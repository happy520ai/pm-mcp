import fs from "node:fs";
import { isInitialized, pmPath } from "./paths.ts";

/**
 * 使用日志 + 运行日志（运行时数据，非账本）：
 * - usage-log.jsonl：每次 MCP 工具/资源调用一条（工具名、成败、耗时、输出与折叠省下的 token 估算）。
 *   只记计量不记参数内容，避免敏感信息与大参数进日志。
 * - runtime-log.jsonl：服务级事件（server 就绪、watcher 状态、工具报错、轮转）。
 * 均为追加式 JSONL，超限自动轮转（当前 + .1 共两份），绝不抛错——日志永远不能影响工具调用本身。
 */

export const USAGE_LOG = "usage-log.jsonl";
export const RUNTIME_LOG = "runtime-log.jsonl";

export type UsageKind = "read" | "write" | "write-async";
export type RuntimeLevel = "info" | "warn" | "error";

export interface UsageEntry {
  ts: string;
  tool: string;
  kind: UsageKind;
  ok: boolean;
  ms: number;
  out_chars?: number;
  est_tokens?: number;
  folded_chars?: number;
  folded_tokens?: number;
  replayed?: boolean;
  pending?: boolean;
  uncertain?: boolean;
  error?: string;
}

export interface RuntimeEntry {
  ts: string;
  level: RuntimeLevel;
  event: string;
  detail?: string;
}

export interface UsageSummary {
  calls: number;
  errors: number;
  errorRate: number;
  avgMs: number;
  maxMs: number;
  slowestTool: string;
  estTokensOut: number;
  estTokensSaved: number;
  savePct: number;
  replayed: number;
  pending: number;
  uncertain: number;
  folds: number;
  topTools: Array<{ tool: string; calls: number; errors: number; avgMs: number }>;
}

export interface UsageFilter {
  last?: number;
  tool?: string;
  ok?: boolean;
  since?: string;
}

export interface RuntimeFilter {
  last?: number;
  level?: RuntimeLevel;
  event?: string;
  since?: string;
}

const DEFAULT_MAX_BYTES = 1024 * 1024;
const ROTATE_CHECK_EVERY = 32;
const rotateCheckCounter = new Map<string, number>();

function maxLogBytes(): number {
  const override = Number(process.env.PM_TEST_LOG_MAX_BYTES);
  return Number.isFinite(override) && override > 0 ? override : DEFAULT_MAX_BYTES;
}

function rotatedFile(file: string): string {
  return file.replace(/\.jsonl$/, ".1.jsonl");
}

function appendLine(root: string, file: string, line: string): void {
  try {
    if (!isInitialized(root)) return;
    fs.appendFileSync(file, line + "\n", "utf8");
    // 每 N 次写查一次大小（测试覆盖了轮转，此时每次都查）
    const every = process.env.PM_TEST_LOG_MAX_BYTES ? 1 : ROTATE_CHECK_EVERY;
    const n = (rotateCheckCounter.get(file) ?? 0) + 1;
    rotateCheckCounter.set(file, n);
    if (n % every !== 0) return;
    if (fs.statSync(file).size <= maxLogBytes()) return;
    const rotated = rotatedFile(file);
    try {
      fs.rmSync(rotated, { force: true });
      fs.renameSync(file, rotated);
    } catch {
      // 多进程并发轮转竞争失败可接受：当前文件继续追加，下次再试
    }
  } catch {
    /* 日志绝不影响工具调用 */
  }
}

export function logUsage(root: string, entry: UsageEntry): void {
  appendLine(root, pmPath(root, USAGE_LOG), JSON.stringify(entry));
}

export function logRuntime(root: string, level: RuntimeLevel, event: string, detail?: string): void {
  const entry: RuntimeEntry = { ts: new Date().toISOString(), level, event, ...(detail ? { detail } : {}) };
  appendLine(root, pmPath(root, RUNTIME_LOG), JSON.stringify(entry));
}

/** 粗估 token 数：CJK 每字≈1 token，其余≈4字符/token（混合中英文经验值，够做趋势判断） */
export function estimateTokens(text: string): number {
  let cjk = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if (
      (c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3400 && c <= 0x4dbf) ||
      (c >= 0x3000 && c <= 0x303f) || (c >= 0xff00 && c <= 0xffef)
    ) cjk += 1;
  }
  return cjk + Math.ceil((text.length - cjk) / 4);
}

function readJsonl<T>(root: string, file: string, coerce: (raw: Record<string, unknown>) => T | null): T[] {
  const out: T[] = [];
  for (const target of [rotatedFile(file), file]) {
    let raw: string;
    try {
      raw = fs.readFileSync(target, "utf8");
    } catch {
      continue;
    }
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = coerce(JSON.parse(trimmed) as Record<string, unknown>);
        if (parsed !== null) out.push(parsed);
      } catch {
        /* 坏行跳过（轮转竞争/手工编辑残留） */
      }
    }
  }
  return out;
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function coerceUsage(raw: Record<string, unknown>): UsageEntry | null {
  const tool = asString(raw.tool);
  const ts = asString(raw.ts);
  if (!tool || !ts) return null;
  return {
    ts,
    tool,
    kind: raw.kind === "write" || raw.kind === "write-async" ? raw.kind : "read",
    ok: raw.ok === true,
    ms: typeof raw.ms === "number" && Number.isFinite(raw.ms) ? raw.ms : 0,
    ...(typeof raw.out_chars === "number" ? { out_chars: raw.out_chars } : {}),
    ...(typeof raw.est_tokens === "number" ? { est_tokens: raw.est_tokens } : {}),
    ...(typeof raw.folded_chars === "number" ? { folded_chars: raw.folded_chars } : {}),
    ...(typeof raw.folded_tokens === "number" ? { folded_tokens: raw.folded_tokens } : {}),
    ...(raw.replayed === true ? { replayed: true } : {}),
    ...(raw.pending === true ? { pending: true } : {}),
    ...(raw.uncertain === true ? { uncertain: true } : {}),
    ...(asString(raw.error) ? { error: asString(raw.error)! } : {}),
  };
}

function coerceRuntime(raw: Record<string, unknown>): RuntimeEntry | null {
  const ts = asString(raw.ts);
  const event = asString(raw.event);
  const level = raw.level === "info" || raw.level === "warn" || raw.level === "error" ? raw.level : null;
  if (!ts || !event || !level) return null;
  return { ts, level, event, ...(asString(raw.detail) ? { detail: asString(raw.detail) } : {}) };
}

/** 读全部保留的使用日志（轮转份 + 当前份，按时间序） */
export function loadUsageEntries(root: string): UsageEntry[] {
  return readJsonl(root, pmPath(root, USAGE_LOG), coerceUsage);
}

export function loadRuntimeEntries(root: string): RuntimeEntry[] {
  return readJsonl(root, pmPath(root, RUNTIME_LOG), coerceRuntime);
}

export function usageSummary(entries: UsageEntry[]): UsageSummary {
  const calls = entries.length;
  const errors = entries.filter((e) => !e.ok).length;
  const totalMs = entries.reduce((sum, e) => sum + e.ms, 0);
  const slowest = entries.reduce<UsageEntry | null>((best, e) => (best === null || e.ms > best.ms ? e : best), null);
  const estTokensOut = entries.reduce((sum, e) => sum + (e.est_tokens ?? 0), 0);
  const estTokensSaved = entries.reduce((sum, e) => sum + (e.folded_tokens ?? 0), 0);
  const byTool = new Map<string, { calls: number; errors: number; ms: number }>();
  for (const e of entries) {
    const bucket = byTool.get(e.tool) ?? { calls: 0, errors: 0, ms: 0 };
    bucket.calls += 1;
    if (!e.ok) bucket.errors += 1;
    bucket.ms += e.ms;
    byTool.set(e.tool, bucket);
  }
  const topTools = [...byTool.entries()]
    .map(([tool, b]) => ({ tool, calls: b.calls, errors: b.errors, avgMs: Math.round(b.ms / Math.max(1, b.calls)) }))
    .sort((a, b) => b.calls - a.calls || a.tool.localeCompare(b.tool))
    .slice(0, 8);
  return {
    calls,
    errors,
    errorRate: calls === 0 ? 0 : errors / calls,
    avgMs: calls === 0 ? 0 : Math.round(totalMs / calls),
    maxMs: slowest?.ms ?? 0,
    slowestTool: slowest?.tool ?? "",
    estTokensOut,
    estTokensSaved,
    savePct: estTokensOut + estTokensSaved === 0 ? 0 : estTokensSaved / (estTokensOut + estTokensSaved),
    replayed: entries.filter((e) => e.replayed).length,
    pending: entries.filter((e) => e.pending).length,
    uncertain: entries.filter((e) => e.uncertain).length,
    folds: entries.filter((e) => (e.folded_chars ?? 0) > 0).length,
    topTools,
  };
}

/** 过滤出明细（汇总始终基于全部保留日志，明细才吃 filter） */
export function filterUsage(entries: UsageEntry[], filter: UsageFilter): UsageEntry[] {
  let list = entries;
  if (filter.tool) list = list.filter((e) => e.tool === filter.tool);
  if (filter.ok !== undefined) list = list.filter((e) => e.ok === filter.ok);
  if (filter.since) list = list.filter((e) => e.ts >= filter.since!);
  const last = filter.last ?? 20;
  return list.slice(-last).reverse();
}

export function filterRuntime(entries: RuntimeEntry[], filter: RuntimeFilter): RuntimeEntry[] {
  let list = entries;
  if (filter.level) list = list.filter((e) => e.level === filter.level);
  if (filter.event) list = list.filter((e) => e.event === filter.event);
  if (filter.since) list = list.filter((e) => e.ts >= filter.since!);
  const last = filter.last ?? 20;
  return list.slice(-last).reverse();
}

/* ------------------------------ 渲染（供工具层） ------------------------------ */

function fmtK(n: number): string {
  return n >= 10000 ? `${(n / 1000).toFixed(0)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function fmtPct(rate: number): string {
  return `${(rate * 100).toFixed(rate < 0.1 && rate > 0 ? 1 : 0)}%`;
}

function outcomeMark(e: UsageEntry): string {
  if (!e.ok) return "❌";
  if (e.uncertain) return "⚠️";
  if (e.replayed) return "↩️";
  if (e.pending) return "⏳";
  return "✅";
}

export function renderUsageLogLines(root: string, filter: UsageFilter): string[] {
  const entries = loadUsageEntries(root);
  if (entries.length === 0) {
    return [
      "（使用日志为空：还没有记录到工具调用；日志在项目初始化后自动开始记录。）",
      "提示: 本日志只记工具名与计量（耗时/输出量），不记录参数内容。",
    ];
  }
  const summary = usageSummary(entries);
  const list = filterUsage(entries, filter);
  const conditions = [
    filter.tool ? `工具=${filter.tool}` : "",
    filter.ok !== undefined ? `结果=${filter.ok ? "成功" : "失败"}` : "",
    filter.since ? `since=${filter.since}` : "",
  ].filter(Boolean).join(" · ");
  const L: string[] = [];
  L.push(`## 使用日志汇总（保留 ${entries.length} 次调用）`);
  L.push(
    `- 调用 ${summary.calls} 次 · 失败 ${summary.errors} 次（${fmtPct(summary.errorRate)}）· 平均 ${summary.avgMs}ms · 最慢 ${summary.maxMs}ms（${summary.slowestTool}）`,
  );
  L.push(
    `- 幂等复用 ${summary.replayed} 次 · 等待占位 ${summary.pending} 次 · 不确定 ${summary.uncertain} 次 · 发生折叠 ${summary.folds} 次`,
  );
  L.push(
    `- 估算输出 tokens ≈ ${fmtK(summary.estTokensOut)} · 折叠省下 ≈ ${fmtK(summary.estTokensSaved)}（占总产出 ${fmtPct(summary.savePct)}）——省 token 主要来自输出折叠与过滤引导`,
  );
  if (summary.topTools.length > 0) {
    L.push(`- 热门工具: ${summary.topTools.map((t) => `${t.tool}×${t.calls}${t.errors > 0 ? `(${t.errors}败)` : ""}`).join(" · ")}`);
  }
  L.push("");
  L.push(`## 明细（最近 ${list.length} 条${conditions ? `，过滤: ${conditions}` : ""}）`);
  if (list.length === 0) L.push("（无匹配条目，放宽过滤条件试试。）");
  for (const e of list) {
    const parts = [
      e.ts.slice(0, 19),
      `${outcomeMark(e)} ${e.tool}`,
      `${e.ms}ms`,
      e.out_chars !== undefined ? `输出 ${fmtK(e.out_chars)} 字/tok≈${fmtK(e.est_tokens ?? 0)}` : "",
      (e.folded_tokens ?? 0) > 0 ? `折叠省 tok≈${fmtK(e.folded_tokens!)}` : "",
      e.error ? `错误: ${e.error.slice(0, 160)}` : "",
    ].filter(Boolean);
    L.push(parts.join(" "));
  }
  return L;
}

export function renderRuntimeLogLines(root: string, filter: RuntimeFilter): string[] {
  const entries = loadRuntimeEntries(root);
  if (entries.length === 0) {
    return ["（运行日志为空：服务级事件（启动、watcher、工具报错）会在项目初始化后自动记录。）"];
  }
  const counts = { info: 0, warn: 0, error: 0 } as Record<RuntimeLevel, number>;
  for (const e of entries) counts[e.level] += 1;
  const list = filterRuntime(entries, filter);
  const conditions = [
    filter.level ? `level=${filter.level}` : "",
    filter.event ? `event=${filter.event}` : "",
    filter.since ? `since=${filter.since}` : "",
  ].filter(Boolean).join(" · ");
  const L: string[] = [];
  L.push(`## 运行日志（保留 ${entries.length} 条：info ${counts.info} · warn ${counts.warn} · error ${counts.error}）`);
  if (counts.error > 0) {
    const lastError = [...entries].reverse().find((e) => e.level === "error");
    if (lastError) L.push(`- 最近 error: ${lastError.ts.slice(0, 19)} ${lastError.event} ${lastError.detail ?? ""}`.trimEnd());
  }
  L.push("");
  L.push(`## 明细（最近 ${list.length} 条${conditions ? `，过滤: ${conditions}` : ""}）`);
  if (list.length === 0) L.push("（无匹配条目，放宽过滤条件试试。）");
  for (const e of list) {
    L.push([e.ts.slice(0, 19), `[${e.level}]`, e.event, e.detail ?? ""].filter(Boolean).join(" ").trimEnd());
  }
  return L;
}
