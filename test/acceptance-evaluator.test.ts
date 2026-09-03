import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import {
  ACCEPTANCE_SCHEMA_VERSION,
  AcceptanceBaselineSchema,
  AcceptanceEvaluationSchema,
  ISO_25010_CHARACTERISTICS,
  ISO_25040_STAGES,
  acceptanceBaselinePath,
  loadAcceptanceBaseline,
  saveAcceptanceBaseline,
  type AcceptanceBaselineInput,
  type AcceptanceEvaluationInput,
} from "../src/acceptance-model.ts";
import { acceptanceBaselineFingerprint, evaluateAcceptance } from "../src/acceptance-evaluator.ts";
import {
  AcceptanceReportSchema,
  AcceptanceReportManifestSchema,
  acceptanceReportPaths,
  renderAcceptanceReportMarkdown,
  writeAcceptanceReport,
} from "../src/acceptance-report.ts";
import { mkProj } from "./helpers.ts";

const HASHES = {
  stage: "1".repeat(64),
  test: "2".repeat(64),
  measure: "3".repeat(64),
  risk: "4".repeat(64),
};

function baseline(status: "draft" | "approved" = "approved"): AcceptanceBaselineInput {
  return {
    schema_version: ACCEPTANCE_SCHEMA_VERSION,
    baseline_id: "pm-mcp-quality",
    baseline_version: "1.0.0",
    title: "PM MCP release acceptance baseline",
    product: "pm-mcp",
    scope: "Local stdio MCP release on the declared platform and workload",
    created_at: "2026-01-01T00:00:00.000Z",
    approval: status === "approved"
      ? { status, approved_by: "quality-board", approved_at: "2026-01-01T01:00:00.000Z", rationale: "Approved before execution by the quality board" }
      : { status, approved_by: null, approved_at: null, rationale: null },
    characteristics: ISO_25010_CHARACTERISTICS.map((id, index) => index === 0
      ? { id, applicable: true, tailoring_reason: null }
      : { id, applicable: false, tailoring_reason: `Not applicable to this explicitly bounded release scope: ${id}` }),
    requirements: [{
      id: "QR-001",
      characteristic: "functional_suitability",
      statement: "All required acceptance scenarios must pass",
      metric: { name: "acceptance pass rate", unit: "percent", direction: "at_least", threshold: 100, tolerance: 0 },
      measurement_source: { evidence_id: "EV-MEASURE", json_pointer: "/metrics/pass_rate" },
      risk_ids: ["R-001"],
      test_ids: ["AT-001"],
    }],
    risks: [{
      id: "R-001",
      title: "Required scenario fails",
      description: "A declared product scenario may not deliver the specified result",
      owner: "risk-owner",
      likelihood: "possible",
      impact: "major",
      inherent_level: "high",
      treatment: "Run the acceptance suite and retain integrity-bound evidence",
      compensating_controls: ["Independent evidence review"],
      requirement_ids: ["QR-001"],
      test_ids: ["AT-001"],
    }],
    tests: [{
      id: "AT-001",
      title: "Required scenario acceptance suite",
      procedure: "Execute the frozen acceptance suite against the declared release candidate",
      expected_result: "Every required scenario passes without skipped checks",
      expected_evidence_kind: "test_result",
      verification_mode: "automated",
      assertion: { evidence_id: "EV-TEST", json_pointer: "/tests/required", operator: "equal", expected: true },
      requirement_ids: ["QR-001"],
      risk_ids: ["R-001"],
    }],
    evaluation_plan: ISO_25040_STAGES.map((stage) => ({
      stage,
      owner: `owner-${stage}`,
      objective: `Complete and evidence the ${stage} stage`,
      entry_criteria: [`Approved entry criteria for ${stage}`],
      activities: [`Perform controlled ${stage} activities`],
      planned_outputs: [`Signed ${stage} evaluation artifact`],
      exit_criteria: [`Reviewed exit criteria for ${stage}`],
    })),
    acceptance_policy: {
      require_all_requirements: true,
      require_all_tests: true,
      require_all_stages: true,
      require_independent_evaluator: true,
      maximum_residual_risk_level: "medium",
      authorized_risk_acceptors: ["risk-owner"],
    },
  };
}

function evaluation(): AcceptanceEvaluationInput {
  return {
    schema_version: ACCEPTANCE_SCHEMA_VERSION,
    report_id: "AR-2026-001",
    evaluation_id: "EV-2026-001",
    baseline_id: "pm-mcp-quality",
    baseline_version: "1.0.0",
    evaluated_at: "2026-01-03T00:00:00.000Z",
    report_generated_at: "2026-01-04T00:00:00.000Z",
    evaluator: { name: "independent-evaluator", organization: "quality-lab", role: "lead evaluator", independent: true },
    stage_results: ISO_25040_STAGES.map((stage) => ({
      stage,
      status: "completed" as const,
      started_at: "2026-01-02T00:00:00.000Z",
      completed_at: "2026-01-02T01:00:00.000Z",
      artifact_evidence_ids: ["EV-STAGE"],
      result_note: `${stage} stage completed and reviewed`,
    })),
    evidence: [
      { id: "EV-STAGE", kind: "review", locator: "evidence/stages.json", captured_at: "2026-01-02T02:00:00.000Z", sha256: HASHES.stage, produced_by: "quality-lab", summary: "Stage review bundle" },
      { id: "EV-TEST", kind: "test_result", locator: "evidence/test.xml", captured_at: "2026-01-02T02:00:00.000Z", sha256: HASHES.test, produced_by: "test-runner", summary: "Acceptance test result" },
      { id: "EV-MEASURE", kind: "measurement", locator: "evidence/measure.json", captured_at: "2026-01-02T02:00:00.000Z", sha256: HASHES.measure, produced_by: "quality-lab", summary: "Quantitative measurement result" },
      { id: "EV-RISK", kind: "audit", locator: "evidence/risk.json", captured_at: "2026-01-02T02:00:00.000Z", sha256: HASHES.risk, produced_by: "risk-reviewer", summary: "Residual risk assessment" },
    ],
    measurements: [{ requirement_id: "QR-001", observed_value: 100, measured_at: "2026-01-02T03:00:00.000Z", evidence_ids: ["EV-MEASURE"] }],
    test_results: [{ test_id: "AT-001", status: "passed", executed_at: "2026-01-02T03:00:00.000Z", evidence_ids: ["EV-TEST"], result_note: "All required scenarios passed" }],
    residual_risks: [{ risk_id: "R-001", residual_level: "low", disposition: "mitigated", acceptance: null, evidence_ids: ["EV-RISK"] }],
  };
}

test("验收 schema 强制九特性、五阶段、量化阈值和双向追踪", () => {
  const valid = AcceptanceBaselineSchema.parse(baseline());
  assert.equal(valid.characteristics.length, 9);
  assert.deepEqual(valid.evaluation_plan.map((item) => item.stage), ISO_25040_STAGES);
  assert.equal(valid.requirements[0].metric.threshold, 100);

  const missingCharacteristic = structuredClone(baseline()) as any;
  missingCharacteristic.characteristics.pop();
  assert.equal(AcceptanceBaselineSchema.safeParse(missingCharacteristic).success, false);

  const noTailoringReason = structuredClone(baseline()) as any;
  noTailoringReason.characteristics[1].tailoring_reason = null;
  assert.equal(AcceptanceBaselineSchema.safeParse(noTailoringReason).success, false);

  const brokenReverseTrace = structuredClone(baseline()) as any;
  brokenReverseTrace.risks[0].requirement_ids = ["QR-OTHER"];
  const broken = AcceptanceBaselineSchema.safeParse(brokenReverseTrace);
  assert.equal(broken.success, false);
  assert.ok(!broken.success && broken.error.issues.some((issue) => issue.message.includes("反向追踪") || issue.message.includes("未知 requirement")));

  const unknownField = { ...baseline(), invented_acceptance: true };
  assert.equal(AcceptanceBaselineSchema.safeParse(unknownField).success, false);

  const missingRiskOwner = structuredClone(baseline()) as any;
  delete missingRiskOwner.risks[0].owner;
  assert.equal(AcceptanceBaselineSchema.safeParse(missingRiskOwner).success, false);
  const noCompensatingControl = structuredClone(baseline()) as any;
  noCompensatingControl.risks[0].compensating_controls = [];
  assert.equal(AcceptanceBaselineSchema.safeParse(noCompensatingControl).success, false);

  const manual = structuredClone(baseline()) as any;
  manual.tests[0].verification_mode = "manual";
  manual.tests[0].assertion = null;
  manual.tests[0].expected_evidence_kind = "review";
  assert.equal(AcceptanceBaselineSchema.safeParse(manual).success, true);
  manual.tests[0].expected_evidence_kind = "test_result";
  assert.equal(AcceptanceBaselineSchema.safeParse(manual).success, false);

  const omittedMode = structuredClone(baseline()) as any;
  delete omittedMode.tests[0].verification_mode;
  delete omittedMode.tests[0].assertion;
  assert.equal(AcceptanceBaselineSchema.safeParse(omittedMode).success, false, "默认 automated 不得退化为无断言人工 PASS");
});

test("草稿可修订；批准后同 ID/版本不可篡改并需升版", () => {
  const root = mkProj();
  const draft = saveAcceptanceBaseline(root, baseline("draft"));
  assert.equal(draft.approval.status, "draft");
  assert.equal(acceptanceBaselinePath(root, draft.baseline_id, draft.baseline_version).endsWith("1.0.0.json"), true);

  const approved = saveAcceptanceBaseline(root, baseline("approved"));
  assert.deepEqual(loadAcceptanceBaseline(root, approved.baseline_id, approved.baseline_version), approved);
  assert.deepEqual(saveAcceptanceBaseline(root, baseline("approved")), approved, "相同内容应幂等");

  const tampered = structuredClone(baseline("approved"));
  tampered.scope = "Changed after approval";
  assert.throws(() => saveAcceptanceBaseline(root, tampered), /已批准验收基线不可覆盖.*创建新版本/);
});

test("完整证据链生成确定性通过报告，并落盘正式 JSON 与 Markdown", () => {
  const root = mkProj();
  const inputBaseline = baseline();
  const inputEvaluation = evaluation();
  const first = evaluateAcceptance(inputBaseline, inputEvaluation);
  const second = evaluateAcceptance(structuredClone(inputBaseline), structuredClone(inputEvaluation));
  assert.deepEqual(second, first);
  assert.equal(first.verdict, "accepted");
  assert.equal(first.summary.accepted_characteristics, 1);
  assert.equal(first.summary.requirements_passed, 1);
  assert.equal(first.summary.tests_passed, 1);
  assert.equal(first.summary.risks_controlled, 1);
  assert.equal(first.summary.stages_completed, 5);
  assert.equal(first.baseline.fingerprint_sha256, acceptanceBaselineFingerprint(inputBaseline));
  assert.equal(first.baseline.fingerprint_sha256.length, 64);
  assert.deepEqual(AcceptanceReportSchema.parse(first), first);

  const malformedReport = structuredClone(first);
  malformedReport.stage_results[1].stage = "define";
  assert.equal(AcceptanceReportSchema.safeParse(malformedReport).success, false);
  const missingTrace = structuredClone(first);
  missingTrace.traceability_matrix = [];
  assert.equal(AcceptanceReportSchema.safeParse(missingTrace).success, false);

  const markdown = renderAcceptanceReportMarkdown(first);
  assert.match(markdown, /ISO\/IEC 25040 阶段记录/);
  assert.match(markdown, /需求—风险—测试—证据追踪矩阵/);
  assert.match(markdown, /验收测试与冻结断言/);
  assert.match(markdown, /EV-TEST#\/tests\/required equal true/);
  assert.match(markdown, /risk-owner.*possible.*major.*Independent evidence review/);
  assert.match(markdown, /最终结论：\*\*通过\*\*/);

  const expected = acceptanceReportPaths(root, first.report_id);
  const files = writeAcceptanceReport(root, first);
  assert.deepEqual(files, expected);
  assert.equal(fs.existsSync(files.json_file), true);
  assert.equal(fs.existsSync(files.markdown_file), true);
  assert.equal(fs.existsSync(files.manifest_file), true);
  assert.deepEqual(AcceptanceReportSchema.parse(JSON.parse(fs.readFileSync(files.json_file, "utf8"))), first);
  assert.equal(fs.readFileSync(files.markdown_file, "utf8"), markdown);
  const manifest = AcceptanceReportManifestSchema.parse(JSON.parse(fs.readFileSync(files.manifest_file, "utf8")));
  assert.equal(manifest.report_id, first.report_id);
  assert.equal(manifest.generated_at, first.report_generated_at);
  assert.equal(manifest.json_sha256, createHash("sha256").update(fs.readFileSync(files.json_file)).digest("hex"));
  assert.equal(manifest.markdown_sha256, createHash("sha256").update(fs.readFileSync(files.markdown_file)).digest("hex"));

  const altered = structuredClone(first);
  altered.conclusion = "A different conclusion must use another report ID.";
  assert.throws(() => writeAcceptanceReport(root, altered), /正式验收报告不可覆盖.*新的 report_id/);
  fs.rmSync(files.manifest_file);
  assert.throws(() => writeAcceptanceReport(root, first), /不可覆盖或修补/);
});

test("未预批、阶段阻塞、阈值失败、测试失败和开放风险全部 fail-closed", () => {
  const draft = baseline("draft");
  const failed = structuredClone(evaluation()) as any;
  failed.stage_results[2] = {
    stage: "plan",
    status: "blocked",
    started_at: "2026-01-02T00:00:00.000Z",
    completed_at: null,
    artifact_evidence_ids: [],
    result_note: "Plan approval was blocked",
  };
  failed.measurements[0].observed_value = 99;
  failed.test_results[0].status = "failed";
  failed.residual_risks[0] = { risk_id: "R-001", residual_level: "high", disposition: "open", acceptance: null, evidence_ids: ["EV-RISK"] };

  const report = evaluateAcceptance(draft, failed);
  assert.equal(report.verdict, "rejected");
  const codes = new Set(report.findings.map((item) => item.code));
  for (const code of [
    "BASELINE_NOT_APPROVED",
    "EVALUATION_STAGE_INCOMPLETE",
    "QUALITY_THRESHOLD_NOT_MET",
    "TEST_NOT_PASSED",
    "RESIDUAL_RISK_ABOVE_LIMIT",
    "RESIDUAL_RISK_OPEN",
  ]) assert.ok(codes.has(code), `missing ${code}`);
  assert.ok(report.summary.errors >= 6);
});

test("正式残余风险接受必须有授权、未过期且不超过预批上限", () => {
  const acceptedInput = structuredClone(evaluation()) as any;
  acceptedInput.residual_risks[0] = {
    risk_id: "R-001",
    residual_level: "medium",
    disposition: "accepted",
    acceptance: {
      accepted_by: "risk-owner",
      accepted_at: "2026-01-02T04:00:00.000Z",
      rationale: "Business owner accepts the bounded residual impact",
      review_due: "2027-01-01T00:00:00.000Z",
    },
    evidence_ids: ["EV-RISK"],
  };
  assert.equal(evaluateAcceptance(baseline(), acceptedInput).verdict, "accepted");

  const unauthorized = structuredClone(acceptedInput);
  unauthorized.residual_risks[0].acceptance.accepted_by = "unlisted-owner";
  const unauthorizedReport = evaluateAcceptance(baseline(), unauthorized);
  assert.equal(unauthorizedReport.verdict, "rejected");
  assert.ok(unauthorizedReport.findings.some((item) => item.code === "RISK_ACCEPTOR_UNAUTHORIZED"));

  const expired = structuredClone(acceptedInput);
  expired.residual_risks[0].acceptance.review_due = "2026-01-03T12:00:00.000Z";
  assert.ok(evaluateAcceptance(baseline(), expired).findings.some((item) => item.code === "RISK_ACCEPTANCE_EXPIRED"));

  const malformed = structuredClone(acceptedInput);
  malformed.residual_risks[0].acceptance = null;
  assert.equal(AcceptanceEvaluationSchema.safeParse(malformed).success, false);
});

test("未来时间证据或执行结果不能计入通过结果", () => {
  const futureEvidence = structuredClone(evaluation()) as any;
  futureEvidence.evidence.find((item: any) => item.id === "EV-TEST").captured_at = "2027-01-01T00:00:00.000Z";
  const evidenceReport = evaluateAcceptance(baseline(), futureEvidence);
  assert.equal(evidenceReport.verdict, "rejected");
  assert.equal(evidenceReport.test_results[0].passed, false);
  assert.ok(evidenceReport.findings.some((item) => item.code === "EVIDENCE_FROM_FUTURE"));

  const futureMeasurement = structuredClone(evaluation()) as any;
  futureMeasurement.measurements[0].measured_at = "2027-01-01T00:00:00.000Z";
  const measurementReport = evaluateAcceptance(baseline(), futureMeasurement);
  assert.equal(measurementReport.requirement_results[0].passed, false);
  assert.ok(measurementReport.findings.some((item) => item.code === "MEASUREMENT_AFTER_EVALUATION"));
});

test("基线必须在 execute 阶段开始前批准", () => {
  const late = structuredClone(baseline()) as any;
  late.approval.approved_at = "2026-01-02T00:00:00.001Z";
  const report = evaluateAcceptance(late, evaluation());
  assert.equal(report.verdict, "rejected");
  assert.ok(report.findings.some((item) => item.code === "BASELINE_APPROVED_AFTER_EXECUTION_STARTED"));

  const equalToStart = structuredClone(baseline()) as any;
  equalToStart.approval.approved_at = "2026-01-02T00:00:00.000Z";
  assert.equal(evaluateAcceptance(equalToStart, evaluation()).verdict, "accepted", "批准时间等于执行开始时间允许通过");
});
