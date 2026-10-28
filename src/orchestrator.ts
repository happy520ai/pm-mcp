import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { pmPath } from "./paths.ts";
import { fingerprintProject } from "./project-fingerprint.ts";
import { saveJson, withLedgerLock } from "./store.ts";

export const ORCHESTRATOR_SCHEMA_VERSION = 1 as const;
export const ORCHESTRATOR_FILE = "orchestrator.json";

/** 并发上限：超过这个数只会撞速率限制与磁盘锁竞争，不会线性变快 */
export const MIN_CONCURRENCY = 1;
export const MAX_CONCURRENCY = 8;
/** 连续多少轮没有任何新证据就判定停滞（而不是继续空转烧额度） */
export const STALL_THRESHOLD = 3;
/** 连续多少轮额度/鉴权失败就退出循环（不做无限重试） */
export const FAIL_EXIT_THRESHOLD = 2;
export const DEFAULT_MAX_ROUNDS = 40;
export const DEFAULT_MAX_HOURS = 24;
const LOG_LIMIT = 20;
const MAX_ROUNDS_MAX = 500;
const MAX_HOURS_MAX = 168;

const Text = z.string().trim().min(1);
const nowIso = () => new Date().toISOString();

/** 最终目标锚点：acceptance 必填，否则「直到完成」没有机器可判的终点 */
export const GoalSchema = z.object({
  objective: Text,
  acceptance: Text,
  note: z.string().default(""),
  created: z.string(),
  updated: z.string(),
});

export const SettingsSchema = z.object({
  enabled: z.boolean().default(false),
  max_concurrency: z.number().int().min(MIN_CONCURRENCY).max(MAX_CONCURRENCY).default(3),
  /** null = 不限（此时只靠停滞与连续失败两个进度型刹车） */
  max_rounds: z.number().int().min(1).max(MAX_ROUNDS_MAX).nullable().default(DEFAULT_MAX_ROUNDS),
  max_hours: z.number().min(0.1).max(MAX_HOURS_MAX).nullable().default(DEFAULT_MAX_HOURS),
  /** 累计 token 上限（null=不限）。一次纯文档轮曾烧掉 543 万 token，没有上限就没有成本防线 */
  max_total_tokens: z.number().int().min(1).nullable().default(null),
});

/** 运行指针：区分是哪一座桥在跑，并记录可据此自愈的运行 id */
export const RunKindSchema = z.enum(["workflow", "cli", "manual"]);

export const RunStateSchema = z.object({
  active_run_id: z.string().nullable().default(null),
  /** 在飞轮次由哪种执行器承载；缺省 manual（手工 tick） */
  active_run_kind: RunKindSchema.nullable().default(null),
  /** begin 时的源码指纹与质量报告基线，供 end 核验「有新证据」是否属实 */
  round_baseline: z.object({
    source_sha256: z.string(),
    quality_report: z.string().nullable(),
    at: z.string(),
  }).nullable().default(null),
  round_count: z.number().int().min(0).default(0),
  /** 累计消耗 token：由 end 逐轮累加（外部上报），用于 max_total_tokens 判定 */
  tokens_used: z.number().int().min(0).default(0),
  stall_rounds: z.number().int().min(0).default(0),
  consecutive_failures: z.number().int().min(0).default(0),
  last_round_at: z.string().nullable().default(null),
  started_at: z.string().nullable().default(null),
  paused_reason: z.string().nullable().default(null),
  paused_at: z.string().nullable().default(null),
});

export const LogEntrySchema = z.object({
  at: z.string(),
  kind: Text,
  note: Text,
});

export const OrchestratorSchema = z.object({
  schema_version: z.literal(ORCHESTRATOR_SCHEMA_VERSION),
  goal: GoalSchema.nullable().default(null),
  settings: SettingsSchema.default({}),
  run: RunStateSchema.default({}),
  log: z.array(LogEntrySchema).default([]),
  updated: z.string(),
});

export type Goal = z.infer<typeof GoalSchema>;
export type OrchestratorSettings = z.infer<typeof SettingsSchema>;
export type OrchestratorRun = z.infer<typeof RunStateSchema>;
export type RunKind = z.infer<typeof RunKindSchema>;
export type OrchestratorFile = z.infer<typeof OrchestratorSchema>;
export type OrchestratorInput = z.input<typeof OrchestratorSchema>;

export function orchestratorPath(root: string): string {
  return pmPath(path.resolve(root), ORCHESTRATOR_FILE);
}

/** 文件缺失时的默认值：禁用状态，任何调用都不会因为没初始化而报错 */
export function defaultOrchestrator(): OrchestratorFile {
  const at = nowIso();
  return {
    schema_version: ORCHESTRATOR_SCHEMA_VERSION,
    goal: null,
    settings: { enabled: false, max_concurrency: 3, max_rounds: DEFAULT_MAX_ROUNDS, max_hours: DEFAULT_MAX_HOURS, max_total_tokens: null },
    run: {
      active_run_id: null,
      active_run_kind: null,
      round_baseline: null,
      round_count: 0,
      tokens_used: 0,
      stall_rounds: 0,
      consecutive_failures: 0,
      last_round_at: null,
      started_at: null,
      paused_reason: null,
      paused_at: null,
    },
    log: [],
    updated: at,
  };
}

/** 文件缺失 / 存在 / 损坏：只有「损坏」会阻止写入，以免静默覆盖一份可疑台账 */
export type OrchestratorHealth = "ok" | "missing" | "invalid";

export interface OrchestratorRead {
  value: OrchestratorFile;
  health: OrchestratorHealth;
  issue?: string;
}

/** 缺失 → 默认禁用状态（fail-closed）；损坏 → 禁用状态 + 记录问题，不抛错、不覆盖原文件 */
export function readOrchestrator(root: string): OrchestratorRead {
  const file = orchestratorPath(root);
  if (!fs.existsSync(file)) return { value: defaultOrchestrator(), health: "missing" };
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    return { value: OrchestratorSchema.parse(raw), health: "ok" };
  } catch (error) {
    return {
      value: defaultOrchestrator(),
      health: "invalid",
      issue: `${file}: ${(error as Error).message}`,
    };
  }
}

export function loadOrchestrator(root: string): OrchestratorFile {
  return readOrchestrator(root).value;
}

export function saveOrchestrator(root: string, file: OrchestratorFile): OrchestratorFile {
  const parsed = OrchestratorSchema.parse(file);
  const target = orchestratorPath(root);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  saveJson(target, parsed);
  return parsed;
}

/** 读-改-写走账本锁；台账损坏时拒绝写入并明确报错。
 *  锁不可重入：本模块的变更函数必须经 toolI（异步包装器不自带账本锁）暴露，
 *  用 toolW 会在包装器已持锁的情况下二次取锁并超时。 */
export function mutateOrchestrator(root: string, fn: (value: OrchestratorFile) => OrchestratorFile): OrchestratorFile {
  return withLedgerLock(root, () => {
    const read = readOrchestrator(root);
    if (read.health === "invalid") {
      throw new Error(`编排台账已损坏，已停止写入（当前视为禁用）：${read.issue}。请备份或删除 ${orchestratorPath(root)} 后重试。`);
    }
    const next = fn(read.value);
    next.updated = nowIso();
    return saveOrchestrator(root, next);
  });
}

/* -------------------------------- 校验 -------------------------------- */

/** 只报错不截断：静默把 16 改成 8 会让调用方以为真的开了 16 */
export function validateConcurrency(value: number): number {
  if (!Number.isInteger(value) || value < MIN_CONCURRENCY || value > MAX_CONCURRENCY) {
    throw new RangeError(`max_concurrency 必须是 ${MIN_CONCURRENCY}-${MAX_CONCURRENCY} 之间的整数，收到: ${value}`);
  }
  return value;
}

export function validateMaxRounds(value: number | null): number | null {
  if (value === null) return null;
  if (!Number.isInteger(value) || value < 1 || value > MAX_ROUNDS_MAX) {
    throw new RangeError(`max_rounds 必须是 1-${MAX_ROUNDS_MAX} 之间的整数，收到: ${value}`);
  }
  return value;
}

export function validateMaxHours(value: number | null): number | null {
  if (value === null) return null;
  if (!Number.isFinite(value) || value <= 0 || value > MAX_HOURS_MAX) {
    throw new RangeError(`max_hours 必须是 0.1-${MAX_HOURS_MAX} 之间的数字，收到: ${value}`);
  }
  return value;
}

export function validateMaxTokens(value: number | null): number | null {
  if (value === null) return null;
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`max_total_tokens 必须是正整数或 null，收到: ${value}`);
  }
  return value;
}

/* ------------------------------- 记账 -------------------------------- */

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
  | "no-goal" | "disabled" | "running" | "budget-exhausted" | "stalled" | "failed-out" | "ready";

/** 单一事实判断：外部定时任务读它决定要不要开一轮 */
export function orchestratorStatus(file: OrchestratorFile): { status: OrchestratorStatus; reason: string } {
  // 在飞的一轮优先级最高：调用方需要立刻看到「别开新轮」，而不是被「已关闭」误导
  if (file.run.active_run_id) return { status: "running", reason: `一轮正在执行：${file.run.active_run_id}` };
  if (!file.goal) return { status: "no-goal", reason: "尚未设置最终目标（set_goal）" };
  if (!file.settings.enabled) {
    return { status: "disabled", reason: file.run.paused_reason ? `已暂停：${file.run.paused_reason}` : "编排已关闭" };
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

/** 最新质量报告文件名（按文件名时间戳排序），没有则 null。只读目录，不解析内容。 */
export function latestQualityReport(root: string): string | null {
  const directory = pmPath(root, "quality-runs");
  if (!fs.existsSync(directory)) return null;
  const names = fs.readdirSync(directory).filter((name) => /^quality-.*\.json$/.test(name)).sort();
  const newest = names[names.length - 1];
  return newest ? `.pm/quality-runs/${newest}` : null;
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
    file.goal = {
      objective,
      acceptance,
      note: (goal.note ?? "").trim(),
      created: file.goal?.created ?? at,
      updated: at,
    };
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
  const baseline = {
    source_sha256: fingerprintProject(root).sha256,
    quality_report: latestQualityReport(root),
    at: nowIso(),
  };
  return mutateOrchestrator(root, (file) => {
    if (!file.goal) throw new Error("尚未设置最终目标，不能开轮（请先 set_goal）。");
    if (file.run.active_run_id && file.run.active_run_id !== runId) {
      throw new Error(`已有一轮在执行（${file.run.active_run_id}），同一时间只允许一轮。`);
    }
    file.run.active_run_id = runId;
    file.run.active_run_kind = kind;
    file.run.round_baseline = baseline;
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
}

/** 一轮结束：清零 active_run_id、推进轮数、判定停滞与连续失败退出 */
export function endRound(root: string, input: EndRoundInput): OrchestratorFile {
  const evidence = roundEvidence(root, readOrchestrator(root).value.run.round_baseline);
  const claimsEvidence = input.producedEvidence && !input.failure;
  // 声称有产出、但源码没变也没有新质量报告：按无证据处理，不让空转冒充成果
  const effectiveEvidence = claimsEvidence ? evidence.sourceChanged || evidence.newQualityReport : input.producedEvidence;
  const downgraded = claimsEvidence && !effectiveEvidence;
  return mutateOrchestrator(root, (file) => {
    if (file.run.active_run_id && file.run.active_run_id !== input.runId.trim()) {
      throw new Error(`本轮已不属于当前执行的轮次（${file.run.active_run_id}），拒绝记账。`);
    }
    const run = file.run;
    const at = nowIso();
    run.active_run_id = null;
    run.active_run_kind = null;
    run.round_baseline = null;
    run.round_count += 1;
    run.last_round_at = at;
    if (input.tokensUsed !== undefined && Number.isFinite(input.tokensUsed) && input.tokensUsed > 0) {
      run.tokens_used += Math.floor(input.tokensUsed);
    }

    if (input.failure) {
      run.consecutive_failures += 1;
      run.stall_rounds = 0;
      const note = `${input.runId.trim()}: 失败 ${input.failure.trim().slice(0, 160)}`;
      appendLog(file, run.consecutive_failures >= FAIL_EXIT_THRESHOLD ? "fail-exit" : "round-fail", note);
    } else {
      run.consecutive_failures = 0;
      run.stall_rounds = effectiveEvidence ? 0 : run.stall_rounds + 1;
      const detail = effectiveEvidence
        ? "有新证据"
        : downgraded
          ? `声称有证据但源码与质量报告都没变，按无证据计（停滞 ${run.stall_rounds}/${STALL_THRESHOLD}）`
          : `无新证据（停滞 ${run.stall_rounds}/${STALL_THRESHOLD}）`;
      appendLog(file, run.stall_rounds >= STALL_THRESHOLD ? "stalled" : "round-end", `${input.runId.trim()}: ${detail}`);
    }
    return file;
  });
}

/** 新一轮开始前判断是否该退出循环（停滞或连续失败） */
export function shouldExitLoop(file: OrchestratorFile): boolean {
  return file.run.consecutive_failures >= FAIL_EXIT_THRESHOLD || file.run.stall_rounds >= STALL_THRESHOLD;
}

