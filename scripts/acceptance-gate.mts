#!/usr/bin/env node
/** ISO/SQuaRE acceptance gate backed exclusively by approved, versioned project evidence. */
import path from "node:path";
import { evaluateAcceptanceFile } from "../src/acceptance-tools.ts";
import { requireInitialized } from "../src/paths.ts";

interface Args {
  root: string;
  baselineId: string;
  baselineVersion: string;
  evaluationFile: string;
}

function parseArgs(argv: string[]): Args {
  let root = process.cwd();
  let baselineId: string | undefined;
  let baselineVersion: string | undefined;
  let evaluationFile: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === "--root") {
      if (!value) throw new Error("--root 缺少路径");
      root = path.resolve(value);
      index += 1;
    } else if (arg === "--baseline-id") {
      if (!value) throw new Error("--baseline-id 缺少值");
      baselineId = value;
      index += 1;
    } else if (arg === "--baseline-version") {
      if (!value) throw new Error("--baseline-version 缺少值");
      baselineVersion = value;
      index += 1;
    } else if (arg === "--evaluation") {
      if (!value) throw new Error("--evaluation 缺少项目内 JSON 路径");
      evaluationFile = value;
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      console.log("node scripts/acceptance-gate.mts --root PATH --baseline-id ID --baseline-version X.Y.Z --evaluation .pm/acceptance/evaluations/FILE.json");
      process.exit(0);
    } else {
      throw new Error(`未知参数: ${arg}`);
    }
  }
  if (!baselineId || !baselineVersion || !evaluationFile) {
    throw new Error("必须提供 --baseline-id、--baseline-version 和 --evaluation");
  }
  return { root, baselineId, baselineVersion, evaluationFile };
}

function main(): number {
  const args = parseArgs(process.argv.slice(2));
  requireInitialized(args.root);
  const result = evaluateAcceptanceFile(args.root, {
    baseline_id: args.baselineId,
    baseline_version: args.baselineVersion,
    evaluation_file: args.evaluationFile,
  });
  const jsonFile = path.relative(args.root, result.json_file).replace(/\\/g, "/");
  const markdownFile = path.relative(args.root, result.markdown_file).replace(/\\/g, "/");
  const manifestFile = path.relative(args.root, result.manifest_file).replace(/\\/g, "/");
  console.log(`[acceptance-gate] ${result.report.verdict === "accepted" ? "PASS" : "FAIL"} · report=${result.report.report_id} · errors=${result.report.summary.errors}`);
  console.log(`[acceptance-gate] JSON=${jsonFile}`);
  console.log(`[acceptance-gate] Markdown=${markdownFile}`);
  console.log(`[acceptance-gate] SHA256=${manifestFile}`);
  return result.report.verdict === "accepted" ? 0 : 1;
}

try {
  process.exitCode = main();
} catch (error) {
  console.error(`[acceptance-gate] ERROR: ${(error as Error).message}`);
  process.exitCode = 1;
}
