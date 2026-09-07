import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  USAGE_LOG,
  RUNTIME_LOG,
  estimateTokens,
  filterRuntime,
  filterUsage,
  loadRuntimeEntries,
  loadUsageEntries,
  logRuntime,
  logUsage,
  renderRuntimeLogLines,
  renderUsageLogLines,
  usageSummary,
} from "../src/usage-log.ts";
import { drainFoldSavings, foldLines } from "../src/budget.ts";
import { toolR, toolW } from "../src/tool-base.ts";
import { registerProjectTools, registerRoadmapTools } from "../src/project-tools.ts";
import { initTestProject, mkProj } from "./helpers.ts";

test("当前和轮转后的运行日志都被 Git 忽略", (t) => {
  const root = mkProj();
  initTestProject(root);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const init = spawnSync("git", ["init", "--quiet"], { cwd: root, encoding: "utf8" });
  assert.equal(init.status, 0, init.stderr);
  const files = [".pm/usage-log.jsonl", ".pm/usage-log.1.jsonl", ".pm/runtime-log.jsonl", ".pm/runtime-log.1.jsonl"];
  const checked = spawnSync("git", ["check-ignore", "--no-index", "--stdin"], { cwd: root, input: files.join("\n") + "\n", encoding: "utf8" });
  assert.equal(checked.status, 0, checked.stderr);
  assert.deepEqual(checked.stdout.trim().split(/\r?\n/).sort(), files.sort());
});

test("estimateTokens：CJK 每字≈1 token，其余≈4字符/token", () => {
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens("abcd"), 1);
  assert.equal(estimateTokens("a"), 1);
  assert.equal(estimateTokens("中文两字"), 4);
  assert.equal(estimateTokens("ab中"), 2);
});

test("折叠记账：foldLines 折叠/截断后 drainFoldSavings 有省量且清零", () => {
  drainFoldSavings(); // 清掉历史残留
  const folded = foldLines(Array.from({ length: 50 }, (_, i) => `line-${i}`), { maxLines: 5 });
  const savings = drainFoldSavings();
  assert.ok(savings, "折叠后应有省量");
  assert.ok(savings.chars > 0);
  assert.ok(savings.tokens > 0);
  assert.equal(drainFoldSavings(), null, "drain 后清零");

  foldLines(["a", "b"], { maxLines: 5 });
  assert.equal(drainFoldSavings(), null, "无折叠无省量");

  const full = ["x".repeat(500)];
  foldLines(full, { maxLines: 5 });
  const capped = drainFoldSavings();
  assert.ok(capped && capped.chars > 100, "超长行截断也记省量");
});

test("logUsage 写入 + 查询过滤 + 汇总", (t) => {
  const root = mkProj();
  initTestProject(root);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const base = { ts: "2026-09-03T10:00:00.000Z", ms: 10 };
  logUsage(root, { ...base, tool: "get_status", kind: "read", ok: true, out_chars: 800, est_tokens: 200 });
  logUsage(root, { ...base, ts: "2026-09-03T10:01:00.000Z", tool: "add_task", kind: "write", ok: true, out_chars: 100, est_tokens: 30 });
  logUsage(root, { ...base, ts: "2026-09-03T10:02:00.000Z", tool: "get_status", kind: "read", ok: false, error: "boom" });
  logUsage(root, { ...base, ts: "2026-09-03T10:03:00.000Z", tool: "list_tasks", kind: "read", ok: true, out_chars: 50, est_tokens: 20, folded_chars: 4000, folded_tokens: 1000, replayed: true });

  const entries = loadUsageEntries(root);
  assert.equal(entries.length, 4);

  const onlyStatus = filterUsage(entries, { tool: "get_status" });
  assert.equal(onlyStatus.length, 2);
  assert.ok(onlyStatus[0].ts >= onlyStatus[1].ts, "明细按时间倒序");

  const failed = filterUsage(entries, { ok: false });
  assert.equal(failed.length, 1);
  assert.equal(failed[0].error, "boom");

  assert.equal(filterUsage(entries, { since: "2026-09-03T10:02:30Z" }).length, 1);
  assert.equal(filterUsage(entries, { last: 2 }).length, 2);

  const summary = usageSummary(entries);
  assert.equal(summary.calls, 4);
  assert.equal(summary.errors, 1);
  assert.equal(summary.estTokensOut, 250);
  assert.equal(summary.estTokensSaved, 1000);
  assert.equal(summary.replayed, 1);
  assert.equal(summary.folds, 1);
  assert.equal(summary.topTools[0].tool, "get_status");

  const lines = renderUsageLogLines(root, { tool: "add_task" });
  assert.ok(lines.some((l) => l.includes("使用日志汇总")));
  assert.ok(lines.some((l) => l.includes("折叠省下")));
  assert.ok(lines.some((l) => l.includes("add_task")));
  assert.ok(!lines.some((l) => l.includes("✅ get_status")), "明细应吃过滤");
});

test("未初始化项目：日志不写盘也不抛错", (t) => {
  const root = mkProj();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.doesNotThrow(() => logUsage(root, { ts: "t", tool: "x", kind: "read", ok: true, ms: 1 }));
  assert.doesNotThrow(() => logRuntime(root, "info", "server.ready"));
  assert.equal(fs.existsSync(path.join(root, ".pm", USAGE_LOG)), false);
  assert.equal(fs.existsSync(path.join(root, ".pm", RUNTIME_LOG)), false);
  assert.deepEqual(loadUsageEntries(root), []);
});

test("运行日志：级别/事件过滤与渲染", (t) => {
  const root = mkProj();
  initTestProject(root);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  logRuntime(root, "info", "server.ready", "pid=1");
  logRuntime(root, "warn", "watcher.unavailable", "降级");
  logRuntime(root, "error", "tool.error", "get_status: boom");

  const entries = loadRuntimeEntries(root);
  assert.equal(entries.length, 3);
  assert.equal(filterRuntime(entries, { level: "error" }).length, 1);
  assert.equal(filterRuntime(entries, { event: "server.ready" }).length, 1);
  assert.equal(filterRuntime(entries, { since: "2999-01-01" }).length, 0);

  const lines = renderRuntimeLogLines(root, { level: "error" });
  assert.ok(lines.some((l) => l.includes("error 1")));
  assert.ok(lines.some((l) => l.includes("tool.error")));
  assert.ok(!lines.some((l) => l.includes("server.ready")), "明细应吃级别过滤");
});

test("超限自动轮转：当前份转 .1，查询跨两份合并", (t) => {
  const root = mkProj();
  initTestProject(root);
  t.after(() => {
    delete process.env.PM_TEST_LOG_MAX_BYTES;
    fs.rmSync(root, { recursive: true, force: true });
  });
  process.env.PM_TEST_LOG_MAX_BYTES = "300";
  const tool = "x".repeat(60);
  for (let i = 0; i < 4; i++) {
    logUsage(root, { ts: `2026-09-03T10:00:0${i}.000Z`, tool, kind: "read", ok: true, ms: 1 });
  }
  // 每行 ~130 字节：第 3 次写后超 300 → 前三行转入 .1，第 4 行留在当前份
  assert.equal(fs.existsSync(path.join(root, ".pm", "usage-log.1.jsonl")), true, "应产生轮转份");
  const entries = loadUsageEntries(root);
  assert.equal(entries.length, 4, "轮转份 + 当前份合并读取");
  assert.equal(entries[0].ts, "2026-09-03T10:00:00.000Z", "轮转份（更早）排在前面");
});

test("工具包装器端到端：成功/失败调用都进使用日志，失败同时进运行日志", async (t) => {
  drainFoldSavings(); // 清掉历史残留，避免折叠省量串台
  const root = mkProj();
  initTestProject(root);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  type Handler = (args: Record<string, never>) => unknown;
  const handlers = new Map<string, Handler>();
  const fake = {
    registerTool(name: string, _config: unknown, handler: Handler): void { handlers.set(name, handler); },
  } as unknown as McpServer;
  toolR<{ x?: string }>(fake, root, "t_echo", "测试读工具", { x: z.string().optional() }, (a) => `echo:${a.x}`);
  toolW(fake, root, "t_fail", "测试失败写工具", {}, () => { throw new Error("boom"); });

  const okResult = (await handlers.get("t_echo")({ x: "hi" })) as { isError?: boolean; content: Array<{ text: string }> };
  assert.equal(okResult.isError, undefined);
  assert.equal(okResult.content[0].text, "echo:hi");

  const failResult = handlers.get("t_fail")({}) as { isError?: boolean; content: Array<{ text: string }> };
  assert.equal(failResult.isError, true);

  const usage = loadUsageEntries(root);
  const echo = usage.find((e) => e.tool === "t_echo");
  assert.ok(echo, "成功调用应记录");
  assert.equal(echo.ok, true);
  assert.ok((echo.est_tokens ?? 0) > 0);
  assert.ok(echo.ms >= 0);
  const fail = usage.find((e) => e.tool === "t_fail");
  assert.ok(fail, "失败调用应记录");
  assert.equal(fail.ok, false);
  assert.ok(fail.error?.includes("boom"));

  const runtime = loadRuntimeEntries(root);
  assert.ok(runtime.some((e) => e.level === "error" && e.event === "tool.error" && (e.detail ?? "").includes("t_fail")));
});

test("get_usage_log / get_runtime_log 工具渲染", async (t) => {
  const root = mkProj({ "src/app.ts": "export const a = 1;\n" });
  initTestProject(root, ); // 不走工具 handler 初始化，保证此刻日志为空
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  type Handler = (args: Record<string, any>) => unknown;
  const handlers = new Map<string, Handler>();
  const fake = {
    registerTool(name: string, _config: unknown, handler: Handler): void { handlers.set(name, handler); },
  } as unknown as McpServer;
  registerProjectTools(fake, root);
  registerRoadmapTools(fake, root);
  const invoke = async (name: string, args: Record<string, any> = {}): Promise<string> => {
    const result = (await handlers.get(name)!(args)) as { content: Array<{ text: string }> };
    return result.content[0].text;
  };

  const empty = await invoke("get_usage_log");
  assert.ok(empty.includes("使用日志为空"));

  await invoke("get_status");
  await invoke("update_milestone", { id: "M404", status: "done" }); // 失败 → tool.error

  const usageOut = await invoke("get_usage_log");
  assert.ok(usageOut.includes("使用日志汇总"));
  assert.ok(usageOut.includes("get_status"));
  assert.ok(usageOut.includes("折叠省下"));
  assert.ok(usageOut.includes("update_milestone"));

  const runtimeOut = await invoke("get_runtime_log", { event: "tool.error" });
  assert.ok(runtimeOut.includes("运行日志"));
  assert.ok(runtimeOut.includes("tool.error"));

  const filtered = await invoke("get_usage_log", { tool: "get_status" });
  assert.ok(filtered.includes("get_status"));
  assert.ok(!filtered.includes("✅ update_milestone"), "明细应吃工具过滤");
});
