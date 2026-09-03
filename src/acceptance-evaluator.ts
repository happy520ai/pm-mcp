import { createHash } from "node:crypto";
import {
  ACCEPTANCE_SCHEMA_VERSION,
  AcceptanceBaselineSchema,
  AcceptanceEvaluationSchema,
  ISO_25010_CHARACTERISTICS,
  ISO_25040_STAGES,
  RISK_LEVELS,
  type AcceptanceBaselineInput,
  type AcceptanceEvaluationInput,
} from "./acceptance-model.ts";
import {
  ACCEPTANCE_STANDARD_BASIS,
  AcceptanceReportSchema,
  type AcceptanceFinding,
  type AcceptanceReport,
} from "./acceptance-report.ts";

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareText);
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort(compareText).map((key) => [key, canonicalize(record[key])]));
  }
  return value;
}

export function acceptanceBaselineFingerprint(input: AcceptanceBaselineInput): string {
  const baseline = AcceptanceBaselineSchema.parse(input);
  return createHash("sha256").update(JSON.stringify(canonicalize(baseline)), "utf8").digest("hex");
}

function metricPassed(
  observed: number,
  metric: { direction: "at_least" | "at_most" | "equal"; threshold: number; tolerance: number },
): boolean {
  if (metric.direction === "at_least") return observed >= metric.threshold;
  if (metric.direction === "at_most") return observed <= metric.threshold;
  return Math.abs(observed - metric.threshold) <= metric.tolerance;
}

export function evaluateAcceptance(
  baselineInput: AcceptanceBaselineInput,
  evaluationInput: AcceptanceEvaluationInput,
): AcceptanceReport {
  // Parsing is deliberately first: malformed acceptance data cannot be turned
  // into a plausible-looking report.
  const baseline = AcceptanceBaselineSchema.parse(baselineInput);
  const evaluation = AcceptanceEvaluationSchema.parse(evaluationInput);
  const findings: AcceptanceFinding[] = [];
  const addError = (code: string, subject: string, message: string): void => {
    findings.push({ code, severity: "error", subject, message });
  };
  const addWarning = (code: string, subject: string, message: string): void => {
    findings.push({ code, severity: "warning", subject, message });
  };

  if (baseline.approval.status !== "approved") {
    addError("BASELINE_NOT_APPROVED", `${baseline.baseline_id}@${baseline.baseline_version}`, `质量基线状态为 ${baseline.approval.status}；只有预先批准的基线可以通过验收。`);
  } else if (baseline.approval.approved_at) {
    const executeStartedAt = evaluation.stage_results.find((item) => item.stage === "execute")?.started_at;
    if (executeStartedAt === null || executeStartedAt === undefined) {
      addError("EXECUTE_START_TIME_MISSING", "execute", "execute 阶段缺少开始时间，无法证明基线在执行前获批。");
    } else if (Date.parse(baseline.approval.approved_at) > Date.parse(executeStartedAt)) {
      addError("BASELINE_APPROVED_AFTER_EXECUTION_STARTED", baseline.baseline_id, "基线批准时间晚于 execute 阶段开始时间，不能作为预先批准的验收条件。");
    }
  }
  if (evaluation.baseline_id !== baseline.baseline_id) {
    addError("BASELINE_ID_MISMATCH", evaluation.baseline_id, `评价引用 ${evaluation.baseline_id}，实际基线为 ${baseline.baseline_id}。`);
  }
  if (evaluation.baseline_version !== baseline.baseline_version) {
    addError("BASELINE_VERSION_MISMATCH", evaluation.baseline_version, `评价引用 ${evaluation.baseline_version}，实际基线版本为 ${baseline.baseline_version}。`);
  }
  if (baseline.acceptance_policy.require_independent_evaluator && !evaluation.evaluator.independent) {
    addError("EVALUATOR_NOT_INDEPENDENT", evaluation.evaluator.name, "基线要求独立评价，但评价人被标记为非独立。");
  }

  const evidenceById = new Map(evaluation.evidence.map((item) => [item.id, item]));
  const referencedEvidence = new Set<string>();
  const validEvidence = (ids: readonly string[], subject: string): boolean => {
    let ok = true;
    for (const id of ids) {
      referencedEvidence.add(id);
      const evidence = evidenceById.get(id);
      if (!evidence) {
        addError("EVIDENCE_NOT_FOUND", subject, `引用的证据 "${id}" 不存在。`);
        ok = false;
      } else if (Date.parse(evidence.captured_at) > Date.parse(evaluation.report_generated_at)) {
        ok = false;
      }
    }
    return ok;
  };

  for (const evidence of evaluation.evidence) {
    if (Date.parse(evidence.captured_at) > Date.parse(evaluation.report_generated_at)) {
      addError("EVIDENCE_FROM_FUTURE", evidence.id, "证据采集时间晚于报告生成时间。");
    }
  }

  const stageByName = new Map(evaluation.stage_results.map((item) => [item.stage, item]));
  const stageResults = ISO_25040_STAGES.map((stage) => {
    const result = stageByName.get(stage)!;
    const evidenceOk = validEvidence(result.artifact_evidence_ids, `stage:${stage}`);
    const timeOk = result.completed_at === null || Date.parse(result.completed_at) <= Date.parse(evaluation.evaluated_at);
    const passed = result.status === "completed" && evidenceOk && timeOk;
    if (result.status !== "completed") {
      addError("EVALUATION_STAGE_INCOMPLETE", stage, `ISO/IEC 25040 阶段 ${stage} 状态为 ${result.status}。`);
    }
    if (result.completed_at && Date.parse(result.completed_at) > Date.parse(evaluation.evaluated_at)) {
      addError("STAGE_COMPLETED_AFTER_EVALUATION", stage, "阶段完成时间晚于评价时间。");
    }
    return {
      stage,
      status: result.status,
      passed,
      evidence_ids: sortedUnique(result.artifact_evidence_ids),
      result_note: result.result_note,
    };
  });

  const testDefinitionById = new Map(baseline.tests.map((item) => [item.id, item]));
  const testResultById = new Map(evaluation.test_results.map((item) => [item.test_id, item]));
  for (const result of evaluation.test_results) {
    if (!testDefinitionById.has(result.test_id)) addError("UNKNOWN_TEST_RESULT", result.test_id, "评价结果引用了基线未定义的测试。");
    if (Date.parse(result.executed_at) > Date.parse(evaluation.evaluated_at)) addError("TEST_EXECUTED_AFTER_EVALUATION", result.test_id, "测试执行时间晚于评价时间。");
  }
  const testResults = [...baseline.tests].sort((a, b) => compareText(a.id, b.id)).map((definition) => {
    const result = testResultById.get(definition.id);
    if (!result) {
      addError("TEST_RESULT_MISSING", definition.id, "缺少基线要求的测试结果。");
      return { id: definition.id, status: "missing" as const, verification_mode: definition.verification_mode, assertion: definition.assertion, passed: false, evidence_ids: [] };
    }
    const evidenceOk = validEvidence(result.evidence_ids, `test:${definition.id}`);
    const matchingKind = result.evidence_ids.some((id) => evidenceById.get(id)?.kind === definition.expected_evidence_kind);
    const assertionEvidenceOk = definition.verification_mode === "manual"
      || Boolean(definition.assertion && result.evidence_ids.includes(definition.assertion.evidence_id));
    const timeOk = Date.parse(result.executed_at) <= Date.parse(evaluation.evaluated_at);
    if (!matchingKind) {
      addError("TEST_EVIDENCE_KIND_MISMATCH", definition.id, `测试至少需要一项 ${definition.expected_evidence_kind} 类型证据。`);
    }
    if (!assertionEvidenceOk) {
      addError("TEST_ASSERTION_EVIDENCE_MISSING", definition.id, `测试结果未引用基线冻结的断言证据 ${definition.assertion?.evidence_id}。`);
    }
    if (result.status !== "passed") addError("TEST_NOT_PASSED", definition.id, `测试状态为 ${result.status}。`);
    return {
      id: definition.id,
      status: result.status,
      verification_mode: definition.verification_mode,
      assertion: definition.assertion,
      passed: result.status === "passed" && evidenceOk && matchingKind && assertionEvidenceOk && timeOk,
      evidence_ids: sortedUnique(result.evidence_ids),
    };
  });
  const evaluatedTestById = new Map(testResults.map((item) => [item.id, item]));

  const measurementByRequirement = new Map(evaluation.measurements.map((item) => [item.requirement_id, item]));
  const requirementDefinitionById = new Map(baseline.requirements.map((item) => [item.id, item]));
  for (const measurement of evaluation.measurements) {
    if (!requirementDefinitionById.has(measurement.requirement_id)) addError("UNKNOWN_REQUIREMENT_MEASUREMENT", measurement.requirement_id, "评价测量引用了基线未定义的需求。");
    if (Date.parse(measurement.measured_at) > Date.parse(evaluation.evaluated_at)) addError("MEASUREMENT_AFTER_EVALUATION", measurement.requirement_id, "测量时间晚于评价时间。");
  }
  const requirementResults = [...baseline.requirements].sort((a, b) => compareText(a.id, b.id)).map((requirement) => {
    const measurement = measurementByRequirement.get(requirement.id);
    if (!measurement) {
      addError("REQUIREMENT_MEASUREMENT_MISSING", requirement.id, "缺少量化需求实测值和证据。");
    }
    const evidenceOk = measurement ? validEvidence(measurement.evidence_ids, `requirement:${requirement.id}`) : false;
    const sourceEvidenceOk = Boolean(measurement?.evidence_ids.includes(requirement.measurement_source.evidence_id));
    if (measurement && !sourceEvidenceOk) {
      addError("MEASUREMENT_SOURCE_EVIDENCE_MISSING", requirement.id, `测量结果未引用基线冻结的数据源证据 ${requirement.measurement_source.evidence_id}。`);
    }
    const thresholdOk = measurement ? metricPassed(measurement.observed_value, requirement.metric) : false;
    const timeOk = measurement ? Date.parse(measurement.measured_at) <= Date.parse(evaluation.evaluated_at) : false;
    if (measurement && !thresholdOk) {
      addError("QUALITY_THRESHOLD_NOT_MET", requirement.id, `实测值 ${measurement.observed_value} 未达到 ${requirement.metric.direction} ${requirement.metric.threshold} ${requirement.metric.unit}。`);
    }
    const linkedTestsOk = requirement.test_ids.every((id) => evaluatedTestById.get(id)?.passed === true);
    if (!linkedTestsOk) addError("REQUIREMENT_TESTS_NOT_PASSED", requirement.id, "一个或多个关联验收测试未通过。");
    return {
      id: requirement.id,
      characteristic: requirement.characteristic,
      metric_name: requirement.metric.name,
      unit: requirement.metric.unit,
      direction: requirement.metric.direction,
      threshold: requirement.metric.threshold,
      tolerance: requirement.metric.tolerance,
      observed_value: measurement?.observed_value ?? null,
      measurement_source: requirement.measurement_source,
      passed: Boolean(measurement && evidenceOk && sourceEvidenceOk && thresholdOk && linkedTestsOk && timeOk),
      risk_ids: sortedUnique(requirement.risk_ids),
      test_ids: sortedUnique(requirement.test_ids),
      evidence_ids: sortedUnique(measurement?.evidence_ids ?? []),
    };
  });
  const evaluatedRequirementById = new Map(requirementResults.map((item) => [item.id, item]));

  const riskDefinitionById = new Map(baseline.risks.map((item) => [item.id, item]));
  const residualById = new Map(evaluation.residual_risks.map((item) => [item.risk_id, item]));
  for (const residual of evaluation.residual_risks) {
    if (!riskDefinitionById.has(residual.risk_id)) addError("UNKNOWN_RESIDUAL_RISK", residual.risk_id, "评价结果引用了基线未定义的风险。");
  }
  const maximumRisk = RISK_LEVELS.indexOf(baseline.acceptance_policy.maximum_residual_risk_level);
  const riskResults = [...baseline.risks].sort((a, b) => compareText(a.id, b.id)).map((risk) => {
    const residual = residualById.get(risk.id);
    if (!residual) {
      addError("RESIDUAL_RISK_MISSING", risk.id, "缺少残余风险评价。");
      return {
        id: risk.id,
        owner: risk.owner,
        likelihood: risk.likelihood,
        impact: risk.impact,
        inherent_level: risk.inherent_level,
        compensating_controls: risk.compensating_controls,
        residual_level: null,
        disposition: "missing" as const,
        accepted_by: null,
        evidence_ids: [],
        controlled: false,
      };
    }
    const evidenceOk = validEvidence(residual.evidence_ids, `risk:${risk.id}`);
    const levelOk = RISK_LEVELS.indexOf(residual.residual_level) <= maximumRisk;
    if (!levelOk) addError("RESIDUAL_RISK_ABOVE_LIMIT", risk.id, `残余风险 ${residual.residual_level} 超过基线允许上限 ${baseline.acceptance_policy.maximum_residual_risk_level}。`);
    if (residual.disposition === "open") addError("RESIDUAL_RISK_OPEN", risk.id, "残余风险仍处于 open 状态。");
    let acceptanceOk = true;
    if (residual.disposition === "accepted") {
      const acceptance = residual.acceptance!;
      acceptanceOk = baseline.acceptance_policy.authorized_risk_acceptors.includes(acceptance.accepted_by);
      if (!acceptanceOk) addError("RISK_ACCEPTOR_UNAUTHORIZED", risk.id, `接受人 "${acceptance.accepted_by}" 不在基线授权名单。`);
      if (Date.parse(acceptance.accepted_at) > Date.parse(evaluation.evaluated_at)) {
        acceptanceOk = false;
        addError("RISK_ACCEPTED_AFTER_EVALUATION", risk.id, "风险接受时间晚于评价时间。");
      }
      if (Date.parse(acceptance.review_due) < Date.parse(evaluation.report_generated_at)) {
        acceptanceOk = false;
        addError("RISK_ACCEPTANCE_EXPIRED", risk.id, "风险接受记录已过复审期限。");
      }
    }
    const linkedTestsOk = risk.test_ids.every((id) => evaluatedTestById.get(id)?.passed === true);
    const linkedRequirementsOk = risk.requirement_ids.every((id) => evaluatedRequirementById.get(id)?.passed === true);
    if (!linkedTestsOk || !linkedRequirementsOk) addError("RISK_CONTROLS_NOT_VERIFIED", risk.id, "风险关联的需求或测试尚未全部通过。");
    const controlled = residual.disposition !== "open" && evidenceOk && levelOk && acceptanceOk && linkedTestsOk && linkedRequirementsOk;
    return {
      id: risk.id,
      owner: risk.owner,
      likelihood: risk.likelihood,
      impact: risk.impact,
      inherent_level: risk.inherent_level,
      compensating_controls: risk.compensating_controls,
      residual_level: residual.residual_level,
      disposition: residual.disposition,
      accepted_by: residual.acceptance?.accepted_by ?? null,
      evidence_ids: sortedUnique(residual.evidence_ids),
      controlled,
    };
  });

  const traceabilityMatrix = [...baseline.requirements].sort((a, b) => compareText(a.id, b.id)).map((requirement) => {
    const measurement = measurementByRequirement.get(requirement.id);
    const testEvidence = requirement.test_ids.flatMap((id) => testResultById.get(id)?.evidence_ids ?? []);
    const riskEvidence = requirement.risk_ids.flatMap((id) => residualById.get(id)?.evidence_ids ?? []);
    const evidenceIds = sortedUnique([...(measurement?.evidence_ids ?? []), ...testEvidence, ...riskEvidence]);
    const complete = Boolean(
      measurement
      && requirement.test_ids.every((id) => evaluatedTestById.has(id))
      && requirement.risk_ids.every((id) => riskResults.some((risk) => risk.id === id && risk.controlled))
      && evidenceIds.length > 0
      && evidenceIds.every((id) => evidenceById.has(id)),
    );
    if (!complete) addError("TRACEABILITY_INCOMPLETE", requirement.id, "需求—风险—测试—证据追踪链未完整闭环。");
    return {
      requirement_id: requirement.id,
      risk_ids: sortedUnique(requirement.risk_ids),
      test_ids: sortedUnique(requirement.test_ids),
      evidence_ids: evidenceIds,
      complete,
    };
  });

  const characteristicResults = ISO_25010_CHARACTERISTICS.map((id) => {
    const characteristic = baseline.characteristics.find((item) => item.id === id)!;
    const requirementIds = baseline.requirements.filter((item) => item.characteristic === id).map((item) => item.id).sort(compareText);
    if (!characteristic.applicable) {
      return { id, status: "tailored_out" as const, requirement_ids: requirementIds, tailoring_reason: characteristic.tailoring_reason };
    }
    const accepted = requirementIds.every((requirementId) => evaluatedRequirementById.get(requirementId)?.passed === true);
    return { id, status: accepted ? "accepted" as const : "rejected" as const, requirement_ids: requirementIds, tailoring_reason: null };
  });

  for (const evidence of evaluation.evidence) {
    if (!referencedEvidence.has(evidence.id)) addWarning("UNREFERENCED_EVIDENCE", evidence.id, "证据未被阶段、需求、测试或风险结果引用。");
  }

  findings.sort((left, right) => compareText(`${left.severity}:${left.code}:${left.subject}:${left.message}`, `${right.severity}:${right.code}:${right.subject}:${right.message}`));
  const errors = findings.filter((finding) => finding.severity === "error").length;
  const warnings = findings.length - errors;
  const verdict = errors === 0 ? "accepted" as const : "rejected" as const;
  const report: AcceptanceReport = {
    schema_version: ACCEPTANCE_SCHEMA_VERSION,
    report_id: evaluation.report_id,
    evaluation_id: evaluation.evaluation_id,
    report_generated_at: evaluation.report_generated_at,
    product: baseline.product,
    scope: baseline.scope,
    baseline: {
      id: baseline.baseline_id,
      version: baseline.baseline_version,
      title: baseline.title,
      fingerprint_sha256: acceptanceBaselineFingerprint(baseline),
      approval: baseline.approval,
    },
    evaluator: evaluation.evaluator,
    standard_basis: [...ACCEPTANCE_STANDARD_BASIS],
    verdict,
    summary: {
      applicable_characteristics: characteristicResults.filter((item) => item.status !== "tailored_out").length,
      accepted_characteristics: characteristicResults.filter((item) => item.status === "accepted").length,
      requirements_total: requirementResults.length,
      requirements_passed: requirementResults.filter((item) => item.passed).length,
      tests_total: testResults.length,
      tests_passed: testResults.filter((item) => item.passed).length,
      risks_total: riskResults.length,
      risks_controlled: riskResults.filter((item) => item.controlled).length,
      stages_total: stageResults.length,
      stages_completed: stageResults.filter((item) => item.passed).length,
      errors,
      warnings,
    },
    stage_results: stageResults,
    characteristic_results: characteristicResults,
    requirement_results: requirementResults,
    test_results: testResults,
    risk_results: riskResults,
    traceability_matrix: traceabilityMatrix,
    findings,
    conclusion: verdict === "accepted"
      ? "本次评价所引用的预批准质量基线、量化需求、测试证据、双向追踪、残余风险处置及 ISO/IEC 25040 五阶段记录均满足既定准则，产品在本报告限定范围内通过验收。"
      : `本次评价存在 ${errors} 个阻断项，产品在本报告限定范围内不通过验收；关闭全部阻断项并重新执行评价后方可批准。`,
  };
  return AcceptanceReportSchema.parse(report);
}
