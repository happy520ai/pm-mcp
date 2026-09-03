import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  ACCEPTANCE_SCHEMA_VERSION,
  AcceptanceEvaluationSchema,
  ISO_25010_CHARACTERISTICS,
  ISO_25040_STAGES,
  type AcceptanceBaselineInput,
  type AcceptanceEvaluationInput,
} from "../src/acceptance-model.ts";
import { acceptanceBaselineFingerprint } from "../src/acceptance-evaluator.ts";
import {
  approveAcceptanceBaseline,
  evaluateAcceptanceFile,
  listAcceptanceBaselines,
  registerAcceptanceTools,
  resolveAcceptanceFile,
  resolveJsonPointer,
  saveDraftAcceptanceBaselineFile,
  sha256AcceptanceFile,
  verifyEvaluationEvidence,
} from "../src/acceptance-tools.ts";
import { mkProj, initTestProject, writeRel } from "./helpers.ts";

function draftBaseline(scope = "Bounded release scope"): AcceptanceBaselineInput {
  return {
    schema_version: ACCEPTANCE_SCHEMA_VERSION,
    baseline_id: "release",
    baseline_version: "1.0.0",
    title: "Release quality baseline",
    product: "fixture",
    scope,
    created_at: "2026-01-01T00:00:00.000Z",
    approval: { status: "draft", approved_by: null, approved_at: null, rationale: null },
    characteristics: ISO_25010_CHARACTERISTICS.map((id, index) => index === 0
      ? { id, applicable: true, tailoring_reason: null }
      : { id, applicable: false, tailoring_reason: `Excluded from this bounded fixture because ${id} is outside scope` }),
    requirements: [{ id: "QR-1", characteristic: "functional_suitability", statement: "Required behavior passes", metric: { name: "pass rate", unit: "percent", direction: "at_least", threshold: 100, tolerance: 0 }, measurement_source: { evidence_id: "E-METRIC", json_pointer: "/metrics/pass_rate" }, risk_ids: ["R-1"], test_ids: ["AT-1"] }],
    risks: [{ id: "R-1", title: "Behavior failure", description: "Required behavior could fail", owner: "risk-owner", likelihood: "possible", impact: "major", inherent_level: "high", treatment: "Execute acceptance evidence", compensating_controls: ["Independent evidence review"], requirement_ids: ["QR-1"], test_ids: ["AT-1"] }],
    tests: [{ id: "AT-1", title: "Acceptance test", procedure: "Execute the frozen scenario", expected_result: "Scenario passes", expected_evidence_kind: "test_result", verification_mode: "automated", assertion: { evidence_id: "E-TEST", json_pointer: "/tests/pass", operator: "equal", expected: true }, requirement_ids: ["QR-1"], risk_ids: ["R-1"] }],
    evaluation_plan: ISO_25040_STAGES.map((stage) => ({ stage, owner: `owner-${stage}`, objective: `Evaluate ${stage}`, entry_criteria: [`Entry ${stage}`], activities: [`Activity ${stage}`], planned_outputs: [`Output ${stage}`], exit_criteria: [`Exit ${stage}`] })),
    acceptance_policy: { require_all_requirements: true, require_all_tests: true, require_all_stages: true, require_independent_evaluator: true, maximum_residual_risk_level: "medium", authorized_risk_acceptors: ["risk-owner"] },
  };
}

function evaluation(sha256: string): AcceptanceEvaluationInput {
  const locator = ".pm/acceptance/evidence/proof.bin";
  return {
    schema_version: ACCEPTANCE_SCHEMA_VERSION,
    report_id: "REPORT-1",
    evaluation_id: "EVAL-1",
    baseline_id: "release",
    baseline_version: "1.0.0",
    evaluated_at: "2026-01-03T00:00:00.000Z",
    report_generated_at: "2026-01-04T00:00:00.000Z",
    evaluator: { name: "evaluator", organization: "lab", role: "lead", independent: true },
    stage_results: ISO_25040_STAGES.map((stage) => ({ stage, status: "completed", started_at: "2026-01-02T00:00:00.000Z", completed_at: "2026-01-02T01:00:00.000Z", artifact_evidence_ids: ["E-STAGE"], result_note: `${stage} completed` })),
    evidence: [
      { id: "E-STAGE", kind: "review", locator, captured_at: "2026-01-02T02:00:00.000Z", sha256, produced_by: "lab", summary: "Stage evidence" },
      { id: "E-TEST", kind: "test_result", locator, captured_at: "2026-01-02T02:00:00.000Z", sha256, produced_by: "runner", summary: "Test evidence" },
      { id: "E-METRIC", kind: "measurement", locator, captured_at: "2026-01-02T02:00:00.000Z", sha256, produced_by: "lab", summary: "Metric evidence" },
      { id: "E-RISK", kind: "audit", locator, captured_at: "2026-01-02T02:00:00.000Z", sha256, produced_by: "reviewer", summary: "Risk evidence" },
    ],
    measurements: [{ requirement_id: "QR-1", observed_value: 100, measured_at: "2026-01-02T03:00:00.000Z", evidence_ids: ["E-METRIC"] }],
    test_results: [{ test_id: "AT-1", status: "passed", executed_at: "2026-01-02T03:00:00.000Z", evidence_ids: ["E-TEST"], result_note: "Passed" }],
    residual_risks: [{ risk_id: "R-1", residual_level: "low", disposition: "mitigated", acceptance: null, evidence_ids: ["E-RISK"] }],
  };
}

function setup(): { root: string; source: string; evidenceFile: string } {
  const root = mkProj({ "src/index.ts": "export const ok = true;\n" });
  initTestProject(root);
  const source = ".pm/acceptance/inbox/baseline.json";
  const evidenceFile = path.join(root, ".pm", "acceptance", "evidence", "proof.bin");
  writeRel(root, source, JSON.stringify(draftBaseline(), null, 2));
  writeRel(root, ".pm/acceptance/evidence/proof.bin", JSON.stringify({ metrics: { pass_rate: 100 }, tests: { pass: true }, array: [7] }) + "\n");
  return { root, source, evidenceFile };
}

test("路径边界拒绝目录穿越、项目外文件、目录和非 JSON 输入", () => {
  const { root, source } = setup();
  assert.equal(resolveAcceptanceFile(root, source, true).endsWith("baseline.json"), true);
  assert.throws(() => resolveAcceptanceFile(root, "outside.json", true), /必须位于项目内/);
  assert.throws(() => resolveAcceptanceFile(root, path.join(root, "src/index.ts"), false), /必须位于项目内/);
  assert.throws(() => resolveAcceptanceFile(root, ".pm/acceptance/inbox", false), /普通文件/);
  assert.throws(() => resolveAcceptanceFile(root, ".pm/acceptance/evidence/proof.bin", true), /只允许读取 JSON/);
});

test("draft 保存和 fingerprint 绑定审批为原子流程，内容变化必须重新审阅", () => {
  const { root, source } = setup();
  const first = saveDraftAcceptanceBaselineFile(root, source);
  const staleFingerprint = acceptanceBaselineFingerprint(first);

  writeRel(root, source, JSON.stringify(draftBaseline("Changed bounded release scope"), null, 2));
  const changed = saveDraftAcceptanceBaselineFile(root, source);
  assert.notEqual(acceptanceBaselineFingerprint(changed), staleFingerprint);
  assert.throws(() => approveAcceptanceBaseline(root, {
    baseline_id: "release", baseline_version: "1.0.0", expected_fingerprint_sha256: staleFingerprint,
    approved_by: "quality-board", approval_rationale: "Reviewed and formally approved", approved_at: "2026-01-01T01:00:00.000Z",
  }), /fingerprint 已变化/);

  const approved = approveAcceptanceBaseline(root, {
    baseline_id: "release", baseline_version: "1.0.0", expected_fingerprint_sha256: acceptanceBaselineFingerprint(changed),
    approved_by: "quality-board", approval_rationale: "Reviewed and formally approved", approved_at: "2026-01-01T01:00:00.000Z",
  });
  assert.equal(approved.approval.status, "approved");
  assert.equal(listAcceptanceBaselines(root)[0].status, "approved");
  assert.throws(() => approveAcceptanceBaseline(root, {
    baseline_id: "release", baseline_version: "1.0.0", expected_fingerprint_sha256: acceptanceBaselineFingerprint(approved),
    approved_by: "quality-board", approval_rationale: "Attempted duplicate approval",
  }), /只有 draft 基线可批准/);
});

test("evaluate 集成层复算证据摘要后生成正式报告，摘要变化、缺失和手填字段均拒绝", () => {
  const { root, source, evidenceFile } = setup();
  const draft = saveDraftAcceptanceBaselineFile(root, source);
  approveAcceptanceBaseline(root, {
    baseline_id: "release", baseline_version: "1.0.0", expected_fingerprint_sha256: acceptanceBaselineFingerprint(draft),
    approved_by: "quality-board", approval_rationale: "Reviewed and formally approved", approved_at: "2026-01-01T01:00:00.000Z",
  });
  const sha256 = sha256AcceptanceFile(evidenceFile);
  const validEvaluation = AcceptanceEvaluationSchema.parse(evaluation(sha256));
  writeRel(root, ".pm/acceptance/evaluations/eval.json", JSON.stringify(validEvaluation, null, 2));
  verifyEvaluationEvidence(root, validEvaluation);
  const result = evaluateAcceptanceFile(root, { baseline_id: "release", baseline_version: "1.0.0", evaluation_file: ".pm/acceptance/evaluations/eval.json" });
  assert.equal(result.report.verdict, "accepted");
  assert.equal(fs.existsSync(result.json_file), true);
  assert.equal(fs.existsSync(result.markdown_file), true);
  assert.equal(fs.existsSync(result.manifest_file), true);
  assert.match(fs.readFileSync(path.join(root, "PROJECT.md"), "utf8"), /\| 标准化验收 \| ✅/);

  fs.appendFileSync(evidenceFile, "tampered\n", "utf8");
  assert.throws(() => evaluateAcceptanceFile(root, { baseline_id: "release", baseline_version: "1.0.0", evaluation_file: ".pm/acceptance/evaluations/eval.json" }), /证据摘要不一致/);

  const handFilled = { ...evaluation(sha256), verdict: "accepted" };
  writeRel(root, ".pm/acceptance/evaluations/hand-filled.json", JSON.stringify(handFilled));
  assert.throws(() => evaluateAcceptanceFile(root, { baseline_id: "release", baseline_version: "1.0.0", evaluation_file: ".pm/acceptance/evaluations/hand-filled.json" }), /数据校验失败/);
});

test("伪造 observed_value 或测试 PASS 无法覆盖冻结的机器证据", () => {
  const first = setup();
  const firstDraft = saveDraftAcceptanceBaselineFile(first.root, first.source);
  approveAcceptanceBaseline(first.root, {
    baseline_id: "release", baseline_version: "1.0.0", expected_fingerprint_sha256: acceptanceBaselineFingerprint(firstDraft),
    approved_by: "quality-board", approval_rationale: "Reviewed and formally approved", approved_at: "2026-01-01T01:00:00.000Z",
  });
  writeRel(first.root, ".pm/acceptance/evidence/proof.bin", JSON.stringify({ metrics: { pass_rate: 42 }, tests: { pass: true } }));
  const firstSha = sha256AcceptanceFile(first.evidenceFile);
  writeRel(first.root, ".pm/acceptance/evaluations/forged-measurement.json", JSON.stringify(evaluation(firstSha)));
  assert.throws(() => evaluateAcceptanceFile(first.root, {
    baseline_id: "release", baseline_version: "1.0.0", evaluation_file: ".pm/acceptance/evaluations/forged-measurement.json",
  }), /伪造或过期测量值.*填写 100.*实际 42/);

  const second = setup();
  const secondDraft = saveDraftAcceptanceBaselineFile(second.root, second.source);
  approveAcceptanceBaseline(second.root, {
    baseline_id: "release", baseline_version: "1.0.0", expected_fingerprint_sha256: acceptanceBaselineFingerprint(secondDraft),
    approved_by: "quality-board", approval_rationale: "Reviewed and formally approved", approved_at: "2026-01-01T01:00:00.000Z",
  });
  writeRel(second.root, ".pm/acceptance/evidence/proof.bin", JSON.stringify({ metrics: { pass_rate: 100 }, tests: { pass: false } }));
  const secondSha = sha256AcceptanceFile(second.evidenceFile);
  writeRel(second.root, ".pm/acceptance/evaluations/forged-pass.json", JSON.stringify(evaluation(secondSha)));
  assert.throws(() => evaluateAcceptanceFile(second.root, {
    baseline_id: "release", baseline_version: "1.0.0", evaluation_file: ".pm/acceptance/evaluations/forged-pass.json",
  }), /伪造或不一致测试状态.*填写 passed.*结果为 failed/);
});

test("安全 RFC 6901 解析拒绝原型字段、缺失字段、数组越界和非 JSON 机器证据", () => {
  assert.equal(resolveJsonPointer({ "a/b": { "~key": [7] } }, "/a~1b/~0key/0"), 7);
  assert.throws(() => resolveJsonPointer({}, "/__proto__"), /禁止字段/);
  assert.throws(() => resolveJsonPointer({}, "/constructor"), /禁止字段/);
  assert.throws(() => resolveJsonPointer({}, "/prototype"), /禁止字段/);
  assert.throws(() => resolveJsonPointer({ array: [1] }, "/array/1"), /数组越界/);
  assert.throws(() => resolveJsonPointer({ array: [1] }, "/array/01"), /数组索引非法/);
  assert.throws(() => resolveJsonPointer({}, "/missing"), /字段不存在/);
  assert.throws(() => resolveJsonPointer({}, "not-a-pointer"), /RFC 6901/);

  const fixture = setup();
  const draft = saveDraftAcceptanceBaselineFile(fixture.root, fixture.source);
  approveAcceptanceBaseline(fixture.root, {
    baseline_id: "release", baseline_version: "1.0.0", expected_fingerprint_sha256: acceptanceBaselineFingerprint(draft),
    approved_by: "quality-board", approval_rationale: "Reviewed and formally approved", approved_at: "2026-01-01T01:00:00.000Z",
  });
  writeRel(fixture.root, ".pm/acceptance/evidence/proof.bin", "not JSON");
  const sha = sha256AcceptanceFile(fixture.evidenceFile);
  writeRel(fixture.root, ".pm/acceptance/evaluations/non-json.json", JSON.stringify(evaluation(sha)));
  assert.throws(() => evaluateAcceptanceFile(fixture.root, {
    baseline_id: "release", baseline_version: "1.0.0", evaluation_file: ".pm/acceptance/evaluations/non-json.json",
  }), /机器断言证据不是合法 JSON/);
});

test("MCP 注册面包含基线读取、列表、草稿保存、批准和正式评价", () => {
  const names: string[] = [];
  const fake = { registerTool(name: string): void { names.push(name); } } as unknown as McpServer;
  registerAcceptanceTools(fake, "C:\\unused");
  assert.deepEqual(names.sort(), [
    "approve_acceptance_baseline",
    "evaluate_acceptance",
    "get_acceptance_baseline",
    "list_acceptance_baselines",
    "save_acceptance_baseline_draft",
  ]);
});
