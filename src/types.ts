import { z } from "zod";
import { normSep } from "./budget.ts";

export const now = (): string => new Date().toISOString();

/** 文件清单字段：统一 / 分隔（Windows 反斜杠入库即规范化），缺省空数组 */
const filesField = () =>
  z.array(z.string()).default([]).transform((list) => list.map(normSep));

/* ---------------------------------- 项目 ---------------------------------- */

export const BudgetsSchema = z.object({
  /** 单文件行数预算（超出进复杂度账） */
  maxFileLoc: z.number().int().min(10).default(500),
  /** 里程碑重构类任务（refactor+debt）最低占比 %，低于则告警"重构被挤出" */
  refactorQuotaPct: z.number().min(0).max(100).default(20),
  /** 单次会话波及文件数阈值（超出告警"波及面过大"） */
  sessionBlastRadius: z.number().int().min(1).default(15),
  /** 读类工具输出行数硬预算（超出自动折叠） */
  outputBudgetLines: z.number().int().min(20).default(150),
});
export type Budgets = z.infer<typeof BudgetsSchema>;

export const ExposureSchema = z.enum(["local", "network", "public"]);

export const ProjectSchema = z.object({
  name: z.string().trim().min(1),
  description: z.string().default(""),
  stack: z.array(z.string()).default([]),
  goals: z.array(z.string()).default([]),
  /** 当前阶段，自由文本，如 "MVP 开发中" */
  phase: z.string().default(""),
  /** 登记的模块名（用于复杂度账的"未登记目录"检测） */
  modules: z.array(z.string()).default([]),
  /** 暴露面：local=本机工具 / network=内网服务 / public=公网服务，影响安全告警力度 */
  exposure: ExposureSchema.default("local"),
  /** 项目许可证（SPDX 或名称），用于依赖兼容性对账 */
  license: z.string().default(""),
  budgets: BudgetsSchema.default(BudgetsSchema.parse({})),
  created: z.string(),
  updated: z.string(),
});
export type Project = z.infer<typeof ProjectSchema>;
export type ProjectInput = z.input<typeof ProjectSchema>;

/* --------------------------------- 里程碑 --------------------------------- */

export const MilestoneStatusSchema = z.enum(["planned", "active", "done", "paused"]);
export type MilestoneStatus = z.infer<typeof MilestoneStatusSchema>;

export const MilestoneSchema = z.object({
  id: z.string(),
  title: z.string().trim().min(1),
  goal: z.string().default(""),
  status: MilestoneStatusSchema.default("planned"),
  order: z.number().int().default(0),
  created: z.string(),
  updated: z.string(),
});
export type Milestone = z.infer<typeof MilestoneSchema>;

export const RoadmapFileSchema = z.object({
  seq: z.number().int().default(0),
  milestones: z.array(MilestoneSchema).default([]),
});
export type RoadmapFile = z.infer<typeof RoadmapFileSchema>;

/* ---------------------------------- 任务 ---------------------------------- */

export const TaskTypeSchema = z.enum(["feature", "refactor", "fix", "chore", "debt"]);
export type TaskType = z.infer<typeof TaskTypeSchema>;

export const TaskStatusSchema = z.enum([
  "backlog",
  "todo",
  "in_progress",
  "blocked",
  "done",
  "cancelled",
]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const StepSchema = z.object({
  text: z.string(),
  done: z.boolean().default(false),
});
export type Step = z.infer<typeof StepSchema>;

export const CheckpointSchema = z.object({
  note: z.string(),
  next_step: z.string(),
  at: z.string(),
});
export type Checkpoint = z.infer<typeof CheckpointSchema>;

export const TaskSchema = z.object({
  id: z.string(),
  title: z.string().trim().min(1),
  detail: z.string().default(""),
  type: TaskTypeSchema.default("feature"),
  status: TaskStatusSchema.default("backlog"),
  priority: z.enum(["P0", "P1", "P2", "P3"]).nullable().default(null),
  milestone: z.string().nullable().default(null),
  /** 长任务显式步骤清单——断点续做的载体 */
  steps: z.array(StepSchema).default([]),
  checkpoint: CheckpointSchema.nullable().default(null),
  files: filesField(),
  acceptance: z.string().default(""),
  result_note: z.string().default(""),
  /** done 时"怎么证明"：用什么命令/测试验证 */
  verification: z.string().default(""),
  tags: z.array(z.string()).default([]),
  author: z.string().default(""),
  created: z.string(),
  updated: z.string(),
  started_at: z.string().nullable().default(null),
  completed_at: z.string().nullable().default(null),
});
export type Task = z.infer<typeof TaskSchema>;

export const TasksFileSchema = z.object({
  seq: z.number().int().default(0),
  tasks: z.array(TaskSchema).default([]),
});
export type TasksFile = z.infer<typeof TasksFileSchema>;

/* ---------------------------------- 功能 ---------------------------------- */

export const FeatureStatusSchema = z.enum(["planned", "implemented", "deprecated"]);

export const FeatureSchema = z.object({
  id: z.string(),
  name: z.string().trim().min(1),
  description: z.string().default(""),
  module: z.string().default(""),
  entry_files: filesField(),
  test_files: filesField(),
  status: FeatureStatusSchema.default("implemented"),
  created: z.string(),
  updated: z.string(),
});
export type Feature = z.infer<typeof FeatureSchema>;

export const FeaturesFileSchema = z.object({
  seq: z.number().int().default(0),
  features: z.array(FeatureSchema).default([]),
});
export type FeaturesFile = z.infer<typeof FeaturesFileSchema>;

/* ---------------------------------- 会话 ---------------------------------- */

export const SessionSchema = z.object({
  id: z.string(),
  date: z.string(),
  /** 谁做的：zcode / codex / human:张三 …… */
  author: z.string().default(""),
  summary: z.string().trim().min(1),
  files: filesField(),
  next_steps: z.array(z.string()).default([]),
});
export type Session = z.infer<typeof SessionSchema>;

export const SessionsFileSchema = z.object({
  seq: z.number().int().default(0),
  sessions: z.array(SessionSchema).default([]),
});
export type SessionsFile = z.infer<typeof SessionsFileSchema>;

/* --------------------------------- 调试记录 --------------------------------- */

export const DebugEntrySchema = z.object({
  id: z.string(),
  date: z.string(),
  author: z.string().default(""),
  symptom: z.string(),
  root_cause: z.string(),
  fix: z.string(),
  verified_how: z.string().default(""),
  files: filesField(),
  task_id: z.string().nullable().default(null),
});
export type DebugEntry = z.infer<typeof DebugEntrySchema>;

export const DebugLogFileSchema = z.object({
  seq: z.number().int().default(0),
  entries: z.array(DebugEntrySchema).default([]),
});
export type DebugLogFile = z.infer<typeof DebugLogFileSchema>;

/* -------------------------------- 文件用途索引 ------------------------------- */

export const FileNoteSchema = z.object({
  purpose: z.string(),
  /** 代码来源（如 Stack Overflow 链接、某仓库），provenance 用 */
  source: z.string().default(""),
  /** 该文件引用代码的许可证 */
  license: z.string().default(""),
  updated: z.string(),
});
export type FileNote = z.infer<typeof FileNoteSchema>;

export const FileNotesFileSchema = z.object({
  notes: z.record(z.string(), FileNoteSchema).default({}),
});
export type FileNotesFile = z.infer<typeof FileNotesFileSchema>;

/* --------------------------------- 安全体检 --------------------------------- */

export const SeveritySchema = z.enum(["high", "medium", "low"]);
export type Severity = z.infer<typeof SeveritySchema>;

export const FindingSchema = z.object({
  id: z.string(),
  rule: z.string(),
  severity: SeveritySchema,
  file: z.string(),
  line: z.number().int(),
  /** sha1(rule + 相对路径 + 命中内容)，行号漂移不误报；绝不存命中明文 */
  fingerprint: z.string(),
  status: z.enum(["open", "fixed", "accepted"]).default("open"),
  note: z.string().default(""),
  first_seen: z.string(),
  last_seen: z.string(),
});
export type Finding = z.infer<typeof FindingSchema>;

export const SecurityFileSchema = z.object({
  findings: z.array(FindingSchema).default([]),
  last_scan: z.string().nullable().default(null),
});
export type SecurityFile = z.infer<typeof SecurityFileSchema>;

/* ---------------------------------- 快照 ---------------------------------- */

export const SnapshotSchema = z.object({
  taken_at: z.string(),
  file: z.string(),
  total_files: z.number().int(),
  total_loc: z.number().int(),
  test_files: z.number().int(),
  skip_markers: z.number().int(),
  /** 依赖清单（扫描时的直接依赖，供 audit 对比新增） */
  deps: z.array(z.string()).default([]),
  by_ext: z.array(z.object({ ext: z.string(), files: z.number().int(), loc: z.number().int() })).default([]),
  top_dirs: z.array(z.object({ dir: z.string(), files: z.number().int(), loc: z.number().int() })).default([]),
  largest_files: z.array(z.object({ path: z.string(), loc: z.number().int() })).default([]),
  index_coverage_pct: z.number().default(0),
});
export type Snapshot = z.infer<typeof SnapshotSchema>;

/* --------------------------------- 全局注册表 -------------------------------- */

export const RegistryEntrySchema = z.object({
  name: z.string(),
  root: z.string(),
  last_seen: z.string(),
});
export type RegistryEntry = z.infer<typeof RegistryEntrySchema>;

export const RegistrySchema = z.object({
  projects: z.array(RegistryEntrySchema).default([]),
});
export type RegistryFile = z.infer<typeof RegistrySchema>;

/* --------------------------- 用户自定义安全规则 ------------------------------ */

export const CustomRuleSchema = z.object({
  id: z.string(),
  severity: SeveritySchema.default("medium"),
  pattern: z.string(),
  message: z.string().default(""),
  glob: z.string().optional(),
});
export type CustomRule = z.infer<typeof CustomRuleSchema>;

export const ExtraRulesFileSchema = z.object({
  rules: z.array(CustomRuleSchema).default([]),
});
export type ExtraRulesFile = z.infer<typeof ExtraRulesFileSchema>;
