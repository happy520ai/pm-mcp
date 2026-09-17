import { createHash } from "node:crypto";
import { z } from "zod";
import type { QualityCommandResult } from "./language-adapters.ts";

export const CompletionEvidenceSchema = z.object({
  minimum: z.enum(["tests_observed", "execution_only"]),
  reason: z.string().trim().min(8).max(1000),
});
export type EvidenceLevel = "unverified" | "execution_only" | "tests_observed" | "coverage_observed";
type Counts = { tests: number | null; passed?: number | null; failed: number | null; skipped: number | null; cancelled: number | null; todo: number | null; coverage?: unknown };
const ranks: Record<EvidenceLevel, number> = { unverified: 0, execution_only: 1, tests_observed: 2, coverage_observed: 3 };

/** 等级描述观测强度，不代表测试充分、结果通过或来源不可伪造。 */
export function evidenceLevel(kind: string, summary: Counts, truncated = false): EvidenceLevel {
  if (truncated || !["test", "coverage"].includes(kind)) return "execution_only";
  const counters = [summary.failed, summary.skipped, summary.cancelled, summary.todo];
  if (summary.tests === null || !Number.isSafeInteger(summary.tests) || summary.tests <= 0 ||
    counters.some((n) => n === null || !Number.isSafeInteger(n) || n < 0) ||
    counters.reduce<number>((total, n) => total + (n ?? 0), 0) > summary.tests) return "execution_only";
  if (summary.passed != null && summary.passed + counters.reduce<number>((total, n) => total + (n ?? 0), 0) !== summary.tests) return "execution_only";
  const coverage = z.object({ lines_pct: z.number().min(0).max(100), branches_pct: z.number().min(0).max(100), functions_pct: z.number().min(0).max(100) }).safeParse(summary.coverage);
  return coverage.success ? "coverage_observed" : "tests_observed";
}

export function weakestEvidence(levels: EvidenceLevel[]): EvidenceLevel {
  return levels.length ? levels.reduce((a, b) => ranks[a] < ranks[b] ? a : b) : "execution_only";
}

export function evidenceLabel(level?: string): string {
  return ({ unverified: "无可用验证证据", execution_only: "仅执行记录，未确认测试数量", tests_observed: "已观察测试结果", coverage_observed: "已观察测试与覆盖率" } as Record<string, string>)[level ?? ""] ?? "旧报告未标等级";
}

export function qualityResultSummary(item: QualityCommandResult) {
  const summary = qualityOutputSummary(item.command.kind, item.stdout, item.stderr, item.truncated);
  return { ...summary, evidence_level: item.exitCode === null ? "unverified" as const : summary.evidence_level };
}

export function qualityOutputSummary(kind: string, stdout: string, stderr: string, truncated = false) {
  const output = `${stdout}\n${stderr}`.replace(/\u001b\[[0-9;]*m/g, "");
  const diagnostic = (label: string) => {
    const matches = [...output.matchAll(new RegExp(`^[ \\t]*(?:ℹ|#)?[ \\t]*${label}[ \\t]+(\\d+)[ \\t]*\\r?$`, "gmi"))];
    return matches.length ? Number(matches.at(-1)![1]) : null;
  };
  let counts: Counts = { tests: diagnostic("tests"), passed: diagnostic("pass"), failed: diagnostic("fail"), cancelled: diagnostic("cancelled"), skipped: diagnostic("skipped"), todo: diagnostic("todo") };
  let counterSource = counts.tests === null ? "unknown" : "node_test_summary";
  const jest = [...output.matchAll(/^\s*Tests:\s*(.+?)(\d+)\s+total\s*$/gm)].at(-1);
  const vitest = [...output.matchAll(/^\s*Tests\s+(.+?)\s*\((\d+)\)\s*$/gm)].at(-1);
  const pytest = [...output.matchAll(/^=+\s+((?:\d+\s+(?:passed|failed|skipped|xfailed|xpassed|deselected|errors?|warnings?)[,\s]*)+)\s+in\s+[\d.]+s.*?=+\s*$/gm)].at(-1);
  if (counts.tests === null && (jest || vitest || pytest)) {
    const text = (jest ?? vitest ?? pytest)![1];
    const number = (label: string) => Number(new RegExp(`(\\d+)\\s+${label}\\b`).exec(text)?.[1] ?? 0);
    const passed = number("passed"), failed = number("failed") + number("errors?") + number("xpassed");
    const skipped = number("skipped") + number("xfailed") + number("deselected"), todo = number("todo");
    counts = { tests: jest ? Number(jest[2]) : vitest ? Number(vitest[2]) : passed + failed + skipped + todo, passed, failed, skipped, todo, cancelled: 0 };
    counterSource = jest ? "jest_summary" : vitest ? "vitest_summary" : "pytest_summary";
  }
  const coverage = output.match(/(?:^|\n)(?:ℹ|#)?\s*all files\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)(?:\s*\|\s*([\d.]+))?/i);
  counts.coverage = coverage ? { lines_pct: Number(coverage[4] ?? coverage[1]), branches_pct: Number(coverage[2]), functions_pct: Number(coverage[3]) } : null;
  return { stdout_bytes: Buffer.byteLength(stdout), stderr_bytes: Buffer.byteLength(stderr),
    output_sha256: createHash("sha256").update(stdout).update("\0").update(stderr).digest("hex"),
    ...counts, counter_source: counterSource, evidence_level: evidenceLevel(kind, counts, truncated) };
}
