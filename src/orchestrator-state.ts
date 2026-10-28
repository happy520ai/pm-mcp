import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { pmPath } from "./paths.ts";
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
const MAX_ROUNDS_MAX = 500;
const MAX_HOURS_MAX = 168;

const Text = z.string().trim().min(1);
export const nowIso = (): string => new Date().toISOString();

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
    /** 开轮时的目标指纹；目标变了，旧轮次的产出不能算到新目标账上 */
    goal_hash: z.string().nullable().default(null),
    at: z.string(),
  }).nullable().default(null),
  round_count: z.number().int().min(0).default(0),
  /** 已结算的 run_id（有界保留）；配合 .runtime/settled-runs 标记防止重复结算 */
  settled_run_ids: z.array(z.string()).default([]),
  /** 目标完成时间：非空即终止态，调度不得再开新轮 */
  completed_at: z.string().nullable().default(null),
  completed_note: z.string().default(""),
  /** 累计消耗 token：由 end 逐轮累加（外部上报），用于 max_total_tokens 判定 */
  tokens_used: z.number().int().min(0).default(0),
  /** 协议合规计数：让「没上报成本」「证据被降级」在状态里可见，而不是只埋在日志 */
  protocol: z.object({
    /** 显式声明无法测量 token 的轮次数 */
    tokens_unknown_rounds: z.number().int().min(0).default(0),
    /** 声称有证据但被核验降级的轮次数（空转冒充产出的累计证据） */
    evidence_downgrades: z.number().int().min(0).default(0),
  }).default({}),
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
      settled_run_ids: [],
      completed_at: null,
      completed_note: "",
      tokens_used: 0,
      protocol: { tokens_unknown_rounds: 0, evidence_downgrades: 0 },
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
