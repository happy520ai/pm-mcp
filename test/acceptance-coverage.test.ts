import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  ACCEPTANCE_SCHEMA_VERSION,
  AcceptanceBaselineSchema,
  AcceptanceEvaluationSchema,
  BaselineApprovalSchema,
  EvaluationStageResultSchema,
  ISO_25010_CHARACTERISTICS,
  ISO_25040_STAGES,
  MachineAssertionSchema,
  ResidualRiskResultSchema,
  saveAcceptanceBaseline,
  type AcceptanceBaselineInput,
  type AcceptanceEvaluationInput,
} from "../src/acceptance-model.ts";
import { acceptanceBaselineFingerprint, evaluateAcceptance } from "../src/acceptance-evaluator.ts";
import { AcceptanceReportSchema, renderAcceptanceReportMarkdown, writeAcceptanceReport } from "../src/acceptance-report.ts";
import {
  approveAcceptanceBaseline,
  evaluateAcceptanceFile,
  listAcceptanceBaselines,
  registerAcceptanceTools,
  resolveJsonPointer,
  saveDraftAcceptanceBaselineFile,
  sha256AcceptanceFile,
  verifyFrozenAcceptanceAssertions,
} from "../src/acceptance-tools.ts";
import { initTestProject, mkProj, writeRel } from "./helpers.ts";

function baseline(status: "approved" | "draft" = "approved", version = "1.0.0"): AcceptanceBaselineInput {
  return {
    schema_version: ACCEPTANCE_SCHEMA_VERSION,
    baseline_id: "coverage", baseline_version: version, title: "Coverage baseline", product: "fixture", scope: "Acceptance branch coverage",
    created_at: "2026-01-01T00:00:00.000Z",
    approval: status === "approved"
      ? { status, approved_by: "board", approved_at: "2026-01-01T01:00:00.000Z", rationale: "Approved before controlled execution" }
      : { status, approved_by: null, approved_at: null, rationale: null },
    characteristics: ISO_25010_CHARACTERISTICS.map((id, index) => index === 0 ? { id, applicable: true, tailoring_reason: null } : { id, applicable: false, tailoring_reason: `${id} is outside this bounded test scope` }),
    requirements: [{ id: "QR", characteristic: "functional_suitability", statement: "Quality value satisfies threshold", metric: { name: "score", unit: "percent", direction: "at_least", threshold: 90, tolerance: 0 }, measurement_source: { evidence_id: "E-METRIC", json_pointer: "/metric" }, risk_ids: ["R"], test_ids: ["AT"] }],
    risks: [{ id: "R", title: "Quality failure", description: "Measured quality could fail", owner: "risk-owner", likelihood: "possible", impact: "major", inherent_level: "high", treatment: "Verify frozen evidence", compensating_controls: ["Independent review"], requirement_ids: ["QR"], test_ids: ["AT"] }],
    tests: [{ id: "AT", title: "Machine test", procedure: "Read frozen result", expected_result: "Result is true", expected_evidence_kind: "test_result", verification_mode: "automated", assertion: { evidence_id: "E-TEST", json_pointer: "/passed", operator: "equal", expected: true }, requirement_ids: ["QR"], risk_ids: ["R"] }],
    evaluation_plan: ISO_25040_STAGES.map((stage) => ({ stage, owner: `owner-${stage}`, objective: `Evaluate ${stage}`, entry_criteria: [`Enter ${stage}`], activities: [`Perform ${stage}`], planned_outputs: [`Output ${stage}`], exit_criteria: [`Exit ${stage}`] })),
    acceptance_policy: { require_all_requirements: true, require_all_tests: true, require_all_stages: true, require_independent_evaluator: true, maximum_residual_risk_level: "medium", authorized_risk_acceptors: ["risk-owner"] },
  };
}

function evaluation(sha = "a".repeat(64), reportId = "COVERAGE-REPORT"): AcceptanceEvaluationInput {
  const locator = ".pm/acceptance/evidence/result.json";
  return {
    schema_version: ACCEPTANCE_SCHEMA_VERSION, report_id: reportId, evaluation_id: `EV-${reportId}`, baseline_id: "coverage", baseline_version: "1.0.0",
    evaluated_at: "2026-01-03T00:00:00.000Z", report_generated_at: "2026-01-04T00:00:00.000Z",
    evaluator: { name: "evaluator", organization: "lab", role: "lead", independent: true },
    stage_results: ISO_25040_STAGES.map((stage) => ({ stage, status: "completed", started_at: "2026-01-02T00:00:00.000Z", completed_at: "2026-01-02T01:00:00.000Z", artifact_evidence_ids: ["E-STAGE"], result_note: `${stage} complete` })),
    evidence: [
      { id: "E-STAGE", kind: "review", locator, captured_at: "2026-01-02T02:00:00.000Z", sha256: sha, produced_by: "lab", summary: "Stage proof" },
      { id: "E-METRIC", kind: "measurement", locator, captured_at: "2026-01-02T02:00:00.000Z", sha256: sha, produced_by: "lab", summary: "Metric proof" },
      { id: "E-TEST", kind: "test_result", locator, captured_at: "2026-01-02T02:00:00.000Z", sha256: sha, produced_by: "runner", summary: "Test proof" },
      { id: "E-RISK", kind: "audit", locator, captured_at: "2026-01-02T02:00:00.000Z", sha256: sha, produced_by: "reviewer", summary: "Risk proof" },
    ],
    measurements: [{ requirement_id: "QR", observed_value: 95, measured_at: "2026-01-02T03:00:00.000Z", evidence_ids: ["E-METRIC"] }],
    test_results: [{ test_id: "AT", status: "passed", executed_at: "2026-01-02T03:00:00.000Z", evidence_ids: ["E-TEST"], result_note: "Machine assertion passed" }],
    residual_risks: [{ risk_id: "R", residual_level: "low", disposition: "mitigated", acceptance: null, evidence_ids: ["E-RISK"] }],
  };
}

function invalidBaseline(mutator: (value: any) => void): void {
  const value = structuredClone(baseline()) as any;
  mutator(value);
  assert.equal(AcceptanceBaselineSchema.safeParse(value).success, false);
}

test("schema fail-closed 分支覆盖重复、断链、裁剪、审批和阶段时序", () => {
  assert.equal(MachineAssertionSchema.safeParse({ evidence_id: "E", json_pointer: "/x", operator: "at_least", expected: "90" }).success, false);
  invalidBaseline((v) => { v.characteristics[0].tailoring_reason = "Cannot coexist with applicable true"; });
  assert.equal(BaselineApprovalSchema.safeParse({ status: "approved", approved_by: null, approved_at: null, rationale: null }).success, false);
  assert.equal(BaselineApprovalSchema.safeParse({ status: "draft", approved_by: "x", approved_at: "2026-01-01T00:00:00.000Z", rationale: null }).success, false);
  invalidBaseline((v) => { v.requirements.push(structuredClone(v.requirements[0])); });
  invalidBaseline((v) => { v.requirements[0].risk_ids.push("R"); });
  invalidBaseline((v) => { v.characteristics[1].applicable = true; v.characteristics[1].tailoring_reason = null; });
  invalidBaseline((v) => { v.characteristics[0].applicable = false; v.characteristics[0].tailoring_reason = "Explicitly excluded for this negative test"; });
  invalidBaseline((v) => { v.requirements[0].risk_ids = ["UNKNOWN"]; });
  invalidBaseline((v) => { v.requirements[0].test_ids = ["UNKNOWN"]; });
  invalidBaseline((v) => { v.risks[0].requirement_ids = ["UNKNOWN"]; });
  invalidBaseline((v) => { v.risks[0].test_ids = ["UNKNOWN"]; });
  invalidBaseline((v) => { v.tests[0].requirement_ids = ["UNKNOWN"]; });
  invalidBaseline((v) => { v.tests[0].risk_ids = ["UNKNOWN"]; });
  invalidBaseline((v) => { v.evaluation_plan[1].stage = "define"; });
  assert.equal(EvaluationStageResultSchema.safeParse({ stage: "define", status: "completed", started_at: null, completed_at: null, artifact_evidence_ids: [], result_note: "Incomplete" }).success, false);
  assert.equal(EvaluationStageResultSchema.safeParse({ stage: "define", status: "completed", started_at: "2026-01-02T02:00:00.000Z", completed_at: "2026-01-02T01:00:00.000Z", artifact_evidence_ids: ["E"], result_note: "Reverse time" }).success, false);
  assert.equal(ResidualRiskResultSchema.safeParse({ risk_id: "R", residual_level: "low", disposition: "mitigated", acceptance: { accepted_by: "x", accepted_at: "2026-01-01T00:00:00.000Z", rationale: "Long enough rationale", review_due: "2027-01-01T00:00:00.000Z" }, evidence_ids: ["E"] }).success, false);
  const badEvaluation = structuredClone(evaluation()) as any;
  badEvaluation.evidence.push(structuredClone(badEvaluation.evidence[0]));
  badEvaluation.report_generated_at = "2026-01-02T00:00:00.000Z";
  assert.equal(AcceptanceEvaluationSchema.safeParse(badEvaluation).success, false);
});

test("evaluator 覆盖阈值方向、身份错配、未知项、缺失项和未引用证据", () => {
  for (const [direction, threshold, observed] of [["at_most", 100, 95], ["equal", 95, 95.5]] as const) {
    const b = structuredClone(baseline()) as any;
    b.requirements[0].metric = { ...b.requirements[0].metric, direction, threshold, tolerance: 0.5 };
    const e = structuredClone(evaluation()) as any;
    e.measurements[0].observed_value = observed;
    const directionalReport = evaluateAcceptance(b, e);
    assert.equal(directionalReport.verdict, "accepted");
    assert.match(renderAcceptanceReportMarkdown(directionalReport), direction === "at_most" ? /<= 100/ : /= 95/);
  }

  const mismatched = structuredClone(evaluation()) as any;
  mismatched.baseline_id = "other";
  mismatched.baseline_version = "2.0.0";
  mismatched.evaluator.independent = false;
  mismatched.evidence.push({ ...structuredClone(mismatched.evidence[0]), id: "UNUSED" });
  mismatched.stage_results[0].completed_at = "2026-01-03T12:00:00.000Z";
  const mismatchReport = evaluateAcceptance(baseline(), mismatched);
  assert.match(renderAcceptanceReportMarkdown(mismatchReport), /UNREFERENCED_EVIDENCE/);
  const mismatchCodes = new Set(mismatchReport.findings.map((item) => item.code));
  for (const code of ["BASELINE_ID_MISMATCH", "BASELINE_VERSION_MISMATCH", "EVALUATOR_NOT_INDEPENDENT", "STAGE_COMPLETED_AFTER_EVALUATION", "UNREFERENCED_EVIDENCE"]) assert.ok(mismatchCodes.has(code));

  const missingEvidence = structuredClone(evaluation()) as any;
  missingEvidence.stage_results[0].artifact_evidence_ids = ["MISSING"];
  assert.ok(evaluateAcceptance(baseline(), missingEvidence).findings.some((item) => item.code === "EVIDENCE_NOT_FOUND"));

  const missingEverything = structuredClone(evaluation()) as any;
  missingEverything.test_results = [{ ...missingEverything.test_results[0], test_id: "UNKNOWN" }];
  missingEverything.measurements = [{ ...missingEverything.measurements[0], requirement_id: "UNKNOWN" }];
  missingEverything.residual_risks = [{ ...missingEverything.residual_risks[0], risk_id: "UNKNOWN" }];
  const missingReport = evaluateAcceptance(baseline(), missingEverything);
  assert.match(renderAcceptanceReportMarkdown(missingReport), /实测.*—/s);
  const missingCodes = new Set(missingReport.findings.map((item) => item.code));
  for (const code of ["UNKNOWN_TEST_RESULT", "TEST_RESULT_MISSING", "UNKNOWN_REQUIREMENT_MEASUREMENT", "REQUIREMENT_MEASUREMENT_MISSING", "UNKNOWN_RESIDUAL_RISK", "RESIDUAL_RISK_MISSING"]) assert.ok(missingCodes.has(code));

  const wrongTestEvidence = structuredClone(evaluation()) as any;
  wrongTestEvidence.test_results[0].evidence_ids = ["E-METRIC"];
  const wrongReport = evaluateAcceptance(baseline(), wrongTestEvidence);
  assert.ok(wrongReport.findings.some((item) => item.code === "TEST_EVIDENCE_KIND_MISMATCH"));
  assert.ok(wrongReport.findings.some((item) => item.code === "TEST_ASSERTION_EVIDENCE_MISSING"));

  const noExecuteStart = structuredClone(evaluation()) as any;
  noExecuteStart.stage_results.find((item: any) => item.stage === "execute").status = "blocked";
  noExecuteStart.stage_results.find((item: any) => item.stage === "execute").started_at = null;
  noExecuteStart.stage_results.find((item: any) => item.stage === "execute").completed_at = null;
  noExecuteStart.stage_results.find((item: any) => item.stage === "execute").artifact_evidence_ids = [];
  assert.ok(evaluateAcceptance(baseline(), noExecuteStart).findings.some((item) => item.code === "EXECUTE_START_TIME_MISSING"));

  const manualBaseline = structuredClone(baseline()) as any;
  manualBaseline.tests[0].verification_mode = "manual";
  manualBaseline.tests[0].assertion = null;
  manualBaseline.tests[0].expected_evidence_kind = "review";
  const manualEvaluation = structuredClone(evaluation()) as any;
  manualEvaluation.evidence.find((item: any) => item.id === "E-TEST").kind = "review";
  const manualReport = evaluateAcceptance(manualBaseline, manualEvaluation);
  assert.match(renderAcceptanceReportMarkdown(manualReport), /manual.*人工评价/);
});

test("report schema 拒绝伪造汇总和与错误发现项矛盾的 verdict", () => {
  const report = evaluateAcceptance(baseline(), evaluation());
  const badSummary = structuredClone(report);
  badSummary.summary.tests_passed = 0;
  assert.equal(AcceptanceReportSchema.safeParse(badSummary).success, false);
  const badVerdict = structuredClone(report);
  badVerdict.verdict = "rejected";
  assert.equal(AcceptanceReportSchema.safeParse(badVerdict).success, false);
});

function projectFixture(): { root: string; sha: string } {
  const root = mkProj({ "src/index.ts": "export const ok = true;\n" });
  initTestProject(root);
  writeRel(root, ".pm/acceptance/evidence/result.json", JSON.stringify({ metric: 95, passed: true, low: 5, text: "ok" }));
  const sha = sha256AcceptanceFile(path.join(root, ".pm", "acceptance", "evidence", "result.json"));
  return { root, sha };
}

test("机器断言覆盖数字上下界、不等、空指针及各种缺失输入", () => {
  const { root, sha } = projectFixture();
  const base = AcceptanceBaselineSchema.parse(baseline());
  const evalData = AcceptanceEvaluationSchema.parse(evaluation(sha));
  assert.deepEqual(resolveJsonPointer({ root: true }, ""), { root: true });
  assert.throws(() => resolveJsonPointer({ value: 1 }, "/value/next"), /无法继续解析/);

  for (const [operator, pointer, expected] of [["at_least", "/metric", 90], ["at_most", "/low", 10], ["not_equal", "/text", "bad"]] as const) {
    const b = structuredClone(base) as any;
    b.tests[0].assertion = { evidence_id: "E-TEST", json_pointer: pointer, operator, expected };
    verifyFrozenAcceptanceAssertions(root, AcceptanceBaselineSchema.parse(b), evalData);
  }
  const nonNumeric = structuredClone(base) as any;
  nonNumeric.tests[0].assertion = { evidence_id: "E-TEST", json_pointer: "/text", operator: "at_least", expected: 1 };
  assert.throws(() => verifyFrozenAcceptanceAssertions(root, AcceptanceBaselineSchema.parse(nonNumeric), evalData), /必须是有限数字/);
  const nonNumericMeasurement = structuredClone(base) as any;
  nonNumericMeasurement.requirements[0].measurement_source.json_pointer = "/text";
  assert.throws(() => verifyFrozenAcceptanceAssertions(root, AcceptanceBaselineSchema.parse(nonNumericMeasurement), evalData), /测量源.*不是有限数字/);

  const wrongDigest = structuredClone(evalData) as any;
  wrongDigest.evidence.find((item: any) => item.id === "E-METRIC").sha256 = "f".repeat(64);
  assert.throws(() => verifyFrozenAcceptanceAssertions(root, base, AcceptanceEvaluationSchema.parse(wrongDigest)), /证据摘要不一致/);

  const missingEvidence = structuredClone(base) as any;
  missingEvidence.requirements[0].measurement_source.evidence_id = "ABSENT";
  const missingEvidenceEvaluation = structuredClone(evalData) as any;
  missingEvidenceEvaluation.measurements[0].evidence_ids = ["ABSENT"];
  assert.throws(() => verifyFrozenAcceptanceAssertions(root, AcceptanceBaselineSchema.parse(missingEvidence), AcceptanceEvaluationSchema.parse(missingEvidenceEvaluation)), /冻结的机器证据不存在/);
  const noMeasurement = structuredClone(evalData) as any;
  noMeasurement.measurements = [{ ...noMeasurement.measurements[0], requirement_id: "OTHER" }];
  assert.throws(() => verifyFrozenAcceptanceAssertions(root, base, AcceptanceEvaluationSchema.parse(noMeasurement)), /缺少基线需求的测量结果/);
  const noSourceRef = structuredClone(evalData) as any;
  noSourceRef.measurements[0].evidence_ids = ["E-TEST"];
  assert.throws(() => verifyFrozenAcceptanceAssertions(root, base, AcceptanceEvaluationSchema.parse(noSourceRef)), /未引用冻结证据/);
  const coreNoSourceRef = structuredClone(evalData) as any;
  coreNoSourceRef.measurements[0].evidence_ids = ["E-TEST"];
  assert.ok(evaluateAcceptance(base, AcceptanceEvaluationSchema.parse(coreNoSourceRef)).findings.some((item) => item.code === "MEASUREMENT_SOURCE_EVIDENCE_MISSING"));
  const noTest = structuredClone(evalData) as any;
  noTest.test_results = [{ ...noTest.test_results[0], test_id: "OTHER" }];
  assert.throws(() => verifyFrozenAcceptanceAssertions(root, base, AcceptanceEvaluationSchema.parse(noTest)), /缺少基线测试结果/);
  const noAssertionRef = structuredClone(evalData) as any;
  noAssertionRef.test_results[0].evidence_ids = ["E-METRIC"];
  assert.throws(() => verifyFrozenAcceptanceAssertions(root, base, AcceptanceEvaluationSchema.parse(noAssertionRef)), /未引用冻结断言证据/);
});

test("工具边界覆盖空列表、非 draft 保存、批准时序和报告三件套冲突", () => {
  const { root, sha } = projectFixture();
  assert.deepEqual(listAcceptanceBaselines(root), []);
  writeRel(root, ".pm/acceptance/inbox/approved.json", JSON.stringify(baseline(), null, 2));
  assert.throws(() => saveDraftAcceptanceBaselineFile(root, ".pm/acceptance/inbox/approved.json"), /只接受.*draft/);
  const draft = baseline("draft");
  saveAcceptanceBaseline(root, draft);
  assert.throws(() => approveAcceptanceBaseline(root, { baseline_id: "coverage", baseline_version: "1.0.0", expected_fingerprint_sha256: acceptanceBaselineFingerprint(draft), approved_by: "board", approval_rationale: "Approval time is invalid", approved_at: "2025-01-01T00:00:00.000Z" }), /批准时间不得早于/);

  const approved = { ...draft, approval: { status: "approved" as const, approved_by: "board", approved_at: "2026-01-01T01:00:00.000Z", rationale: "Approved after complete review" } };
  saveAcceptanceBaseline(root, approved);
  writeRel(root, ".pm/acceptance/evaluations/eval.json", JSON.stringify(evaluation(sha), null, 2));
  const result = evaluateAcceptanceFile(root, { baseline_id: "coverage", baseline_version: "1.0.0", evaluation_file: ".pm/acceptance/evaluations/eval.json" });
  fs.writeFileSync(result.markdown_file, "tampered", "utf8");
  assert.throws(() => writeAcceptanceReport(root, result.report), /不可覆盖或修补/);
});

test("五个 MCP handler 均执行真实成功或错误路径", async () => {
  const { root, sha } = projectFixture();
  saveAcceptanceBaseline(root, baseline());
  writeRel(root, ".pm/acceptance/evaluations/mcp.json", JSON.stringify(evaluation(sha, "MCP-REPORT"), null, 2));
  const draftV2 = baseline("draft", "2.0.0");
  writeRel(root, ".pm/acceptance/inbox/v2.json", JSON.stringify(draftV2, null, 2));
  const handlers = new Map<string, (args: any) => any>();
  const fake = { registerTool(name: string, _config: unknown, handler: (args: any) => any): void { handlers.set(name, handler); } } as unknown as McpServer;
  registerAcceptanceTools(fake, root);
  const invoke = async (name: string, args: any = {}): Promise<any> => handlers.get(name)!(args);
  assert.match(JSON.stringify(await invoke("list_acceptance_baselines")), /coverage/);
  assert.match(JSON.stringify(await invoke("get_acceptance_baseline", { baseline_id: "coverage", baseline_version: "1.0.0" })), /fingerprint/);
  assert.match(JSON.stringify(await invoke("get_acceptance_baseline", { baseline_id: "coverage", baseline_version: "1.0.0", full: true })), /requirements/);
  assert.match(JSON.stringify(await invoke("save_acceptance_baseline_draft", { baseline_file: ".pm/acceptance/inbox/v2.json" })), /draft/);
  const fingerprint = acceptanceBaselineFingerprint(AcceptanceBaselineSchema.parse(draftV2));
  assert.match(JSON.stringify(await invoke("approve_acceptance_baseline", { baseline_id: "coverage", baseline_version: "2.0.0", expected_fingerprint_sha256: fingerprint, approved_by: "board", approval_rationale: "Approved through MCP coverage test", approved_at: "2026-01-01T01:00:00.000Z" })), /已批准/);
  assert.match(JSON.stringify(await invoke("evaluate_acceptance", { baseline_id: "coverage", baseline_version: "1.0.0", evaluation_file: ".pm/acceptance/evaluations/mcp.json" })), /PASS/);
});
