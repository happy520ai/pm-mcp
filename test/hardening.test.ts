import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { initProject } from "../src/init.ts";
import { isInitialized } from "../src/paths.ts";
import { loadSessions, loadTasks } from "../src/store.ts";
import { CLIENT_ADAPTER_ENV, QODER_ADAPTER } from "../src/caller-workspace.ts";
import { gcIdempotencyRecords, runCoalescedRead, runIdempotentWriteSync } from "../src/idempotency.ts";
import { registerTaskTools } from "../src/task-tools.ts";
import { mkProj } from "./helpers.ts";

interface Captured {
  content?: Array<{ text?: string }>;
  isError?: boolean;
}
type Handler = (args: Record<string, any>) => Captured | Promise<Captured>;

function taskHandlers(root: string): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  const fake = {
    registerTool(name: string, _config: unknown, handler: Handler): void { handlers.set(name, handler); },
  } as unknown as McpServer;
  registerTaskTools(fake, root);
  return handlers;
}

function textOf(result: Captured): string {
  return (result.content ?? []).map((item) => item.text ?? "").join("\n");
}

function scratch(prefix: string, t: { after: (fn: () => void) => void }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/* ---------------------- P0-1 工作区歧义写操作 fail-closed ---------------------- */

test("两个工作区同时匹配时 add_task 必须报错且两边都不落任务；显式 root 可逃生", async (t) => {
  const projectA = mkProj();
  const projectB = mkProj();
  initProject(projectA, { name: "A", agentsMd: false });
  initProject(projectB, { name: "B", agentsMd: false });

  const now = Date.now();
  const configDir = scratch("pm-hard-cfg-", t);
  const makeLog = (name: string, cwd: string): void => {
    const dir = path.join(configDir, "logs", "runs", name);
    fs.mkdirSync(dir, { recursive: true });
    const head = `${new Date(now - 5_000).toISOString()} INFO  debug.message [qoder-worker-runtime] installed worker cwd shim initial_cwd=${cwd} restore_cwd=C:\\Qoder\n`;
    const payload = JSON.stringify({ arguments: { title: "ambiguous" }, toolName: "mcp__pm_mcp__add_task" });
    const line = `${new Date(now - 500).toISOString()} INFO  [session=s turn=t tool=call_1] tool.requested tool_name="mcp_call" args=${payload}\n`;
    fs.writeFileSync(path.join(dir, "qodercli.log"), head + line, "utf8");
  };
  makeLog("2026-10-28T10-00-00-000+08-00-aaa-p1", projectA);
  makeLog("2026-10-28T10-00-01-000+08-00-bbb-p1", projectB);

  const saved = { ...process.env };
  t.after(() => {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, saved);
  });
  process.env.QODER_CONFIG_DIR = configDir;
  process.env[CLIENT_ADAPTER_ENV] = QODER_ADAPTER;

  const ambiguous = await Promise.resolve(taskHandlers(projectA).get("add_task")!({ title: "ambiguous" }));
  assert.equal(ambiguous.isError, true, textOf(ambiguous));
  assert.match(textOf(ambiguous), /无法确定本次调用的项目根/);
  assert.equal(loadTasks(projectA).tasks.length, 0, "歧义时不得写入启动根");
  assert.equal(loadTasks(projectB).tasks.length, 0, "歧义时不得写入候选根");

  const explicit = await Promise.resolve(taskHandlers(projectA).get("add_task")!({ title: "explicit", root: projectA }));
  assert.ok(!explicit.isError, textOf(explicit));
  assert.equal(loadTasks(projectA).tasks.length, 1, "显式 root 必须能正常写入");
  assert.equal(loadTasks(projectB).tasks.length, 0);
});

/* ---------------------- P0-2 核心账本缺失/主体字段缺失 ---------------------- */

test("核心账本缺失时 list/add 报错，不把缺失当空账、不重建 T-001", async () => {
  const root = mkProj();
  initProject(root, { name: "missing-ledger", agentsMd: false });
  fs.renameSync(path.join(root, ".pm", "tasks.json"), path.join(root, ".pm", "tasks.json.bak"));

  assert.throws(() => loadTasks(root), /核心账本缺失/);
  const result = await Promise.resolve(taskHandlers(root).get("add_task")!({ title: "不应写入" }));
  assert.equal(result.isError, true, textOf(result));
  assert.match(textOf(result), /核心账本缺失/);
  assert.equal(fs.existsSync(path.join(root, ".pm", "tasks.json")), false, "不得静默重建账本");
});

test("主体数组缺失按校验失败处理，而不是补成空数组", () => {
  const root = mkProj();
  initProject(root, { name: "truncated-ledger", agentsMd: false });
  fs.writeFileSync(path.join(root, ".pm", "tasks.json"), JSON.stringify({ seq: 78 }), "utf8");
  assert.throws(() => loadTasks(root), /数据校验失败/);

  fs.writeFileSync(path.join(root, ".pm", "sessions.json"), JSON.stringify({ seq: 94 }), "utf8");
  assert.throws(() => loadSessions(root), /数据校验失败/);
});

/* ---------------------- P0-3 初始化半提交可恢复 ---------------------- */

test("初始化失败不留下已初始化假象，修复后可重试完成", () => {
  const root = mkProj();
  fs.mkdirSync(path.join(root, ".pm", "tasks.json"), { recursive: true });
  assert.throws(() => initProject(root, { name: "half-init", agentsMd: false }));
  assert.equal(isInitialized(root), false, "project.json 必须最后提交，失败时不得声称已初始化");

  fs.rmSync(path.join(root, ".pm", "tasks.json"), { recursive: true, force: true });
  initProject(root, { name: "half-init", agentsMd: false });
  assert.equal(isInitialized(root), true);
  assert.deepEqual(loadTasks(root).tasks, []);
});

/* ---------------------- P0-4 幂等缓存回收 ---------------------- */

function cacheRecords(root: string): string[] {
  const dir = path.join(root, ".pm", ".runtime", "idempotency");
  return fs.readdirSync(dir).filter((name) => name.endsWith(".json")).map((name) => path.join(dir, name));
}

function ageRecord(file: string, ageMs: number): void {
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { updated_at: string };
  raw.updated_at = new Date(Date.now() - ageMs).toISOString();
  fs.writeFileSync(file, JSON.stringify(raw), "utf8");
}

function recordTool(file: string): string {
  return (JSON.parse(fs.readFileSync(file, "utf8")) as { tool: string }).tool;
}

test("GC 清理过期读/自动写记录，保留新读与显式写记录", async () => {
  const root = mkProj();
  initProject(root, { name: "gc", agentsMd: false });

  await runCoalescedRead(root, "read-old", { q: 1 }, () => "old");
  await runCoalescedRead(root, "read-fresh", { q: 2 }, () => "fresh");
  const auto = runIdempotentWriteSync(root, "write-auto", { value: 1 }, () => "auto");
  assert.equal(auto.pending, false);
  const explicit = runIdempotentWriteSync(root, "write-explicit", { value: 2, idempotency_key: "KEEP:EXPLICIT" }, () => "explicit");
  assert.equal(explicit.pending, false);

  const oldRead = cacheRecords(root).find((file) => recordTool(file) === "read-old");
  const freshRead = cacheRecords(root).find((file) => recordTool(file) === "read-fresh");
  const autoWrite = cacheRecords(root).find((file) => recordTool(file) === "write-auto");
  const explicitWrite = cacheRecords(root).find((file) => recordTool(file) === "write-explicit");
  assert.ok(oldRead && freshRead && autoWrite && explicitWrite, "四类记录都应存在");
  ageRecord(oldRead!, 60 * 60_000);
  ageRecord(autoWrite!, 48 * 60 * 60_000);
  ageRecord(explicitWrite!, 48 * 60 * 60_000);

  const stats = gcIdempotencyRecords(root, { force: true });
  assert.ok(stats.removed >= 2, `至少清理两条，实际 ${stats.removed}`);
  assert.equal(fs.existsSync(oldRead!), false, "过期读记录应删除");
  assert.equal(fs.existsSync(autoWrite!), false, "过期自动写记录应删除");
  assert.equal(fs.existsSync(freshRead!), true, "新读记录必须保留");
  assert.equal(fs.existsSync(explicitWrite!), true, "显式写记录在保留期内必须保留");
});

/* ---------------------- P1-5 update_task 部分提交可重试 ---------------------- */

test("会话账本损坏时任务不被修改，修复后同参数重试可成功", async () => {
  const root = mkProj();
  initProject(root, { name: "atomic-task", agentsMd: false });
  const add = await Promise.resolve(taskHandlers(root).get("add_task")!({ title: "原子任务", type: "chore" }));
  assert.ok(!add.isError, textOf(add));

  fs.writeFileSync(path.join(root, ".pm", "sessions.json"), "{ broken", "utf8");
  const failed = await Promise.resolve(taskHandlers(root).get("update_task")!({
    id: "T-001", status: "done", result_note: "完成测试", record_session: true,
  }));
  assert.equal(failed.isError, true, textOf(failed));
  assert.match(textOf(failed), /会话账本不可用/);
  assert.equal(loadTasks(root).tasks[0]!.status, "backlog", "会话写入失败时任务必须保持原状态");

  fs.writeFileSync(path.join(root, ".pm", "sessions.json"), JSON.stringify({ seq: 0, sessions: [] }), "utf8");
  const retried = await Promise.resolve(taskHandlers(root).get("update_task")!({
    id: "T-001", status: "done", result_note: "完成测试", record_session: true,
  }));
  assert.ok(!retried.isError, textOf(retried));
  assert.equal(loadTasks(root).tasks[0]!.status, "done");
  assert.equal(loadSessions(root).sessions.length, 1);
});
