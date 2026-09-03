import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { pmPath } from "./paths.ts";
import { loadJson, saveJson, withLedgerLock } from "./store.ts";

export const ACCEPTANCE_SCHEMA_VERSION = 1 as const;

export const ISO_25010_CHARACTERISTICS = [
  "functional_suitability",
  "performance_efficiency",
  "compatibility",
  "interaction_capability",
  "reliability",
  "security",
  "maintainability",
  "flexibility",
  "safety",
] as const;

export const ISO_25040_STAGES = ["define", "design", "plan", "execute", "conclude"] as const;

export const RISK_LEVELS = ["low", "medium", "high", "critical"] as const;

const IdSchema = z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, "只能包含字母、数字、点、下划线、冒号和连字符");
const TextSchema = z.string().trim().min(1).max(4_000);
const RationaleSchema = z.string().trim().min(8, "理由至少需要 8 个字符").max(4_000);
const TimestampSchema = z.string().datetime({ offset: true });
const SemVerSchema = z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/, "必须是语义化版本");
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/i, "必须是 64 位 SHA-256 十六进制摘要");
export const JsonPointerSchema = z
  .string()
  .max(2_000)
  .refine((value) => value === "" || /^\/(?:[^~/]|~[01])*(?:\/(?:[^~/]|~[01])*)*$/.test(value), "必须是合法 RFC 6901 JSON Pointer");

export const FrozenEvidencePointerSchema = z
  .object({
    evidence_id: IdSchema,
    json_pointer: JsonPointerSchema,
  })
  .strict();

export const MachineAssertionSchema = FrozenEvidencePointerSchema.extend({
  operator: z.enum(["equal", "not_equal", "at_least", "at_most"]),
  expected: z.union([z.string(), z.number().finite(), z.boolean(), z.null()]),
})
  .strict()
  .superRefine((assertion, ctx) => {
    if ((assertion.operator === "at_least" || assertion.operator === "at_most") && typeof assertion.expected !== "number") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["expected"], message: `${assertion.operator} 的 expected 必须是数字` });
    }
  });

export const QualityCharacteristicSchema = z
  .object({
    id: z.enum(ISO_25010_CHARACTERISTICS),
    applicable: z.boolean(),
    tailoring_reason: RationaleSchema.nullable(),
  })
  .strict()
  .superRefine((characteristic, ctx) => {
    if (characteristic.applicable && characteristic.tailoring_reason !== null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["tailoring_reason"], message: "适用特性不得填写裁剪理由" });
    }
    if (!characteristic.applicable && characteristic.tailoring_reason === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["tailoring_reason"], message: "裁剪特性必须说明理由" });
    }
  });

export const QualityRequirementSchema = z
  .object({
    id: IdSchema,
    characteristic: z.enum(ISO_25010_CHARACTERISTICS),
    statement: TextSchema,
    metric: z
      .object({
        name: TextSchema,
        unit: TextSchema,
        direction: z.enum(["at_least", "at_most", "equal"]),
        threshold: z.number().finite(),
        tolerance: z.number().finite().min(0).default(0),
      })
      .strict(),
    measurement_source: FrozenEvidencePointerSchema,
    risk_ids: z.array(IdSchema).min(1),
    test_ids: z.array(IdSchema).min(1),
  })
  .strict();

export const AcceptanceRiskSchema = z
  .object({
    id: IdSchema,
    title: TextSchema,
    description: TextSchema,
    owner: TextSchema,
    likelihood: z.enum(["rare", "unlikely", "possible", "likely", "almost_certain"]),
    impact: z.enum(["negligible", "minor", "moderate", "major", "severe"]),
    inherent_level: z.enum(RISK_LEVELS),
    treatment: TextSchema,
    compensating_controls: z.array(TextSchema).min(1),
    requirement_ids: z.array(IdSchema).min(1),
    test_ids: z.array(IdSchema).min(1),
  })
  .strict();

export const AcceptanceTestSchema = z
  .object({
    id: IdSchema,
    title: TextSchema,
    procedure: TextSchema,
    expected_result: TextSchema,
    expected_evidence_kind: z.enum(["test_result", "benchmark", "audit", "inspection", "review", "measurement", "certificate"]),
    verification_mode: z.enum(["automated", "manual"]).default("automated"),
    assertion: MachineAssertionSchema.nullable().default(null),
    requirement_ids: z.array(IdSchema).min(1),
    risk_ids: z.array(IdSchema).min(1),
  })
  .strict()
  .superRefine((acceptanceTest, ctx) => {
    if (acceptanceTest.verification_mode === "automated" && acceptanceTest.assertion === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["assertion"], message: "automated 测试必须冻结机器断言" });
    }
    if (acceptanceTest.verification_mode === "manual") {
      if (acceptanceTest.assertion !== null) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["assertion"], message: "manual 测试不得伪装为机器断言" });
      }
      if (!["inspection", "review", "certificate"].includes(acceptanceTest.expected_evidence_kind)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["expected_evidence_kind"], message: "manual 测试仅允许 inspection/review/certificate 证据" });
      }
    }
  });

export const BaselineApprovalSchema = z
  .object({
    status: z.enum(["draft", "approved", "rejected", "superseded"]),
    approved_by: TextSchema.nullable(),
    approved_at: TimestampSchema.nullable(),
    rationale: RationaleSchema.nullable(),
  })
  .strict()
  .superRefine((approval, ctx) => {
    const complete = approval.approved_by !== null && approval.approved_at !== null && approval.rationale !== null;
    if (approval.status === "approved" && !complete) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "approved 状态必须包含批准人、批准时间和批准理由" });
    }
    if (approval.status !== "approved" && (approval.approved_by !== null || approval.approved_at !== null)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "非 approved 状态不得携带批准人或批准时间" });
    }
  });

export const EvaluationPlanStageSchema = z
  .object({
    stage: z.enum(ISO_25040_STAGES),
    owner: TextSchema,
    objective: TextSchema,
    entry_criteria: z.array(TextSchema).min(1),
    activities: z.array(TextSchema).min(1),
    planned_outputs: z.array(TextSchema).min(1),
    exit_criteria: z.array(TextSchema).min(1),
  })
  .strict();

export const AcceptancePolicySchema = z
  .object({
    require_all_requirements: z.literal(true),
    require_all_tests: z.literal(true),
    require_all_stages: z.literal(true),
    require_independent_evaluator: z.boolean(),
    maximum_residual_risk_level: z.enum(RISK_LEVELS),
    authorized_risk_acceptors: z.array(TextSchema).min(1),
  })
  .strict();

function addDuplicateIssues(values: readonly string[], pathName: string, ctx: z.RefinementCtx): void {
  const seen = new Set<string>();
  values.forEach((value, index) => {
    if (seen.has(value)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [pathName, index, "id"], message: `重复 ID "${value}"` });
    }
    seen.add(value);
  });
}

function addDuplicateReferenceIssues(values: readonly string[], pathPrefix: (string | number)[], ctx: z.RefinementCtx): void {
  const seen = new Set<string>();
  values.forEach((value, index) => {
    if (seen.has(value)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...pathPrefix, index], message: `重复引用 "${value}"` });
    }
    seen.add(value);
  });
}

function requireExactEnumSet(
  values: readonly string[],
  expected: readonly string[],
  pathName: string,
  ctx: z.RefinementCtx,
): void {
  const actual = new Set(values);
  for (const value of expected) {
    if (!actual.has(value)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [pathName], message: `缺少必需项 "${value}"` });
    }
  }
}

export const AcceptanceBaselineSchema = z
  .object({
    schema_version: z.literal(ACCEPTANCE_SCHEMA_VERSION),
    baseline_id: IdSchema,
    baseline_version: SemVerSchema,
    title: TextSchema,
    product: TextSchema,
    scope: TextSchema,
    created_at: TimestampSchema,
    approval: BaselineApprovalSchema,
    characteristics: z.array(QualityCharacteristicSchema).length(ISO_25010_CHARACTERISTICS.length),
    requirements: z.array(QualityRequirementSchema).min(1),
    risks: z.array(AcceptanceRiskSchema).min(1),
    tests: z.array(AcceptanceTestSchema).min(1),
    evaluation_plan: z.array(EvaluationPlanStageSchema).length(ISO_25040_STAGES.length),
    acceptance_policy: AcceptancePolicySchema,
  })
  .strict()
  .superRefine((baseline, ctx) => {
    addDuplicateIssues(baseline.characteristics.map((item) => item.id), "characteristics", ctx);
    addDuplicateIssues(baseline.requirements.map((item) => item.id), "requirements", ctx);
    addDuplicateIssues(baseline.risks.map((item) => item.id), "risks", ctx);
    addDuplicateIssues(baseline.tests.map((item) => item.id), "tests", ctx);
    addDuplicateIssues(baseline.evaluation_plan.map((item) => item.stage), "evaluation_plan", ctx);
    requireExactEnumSet(baseline.characteristics.map((item) => item.id), ISO_25010_CHARACTERISTICS, "characteristics", ctx);
    requireExactEnumSet(baseline.evaluation_plan.map((item) => item.stage), ISO_25040_STAGES, "evaluation_plan", ctx);

    const characteristicById = new Map(baseline.characteristics.map((item) => [item.id, item]));
    const requirementById = new Map(baseline.requirements.map((item) => [item.id, item]));
    const riskById = new Map(baseline.risks.map((item) => [item.id, item]));
    const testById = new Map(baseline.tests.map((item) => [item.id, item]));

    for (const characteristic of baseline.characteristics) {
      const linked = baseline.requirements.filter((item) => item.characteristic === characteristic.id);
      if (characteristic.applicable && linked.length === 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["characteristics"], message: `适用特性 "${characteristic.id}" 至少需要一条量化需求` });
      }
      if (!characteristic.applicable && linked.length > 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["requirements"], message: `已裁剪特性 "${characteristic.id}" 不得关联质量需求` });
      }
    }

    baseline.requirements.forEach((requirement, requirementIndex) => {
      if (!characteristicById.get(requirement.characteristic)?.applicable) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["requirements", requirementIndex, "characteristic"], message: `需求关联了未纳入的特性 "${requirement.characteristic}"` });
      }
      addDuplicateReferenceIssues(requirement.risk_ids, ["requirements", requirementIndex, "risk_ids"], ctx);
      addDuplicateReferenceIssues(requirement.test_ids, ["requirements", requirementIndex, "test_ids"], ctx);
      requirement.risk_ids.forEach((riskId, index) => {
        const risk = riskById.get(riskId);
        if (!risk) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["requirements", requirementIndex, "risk_ids", index], message: `未知 risk 引用 "${riskId}"` });
        } else if (!risk.requirement_ids.includes(requirement.id)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["requirements", requirementIndex, "risk_ids", index], message: `requirement-risk 反向追踪缺失："${riskId}" 未引用 "${requirement.id}"` });
        }
      });
      requirement.test_ids.forEach((testId, index) => {
        const acceptanceTest = testById.get(testId);
        if (!acceptanceTest) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["requirements", requirementIndex, "test_ids", index], message: `未知 test 引用 "${testId}"` });
        } else if (!acceptanceTest.requirement_ids.includes(requirement.id)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["requirements", requirementIndex, "test_ids", index], message: `requirement-test 反向追踪缺失："${testId}" 未引用 "${requirement.id}"` });
        }
      });
    });

    baseline.risks.forEach((risk, riskIndex) => {
      addDuplicateReferenceIssues(risk.requirement_ids, ["risks", riskIndex, "requirement_ids"], ctx);
      addDuplicateReferenceIssues(risk.test_ids, ["risks", riskIndex, "test_ids"], ctx);
      risk.requirement_ids.forEach((requirementId, index) => {
        const requirement = requirementById.get(requirementId);
        if (!requirement) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["risks", riskIndex, "requirement_ids", index], message: `未知 requirement 引用 "${requirementId}"` });
        } else if (!requirement.risk_ids.includes(risk.id)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["risks", riskIndex, "requirement_ids", index], message: `risk-requirement 反向追踪缺失："${requirementId}" 未引用 "${risk.id}"` });
        }
      });
      risk.test_ids.forEach((testId, index) => {
        const acceptanceTest = testById.get(testId);
        if (!acceptanceTest) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["risks", riskIndex, "test_ids", index], message: `未知 test 引用 "${testId}"` });
        } else if (!acceptanceTest.risk_ids.includes(risk.id)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["risks", riskIndex, "test_ids", index], message: `risk-test 反向追踪缺失："${testId}" 未引用 "${risk.id}"` });
        }
      });
    });

    baseline.tests.forEach((acceptanceTest, testIndex) => {
      addDuplicateReferenceIssues(acceptanceTest.requirement_ids, ["tests", testIndex, "requirement_ids"], ctx);
      addDuplicateReferenceIssues(acceptanceTest.risk_ids, ["tests", testIndex, "risk_ids"], ctx);
      acceptanceTest.requirement_ids.forEach((requirementId, index) => {
        const requirement = requirementById.get(requirementId);
        if (!requirement) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["tests", testIndex, "requirement_ids", index], message: `未知 requirement 引用 "${requirementId}"` });
        } else if (!requirement.test_ids.includes(acceptanceTest.id)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["tests", testIndex, "requirement_ids", index], message: `test-requirement 反向追踪缺失："${requirementId}" 未引用 "${acceptanceTest.id}"` });
        }
      });
      acceptanceTest.risk_ids.forEach((riskId, index) => {
        const risk = riskById.get(riskId);
        if (!risk) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["tests", testIndex, "risk_ids", index], message: `未知 risk 引用 "${riskId}"` });
        } else if (!risk.test_ids.includes(acceptanceTest.id)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["tests", testIndex, "risk_ids", index], message: `test-risk 反向追踪缺失："${riskId}" 未引用 "${acceptanceTest.id}"` });
        }
      });

      for (const requirementId of acceptanceTest.requirement_ids) {
        const requirement = requirementById.get(requirementId);
        if (requirement && !acceptanceTest.risk_ids.some((riskId) => requirement.risk_ids.includes(riskId))) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["tests", testIndex], message: `测试 "${acceptanceTest.id}" 与需求 "${requirementId}" 没有共同风险，追踪链不完整` });
        }
      }
    });
  });

export const AcceptanceEvidenceSchema = z
  .object({
    id: IdSchema,
    kind: z.enum(["test_result", "benchmark", "audit", "inspection", "review", "measurement", "certificate"]),
    locator: TextSchema,
    captured_at: TimestampSchema,
    sha256: Sha256Schema,
    produced_by: TextSchema,
    summary: TextSchema,
  })
  .strict();

export const EvaluationStageResultSchema = z
  .object({
    stage: z.enum(ISO_25040_STAGES),
    status: z.enum(["completed", "blocked", "not_started"]),
    started_at: TimestampSchema.nullable(),
    completed_at: TimestampSchema.nullable(),
    artifact_evidence_ids: z.array(IdSchema),
    result_note: TextSchema,
  })
  .strict()
  .superRefine((stage, ctx) => {
    if (stage.status === "completed" && (stage.started_at === null || stage.completed_at === null || stage.artifact_evidence_ids.length === 0)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "completed 阶段必须包含起止时间和至少一项产物证据" });
    }
    if (stage.started_at !== null && stage.completed_at !== null && Date.parse(stage.completed_at) < Date.parse(stage.started_at)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["completed_at"], message: "完成时间不得早于开始时间" });
    }
  });

export const RequirementMeasurementSchema = z
  .object({
    requirement_id: IdSchema,
    observed_value: z.number().finite(),
    measured_at: TimestampSchema,
    evidence_ids: z.array(IdSchema).min(1),
  })
  .strict();

export const AcceptanceTestResultSchema = z
  .object({
    test_id: IdSchema,
    status: z.enum(["passed", "failed", "blocked", "not_run"]),
    executed_at: TimestampSchema,
    evidence_ids: z.array(IdSchema).min(1),
    result_note: TextSchema,
  })
  .strict();

export const ResidualRiskAcceptanceSchema = z
  .object({
    accepted_by: TextSchema,
    accepted_at: TimestampSchema,
    rationale: RationaleSchema,
    review_due: TimestampSchema,
  })
  .strict();

export const ResidualRiskResultSchema = z
  .object({
    risk_id: IdSchema,
    residual_level: z.enum(RISK_LEVELS),
    disposition: z.enum(["mitigated", "accepted", "open"]),
    acceptance: ResidualRiskAcceptanceSchema.nullable(),
    evidence_ids: z.array(IdSchema).min(1),
  })
  .strict()
  .superRefine((risk, ctx) => {
    if (risk.disposition === "accepted" && risk.acceptance === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["acceptance"], message: "accepted 残余风险必须包含正式接受记录" });
    }
    if (risk.disposition !== "accepted" && risk.acceptance !== null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["acceptance"], message: "非 accepted 残余风险不得携带接受记录" });
    }
  });

export const AcceptanceEvaluationSchema = z
  .object({
    schema_version: z.literal(ACCEPTANCE_SCHEMA_VERSION),
    report_id: IdSchema,
    evaluation_id: IdSchema,
    baseline_id: IdSchema,
    baseline_version: SemVerSchema,
    evaluated_at: TimestampSchema,
    report_generated_at: TimestampSchema,
    evaluator: z
      .object({
        name: TextSchema,
        organization: TextSchema,
        role: TextSchema,
        independent: z.boolean(),
      })
      .strict(),
    stage_results: z.array(EvaluationStageResultSchema).length(ISO_25040_STAGES.length),
    evidence: z.array(AcceptanceEvidenceSchema).min(1),
    measurements: z.array(RequirementMeasurementSchema).min(1),
    test_results: z.array(AcceptanceTestResultSchema).min(1),
    residual_risks: z.array(ResidualRiskResultSchema).min(1),
  })
  .strict()
  .superRefine((evaluation, ctx) => {
    addDuplicateIssues(evaluation.stage_results.map((item) => item.stage), "stage_results", ctx);
    addDuplicateIssues(evaluation.evidence.map((item) => item.id), "evidence", ctx);
    addDuplicateIssues(evaluation.measurements.map((item) => item.requirement_id), "measurements", ctx);
    addDuplicateIssues(evaluation.test_results.map((item) => item.test_id), "test_results", ctx);
    addDuplicateIssues(evaluation.residual_risks.map((item) => item.risk_id), "residual_risks", ctx);
    requireExactEnumSet(evaluation.stage_results.map((item) => item.stage), ISO_25040_STAGES, "stage_results", ctx);
    if (Date.parse(evaluation.report_generated_at) < Date.parse(evaluation.evaluated_at)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["report_generated_at"], message: "报告生成时间不得早于评价时间" });
    }
  });

export type QualityCharacteristic = z.infer<typeof QualityCharacteristicSchema>;
export type QualityRequirement = z.infer<typeof QualityRequirementSchema>;
export type AcceptanceRisk = z.infer<typeof AcceptanceRiskSchema>;
export type AcceptanceTest = z.infer<typeof AcceptanceTestSchema>;
export type MachineAssertion = z.infer<typeof MachineAssertionSchema>;
export type AcceptanceBaseline = z.infer<typeof AcceptanceBaselineSchema>;
export type AcceptanceBaselineInput = z.input<typeof AcceptanceBaselineSchema>;
export type AcceptanceEvidence = z.infer<typeof AcceptanceEvidenceSchema>;
export type AcceptanceEvaluation = z.infer<typeof AcceptanceEvaluationSchema>;
export type AcceptanceEvaluationInput = z.input<typeof AcceptanceEvaluationSchema>;
export type ResidualRiskResult = z.infer<typeof ResidualRiskResultSchema>;

function safeSegment(value: string): string {
  return IdSchema.parse(value);
}

export function acceptanceBaselinePath(root: string, baselineId: string, baselineVersion: string): string {
  return pmPath(path.resolve(root), "acceptance", "baselines", safeSegment(baselineId), `${SemVerSchema.parse(baselineVersion)}.json`);
}

export function loadAcceptanceBaseline(root: string, baselineId: string, baselineVersion: string): AcceptanceBaseline {
  const file = acceptanceBaselinePath(root, baselineId, baselineVersion);
  const value = loadJson(file, AcceptanceBaselineSchema);
  if (value === undefined) throw new Error(`验收基线不存在：${file}`);
  return value;
}

/**
 * Draft baselines can be refined. Once approved, the same ID/version is
 * immutable; changes require a new semantic version.
 */
export function saveAcceptanceBaseline(root: string, input: AcceptanceBaselineInput): AcceptanceBaseline {
  const parsed = AcceptanceBaselineSchema.parse(input);
  return withLedgerLock(path.resolve(root), () => {
    const file = acceptanceBaselinePath(root, parsed.baseline_id, parsed.baseline_version);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const existing = loadJson(file, AcceptanceBaselineSchema);
    if (existing?.approval.status === "approved") {
      const before = JSON.stringify(existing);
      const after = JSON.stringify(parsed);
      if (before !== after) {
        throw new Error(`已批准验收基线不可覆盖：${parsed.baseline_id}@${parsed.baseline_version}；请创建新版本。`);
      }
      return existing;
    }
    saveJson(file, parsed);
    return parsed;
  });
}
