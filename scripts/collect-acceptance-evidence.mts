#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { auditGovernance } from "../src/governance-audit.ts";
import { fingerprintProject } from "../src/project-fingerprint.ts";
import { POLYGLOT_AST_LANGUAGES } from "../src/polyglot-ast.ts";
import { atomicWrite, loadSecurity } from "../src/store.ts";

interface Args { root: string; output: string }

function parseArgs(argv: string[]): Args {
  let root = process.cwd();
  let output = ".pm/acceptance/evidence/product-evidence.json";
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--root") {
      if (!argv[index + 1]) throw new Error("--root 缺少路径");
      root = path.resolve(argv[++index]);
    } else if (arg === "--output") {
      if (!argv[index + 1]) throw new Error("--output 缺少路径");
      output = argv[++index];
    } else if (arg === "--help" || arg === "-h") {
      console.log("node scripts/collect-acceptance-evidence.mts [--root PATH] [--output .pm/acceptance/evidence/FILE.json]");
      process.exit(0);
    } else throw new Error(`未知参数: ${arg}`);
  }
  return { root, output };
}

function within(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function safeOutput(root: string, locator: string): string {
  const allowed = path.resolve(root, ".pm", "acceptance", "evidence");
  const target = path.resolve(root, locator);
  if (!within(allowed, target) || path.extname(target).toLowerCase() !== ".json") throw new Error("输出必须是 .pm/acceptance/evidence 下的 JSON 文件");
  return target;
}

function sha256File(file: string): string {
  const hash = createHash("sha256");
  const handle = fs.openSync(file, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    const before = fs.fstatSync(handle);
    let offset = 0;
    while (offset < before.size) {
      const read = fs.readSync(handle, buffer, 0, Math.min(buffer.length, before.size - offset), offset);
      if (read === 0) break;
      hash.update(buffer.subarray(0, read));
      offset += read;
    }
    const after = fs.fstatSync(handle);
    if (offset !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error(`读取期间文件变化: ${file}`);
    return hash.digest("hex");
  } finally { fs.closeSync(handle); }
}

function latestJson(directory: string): { file: string; value: Record<string, unknown> } {
  const candidate = fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => ({ file: path.join(directory, entry.name), mtime: fs.statSync(path.join(directory, entry.name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime || a.file.localeCompare(b.file))[0];
  if (!candidate) throw new Error(`没有 JSON 证据: ${directory}`);
  return { file: candidate.file, value: JSON.parse(fs.readFileSync(candidate.file, "utf8")) as Record<string, unknown> };
}

function implementationComplexity(root: string): { maximum_lines: number; over_500: Array<{ file: string; lines: number }> } {
  const rows: Array<{ file: string; lines: number }> = [];
  const visit = (directory: string): void => {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile() && /\.(?:ts|mts)$/.test(entry.name)) {
        const text = fs.readFileSync(absolute, "utf8");
        rows.push({ file: path.relative(root, absolute).replace(/\\/g, "/"), lines: text.split("\n").length });
      }
    }
  };
  visit(path.join(root, "src"));
  visit(path.join(root, "scripts"));
  return {
    maximum_lines: rows.reduce((maximum, row) => Math.max(maximum, row.lines), 0),
    over_500: rows.filter((row) => row.lines > 500).sort((a, b) => b.lines - a.lines || a.file.localeCompare(b.file)),
  };
}

async function mcpInventory(root: string): Promise<{ ok: boolean; tools: number; resources: number; prompts: number; names_unique: boolean }> {
  const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), "pm-acceptance-home-"));
  const client = new Client({ name: "pm-acceptance-collector", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(root, "src", "index.ts"), "--root", root],
    env: { PM_MCP_HOME: isolatedHome },
  });
  try {
    await client.connect(transport);
    const [tools, resources, prompts] = await Promise.all([client.listTools(), client.listResources(), client.listPrompts()]);
    const names = [...tools.tools.map((item) => `tool:${item.name}`), ...resources.resources.map((item) => `resource:${item.uri}`), ...prompts.prompts.map((item) => `prompt:${item.name}`)];
    return { ok: true, tools: tools.tools.length, resources: resources.resources.length, prompts: prompts.prompts.length, names_unique: new Set(names).size === names.length };
  } finally {
    await client.close().catch(() => undefined);
    fs.rmSync(isolatedHome, { recursive: true, force: true });
  }
}

function benchmarkMetrics(root: string): Record<string, unknown> {
  const file = path.join(root, ".pm", "benchmarks", "volume-20g-3e8-20260902.json");
  const value = JSON.parse(fs.readFileSync(file, "utf8")) as any;
  const smokeFile = path.join(root, ".pm", "benchmarks", "volume-refactor-smoke-20260903.json");
  const smoke = JSON.parse(fs.readFileSync(smokeFile, "utf8")) as any;
  const phases = value.phases;
  const expectedBytes = Number(value.request.payload_bytes);
  const expectedFiles = Number(value.request.files);
  const expectedLoc = Number(value.request.expected_loc);
  const oracles = [phases.first_structure_walk.oracle, phases.warm_structure_walk.oracle, phases.watcher_start_reconcile.oracle, phases.watcher_steady_audit_structure.oracle, phases.watcher_restart_offline_replace.oracle];
  const oracleConsistent = oracles.every((item: any) => item.files === expectedFiles && Number(item.bytes) === expectedBytes && item.loc === expectedLoc && item.oversize === 0 && item.contentOk === expectedFiles && item.skip === 0);
  const maxRssKib = Math.max(...Object.values(phases).map((item: any) => Number(item.max_rss_kib ?? 0)));
  const smokeExpectedBytes = Number(smoke.request.payload_bytes);
  const smokeExpectedFiles = Number(smoke.request.files);
  const smokeExpectedLoc = Number(smoke.request.expected_loc);
  const smokeOracles = [smoke.phases.first_structure_walk.oracle, smoke.phases.warm_structure_walk.oracle, smoke.phases.watcher_start_reconcile.oracle, smoke.phases.watcher_steady_audit_structure.oracle, smoke.phases.watcher_restart_offline_replace.oracle];
  const smokeVerified = smoke.status === "complete"
    && smokeOracles.every((item: any) => item.files === smokeExpectedFiles && Number(item.bytes) === smokeExpectedBytes && item.loc === smokeExpectedLoc && item.oversize === 0 && item.contentOk === smokeExpectedFiles && item.skip === 0)
    && Number(smoke.phases.security_content_scan.disk_read_bytes) === smokeExpectedBytes
    && Number(smoke.phases.license_content_scan.disk_read_bytes) === smokeExpectedBytes
    && smoke.cleanup.verified === true && smoke.cleanup.removed === true;
  return {
    evidence_file: path.relative(root, file).replace(/\\/g, "/"),
    evidence_sha256: sha256File(file),
    script_sha256: sha256File(path.join(root, "scripts", "benchmark-volume.mts")),
    refactor_smoke_file: path.relative(root, smokeFile).replace(/\\/g, "/"),
    refactor_smoke_sha256: sha256File(smokeFile),
    refactor_smoke_verified: smokeVerified,
    status: value.status,
    payload_gib: value.request.payload_gib,
    files: expectedFiles,
    loc: expectedLoc,
    oracle_consistent: oracleConsistent,
    disk_read_bytes_complete: Number(phases.security_content_scan.disk_read_bytes) === expectedBytes && Number(phases.license_content_scan.disk_read_bytes) === expectedBytes,
    peak_rss_mib: Math.round((maxRssKib / 1024) * 100) / 100,
    total_duration_seconds: Math.round(((Date.parse(value.finished_at) - Date.parse(value.started_at)) / 1000) * 1000) / 1000,
    warm_walk_seconds: phases.warm_structure_walk.duration_ms / 1000,
    steady_audit_seconds: phases.watcher_steady_audit_structure.duration_ms / 1000,
    snapshot_seconds: phases.snapshot.duration_ms / 1000,
    cleanup_verified: value.cleanup.verified === true && value.cleanup.removed === true,
    evidence_scope: value.environment.note,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const output = safeOutput(args.root, args.output);
  const source = fingerprintProject(args.root);
  const governance = auditGovernance(args.root, 200);
  const quality = latestJson(path.join(args.root, ".pm", "quality-runs"));
  const qualityValue = quality.value as any;
  const security = loadSecurity(args.root);
  const inventory = await mcpInventory(args.root);
  const maintainability = implementationComplexity(args.root);
  const performance = benchmarkMetrics(args.root);
  const testSummary = qualityValue.results?.find((item: any) => item.kind === "test")?.output_summary ?? null;
  const coverageSummary = qualityValue.results?.find((item: any) => item.kind === "coverage")?.output_summary ?? null;
  const readme = fs.readFileSync(path.join(args.root, "README.md"), "utf8");
  const documented = readme.match(/工具清单（(\d+) 个）/)?.[1];
  const evidence = {
    schema_version: 1,
    captured_at: new Date().toISOString(),
    product: JSON.parse(fs.readFileSync(path.join(args.root, "package.json"), "utf8")),
    environment: { platform: process.platform, arch: process.arch, node: process.version, os_release: os.release(), logical_cpus: os.cpus().length, memory_bytes: os.totalmem() },
    source,
    inventory,
    documentation: { documented_tools: documented ? Number(documented) : null, inventory_matches: documented !== undefined && Number(documented) === inventory.tools },
    governance: {
      ok: governance.ok,
      issues: governance.issues.length,
      source_coverage_pct: governance.graph.coverage.sourceCoveragePct,
      semantic_assurance_pct: governance.graph.coverage.semanticAssurancePct,
      ast_files: governance.graph.coverage.astFiles,
      runtime_files: governance.graph.coverage.runtimeFiles,
      heuristic_files: governance.graph.coverage.heuristicFiles,
      fallback_files: governance.graph.analysis.fallbackFiles.length,
      rejected_files: governance.graph.analysis.rejectedFiles.length,
      evidence_errors: governance.graph.analysis.evidenceErrors.length,
      resolution_pct: governance.graph.coverage.resolutionPct,
      unresolved: governance.graph.coverage.unresolvedInternal,
      cycles: governance.graph.cycles.length,
      violations: governance.graph.violations.length,
      analyzer_families: [...new Set(governance.graph.analysis.analyzers.map((item) => item.family))].sort(),
      built_in_ast_languages: ["typescript", "javascript", ...POLYGLOT_AST_LANGUAGES],
    },
    quality: {
      evidence_file: path.relative(args.root, quality.file).replace(/\\/g, "/"),
      evidence_sha256: sha256File(quality.file),
      run_at: qualityValue.run_at,
      ok: qualityValue.ok === true,
      execute: qualityValue.execute === true,
      source_stable: qualityValue.source?.stable === true,
      source_matches_current: qualityValue.source?.after?.sha256 === source.sha256,
      results_total: Array.isArray(qualityValue.results) ? qualityValue.results.length : 0,
      results_passed: Array.isArray(qualityValue.results) ? qualityValue.results.filter((item: any) => item.status === "passed").length : 0,
      failed_or_blocked: Array.isArray(qualityValue.results) ? qualityValue.results.filter((item: any) => item.status !== "passed").length : -1,
      test_summary: testSummary,
      coverage_summary: coverageSummary,
    },
    security: {
      last_scan: security.last_scan,
      open_total: security.findings.filter((item) => item.status === "open").length,
      open_high_or_critical: security.findings.filter((item) => item.status === "open" && item.severity === "high").length,
      accepted_total: security.findings.filter((item) => item.status === "accepted").length,
      accepted_without_note: security.findings.filter((item) => item.status === "accepted" && !item.note.trim()).length,
    },
    maintainability,
    performance,
    metrics: {
      source_files_hashed: source.files,
      mcp_tools: inventory.tools,
      mcp_resources: inventory.resources,
      mcp_prompts: inventory.prompts,
      mcp_inventory_ok: inventory.ok && inventory.names_unique ? 1 : 0,
      documentation_inventory_match: documented !== undefined && Number(documented) === inventory.tools ? 1 : 0,
      governance_ok: governance.ok ? 1 : 0,
      source_coverage_pct: governance.graph.coverage.sourceCoveragePct,
      semantic_assurance_pct: governance.graph.coverage.semanticAssurancePct,
      ast_files: governance.graph.coverage.astFiles,
      heuristic_files: governance.graph.coverage.heuristicFiles,
      fallback_files: governance.graph.analysis.fallbackFiles.length,
      rejected_files: governance.graph.analysis.rejectedFiles.length,
      semantic_evidence_errors: governance.graph.analysis.evidenceErrors.length,
      internal_resolution_pct: governance.graph.coverage.resolutionPct,
      unresolved_references: governance.graph.coverage.unresolvedInternal,
      dependency_cycles: governance.graph.cycles.length,
      governance_violations: governance.graph.violations.length,
      built_in_ast_languages: 2 + POLYGLOT_AST_LANGUAGES.length,
      quality_ok: qualityValue.ok === true ? 1 : 0,
      quality_source_stable: qualityValue.source?.stable === true ? 1 : 0,
      quality_source_matches_current: qualityValue.source?.after?.sha256 === source.sha256 ? 1 : 0,
      quality_failed_or_blocked: Array.isArray(qualityValue.results) ? qualityValue.results.filter((item: any) => item.status !== "passed").length : -1,
      tests_total: Number(testSummary?.tests ?? -1),
      tests_failed: Number(testSummary?.failed ?? -1),
      tests_cancelled: Number(testSummary?.cancelled ?? -1),
      tests_skipped: Number(testSummary?.skipped ?? -1),
      tests_todo: Number(testSummary?.todo ?? -1),
      coverage_lines_pct: Number(coverageSummary?.coverage?.lines_pct ?? -1),
      coverage_branches_pct: Number(coverageSummary?.coverage?.branches_pct ?? -1),
      coverage_functions_pct: Number(coverageSummary?.coverage?.functions_pct ?? -1),
      security_open_total: security.findings.filter((item) => item.status === "open").length,
      security_accepted_without_note: security.findings.filter((item) => item.status === "accepted" && !item.note.trim()).length,
      implementation_files_over_500: maintainability.over_500.length,
      maximum_implementation_lines: maintainability.maximum_lines,
      volume_payload_gib: Number(performance.payload_gib),
      volume_oracle_consistent: performance.oracle_consistent === true ? 1 : 0,
      volume_disk_read_complete: performance.disk_read_bytes_complete === true ? 1 : 0,
      volume_peak_rss_mib: Number(performance.peak_rss_mib),
      volume_total_seconds: Number(performance.total_duration_seconds),
      volume_warm_walk_seconds: Number(performance.warm_walk_seconds),
      volume_steady_audit_seconds: Number(performance.steady_audit_seconds),
      volume_snapshot_seconds: Number(performance.snapshot_seconds),
      volume_cleanup_verified: performance.cleanup_verified === true ? 1 : 0,
      volume_refactor_smoke_verified: performance.refactor_smoke_verified === true ? 1 : 0,
    },
  };
  fs.mkdirSync(path.dirname(output), { recursive: true });
  atomicWrite(output, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify({ output: path.relative(args.root, output).replace(/\\/g, "/"), sha256: sha256File(output), source: source.sha256, governance_ok: governance.ok, quality_ok: evidence.quality.ok }, null, 2));
}

await main();
