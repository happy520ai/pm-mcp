#!/usr/bin/env node
/**
 * 独立 MCP 进程多 Agent 压力基准。
 *
 * 默认执行 10/20 Agent 各 20 轮：
 *   node scripts/benchmark-agents.mts
 *   node scripts/benchmark-agents.mts --agents 10,20 --rounds 30
 *
 * 每档先让所有 stdio MCP server 完成 initialize，再释放同一个 barrier。
 * 所有数据仅写入带随机所有权标记的系统临时目录，最终输出单个 JSON。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import {
  MAX_AGENTS,
  MAX_ROUNDS,
  OWNER_FILE,
  TEMP_PREFIX,
  connectAgents,
  createFixture,
  delay,
  distribution,
  fanout,
  markerCount,
  parseAgentBenchmarkArgs,
  requireConcurrent,
  requireCheck,
  requirePositiveInteger,
  rounded,
  taskData,
  usage,
  type AgentBenchmarkOptions,
  type ConnectedAgent,
  type FanoutResult,
  type Fixture,
} from "./agent-benchmark-support.mts";

export { parseAgentBenchmarkArgs } from "./agent-benchmark-support.mts";
export type { AgentBenchmarkOptions } from "./agent-benchmark-support.mts";

function scenarioRecord(name: string, result: FanoutResult, checks: Record<string, unknown>): Record<string, unknown> {
  const errors = result.replies.filter((reply) => reply.isError).length;
  return {
    name,
    ...result.metrics,
    outcomes: {
      success: result.replies.length - errors,
      errors,
      idempotent_replays: result.replies.filter((reply) => reply.text.includes("幂等复用")).length,
      pending_placeholders: result.replies.filter((reply) => reply.text.includes("幂等占位")).length,
      transport_errors: result.replies.filter((reply) => reply.transportError !== null).length,
    },
    checks,
  };
}

function timingSummary(records: Record<string, unknown>[]): Record<string, unknown> {
  return {
    samples: records.length,
    batch_duration_ms: distribution(records.map((item) => Number(item.duration_ms))),
    dispatch_skew_ms: distribution(records.map((item) => Number(item.dispatch_skew_ms))),
    peak_inflight_max: Math.max(0, ...records.map((item) => Number(item.peak_inflight))),
  };
}

function perScenarioSummaries(records: Record<string, unknown>[]): Record<string, unknown> {
  const names = [...new Set(records.map((item) => String(item.name)))];
  return Object.fromEntries(names.map((name) => [name, timingSummary(records.filter((item) => item.name === name))]));
}

async function runRound(agents: ConnectedAgent[], fixture: Fixture, agentCount: number, round: number, runId: string) {
  const scenarios: Record<string, unknown>[] = [];
  const prefix = `bench-${agentCount}-${runId}-${round}`;

  let before = taskData(fixture.root).tasks.length;
  const same = await fanout(agents, () => ({
    name: "add_task",
    arguments: { title: `${prefix}-same`, idempotency_key: `${prefix}:same` },
  }));
  requireConcurrent(same, agentCount, "同键同参");
  let after = taskData(fixture.root).tasks.length;
  requireCheck(same.metrics.sent === agentCount && same.metrics.done === agentCount, "同键同参 sent/done 不完整");
  requireCheck(same.replies.every((reply) => !reply.isError), "同键同参出现错误");
  requireCheck(same.replies.every((reply) => !reply.text.includes("幂等占位")), "同键同参仍有调用者只拿到 pending 占位");
  requireCheck(after - before === 1, `同键同参应只写 1 条，实际 ${after - before}`);
  scenarios.push(scenarioRecord("same_key_same_args", same, { task_delta: 1, single_business_write: true, all_callers_settled: true }));

  before = after;
  const conflict = await fanout(agents, (index) => ({
    name: "add_task",
    arguments: { title: `${prefix}-conflict-${index}`, idempotency_key: `${prefix}:conflict` },
  }));
  requireConcurrent(conflict, agentCount, "同键冲突");
  after = taskData(fixture.root).tasks.length;
  const conflictErrors = conflict.replies.filter((reply) => reply.isError);
  requireCheck(conflict.metrics.sent === agentCount && conflict.metrics.done === agentCount, "同键冲突 sent/done 不完整");
  requireCheck(conflictErrors.length === agentCount - 1, `同键冲突应拒绝 ${agentCount - 1} 次，实际 ${conflictErrors.length}`);
  requireCheck(conflictErrors.every((reply) => reply.text.includes("冲突") && reply.transportError === null), "同键冲突未 fail-closed");
  requireCheck(after - before === 1, `同键冲突应只写 1 条，实际 ${after - before}`);
  scenarios.push(scenarioRecord("same_key_conflict", conflict, { task_delta: 1, rejected: agentCount - 1, fail_closed: true }));

  before = after;
  const distinct = await fanout(agents, (index) => ({
    name: "add_task",
    arguments: { title: `${prefix}-distinct-${index}`, idempotency_key: `${prefix}:distinct:${index}` },
  }));
  requireConcurrent(distinct, agentCount, "不同键写");
  after = taskData(fixture.root).tasks.length;
  requireCheck(distinct.metrics.sent === agentCount && distinct.metrics.done === agentCount, "不同键写 sent/done 不完整");
  requireCheck(distinct.replies.every((reply) => !reply.isError), "不同键写出现错误");
  requireCheck(after - before === agentCount, `不同键应写 ${agentCount} 条，实际 ${after - before}`);
  scenarios.push(scenarioRecord("distinct_key_writes", distinct, { task_delta: agentCount, all_persisted: true }));

  before = after;
  const keyless = await fanout(agents, () => ({ name: "add_task", arguments: { title: `${prefix}-keyless` } }));
  requireConcurrent(keyless, agentCount, "无键瞬时写");
  after = taskData(fixture.root).tasks.length;
  requireCheck(keyless.metrics.sent === agentCount && keyless.metrics.done === agentCount, "无键瞬时写 sent/done 不完整");
  requireCheck(keyless.replies.every((reply) => !reply.isError), "无键瞬时写出现错误");
  requireCheck(keyless.replies.every((reply) => !reply.text.includes("幂等占位")), "无键瞬时写仍有调用者只拿到 pending 占位");
  requireCheck(after - before === 1, `无键瞬时写应只落 1 条，实际 ${after - before}`);
  scenarios.push(scenarioRecord("keyless_instantaneous", keyless, { task_delta: 1, auto_deduplicated: true }));

  const markerBefore = markerCount(fixture.marker);
  const read = await fanout(agents, () => ({
    name: "search_code",
    arguments: { query: "agent-benchmark-needle", glob: "src/**/*.ts", max_results: 10 },
  }));
  requireConcurrent(read, agentCount, "同参读");
  const markerAfter = markerCount(fixture.marker);
  requireCheck(read.metrics.sent === agentCount && read.metrics.done === agentCount, "同参读 sent/done 不完整");
  const readErrors = read.replies
    .map((reply, agent) => ({ agent, ...reply }))
    .filter((reply) => reply.isError);
  requireCheck(readErrors.length === 0, `第 ${round} 轮同参读出现错误: ${JSON.stringify(readErrors)}`);
  requireCheck(new Set(read.replies.map((reply) => reply.text)).size === 1, "同参读未复用完全相同结果");
  requireCheck(read.replies.every((reply) => reply.text.includes("ripgrep 后端")), "同参读未走 fake rg 后端");
  requireCheck(markerAfter - markerBefore === 1, `同参读业务函数应执行 1 次，fake rg 记录为 ${markerAfter - markerBefore}`);
  scenarios.push(scenarioRecord("coalesced_same_args_read", read, {
    fake_rg_marker_delta: 1,
    one_execution: true,
    identical_results: true,
  }));
  return { round, scenarios, tasks_after_round: after };
}

function walkFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const files: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(absolute);
      else if (entry.isFile()) files.push(absolute);
    }
  }
  return files;
}

function inspectArtifacts(fixture: Fixture, expectedTasks: number): Record<string, unknown> & { passed: boolean } {
  const allFiles = [...walkFiles(path.join(fixture.root, ".pm")), ...walkFiles(fixture.home)];
  const relative = (file: string) => path.relative(fixture.base, file).replaceAll("\\", "/");
  const jsonFiles = allFiles.filter((file) => file.endsWith(".json"));
  const invalidJson: string[] = [];
  const pendingRecords: string[] = [];
  const uncertainRecords: string[] = [];
  for (const file of jsonFiles) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { status?: unknown; owner_pid?: unknown };
      if (parsed.status === "pending" && typeof parsed.owner_pid === "number") pendingRecords.push(relative(file));
      if (parsed.status === "uncertain" && typeof parsed.owner_pid === "number") uncertainRecords.push(relative(file));
    } catch {
      invalidJson.push(relative(file));
    }
  }
  const data = taskData(fixture.root);
  const ids = data.tasks.map((task) => task.id);
  const numericIds = ids.map((id) => Number(id.slice(2)));
  const idsValid = ids.every((id) => /^T-\d{3,}$/.test(id)) &&
    new Set(ids).size === ids.length &&
    numericIds.every((value, index) => value === index + 1) &&
    data.seq === ids.length;
  const tempFiles = allFiles.filter((file) => file.endsWith(".tmp")).map(relative);
  const lockFiles = allFiles.filter((file) => path.basename(file) === ".lock" || file.endsWith(".lock")).map(relative);
  const passed = invalidJson.length === 0 && data.tasks.length === expectedTasks && idsValid &&
    tempFiles.length === 0 && lockFiles.length === 0 && pendingRecords.length === 0 && uncertainRecords.length === 0;
  return {
    passed,
    json: { files_checked: jsonFiles.length, invalid: invalidJson },
    tasks: { expected: expectedTasks, actual: data.tasks.length, seq: data.seq, ids_unique_contiguous: idsValid },
    residuals: {
      temp_files: tempFiles,
      lock_files: lockFiles,
      pending_operation_records: pendingRecords,
      uncertain_operation_records: uncertainRecords,
    },
  };
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function closeAgents(agents: ConnectedAgent[], pids: number[]): Promise<{ orphan_pids: number[]; close_errors: string[] }> {
  const closed = await Promise.allSettled(agents.map((agent) => agent.client.close()));
  const closeErrors = closed
    .filter((item): item is PromiseRejectedResult => item.status === "rejected")
    .map((item) => item.reason instanceof Error ? item.reason.message : String(item.reason));
  const deadline = Date.now() + 4_000;
  let alive = pids.filter(processAlive);
  while (alive.length > 0 && Date.now() < deadline) {
    await delay(25);
    alive = pids.filter(processAlive);
  }
  return { orphan_pids: alive, close_errors: closeErrors };
}

function cleanupFixture(fixture: Fixture): { verified: boolean; removed: boolean; detail: string } {
  try {
    const tempReal = fs.realpathSync(os.tmpdir());
    const baseReal = fs.realpathSync(fixture.base);
    const rel = path.relative(tempReal, baseReal);
    const directChild = rel.length > 0 && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel) && !rel.includes(path.sep);
    const owned = fs.readFileSync(path.join(baseReal, OWNER_FILE), "utf8") === fixture.ownerToken;
    if (!directChild || !path.basename(baseReal).startsWith(TEMP_PREFIX) || !owned) {
      return { verified: false, removed: false, detail: "所有权校验失败，拒绝删除" };
    }
    fs.rmSync(baseReal, { recursive: true, force: false });
    const removed = !fs.existsSync(baseReal);
    return { verified: true, removed, detail: removed ? "已删除经校验的临时目录" : "临时目录仍存在" };
  } catch (error) {
    return { verified: false, removed: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

async function runAgentGroup(agentCount: number, rounds: number): Promise<Record<string, unknown> & { ok: boolean }> {
  const fixture = createFixture(agentCount);
  const started = performance.now();
  const runId = randomUUID().replaceAll("-", "").slice(0, 12);
  let agents: ConnectedAgent[] = [];
  let pids: number[] = [];
  let initializedAt: number[] = [];
  let barrierReleasedAt: number | null = null;
  const results: Awaited<ReturnType<typeof runRound>>[] = [];
  let failure: string | null = null;
  try {
    const connected = await connectAgents(fixture, agentCount);
    agents = connected.agents;
    pids = connected.pids;
    initializedAt = connected.initializedAt;
    requireCheck(pids.length === agentCount && new Set(pids).size === agentCount, "每个 Agent 必须拥有独立 MCP server PID");
    barrierReleasedAt = performance.now();
    for (let round = 1; round <= rounds; round += 1) results.push(await runRound(agents, fixture, agentCount, round, runId));
  } catch (error) {
    failure = error instanceof Error ? error.stack ?? error.message : String(error);
  }
  const lifecycle = await closeAgents(agents, pids);
  const expectedTasks = rounds * (agentCount + 3);
  let artifacts: ReturnType<typeof inspectArtifacts>;
  try {
    artifacts = inspectArtifacts(fixture, expectedTasks);
  } catch (error) {
    artifacts = {
      passed: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  const cleanup = cleanupFixture(fixture);
  const sent = results.flatMap((round) => round.scenarios).reduce((sum, item) => sum + Number(item.sent ?? 0), 0);
  const done = results.flatMap((round) => round.scenarios).reduce((sum, item) => sum + Number(item.done ?? 0), 0);
  const peakInflight = Math.max(0, ...results.flatMap((round) => round.scenarios).map((item) => Number(item.peak_inflight ?? 0)));
  const scenarioRecords = results.flatMap((round) => round.scenarios);
  const initializationSkew = initializedAt.length > 1 ? Math.max(...initializedAt) - Math.min(...initializedAt) : 0;
  const ok = failure === null && results.length === rounds && artifacts.passed && lifecycle.orphan_pids.length === 0 &&
    lifecycle.close_errors.length === 0 && cleanup.verified && cleanup.removed;
  return {
    ok,
    agents: agentCount,
    rounds_requested: rounds,
    rounds_completed: results.length,
    initialization: {
      requested: agentCount,
      initialized: initializedAt.length,
      independent_server_pids: pids,
      unique_pids: new Set(pids).size,
      initialization_skew_ms: rounded(initializationSkew),
      barrier_released_after_all_initialized: barrierReleasedAt !== null && initializedAt.every((time) => time <= barrierReleasedAt!),
    },
    aggregate: {
      sent,
      done,
      peak_inflight: peakInflight,
      duration_ms: rounded(performance.now() - started),
      timing_summary: timingSummary(scenarioRecords),
    },
    scenario_summaries: perScenarioSummaries(scenarioRecords),
    round_results: results,
    artifacts,
    lifecycle,
    cleanup,
    ...(failure ? { error: failure, server_stderr_tail: agents.map((agent) => agent.stderr.join("").slice(-1_000)) } : {}),
  };
}

export async function runAgentBenchmark(options: AgentBenchmarkOptions): Promise<Record<string, unknown> & { ok: boolean }> {
  requireCheck(options.agents.length > 0, "至少需要一个 Agent 档位");
  for (const count of options.agents) requirePositiveInteger(String(count), "agents", MAX_AGENTS);
  requirePositiveInteger(String(options.rounds), "rounds", MAX_ROUNDS);
  const startedAt = new Date().toISOString();
  const groups = [];
  for (const count of options.agents) groups.push(await runAgentGroup(count, options.rounds));
  return {
    ok: groups.every((group) => group.ok),
    benchmark: "pm-mcp independent stdio multi-agent concurrency",
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    environment: { node: process.version, platform: process.platform, release: os.release(), arch: process.arch },
    configuration: { agents: options.agents, rounds: options.rounds, scenarios_per_round: 5, data: "owned synthetic temporary project" },
    groups,
  };
}

/** 把完整证据写到调用者显式指定的位置；同目录唯一 tmp + rename，且不覆盖既有证据。 */
export function writeBenchmarkJson(output: string, value: unknown): string {
  if (!output.trim() || path.extname(output).toLowerCase() !== ".json") {
    throw new Error("输出路径必须是调用者显式指定的 .json 文件");
  }
  const target = path.resolve(output);
  if (fs.existsSync(target)) throw new Error(`输出文件已存在，拒绝覆盖证据: ${target}`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
    fs.renameSync(temporary, target);
  } catch (error) {
    try { fs.rmSync(temporary, { force: true }); } catch { /* 保留原始写入错误 */ }
    throw error;
  }
  return target;
}

async function main(): Promise<void> {
  try {
    const parsed = parseAgentBenchmarkArgs(process.argv.slice(2));
    if (parsed.help) {
      console.log(usage());
      return;
    }
    const result = await runAgentBenchmark(parsed);
    const outputFile = parsed.output ? path.resolve(parsed.output) : null;
    const payload = outputFile ? { ...result, output: { file: outputFile, atomic: true, overwritten: false } } : result;
    if (parsed.output) writeBenchmarkJson(parsed.output, payload);
    console.log(JSON.stringify(payload, null, 2));
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    console.log(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error), usage: usage() }, null, 2));
    process.exitCode = 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
