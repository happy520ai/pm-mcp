import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CLIENT_ADAPTER_ENV,
  QODER_ADAPTER,
  ROOT_HINT_ENV,
  ROOT_HINT_SOURCE_ENV,
  resolveRequestRoot,
} from "../src/caller-workspace.ts";
import { registerProjectTools, registerRoadmapTools } from "../src/project-tools.ts";
import { initProject } from "../src/init.ts";

const NOW = Date.parse("2026-09-20T11:00:00.000Z");

interface RunSpec {
  name: string;
  initialCwd: string;
  lines?: string[];
  ageMs?: number;
}

function scratch(prefix: string, t: { after: (fn: () => void) => void }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** 造一个只有指定会话日志的假 Qoder 配置目录；QODER_CONFIG_DIR 一旦给出就只看它 */
function fakeQoder(t: { after: (fn: () => void) => void }, runs: RunSpec[], now: number = NOW): { configDir: string; env: NodeJS.ProcessEnv } {
  const configDir = scratch("pm-caller-cfg-", t);
  for (const run of runs) {
    const dir = path.join(configDir, "logs", "runs", run.name);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "qodercli.log");
    const head = `2026-09-20T10:57:57.220+08:00 INFO  debug.message [qoder-worker-runtime] installed worker cwd shim initial_cwd=${run.initialCwd} restore_cwd=D:\\Qoder CN\n`;
    fs.writeFileSync(file, head + (run.lines ?? []).join("\n") + (run.lines?.length ? "\n" : ""), "utf8");
    const stamp = new Date(now - (run.ageMs ?? 0));
    fs.utimesSync(file, stamp, stamp);
  }
  return {
    configDir,
    env: { QODER_CONFIG_DIR: configDir, [CLIENT_ADAPTER_ENV]: QODER_ADAPTER } as NodeJS.ProcessEnv,
  };
}

function requested(tool: string, args: unknown, options: { lazy?: boolean; at?: number } = {}): string {
  const stamp = new Date(options.at ?? NOW - 1000).toISOString();
  const ctx = '[session=93ecaf00 turn=0b95a22d tool=call_1]';
  const lazy = options.lazy ?? true;
  const payload = lazy
    ? JSON.stringify({ arguments: args, toolName: `mcp__pm_mcp__${tool}` })
    : JSON.stringify(args);
  return lazy
    ? `${stamp} INFO  ${ctx} tool.requested tool_name="mcp_call" args=${payload}`
    : `${stamp} INFO  ${ctx} tool.requested tool_name="mcp__pm_mcp__${tool}" args=${payload}`;
}

const STARTUP = { startupRoot: path.join(os.tmpdir(), "pm-startup-root"), startupSource: "QODER_WORKER_CWD(spawn-time)" };

test("未标记为 Qoder 适配器时完全沿用启动根，不去翻别人的日志", (t) => {
  const workspace = scratch("pm-caller-ws-", t);
  const { configDir } = fakeQoder(t, [{ name: "2026-09-20T10-57-56-000+08-00-aaa-p30056", initialCwd: workspace, lines: [requested("get_status", {})], ageMs: 1000 }]);
  const result = resolveRequestRoot({
    tool: "get_status",
    args: {},
    ...STARTUP,
    now: NOW,
    env: { QODER_CONFIG_DIR: configDir } as NodeJS.ProcessEnv,
  });
  assert.deepEqual(result, { root: STARTUP.startupRoot, source: STARTUP.startupSource });
});

test("显式 root 参数优先，作为多会话歧义时的逃生口", (t) => {
  const workspace = scratch("pm-caller-ws-", t);
  const { env } = fakeQoder(t, []);
  const result = resolveRequestRoot({ tool: "get_status", args: { root: workspace }, ...STARTUP, now: NOW, env });
  assert.deepEqual(result, { root: path.resolve(workspace), source: "argument" });
});

test("按请求指纹认领调用方会话的工作区（惰性 mcp_call 形态）", (t) => {
  const mine = scratch("pm-caller-mine-", t);
  const other = scratch("pm-caller-other-", t);
  const { env } = fakeQoder(t, [
    { name: "2026-09-20T10-46-39-000+08-00-bbb-p30056", initialCwd: other, lines: [requested("get_status", {})], ageMs: 30_000 },
    { name: "2026-09-20T10-57-56-000+08-00-aaa-p30056", initialCwd: mine, lines: [requested("list_tasks", { status: "in_progress" })], ageMs: 1000 },
  ]);
  const result = resolveRequestRoot({
    tool: "list_tasks",
    args: { status: "in_progress" },
    ...STARTUP,
    now: NOW,
    env,
  });
  assert.deepEqual(result, { root: path.resolve(mine), source: "qoder-session-log(request-match)" });
});

test("客户端直连工具名（非惰性）形态同样能认领", (t) => {
  const mine = scratch("pm-caller-mine-", t);
  const { env } = fakeQoder(t, [
    { name: "2026-09-20T10-57-56-000+08-00-aaa-p30056", initialCwd: mine, lines: [requested("get_roadmap", { depth: 2 }, { lazy: false })], ageMs: 500 },
  ]);
  const result = resolveRequestRoot({ tool: "get_roadmap", args: { depth: 2 }, ...STARTUP, now: NOW, env });
  assert.deepEqual(result, { root: path.resolve(mine), source: "qoder-session-log(request-match)" });
});

test("日志记的是客户端原始参数：服务端被 zod 补了默认值也要能匹配上", (t) => {
  const mine = scratch("pm-caller-mine-", t);
  const { env } = fakeQoder(t, [
    { name: "2026-09-20T10-57-56-000+08-00-aaa-p30056", initialCwd: mine, lines: [requested("list_tasks", {})], ageMs: 500 },
  ]);
  const result = resolveRequestRoot({ tool: "list_tasks", args: { include_done: false }, ...STARTUP, now: NOW, env });
  assert.deepEqual(result, { root: path.resolve(mine), source: "qoder-session-log(request-match)" });
});

test("指纹命中多个不同工作区时拒绝猜测，交回启动根并列出候选", (t) => {
  const first = scratch("pm-caller-a-", t);
  const second = scratch("pm-caller-b-", t);
  const { env } = fakeQoder(t, [
    { name: "2026-09-20T10-46-39-000+08-00-bbb-p30056", initialCwd: second, lines: [requested("get_status", {})], ageMs: 2000 },
    { name: "2026-09-20T10-57-56-000+08-00-aaa-p30056", initialCwd: first, lines: [requested("get_status", {})], ageMs: 1000 },
  ]);
  const result = resolveRequestRoot({ tool: "get_status", args: {}, ...STARTUP, now: NOW, env });
  assert.equal(result.root, STARTUP.startupRoot);
  assert.match(result.source, /未猜测/);
  assert.deepEqual([...(result.candidates ?? [])].sort(), [first, second].map((p) => path.resolve(p)).sort());
});

test("两个窗口先后发同一个无参调用：认刚刚写下指纹的那个，不当成歧义", (t) => {
  const earlier = scratch("pm-caller-earlier-", t);
  const caller = scratch("pm-caller-caller-", t);
  // 前一个窗口的同样调用仍在回溯窗内（会被扫到），但它的指纹已经超出「刚刚写下」的时限
  const { env } = fakeQoder(t, [
    { name: "2026-09-20T10-46-39-000+08-00-bbb-p30056", initialCwd: earlier, lines: [requested("get_status", {}, { at: NOW - 45_000 })], ageMs: 45_000 },
    { name: "2026-09-20T10-57-56-000+08-00-aaa-p30056", initialCwd: caller, lines: [requested("get_status", {}, { at: NOW - 800 })], ageMs: 800 },
  ]);
  const result = resolveRequestRoot({ tool: "get_status", args: {}, ...STARTUP, now: NOW, env });
  assert.deepEqual(result, { root: path.resolve(caller), source: "qoder-session-log(request-match)" });
});

test("指纹没命中但只有一个活跃会话时降级认领，并如实标注依据", (t) => {
  const mine = scratch("pm-caller-mine-", t);
  const stale = scratch("pm-caller-stale-", t);
  const { env } = fakeQoder(t, [
    { name: "2026-09-20T09-00-00-000+08-00-ccc-p30056", initialCwd: stale, ageMs: 3_600_000 },
    { name: "2026-09-20T10-57-56-000+08-00-aaa-p30056", initialCwd: mine, ageMs: 2000 },
  ]);
  const result = resolveRequestRoot({ tool: "audit_security", args: {}, ...STARTUP, now: NOW, env });
  assert.deepEqual(result, { root: path.resolve(mine), source: "qoder-session-log(only-active)" });
});

test("日志涨到几 MB 时仍要跨块往前扫到指纹，不能被固定尾部窗口漏掉", (t) => {
  const mine = scratch("pm-caller-big-", t);
  const filler: string[] = [];
  for (let i = 0; i < 6000; i += 1) {
    const stamp = new Date(NOW - 20_000 + i).toISOString();
    filler.push(`${stamp} INFO  debug.message [filler] ${"x".repeat(100)} line=${i}`);
  }
  const target = requested("get_status", { since: "2026-09-01" }, { at: NOW - 21_000 });
  const { env } = fakeQoder(t, [
    { name: "2026-09-20T10-57-56-000+08-00-aaa-p30056", initialCwd: mine, lines: [target, ...filler], ageMs: 500 },
  ]);
  const result = resolveRequestRoot({ tool: "get_status", args: { since: "2026-09-01" }, ...STARTUP, now: NOW, env });
  assert.deepEqual(result, { root: path.resolve(mine), source: "qoder-session-log(request-match)" });
});

test("拿不到任何会话证据时退回启动期提示，并标明是 spawn-time 定格", (t) => {
  const hint = scratch("pm-caller-hint-", t);
  const { configDir } = fakeQoder(t, []);
  const result = resolveRequestRoot({
    tool: "get_status",
    args: {},
    ...STARTUP,
    now: NOW,
    env: {
      QODER_CONFIG_DIR: configDir,
      [CLIENT_ADAPTER_ENV]: QODER_ADAPTER,
      [ROOT_HINT_ENV]: hint,
      [ROOT_HINT_SOURCE_ENV]: "QODER_WORKER_CWD",
    } as NodeJS.ProcessEnv,
  });
  assert.deepEqual(result, { root: path.resolve(hint), source: "QODER_WORKER_CWD(spawn-time)" });
});

test("多个会话同时活跃且无指纹时不猜，列出候选让人传 root", (t) => {
  const first = scratch("pm-caller-a-", t);
  const second = scratch("pm-caller-b-", t);
  const { env } = fakeQoder(t, [
    { name: "2026-09-20T10-57-56-000+08-00-aaa-p30056", initialCwd: first, ageMs: 1000 },
    { name: "2026-09-20T10-57-57-000+08-00-bbb-p30056", initialCwd: second, ageMs: 1500 },
  ]);
  const result = resolveRequestRoot({ tool: "get_status", args: {}, ...STARTUP, now: NOW, env });
  assert.equal(result.root, STARTUP.startupRoot);
  assert.match(result.source, /未猜测/);
  assert.equal(result.candidates?.length, 2);
});

test("日志里 initial_cwd 指向已删除目录时不当真", (t) => {
  const gone = scratch("pm-caller-gone-", t);
  const removed = path.join(gone, "removed");
  fs.mkdirSync(removed, { recursive: true });
  const { env } = fakeQoder(t, [
    { name: "2026-09-20T10-57-56-000+08-00-aaa-p30056", initialCwd: removed, ageMs: 500 },
  ]);
  fs.rmSync(gone, { recursive: true, force: true });
  const result = resolveRequestRoot({ tool: "get_status", args: {}, ...STARTUP, now: NOW, env });
  assert.deepEqual(result, { root: STARTUP.startupRoot, source: STARTUP.startupSource });
});

test("超出回溯窗口的旧会话不参与认领", (t) => {
  const old = scratch("pm-caller-old-", t);
  const { env } = fakeQoder(t, [
    { name: "2026-09-20T08-00-00-000+08-00-aaa-p30056", initialCwd: old, lines: [requested("get_status", {})], ageMs: 600_000 },
  ]);
  const result = resolveRequestRoot({ tool: "get_status", args: {}, ...STARTUP, now: NOW, env });
  assert.deepEqual(result, { root: STARTUP.startupRoot, source: STARTUP.startupSource });
});

interface Captured {
  content?: Array<{ text?: string }>;
  structuredContent?: Record<string, any>;
  isError?: boolean;
}
type Handler = (args: Record<string, any>) => Captured | Promise<Captured>;

function captureHandlers(startupRoot: string): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  const fake = {
    registerTool(name: string, _config: unknown, handler: Handler): void { handlers.set(name, handler); },
  } as unknown as McpServer;
  registerProjectTools(fake, startupRoot);
  registerRoadmapTools(fake, startupRoot);
  return handlers;
}

test("端到端：一个常驻进程服务两个窗口，get_status 返回调用方那个项目的账本，结构化载荷带全状态", async (t) => {
  const projectA = scratch("pm-e2e-a-", t);
  const projectB = scratch("pm-e2e-b-", t);
  initProject(projectA, { name: "A项目", modules: ["src"], license: "MIT", agentsMd: false });
  initProject(projectB, { name: "B项目", modules: ["src"], license: "MIT", agentsMd: false });

  const savedEnv = { ...process.env };
  t.after(() => {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, savedEnv);
  });

  // 先以「非 Qoder」语义只给 B 建里程碑，A 保持空路线图：两边账本必须能区分开
  process.env[CLIENT_ADAPTER_ENV] = "";
  const onB = captureHandlers(projectB).get("add_milestone")!;
  await onB({ title: "B 的里程碑" });

  // 常驻进程启动时定格在 A，但本次调用来自 B 窗口
  const now = Date.now();
  const { env } = fakeQoder(t, [
    { name: "2026-09-20T10-57-56-000+08-00-aaa-p30056", initialCwd: projectB, lines: [requested("get_status", {}, { at: now - 800 })], ageMs: 500 },
  ], now);
  Object.assign(process.env, env);

  const result = await captureHandlers(projectA).get("get_status")!({});
  const data = result.structuredContent!;
  assert.equal(data.runtime.root, path.resolve(projectB), "必须认领调用方窗口的项目根，而不是启动时定格的那个");
  assert.equal(data.runtime.root_source, "qoder-session-log(request-match)");
  assert.equal(data.project.name, "B项目");
  assert.deepEqual(data.milestones.map((m: { title: string }) => m.title), ["B 的里程碑"]);
  // 只有 runtime 段等于没状态：阶段/里程碑/焦点/健康/最近会话都必须在结构化载荷里
  for (const key of ["project", "milestones", "focus", "health", "last_session"]) {
    assert.ok(key in data, `structuredContent 缺少 ${key}`);
  }
  assert.ok(Array.isArray(data.focus));
  assert.equal(typeof data.health.open_debt, "number");
  assert.match(result.content![0].text!, /依据 qoder-session-log\(request-match\)/);
  assert.match(result.content![0].text!, /B项目/);

  // 不是 Qoder 拉起的进程（CLI / ZCode / 直接 stdio）行为不变：仍用启动根
  delete process.env[CLIENT_ADAPTER_ENV];
  const plain = await captureHandlers(projectA).get("get_status")!({});
  assert.equal(plain.structuredContent!.runtime.root, path.resolve(projectA));
  assert.equal(plain.structuredContent!.project.name, "A项目");
  assert.deepEqual(plain.structuredContent!.milestones, []);
});
