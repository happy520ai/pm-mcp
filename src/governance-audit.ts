import fs from "node:fs";
import path from "node:path";
import { foldLines } from "./budget.ts";
import { loadGovernance, type GovernanceFile } from "./governance-model.ts";
import { assessQualityCoverage, createQualityPlan, discoverProjectUnits, type LanguageUnit, type QualityCommand } from "./language-adapters.ts";
import { buildSemanticGraph, moduleForFile, type SemanticGraph } from "./semantic-graph.ts";
import { loadAllSemanticEvidence } from "./semantic-evidence-store.ts";
import { relPath } from "./semantic-parsers.ts";

export interface GovernanceIssue {
  severity: "error" | "warning";
  code: string;
  message: string;
  evidence: string[];
}

export interface GovernanceAudit {
  ok: boolean;
  governance: GovernanceFile;
  graph: SemanticGraph;
  units: LanguageUnit[];
  qualityPlan: QualityCommand[];
  qualityCoverage: ReturnType<typeof assessQualityCoverage>;
  issues: GovernanceIssue[];
  report: string;
}

function languageIssues(governance: GovernanceFile, graph: SemanticGraph): GovernanceIssue[] {
  const issues: GovernanceIssue[] = [];
  for (const module of governance.modules) {
    const matching = graph.files.filter((file) => file.module === module.id && file.status === "parsed");
    const discovered = new Set(matching.map((file) => file.language).filter((language) => language !== "protobuf" && language !== "graphql" && language !== "openapi"));
    if (module.languages.length === 0) {
      issues.push({ severity: "error", code: "module-language-missing", message: `模块 ${module.id} 未声明语言`, evidence: module.roots });
      continue;
    }
    const missing = [...discovered].filter((language) => !module.languages.includes(language));
    if (missing.length > 0) {
      issues.push({
        severity: "error",
        code: "module-language-drift",
        message: `模块 ${module.id} 发现未声明语言: ${missing.join(", ")}`,
        evidence: matching.slice(0, 10).map((file) => `${file.path} => ${file.language}`),
      });
    }
  }
  return issues;
}

function declaredArtifactIssues(root: string, governance: GovernanceFile): GovernanceIssue[] {
  const issues: GovernanceIssue[] = [];
  for (const module of governance.modules) {
    for (const declaredRoot of module.roots) {
      const absolute = path.resolve(root, declaredRoot);
      if (!fs.existsSync(absolute)) {
        issues.push({ severity: "error", code: "module-root-missing", message: `模块 ${module.id} 的 root 不存在: ${declaredRoot}`, evidence: [declaredRoot] });
      } else if (!fs.statSync(absolute).isDirectory()) {
        issues.push({ severity: "error", code: "module-root-not-directory", message: `模块 ${module.id} 的 root 不是目录: ${declaredRoot}`, evidence: [declaredRoot] });
      }
    }
  }
  for (const contract of governance.interfaces) {
    for (const file of contract.contract_files) {
      const absolute = path.resolve(root, file);
      if (!fs.existsSync(absolute)) {
        issues.push({ severity: "error", code: "contract-file-missing", message: `接口 ${contract.id} 的契约文件不存在: ${file}`, evidence: [file] });
        continue;
      }
      const owner = moduleForFile(file, governance.modules);
      if (owner !== contract.provider) {
        issues.push({ severity: "error", code: "contract-provider-mismatch", message: `接口 ${contract.id} 契约文件归属 ${owner ?? "未归属"}，不是 provider ${contract.provider}`, evidence: [file] });
      }
    }
  }
  return issues;
}

function graphIssues(graph: SemanticGraph): GovernanceIssue[] {
  const issues: GovernanceIssue[] = graph.violations.map((violation) => ({
    severity: "error",
    code: violation.type,
    message: `${violation.type}: ${violation.from} -> ${violation.to}`,
    evidence: violation.evidence,
  }));
  for (const cycle of graph.cycles) {
    issues.push({ severity: "error", code: "module-cycle", message: `模块依赖循环: ${cycle.join(" -> ")} -> ${cycle[0]}`, evidence: cycle });
  }
  // 文件级循环通常是 barrel/重导出或真实的循环依赖；比模块环轻，作警告可见。
  for (const cycle of graph.fileCycles.slice(0, 10)) {
    issues.push({ severity: "warning", code: "file-cycle", message: `文件级依赖循环: ${cycle.join(" -> ")} -> ${cycle[0]}`, evidence: cycle });
  }
  if (graph.fileCycles.length > 10) {
    issues.push({ severity: "warning", code: "file-cycle-truncated", message: `文件级依赖循环共 ${graph.fileCycles.length} 个，仅列出前 10 个`, evidence: [] });
  }
  return issues;
}

function render(
  governance: GovernanceFile,
  graph: SemanticGraph,
  units: LanguageUnit[],
  qualityCoverage: ReturnType<typeof assessQualityCoverage>,
  issues: GovernanceIssue[],
  maxLines: number,
): string {
  const errors = issues.filter((issue) => issue.severity === "error");
  const warnings = issues.filter((issue) => issue.severity === "warning");
  const lines = [
    "## 跨文件/模块/语言治理审计",
    `${errors.length === 0 ? "✅" : "🚩"} modules=${governance.modules.length} · interfaces=${governance.interfaces.length} · repositories=${governance.repositories.length} · errors=${errors.length} · warnings=${warnings.length}`,
    `语义覆盖: source ${graph.coverage.sourceCoveragePct}%（${graph.coverage.parsedFiles}/${graph.coverage.sourceCandidateFiles}）· assurance ${graph.coverage.semanticAssurancePct}% · AST ${graph.coverage.astFiles} · runtime ${graph.coverage.runtimeFiles} · heuristic ${graph.coverage.heuristicFiles} · internal resolution ${graph.coverage.resolutionPct}% · unresolved ${graph.coverage.unresolvedInternal}`,
    `关系: files ${graph.files.length} · file edges ${graph.fileEdges.length} · module edges ${graph.moduleEdges.length} · contracts ${graph.contracts.length} · cycles ${graph.cycles.length} · file cycles ${graph.fileCycles.length}`,
    `质量矩阵: units ${qualityCoverage.totalUnits} · covered ${qualityCoverage.unitsWithCommands} · coverage ${qualityCoverage.coveragePct}% · commands ${qualityCoverage.commandKinds.join(", ") || "无"}`,
    `manifest 依赖: ${units.reduce((sum, unit) => sum + unit.dependencies.length, 0)} · parse errors ${units.reduce((sum, unit) => sum + unit.dependencyErrors.length, 0)}`,
    `语言: ${[...new Set(units.flatMap((unit) => unit.languages))].sort().join(", ") || "未发现"}`,
    `> 语义引擎 hybrid-semantic-v2；最低保证 ${governance.policies.minimum_semantic_assurance}，正则 fallback ${governance.policies.fail_on_semantic_fallback ? "禁止" : "允许"}。AST 不能证明动态执行；反射、生成代码和数据驱动分发须补 hash-bound runtime evidence。`,
  ];
  if (qualityCoverage.withoutCommands.length > 0) {
    lines.push(`- 🚩 有 manifest 但没有质量命令的单元: ${qualityCoverage.withoutCommands.join(", ")}`);
  }
  for (const issue of issues.slice(0, 25)) {
    lines.push(`- ${issue.severity === "error" ? "🚩" : "⚠️"} [${issue.code}] ${issue.message}${issue.evidence.length ? ` — ${issue.evidence.slice(0, 3).join(", ")}` : ""}`);
  }
  if (issues.length > 25) lines.push(`…另有 ${issues.length - 25} 个问题未展开`);
  if (graph.coverage.unknownFiles.length > 0) lines.push(`- ⚠️ 未识别文件样例: ${graph.coverage.unknownFiles.slice(0, 8).join(", ")}`);
  if (graph.coverage.skippedFiles.length > 0) lines.push(`- 🚩 未读取/超限文件样例: ${graph.coverage.skippedFiles.slice(0, 8).join(", ")}`);
  return foldLines(lines, { maxLines, hint: "用 impact_analysis 或治理过滤参数缩小范围" });
}

export function auditGovernance(root: string, maxLines = 150): GovernanceAudit {
  const absolute = path.resolve(root);
  const governance = loadGovernance(absolute);
  const graph = buildSemanticGraph(absolute, governance, { semanticEvidence: loadAllSemanticEvidence(absolute) });
  const units = discoverProjectUnits(absolute);
  const qualityPlan = createQualityPlan(units);
  const qualityCoverage = assessQualityCoverage(units);
  const issues = [
    ...declaredArtifactIssues(absolute, governance),
    ...languageIssues(governance, graph),
    ...graphIssues(graph),
  ];
  if (units.length === 0) {
    issues.push({ severity: "error", code: "quality-units-missing", message: "未发现任何受支持语言 manifest，无法建立质量矩阵", evidence: [] });
  }
  if (qualityCoverage.withoutCommands.length > 0) {
    issues.push({ severity: "error", code: "quality-command-missing", message: `${qualityCoverage.withoutCommands.length} 个单元没有质量命令`, evidence: qualityCoverage.withoutCommands });
  }
  for (const unit of units) {
    for (const error of unit.dependencyErrors) {
      issues.push({ severity: "error", code: "dependency-parse-error", message: `依赖清单解析失败 ${unit.id}: ${error.message}`, evidence: [`${error.sourceManifest}${error.line ? `:${error.line}` : ""} (${error.parser})`] });
    }
    const present = new Set(unit.qualityCommands.map((command) => command.kind));
    const missing = governance.policies.required_quality_kinds.filter((kind) => !present.has(kind));
    if (missing.length > 0) {
      issues.push({ severity: "error", code: "quality-kind-missing", message: `质量单元 ${unit.id} 缺少必需门禁: ${missing.join(", ")}`, evidence: unit.manifest.map((item) => item.path) });
    }
  }
  const ok = !issues.some((issue) => issue.severity === "error");
  return { ok, governance, graph, units, qualityPlan, qualityCoverage, issues, report: render(governance, graph, units, qualityCoverage, issues, maxLines) };
}

export interface DependencyGraphArgs { focus?: string; direction?: "deps" | "dependents" | "both"; depth?: number; }

const MAX_CYCLE_LIST = 10;
const MAX_FOCUS_NODES = 80;

/** 依赖图查询：全局摘要（关系/环/枢纽）+ 模块与文件级循环 + 聚焦文件邻域；输出折叠在行预算内。 */
export function dependencyGraphReport(root: string, args: DependencyGraphArgs = {}, maxLines = 150): string {
  const absolute = path.resolve(root);
  const governance = loadGovernance(absolute);
  const graph = buildSemanticGraph(absolute, governance, { semanticEvidence: loadAllSemanticEvidence(absolute) });
  const lines = [
    "## 依赖图",
    `- 关系: files ${graph.files.length} · file edges ${graph.fileEdges.length} · module edges ${graph.moduleEdges.length} · unresolved ${graph.unresolved.length}`,
    `- 环: module cycles ${graph.cycles.length} · file cycles ${graph.fileCycles.length}`,
  ];
  const fanOut = new Map<string, number>();
  const fanIn = new Map<string, number>();
  for (const edge of graph.fileEdges) {
    if (edge.to === null || edge.resolution !== "file") continue;
    fanOut.set(edge.from, (fanOut.get(edge.from) ?? 0) + 1);
    fanIn.set(edge.to, (fanIn.get(edge.to) ?? 0) + 1);
  }
  const hubs = (counts: Map<string, number>): string =>
    [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 5).map(([file, n]) => `${file}(${n})`).join(", ") || "无";
  lines.push(`- 出边枢纽: ${hubs(fanOut)}`);
  lines.push(`- 入边枢纽: ${hubs(fanIn)}`);
  for (const cycle of graph.cycles.slice(0, 5)) lines.push(`- 🔴 模块循环: ${cycle.join(" -> ")} -> ${cycle[0]}`);
  for (const cycle of graph.fileCycles.slice(0, MAX_CYCLE_LIST)) lines.push(`- ⚠️ 文件循环: ${cycle.join(" -> ")} -> ${cycle[0]}`);

  if (args.focus) {
    // focus 可传相对或绝对路径：先解析并转成项目内相对 posix 路径，再与语义图对表。
    const focusRel = relPath(path.relative(absolute, path.resolve(absolute, args.focus)));
    if (!graph.files.some((file) => file.path === focusRel)) {
      lines.push(`- 🚩 聚焦文件不在语义图中（未解析或不在治理范围）: ${focusRel}`);
      return foldLines(lines, { maxLines, hint: "先确认路径在模块 root 下且语言已登记" });
    }
    const forward = new Map<string, string[]>();
    const backward = new Map<string, string[]>();
    for (const edge of graph.fileEdges) {
      if (edge.to === null || edge.resolution !== "file") continue;
      forward.set(edge.from, [...(forward.get(edge.from) ?? []), edge.to]);
      backward.set(edge.to, [...(backward.get(edge.to) ?? []), edge.from]);
    }
    const depth = args.depth ?? 2;
    const walk = (start: string, adjacency: Map<string, string[]>): Map<string, number> => {
      const seen = new Map<string, number>([[start, 0]]);
      let frontier = [start];
      for (let level = 1; level <= depth; level += 1) {
        const next: string[] = [];
        for (const node of frontier) for (const neighbor of adjacency.get(node) ?? []) {
          if (!seen.has(neighbor)) { seen.set(neighbor, level); next.push(neighbor); }
        }
        if (next.length === 0) break;
        frontier = next.sort();
      }
      return seen;
    };
    lines.push(`### 聚焦 ${focusRel}（depth=${depth}）`);
    const sides = [
      { title: "依赖（出边）", adjacency: forward, enabled: args.direction !== "dependents" },
      { title: "被依赖（入边）", adjacency: backward, enabled: args.direction !== "deps" },
    ];
    for (const side of sides) {
      if (!side.enabled) continue;
      const seen = walk(focusRel, side.adjacency);
      const levels = [...seen.entries()].filter(([file]) => file !== focusRel).sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]));
      if (levels.length === 0) { lines.push(`- ${side.title}: 无`); continue; }
      const byLevel = new Map<number, string[]>();
      for (const [file, level] of levels.slice(0, MAX_FOCUS_NODES)) byLevel.set(level, [...(byLevel.get(level) ?? []), file]);
      for (const level of [...byLevel.keys()].sort((a, b) => a - b)) lines.push(`- ${side.title} L${level}: ${byLevel.get(level)!.join(", ")}`);
      if (levels.length > MAX_FOCUS_NODES) lines.push(`  …另有 ${levels.length - MAX_FOCUS_NODES} 个节点未展开（提高 depth 或改用 impact_analysis 反向闭包）`);
    }
    const focusUnresolved = graph.unresolved.filter((edge) => edge.from === focusRel).slice(0, 10).map((edge) => edge.specifier);
    if (focusUnresolved.length > 0) lines.push(`- 未解析引用: ${focusUnresolved.join(", ")}`);
  }
  return foldLines(lines, { maxLines, hint: "用 focus 参数聚焦单个文件，或提高 depth 扩大邻域" });
}
