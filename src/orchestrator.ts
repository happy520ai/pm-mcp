import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { pmPath } from "./paths.ts";
import { fingerprintProject } from "./project-fingerprint.ts";
import { latestValidQualityReport } from "./quality-report.ts";
import {
  FAIL_EXIT_THRESHOLD,
  STALL_THRESHOLD,
  mutateOrchestrator,
  nowIso,
  readOrchestrator,
  validateConcurrency,
  validateMaxHours,
  validateMaxRounds,
  validateMaxTokens,
  type Goal,
  type OrchestratorFile,
  type RunKind,
} from "./orchestrator-state.ts";

export * from "./orchestrator-state.ts";

const LOG_LIMIT = 20;
const SETTLED_RUN_LIMIT = 200;

/** 日志有界，避免台账无限膨胀 */
function appendLog(file: OrchestratorFile, kind: string, note: string): void {
  file.log.push({ at: nowIso(), kind, note });
  if (file.log.length > LOG_LIMIT) file.log = file.log.slice(-LOG_LIMIT);
}

/* ------------------------------ 状态推导 ------------------------------ */

/** 预算渲染：null 统一显示「不限」，避免各调用点各写一套 */
export function budgetLabel(file: OrchestratorFile): string {
  const rounds = file.settings.max_rounds === null ? `${file.run.round_count}/不限` : `${file.run.round_count}/${file.settings.max_rounds}`;
  const hours = file.settings.max_hours === null ? "不限" : `${file.settings.max_hours}h`;
  const tokens = file.settings.max_total_tokens === null
    ? ""
    : `（token ${file.run.tokens_used}/${file.settings.max_total_tokens}）`;
  return `${rounds} 轮（上限 ${hours}）${tokens}`;
}

export type OrchestratorStatus =
  | "no-goal" | "disabled" | "running" | "completed" | "budget-exhausted" | "stalled" | "failed-out" | "ready";

/** 单一事实判断：外部定时任务读它决定要不要开一轮 */
export function orchestratorStatus(file: OrchestratorFile): { status: OrchestratorStatus; reason: string } {
  // 在飞的一轮优先级最高：调用方需要立刻看到「别开新轮」，而不是被「已关闭」误导
  if (file.run.active_run_id) return { status: "running", reason: `一轮正在执行：${file.run.active_run_id}` };
  // 已验收完成是终止态：即使开关仍开着，也不得再开新轮
  if (file.run.completed_at) {
    return {
      status: "completed",
      reason: `目标已完成并验收（${file.run.completed_at}）${file.run.completed_note ? `：${file.run.completed_note}` : ""}`,
    };
  }
  if (!file.goal) return { status: "no-goal", reason: "尚未设置最终目标（set_goal）" };
  if (!file.settings.enabled) {
    return { status: "disabled", reason: file.run.paused_reason ? `已暂停：${file.run.paused_reason}` : "自动编排已关闭（set_orchestrator）" };
  }
  if (file.run.consecutive_failures >= FAIL_EXIT_THRESHOLD) {
    return { status: "failed-out", reason: `连续 ${file.run.consecutive_failures} 轮失败（额度/鉴权），已退出循环，需人工确认后重新开启` };
  }
  if (file.run.stall_rounds >= STALL_THRESHOLD) {
    return { status: "stalled", reason: `连续 ${file.run.stall_rounds} 轮没有新证据，已判定停滞并停止` };
  }
  if (file.settings.max_rounds !== null && file.run.round_count >= file.settings.max_rounds) {
    return { status: "budget-exhausted", reason: `已用完 ${file.run.round_count}/${file.settings.max_rounds} 轮预算` };
  }
  if (file.settings.max_total_tokens !== null && file.run.tokens_used >= file.settings.max_total_tokens) {
    return { status: "budget-exhausted", reason: `已用完 token 预算（${file.run.tokens_used}/${file.settings.max_total_tokens}）` };
  }
  return { status: "ready", reason: `可执行下一轮（${budgetLabel(file)}）` };
}

/* ------------------------------ 证据核验 ------------------------------ */

/** 最新“结构有效”的质量报告；坏 JSON/空文件不参与证据判定。 */
export function latestQualityReport(root: string): string | null {
  return latestValidQualityReport(root)?.path ?? null;
}

/** 目标指纹只取 objective+acceptance：只改 note 不应作废在飞轮次。 */
function goalFingerprint(goal: Goal | null): string | null {
  if (!goal) return null;
  return createHash("sha256").update(`${goal.objective}\0${goal.acceptance}`).digest("hex");
}

function settledMarker(root: string, runId: string): string {
  const hash = createHash("sha256").update(runId).digest("hex");
  return pmPath(path.resolve(root), ".runtime", "settled-runs", `${hash}.json`);
}

function runAlreadySettled(root: string, runId: string): boolean {
  return fs.existsSync(settledMarker(root, runId));
}

/** 永久结算标记与台账有界列表互为补充：台账限制 200 条，标记文件保证更久之后也不能复用同一 run_id。 */
function markRunSettled(root: string, runId: string): void {
  const file = settledMarker(root, runId);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ run_id: runId, at: nowIso() }, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
  } catch {
    // 标记写失败不推翻已提交的台账；台账内的 settled_run_ids 仍会拦截近期重复结算
  }
}

export interface RoundEvidence {
  /** 源码树相对 begin 是否变化（指纹不同） */
  sourceChanged: boolean;
  /** begin 之后是否出现更新的质量报告 */
  newQualityReport: boolean;
}

/**
 * 核验「本轮产出了新证据」这一声称：源码指纹变化，或出现了更新的质量报告。
 * 两者都没有却声称有证据，就是空转冒充产出——这是自动编排最该拦的一种谎。
 */
export function roundEvidence(root: string, baseline: OrchestratorFile["run"]["round_baseline"]): RoundEvidence {
  const current = fingerprintProject(root).sha256;
  const report = latestQualityReport(root);
  return {
    sourceChanged: baseline ? current !== baseline.source_sha256 : true,
    newQualityReport: baseline ? report !== null && report !== baseline.quality_report : report !== null,
  };
}

/* ------------------------------ 变更操作 ------------------------------ */

export interface SetGoalInput {
  objective: string;
  acceptance: string;
  note?: string;
}

export function setGoal(root: string, goal: SetGoalInput): OrchestratorFile {
  const objective = goal.objective.trim();
  const acceptance = goal.acceptance.trim();
  if (!objective) throw new Error("objective 不能为空。");
  if (!acceptance) {
    throw new Error("acceptance 不能为空：没有机器可判的验收标准，「直到完成」就没有终点。");
  }
  return mutateOrchestrator(root, (file) => {
    const at = nowIso();
    const changed = file.goal === null || file.goal.objective !== objective || file.goal.acceptance !== acceptance;
    file.goal = {
      objective,
      acceptance,
      note: (goal.note ?? "").trim(),
      created: file.goal?.created ?? at,
      updated: at,
    };
    if (changed) {
      // 目标变了，旧轮次不能继续算到新目标头上；显式作废并留痕。
      if (file.run.active_run_id) {
        appendLog(file, "round-cancelled", `${file.run.active_run_id}: 目标变更，在飞轮次作废`);
        file.run.active_run_id = null;
        file.run.active_run_kind = null;
        file.run.round_baseline = null;
      }
      file.run.completed_at = null;
      file.run.completed_note = "";
    }
    appendLog(file, "goal", objective);
    return file;
  });
}

export interface SetSettingsInput {
  enabled?: boolean;
  reason?: string;
  max_concurrency?: number;
  max_rounds?: number | null;
  max_hours?: number | null;
  max_total_tokens?: number | null;
}

/** 每次开关都留理由与时间，否则第二天不知道为什么停的 */
export function setSettings(root: string, input: SetSettingsInput): OrchestratorFile {
  if (input.enabled !== undefined && input.reason === undefined) {
    throw new Error("开启/关闭编排时必须给 reason（开关理由），用于追溯。");
  }
  const at = nowIso();
  return mutateOrchestrator(root, (file) => {
    if (input.max_concurrency !== undefined) file.settings.max_concurrency = validateConcurrency(input.max_concurrency);
    if (input.max_rounds !== undefined) file.settings.max_rounds = validateMaxRounds(input.max_rounds);
    if (input.max_hours !== undefined) file.settings.max_hours = validateMaxHours(input.max_hours);
    if (input.max_total_tokens !== undefined) file.settings.max_total_tokens = validateMaxTokens(input.max_total_tokens);
    if (input.enabled !== undefined && input.enabled !== file.settings.enabled) {
      if (input.enabled) {
        if (file.run.completed_at) {
          throw new Error("目标已完成并验收，不能再开启自动编排；如需继续，请先 set_goal 设定新目标。");
        }
        if (file.settings.max_rounds === null && file.settings.max_hours === null && file.settings.max_total_tokens === null) {
          throw new Error("开启自动编排时至少需要一项有限预算（max_rounds / max_hours / max_total_tokens），否则没有成本防线。");
        }
      }
      file.settings.enabled = input.enabled;
      if (input.enabled) {
        file.run.started_at = file.run.started_at ?? at;
        file.run.paused_reason = null;
        file.run.paused_at = null;
        file.run.consecutive_failures = 0;
        file.run.stall_rounds = 0;
        appendLog(file, "enable", input.reason as string);
      } else {
        file.run.paused_reason = input.reason ?? null;
        file.run.paused_at = at;
        appendLog(file, "disable", input.reason as string);
      }
    }
    return file;
  });
}

export interface BeginRoundInput {
  runId: string;
  /** 承载本轮的执行器；缺省 manual。workflow/cli 应传真实运行 id 以便自愈 */
  kind?: RunKind;
}

/** 一轮开始：记录 active_run_id、执行器类型与证据基线（供 end 核验产出是否属实） */
export function beginRound(root: string, input: BeginRoundInput | string): OrchestratorFile {
  const runId = (typeof input === "string" ? input : input.runId).trim();
  const kind: RunKind = typeof input === "string" ? "manual" : (input.kind ?? "manual");
  const baselineSource = {
    source_sha256: fingerprintProject(root).sha256,
    quality_report: latestQualityReport(root),
  };
  return mutateOrchestrator(root, (file) => {
    if (!file.goal) throw new Error("尚未设置最终目标，不能开轮（请先 set_goal）。");
    if (file.run.completed_at) throw new Error("目标已完成并验收，不能再开新轮；如需继续，请先 set_goal 设定新目标。");
    if (file.run.active_run_id) {
      throw new Error(`已有一轮在执行（${file.run.active_run_id}），同一时间只允许一轮。`);
    }
    if (runAlreadySettled(root, runId) || file.run.settled_run_ids.includes(runId)) {
      throw new Error(`run_id 已结算过（${runId}），不能重复使用；每轮必须使用新的 run_id。`);
    }
    file.run.active_run_id = runId;
    file.run.active_run_kind = kind;
    file.run.round_baseline = { ...baselineSource, goal_hash: goalFingerprint(file.goal), at: nowIso() };
    file.run.last_round_at = nowIso();
    appendLog(file, "round-start", `${runId}（${kind}）`);
    return file;
  });
}

export interface EndRoundInput {
  runId: string;
  /** 这一轮是否产出了新的可核验证据（测试报告/提交的源码变更） */
  producedEvidence: boolean;
  failure?: string;
  /** 本轮实际消耗 token（由执行器上报）；累计进 run.tokens_used */
  tokensUsed?: number;
  /** 确实无法测量时的显式声明；与 tokensUsed 二选一，省略两者会被拒绝 */
  tokensUnknown?: boolean;
}

/** 一轮结束：清零 active_run_id、推进轮数、判定停滞与连续失败退出 */
export function endRound(root: string, input: EndRoundInput): OrchestratorFile {
  // 协议硬约束：成本必须被明确交代。静默省略会让 token 预算变成一句空话，
  // 所以宁可直接报错要求调用方补上，也不接受「装作没这回事」。
  if (input.tokensUsed === undefined && !input.tokensUnknown) {
    throw new Error("record_round(end) 必须上报本轮成本：传 tokens_used（实际消耗）或 tokens_unknown:true（确实无法测量）。两者都不传会让 token 预算失效，已被拒绝。");
  }
  const runId = input.runId.trim();
  if (runAlreadySettled(root, runId)) {
    throw new Error(`run_id 已结算过（${runId}），拒绝重复结算。`);
  }
  const snapshot = readOrchestrator(root).value;
  if (snapshot.run.active_run_id !== runId) {
    throw new Error(snapshot.run.active_run_id
      ? `本轮已不属于当前执行的轮次（${snapshot.run.active_run_id}），拒绝记账。`
      : `没有在飞的轮次（${runId}），拒绝记账。每轮必须先 record_round(begin)。`);
  }
  if (snapshot.run.round_baseline?.goal_hash && goalFingerprint(snapshot.goal) !== snapshot.run.round_baseline.goal_hash) {
    throw new Error("目标在开轮后已变更，旧轮次的产出不能结算到新目标账上；请用新 run_id 重新开轮。");
  }
  const evidence = roundEvidence(root, snapshot.run.round_baseline);
  const claimsEvidence = input.producedEvidence && !input.failure;
  // 声称有产出、但源码没变也没有新质量报告：按无证据处理，不让空转冒充成果
  const effectiveEvidence = claimsEvidence ? evidence.sourceChanged || evidence.newQualityReport : input.producedEvidence;
  const downgraded = claimsEvidence && !effectiveEvidence;
  const result = mutateOrchestrator(root, (file) => {
    if (file.run.active_run_id !== runId) {
      throw new Error(file.run.active_run_id
        ? `本轮已不属于当前执行的轮次（${file.run.active_run_id}），拒绝记账。`
        : `没有在飞的轮次（${runId}），拒绝记账。每轮必须先 record_round(begin)。`);
    }
    if (file.run.settled_run_ids.includes(runId) || runAlreadySettled(root, runId)) {
      throw new Error(`run_id 已结算过（${runId}），拒绝重复结算。`);
    }
    if (file.run.round_baseline?.goal_hash && goalFingerprint(file.goal) !== file.run.round_baseline.goal_hash) {
      throw new Error("目标在开轮后已变更，旧轮次的产出不能结算到新目标账上；请用新 run_id 重新开轮。");
    }
    const run = file.run;
    const at = nowIso();
    run.active_run_id = null;
    run.active_run_kind = null;
    run.round_baseline = null;
    run.round_count += 1;
    run.settled_run_ids = [...run.settled_run_ids, runId].slice(-SETTLED_RUN_LIMIT);
    run.last_round_at = at;
    if (input.tokensUsed !== undefined && Number.isFinite(input.tokensUsed) && input.tokensUsed > 0) {
      run.tokens_used += Math.floor(input.tokensUsed);
    } else if (input.tokensUnknown) {
      run.protocol.tokens_unknown_rounds += 1;
    }

    if (downgraded) run.protocol.evidence_downgrades += 1;
    if (input.failure) {
      run.consecutive_failures += 1;
      run.stall_rounds = 0;
      const note = `${runId}: 失败 ${input.failure.trim().slice(0, 160)}`;
      appendLog(file, run.consecutive_failures >= FAIL_EXIT_THRESHOLD ? "fail-exit" : "round-fail", note);
    } else {
      run.consecutive_failures = 0;
      run.stall_rounds = effectiveEvidence ? 0 : run.stall_rounds + 1;
      const detail = effectiveEvidence
        ? "有新证据"
        : downgraded
          ? `声称有证据但源码与质量报告都没变，按无证据计（停滞 ${run.stall_rounds}/${STALL_THRESHOLD}）`
          : `无新证据（停滞 ${run.stall_rounds}/${STALL_THRESHOLD}）`;
      appendLog(file, run.stall_rounds >= STALL_THRESHOLD ? "stalled" : "round-end", `${runId}: ${detail}`);
    }
    return file;
  });
  markRunSettled(root, runId);
  return result;
}

/** 目标完成：显式终止信号。调用方必须先按 acceptance 完成核验；此处只记账、不代替验收。 */
export function completeGoal(root: string, note = ""): OrchestratorFile {
  return mutateOrchestrator(root, (file) => {
    if (!file.goal) throw new Error("尚未设置最终目标，不能标记完成。");
    if (file.run.completed_at) throw new Error(`目标已完成（${file.run.completed_at}），请勿重复标记。`);
    if (file.run.active_run_id) {
      throw new Error(`还有一轮在执行（${file.run.active_run_id}），请先 record_round(end) 收轮，再标记目标完成。`);
    }
    file.run.completed_at = nowIso();
    file.run.completed_note = note.trim();
    appendLog(file, "goal-completed", note.trim() || file.goal.objective);
    return file;
  });
}

/** 新一轮开始前判断是否该退出循环（停滞或连续失败） */
export function shouldExitLoop(file: OrchestratorFile): boolean {
  return file.run.consecutive_failures >= FAIL_EXIT_THRESHOLD || file.run.stall_rounds >= STALL_THRESHOLD;
}
