import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTaskTools } from "../src/task-tools.ts";
import { registerSessionTools } from "../src/knowledge-tools.ts";
import { registerProjectTools } from "../src/project-tools.ts";
import { gitAudit } from "../src/audit.ts";
import { listFiles } from "../src/scan.ts";
import { closeIndex, ensureFresh, freshness, getIndex, iterateFileRows, startWatcher, walkRefresh } from "../src/index-store.ts";
import { loadSessions, loadTasks, saveSessions } from "../src/store.ts";
import { fingerprintProject } from "../src/project-fingerprint.ts";
import { changedGitFiles } from "../src/git-state.ts";
import { verifiedTaskEvidence } from "../src/task-evidence.ts";
import { runQualityPlan } from "../src/language-adapters.ts";
import { saveQualityRun } from "../src/quality-store.ts";
import { initTestProject, mkProj, writeRel } from "./helpers.ts";

function fixture(t: { after: (fn: () => void) => void }) {
  const root = mkProj({ "src/a.mjs": "export const value = 1;\n", "src/b.mjs": "export const other = 1;\n" });
  initTestProject(root);
  t.after(() => { closeIndex(root); fs.rmSync(root, { recursive: true, force: true }); });
  const handlers = new Map<string, (args: any) => any>();
  const server = { registerTool: (name: string, _schema: unknown, fn: any) => handlers.set(name, fn) } as unknown as McpServer;
  registerTaskTools(server, root);
  registerSessionTools(server, root);
  registerProjectTools(server, root);
  let sequence = 0;
  const call = async (name: string, args: Record<string, unknown> = {}) => handlers.get(name)!({ idempotency_key: `upgrade:${++sequence}`, ...args });
  const ok = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await call(name, args);
    assert.ok(!result.isError, JSON.stringify(result));
    return result;
  };
  const git = (...args: string[]) => {
    const result = spawnSync("git", ["-c", "commit.gpgSign=false", "-c", `core.hooksPath=${path.join(root, "no-hooks")}`, ...args], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  };
  return { root, call, ok, git };
}

async function realTestEvidence(root: string): Promise<string> {
  writeRel(root, "test/probe.test.mjs", `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport {value} from '../src/a.mjs';\ntest('fixture value',()=>{assert.equal(value,1);assert.notEqual(process.env.PM_TEST_EVIDENCE_FAIL,'1');});\n`);
  const before = fingerprintProject(root);
  const result = await runQualityPlan([{
    command: process.execPath, args: ["--test", "test/probe.test.mjs"], cwd: root, kind: "test",
    requiredExecutable: process.execPath, timeoutMs: 10000, maxOutputBytes: 65536,
  }], { execute: true });
  return saveQualityRun(root, result, { source_before: before, source_after: fingerprintProject(root) });
}

test("Git 对账保留多会话的真实内容证据，后续改动仍会报出", async (t) => {
  const { root, ok, git } = fixture(t);
  git("init", "--quiet"); git("config", "user.name", "fixture"); git("config", "user.email", "fixture@example.invalid");
  git("add", "."); git("commit", "--quiet", "-m", "baseline");
  writeRel(root, "src/a.mjs", "export const value = 2;\n");
  await ok("log_session", { summary: "记录第一个文件改动", files: ["src/a.mjs"] });
  writeRel(root, "src/b.mjs", "export const other = 2;\n");
  await ok("log_session", { summary: "记录第二个文件改动", files: ["src/b.mjs"] });
  assert.deepEqual(gitAudit(root).unaccounted, []);
  const stamp = fs.statSync(path.join(root, "src/a.mjs")).mtime;
  writeRel(root, "src/a.mjs", "export const value = 3;\n");
  fs.utimesSync(path.join(root, "src/a.mjs"), stamp, stamp);
  assert.ok(gitAudit(root).unaccounted.includes("src/a.mjs"));
  const odd = process.platform === "win32" ? "src/中文 名称.mjs" : "src/中文 -> 名称.mjs";
  writeRel(root, odd, "export const odd = 1;\n");
  assert.ok(gitAudit(root).unaccounted.includes(odd), "Git NUL 输出必须保留完整文件名");
  await ok("log_session", { summary: "记录特殊文件名", files: [odd, "src/a.mjs"] });
  assert.deepEqual(gitAudit(root).unaccounted, []);
});

test("扫描排除缓存，并在项目规则改变后刷新已有索引而不隐藏默认源码目录", async (t) => {
  const { root, ok } = fixture(t);
  writeRel(root, ".runtime/cache.ts", "cached code\n");
  writeRel(root, "EBWebView/profile.txt", "fixture browser cache\n");
  writeRel(root, "release/source.ts", "export const releaseCode = 1;\n");
  const initial = listFiles(root).map((item) => item.rel);
  assert.ok(!initial.some((rel) => rel.startsWith(".runtime/") || rel.startsWith("EBWebView/")));
  assert.ok(initial.includes("release/source.ts"), "release 可能是源码目录，不能一刀切隐藏");
  walkRefresh(root);
  const before = fingerprintProject(root).sha256;
  await ok("update_project", { scan_ignore: ["release/**"] });
  ensureFresh(root);
  assert.ok(![...iterateFileRows(getIndex(root))].some((row) => row.rel.startsWith("release/")));
  assert.notEqual(fingerprintProject(root).sha256, before);
  await ok("update_project", { scan_ignore: [] });
  ensureFresh(root);
  assert.ok([...iterateFileRows(getIndex(root))].some((row) => row.rel === "release/source.ts"));
});

test("旧会话只说明路径未验证，删除与重命名核对两端的实际状态", async (t) => {
  const { root, ok, git } = fixture(t);
  git("init", "--quiet"); git("config", "user.name", "fixture"); git("config", "user.email", "fixture@example.invalid");
  git("add", "."); git("commit", "--quiet", "-m", "baseline");
  writeRel(root, "src/b.mjs", "export const other = 2;\n");
  await ok("log_session", { summary: "兼容旧版本路径记录", files: ["src/b.mjs"] });
  const legacy = loadSessions(root);
  delete legacy.sessions[0].file_hashes;
  saveSessions(root, legacy);
  assert.deepEqual(gitAudit(root).unverified, ["src/b.mjs"]);
  assert.deepEqual(gitAudit(root).unaccounted, []);
  git("mv", "src/a.mjs", "src/renamed.mjs");
  assert.deepEqual(changedGitFiles(root).sort(), ["src/a.mjs", "src/b.mjs", "src/renamed.mjs"]);
  await ok("log_session", { summary: "记录重命名与现有文件内容", files: changedGitFiles(root) });
  assert.deepEqual(gitAudit(root).unaccounted, []);
  assert.deepEqual(gitAudit(root).unverified, []);
  fs.unlinkSync(path.join(root, "src/b.mjs"));
  assert.ok(gitAudit(root).unaccounted.includes("src/b.mjs"));
  await ok("log_session", { summary: "记录文件删除", files: ["src/b.mjs"] });
  assert.deepEqual(gitAudit(root).unaccounted, []);
});

test("活动 watcher 随排除规则变更，不重新收录忽略的输出，清空规则后恢复", async (t) => {
  const { root, ok } = fixture(t);
  writeRel(root, "release/source.mjs", "export const releaseCode = 1;\n");
  walkRefresh(root);
  const watcher = startWatcher(root);
  assert.ok(watcher, "当前测试平台需要真实文件监听");
  try {
    ensureFresh(root);
    await ok("update_project", { scan_ignore: ["release/**"] });
    ensureFresh(root);
    writeRel(root, "release/late.mjs", "export const ignoredOutput = 2;\n");
    writeRel(root, "src/fresh.mjs", "export const includedSource = 3;\n");
    const indexed = () => [...iterateFileRows(getIndex(root))].map((row) => row.rel);
    const deadline = Date.now() + 6000;
    while (!indexed().includes("src/fresh.mjs") && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 120));
      const state = freshness(root);
      if (!state.fresh && state.pendingEvents === 0) ensureFresh(root); // 无文件名的通知必须先标脏，再允许精确恢复
    }
    assert.ok(indexed().includes("src/fresh.mjs"), "源码变更由监听或已标脏的精确恢复入账，不能静默遗漏");
    assert.ok(!indexed().some((rel) => rel.startsWith("release/")));
    await ok("update_project", { scan_ignore: [] });
    ensureFresh(root);
    assert.ok(indexed().includes("release/late.mjs"));
  } finally { watcher.stop(); }
});

test("一次 update_task 同时保存进度和会话，重放不重复落账，完成自动关联质量证据", async (t) => {
  const { root, ok } = fixture(t);
  await ok("add_task", { title: "验证自动管理", type: "fix" });
  const update = { id: "T-001", status: "in_progress", files: ["src/a.mjs"], checkpoint: { note: "已定位问题", next_step: "执行验证" }, idempotency_key: "upgrade:progress" };
  await ok("update_task", update);
  await ok("update_task", update);
  assert.equal(loadTasks(root).tasks[0].checkpoint?.next_step, "执行验证");
  assert.equal(loadSessions(root).sessions.length, 1);
  const report = await realTestEvidence(root);
  await ok("update_task", { id: "T-001", status: "done", result_note: "实际验证已通过", verification_run: report, record_session: true, files: ["src/a.mjs"] });
  assert.equal(loadSessions(root).sessions.length, 2);
  assert.ok(loadTasks(root).tasks[0].verification.includes(report));
  assert.ok(loadTasks(root).tasks[0].verification.includes(fingerprintProject(root).sha256));
});

test("完成门禁拒绝文字声明、过期源码和后来失败的验证", async (t) => {
  const { root, call, ok } = fixture(t);
  await ok("add_task", { title: "验证完成门禁", type: "feature", files: ["src/a.mjs"] });
  const noEvidence = await call("update_task", { id: "T-001", status: "done", result_note: "宣称已经完成", verification: "npm test 通过" });
  assert.equal(noEvidence.isError, true);
  assert.equal(loadTasks(root).tasks[0].status, "backlog");
  const passed = await realTestEvidence(root);
  const previous = process.env.PM_TEST_EVIDENCE_FAIL;
  try { process.env.PM_TEST_EVIDENCE_FAIL = "1"; await realTestEvidence(root); }
  finally { if (previous === undefined) delete process.env.PM_TEST_EVIDENCE_FAIL; else process.env.PM_TEST_EVIDENCE_FAIL = previous; }
  const hiddenFailure = await call("update_task", { id: "T-001", status: "done", result_note: "选择旧的通过结果", verification_run: passed });
  assert.equal(hiddenFailure.isError, true);
  const newest = await realTestEvidence(root);
  writeRel(root, "src/b.mjs", "export const other = 99;\n");
  const stale = await call("update_task", { id: "T-001", status: "done", result_note: "旧验证不能证明新代码", verification_run: newest });
  assert.equal(stale.isError, true);
  await realTestEvidence(root);
  await ok("update_task", { id: "T-001", status: "done", result_note: "自动采用最新有效验证" });
});

test("完成证据拒绝损坏、未执行、零测试、跳过项、越界执行目录和排除文件", async (t) => {
  const { root, ok } = fixture(t);
  const report = await realTestEvidence(root);
  const full = path.join(root, report);
  const original = fs.readFileSync(full, "utf8");
  const check = () => verifiedTaskEvidence(root, report, ["src/a.mjs"]);
  const invalid: Array<(report: any) => void> = [
    (report) => { report.schema_version = 1; },
    (report) => { report.execute = false; },
    (report) => { report.source.stable = false; },
    (report) => { report.results[0].output_truncated = true; },
    (report) => { report.results[0].output_summary.tests = 0; },
    (report) => { report.results[0].output_summary.skipped = 1; },
    (report) => { report.results[0].exit_code = 1; },
    (report) => { report.results[0].signal = "SIGTERM"; },
    (report) => { report.results[0].kind = "build"; },
    (report) => { report.results[0].unit_root = path.dirname(root); },
    (report) => { report.results[0].unit_root = "."; },
  ];
  for (const mutate of invalid) {
    const value = JSON.parse(original);
    mutate(value);
    fs.writeFileSync(full, JSON.stringify(value));
    assert.throws(check, undefined, mutate.toString());
  }
  fs.writeFileSync(full, "{broken");
  assert.throws(check);
  fs.writeFileSync(full, original);
  writeRel(root, ".pm/quality-runs/quality-20200101-legacy.json", JSON.stringify({ ...JSON.parse(original), schema_version: 1, run_at: "2020-01-01T00:00:00.000Z" }));
  assert.ok(check().includes(report), "较旧报告不阻断更新的真实有效报告");
  assert.throws(() => verifiedTaskEvidence(root, report, []), /files/);
  assert.throws(() => verifiedTaskEvidence(root, report, ["src"]), /普通文件/);
  assert.throws(() => verifiedTaskEvidence(root, report, ["../outside.mjs"]), /相对路径/);
  await ok("update_project", { scan_ignore: ["src"] });
  assert.throws(check, /源码验证范围/, "匹配父目录的规则也排除任务文件");
  await ok("update_project", { scan_ignore: [] });
  assert.ok(check().includes(report));
});
