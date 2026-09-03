import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GovernanceSchema, saveGovernance, type GovernanceFile } from "../src/governance-model.ts";
import { buildPortfolioFromRegistry, buildPortfolioReport, buildRepositoryGraph, checkVersionConstraint, type PortfolioProjectSnapshot } from "../src/portfolio.ts";
import { initProject } from "../src/init.ts";
import { saveRegistry } from "../src/registry.ts";

function governance(id: string, version: string, dependencies: Array<{ repository: string; constraint: string }> = [], failOnUnresolved = true): GovernanceFile {
  return GovernanceSchema.parse({
    modules: [{ id: `${id}-module`, name: `${id} module`, roots: [`packages/${id}`], kind: "service", owners: [`team-${id}`], languages: id === "app" ? ["TypeScript", "Python"] : ["Go"] }],
    repositories: [{ id, name: id, root: ".", version, dependencies }],
    policies: { enforce_ownership: true, enforce_declared_dependencies: true, enforce_public_interfaces: true, fail_on_unresolved: failOnUnresolved, minimum_coverage_pct: 80 },
  });
}

test("semver 子集覆盖 exact/caret/tilde/comparators/star，未知格式明确 unresolved", () => {
  const cases: Array<[string, string, string]> = [
    ["1.2.3", "*", "satisfied"],
    ["1.2.3", "1.2.3", "satisfied"],
    ["1.2.4", "1.2.3", "mismatch"],
    ["1.9.0", "^1.2.3", "satisfied"],
    ["2.0.0", "^1.2.3", "mismatch"],
    ["0.2.9", "^0.2.3", "satisfied"],
    ["0.3.0", "^0.2.3", "mismatch"],
    ["1.2.9", "~1.2.3", "satisfied"],
    ["1.3.0", "~1.2.3", "mismatch"],
    ["1.2.3", ">=1.2.0", "satisfied"],
    ["1.2.3", "<=1.2.2", "mismatch"],
    ["1.2.3", ">1.2.2", "satisfied"],
    ["1.2.3", "<2.0.0", "satisfied"],
    ["1.2.3", "workspace:*", "unresolved"],
    ["main", ">=1.0.0", "unresolved"],
  ];
  for (const [version, constraint, expected] of cases) assert.equal(checkVersionConstraint(version, constraint).status, expected, `${version} ${constraint}`);
});

test("显式治理文件构建依赖图：解析版本、missing target、cycle", () => {
  const app = governance("app", "1.0.0", [{ repository: "lib", constraint: "^2.0.0" }, { repository: "ghost", constraint: "*" }]);
  const lib = governance("lib", "2.1.0", [{ repository: "app", constraint: "*" }]);
  const graph = buildRepositoryGraph([app, lib]);
  assert.equal(graph.dependencies.find((edge) => edge.to === "lib")?.status, "satisfied");
  assert.equal(graph.dependencies.find((edge) => edge.to === "ghost")?.status, "missing");
  assert.deepEqual(graph.cycles[0], ["app", "lib", "app"]);
  assert.ok(graph.violations.some((violation) => violation.code === "missing-repository-target"));
  assert.ok(graph.violations.some((violation) => violation.code === "repository-cycle"));
});

test("未知约束始终进入 violations，并由源仓 policies 决定是否令 ok=false", () => {
  const target = governance("lib", "2.1.0");
  const warning = buildPortfolioReport({ governanceFiles: [governance("app", "1.0.0", [{ repository: "lib", constraint: "workspace:*" }], false), target] });
  assert.equal(warning.violations[0]?.code, "version-constraint-unresolved");
  assert.equal(warning.violations[0]?.severity, "warning");
  assert.equal(warning.ok, true);
  const failed = buildPortfolioReport({ governanceFiles: [governance("app", "1.0.0", [{ repository: "lib", constraint: "workspace:*" }], true), target] });
  assert.equal(failed.violations[0]?.severity, "error");
  assert.equal(failed.ok, false);
});

test("项目快照聚合阶段、里程碑、任务债务、安全与模块语言并输出 coverage/risks", () => {
  const project: PortfolioProjectSnapshot = {
    id: "app",
    name: "App",
    root: "C:/repos/app",
    phase: "beta",
    milestones: [{ status: "active" }, { status: "done" }],
    tasks: [{ status: "todo", type: "debt" }, { status: "blocked", type: "feature" }, { status: "done", type: "fix" }],
    findings: [{ status: "open", severity: "medium" }],
    code_snapshot: { taken_at: "2026-09-02T00:00:00.000Z", total_files: 10, total_loc: 1000 },
    governance: governance("app", "1.0.0"),
  };
  const report = buildPortfolioReport({ projects: [project] });
  assert.equal(report.projects[0].phase, "beta");
  assert.deepEqual(report.projects[0].milestones, { total: 2, planned: 0, active: 1, done: 1, paused: 0 });
  assert.equal(report.projects[0].tasks.debt_open, 1);
  assert.equal(report.projects[0].security.medium, 1);
  assert.deepEqual(report.projects[0].languages, ["Python", "TypeScript"]);
  assert.equal(report.coverage.projects_loaded, 1);
  assert.equal(report.coverage.code_snapshots, 1);
  assert.equal(report.coverage.modules_with_owners, 1);
  assert.ok(report.risks.some((risk) => risk.code === "open-debt"));
  assert.ok(report.risks.some((risk) => risk.code === "blocked-tasks"));
});

test("注册表聚合保留缺失项目失败，不用空项目制造假绿", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "pm-portfolio-"));
  const home = path.join(base, "home");
  const good = path.join(base, "good");
  const missing = path.join(base, "missing");
  fs.mkdirSync(good, { recursive: true });
  process.env.PM_MCP_HOME = home;
  initProject(good, { name: "Good", phase: "MVP" });
  saveGovernance(good, governance("good", "1.0.0"));
  saveRegistry({ projects: [{ name: "Good", root: good, last_seen: "2026-09-02T00:00:00.000Z" }, { name: "Missing", root: missing, last_seen: "2026-09-02T00:00:00.000Z" }] });
  const report = buildPortfolioFromRegistry();
  assert.equal(report.coverage.projects_requested, 2);
  assert.equal(report.coverage.projects_loaded, 1);
  assert.equal(report.coverage.projects_failed, 1);
  assert.equal(report.projectFailures[0].name, "Missing");
  assert.ok(report.violations.some((violation) => violation.code === "project-load-failed"));
  assert.equal(report.ok, false);
});

test("注册表缺失或损坏成为 projectFailures", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "pm-portfolio-registry-"));
  const file = path.join(base, "registry.json");
  const absent = buildPortfolioFromRegistry(file);
  assert.equal(absent.projectFailures.length, 1);
  assert.equal(absent.ok, false);
  fs.writeFileSync(file, "{broken", "utf8");
  const corrupt = buildPortfolioFromRegistry(file);
  assert.match(corrupt.projectFailures[0].error, /注册表损坏/);
  assert.equal(corrupt.ok, false);
});

test("注册项目的损坏快照成为 projectFailure，不静默降级为无快照", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "pm-portfolio-snapshot-"));
  const root = path.join(base, "project");
  const home = path.join(base, "home");
  fs.mkdirSync(root, { recursive: true });
  process.env.PM_MCP_HOME = home;
  initProject(root, { name: "Broken snapshot" });
  saveGovernance(root, governance("broken-snapshot", "1.0.0"));
  fs.writeFileSync(path.join(root, ".pm", "snapshots", "snap-99999999-999999.json"), "{broken", "utf8");
  saveRegistry({ projects: [{ name: "Broken snapshot", root, last_seen: "2026-09-02T00:00:00.000Z" }] });
  const report = buildPortfolioFromRegistry();
  assert.equal(report.coverage.projects_loaded, 0);
  assert.equal(report.projectFailures.length, 1);
  assert.match(report.projectFailures[0].error, /代码快照 JSON 解析失败/);
  assert.equal(report.ok, false);
});
