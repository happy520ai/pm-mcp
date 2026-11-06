import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { loadSyncConfig, runSyncPush, syncStatus } from "../src/sync.ts";
import { resolveGitCommand } from "../src/git-state.ts";
import { initTestProject, mkProj, writeRel } from "./helpers.ts";

/** T1（ADR-013）：同步 = 带安全门的 git push。 */
function git(cwd: string, ...args: string[]): string {
  const bin = resolveGitCommand();
  if (!bin) throw new Error("测试环境无 git 可执行文件");
  const result = spawnSync(bin, args, { cwd, encoding: "utf8", timeout: 30000, windowsHide: true });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} 失败: ${result.stderr}`);
  return result.stdout;
}

const SYNC_CONFIG = JSON.stringify({ enabled: true, remote: "origin", branch: "main" });

interface Repo {
  root: string;
  remoteDir: string;
  headBefore: string;
}

function mkRepo(files: Record<string, string>): Repo {
  const root = mkProj(files);
  initTestProject(root);
  git(root, "init", "-b", "main");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "测试");
  git(root, "add", "-A");
  git(root, "commit", "-m", "init");
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "pm-sync-remote-"));
  const remoteDir = path.join(base, "remote.git");
  git(root, "init", "--bare", "-b", "main", remoteDir);
  git(root, "remote", "add", "origin", remoteDir);
  git(root, "push", "origin", "main:main");
  return { root, remoteDir, headBefore: git(root, "rev-parse", "HEAD").trim() };
}

function headOf(gitDir: string): string | null {
  const bin = resolveGitCommand();
  if (!bin) throw new Error("测试环境无 git 可执行文件");
  const result = spawnSync(bin, ["--git-dir", gitDir, "rev-parse", "HEAD"], { encoding: "utf8", windowsHide: true });
  return result.status === 0 ? result.stdout.trim() : null;
}

test("sync: 无配置默认关闭，push 拒绝（fail closed）", async () => {
  const root = mkProj({ "src/a.ts": "export const a = 1;\n" });
  initTestProject(root);
  const loaded = loadSyncConfig(root);
  assert.equal(loaded.config.enabled, false);
  assert.equal(loaded.source, "default");
  const result = await runSyncPush(root, { confirm: () => true });
  assert.equal(result.ok, false);
  assert.equal(result.blocked, "disabled");
});

test("sync: 非法配置 fail closed（非法 JSON 与未知字段）", async () => {
  const root = mkProj({});
  initTestProject(root);
  writeRel(root, ".pm/sync.json", "{ not json");
  const bad = loadSyncConfig(root);
  assert.equal(bad.config.enabled, false);
  assert.ok(bad.problems.length > 0);
  const result = await runSyncPush(root, { confirm: () => true });
  assert.equal(result.blocked, "disabled");
});

test("sync: push 前密钥扫描高危阻断，confirm 不可覆盖", async () => {
  const { root, remoteDir, headBefore } = mkRepo({ "src/a.ts": "export const a = 1;\n" });
  writeRel(root, ".pm/sync.json", SYNC_CONFIG);
  // 字面量运行时拼接：本仓扫描器不把测试夹具当真密钥（SEC-024 教训），运行时文件仍连续命中
  writeRel(root, "src/leak.ts", `const key = "${["sk-", "abcdefghijklmnopqrstuvwxyz123456"].join("")}";\nexport const k = key;\n`);
  const result = await runSyncPush(root, { confirm: () => true });
  assert.equal(result.ok, false);
  assert.equal(result.blocked, "secret-scan");
  assert.match(result.message, /高危/);
  // 裸仓库未收到新提交
  assert.equal(headOf(remoteDir), headBefore);
});

test("sync: .env 类文件按文件名阻断", async () => {
  const { root } = mkRepo({ "src/a.ts": "export const a = 1;\n" });
  writeRel(root, ".pm/sync.json", SYNC_CONFIG);
  writeRel(root, ".env", "DATABASE_URL=postgres://localhost/db\n");
  const result = await runSyncPush(root, { confirm: () => true });
  assert.equal(result.ok, false);
  assert.equal(result.blocked, "env-file");
  // 示例文件不阻断
  fs.rmSync(path.join(root, ".env"), { force: true });
  writeRel(root, ".env.example", "DATABASE_URL=postgres://localhost/db\n");
  const ok = await runSyncPush(root, { confirm: () => true });
  assert.notEqual(ok.blocked, "env-file");
});

test("sync: 缺少 confirm 回调一律拒绝（非交互结构防线）", async () => {
  const { root } = mkRepo({ "src/a.ts": "export const a = 1;\n" });
  writeRel(root, ".pm/sync.json", SYNC_CONFIG);
  writeRel(root, "src/b.ts", "export const b = 2;\n");
  git(root, "add", "-A");
  git(root, "commit", "-m", "add b");
  const result = await runSyncPush(root);
  assert.equal(result.ok, false);
  assert.equal(result.blocked, "no-confirmation");
});

test("sync: 用户拒绝 confirm=false 不推送", async () => {
  const { root, remoteDir, headBefore } = mkRepo({ "src/a.ts": "export const a = 1;\n" });
  writeRel(root, ".pm/sync.json", SYNC_CONFIG);
  writeRel(root, "src/b.ts", "export const b = 2;\n");
  git(root, "add", "-A");
  git(root, "commit", "-m", "add b");
  const result = await runSyncPush(root, { confirm: () => false });
  assert.equal(result.ok, false);
  assert.equal(result.blocked, "declined");
  assert.equal(headOf(remoteDir), headBefore);
});

test("sync: 确认后推送到裸仓库，本地 HEAD 与工作区不变", async () => {
  const { root, remoteDir, headBefore } = mkRepo({ "src/a.ts": "export const a = 1;\n" });
  writeRel(root, ".pm/sync.json", SYNC_CONFIG);
  writeRel(root, "src/b.ts", "export const b = 2;\n");
  git(root, "add", "-A");
  git(root, "commit", "-m", "add b");
  const localHead = git(root, "rev-parse", "HEAD").trim();
  const result = await runSyncPush(root, { confirm: () => true });
  assert.equal(result.ok, true, result.message);
  // 本地 HEAD 不变（push 不动本地分支）
  assert.equal(git(root, "rev-parse", "HEAD").trim(), localHead);
  // 远端恰好收到本地 HEAD
  const remoteHead = headOf(remoteDir);
  assert.notEqual(remoteHead, null);
  assert.equal(remoteHead, localHead);
  // 已提交的变更进入快照（.pm/ 台账为 git 友好设计，用户提交则随推送，不排除）
  const remoteFiles = git(root, "--git-dir", remoteDir, "ls-tree", "-r", "--name-only", "HEAD");
  assert.ok(remoteFiles.includes("src/b.ts"));
  assert.ok(remoteFiles.includes("src/a.ts"));
  // 未提交的工作区变更不进入快照（push 只推已提交内容）
  writeRel(root, "src/uncommitted.ts", "export const u = 9;\n");
  const filesAfter = git(root, "--git-dir", remoteDir, "ls-tree", "-r", "--name-only", "HEAD");
  assert.ok(!filesAfter.includes("src/uncommitted.ts"));
});

test("sync: status 只读展示配置与变更", async () => {
  const { root } = mkRepo({ "src/a.ts": "export const a = 1;\n" });
  writeRel(root, "src/b.ts", "export const b = 2;\n");
  const status = syncStatus(root);
  assert.equal(status.enabled, false);
  assert.equal(status.remote, "origin");
  assert.equal(status.branch, "main");
  assert.ok(status.changedFiles.includes("src/b.ts"));
  assert.ok(!status.changedFiles.includes(".pm/sync.json"));
});

test("sync: 配置写入读取回环", () => {
  const root = mkProj({});
  initTestProject(root);
  writeRel(root, ".pm/sync.json", SYNC_CONFIG);
  const loaded = loadSyncConfig(root);
  assert.equal(loaded.config.enabled, true);
  assert.equal(loaded.config.remote, "origin");
  assert.equal(loaded.config.branch, "main");
  assert.equal(fs.readFileSync(path.join(root, ".pm/sync.json"), "utf8"), SYNC_CONFIG);
});
