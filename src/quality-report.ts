import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { fingerprintProject } from "./project-fingerprint.ts";

/** 只校验“这是一份结构完整的质量报告”，不把失败报告误判为无效：
 *  ok:false 仍代表真的跑过命令，是有效证据；空文件/坏 JSON/缺 results 才是无效。 */
export const QualityReportSchema = z.object({
  schema_version: z.number().int().optional(),
  run_at: z.string().min(1),
  ok: z.boolean(),
  results: z.array(z.object({
    kind: z.string().optional(),
    status: z.string().optional(),
    output_summary: z.object({
      tests: z.number().nullable().optional(),
      passed: z.number().nullable().optional(),
    }).passthrough().optional(),
  }).passthrough()).min(1),
}).passthrough();

export type QualityReport = z.infer<typeof QualityReportSchema>;

export interface ValidQualityReport {
  /** 相对项目根的路径，如 .pm/quality-runs/quality-...json */
  path: string;
  report: QualityReport;
}

function qualityDirectory(root: string): string {
  return path.join(path.resolve(root), ".pm", "quality-runs");
}

/** 从最新文件往回找第一份能通过结构校验的报告；坏文件不参与证据判定。 */
export function latestValidQualityReport(root: string): ValidQualityReport | null {
  const directory = qualityDirectory(root);
  let names: string[];
  try {
    names = fs.readdirSync(directory).filter((name) => /^quality-.*\.json$/.test(name)).sort().reverse();
  } catch {
    return null;
  }
  for (const name of names) {
    try {
      const raw: unknown = JSON.parse(fs.readFileSync(path.join(directory, name), "utf8"));
      const report = QualityReportSchema.parse(raw);
      return { path: `.pm/quality-runs/${name}`, report };
    } catch {
      // 坏报告继续往前找：一份损坏文件不能把已有证据一起作废
    }
  }
  return null;
}

export interface QualityReportSummary {
  at: string;
  ok: boolean;
  tests: string;
  commands: number;
  /** null=报告没有源码指纹（旧报告），true/false=报告源码与当前工作区是否一致 */
  sourceMatched: boolean | null;
}

export function qualityReportSummary(root: string): QualityReportSummary | null {
  const latest = latestValidQualityReport(root);
  if (!latest) return null;
  const { report } = latest;
  let passed = 0;
  let tests = 0;
  for (const result of report.results) {
    const summary = result.output_summary;
    if (typeof summary?.passed === "number") passed += summary.passed;
    if (typeof summary?.tests === "number") tests += summary.tests;
  }
  const source = (report as { source?: { before?: { sha256?: unknown }; after?: { sha256?: unknown } } }).source;
  const sha = typeof source?.after?.sha256 === "string"
    ? source.after.sha256
    : typeof source?.before?.sha256 === "string" ? source.before.sha256 : null;
  let sourceMatched: boolean | null = null;
  if (sha) {
    try {
      sourceMatched = fingerprintProject(root).sha256 === sha;
    } catch {
      sourceMatched = null;
    }
  }
  return {
    at: report.run_at,
    ok: report.ok,
    tests: tests > 0 ? `${passed}/${tests}` : "n/a",
    commands: report.results.length,
    sourceMatched,
  };
}
