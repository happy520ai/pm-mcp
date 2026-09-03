import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fingerprintProject, type ProjectFingerprint } from "../src/project-fingerprint.ts";
import { saveQualityRun } from "../src/quality-store.ts";
import type { QualityCommandResult, QualityPlanResult, QualityRunStatus } from "../src/language-adapters.ts";
import { initTestProject, mkProj, writeRel } from "./helpers.ts";

const roots: string[] = [];
after(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });

function commandResult(
  root: string,
  status: QualityRunStatus,
  stdout = "",
  stderr = "",
  overrides: Partial<QualityCommandResult> = {},
): QualityCommandResult {
  return {
    command: {
      command: process.execPath,
      args: ["--test"],
      cwd: root,
      kind: "test",
      requiredExecutable: process.execPath,
      timeoutMs: 30_000,
      maxOutputBytes: 64 * 1024,
    },
    status,
    exitCode: status === "passed" ? 0 : status === "failed" ? 1 : null,
    signal: null,
    stdout,
    stderr,
    truncated: false,
    durationMs: 123,
    ...overrides,
  };
}

function plan(result: QualityCommandResult, reportedOk = result.status === "passed", execute = true): QualityPlanResult {
  return { execute, ok: reportedOk, results: [result] };
}

function savedJson(root: string, relative: string): Record<string, any> {
  return JSON.parse(fs.readFileSync(path.join(root, ...relative.split("/")), "utf8")) as Record<string, any>;
}

function outputHash(stdout: string, stderr: string): string {
  return createHash("sha256").update(stdout, "utf8").update("\0", "utf8").update(stderr, "utf8").digest("hex");
}

test("quality evidence binds stable source, parses TAP/Istanbul metrics, and stores only output digest", () => {
  const root = mkProj({ "src/app.ts": "export const value = 1;\n" });
  roots.push(root);
  const before = fingerprintProject(root);
  writeRel(root, ".pm/generated.json", "ledger changes do not alter product source\n");
  writeRel(root, "dist/app.js", "generated output does not alter product source\n");
  const afterGenerated = fingerprintProject(root);
  assert.deepEqual(afterGenerated, before, ".pm and dist must be excluded from the product fingerprint");

  const secretOutput = "SENSITIVE-RAW-OUTPUT-must-not-enter-ledger";
  const stdout = [
    secretOutput,
    "ℹ tests 7",
    "ℹ pass 5",
    "ℹ fail 0",
    "ℹ cancelled 0",
    "ℹ skipped 1",
    "ℹ todo 1",
    "All files | 88.1 | 82.3 | 73.4 | 91.2",
  ].join("\n");
  const stderr = "diagnostic-without-raw-retention";
  const relative = saveQualityRun(root, plan(commandResult(root, "passed", stdout, stderr, { truncated: true })), {
    source_before: before,
    source_after: afterGenerated,
  });
  assert.match(relative, /^\.pm\/quality-runs\/quality-\d{8}-\d{6}-\d{3}-\d{4}\.json$/);
  const raw = fs.readFileSync(path.join(root, ...relative.split("/")), "utf8");
  assert.ok(!raw.includes(secretOutput));
  assert.ok(!raw.includes(stderr));
  assert.ok(!raw.includes('"stdout"'));
  assert.ok(!raw.includes('"stderr"'));

  const evidence = JSON.parse(raw) as Record<string, any>;
  assert.equal(evidence.ok, true);
  assert.equal(evidence.reported_ok, true);
  assert.equal(evidence.source.stable, true);
  assert.deepEqual(evidence.source.before, before);
  assert.deepEqual(evidence.source.after, afterGenerated);
  assert.deepEqual(evidence.results[0].output_summary, {
    stdout_bytes: Buffer.byteLength(stdout),
    stderr_bytes: Buffer.byteLength(stderr),
    output_sha256: outputHash(stdout, stderr),
    tests: 7,
    passed: 5,
    failed: 0,
    cancelled: 0,
    skipped: 1,
    todo: 1,
    coverage: { lines_pct: 91.2, branches_pct: 82.3, functions_pct: 73.4 },
  });
  assert.equal(evidence.results[0].output_truncated, true);
  assert.deepEqual(fingerprintProject(root), before, "persisted quality evidence itself must not mutate the product fingerprint");

  writeRel(root, "src/app.ts", "export const value = 2;\n");
  const changed = fingerprintProject(root);
  assert.notEqual(changed.sha256, before.sha256);
  const unstable = savedJson(root, saveQualityRun(root, plan(commandResult(root, "passed"), false), {
    source_before: before,
    source_after: changed,
  }));
  assert.equal(unstable.source.stable, false);
  assert.equal(unstable.ok, false);
});

test("Node three-column coverage remains correctly normalized", () => {
  const root = mkProj({ "src/app.ts": "export const value = 1;\n" });
  roots.push(root);
  const fingerprint = fingerprintProject(root);
  const stdout = "All files | 91.2 | 82.3 | 73.4 | uncovered lines\n";
  const evidence = savedJson(root, saveQualityRun(root, plan(commandResult(root, "passed", stdout)), {
    source_before: fingerprint,
    source_after: fingerprint,
  }));
  assert.deepEqual(evidence.results[0].output_summary.coverage, {
    lines_pct: 91.2,
    branches_pct: 82.3,
    functions_pct: 73.4,
  });
});

test("quality evidence is append-only within a millisecond and contradictory green claims fail closed", () => {
  const root = mkProj({ "src/app.ts": "export const value = 1;\n" });
  roots.push(root);
  const fingerprint: ProjectFingerprint = fingerprintProject(root);
  const provenance = { source_before: fingerprint, source_after: fingerprint };

  const failurePath = saveQualityRun(root, plan(commandResult(root, "failed", "first failure"), false), provenance);
  const passingPath = saveQualityRun(root, plan(commandResult(root, "passed", "later pass"), true), provenance);
  assert.notEqual(failurePath, passingPath, "a later pass must never overwrite first-failure evidence");
  assert.equal(savedJson(root, failurePath).ok, false);
  assert.equal(savedJson(root, passingPath).ok, true);
  assert.ok(fs.existsSync(path.join(root, ...failurePath.split("/"))));

  const contradictory = savedJson(root, saveQualityRun(root, plan(commandResult(root, "failed"), true), provenance));
  assert.equal(contradictory.reported_ok, true);
  assert.equal(contradictory.ok, false, "caller ok=true cannot override a failed command");

  const wrongExit = savedJson(root, saveQualityRun(root, plan(commandResult(root, "passed", "", "", { exitCode: 9 }), true), provenance));
  assert.equal(wrongExit.ok, false, "passed status with non-zero exit is internally inconsistent");

  const empty = savedJson(root, saveQualityRun(root, { execute: true, ok: true, results: [] }, provenance));
  assert.equal(empty.ok, false, "empty execution cannot be green");
  const planned = savedJson(root, saveQualityRun(root, plan(commandResult(root, "planned"), true, false), provenance));
  assert.equal(planned.ok, false, "plan-only evidence cannot be green");
});

test("saving quality evidence refreshes the generated dashboard, including failures", () => {
  const root = mkProj({ "src/app.ts": "export const value = 1;\n" });
  roots.push(root);
  initTestProject(root);
  const fingerprint = fingerprintProject(root);
  saveQualityRun(root, plan(commandResult(root, "failed", "first failure"), false), {
    source_before: fingerprint,
    source_after: fingerprint,
  });
  const dashboard = fs.readFileSync(path.join(root, "PROJECT.md"), "utf8");
  assert.match(dashboard, /\| 质量矩阵 \| 🚩/);
  assert.match(dashboard, /（0\/1）/);
});
