import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { initTestProject, mkProj, writeRel } from "./helpers.ts";
import { saveGovernance } from "../src/governance-model.ts";
import { auditGovernance } from "../src/governance-audit.ts";

test("多模块治理审计汇总语义图、语言与质量覆盖", () => {
  const root = mkProj({
    "package.json": JSON.stringify({ scripts: { test: "node --test" }, devDependencies: { typescript: "1.0.0" } }),
    "src/api/index.ts": "export const api = 1;\n",
    "src/web/app.ts": "import { api } from '../api/index.ts';\nexport const web = api;\n",
  });
  initTestProject(root);
  saveGovernance(root, {
    modules: [
      { id: "api", name: "API", roots: ["src/api"], kind: "library", owners: ["team-api"], languages: ["typescript"], public_interfaces: ["api-public"], depends_on: [], allowed_dependencies: [], denied_dependencies: [] },
      { id: "web", name: "Web", roots: ["src/web"], kind: "app", owners: ["team-web"], languages: ["typescript"], public_interfaces: [], depends_on: ["api"], allowed_dependencies: ["api"], denied_dependencies: [] },
    ],
    interfaces: [{ id: "api-public", kind: "typescript", provider: "api", consumers: ["web"], contract_files: ["src/api/index.ts"], version: "1.0.0" }],
    repositories: [],
    policies: { enforce_ownership: true, enforce_declared_dependencies: true, fail_on_unresolved: true, enforce_public_interfaces: true, minimum_coverage_pct: 80, required_quality_kinds: ["test"] },
  });
  const result = auditGovernance(root);
  assert.equal(result.ok, true, result.report);
  assert.equal(result.graph.moduleEdges.length, 1);
  assert.equal(result.qualityCoverage.coveragePct, 100);
  assert.ok(result.report.includes("typescript"));
});

test("缺 root、无 owner、私有入口、未知相对引用与无质量命令均不能假绿", () => {
  const root = mkProj({
    "package.json": JSON.stringify({ name: "x" }),
    "src/api/private.ts": "export const secret = 1;\n",
    "src/web/app.ts": "import { secret } from '../api/private.ts';\nimport x from './missing.ts';\n",
  });
  initTestProject(root);
  // schema 层已拒绝无 owner；这里关闭 owner schema policy，专测审计层其余问题。
  saveGovernance(root, {
    modules: [
      { id: "api", name: "API", roots: ["src/api"], kind: "library", owners: ["team-api"], languages: ["typescript"], public_interfaces: ["api-public"], depends_on: [], allowed_dependencies: [], denied_dependencies: [] },
      { id: "web", name: "Web", roots: ["src/web"], kind: "app", owners: ["team-web"], languages: ["typescript"], public_interfaces: [], depends_on: ["api"], allowed_dependencies: ["api"], denied_dependencies: [] },
    ],
    interfaces: [{ id: "api-public", kind: "typescript", provider: "api", consumers: ["web"], contract_files: ["src/api/index.ts"], version: "1.0.0" }],
    repositories: [],
    policies: { enforce_ownership: true, enforce_declared_dependencies: true, fail_on_unresolved: true, enforce_public_interfaces: true, minimum_coverage_pct: 100, required_quality_kinds: ["test"] },
  });
  const result = auditGovernance(root);
  assert.equal(result.ok, false);
  const codes = new Set(result.issues.map((issue) => issue.code));
  assert.ok(codes.has("contract-file-missing"));
  assert.ok(codes.has("private-interface"));
  assert.ok(codes.has("unresolved-reference"));
  assert.ok(codes.has("quality-command-missing"));
});

test("治理声明的模块 root 漂移会被点名", () => {
  const root = mkProj({ "package.json": JSON.stringify({ scripts: { test: "node --test" } }), "src/a.ts": "export const a = 1;\n" });
  initTestProject(root);
  saveGovernance(root, {
    modules: [{ id: "ghost", name: "Ghost", roots: ["missing/module"], kind: "library", owners: ["team"], languages: ["typescript"], public_interfaces: [], depends_on: [], allowed_dependencies: [], denied_dependencies: [] }],
    interfaces: [], repositories: [],
    policies: { enforce_ownership: true, enforce_declared_dependencies: true, fail_on_unresolved: true, enforce_public_interfaces: true, minimum_coverage_pct: 0, required_quality_kinds: ["test"] },
  });
  const result = auditGovernance(root);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.code === "module-root-missing"));
});
