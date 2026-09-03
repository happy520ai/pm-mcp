import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { initProject } from "../src/init.ts";
import { TasksFileSchema } from "../src/types.ts";

const DEFAULT_AGENTS = [10, 20];
const DEFAULT_ROUNDS = 20;
export const MAX_AGENTS = 64;
export const MAX_ROUNDS = 100;
export const TEMP_PREFIX = "pm-mcp-agent-benchmark-";
export const OWNER_FILE = ".benchmark-owner";
const SERVER_ENTRY = fileURLToPath(new URL("../src/index.ts", import.meta.url));

export interface AgentBenchmarkOptions {
  agents: number[];
  rounds: number;
}

export interface ToolReply {
  isError: boolean;
  text: string;
  transportError: string | null;
}

export interface Distribution {
  samples: number;
  p50: number;
  p95: number;
  max: number;
}

export interface FanoutResult {
  metrics: {
    sent: number;
    done: number;
    dispatch_skew_ms: number;
    duration_ms: number;
    peak_inflight: number;
    all_dispatched_before_first_done: boolean;
    call_latency_ms: Distribution;
  };
  replies: ToolReply[];
}

export interface Fixture {
  base: string;
  root: string;
  home: string;
  marker: string;
  preload: string;
  ownerToken: string;
}

export interface ConnectedAgent {
  client: Client;
  transport: StdioClientTransport;
  stderr: string[];
}

export interface PartialConnectionCleanup {
  close_errors: string[];
  orphan_pids: number[];
}

export function rounded(value: number): number {
  return Number(value.toFixed(3));
}

/** Nearest-rank percentile，短样本也不做外推。 */
export function distribution(values: number[]): Distribution {
  if (values.length === 0) return { samples: 0, p50: 0, p95: 0, max: 0 };
  const sorted = [...values].sort((left, right) => left - right);
  const at = (ratio: number) => sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)];
  return {
    samples: sorted.length,
    p50: rounded(at(0.5)),
    p95: rounded(at(0.95)),
    max: rounded(sorted[sorted.length - 1]),
  };
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** initialize 部分失败时调用者拿不到 agents，因此必须在本层关闭所有已创建连接。 */
export async function closePartialConnections(agents: ConnectedAgent[]): Promise<PartialConnectionCleanup> {
  const pids = agents.map((agent) => agent.transport.pid).filter((pid): pid is number => pid !== null);
  const closed = await Promise.allSettled(agents.map(async (agent) => {
    let clientError: unknown;
    try {
      await agent.client.close();
    } catch (error) {
      clientError = error;
    }
    try {
      await agent.transport.close();
    } catch (error) {
      throw clientError ?? error;
    }
    if (clientError) throw clientError;
  }));
  const closeErrors = closed
    .filter((item): item is PromiseRejectedResult => item.status === "rejected")
    .map((item) => item.reason instanceof Error ? item.reason.message : String(item.reason));
  const deadline = Date.now() + 4_000;
  let alive = pids.filter(processAlive);
  while (alive.length > 0 && Date.now() < deadline) {
    await delay(25);
    alive = pids.filter(processAlive);
  }
  return { close_errors: closeErrors, orphan_pids: alive };
}

export function requirePositiveInteger(raw: string, flag: string, max: number): number {
  if (!/^[1-9]\d*$/.test(raw)) throw new Error(`${flag} 必须是正整数`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > max) throw new Error(`${flag} 必须在 1..${max} 之间`);
  return value;
}

export function parseAgentBenchmarkArgs(args: string[]): AgentBenchmarkOptions & { help: boolean; output?: string } {
  let agentText: string | undefined;
  let roundText: string | undefined;
  let output: string | undefined;
  let help = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--agents" || arg === "--rounds" || arg === "--output") {
      const value = args[index + 1];
      if (!value) throw new Error(`${arg} 缺少值`);
      if (arg === "--agents") {
        if (agentText !== undefined) throw new Error("--agents 只能指定一次");
        agentText = value;
      } else if (arg === "--rounds") {
        if (roundText !== undefined) throw new Error("--rounds 只能指定一次");
        roundText = value;
      } else {
        if (output !== undefined) throw new Error("--output 只能指定一次");
        output = value;
      }
      index += 1;
    } else if (arg.startsWith("--agents=")) {
      if (agentText !== undefined) throw new Error("--agents 只能指定一次");
      agentText = arg.slice("--agents=".length);
    } else if (arg.startsWith("--rounds=")) {
      if (roundText !== undefined) throw new Error("--rounds 只能指定一次");
      roundText = arg.slice("--rounds=".length);
    } else if (arg.startsWith("--output=")) {
      if (output !== undefined) throw new Error("--output 只能指定一次");
      output = arg.slice("--output=".length);
    } else {
      throw new Error(`未知参数: ${arg}`);
    }
  }
  const agents = (agentText ?? DEFAULT_AGENTS.join(","))
    .split(",")
    .map((item) => requirePositiveInteger(item.trim(), "--agents", MAX_AGENTS));
  if (agents.some((value) => value < 2)) throw new Error("--agents 每档至少为 2");
  if (new Set(agents).size !== agents.length) throw new Error("--agents 不得包含重复档位");
  const rounds = requirePositiveInteger(roundText ?? String(DEFAULT_ROUNDS), "--rounds", MAX_ROUNDS);
  if (output !== undefined && (!output.trim() || path.extname(output).toLowerCase() !== ".json")) {
    throw new Error("--output 必须显式指定 .json 文件路径");
  }
  return { agents, rounds, help, ...(output ? { output } : {}) };
}

export function usage(): string {
  return [
    "用法: node scripts/benchmark-agents.mts [--agents 10,20] [--rounds 20] [--output <file.json>]",
    `Agent 档位范围 2..${MAX_AGENTS}，轮数范围 1..${MAX_ROUNDS}；默认 10/20 Agent 各 20 轮。`,
    "--output 无默认值；仅显式指定时原子写入，且拒绝覆盖已有证据文件。",
  ].join("\n");
}

export function createFixture(agentCount: number): Fixture {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX));
  const ownerToken = randomUUID();
  const root = path.join(base, "project");
  const home = path.join(base, "home");
  const marker = path.join(base, "fake-rg-calls.jsonl");
  const preload = path.join(base, "fake-rg-preload.cjs");
  fs.writeFileSync(path.join(base, OWNER_FILE), ownerToken, "utf8");
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(root, "src", "marker.ts"), "export const agentBenchmarkNeedle = 'agent-benchmark-needle';\n", "utf8");
  fs.writeFileSync(marker, "", "utf8");
  fs.writeFileSync(preload, [
    "const fs = require('node:fs');",
    "const child = require('node:child_process');",
    "const { syncBuiltinESMExports } = require('node:module');",
    "const original = child.spawnSync;",
    "child.spawnSync = function(command, args, options) {",
    "  if (command !== 'rg') return original.apply(this, arguments);",
    "  const version = Array.isArray(args) && args.length === 1 && args[0] === '--version';",
    "  if (!version) {",
    "    const marker = process.env.PM_AGENT_BENCH_RG_MARKER;",
    "    if (!marker) throw new Error('PM_AGENT_BENCH_RG_MARKER is missing');",
    "    fs.appendFileSync(marker, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }) + '\\n');",
    "    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2_000);",
    "  }",
    "  const stdout = version ? 'ripgrep fake-agent-benchmark 1.0\\n' : 'src/marker.ts:1:agent-benchmark-needle\\n';",
    "  return { pid: 0, output: [null, stdout, ''], stdout, stderr: '', status: 0, signal: null };",
    "};",
    "syncBuiltinESMExports();",
    "",
  ].join("\n"), "utf8");
  initProject(root, { name: `agent benchmark ${agentCount}`, modules: ["src"], license: "MIT" });
  return { base, root, home, marker, preload, ownerToken };
}

function preloadOption(file: string): string {
  // NODE_OPTIONS 会把反斜杠当作转义符；Windows 绝对路径必须先转成正斜杠。
  return `--require="${file.replaceAll("\\", "/").replace(/"/g, "\\\"")}"`;
}

export async function connectAgents(fixture: Fixture, count: number): Promise<{
  agents: ConnectedAgent[];
  initializedAt: number[];
  pids: number[];
}> {
  const agents: ConnectedAgent[] = [];
  for (let index = 0; index < count; index += 1) {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [SERVER_ENTRY, "--root", fixture.root],
      env: {
        PATH: process.env.PATH ?? "",
        PM_MCP_HOME: fixture.home,
        PM_AGENT_BENCH_RG_MARKER: fixture.marker,
        NODE_OPTIONS: preloadOption(fixture.preload),
      },
      stderr: "pipe",
    });
    const stderr: string[] = [];
    transport.stderr?.on("data", (chunk) => {
      if (stderr.join("").length < 8_192) stderr.push(String(chunk));
    });
    agents.push({ client: new Client({ name: `agent-benchmark-${index}`, version: "1" }), transport, stderr });
  }
  const initializedAt = new Array<number>(count);
  const connections = await Promise.allSettled(agents.map(async (agent, index) => {
    await agent.client.connect(agent.transport);
    initializedAt[index] = performance.now();
  }));
  const failures = connections.filter((item): item is PromiseRejectedResult => item.status === "rejected");
  if (failures.length > 0) {
    const cleanup = await closePartialConnections(agents);
    const cause = failures[0].reason instanceof Error ? failures[0].reason.message : String(failures[0].reason);
    throw new Error(
      `MCP server initialize 失败 ${failures.length}/${count}: ${cause}; ` +
      `部分连接清理 close_errors=${cleanup.close_errors.length}, orphan_pids=${JSON.stringify(cleanup.orphan_pids)}`,
    );
  }
  const pids = agents.map((agent) => agent.transport.pid).filter((pid): pid is number => pid !== null);
  return { agents, initializedAt, pids };
}

function replyText(result: unknown): ToolReply {
  const value = result as { isError?: boolean; content?: Array<{ text?: string }> };
  return {
    isError: value.isError === true,
    text: (value.content ?? []).map((item) => item.text ?? "").join("\n"),
    transportError: null,
  };
}

export async function fanout(
  agents: ConnectedAgent[],
  request: (index: number) => { name: string; arguments: Record<string, unknown> },
): Promise<FanoutResult> {
  const started = performance.now();
  const sentAt: number[] = [];
  const doneAt: number[] = [];
  let sent = 0;
  let done = 0;
  let inflight = 0;
  let peakInflight = 0;
  const callLatencies: number[] = [];
  const replies = await Promise.all(agents.map(async (agent, index): Promise<ToolReply> => {
    const callStarted = performance.now();
    sentAt.push(callStarted);
    sent += 1;
    inflight += 1;
    peakInflight = Math.max(peakInflight, inflight);
    try {
      return replyText(await agent.client.callTool(request(index)));
    } catch (error) {
      return { isError: true, text: "", transportError: error instanceof Error ? error.message : String(error) };
    } finally {
      doneAt.push(performance.now());
      callLatencies.push(performance.now() - callStarted);
      inflight -= 1;
      done += 1;
    }
  }));
  const dispatchSkew = sentAt.length > 1 ? Math.max(...sentAt) - Math.min(...sentAt) : 0;
  return {
    metrics: {
      sent,
      done,
      dispatch_skew_ms: rounded(dispatchSkew),
      duration_ms: rounded(performance.now() - started),
      peak_inflight: peakInflight,
      all_dispatched_before_first_done: Math.max(...sentAt) < Math.min(...doneAt),
      call_latency_ms: distribution(callLatencies),
    },
    replies,
  };
}

export function requireConcurrent(result: FanoutResult, agentCount: number, label: string): void {
  const skewLimit = agentCount <= 10 ? 50 : 100;
  requireCheck(result.metrics.peak_inflight === agentCount, `${label} peak_inflight 应为 ${agentCount}`);
  requireCheck(result.metrics.all_dispatched_before_first_done, `${label} 未证明全部请求在首个完成前发出`);
  requireCheck(result.metrics.dispatch_skew_ms <= skewLimit, `${label} dispatch skew ${result.metrics.dispatch_skew_ms}ms 超过 ${skewLimit}ms`);
  requireCheck(result.metrics.call_latency_ms.samples === agentCount, `${label} 延迟样本不完整`);
}

export function taskData(root: string) {
  return TasksFileSchema.parse(JSON.parse(fs.readFileSync(path.join(root, ".pm", "tasks.json"), "utf8")));
}

export function markerCount(marker: string): number {
  return fs.readFileSync(marker, "utf8").split(/\r?\n/).filter(Boolean).length;
}

export function requireCheck(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
