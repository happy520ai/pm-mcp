import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { budgetLines, toolI, toolR, toolW } from "./tool-base.ts";
import { foldLines } from "./budget.ts";
import { refreshDerived } from "./dashboard.ts";
import { requireInitialized } from "./paths.ts";
import {
  initGovernance,
  loadGovernance,
  saveGovernance,
  type GovernanceFile,
  type InterfaceSpec,
  type ModuleSpec,
  type RepositorySpec,
} from "./governance-model.ts";
import { auditGovernance } from "./governance-audit.ts";
import { impactAnalysis } from "./semantic-graph.ts";
import { assessQualityCoverage, createQualityPlan, discoverProjectUnits, runQualityPlan, type QualityCommand } from "./language-adapters.ts";
import { buildPortfolioFromRegistry, buildPortfolioReport, loadPortfolioProject } from "./portfolio.ts";
import { saveQualityRun } from "./quality-store.ts";
import { SemanticEvidenceDocumentSchema } from "./semantic-evidence.ts";
import { listSemanticEvidence, saveSemanticEvidence } from "./semantic-evidence-store.ts";
import { fingerprintProject } from "./project-fingerprint.ts";

const id = z.string().trim().min(1);
const texts = z.array(z.string().trim().min(1));
const moduleInput = {
  id,
  name: z.string().trim().min(1),
  roots: texts.min(1),
  kind: z.string().trim().min(1),
  owners: texts,
  languages: texts,
  public_interfaces: texts.optional(),
  depends_on: texts.optional(),
  allowed_dependencies: texts.optional(),
  denied_dependencies: texts.optional(),
};

function replaceById<T extends { id: string }>(items: T[], value: T): void {
  const index = items.findIndex((item) => item.id === value.id);
  if (index >= 0) items[index] = value;
  else items.push(value);
}

function compactGovernance(governance: GovernanceFile): string {
  const lines = [
    `治理 schema v${governance.schema_version}`,
    `modules ${governance.modules.length} · interfaces ${governance.interfaces.length} · repositories ${governance.repositories.length}`,
    `policies: ownership=${governance.policies.enforce_ownership} · declared=${governance.policies.enforce_declared_dependencies} · public=${governance.policies.enforce_public_interfaces} · unresolved=${governance.policies.fail_on_unresolved} · coverage>=${governance.policies.minimum_coverage_pct}% · semantic>=${governance.policies.minimum_semantic_assurance} · regex-fallback=${governance.policies.fail_on_semantic_fallback ? "forbidden" : "allowed"} · quality=${governance.policies.required_quality_kinds.join(",")}`,
  ];
  for (const module of governance.modules) {
    lines.push(`- ${module.id} [${module.kind}] roots=${module.roots.join(",")} owners=${module.owners.join(",") || "无"} languages=${module.languages.join("+") || "无"} depends=${module.depends_on.join(",") || "无"}`);
  }
  for (const item of governance.interfaces) lines.push(`- interface ${item.id} ${item.kind}@${item.version}: ${item.provider} -> ${item.consumers.join(",") || "无消费者"}`);
  for (const repo of governance.repositories) lines.push(`- repository ${repo.id}@${repo.version}: ${repo.root} -> ${repo.dependencies.map((dependency) => `${dependency.repository}@${dependency.constraint}`).join(",") || "无依赖"}`);
  return foldLines(lines, { maxLines: 150, hint: "用 upsert_module/upsert_interface/upsert_repository 分项维护" });
}

function qualityPlan(root: string, unit?: string, kinds?: string[]): { commands: QualityCommand[]; coverage: ReturnType<typeof assessQualityCoverage> } {
  const units = discoverProjectUnits(root);
  const coverage = assessQualityCoverage(units);
  const selectedUnits = unit ? units.filter((item) => item.id === unit) : units;
  if (unit && selectedUnits.length === 0) throw new Error(`找不到质量单元 ${unit}。现有: ${units.map((item) => item.id).join(", ") || "无"}`);
  let commands = createQualityPlan(selectedUnits);
  if (kinds?.length) commands = commands.filter((command) => kinds.includes(command.kind));
  return { commands, coverage };
}

function qualityLines(commands: QualityCommand[]): string[] {
  return commands.map((command, index) => `${index + 1}. [${command.kind}] (${command.cwd}) ${command.command} ${command.args.join(" ")}`);
}

export function registerGovernanceTools(server: McpServer, root: string): void {
  toolI(server, root, "init_governance", "为旧项目初始化 .pm/governance.json；新项目 init_project 已自动创建。", {}, () => {
    requireInitialized(root);
    const governance = initGovernance(root, {});
    refreshDerived(root);
    return `✅ 治理模型已初始化（schema v${governance.schema_version}）。下一步用 upsert_module 声明模块、owner 与语言。`;
  });

  toolR(server, root, "get_governance", "查看结构化模块、owner、公开接口、仓库依赖与强制策略。", {}, () => {
    requireInitialized(root);
    return compactGovernance(loadGovernance(root));
  });

  toolW<ModuleSpec>(server, root, "upsert_module", "新增或完整替换一个治理模块；root/owner/language/依赖边均经 schema 对账。", moduleInput, (args) => {
    requireInitialized(root);
    const governance = loadGovernance(root);
    const value: ModuleSpec = {
      ...args,
      public_interfaces: args.public_interfaces ?? [],
      depends_on: args.depends_on ?? [],
      allowed_dependencies: args.allowed_dependencies ?? [],
      denied_dependencies: args.denied_dependencies ?? [],
    };
    replaceById(governance.modules, value);
    saveGovernance(root, governance);
    refreshDerived(root);
    return `✅ module ${value.id} 已保存（roots ${value.roots.length}，owners ${value.owners.length}，languages ${value.languages.length}）。`;
  });

  toolW<InterfaceSpec>(server, root, "upsert_interface", "新增或替换跨模块公开接口及契约文件、provider/consumers、版本。", {
    id,
    kind: z.string().trim().min(1),
    provider: id,
    consumers: texts,
    contract_files: texts,
    version: z.string().trim().min(1),
  }, (args) => {
    requireInitialized(root);
    const governance = loadGovernance(root);
    if (!governance.modules.some((module) => module.id === args.provider)) throw new Error(`provider module 不存在: ${args.provider}`);
    for (const module of governance.modules) module.public_interfaces = module.public_interfaces.filter((item) => item !== args.id);
    governance.modules.find((module) => module.id === args.provider)!.public_interfaces.push(args.id);
    replaceById(governance.interfaces, args);
    saveGovernance(root, governance);
    refreshDerived(root);
    return `✅ interface ${args.id}@${args.version} 已保存：${args.provider} -> ${args.consumers.join(",") || "无消费者"}。`;
  });

  toolW<RepositorySpec>(server, root, "upsert_repository", "登记当前组合视图中的仓库、版本及跨仓 semver 约束。", {
    id,
    name: z.string().trim().min(1),
    root: z.string().trim().min(1),
    version: z.string().trim().min(1),
    dependencies: z.array(z.object({ repository: id, constraint: z.string().trim().min(1) })),
  }, (args) => {
    requireInitialized(root);
    const governance = loadGovernance(root);
    replaceById(governance.repositories, args);
    saveGovernance(root, governance);
    refreshDerived(root);
    return `✅ repository ${args.id}@${args.version} 已保存（依赖 ${args.dependencies.length}）。`;
  });

  toolW<Partial<GovernanceFile["policies"]>>(server, root, "set_governance_policies", "更新治理强制策略；未传字段保持原值。", {
    enforce_ownership: z.boolean().optional(),
    enforce_declared_dependencies: z.boolean().optional(),
    fail_on_unresolved: z.boolean().optional(),
    enforce_public_interfaces: z.boolean().optional(),
    minimum_coverage_pct: z.number().min(0).max(100).optional(),
    minimum_semantic_assurance: z.enum(["heuristic", "ast", "runtime"]).optional(),
    fail_on_semantic_fallback: z.boolean().optional(),
    required_quality_kinds: z.array(z.enum(["test", "build", "lint", "typecheck", "coverage", "security"])).optional(),
  }, (args) => {
    requireInitialized(root);
    const governance = loadGovernance(root);
    governance.policies = { ...governance.policies, ...args };
    saveGovernance(root, governance);
    refreshDerived(root);
    return `✅ 治理策略已更新：coverage>=${governance.policies.minimum_coverage_pct}% · semantic>=${governance.policies.minimum_semantic_assurance} · regex-fallback=${governance.policies.fail_on_semantic_fallback ? "forbidden" : "allowed"}`;
  });

  toolR(server, root, "discover_languages", "递归发现 Node/Python/Go/Rust/JVM/.NET 单元及其受控质量命令，不执行命令。", {}, () => {
    requireInitialized(root);
    const units = discoverProjectUnits(root);
    const coverage = assessQualityCoverage(units);
    const lines = [`发现 ${units.length} 个语言单元；质量命令覆盖 ${coverage.coveragePct}%（${coverage.unitsWithCommands}/${coverage.totalUnits}）`];
    for (const unit of units) lines.push(`- ${unit.id}: ${unit.languages.join("+") || "未知"} · manifests ${unit.manifest.map((item) => path.basename(item.path)).join(",")} · deps ${unit.dependencies.length} · dep-errors ${unit.dependencyErrors.length} · commands ${unit.qualityCommands.map((item) => item.kind).join(",") || "无"}`);
    if (coverage.withoutCommands.length) lines.push(`- 🚩 无质量命令: ${coverage.withoutCommands.join(", ")}`);
    return foldLines(lines, { maxLines: budgetLines(root), hint: "按模块拆分治理 root" });
  });

  toolR(server, root, "audit_governance", "审计跨文件/模块/语言语义覆盖、owner、公开接口、依赖边界、循环、unresolved 与质量矩阵覆盖。", {}, () => {
    requireInitialized(root);
    return auditGovernance(root, budgetLines(root)).report;
  });

  toolR(server, root, "list_semantic_evidence", "列出已登记的语言原生 AST、编译器或运行时语义证据；损坏文档会使整次读取失败。", {}, () => {
    requireInitialized(root);
    return JSON.stringify(listSemanticEvidence(root), null, 2);
  });

  toolI<{ id: string; document: unknown }>(server, root, "save_semantic_evidence", "保存一份绑定源码 SHA-256 的语言原生 AST/编译器/运行时证据；过期摘要在治理审计中严格失败。", {
    id: z.string().trim().min(1).max(128),
    document: SemanticEvidenceDocumentSchema,
  }, (args) => {
    requireInitialized(root);
    const saved = saveSemanticEvidence(root, args.id, args.document);
    return `✅ semantic evidence ${args.id} 已保存：${saved.file} · ${saved.analyzer.id} · ${saved.analyzer.assurance} · ${saved.status}`;
  });

  toolR<{ files: string[] }>(server, root, "impact_analysis", "从变更文件沿 file/module 反向依赖闭包计算受影响文件与模块。", {
    files: z.array(z.string().min(1)).min(1).max(100),
  }, (args) => {
    requireInitialized(root);
    const audit = auditGovernance(root, budgetLines(root));
    const impact = impactAnalysis(audit.graph, args.files);
    return foldLines([
      `变更 ${impact.changedFiles.length} · 受影响文件 ${impact.impactedFiles.length} · 模块 ${impact.impactedModules.length}`,
      `模块: ${impact.impactedModules.join(", ") || "无"}`,
      ...impact.dependentFiles.slice(0, 80).map((file) => `- ${file}`),
      ...(impact.unknownChangedFiles.length ? [`⚠️ 未进入语义图: ${impact.unknownChangedFiles.join(", ")}`] : []),
    ], { maxLines: budgetLines(root), hint: "缩小 files 输入或按模块运行" });
  });

  toolR<{ unit?: string; kinds?: Array<"test" | "build" | "lint" | "typecheck" | "coverage" | "security"> }>(server, root, "plan_quality_matrix", "生成跨语言真实质量命令计划；只规划，不启动进程。", {
    unit: z.string().optional(),
    kinds: z.array(z.enum(["test", "build", "lint", "typecheck", "coverage", "security"])).optional(),
  }, (args) => {
    requireInitialized(root);
    const plan = qualityPlan(root, args.unit, args.kinds);
    return foldLines([
      `质量矩阵计划 ${plan.commands.length} 条；unit coverage ${plan.coverage.coveragePct}%（plan-only，未执行）`,
      ...qualityLines(plan.commands),
      ...(plan.coverage.withoutCommands.length ? [`🚩 无命令单元: ${plan.coverage.withoutCommands.join(", ")}`] : []),
    ], { maxLines: budgetLines(root), hint: "用 unit/kinds 过滤；真实执行需 run_quality_matrix confirm_execute=true" });
  });

  toolI<{ confirm_execute: boolean; unit?: string; kinds?: Array<"test" | "build" | "lint" | "typecheck" | "coverage" | "security">; stop_on_failure?: boolean }>(server, root, "run_quality_matrix", "显式执行跨语言质量矩阵。只运行受支持适配器生成的 argv，shell=false；缺工具/超时/非零均失败。", {
    confirm_execute: z.literal(true).describe("必须显式为 true；该操作会运行目标项目构建/测试命令"),
    unit: z.string().optional(),
    kinds: z.array(z.enum(["test", "build", "lint", "typecheck", "coverage", "security"])).optional(),
    stop_on_failure: z.boolean().optional(),
  }, async (args) => {
    requireInitialized(root);
    if (args.confirm_execute !== true) throw new Error("必须显式 confirm_execute=true");
    const plan = qualityPlan(root, args.unit, args.kinds);
    if (plan.coverage.withoutCommands.length) throw new Error(`质量矩阵不完整，无命令单元: ${plan.coverage.withoutCommands.join(", ")}`);
    if (plan.commands.length === 0) throw new Error("质量矩阵为空，拒绝制造假绿");
    const sourceBefore = fingerprintProject(root);
    const executed = await runQualityPlan(plan.commands, { execute: true, stopOnFailure: args.stop_on_failure });
    const sourceAfter = fingerprintProject(root);
    const sourceStable = sourceBefore.sha256 === sourceAfter.sha256;
    const result = { ...executed, ok: executed.ok && sourceStable };
    const file = saveQualityRun(root, result, { source_before: sourceBefore, source_after: sourceAfter });
    const lines = [`${result.ok ? "✅" : "🚩"} 质量矩阵 ${result.ok ? "通过" : "失败"}；结果 ${file}`];
    if (!sourceStable) lines.push(`- 🚩 源码在执行期间变化：before=${sourceBefore.sha256} after=${sourceAfter.sha256}`);
    for (const item of result.results) lines.push(`- [${item.status}] ${item.command.kind} ${item.command.cwd} (${item.durationMs}ms${item.exitCode === null ? "" : `, exit ${item.exitCode}`})`);
    return foldLines(lines, { maxLines: budgetLines(root), hint: "查看 .pm/quality-runs 结构化摘要（不落原始输出）" });
  });

  toolR<{ current_only?: boolean }>(server, root, "get_portfolio", "聚合当前项目或全局注册项目的阶段、里程碑、债务、安全、语言、跨仓依赖/版本/cycle；加载失败不能假绿。", {
    current_only: z.boolean().optional(),
  }, (args) => {
    requireInitialized(root);
    const portfolio = args.current_only
      ? buildPortfolioReport({ projects: [loadPortfolioProject(root)], projectsRequested: 1 })
      : buildPortfolioFromRegistry();
    const lines = [
      `${portfolio.ok ? "✅" : "🚩"} portfolio projects ${portfolio.coverage.projects_loaded}/${portfolio.coverage.projects_requested} · failures ${portfolio.coverage.projects_failed} · repo edges ${portfolio.coverage.repository_dependencies} · violations ${portfolio.violations.length}`,
    ];
    for (const project of portfolio.projects) lines.push(`- ${project.name}: ${project.phase || "无阶段"} · milestone active ${project.milestones.active}/${project.milestones.total} · debt ${project.tasks.debt_open} · security ${project.security.open} · languages ${project.languages.join("+") || "无"}`);
    for (const violation of portfolio.violations.slice(0, 20)) lines.push(`- ${violation.severity === "error" ? "🚩" : "⚠️"} [${violation.code}] ${violation.message}`);
    for (const failure of portfolio.projectFailures.slice(0, 10)) lines.push(`- 🚩 load ${failure.name}: ${failure.error}`);
    return foldLines(lines, { maxLines: budgetLines(root), hint: "修复 projectFailures/跨仓版本或循环后重跑" });
  });
}
