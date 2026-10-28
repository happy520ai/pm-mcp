import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { mkProj, initTestProject, qualityEvidenceFixture } from "./helpers.ts";
import {
  DEFAULT_MAX_HOURS,
  DEFAULT_MAX_ROUNDS,
  FAIL_EXIT_THRESHOLD,
  MAX_CONCURRENCY,
  MIN_CONCURRENCY,
  STALL_THRESHOLD,
  beginRound,
  completeGoal,
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
  validateMaxTokens,
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
  beginRound(root, "r1");
  endRound(root, { runId: "r1", producedEvidence: false , tokensUnknown: true });
  beginRound(root, "r2");
  endRound(root, { runId: "r2", producedEvidence: false , tokensUnknown: true });
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

  const done = endRound(root, { runId: "run-1", producedEvidence: true , tokensUnknown: true });
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
    beginRound(root, `r${i}`);
    endRound(root, { runId: `r${i}`, producedEvidence: false , tokensUnknown: true });
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
  beginRound(root, "a");
  endRound(root, { runId: "a", producedEvidence: false, tokensUnknown: true });
  beginRound(root, "b");
  endRound(root, { runId: "b", producedEvidence: false, tokensUnknown: true });
  beginRound(root, "c");
  fs.writeFileSync(path.join(root, "evidence.ts"), "export const evidence = 1;\n", "utf8");
  endRound(root, { runId: "c", producedEvidence: true, tokensUnknown: true });
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
    beginRound(root, `f${i}`);
    endRound(root, { runId: `f${i}`, producedEvidence: true, failure: "额度已耗尽" , tokensUnknown: true });
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
  assert.throws(() => endRound(root, { runId: "run-b", producedEvidence: true, tokensUnknown: true }), /拒绝记账/);
  const ended = endRound(root, { runId: "run-a", producedEvidence: true , tokensUnknown: true });
  assert.equal(ended.run.active_run_id, null);
});

test("结束一个轮次后允许再开一轮（但 run_id 必须换新的）", () => {
  const root = proj();
  setGoal(root, { objective: "完成", acceptance: "测试全绿" });
  beginRound(root, "run-a");
  endRound(root, { runId: "run-a", producedEvidence: true , tokensUnknown: true });
  const again = beginRound(root, "run-b");
  assert.equal(again.run.active_run_id, "run-b");
  endRound(root, { runId: "run-b", producedEvidence: false, tokensUnknown: true });
  assert.throws(() => beginRound(root, "run-a"), /已结算过/);
});

test("同一 run_id 不能重复结算：end 必须先 begin 且只能成功一次", () => {
  const root = proj();
  setGoal(root, { objective: "完成", acceptance: "测试全绿" });
  assert.throws(
    () => endRound(root, { runId: "ghost", producedEvidence: false, tokensUnknown: true }),
    /没有在飞的轮次/,
  );
  assert.equal(loadOrchestrator(root).run.round_count, 0);

  beginRound(root, "once");
  const first = endRound(root, { runId: "once", producedEvidence: false, tokensUnknown: true });
  assert.equal(first.run.round_count, 1);
  assert.equal(first.run.stall_rounds, 1);
  assert.throws(
    () => endRound(root, { runId: "once", producedEvidence: true, tokensUnknown: true }),
    /已结算过|没有在飞的轮次/,
  );
  const after = loadOrchestrator(root);
  assert.equal(after.run.round_count, 1, "重复结算不得增加轮数");
  assert.equal(after.run.stall_rounds, 1, "重复结算不得改变停滞计数");
});

test("目标变更会作废在飞轮次，旧轮次不能再结算", () => {
  const root = proj();
  setGoal(root, { objective: "目标 A", acceptance: "A 通过" });
  beginRound(root, "run-for-a");
  setGoal(root, { objective: "目标 B", acceptance: "B 通过" });
  const after = loadOrchestrator(root);
  assert.equal(after.run.active_run_id, null, "换目标必须作废旧轮次");
  assert.ok(after.log.some((e) => e.kind === "round-cancelled"));
  assert.throws(
    () => endRound(root, { runId: "run-for-a", producedEvidence: true, tokensUnknown: true }),
    /没有在飞的轮次|已结算过/,
  );
  assert.equal(loadOrchestrator(root).run.round_count, 0);
});

test("目标指纹写入基线，只改 note 不作废轮次", () => {
  const root = proj();
  setGoal(root, { objective: "完成", acceptance: "测试全绿" });
  const begun = beginRound(root, "goal-hash");
  assert.match(begun.run.round_baseline!.goal_hash!, /^[a-f0-9]{64}$/);
  setGoal(root, { objective: "完成", acceptance: "测试全绿", note: "补充说明" });
  assert.equal(loadOrchestrator(root).run.active_run_id, "goal-hash");
  const ended = endRound(root, { runId: "goal-hash", producedEvidence: false, tokensUnknown: true });
  assert.equal(ended.run.round_count, 1);
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
    beginRound(root, `l${i}`);
    endRound(root, { runId: `l${i}`, producedEvidence: i % 2 === 0 , tokensUnknown: true });
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

  const end = await call("record_round", { action: "end", run_id: "wf-1", produced_evidence: false, tokens_used: 1200 });
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

/* ---------------------------- 轮次证据核验 ---------------------------- */

test("begin 记录证据基线：源码指纹与最新质量报告", () => {
  const root = proj();
  setGoal(root, { objective: "完成", acceptance: "测试全绿" });
  const file = beginRound(root, { runId: "ev-1", kind: "cli" });
  assert.equal(file.run.active_run_kind, "cli");
  assert.ok(file.run.round_baseline, "begin 必须记录基线");
  assert.match(file.run.round_baseline!.source_sha256, /^[a-f0-9]{64}$/);
  assert.equal(file.run.round_baseline!.quality_report, null);
  assert.match(file.run.round_baseline!.goal_hash!, /^[a-f0-9]{64}$/);
  assert.match(file.log[file.log.length - 1]!.note, /cli/);
});

test("损坏的质量报告不能清零停滞：坏文件不参与证据核验", () => {
  const root = proj();
  setGoal(root, { objective: "完成", acceptance: "测试全绿" });
  beginRound(root, "bad-r1");
  endRound(root, { runId: "bad-r1", producedEvidence: false, tokensUnknown: true });
  assert.equal(loadOrchestrator(root).run.stall_rounds, 1);

  const dir = path.join(root, ".pm", "quality-runs");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "quality-99999999-0000-0000.json"), "{invalid json", "utf8");
  beginRound(root, "bad-r2");
  const after = endRound(root, { runId: "bad-r2", producedEvidence: true, tokensUnknown: true });
  assert.equal(after.run.stall_rounds, 2, "坏报告不得被当作新证据");
  assert.equal(after.run.protocol.evidence_downgrades, 1);
  assert.match(after.log[after.log.length - 1]!.note, /声称有证据但源码与质量报告都没变/);
});

test("结构有效的新质量报告可以清零停滞", () => {
  const root = proj();
  setGoal(root, { objective: "完成", acceptance: "测试全绿" });
  beginRound(root, "good-r1");
  endRound(root, { runId: "good-r1", producedEvidence: false, tokensUnknown: true });
  beginRound(root, "good-r2");
  qualityEvidenceFixture(root);
  const after = endRound(root, { runId: "good-r2", producedEvidence: true, tokensUnknown: true });
  assert.equal(after.run.stall_rounds, 0);
  assert.match(after.log[after.log.length - 1]!.note, /有新证据/);
});

test("complete_goal 进入终止态：不能再开轮，换目标后恢复", () => {
  const root = proj();
  setGoal(root, { objective: "完成", acceptance: "测试全绿" });
  setSettings(root, { enabled: true, reason: "开工" });
  const completed = completeGoal(root, "验收命令已通过");
  assert.equal(orchestratorStatus(completed).status, "completed");
  assert.match(orchestratorStatus(completed).reason, /验收命令已通过/);
  assert.throws(() => beginRound(root, "after-done"), /已完成/);

  setSettings(root, { enabled: false, reason: "已完成" });
  assert.throws(() => setSettings(root, { enabled: true, reason: "试图重开" }), /目标已完成/);
  setGoal(root, { objective: "新目标", acceptance: "新验收" });
  assert.equal(loadOrchestrator(root).run.completed_at, null, "设定新目标应清除完成标记");
  assert.equal(beginRound(root, "new-run").run.active_run_id, "new-run");
});

test("三项预算都为 null 时拒绝开启自动编排", () => {
  const root = proj();
  setGoal(root, { objective: "完成", acceptance: "测试全绿" });
  setSettings(root, { max_rounds: null, max_hours: null, max_total_tokens: null });
  assert.throws(
    () => setSettings(root, { enabled: true, reason: "无预算开启" }),
    /至少需要一项有限预算/,
  );
});

test("end 声称有证据但源码与报告都没变：降级为无证据并计入停滞", () => {
  const root = proj();
  setGoal(root, { objective: "完成", acceptance: "测试全绿" });
  beginRound(root, { runId: "ev-2", kind: "manual" });
  const after = endRound(root, { runId: "ev-2", producedEvidence: true , tokensUnknown: true });
  assert.equal(after.run.stall_rounds, 1, "无实际产出却声称有证据，应记停滞");
  assert.match(after.log[after.log.length - 1]!.note, /声称有证据但源码与质量报告都没变/);
});

test("end 声称有证据且源码确实变化：正常清零停滞", () => {
  const root = proj();
  setGoal(root, { objective: "完成", acceptance: "测试全绿" });
  beginRound(root, { runId: "ev-3", kind: "cli" });
  fs.writeFileSync(path.join(root, "changed.ts"), "export const changed = 1;\n", "utf8");
  const after = endRound(root, { runId: "ev-3", producedEvidence: true , tokensUnknown: true });
  assert.equal(after.run.stall_rounds, 0);
  assert.match(after.log[after.log.length - 1]!.note, /有新证据/);
});

test("end 显式传 produced_evidence:false 时不误报降级", () => {
  const root = proj();
  setGoal(root, { objective: "完成", acceptance: "测试全绿" });
  beginRound(root, { runId: "ev-4", kind: "manual" });
  const after = endRound(root, { runId: "ev-4", producedEvidence: false , tokensUnknown: true });
  assert.equal(after.run.stall_rounds, 1);
  assert.match(after.log[after.log.length - 1]!.note, /无新证据/);
  assert.ok(!/声称有证据/.test(after.log[after.log.length - 1]!.note));
});

test("失败轮不受证据核验影响，走连续失败计数", () => {
  const root = proj();
  setGoal(root, { objective: "完成", acceptance: "测试全绿" });
  beginRound(root, { runId: "ev-5", kind: "workflow" });
  const after = endRound(root, { runId: "ev-5", producedEvidence: true, failure: "额度耗尽" , tokensUnknown: true });
  assert.equal(after.run.consecutive_failures, 1);
  assert.equal(after.run.stall_rounds, 0);
});

test("end 清零运行指针与基线：不留过期状态", () => {
  const root = proj();
  setGoal(root, { objective: "完成", acceptance: "测试全绿" });
  beginRound(root, { runId: "ev-6", kind: "cli" });
  const after = endRound(root, { runId: "ev-6", producedEvidence: false , tokensUnknown: true });
  assert.equal(after.run.active_run_id, null);
  assert.equal(after.run.active_run_kind, null);
  assert.equal(after.run.round_baseline, null);
});

/* ---------------------------- token 记账与上限 ---------------------------- */

test("token 逐轮累加，达到上限判 budget-exhausted", () => {
  const root = proj();
  setGoal(root, { objective: "完成", acceptance: "测试全绿" });
  setSettings(root, { enabled: true, reason: "开工" });
  setSettings(root, { max_total_tokens: 1_000_000 });
  beginRound(root, { runId: "tk-1", kind: "cli" });
  endRound(root, { runId: "tk-1", producedEvidence: false, tokensUsed: 600_000 });
  assert.equal(loadOrchestrator(root).run.tokens_used, 600_000);
  assert.equal(orchestratorStatus(loadOrchestrator(root)).status, "ready");
  beginRound(root, { runId: "tk-2", kind: "cli" });
  const over = endRound(root, { runId: "tk-2", producedEvidence: false, tokensUsed: 500_000 });
  assert.equal(over.run.tokens_used, 1_100_000);
  assert.equal(orchestratorStatus(over).status, "budget-exhausted");
  assert.match(orchestratorStatus(over).reason, /token/);
});

test("token 上限缺省为不限，负数与小数被拒", () => {
  const root = proj();
  assert.equal(loadOrchestrator(root).settings.max_total_tokens, null);
  assert.throws(() => setSettings(root, { max_total_tokens: 0 }), /max_total_tokens/);
  assert.throws(() => setSettings(root, { max_total_tokens: 1.5 }), /max_total_tokens/);
  assert.equal(validateMaxTokens(null), null);
});

test("未上报 token 时不改变累计值（不伪造消耗）", () => {
  const root = proj();
  setGoal(root, { objective: "完成", acceptance: "测试全绿" });
  beginRound(root, { runId: "tk-3", kind: "manual" });
  const after = endRound(root, { runId: "tk-3", producedEvidence: false , tokensUnknown: true });
  assert.equal(after.run.tokens_used, 0);
});

/* ------------------------- 成本上报硬约束（协议） ------------------------- */

test("end 既不给 tokens_used 也不声明 tokens_unknown 时直接拒绝", () => {
  const root = proj();
  setGoal(root, { objective: "完成", acceptance: "测试全绿" });
  beginRound(root, { runId: "p-1", kind: "cli" });
  assert.throws(
    () => endRound(root, { runId: "p-1", producedEvidence: false }),
    /必须上报本轮成本/,
  );
  // 拒绝后轮次仍在飞，调用方补上字段即可正常收轮
  assert.equal(loadOrchestrator(root).run.active_run_id, "p-1");
  const ok = endRound(root, { runId: "p-1", producedEvidence: false, tokensUnknown: true });
  assert.equal(ok.run.active_run_id, null);
});

test("声明 tokens_unknown 会被单独计数，不计入 token 累计", () => {
  const root = proj();
  setGoal(root, { objective: "完成", acceptance: "测试全绿" });
  beginRound(root, { runId: "p-2", kind: "manual" });
  const after = endRound(root, { runId: "p-2", producedEvidence: false, tokensUnknown: true });
  assert.equal(after.run.tokens_used, 0);
  assert.equal(after.run.protocol.tokens_unknown_rounds, 1);
});

test("证据降级会被累计计数，供状态查询暴露", () => {
  const root = proj();
  setGoal(root, { objective: "完成", acceptance: "测试全绿" });
  beginRound(root, { runId: "p-3", kind: "cli" });
  const after = endRound(root, { runId: "p-3", producedEvidence: true, tokensUsed: 100 });
  assert.equal(after.run.protocol.evidence_downgrades, 1);
  assert.equal(after.run.stall_rounds, 1);
});
