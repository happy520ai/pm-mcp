import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAuditTools, registerRegistryTools } from "../src/audit-tools.ts";
import { registerGovernanceTools } from "../src/governance-tools.ts";
import { registerDecisionTools, registerFeatureTools, registerSearchTools, registerSessionTools } from "../src/knowledge-tools.ts";
import { registerProjectTools, registerRoadmapTools } from "../src/project-tools.ts";
import { registerTaskTools } from "../src/task-tools.ts";
import { semanticContentHash } from "../src/semantic-evidence.ts";
import {
  closeIndex,
  computeEntry,
  deleteFile,
  deleteSubtree,
  drainWatcher,
  getIndex,
  indexSummary,
  upsertFile,
  walkRefresh,
} from "../src/index-store.ts";
import {
  contentCacheStats,
  formatCodeSearch,
  readText,
  resetContentReadStats,
  searchKnowledge,
  setContentReadObserver,
} from "../src/search.ts";
import {
  decisionsDir,
  ensurePmDirs,
  registryFile,
  requireInitialized,
  resolveRoot,
  snapshotsDir,
} from "../src/paths.ts";
import { listRegistry, loadRegistry, saveRegistry, touchRegistry } from "../src/registry.ts";
import { initTestProject, mkProj, writeRel } from "./helpers.ts";

interface ToolResult {
  content?: Array<{ text?: string }>;
  isError?: boolean;
}

type Handler = (args: Record<string, any>) => ToolResult | Promise<ToolResult>;

function registeredHandlers(root: string): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  const fake = {
    registerTool(name: string, _config: unknown, handler: Handler): void { handlers.set(name, handler); },
  } as unknown as McpServer;
  registerProjectTools(fake, root);
  registerRoadmapTools(fake, root);
  registerTaskTools(fake, root);
  registerFeatureTools(fake, root);
  registerDecisionTools(fake, root);
  registerSessionTools(fake, root);
  registerSearchTools(fake, root);
  registerAuditTools(fake, root);
  registerRegistryTools(fake);
  registerGovernanceTools(fake, root);
  return handlers;
}

function resultText(result: ToolResult): string {
  return (result.content ?? []).map((item) => item.text ?? "").join("\n");
}

test("domain MCP handlers exercise success, rejection, filtering and warning branches", async (t) => {
  const root = mkProj({
    "src/app.ts": "export function run(): number { return 1; }\n",
    "package.json": JSON.stringify({ name: "coverage-fixture", version: "1.0.0", scripts: { test: "node -e \"process.exit(0)\"" }, devDependencies: { typescript: "1.0.0" } }),
    "tsconfig.json": "{}\n",
  });
  const home = process.env.PM_MCP_HOME!;
  t.after(() => {
    closeIndex(root);
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });
  const handlers = registeredHandlers(root);
  const invoke = async (name: string, args: Record<string, any> = {}): Promise<ToolResult> => {
    const handler = handlers.get(name);
    assert.ok(handler, `missing handler ${name}`);
    return await handler(args);
  };
  const ok = async (name: string, args: Record<string, any> = {}): Promise<string> => {
    const result = await invoke(name, args);
    assert.equal(result.isError, undefined, `${name}: ${resultText(result)}`);
    return resultText(result);
  };
  const bad = async (name: string, args: Record<string, any> = {}): Promise<string> => {
    const result = await invoke(name, args);
    assert.equal(result.isError, true, `${name} unexpectedly passed`);
    return resultText(result);
  };

  assert.match(await bad("get_status"), /未初始化/);
  assert.match(await ok("list_projects"), /注册表为空/);
  await ok("init_project", { name: "coverage", description: "domain handlers", stack: ["TypeScript"], goals: ["coverage"], license: "MIT", exposure: "local", modules: ["src"] });
  assert.match(await bad("init_project", { name: "again" }), /已初始化/);
  assert.match(await ok("list_projects"), /coverage/);

  fs.rmSync(path.join(root, ".pm", "governance.json"));
  assert.match(await ok("get_status"), /治理模型未初始化/);
  await ok("init_governance");
  await ok("update_project", {
    description: "updated", stack: ["Node"], goals: ["all handlers"], phase: "verification", license: "Apache-2.0", exposure: "public", modules: ["src"],
    max_file_loc: 600, refactor_quota_pct: 100, session_blast_radius: 1, output_budget_lines: 80,
  });
  await ok("regenerate_dashboard");

  await ok("add_milestone", { title: "first", goal: "foundation" });
  await ok("add_milestone", { title: "second" });
  assert.match(await ok("update_milestone", { id: "M2", status: "done", title: "second-updated", goal: "done", order: 2 }), /跳过前置/);
  assert.match(await bad("update_milestone", { id: "M404" }), /找不到里程碑/);
  await ok("update_milestone", { id: "M1", status: "active" });
  assert.match(await bad("add_task", { title: "bad milestone", milestone: "M404" }), /不存在/);
  for (let index = 0; index < 5; index += 1) {
    await ok("add_task", { title: `feature-${index}`, milestone: "M1", type: "feature", priority: index === 0 ? "P0" : undefined, tags: ["coverage"], files: ["src\\app.ts"], steps: index === 0 ? [{ text: "first" }, { text: "second" }] : undefined });
  }
  assert.match(await ok("list_tasks", { status: "backlog" }), /5 个任务/);
  assert.match(await ok("list_tasks", { type: "feature", milestone: "M1", tag: "coverage", include_done: true }), /feature-0/);
  assert.match(await bad("update_task", { id: "T-404" }), /找不到任务/);
  assert.match(await bad("update_task", { id: "T-001", milestone: "M404" }), /不存在/);
  assert.match(await bad("update_task", { id: "T-001", step_done: 9 }), /不存在/);
  await ok("update_task", { id: "T-001", status: "in_progress", title: "feature-main", detail: "detail", priority: null, milestone: "M1", tags: ["updated"], files: ["src/app.ts"], acceptance: "accepted", result_note: "", verification: "", steps: [{ text: "step", done: false }], step_done: 1, author: "codex" });
  assert.match(await bad("update_task", { id: "T-001", status: "done" }), /result_note/);
  assert.match(await bad("update_task", { id: "T-001", status: "done", result_note: "好" }), /过于空洞/);
  assert.match(await ok("update_task", { id: "T-001", status: "done", result_note: "完成真实分支" }), /提示/);
  await ok("update_task", { id: "T-001", status: "backlog", verification: "node --test" });
  assert.match(await bad("checkpoint", { task_id: "T-404", note: "x", next_step: "y" }), /找不到任务/);
  await ok("checkpoint", { task_id: "T-002", note: "half", next_step: "continue" });
  assert.match(await ok("get_status", { since: "not-a-date" }), /自 not-a-date/);
  assert.match(await ok("get_roadmap", { depth: 2 }), /重构被挤出/);

  await ok("register_feature", { name: "duplicate", description: "coverage", entry_files: ["src/app.ts"], module: "src", test_files: [] });
  assert.match(await ok("register_feature", { name: "duplicate", status: "planned", entry_files: ["src/missing.ts"] }), /同名功能/);
  assert.match(await ok("list_features", { status: "implemented", module: "src" }), /无测试/);
  assert.match(await ok("list_features", { status: "planned" }), /planned|duplicate/);
  assert.match(await ok("list_decisions"), /暂无/);
  await ok("record_decision", { title: "coverage decision", context: "context", decision: "decision", consequences: "cost" });
  assert.match(await ok("list_decisions"), /ADR-001/);
  assert.match(await ok("log_session", { summary: "coverage session", files: ["src/app.ts", "src/other.ts"], next_steps: ["coverage next"], author: "codex" }), /超过阈值/);
  await ok("log_debug", { symptom: "coverage symptom", root_cause: "coverage root", fix: "coverage fix", verified_how: "test", files: ["src/app.ts"], task_id: "T-001" });
  assert.match(await bad("annotate_file", { path: "missing.ts", purpose: "missing" }), /不存在/);
  await ok("annotate_file", { path: "src/app.ts", purpose: "coverage purpose", source: "local", license: "MIT" });
  await ok("annotate_file", { path: "src/app.ts", purpose: "coverage purpose updated" });
  assert.match(await ok("search_code", { query: "return 1", glob: "src/**/*.ts", max_results: 2 }), /src\/app.ts:1/);
  for (const query of ["feature-main", "duplicate", "coverage session", "coverage symptom", "coverage purpose", "coverage decision"]) {
    assert.doesNotMatch(await ok("search_knowledge", { query }), /无 .*相关记录/);
  }

  assert.match(await ok("get_governance"), /modules 0/);
  assert.match(await bad("upsert_interface", { id: "bad-api", kind: "typescript", provider: "missing", consumers: [], contract_files: ["src/app.ts"], version: "1.0.0" }), /provider module 不存在/);
  const module = { id: "app", name: "App", roots: ["src"], kind: "app", owners: ["team"], languages: ["typescript"], public_interfaces: [], depends_on: [], allowed_dependencies: [], denied_dependencies: [] };
  await ok("upsert_module", module);
  await ok("upsert_module", { ...module, name: "App replaced" });
  await ok("upsert_interface", { id: "app-api", kind: "typescript", provider: "app", consumers: [], contract_files: ["src/app.ts"], version: "1.0.0" });
  await ok("upsert_repository", { id: "repo", name: "Repo", root: ".", version: "1.0.0", dependencies: [] });
  await ok("upsert_repository", { id: "repo", name: "Repo replaced", root: ".", version: "1.0.1", dependencies: [] });
  await ok("set_governance_policies", { minimum_coverage_pct: 100, minimum_semantic_assurance: "ast", fail_on_semantic_fallback: true, required_quality_kinds: ["test"] });
  writeRel(root, "empty/package.json", JSON.stringify({ name: "empty" }));
  assert.match(await ok("discover_languages"), /无质量命令/);
  fs.rmSync(path.join(root, "empty"), { recursive: true, force: true });
  assert.match(await ok("audit_governance"), /source 100%/);
  assert.match(await ok("list_semantic_evidence"), /\[\]/);
  const content = fs.readFileSync(path.join(root, "src/app.ts"), "utf8");
  await ok("save_semantic_evidence", {
    id: "coverage-ast",
    document: {
      schema_version: 1, file: "src/app.ts", language: "typescript", content_sha256: semanticContentHash(content), generated_at: new Date().toISOString(), status: "complete",
      analyzer: { id: "coverage-analyzer", family: "compiler-ast", assurance: "ast", engine: "fixture", version: "1", capabilities: ["imports"] }, references: [], exports: [], diagnostics: [],
    },
  });
  assert.match(await ok("list_semantic_evidence"), /coverage-analyzer/);
  assert.match(await ok("impact_analysis", { files: ["src/app.ts", "src/unknown.ts"] }), /未进入语义图/);
  assert.match(await bad("plan_quality_matrix", { unit: "missing" }), /找不到质量单元/);
  assert.match(await ok("plan_quality_matrix", { kinds: ["test"] }), /plan-only/);
  assert.match(await bad("run_quality_matrix", { confirm_execute: true, kinds: ["lint"] }), /质量矩阵为空/);
  assert.match(await ok("run_quality_matrix", { confirm_execute: true, kinds: ["test"], stop_on_failure: false }), /通过/);
  assert.match(await ok("get_portfolio", { current_only: true }), /projects 1\/1/);
  assert.match(await ok("get_portfolio", { current_only: false }), /portfolio projects/);

  assert.match(await ok("list_findings", { status: "open" }), /无open/);
  // Build the fixture at runtime so the scanner does not flag its own test
  // source as a real dangerous call in this repository.
  writeRel(root, "src/danger.ts", `${"ev"}${"al"}(userInput);\n`);
  assert.match(await ok("audit_security"), /SEC-|需处置/);
  const security = JSON.parse(fs.readFileSync(path.join(root, ".pm", "security.json"), "utf8")) as { findings: Array<{ id: string }> };
  const findingId = security.findings.at(-1)!.id;
  assert.match(await ok("list_findings", { status: "open" }), new RegExp(findingId));
  assert.match(await bad("resolve_finding", { id: "SEC-404", status: "fixed" }), /找不到/);
  assert.match(await bad("resolve_finding", { id: findingId, status: "accepted" }), /必须填写理由/);
  await ok("resolve_finding", { id: findingId, status: "accepted", note: "测试夹具中的动态执行模式，仅用于覆盖扫描分支" });
  assert.match(await ok("list_findings", { status: "accepted" }), new RegExp(findingId));
  await ok("snapshot_codebase");
  await ok("audit_structure");
  await ok("audit_license");
});

test("paths and registry cover fallback, corruption, replacement and ordering", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pm-tooling-paths-"));
  const home = `${root}-home`;
  const oldHome = process.env.PM_MCP_HOME;
  const oldRoot = process.env.PM_ROOT;
  process.env.PM_MCP_HOME = home;
  t.after(() => {
    if (oldHome === undefined) delete process.env.PM_MCP_HOME; else process.env.PM_MCP_HOME = oldHome;
    if (oldRoot === undefined) delete process.env.PM_ROOT; else process.env.PM_ROOT = oldRoot;
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });
  process.env.PM_ROOT = root;
  assert.equal(resolveRoot(), path.resolve(root));
  assert.equal(resolveRoot(` ${path.join(root, "explicit")} `), path.resolve(root, "explicit"));
  delete process.env.PM_ROOT;
  assert.equal(resolveRoot(), process.cwd());
  assert.throws(() => requireInitialized(root), /未初始化/);
  ensurePmDirs(root);
  assert.equal(fs.existsSync(decisionsDir(root)), true);
  assert.equal(fs.existsSync(snapshotsDir(root)), true);

  const file = registryFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "not-json", "utf8");
  const errors: unknown[] = [];
  const oldError = console.error;
  console.error = (...args: unknown[]) => { errors.push(args); };
  try { assert.deepEqual(loadRegistry(), { projects: [] }); } finally { console.error = oldError; }
  assert.equal(errors.length, 1);
  saveRegistry({ projects: [] });
  touchRegistry(root, "first");
  touchRegistry(root, "renamed");
  touchRegistry(path.join(root, "second"), "second");
  const listed = listRegistry();
  assert.equal(listed.length, 2);
  assert.ok(listed.some((item) => item.name === "renamed"));
});

test("index and search boundaries reject unreadable content and render every result state", (t) => {
  const root = mkProj({ "src/plain.ts": "export const plain = 1;\n", "src/nul.ts": "a\0b", "blob.png": "binary" });
  const home = process.env.PM_MCP_HOME!;
  initTestProject(root);
  t.after(() => {
    setContentReadObserver(null);
    closeIndex(root);
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });
  writeRel(root, "package-lock.json", "{}\n");
  const oversize = path.join(root, "src", "oversize.ts");
  fs.writeFileSync(oversize, Buffer.alloc(2 * 1024 * 1024 + 1, 0x20));
  const normalStat = fs.statSync(path.join(root, "src", "plain.ts"));
  assert.equal(computeEntry(root, "blob.png", fs.statSync(path.join(root, "blob.png"))).contentOk, false);
  assert.equal(computeEntry(root, "package-lock.json", fs.statSync(path.join(root, "package-lock.json"))).contentOk, false);
  assert.equal(computeEntry(root, "src/oversize.ts", fs.statSync(oversize)).oversize, true);
  assert.equal(computeEntry(root, "src/nul.ts", fs.statSync(path.join(root, "src", "nul.ts"))).contentOk, false);
  assert.equal(computeEntry(root, "src/missing.ts", normalStat).contentOk, false);

  const db = getIndex(root);
  upsertFile(root, db, "src/plain.ts", normalStat, computeEntry(root, "src/plain.ts", normalStat));
  assert.match(indexSummary(root), /1 文件/);
  deleteFile(db, "src/plain.ts");
  upsertFile(root, db, "src/group/plain.ts", normalStat, computeEntry(root, "src/plain.ts", normalStat));
  deleteSubtree(db, "src/group");
  assert.equal(drainWatcher(root), false);
  walkRefresh(root);
  assert.match(indexSummary(root), /watcher 未运行/);

  resetContentReadStats(true);
  let observed = 0;
  setContentReadObserver(() => { observed += 1; });
  assert.match(readText(root, "src/plain.ts")!, /plain/);
  assert.match(readText(root, "src/plain.ts")!, /plain/);
  assert.equal(readText(root, "missing.ts"), null);
  assert.equal(readText(root, "src/nul.ts"), null);
  const huge = path.join(root, "src", "huge.txt");
  fs.writeFileSync(huge, Buffer.alloc(4 * 1024 * 1024 + 1, 0x20));
  assert.equal(readText(root, "src/huge.txt"), null);
  assert.ok(observed >= 1);
  assert.ok(contentCacheStats().cacheHits >= 1);
  resetContentReadStats(false);

  assert.match(formatCodeSearch({ matches: [], purposeHits: [], scannedFiles: 0, truncated: false }, "none"), /无命中/);
  const rendered = formatCodeSearch({ matches: [{ rel: "src/plain.ts", line: 1, text: "plain" }], purposeHits: ["src/plain.ts（用途: demo）"], scannedFiles: -1, truncated: true }, "plain");
  assert.match(rendered, /已截断/);
  assert.match(rendered, /ripgrep 后端/);
  assert.match(rendered, /文件索引命中/);

  fs.rmSync(path.join(root, ".pm", "governance.json"));
  assert.match(searchKnowledge(root, "definitely-absent"), /无 .*相关记录/);
});
