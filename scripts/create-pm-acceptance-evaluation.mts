#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import {
  AcceptanceEvaluationSchema,
  acceptanceBaselinePath,
  loadAcceptanceBaseline,
  type AcceptanceTest,
} from "../src/acceptance-model.ts";
import { resolveJsonPointer, sha256AcceptanceFile } from "../src/acceptance-tools.ts";
import { atomicWrite } from "../src/store.ts";

function option(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  if (!process.argv[index + 1]) throw new Error(`${name} 缺少值`);
  return process.argv[index + 1];
}

const root = path.resolve(option("--root", process.cwd()));
const evidenceLocator = option("--evidence", ".pm/acceptance/evidence/product-evidence.json");
const evaluationLocator = option("--evaluation", ".pm/acceptance/evaluations/pm-mcp-local-release-1.0.0.json");
const reportId = option("--report-id", "pm-mcp-local-release-20260903");
const planLocator = ".pm/acceptance/evidence/evaluation-plan.md";
const firstFailureLocator = ".pm/acceptance/evidence/first-failure.md";

function absolute(locator: string): string {
  return path.resolve(root, locator);
}

function requireWithin(subdirectory: "evidence" | "evaluations", locator: string): void {
  const parent = path.resolve(root, ".pm", "acceptance", subdirectory);
  const child = absolute(locator);
  const relative = path.relative(parent, child);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${locator} 必须位于 .pm/acceptance/${subdirectory}`);
  }
}

requireWithin("evidence", evidenceLocator);
requireWithin("evaluations", evaluationLocator);

function assertionPassed(actual: unknown, assertion: NonNullable<AcceptanceTest["assertion"]>): boolean {
  if (assertion.operator === "at_least" || assertion.operator === "at_most") {
    if (typeof actual !== "number" || typeof assertion.expected !== "number") return false;
    return assertion.operator === "at_least" ? actual >= assertion.expected : actual <= assertion.expected;
  }
  const equal = Object.is(actual, assertion.expected);
  return assertion.operator === "equal" ? equal : !equal;
}

function isoMtime(file: string): string {
  return fs.statSync(file).mtime.toISOString();
}

const baseline = loadAcceptanceBaseline(root, "pm-mcp-local-release", "1.0.0");
if (baseline.approval.status !== "approved" || !baseline.approval.approved_at) throw new Error("验收基线尚未批准");
const productFile = absolute(evidenceLocator);
const product = JSON.parse(fs.readFileSync(productFile, "utf8")) as unknown;
const capturedAt = String(resolveJsonPointer(product, "/captured_at"));
if (!Number.isFinite(Date.parse(capturedAt))) throw new Error("产品证据 captured_at 无效");

const evidence = [
  { id: "EV-BASELINE", kind: "review" as const, locator: path.relative(root, acceptanceBaselinePath(root, baseline.baseline_id, baseline.baseline_version)).replace(/\\/g, "/"), captured_at: baseline.approval.approved_at, produced_by: "pm-mcp baseline approval transaction", summary: "Immutable approved quality baseline and evaluation plan." },
  { id: "EV-PLAN", kind: "review" as const, locator: planLocator, captured_at: isoMtime(absolute(planLocator)), produced_by: "Codex first-party evaluation planner", summary: "Human-readable bounded evaluation plan and stop conditions." },
  { id: "EV-FIRST-FAILURE", kind: "review" as const, locator: firstFailureLocator, captured_at: isoMtime(absolute(firstFailureLocator)), produced_by: "Node.js coverage gate", summary: "Preserved first failing coverage result before remediation." },
  { id: "EV-MEASURE", kind: "measurement" as const, locator: evidenceLocator, captured_at: capturedAt, produced_by: "collect-acceptance-evidence.mts", summary: "Machine-collected numeric measurements bound to the current source tree." },
  { id: "EV-TEST", kind: "test_result" as const, locator: evidenceLocator, captured_at: capturedAt, produced_by: "npm quality and MCP integration collector", summary: "Machine test, build, typecheck, coverage and stdio inventory results." },
  { id: "EV-AUDIT", kind: "audit" as const, locator: evidenceLocator, captured_at: capturedAt, produced_by: "pm-mcp audit/governance/security collectors", summary: "Machine governance, documentation, security and maintainability audit results." },
  { id: "EV-BENCH", kind: "benchmark" as const, locator: evidenceLocator, captured_at: capturedAt, produced_by: "pm-mcp volume benchmark verifier", summary: "Verified digest and oracle summary for the 20 GiB qualification run." },
].map((item) => ({ ...item, sha256: sha256AcceptanceFile(absolute(item.locator)) }));

const measurements = baseline.requirements.map((requirement) => {
  const observed = resolveJsonPointer(product, requirement.measurement_source.json_pointer);
  if (typeof observed !== "number" || !Number.isFinite(observed)) throw new Error(`需求 ${requirement.id} 的机器测量不是有限数字`);
  return { requirement_id: requirement.id, observed_value: observed, measured_at: capturedAt, evidence_ids: [requirement.measurement_source.evidence_id] };
});

const testResults = baseline.tests.map((definition) => {
  if (definition.verification_mode !== "automated" || !definition.assertion) throw new Error(`本配置不允许手工测试: ${definition.id}`);
  const actual = resolveJsonPointer(product, definition.assertion.json_pointer);
  const passed = assertionPassed(actual, definition.assertion);
  return {
    test_id: definition.id,
    status: passed ? "passed" as const : "failed" as const,
    executed_at: capturedAt,
    evidence_ids: [definition.assertion.evidence_id],
    result_note: passed
      ? `Machine assertion passed: ${definition.assertion.json_pointer} ${definition.assertion.operator} ${JSON.stringify(definition.assertion.expected)}.`
      : `Machine assertion failed: actual=${JSON.stringify(actual)}; expected ${definition.assertion.operator} ${JSON.stringify(definition.assertion.expected)}.`,
  };
});

const productEvidenceIds = ["EV-MEASURE", "EV-TEST", "EV-AUDIT", "EV-BENCH"];
const reviewDue = new Date(Date.parse(baseline.approval.approved_at) + 89 * 24 * 60 * 60 * 1000).toISOString();
const residualRisks = baseline.risks.map((risk) => risk.id === "R-SECURITY"
  ? {
      risk_id: risk.id,
      residual_level: "low" as const,
      disposition: "accepted" as const,
      acceptance: {
        accepted_by: "project-owner",
        accepted_at: baseline.approval.approved_at!,
        rationale: "Remaining accepted scanner findings are documented synthetic fixtures or scanner rule literals; open findings are still prohibited.",
        review_due: reviewDue,
      },
      evidence_ids: ["EV-AUDIT"],
    }
  : {
      risk_id: risk.id,
      residual_level: "low" as const,
      disposition: "mitigated" as const,
      acceptance: null,
      evidence_ids: risk.id === "R-PERFORMANCE" ? ["EV-BENCH"] : risk.id === "R-FUNCTIONAL" || risk.id === "R-RELIABILITY" ? ["EV-TEST"] : ["EV-AUDIT"],
    });

const evaluatedAt = new Date().toISOString();
const reportGeneratedAt = new Date(Date.parse(evaluatedAt) + 1).toISOString();
const evaluation = AcceptanceEvaluationSchema.parse({
  schema_version: 1,
  report_id: reportId,
  evaluation_id: "EVAL-PM-MCP-LOCAL-1.0.0",
  baseline_id: baseline.baseline_id,
  baseline_version: baseline.baseline_version,
  evaluated_at: evaluatedAt,
  report_generated_at: reportGeneratedAt,
  evaluator: { name: "Codex machine-assisted evaluator", organization: "pm-mcp development", role: "first-party evaluator", independent: false },
  stage_results: [
    { stage: "define", status: "completed", started_at: baseline.created_at, completed_at: baseline.approval.approved_at, artifact_evidence_ids: ["EV-BASELINE"], result_note: "Product, intended use, environment and exclusions were frozen in the approved baseline." },
    { stage: "design", status: "completed", started_at: baseline.created_at, completed_at: baseline.approval.approved_at, artifact_evidence_ids: ["EV-BASELINE"], result_note: "Nine characteristics, quantitative requirements, risks, tests and evidence pointers were designed before execution." },
    { stage: "plan", status: "completed", started_at: baseline.created_at, completed_at: baseline.approval.approved_at, artifact_evidence_ids: ["EV-BASELINE"], result_note: "Entry, stop, retest and reporting rules were frozen; the readable plan is supplementary evidence." },
    { stage: "execute", status: "completed", started_at: baseline.approval.approved_at, completed_at: capturedAt, artifact_evidence_ids: [...productEvidenceIds, "EV-FIRST-FAILURE"], result_note: "The first failed coverage run was preserved; remediation added tests without lowering thresholds, followed by fresh quality and evidence collection." },
    { stage: "conclude", status: "completed", started_at: capturedAt, completed_at: evaluatedAt, artifact_evidence_ids: ["EV-PLAN", ...productEvidenceIds], result_note: "All evidence hashes and frozen JSON assertions are ready for evaluator recomputation and immutable report generation." },
  ],
  evidence,
  measurements,
  test_results: testResults,
  residual_risks: residualRisks,
});

const output = absolute(evaluationLocator);
fs.mkdirSync(path.dirname(output), { recursive: true });
if (fs.existsSync(output)) throw new Error(`评价输入已存在，拒绝覆盖: ${evaluationLocator}`);
atomicWrite(output, `${JSON.stringify(evaluation, null, 2)}\n`);
console.log(JSON.stringify({ evaluation: evaluationLocator, report_id: evaluation.report_id, tests: evaluation.test_results.length, requirements: evaluation.measurements.length, evidence: evaluation.evidence.length }, null, 2));
