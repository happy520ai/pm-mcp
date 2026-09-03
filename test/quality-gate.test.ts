import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { initProject } from "../src/init.ts";
import { saveGovernance } from "../src/governance-model.ts";

const runner = path.resolve("scripts/quality-gate.mts");

function fixture(withTest: boolean): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pm-quality-gate-"));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "index.ts"), "export const value = 1;\n");
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: withTest ? { test: "node -e \"process.exit(0)\"" } : {} }));
  initProject(root, { name: "quality" });
  saveGovernance(root, {
    modules: [{ id: "app", name: "App", roots: ["src"], kind: "app", owners: ["team"], languages: ["typescript"], public_interfaces: ["api"], depends_on: [], allowed_dependencies: [], denied_dependencies: [] }],
    interfaces: [{ id: "api", kind: "typescript", provider: "app", consumers: [], contract_files: ["src/index.ts"], version: "1.0.0" }],
    repositories: [{ id: "app", name: "App", root: ".", version: "1.0.0", dependencies: [] }],
    policies: { enforce_ownership: true, enforce_declared_dependencies: true, fail_on_unresolved: true, enforce_public_interfaces: true, minimum_coverage_pct: 100, required_quality_kinds: ["test"] },
  });
  return root;
}

function run(root: string, ...args: string[]): { code: number; output: string } {
  const result = spawnSync(process.execPath, [runner, "--root", root, ...args], { encoding: "utf8", timeout: 30_000 });
  return { code: result.status ?? -1, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

test("quality gate 的 plan-only 不冒充执行，默认执行真实 Node 测试", () => {
  const root = fixture(true);
  const plan = run(root, "--plan");
  assert.equal(plan.code, 0, plan.output);
  assert.ok(plan.output.includes("PLAN_ONLY") && plan.output.includes("未执行"));
  const executed = run(root);
  assert.equal(executed.code, 0, executed.output);
  assert.ok(executed.output.includes("[passed/test]") && executed.output.includes("PASS"));
  assert.ok(fs.existsSync(path.join(root, ".pm", "quality-runs")), "真实执行应写结构化摘要");
});

test("无质量命令与治理违规均 fail-closed", () => {
  const noCommand = fixture(false);
  const missing = run(noCommand);
  assert.equal(missing.code, 1, missing.output);
  assert.ok(missing.output.includes("没有质量命令") || missing.output.includes("质量命令为空"));

  const broken = fixture(true);
  fs.rmSync(path.join(broken, "src", "index.ts"));
  const invalid = run(broken);
  assert.equal(invalid.code, 1, invalid.output);
  assert.ok(invalid.output.includes("架构治理未通过"));
});
