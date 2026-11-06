import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { runSyncPush } from "../src/sync.ts";
import { resolveGitCommand } from "../src/git-state.ts";
import { initTestProject, mkProj, writeRel } from "./helpers.ts";

/** T2（ADR-013）：端到端泄露回归——密钥样例在任何路径下都无法通过 sync 推送。 */

function git(cwd: string, ...args: string[]): string {
  const bin = resolveGitCommand();
  if (!bin) throw new Error("测试环境无 git 可执行文件");
  const result = spawnSync(bin, args, { cwd, encoding: "utf8", timeout: 30000, windowsHide: true });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} 失败: ${result.stderr}`);
  return result.stdout;
}

const SYNC_CONFIG = JSON.stringify({ enabled: true, remote: "origin", branch: "main" });

/** 泄露夹具：字面量运行时拼接——本仓扫描器不应把测试夹具当真密钥（SEC-018~024 教训），运行时写出的文件仍是连续命中。 */
const AWS = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
const GHT = ["ghp_", "abcdefghijklmnopqrstuvwxyz012345"].join("");
const OAI = ["sk-", "abcdefghijklmnopqrstuvwxyz0123456789"].join("");
const GCP = ["AIza", "SyA0123456789abcdefghijklmnopqrstuv"].join("");
const SLK = ["xox", "b-123456789012-", "abcdefghijklmn"].join("");
const PEM_HEAD = ["-----BE", "GIN RSA PRIVATE KEY-----"].join("");
const PEM_TAIL = ["-----E", "ND RSA PRIVATE KEY-----"].join("");

/** 泄露夹具：覆盖内置每条高危密钥规则 + .env 类文件名。 */
const LEAK_FIXTURES: Record<string, string> = {
  "secrets/aws.ts": `export const key = "${AWS}";\n`,
  "secrets/github.ts": `export const t = "${GHT}";\n`,
  "secrets/openai.ts": `export const t = "${OAI}";\n`,
  "secrets/google.ts": `export const t = "${GCP}";\n`,
  "secrets/slack.ts": `export const t = "${SLK}";\n`,
  "secrets/key.pem": `${PEM_HEAD}\nMIIEpAIBAAKCAQEA1234\n${PEM_TAIL}\n`,
};

function mkSyncRepo(): string {
  const root = mkProj({ "src/a.ts": "export const a = 1;\n" });
  initTestProject(root);
  git(root, "init", "-b", "main");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "测试");
  git(root, "add", "-A");
  git(root, "commit", "-m", "init");
  const remoteDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pm-leak-remote-")), "remote.git");
  git(root, "init", "--bare", "-b", "main", remoteDir);
  git(root, "remote", "add", "origin", remoteDir);
  git(root, "push", "origin", "main:main");
  writeRel(root, ".pm/sync.json", SYNC_CONFIG);
  return root;
}

test("leak: 单条高危密钥样例逐个阻断推送（confirm 不可覆盖）", async () => {
  for (const [file, content] of Object.entries(LEAK_FIXTURES)) {
    const root = mkSyncRepo();
    writeRel(root, file, content);
    const result = await runSyncPush(root, { confirm: () => true });
    assert.equal(result.blocked, "secret-scan", `${file} 应被密钥扫描阻断，实际: ${result.message}`);
    assert.equal(result.ok, false);
  }
});

test("leak: .env 类文件名阻断（空 .env 也拦）", async () => {
  const root = mkSyncRepo();
  writeRel(root, ".env", "");
  const result = await runSyncPush(root, { confirm: () => true });
  assert.equal(result.blocked, "env-file");
  assert.equal(result.ok, false);
});

test("leak: 混合夹具一次全部列出，不推送", async () => {
  const root = mkSyncRepo();
  for (const [file, content] of Object.entries(LEAK_FIXTURES)) writeRel(root, file, content);
  writeRel(root, ".env.local", "TOKEN=abc\n");
  const result = await runSyncPush(root, { confirm: () => true });
  assert.equal(result.ok, false);
  // 两种阻断之一命中，且消息包含定位信息
  assert.match(result.message, /阻断/);
});

test("leak: 示例文件与无密钥的正常文件不被误伤", async () => {
  const root = mkSyncRepo();
  writeRel(root, "src/normal.ts", "export const url = process.env.DATABASE_URL;\nexport const example = 'your-api-key-here';\n");
  const result = await runSyncPush(root, { confirm: () => true });
  assert.equal(result.ok, true, result.message);
});

test("leak: 非交互（无 confirm 回调）任何内容都不推送", async () => {
  const root = mkSyncRepo();
  for (const [file, content] of Object.entries(LEAK_FIXTURES)) writeRel(root, file, content);
  const result = await runSyncPush(root);
  assert.equal(result.ok, false);
  // 密钥门禁在确认门禁之前触发；无论哪道门先拦，缺省 confirm 都到不了 push
  assert.ok(["secret-scan", "no-confirmation"].includes(result.blocked ?? ""), `实际 blocked: ${result.blocked}`);
});
