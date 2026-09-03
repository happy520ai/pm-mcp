import fs from "node:fs";
import path from "node:path";
import { foldLines } from "./budget.ts";
import { loadGovernance, type GovernanceFile } from "./governance-model.ts";
import { assessQualityCoverage, createQualityPlan, discoverProjectUnits, type LanguageUnit, type QualityCommand } from "./language-adapters.ts";
import { buildSemanticGraph, moduleForFile, type SemanticGraph } from "./semantic-graph.ts";
import { loadAllSemanticEvidence } from "./semantic-evidence-store.ts";

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
    `关系: files ${graph.files.length} · file edges ${graph.fileEdges.length} · module edges ${graph.moduleEdges.length} · contracts ${graph.contracts.length} · cycles ${graph.cycles.length}`,
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
