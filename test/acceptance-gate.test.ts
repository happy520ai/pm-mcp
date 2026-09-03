import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  ACCEPTANCE_SCHEMA_VERSION,
  ISO_25010_CHARACTERISTICS,
  ISO_25040_STAGES,
  saveAcceptanceBaseline,
  type AcceptanceBaselineInput,
  type AcceptanceEvaluationInput,
} from "../src/acceptance-model.ts";
import { sha256AcceptanceFile } from "../src/acceptance-tools.ts";
import { initTestProject, mkProj, writeRel } from "./helpers.ts";

const runner = path.resolve("scripts/acceptance-gate.mts");

function approvedBaseline(): AcceptanceBaselineInput {
  return {
    schema_version: ACCEPTANCE_SCHEMA_VERSION,
    baseline_id: "cli-release", baseline_version: "1.0.0", title: "CLI acceptance baseline", product: "fixture", scope: "CLI gate scope",
    created_at: "2026-01-01T00:00:00.000Z",
    approval: { status: "approved", approved_by: "board", approved_at: "2026-01-01T01:00:00.000Z", rationale: "Approved before controlled gate execution" },
    characteristics: ISO_25010_CHARACTERISTICS.map((id, index) => index === 0 ? { id, applicable: true, tailoring_reason: null } : { id, applicable: false, tailoring_reason: `${id} is excluded from this explicitly bounded CLI fixture` }),
    requirements: [{ id: "QR-CLI", characteristic: "functional_suitability", statement: "CLI acceptance succeeds", metric: { name: "pass rate", unit: "percent", direction: "at_least", threshold: 100, tolerance: 0 }, measurement_source: { evidence_id: "EV-METRIC", json_pointer: "/metrics/pass_rate" }, risk_ids: ["R-CLI"], test_ids: ["AT-CLI"] }],
    risks: [{ id: "R-CLI", title: "CLI failure", description: "CLI may accept an invalid result", owner: "risk-owner", likelihood: "possible", impact: "major", inherent_level: "high", treatment: "Execute fail-closed gate", compensating_controls: ["Independent evidence review"], requirement_ids: ["QR-CLI"], test_ids: ["AT-CLI"] }],
    tests: [{ id: "AT-CLI", title: "CLI gate test", procedure: "Run the controlled CLI scenario", expected_result: "Gate returns expected status", expected_evidence_kind: "test_result", verification_mode: "automated", assertion: { evidence_id: "EV-TEST", json_pointer: "/tests/pass", operator: "equal", expected: true }, requirement_ids: ["QR-CLI"], risk_ids: ["R-CLI"] }],
    evaluation_plan: ISO_25040_STAGES.map((stage) => ({ stage, owner: `owner-${stage}`, objective: `Evaluate ${stage}`, entry_criteria: [`Entry ${stage}`], activities: [`Activity ${stage}`], planned_outputs: [`Output ${stage}`], exit_criteria: [`Exit ${stage}`] })),
    acceptance_policy: { require_all_requirements: true, require_all_tests: true, require_all_stages: true, require_independent_evaluator: true, maximum_residual_risk_level: "medium", authorized_risk_acceptors: ["risk-owner"] },
  };
}

function evaluation(sha256: string, reportId: string, observedValue: number): AcceptanceEvaluationInput {
  const locator = ".pm/acceptance/evidence/proof.txt";
  return {
    schema_version: ACCEPTANCE_SCHEMA_VERSION,
    report_id: reportId, evaluation_id: `EVAL-${reportId}`, baseline_id: "cli-release", baseline_version: "1.0.0",
    evaluated_at: "2026-01-03T00:00:00.000Z", report_generated_at: "2026-01-04T00:00:00.000Z",
    evaluator: { name: "evaluator", organization: "lab", role: "lead", independent: true },
    stage_results: ISO_25040_STAGES.map((stage) => ({ stage, status: "completed", started_at: "2026-01-02T00:00:00.000Z", completed_at: "2026-01-02T01:00:00.000Z", artifact_evidence_ids: ["EV-STAGE"], result_note: `${stage} completed` })),
    evidence: [
      { id: "EV-STAGE", kind: "review", locator, captured_at: "2026-01-02T02:00:00.000Z", sha256, produced_by: "lab", summary: "Stage proof" },
      { id: "EV-TEST", kind: "test_result", locator, captured_at: "2026-01-02T02:00:00.000Z", sha256, produced_by: "runner", summary: "Test proof" },
      { id: "EV-METRIC", kind: "measurement", locator, captured_at: "2026-01-02T02:00:00.000Z", sha256, produced_by: "lab", summary: "Metric proof" },
      { id: "EV-RISK", kind: "audit", locator, captured_at: "2026-01-02T02:00:00.000Z", sha256, produced_by: "reviewer", summary: "Risk proof" },
    ],
    measurements: [{ requirement_id: "QR-CLI", observed_value: observedValue, measured_at: "2026-01-02T03:00:00.000Z", evidence_ids: ["EV-METRIC"] }],
    test_results: [{ test_id: "AT-CLI", status: "passed", executed_at: "2026-01-02T03:00:00.000Z", evidence_ids: ["EV-TEST"], result_note: "Passed" }],
    residual_risks: [{ risk_id: "R-CLI", residual_level: "low", disposition: "mitigated", acceptance: null, evidence_ids: ["EV-RISK"] }],
  };
}

function fixture(): { root: string; sha256: string } {
  const root = mkProj({ "src/index.ts": "export const ok = true;\n" });
  initTestProject(root);
  saveAcceptanceBaseline(root, approvedBaseline());
  writeRel(root, ".pm/acceptance/evidence/proof.txt", JSON.stringify({ metrics: { pass_rate: 100 }, tests: { pass: true } }) + "\n");
  return { root, sha256: sha256AcceptanceFile(path.join(root, ".pm", "acceptance", "evidence", "proof.txt")) };
}

function run(root: string, evaluationFile: string, extra: string[] = []): { code: number; output: string } {
  const result = spawnSync(process.execPath, [runner, "--root", root, "--baseline-id", "cli-release", "--baseline-version", "1.0.0", "--evaluation", evaluationFile, ...extra], { encoding: "utf8", timeout: 30_000 });
  return { code: result.status ?? -1, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

test("acceptance CLI 通过时退出 0 并生成正式双格式报告", () => {
  const { root, sha256 } = fixture();
  writeRel(root, ".pm/acceptance/evaluations/pass.json", JSON.stringify(evaluation(sha256, "CLI-PASS", 100), null, 2));
  const result = run(root, ".pm/acceptance/evaluations/pass.json");
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /\[acceptance-gate\] PASS/);
  assert.equal(fs.existsSync(path.join(root, ".pm", "acceptance", "reports", "CLI-PASS.json")), true);
  assert.equal(fs.existsSync(path.join(root, ".pm", "acceptance", "reports", "CLI-PASS.md")), true);
  assert.equal(fs.existsSync(path.join(root, ".pm", "acceptance", "reports", "CLI-PASS.sha256.json")), true);
  assert.match(result.output, /SHA256=.*CLI-PASS\.sha256\.json/);
});

test("acceptance CLI 以 evaluator verdict 决定失败退出码且保留失败报告", () => {
  const { root } = fixture();
  const evidenceFile = path.join(root, ".pm", "acceptance", "evidence", "proof.txt");
  writeRel(root, ".pm/acceptance/evidence/proof.txt", JSON.stringify({ metrics: { pass_rate: 99 }, tests: { pass: true } }) + "\n");
  const sha256 = sha256AcceptanceFile(evidenceFile);
  writeRel(root, ".pm/acceptance/evaluations/fail.json", JSON.stringify(evaluation(sha256, "CLI-FAIL", 99), null, 2));
  const result = run(root, ".pm/acceptance/evaluations/fail.json");
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /\[acceptance-gate\] FAIL/);
  const report = JSON.parse(fs.readFileSync(path.join(root, ".pm", "acceptance", "reports", "CLI-FAIL.json"), "utf8"));
  assert.equal(fs.existsSync(path.join(root, ".pm", "acceptance", "reports", "CLI-FAIL.sha256.json")), true);
  assert.equal(report.verdict, "rejected");
  assert.ok(report.findings.some((item: { code: string }) => item.code === "QUALITY_THRESHOLD_NOT_MET"));
});

test("acceptance CLI 对路径穿越、摘要不一致和缺少参数均退出 1", () => {
  const { root, sha256 } = fixture();
  writeRel(root, ".pm/acceptance/evaluations/digest.json", JSON.stringify(evaluation("f".repeat(64), "CLI-DIGEST", 100), null, 2));
  const digest = run(root, ".pm/acceptance/evaluations/digest.json");
  assert.equal(digest.code, 1);
  assert.match(digest.output, /证据摘要不一致/);

  writeRel(root, "outside.json", JSON.stringify(evaluation(sha256, "CLI-ESCAPE", 100)));
  const escaped = run(root, "outside.json");
  assert.equal(escaped.code, 1);
  assert.match(escaped.output, /必须位于项目内/);

  const missing = spawnSync(process.execPath, [runner, "--root", root], { encoding: "utf8", timeout: 30_000 });
  assert.equal(missing.status, 1);
  assert.match(`${missing.stdout ?? ""}${missing.stderr ?? ""}`, /必须提供/);
});
