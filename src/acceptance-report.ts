import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  ACCEPTANCE_SCHEMA_VERSION,
  BaselineApprovalSchema,
  FrozenEvidencePointerSchema,
  ISO_25010_CHARACTERISTICS,
  ISO_25040_STAGES,
  MachineAssertionSchema,
  RISK_LEVELS,
} from "./acceptance-model.ts";
import { pmPath } from "./paths.ts";
import { atomicWrite, withLedgerLock } from "./store.ts";

export const ACCEPTANCE_STANDARD_BASIS = [
  "ISO/IEC 25010:2023",
  "ISO/IEC 25023:2016",
  "ISO/IEC 25030:2019",
  "ISO/IEC 25040:2024",
  "ISO/IEC/IEEE 29119-2:2021",
] as const;

const IdSchema = z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const TextSchema = z.string().trim().min(1).max(8_000);
const TimestampSchema = z.string().datetime({ offset: true });
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/i);

function requireUniqueSet(values: readonly string[], expected: readonly string[] | null, pathName: string, ctx: z.RefinementCtx): void {
  const actual = new Set(values);
  if (actual.size !== values.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: [pathName], message: `${pathName} 包含重复项` });
  }
  if (expected) {
    for (const item of expected) {
      if (!actual.has(item)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [pathName], message: `${pathName} 缺少 "${item}"` });
    }
    if (values.length !== expected.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [pathName], message: `${pathName} 数量必须为 ${expected.length}` });
  }
}

export const AcceptanceFindingSchema = z
  .object({
    code: IdSchema,
    severity: z.enum(["error", "warning"]),
    subject: TextSchema,
    message: TextSchema,
  })
  .strict();

export const AcceptanceReportSchema = z
  .object({
    schema_version: z.literal(ACCEPTANCE_SCHEMA_VERSION),
    report_id: IdSchema,
    evaluation_id: IdSchema,
    report_generated_at: TimestampSchema,
    product: TextSchema,
    scope: TextSchema,
    baseline: z
      .object({
        id: IdSchema,
        version: z.string().min(1),
        title: TextSchema,
        fingerprint_sha256: Sha256Schema,
        approval: BaselineApprovalSchema,
      })
      .strict(),
    evaluator: z
      .object({
        name: TextSchema,
        organization: TextSchema,
        role: TextSchema,
        independent: z.boolean(),
      })
      .strict(),
    standard_basis: z.tuple([
      z.literal(ACCEPTANCE_STANDARD_BASIS[0]),
      z.literal(ACCEPTANCE_STANDARD_BASIS[1]),
      z.literal(ACCEPTANCE_STANDARD_BASIS[2]),
      z.literal(ACCEPTANCE_STANDARD_BASIS[3]),
      z.literal(ACCEPTANCE_STANDARD_BASIS[4]),
    ]),
    verdict: z.enum(["accepted", "rejected"]),
    summary: z
      .object({
        applicable_characteristics: z.number().int().min(0),
        accepted_characteristics: z.number().int().min(0),
        requirements_total: z.number().int().min(0),
        requirements_passed: z.number().int().min(0),
        tests_total: z.number().int().min(0),
        tests_passed: z.number().int().min(0),
        risks_total: z.number().int().min(0),
        risks_controlled: z.number().int().min(0),
        stages_total: z.number().int().min(0),
        stages_completed: z.number().int().min(0),
        errors: z.number().int().min(0),
        warnings: z.number().int().min(0),
      })
      .strict(),
    stage_results: z.array(
      z.object({
        stage: z.enum(ISO_25040_STAGES),
        status: z.enum(["completed", "blocked", "not_started"]),
        passed: z.boolean(),
        evidence_ids: z.array(IdSchema),
        result_note: TextSchema,
      }).strict(),
    ),
    characteristic_results: z.array(
      z.object({
        id: z.enum(ISO_25010_CHARACTERISTICS),
        status: z.enum(["accepted", "rejected", "tailored_out"]),
        requirement_ids: z.array(IdSchema),
        tailoring_reason: TextSchema.nullable(),
      }).strict(),
    ),
    requirement_results: z.array(
      z.object({
        id: IdSchema,
        characteristic: z.enum(ISO_25010_CHARACTERISTICS),
        metric_name: TextSchema,
        unit: TextSchema,
        direction: z.enum(["at_least", "at_most", "equal"]),
        threshold: z.number().finite(),
        tolerance: z.number().finite().min(0),
        observed_value: z.number().finite().nullable(),
        measurement_source: FrozenEvidencePointerSchema,
        passed: z.boolean(),
        risk_ids: z.array(IdSchema),
        test_ids: z.array(IdSchema),
        evidence_ids: z.array(IdSchema),
      }).strict(),
    ),
    test_results: z.array(
      z.object({
        id: IdSchema,
        status: z.enum(["passed", "failed", "blocked", "not_run", "missing"]),
        verification_mode: z.enum(["automated", "manual"]),
        assertion: MachineAssertionSchema.nullable(),
        passed: z.boolean(),
        evidence_ids: z.array(IdSchema),
      }).strict(),
    ),
    risk_results: z.array(
      z.object({
        id: IdSchema,
        owner: TextSchema,
        likelihood: z.enum(["rare", "unlikely", "possible", "likely", "almost_certain"]),
        impact: z.enum(["negligible", "minor", "moderate", "major", "severe"]),
        inherent_level: z.enum(RISK_LEVELS),
        compensating_controls: z.array(TextSchema).min(1),
        residual_level: z.enum(RISK_LEVELS).nullable(),
        disposition: z.enum(["mitigated", "accepted", "open", "missing"]),
        accepted_by: TextSchema.nullable(),
        evidence_ids: z.array(IdSchema),
        controlled: z.boolean(),
      }).strict(),
    ),
    traceability_matrix: z.array(
      z.object({
        requirement_id: IdSchema,
        risk_ids: z.array(IdSchema),
        test_ids: z.array(IdSchema),
        evidence_ids: z.array(IdSchema),
        complete: z.boolean(),
      }).strict(),
    ),
    findings: z.array(AcceptanceFindingSchema),
    conclusion: TextSchema,
  })
  .strict()
  .superRefine((report, ctx) => {
    requireUniqueSet(report.stage_results.map((item) => item.stage), ISO_25040_STAGES, "stage_results", ctx);
    requireUniqueSet(report.characteristic_results.map((item) => item.id), ISO_25010_CHARACTERISTICS, "characteristic_results", ctx);
    requireUniqueSet(report.requirement_results.map((item) => item.id), null, "requirement_results", ctx);
    requireUniqueSet(report.test_results.map((item) => item.id), null, "test_results", ctx);
    requireUniqueSet(report.risk_results.map((item) => item.id), null, "risk_results", ctx);
    requireUniqueSet(report.traceability_matrix.map((item) => item.requirement_id), null, "traceability_matrix", ctx);
    const requirementIds = new Set(report.requirement_results.map((item) => item.id));
    const traceIds = new Set(report.traceability_matrix.map((item) => item.requirement_id));
    for (const id of requirementIds) {
      if (!traceIds.has(id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["traceability_matrix"], message: `追踪矩阵缺少需求 "${id}"` });
    }
    for (const id of traceIds) {
      if (!requirementIds.has(id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["traceability_matrix"], message: `追踪矩阵包含未知需求 "${id}"` });
    }
    const errors = report.findings.filter((finding) => finding.severity === "error").length;
    const warnings = report.findings.filter((finding) => finding.severity === "warning").length;
    const expected = {
      applicable_characteristics: report.characteristic_results.filter((item) => item.status !== "tailored_out").length,
      accepted_characteristics: report.characteristic_results.filter((item) => item.status === "accepted").length,
      requirements_total: report.requirement_results.length,
      requirements_passed: report.requirement_results.filter((item) => item.passed).length,
      tests_total: report.test_results.length,
      tests_passed: report.test_results.filter((item) => item.passed).length,
      risks_total: report.risk_results.length,
      risks_controlled: report.risk_results.filter((item) => item.controlled).length,
      stages_total: report.stage_results.length,
      stages_completed: report.stage_results.filter((item) => item.passed).length,
      errors,
      warnings,
    };
    for (const [key, value] of Object.entries(expected)) {
      if (report.summary[key as keyof typeof expected] !== value) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["summary", key], message: `汇总值应为 ${value}` });
      }
    }
    if ((errors === 0) !== (report.verdict === "accepted")) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["verdict"], message: "verdict 必须与 error finding 一致" });
    }
  });

export type AcceptanceFinding = z.infer<typeof AcceptanceFindingSchema>;
export type AcceptanceReport = z.infer<typeof AcceptanceReportSchema>;

export const AcceptanceReportManifestSchema = z
  .object({
    schema_version: z.literal(ACCEPTANCE_SCHEMA_VERSION),
    report_id: IdSchema,
    generated_at: TimestampSchema,
    json_sha256: Sha256Schema,
    markdown_sha256: Sha256Schema,
  })
  .strict();

export type AcceptanceReportManifest = z.infer<typeof AcceptanceReportManifestSchema>;

function md(value: unknown): string {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");
}

function list(values: readonly string[]): string {
  return values.length === 0 ? "—" : values.map(md).join(", ");
}

export function renderAcceptanceReportMarkdown(input: AcceptanceReport): string {
  const report = AcceptanceReportSchema.parse(input);
  const lines: string[] = [
    `# 产品质量正式评价报告：${report.product}`,
    "",
    `- 报告 ID：${report.report_id}`,
    `- 评价 ID：${report.evaluation_id}`,
    `- 基线：${report.baseline.id}@${report.baseline.version}`,
    `- 基线 SHA-256：\`${report.baseline.fingerprint_sha256}\``,
    `- 基线审批：${report.baseline.approval.status}`,
    `- 评价人：${report.evaluator.name}（${report.evaluator.organization}，${report.evaluator.role}）`,
    `- 独立评价：${report.evaluator.independent ? "是" : "否"}`,
    `- 报告生成时间：${report.report_generated_at}`,
    `- 最终结论：**${report.verdict === "accepted" ? "通过" : "不通过"}**`,
    "",
    "## 适用标准",
    "",
    ...report.standard_basis.map((standard) => `- ${standard}`),
    "",
    "## 评价摘要",
    "",
    "| 项目 | 通过 / 总数 |",
    "|---|---:|",
    `| ISO/IEC 25010 适用质量特性 | ${report.summary.accepted_characteristics} / ${report.summary.applicable_characteristics} |`,
    `| 量化质量需求 | ${report.summary.requirements_passed} / ${report.summary.requirements_total} |`,
    `| 验收测试 | ${report.summary.tests_passed} / ${report.summary.tests_total} |`,
    `| 残余风险受控 | ${report.summary.risks_controlled} / ${report.summary.risks_total} |`,
    `| ISO/IEC 25040 评价阶段 | ${report.summary.stages_completed} / ${report.summary.stages_total} |`,
    `| 错误 / 警告 | ${report.summary.errors} / ${report.summary.warnings} |`,
    "",
    "## ISO/IEC 25040 阶段记录",
    "",
    "| 阶段 | 状态 | 证据 | 结论 |",
    "|---|---|---|---|",
    ...report.stage_results.map((item) => `| ${item.stage} | ${item.status} | ${list(item.evidence_ids)} | ${md(item.result_note)} |`),
    "",
    "## ISO/IEC 25010 质量特性",
    "",
    "| 特性 | 状态 | 需求 | 裁剪理由 |",
    "|---|---|---|---|",
    ...report.characteristic_results.map((item) => `| ${item.id} | ${item.status} | ${list(item.requirement_ids)} | ${md(item.tailoring_reason ?? "—")} |`),
    "",
    "## 量化需求结果",
    "",
    "| 需求 | 特性 | 指标 | 阈值 | 实测 | 冻结数据源 | 结果 | 证据 |",
    "|---|---|---|---:|---:|---|---|---|",
    ...report.requirement_results.map((item) => {
      const operator = item.direction === "at_least" ? ">=" : item.direction === "at_most" ? "<=" : "=";
      return `| ${item.id} | ${item.characteristic} | ${md(item.metric_name)} (${md(item.unit)}) | ${operator} ${item.threshold} | ${item.observed_value ?? "—"} | ${item.measurement_source.evidence_id}#${md(item.measurement_source.json_pointer)} | ${item.passed ? "通过" : "不通过"} | ${list(item.evidence_ids)} |`;
    }),
    "",
    "## 验收测试与冻结断言",
    "",
    "| 测试 | 验证模式 | 冻结断言 | 状态 | 结果 | 证据 |",
    "|---|---|---|---|---|---|",
    ...report.test_results.map((item) => {
      const assertion = item.assertion
        ? `${item.assertion.evidence_id}#${item.assertion.json_pointer} ${item.assertion.operator} ${JSON.stringify(item.assertion.expected)}`
        : "人工评价";
      return `| ${item.id} | ${item.verification_mode} | ${md(assertion)} | ${item.status} | ${item.passed ? "通过" : "不通过"} | ${list(item.evidence_ids)} |`;
    }),
    "",
    "## 需求—风险—测试—证据追踪矩阵",
    "",
    "| 需求 | 风险 | 测试 | 证据 | 完整 |",
    "|---|---|---|---|---|",
    ...report.traceability_matrix.map((item) => `| ${item.requirement_id} | ${list(item.risk_ids)} | ${list(item.test_ids)} | ${list(item.evidence_ids)} | ${item.complete ? "是" : "否"} |`),
    "",
    "## 残余风险",
    "",
    "| 风险 | Owner | 可能性 | 影响 | 固有等级 | 补偿控制 | 残余等级 | 处置 | 接受人 | 受控 | 证据 |",
    "|---|---|---|---|---|---|---|---|---|---|---|",
    ...report.risk_results.map((item) => `| ${item.id} | ${md(item.owner)} | ${item.likelihood} | ${item.impact} | ${item.inherent_level} | ${list(item.compensating_controls)} | ${item.residual_level ?? "—"} | ${item.disposition} | ${md(item.accepted_by ?? "—")} | ${item.controlled ? "是" : "否"} | ${list(item.evidence_ids)} |`),
    "",
    "## 发现项",
    "",
  ];

  if (report.findings.length === 0) {
    lines.push("无阻断项或警告。", "");
  } else {
    lines.push("| 严重度 | 代码 | 对象 | 说明 |", "|---|---|---|---|", ...report.findings.map((item) => `| ${item.severity} | ${item.code} | ${md(item.subject)} | ${md(item.message)} |`), "");
  }
  lines.push("## 正式结论", "", report.conclusion, "");
  return lines.join("\n");
}

export function acceptanceReportPaths(root: string, reportId: string): { json_file: string; markdown_file: string; manifest_file: string } {
  const safe = IdSchema.parse(reportId);
  const dir = pmPath(path.resolve(root), "acceptance", "reports");
  return {
    json_file: path.join(dir, `${safe}.json`),
    markdown_file: path.join(dir, `${safe}.md`),
    manifest_file: path.join(dir, `${safe}.sha256.json`),
  };
}

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export function writeAcceptanceReport(root: string, input: AcceptanceReport): { json_file: string; markdown_file: string; manifest_file: string } {
  const report = AcceptanceReportSchema.parse(input);
  const files = acceptanceReportPaths(root, report.report_id);
  const jsonContent = JSON.stringify(report, null, 2) + "\n";
  const markdownContent = renderAcceptanceReportMarkdown(report);
  const manifest = AcceptanceReportManifestSchema.parse({
    schema_version: ACCEPTANCE_SCHEMA_VERSION,
    report_id: report.report_id,
    generated_at: report.report_generated_at,
    json_sha256: sha256(jsonContent),
    markdown_sha256: sha256(markdownContent),
  });
  const manifestContent = JSON.stringify(manifest, null, 2) + "\n";
  return withLedgerLock(path.resolve(root), () => {
    fs.mkdirSync(path.dirname(files.json_file), { recursive: true });
    const existing = [files.json_file, files.markdown_file, files.manifest_file].filter((file) => fs.existsSync(file));
    if (existing.length > 0) {
      const allMatch = existing.length === 3
        && fs.readFileSync(files.json_file, "utf8") === jsonContent
        && fs.readFileSync(files.markdown_file, "utf8") === markdownContent
        && fs.readFileSync(files.manifest_file, "utf8") === manifestContent;
      if (!allMatch) throw new Error(`正式验收报告不可覆盖或修补（三件套）：${report.report_id}；请使用新的 report_id。`);
      return files;
    }
    atomicWrite(files.json_file, jsonContent);
    atomicWrite(files.markdown_file, markdownContent);
    atomicWrite(files.manifest_file, manifestContent);
    return files;
  });
}
