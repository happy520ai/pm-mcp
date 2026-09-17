#!/usr/bin/env node
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { acceptanceTarget } from "./acceptance-target.mts";

const rootIndex = process.argv.indexOf("--root");
const root = rootIndex >= 0 && process.argv[rootIndex + 1] ? path.resolve(process.argv[rootIndex + 1]) : process.cwd();
const target = acceptanceTarget(root);
const baselineArgs = ["--baseline-id", target.id, "--baseline-version", target.version];
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
const runId = `${stamp}-${randomUUID().slice(0, 8)}`;
const evidence = `.pm/acceptance/evidence/product-evidence-${runId}.json`;
const evaluation = `.pm/acceptance/evaluations/pm-mcp-local-${runId}.json`;
const reportId = `pm-mcp-local-${runId}`;

function run(script: string, args: string[]): void {
  const result = spawnSync(process.execPath, [path.join(root, "scripts", script), ...args], {
    cwd: root,
    shell: false,
    windowsHide: true,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${script} 失败（exit ${result.status ?? "null"}）`);
}

run("collect-acceptance-evidence.mts", ["--root", root, "--output", evidence]);
run("create-pm-acceptance-evaluation.mts", ["--root", root, ...baselineArgs, "--evidence", evidence, "--evaluation", evaluation, "--report-id", reportId]);
run("acceptance-gate.mts", ["--root", root, ...baselineArgs, "--evaluation", evaluation]);
console.log(`[acceptance-cycle] PASS ${reportId}`);
