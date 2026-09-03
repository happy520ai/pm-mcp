#!/usr/bin/env node
/** Platform-neutral semantic + multi-language CI gate. */
import path from "node:path";
import { auditGovernance } from "../src/governance-audit.ts";
import { createQualityPlan, runQualityPlan } from "../src/language-adapters.ts";
import { saveQualityRun } from "../src/quality-store.ts";
import { fingerprintProject } from "../src/project-fingerprint.ts";

interface Args {
  root: string;
  planOnly: boolean;
  unit?: string;
  kinds: Array<"test" | "build" | "lint" | "typecheck" | "coverage" | "security">;
}

function parseArgs(argv: string[]): Args {
  let root = process.cwd();
  let planOnly = false;
  let unit: string | undefined;
  const kinds: Args["kinds"] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--root") {
      if (!argv[i + 1]) throw new Error("--root 缺少路径");
      root = path.resolve(argv[++i]);
    } else if (arg === "--plan") {
      planOnly = true;
    } else if (arg === "--unit") {
      if (!argv[i + 1]) throw new Error("--unit 缺少 ID");
      unit = argv[++i];
    } else if (arg === "--kind") {
      const kind = argv[++i] as Args["kinds"][number] | undefined;
      if (!kind || !["test", "build", "lint", "typecheck", "coverage", "security"].includes(kind)) throw new Error("--kind 必须是 test/build/lint/typecheck/coverage/security");
      kinds.push(kind);
    } else if (arg === "--help" || arg === "-h") {
      console.log("node scripts/quality-gate.mts [--root PATH] [--plan] [--unit ID] [--kind test|build|lint|typecheck]");
      process.exit(0);
    } else {
      throw new Error(`未知参数: ${arg}`);
    }
  }
  return { root, planOnly, unit, kinds };
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const sourceBefore = fingerprintProject(args.root);
  const audit = auditGovernance(args.root, 200);
  console.log(audit.report);
  if (!audit.ok) {
    console.error("[quality-gate] 架构治理未通过；不执行后续命令。");
    return 1;
  }
  const units = args.unit ? audit.units.filter((unit) => unit.id === args.unit) : audit.units;
  if (args.unit && units.length === 0) {
    console.error(`[quality-gate] 找不到 unit ${args.unit}`);
    return 1;
  }
  let plan = createQualityPlan(units);
  if (args.kinds.length > 0) plan = plan.filter((command) => args.kinds.includes(command.kind));
  if (plan.length === 0) {
    console.error("[quality-gate] 质量命令为空，拒绝假绿。");
    return 1;
  }
  for (const command of plan) console.log(`[plan/${command.kind}] ${command.cwd} :: ${command.command} ${command.args.join(" ")}`);
  if (args.planOnly) {
    console.log("[quality-gate] PLAN_ONLY：未执行任何构建或测试，不能作为通过证据。");
    return 0;
  }
  const executed = await runQualityPlan(plan, { execute: true, stopOnFailure: true });
  const sourceAfter = fingerprintProject(args.root);
  const sourceStable = sourceBefore.sha256 === sourceAfter.sha256;
  const result = { ...executed, ok: executed.ok && sourceStable };
  const summary = saveQualityRun(args.root, result, { source_before: sourceBefore, source_after: sourceAfter });
  for (const item of result.results) {
    console.log(`[${item.status}/${item.command.kind}] ${item.command.cwd} (${item.durationMs}ms${item.exitCode === null ? "" : `, exit=${item.exitCode}`})`);
  }
  if (!sourceStable) console.error(`[quality-gate] 源码在质量执行期间变化：before=${sourceBefore.sha256} after=${sourceAfter.sha256}`);
  console.log(`[quality-gate] ${result.ok ? "PASS" : "FAIL"} · ${summary}`);
  return result.ok ? 0 : 1;
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error(`[quality-gate] ERROR: ${(error as Error).message}`);
  process.exitCode = 1;
}
