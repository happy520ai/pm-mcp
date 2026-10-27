import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { mkProj, initTestProject } from "./helpers.ts";
import {
  DEFAULT_MAX_HOURS,
  DEFAULT_MAX_ROUNDS,
  FAIL_EXIT_THRESHOLD,
  MAX_CONCURRENCY,
  MIN_CONCURRENCY,
  STALL_THRESHOLD,
  beginRound,
  defaultOrchestrator,
  endRound,
  loadOrchestrator,
  mutateOrchestrator,
  orchestratorPath,
  orchestratorStatus,
  readOrchestrator,
  saveOrchestrator,
  setGoal,
  setSettings,
  shouldExitLoop,
  validateConcurrency,
  validateMaxHours,
  validateMaxRounds,
} from "../src/orchestrator.ts";

function proj(): string {
  const root = mkProj();
  initTestProject(root);
  return root;
}

/* ------------------------------ fail-closed ------------------------------ */

test("台账缺失时默认禁用（fail-closed），不报错", () => {
  const root = proj();
  assert.equal(fs.existsSync(orchestratorPath(root)), false);
  const read = readOrchestrator(root);
  assert.equal(read.health, "missing");
  assert.equal(read.value.settings.enabled, false);
  assert.equal(read.value.goal, null);
  assert.equal(read.value.settings.max_concurrency, 3);
  assert.equal(read.value.settings.max_rounds, DEFAULT_MAX_ROUNDS);
  assert.equal(read.value.settings.max_hours, DEFAULT_MAX_HOURS);
});

test("台账损坏时视为禁用并记录问题，不抛错", () => {
  const root = proj();
  fs.mkdirSync(path.dirname(orchestratorPath(root)), { recursive: true });
  fs.writeFileSync(orchestratorPath(root), "{ not json", "utf8");
  const read = readOrchestrator(root);
  assert.equal(read.health, "invalid");
  assert.equal(read.value.settings.enabled, false);
  assert.match(read.issue as string, /orchestrator\.json/);
});

test("台账损坏时拒绝写入，且不覆盖原文件", () => {
  const root = proj();
  fs.writeFileSync(orchestratorPath(root), "{ not json", "utf8");
  assert.throws(() => mutateOrchestrator(root, (file) => file), /已损坏/);
  assert.equal(fs.readFileSync(orchestratorPath(root), "utf8"), "{ not json");
});

test("schema 不合规（未知字段外的错误值）也归为 invalid", () => {
  const root = proj();
  fs.writeFileSync(orchestratorPath(root), JSON.stringify(defaultOrchestrator()), "utf8");
  const file = saveOrchestrator(root, defaultOrchestrator());
  (file.settings as { max_concurrency: number }).max_concurrency = 99;
  fs.writeFileSync(orchestratorPath(root), JSON.stringify(file), "utf8");
  assert.equal(readOrchestrator(root).health, "invalid");
});

/* -------------------------------- 校验 -------------------------------- */

test("并发上限只接受 1-8 的整数，越界直接报错不截断", () => {
  assert.equal(validateConcurrency(MIN_CONCURRENCY), MIN_CONCURRENCY);
  assert.equal(validateConcurrency(MAX_CONCURRENCY), MAX_CONCURRENCY);
  assert.throws(() => validateConcurrency(0), /max_concurrency/);
  assert.throws(() => validateConcurrency(MAX_CONCURRENCY + 1), /max_concurrency/);
  assert.throws(() => validateConcurrency(2.5), /max_concurrency/);
});

test("轮数与小时预算各自校验，不静默改值", () => {
  assert.equal(validateMaxRounds(1), 1);
  assert.equal(validateMaxRounds(DEFAULT_MAX_ROUNDS), DEFAULT_MAX_ROUNDS);
  assert.throws(() => validateMaxRounds(0), /max_rounds/);
  assert.throws(() => validateMaxRounds(1.5), /max_rounds/);
  assert.equal(validateMaxHours(0.5), 0.5);
  assert.throws(() => validateMaxHours(0), /max_hours/);
  assert.throws(() => validateMaxHours(-3), /max_hours/);
});

/* -------------------------------- 目标 -------------------------------- */

test("set_goal 拒绝空 objective 与空 acceptance", () => {
  const root = proj();
  assert.throws(() => setGoal(root, { objective: "  ", acceptance: "通过测试" }), /objective 不能为空/);
  assert.throws(() => setGoal(root, { objective: "完成项目", acceptance: "   " }), /acceptance 不能为空/);
  assert.equal(loadOrchestrator(root).goal, null);
});

test("set_goal 写入后持久化，重复写入保留 created 时间", () => {
  const root = proj();
  const first = setGoal(root, { objective: "把服务上线", acceptance: "npm run quality 全绿" });
  assert.equal(first.goal?.objective, "把服务上线");
  assert.equal(first.goal?.acceptance, "npm run quality 全绿");
  const created = first.goal?.created as string;

  const second = setGoal(root, { objective: "把服务上线并加监控", acceptance: "npm run quality 全绿", note: "补充监控" });
  assert.equal(second.goal?.objective, "把服务上线并加监控");
  assert.equal(second.goal?.created, created);
  assert.equal(second.goal?.note, "补充监控");
  assert.equal(second.goal?.updated >= second.goal?.created, true);
});

/* -------------------------------- 开关 -------------------------------- */

test("开关必须给理由，只改并发不需要理由", () => {
  const root = proj();
  assert.throws(() => setSettings(root, { enabled: true }), /reason/);
  const changed = setSettings(root, { max_concurrency: 5 });
  assert.equal(changed.settings.max_concurrency, 5);
  assert.equal(changed.settings.enabled, false);
});

test("开启编排清除暂停标记并重置停滞与失败计数", () => {
  const root = proj();
  setGoal(root, { objective: "完成", acceptance: "测试全绿" });
  endRound(root, { runId: "r1", producedEvidence: false });
  endRound(root, { runId: "r2", producedEvidence: false });
  const on = setSettings(root, { enabled: true, reason: "开始迭代" });
  assert.equal(on.settings.enabled, true);
  assert.equal(on.run.paused_reason, null);
  assert.equal(on.run.paused_at, null);
  assert.equal(on.run.stall_rounds, 0);
  assert.equal(on.run.round_count, 2, "开启不应重置轮数预算");
});

test("关闭编排记录原因与时间", () => {
  const root = proj();
  setGoal(root, { objective: "完成", acceptance: "测试全绿" });
  setSettings(root, { enabled: true, reason: "开工" });
  const off = setSettings(root, { enabled: false, reason: "额度快用完了" });
  assert.equal(off.settings.enabled, false);
  assert.equal(off.run.paused_reason, "额度快用完了");
  assert.notEqual(off.run.paused_at, null);
  assert.ok(off.log.some((e) => e.kind === "disable" && e.note === "额度快用完了"));
});

/* ------------------------------- 状态推导 ------------------------------- */

test("orchestratorStatus 覆盖七种状态", () => {
  const root = proj();
  assert.equal(orchestratorStatus(loadOrchestrator(root)).status, "no-goal");

  setGoal(root, { objective: "完成", acceptance: "测试全绿" });
  assert.equal(orchestratorStatus(loadOrchestrator(root)).status, "disabled");

  setSettings(root, { enabled: true, reason: "开工" });
  const running = beginRound(root, "run-1");
  assert.equal(orchestratorStatus(running).status, "running");

  const done = endRound(root, { runId: "run-1", producedEvidence: true });
  assert.equal(orchestratorStatus(done).status, "ready");

  setSettings(root, { max_rounds: 1 });
  const exhausted = loadOrchestrator(root);
  assert.equal(orchestratorStatus(exhausted).status, "budget-exhausted");

  const stalled = mutateOrchestrator(root, (file) => {
    file.run.stall_rounds = STALL_THRESHOLD;
    return file;
  });
  assert.equal(orchestratorStatus(stalled).status, "stalled");

  const failed = mutateOrchestrator(root, (file) => {
    file.run.stall_rounds = 0;
    file.run.consecutive_failures = FAIL_EXIT_THRESHOLD;
    return file;
  });
  assert.equal(orchestratorStatus(failed).status, "failed-out");
});


/* ------------------------------ 轮次记账 ------------------------------ */

test("无新证据累加停滞计数，达到阈值后退出循环", () => {
  const root = proj();
  setGoal(root, { objective: "完成", acceptance: "测试全绿" });
  setSettings(root, { enabled: true, reason: "开工" });
  for (let i = 1; i <= STALL_THRESHOLD; i++) {
    endRound(root, { runId: `r${i}`, producedEvidence: false });
  }
  const stalled = loadOrchestrator(root);
  assert.equal(stalled.run.stall_rounds, STALL_THRESHOLD);
  assert.equal(stalled.run.round_count, STALL_THRESHOLD);
  assert.equal(shouldExitLoop(stalled), true);
  assert.equal(orchestratorStatus(stalled).status, "stalled");
});

test("有新证据会重置停滞计数", () => {
  const root = proj();
  setGoal(root, { objective: "完成", acceptance: "测试全绿" });
  setSettings(root, { enabled: true, reason: "开工" });
  endRound(root, { runId: "a", producedEvidence: false });
  endRound(root, { runId: "b", producedEvidence: false });
  endRound(root, { runId: "c", producedEvidence: true });
  const file = loadOrchestrator(root);
  assert.equal(file.run.stall_rounds, 0);
  assert.equal(file.run.round_count, 3);
  assert.equal(shouldExitLoop(file), false);
});

test("连续失败达到阈值触发退出，且重置停滞计数", () => {
  const root = proj();
  setGoal(root, { objective: "完成", acceptance: "测试全绿" });
  setSettings(root, { enabled: true, reason: "开工" });
  for (let i = 0; i < FAIL_EXIT_THRESHOLD; i++) {
    endRound(root, { runId: `f${i}`, producedEvidence: true, failure: "额度已耗尽" });
  }
  const file = loadOrchestrator(root);
  assert.equal(file.run.consecutive_failures, FAIL_EXIT_THRESHOLD);
  assert.equal(file.run.stall_rounds, 0);
  assert.equal(shouldExitLoop(file), true);
  assert.equal(orchestratorStatus(file).status, "failed-out");
  assert.match(orchestratorStatus(file).reason, /额度/);
});

test("同一时间只允许一轮，且结束轮次必须匹配 runId", () => {
  const root = proj();
  setGoal(root, { objective: "完成", acceptance: "测试全绿" });
  beginRound(root, "run-a");
  assert.throws(() => beginRound(root, "run-b"), /只允许一轮/);
  assert.throws(() => endRound(root, { runId: "run-b", producedEvidence: true }), /拒绝记账/);
  const ended = endRound(root, { runId: "run-a", producedEvidence: true });
  assert.equal(ended.run.active_run_id, null);
});

test("结束一个轮次后允许再开一轮", () => {
  const root = proj();
  setGoal(root, { objective: "完成", acceptance: "测试全绿" });
  beginRound(root, "run-a");
  endRound(root, { runId: "run-a", producedEvidence: true });
  const again = beginRound(root, "run-a");
  assert.equal(again.run.active_run_id, "run-a");
});

test("未设置目标时不能开轮", () => {
  const root = proj();
  setSettings(root, { enabled: true, reason: "想先跑起来" });
  assert.throws(() => beginRound(root, "run-x"), /尚未设置最终目标/);
});

test("日志有界，不会无限膨胀", () => {
  const root = proj();
  setGoal(root, { objective: "完成", acceptance: "测试全绿" });
  setSettings(root, { enabled: true, reason: "开工" });
  for (let i = 0; i < 40; i++) {
    endRound(root, { runId: `l${i}`, producedEvidence: i % 2 === 0 });
  }
  const file = loadOrchestrator(root);
  assert.ok(file.log.length <= 20, `日志应截断，实际 ${file.log.length}`);
  assert.ok(file.log.every((e) => e.at && e.kind && e.note));
});

/* --------------------------- MCP 工具层端到端 --------------------------- */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverEntry = path.join(repoRoot, "src", "index.ts");

async function connectClient(root: string) {
  const client = new Client({ name: "orch-it", version: "0" });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry, "--root", root],
    env: { PM_MCP_HOME: process.env.PM_MCP_HOME! },
  }));
  return client;
}

function textOf(result: { content?: Array<{ text?: string }> }): string {
  return (result.content ?? []).map((c) => c.text ?? "").join("\n");
}

test("编排工具端到端：目标 → 开关 → 开轮 → 停滞退出，get_status 暴露编排段", async (t) => {
  const root = mkProj();
  const client = await connectClient(root);
  t.after(() => client.close());
  const call = async (name: string, args: Record<string, unknown>) =>
    client.callTool({ name, arguments: args }) as Promise<{ content?: Array<{ text?: string }>; isError?: boolean }>;

  await call("init_project", { name: "编排端到端", modules: ["src"] });

  const before = await call("get_orchestrator", {});
  assert.match(textOf(before), /no-goal/);
  assert.match(textOf(before), /未设置/);

  const goal = await call("set_goal", { objective: "把 v0.7 发布出去", acceptance: "npm run gate 全绿并发布 npm" });
  assert.ok(!goal.isError, textOf(goal));
  assert.match(textOf(goal), /把 v0.7 发布出去/);

  const noReason = await call("set_orchestrator", { enabled: true });
  assert.equal(noReason.isError, true, "开关不给理由必须被拒绝");
  assert.match(textOf(noReason), /reason/);

  const badConcurrency = await call("set_orchestrator", { max_concurrency: 9 });
  assert.equal(badConcurrency.isError, true);
  assert.match(textOf(badConcurrency), /max_concurrency/);

  const on = await call("set_orchestrator", { enabled: true, reason: "开始自动迭代" });
  assert.ok(!on.isError, textOf(on));
  assert.match(textOf(on), /开启/);

  const begin = await call("record_round", { action: "begin", run_id: "wf-1" });
  assert.ok(!begin.isError, textOf(begin));
  assert.match(textOf(begin), /wf-1/);

  const again = await call("record_round", { action: "begin", run_id: "wf-2" });
  assert.equal(again.isError, true, "同一时间只允许一轮");

  const end = await call("record_round", { action: "end", run_id: "wf-1", produced_evidence: false });
  assert.ok(!end.isError, textOf(end));
  assert.match(textOf(end), /轮次 1\/40/);

  const status = await call("get_status", {});
  assert.match(textOf(status), /## 编排/);
  assert.match(textOf(status), /把 v0.7 发布出去/);

  const detail = await call("get_orchestrator", {});
  assert.match(textOf(detail), /停滞 1\/3/);
  assert.match(textOf(detail), /wf-1/);
});

test("预算传 null = 不限：轮数再高也不触发 budget-exhausted", () => {
  const root = proj();
  setGoal(root, { objective: "完成", acceptance: "测试全绿" });
  setSettings(root, { enabled: true, reason: "开工" });
  setSettings(root, { max_rounds: null, max_hours: null, reason: "用户要求不限" });
  const high = mutateOrchestrator(root, (file) => {
    file.run.round_count = 100000;
    return file;
  });
  assert.equal(high.settings.max_rounds, null);
  assert.equal(high.settings.max_hours, null);
  assert.equal(orchestratorStatus(high).status, "ready");
  assert.match(orchestratorStatus(high).reason, /不限/);
});
