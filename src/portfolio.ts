import fs from "node:fs";
import path from "node:path";
import { GovernanceSchema, loadGovernance, type GovernanceFile } from "./governance-model.ts";
import { pmPath, registryFile, snapshotsDir } from "./paths.ts";
import { loadProject, loadRoadmap, loadSecurity, loadTasks } from "./store.ts";
import { RegistrySchema, SnapshotSchema, type Snapshot } from "./types.ts";

export type VersionConstraintStatus = "satisfied" | "mismatch" | "unresolved";

export interface VersionConstraintResult {
  status: VersionConstraintStatus;
  version: string;
  constraint: string;
  reason?: string;
}

interface SemVer {
  major: number;
  minor: number;
  patch: number;
  prerelease: Array<number | string>;
}

const SEMVER_SOURCE = "(?:v)?(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-([0-9A-Za-z.-]+))?(?:\\+[0-9A-Za-z.-]+)?";
const SEMVER_RE = new RegExp(`^${SEMVER_SOURCE}$`);
const CONSTRAINT_RE = new RegExp(`^(\\^|~|>=|<=|>|<)?\\s*(${SEMVER_SOURCE})$`);

function parseSemVer(value: string): SemVer | null {
  const match = value.trim().match(SEMVER_RE);
  if (!match) return null;
  const prerelease: Array<number | string> = [];
  if (match[4]) {
    for (const identifier of match[4].split(".")) {
      if (!identifier || (/^\d+$/.test(identifier) && identifier.length > 1 && identifier.startsWith("0"))) return null;
      prerelease.push(/^\d+$/.test(identifier) ? Number(identifier) : identifier);
    }
  }
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), prerelease };
}

function compareSemVer(left: SemVer, right: SemVer): number {
  for (const field of ["major", "minor", "patch"] as const) {
    if (left[field] !== right[field]) return left[field] < right[field] ? -1 : 1;
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    return left.prerelease.length === right.prerelease.length ? 0 : left.prerelease.length === 0 ? 1 : -1;
  }
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const a = left.prerelease[index];
    const b = right.prerelease[index];
    if (a === undefined || b === undefined) return a === undefined ? -1 : 1;
    if (a === b) continue;
    if (typeof a === "number" && typeof b === "string") return -1;
    if (typeof a === "string" && typeof b === "number") return 1;
    return a < b ? -1 : 1;
  }
  return 0;
}

function upperBound(operator: "^" | "~", base: SemVer): SemVer {
  if (operator === "~") return { major: base.major, minor: base.minor + 1, patch: 0, prerelease: [] };
  if (base.major > 0) return { major: base.major + 1, minor: 0, patch: 0, prerelease: [] };
  if (base.minor > 0) return { major: 0, minor: base.minor + 1, patch: 0, prerelease: [] };
  return { major: 0, minor: 0, patch: base.patch + 1, prerelease: [] };
}

/** Evaluate the deliberately small, deterministic semver constraint subset. */
export function checkVersionConstraint(version: string, constraint: string): VersionConstraintResult {
  const normalizedConstraint = constraint.trim();
  if (normalizedConstraint === "*") return { status: "satisfied", version, constraint: normalizedConstraint };
  const target = parseSemVer(version);
  if (!target) {
    return { status: "unresolved", version, constraint: normalizedConstraint, reason: `目标版本不是完整 semver: ${version}` };
  }
  const match = normalizedConstraint.match(CONSTRAINT_RE);
  if (!match) {
    return { status: "unresolved", version, constraint: normalizedConstraint, reason: `不支持的版本约束: ${constraint}` };
  }
  const operator = (match[1] || "exact") as "exact" | "^" | "~" | ">=" | "<=" | ">" | "<";
  const base = parseSemVer(match[2]);
  if (!base) {
    return { status: "unresolved", version, constraint: normalizedConstraint, reason: `约束版本不是完整 semver: ${match[2]}` };
  }
  const compared = compareSemVer(target, base);
  let satisfied: boolean;
  switch (operator) {
    case "exact": satisfied = compared === 0; break;
    case ">=": satisfied = compared >= 0; break;
    case "<=": satisfied = compared <= 0; break;
    case ">": satisfied = compared > 0; break;
    case "<": satisfied = compared < 0; break;
    case "^": satisfied = compared >= 0 && compareSemVer(target, upperBound("^", base)) < 0; break;
    case "~": satisfied = compared >= 0 && compareSemVer(target, upperBound("~", base)) < 0; break;
  }
  return { status: satisfied ? "satisfied" : "mismatch", version, constraint: normalizedConstraint };
}

export interface PortfolioProjectSnapshot {
  id: string;
  name: string;
  root: string;
  phase: string;
  milestones: Array<{ status: "planned" | "active" | "done" | "paused" }>;
  tasks: Array<{ status: "backlog" | "todo" | "in_progress" | "blocked" | "done" | "cancelled"; type: "feature" | "refactor" | "fix" | "chore" | "debt" }>;
  findings: Array<{ status: "open" | "fixed" | "accepted"; severity: "high" | "medium" | "low" }>;
  code_snapshot: Pick<Snapshot, "taken_at" | "total_files" | "total_loc"> | null;
  governance: GovernanceFile;
}

export interface ProjectFailure {
  name: string;
  root: string;
  error: string;
}

export interface PortfolioViolation {
  code: "project-load-failed" | "governance-invalid" | "duplicate-repository-id" | "missing-repository-target" | "repository-cycle" | "version-constraint-unresolved" | "version-constraint-mismatch";
  severity: "error" | "warning";
  message: string;
  repository?: string;
  target?: string;
  constraint?: string;
  target_version?: string;
}

export interface RepositoryNode {
  id: string;
  name: string;
  root: string;
  version: string;
  source: string;
}

export interface RepositoryEdge {
  from: string;
  to: string;
  constraint: string;
  target_version?: string;
  status: VersionConstraintStatus | "missing" | "ambiguous";
}

export interface RepositoryGraph {
  repositories: RepositoryNode[];
  dependencies: RepositoryEdge[];
  cycles: string[][];
  violations: PortfolioViolation[];
}

interface GovernanceSource {
  governance: GovernanceFile;
  source: string;
}

function canonicalCycle(cycle: string[]): string {
  const body = cycle.slice(0, -1);
  if (body.length === 0) return "";
  const rotations = body.map((_, index) => [...body.slice(index), ...body.slice(0, index)]);
  rotations.sort((a, b) => a.join("\0").localeCompare(b.join("\0")));
  return [...rotations[0], rotations[0][0]].join(" -> ");
}

function findCycles(ids: string[], adjacency: Map<string, string[]>): string[][] {
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const cycles = new Map<string, string[]>();
  const visit = (id: string): void => {
    state.set(id, 1);
    stack.push(id);
    for (const target of adjacency.get(id) ?? []) {
      if ((state.get(target) ?? 0) === 0) visit(target);
      else if (state.get(target) === 1) {
        const start = stack.lastIndexOf(target);
        const cycle = [...stack.slice(start), target];
        cycles.set(canonicalCycle(cycle), cycle);
      }
    }
    stack.pop();
    state.set(id, 2);
  };
  for (const id of [...ids].sort()) if ((state.get(id) ?? 0) === 0) visit(id);
  return [...cycles.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, cycle]) => cycle);
}

export function buildRepositoryGraph(governances: readonly GovernanceFile[]): RepositoryGraph {
  const violations: PortfolioViolation[] = [];
  const sources: GovernanceSource[] = [];
  governances.forEach((governance, index) => {
    const parsed = GovernanceSchema.safeParse(governance);
    if (!parsed.success) {
      violations.push({
        code: "governance-invalid",
        severity: "error",
        message: `治理模型 ${index + 1} 无效: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`,
      });
    } else {
      sources.push({ governance: parsed.data, source: `governance:${index + 1}` });
    }
  });

  const repositories: RepositoryNode[] = [];
  const specs = new Map<string, Array<{ source: GovernanceSource; repository: GovernanceFile["repositories"][number] }>>();
  for (const source of sources) {
    for (const repository of source.governance.repositories) {
      repositories.push({
        id: repository.id,
        name: repository.name,
        root: repository.root,
        version: repository.version,
        source: source.source,
      });
      const entries = specs.get(repository.id) ?? [];
      entries.push({ source, repository });
      specs.set(repository.id, entries);
    }
  }
  repositories.sort((a, b) => a.id.localeCompare(b.id) || a.source.localeCompare(b.source));
  for (const [id, entries] of specs) {
    if (entries.length > 1) {
      violations.push({ code: "duplicate-repository-id", severity: "error", repository: id, message: `跨治理文件重复 repository ID "${id}"（${entries.length} 处）` });
    }
  }

  const dependencies: RepositoryEdge[] = [];
  const adjacency = new Map<string, string[]>();
  for (const entries of specs.values()) {
    for (const { source, repository } of entries) {
      for (const dependency of repository.dependencies) {
        const targets = specs.get(dependency.repository) ?? [];
        if (targets.length === 0) {
          dependencies.push({ from: repository.id, to: dependency.repository, constraint: dependency.constraint, status: "missing" });
          violations.push({ code: "missing-repository-target", severity: "error", repository: repository.id, target: dependency.repository, constraint: dependency.constraint, message: `仓库 "${repository.id}" 依赖的目标 "${dependency.repository}" 不存在` });
          continue;
        }
        if (targets.length > 1) {
          dependencies.push({ from: repository.id, to: dependency.repository, constraint: dependency.constraint, status: "ambiguous" });
          continue;
        }
        const target = targets[0].repository;
        const checked = checkVersionConstraint(target.version, dependency.constraint);
        dependencies.push({ from: repository.id, to: target.id, constraint: dependency.constraint, target_version: target.version, status: checked.status });
        const adjacent = adjacency.get(repository.id) ?? [];
        adjacent.push(target.id);
        adjacency.set(repository.id, adjacent);
        if (checked.status === "unresolved") {
          const fail = source.governance.policies.fail_on_unresolved;
          violations.push({ code: "version-constraint-unresolved", severity: fail ? "error" : "warning", repository: repository.id, target: target.id, constraint: dependency.constraint, target_version: target.version, message: `仓库 "${repository.id}" → "${target.id}" 版本约束无法解析: ${checked.reason}` });
        } else if (checked.status === "mismatch") {
          violations.push({ code: "version-constraint-mismatch", severity: "error", repository: repository.id, target: target.id, constraint: dependency.constraint, target_version: target.version, message: `仓库 "${repository.id}" 要求 ${dependency.constraint}，目标 "${target.id}" 当前为 ${target.version}` });
        }
      }
    }
  }
  dependencies.sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
  const uniqueIds = [...specs].filter(([, entries]) => entries.length === 1).map(([id]) => id);
  const cycles = findCycles(uniqueIds, adjacency);
  for (const cycle of cycles) {
    violations.push({ code: "repository-cycle", severity: "error", repository: cycle[0], message: `仓库依赖循环: ${cycle.join(" -> ")}` });
  }
  return { repositories, dependencies, cycles, violations };
}

export interface PortfolioRisk {
  code: "open-debt" | "blocked-tasks" | "open-security" | "missing-code-snapshot" | "module-language-missing";
  severity: "error" | "warning";
  project: string;
  count: number;
  message: string;
}

export interface PortfolioProjectSummary {
  id: string;
  name: string;
  root: string;
  phase: string;
  milestones: { total: number; planned: number; active: number; done: number; paused: number };
  tasks: { total: number; open: number; done: number; blocked: number; debt_open: number };
  security: { open: number; high: number; medium: number; low: number };
  modules: number;
  languages: string[];
  code_snapshot: PortfolioProjectSnapshot["code_snapshot"];
}

export interface PortfolioCoverage {
  projects_requested: number;
  projects_loaded: number;
  projects_failed: number;
  governance_files: number;
  code_snapshots: number;
  modules: number;
  modules_with_owners: number;
  languages: Array<{ language: string; modules: number }>;
  repositories: number;
  repository_dependencies: number;
  resolved_repository_dependencies: number;
}

export interface PortfolioReport {
  generated_at: string;
  ok: boolean;
  projects: PortfolioProjectSummary[];
  projectFailures: ProjectFailure[];
  repository_graph: RepositoryGraph;
  coverage: PortfolioCoverage;
  risks: PortfolioRisk[];
  violations: PortfolioViolation[];
}

export interface PortfolioBuildInput {
  projects?: readonly PortfolioProjectSnapshot[];
  governanceFiles?: readonly GovernanceFile[];
  projectFailures?: readonly ProjectFailure[];
  projectsRequested?: number;
}

function countByStatus<T extends { status: string }>(items: readonly T[], status: string): number {
  return items.filter((item) => item.status === status).length;
}

export function buildPortfolioReport(input: PortfolioBuildInput): PortfolioReport {
  const projects = [...(input.projects ?? [])];
  const projectFailures = [...(input.projectFailures ?? [])];
  const governances: GovernanceFile[] = [...(input.governanceFiles ?? [])];
  const seenGovernance = new Set(governances);
  for (const project of projects) {
    if (!seenGovernance.has(project.governance)) {
      governances.push(project.governance);
      seenGovernance.add(project.governance);
    }
  }
  const graph = buildRepositoryGraph(governances);
  const summaries: PortfolioProjectSummary[] = [];
  const risks: PortfolioRisk[] = [];
  for (const project of projects) {
    const openTasks = project.tasks.filter((task) => task.status !== "done" && task.status !== "cancelled");
    const openFindings = project.findings.filter((finding) => finding.status === "open");
    const languages = [...new Set(project.governance.modules.flatMap((module) => module.languages))].sort();
    const debtOpen = openTasks.filter((task) => task.type === "debt").length;
    const blocked = countByStatus(project.tasks, "blocked");
    const high = openFindings.filter((finding) => finding.severity === "high").length;
    const medium = openFindings.filter((finding) => finding.severity === "medium").length;
    const low = openFindings.filter((finding) => finding.severity === "low").length;
    summaries.push({
      id: project.id,
      name: project.name,
      root: project.root,
      phase: project.phase,
      milestones: { total: project.milestones.length, planned: countByStatus(project.milestones, "planned"), active: countByStatus(project.milestones, "active"), done: countByStatus(project.milestones, "done"), paused: countByStatus(project.milestones, "paused") },
      tasks: { total: project.tasks.length, open: openTasks.length, done: countByStatus(project.tasks, "done"), blocked, debt_open: debtOpen },
      security: { open: openFindings.length, high, medium, low },
      modules: project.governance.modules.length,
      languages,
      code_snapshot: project.code_snapshot,
    });
    if (debtOpen > 0) risks.push({ code: "open-debt", severity: "warning", project: project.id, count: debtOpen, message: `${debtOpen} 个未完成债务任务` });
    if (blocked > 0) risks.push({ code: "blocked-tasks", severity: "warning", project: project.id, count: blocked, message: `${blocked} 个阻塞任务` });
    if (openFindings.length > 0) risks.push({ code: "open-security", severity: high > 0 ? "error" : "warning", project: project.id, count: openFindings.length, message: `${openFindings.length} 个未关闭安全发现（高危 ${high}）` });
    if (!project.code_snapshot) risks.push({ code: "missing-code-snapshot", severity: "warning", project: project.id, count: 1, message: "缺少代码快照" });
    const missingLanguage = project.governance.modules.filter((module) => module.languages.length === 0).length;
    if (missingLanguage > 0) risks.push({ code: "module-language-missing", severity: "warning", project: project.id, count: missingLanguage, message: `${missingLanguage} 个模块未声明语言` });
  }
  summaries.sort((a, b) => a.id.localeCompare(b.id));

  const languageCounts = new Map<string, number>();
  const modules = governances.flatMap((governance) => governance.modules);
  for (const module of modules) for (const language of new Set(module.languages)) languageCounts.set(language, (languageCounts.get(language) ?? 0) + 1);
  const projectFailureViolations: PortfolioViolation[] = projectFailures.map((failure) => ({ code: "project-load-failed", severity: "error", message: `项目 "${failure.name}" 加载失败 (${failure.root}): ${failure.error}` }));
  const violations = [...projectFailureViolations, ...graph.violations];
  const coverage: PortfolioCoverage = {
    projects_requested: input.projectsRequested ?? projects.length + projectFailures.length,
    projects_loaded: projects.length,
    projects_failed: projectFailures.length,
    governance_files: governances.length,
    code_snapshots: projects.filter((project) => project.code_snapshot !== null).length,
    modules: modules.length,
    modules_with_owners: modules.filter((module) => module.owners.length > 0).length,
    languages: [...languageCounts].sort(([a], [b]) => a.localeCompare(b)).map(([language, count]) => ({ language, modules: count })),
    repositories: graph.repositories.length,
    repository_dependencies: graph.dependencies.length,
    resolved_repository_dependencies: graph.dependencies.filter((dependency) => dependency.status !== "missing" && dependency.status !== "ambiguous" && dependency.status !== "unresolved").length,
  };
  const ok = violations.every((violation) => violation.severity !== "error") && risks.every((risk) => risk.severity !== "error");
  return { generated_at: new Date().toISOString(), ok, projects: summaries, projectFailures, repository_graph: graph, coverage, risks, violations };
}

function latestSnapshotStrict(root: string): Snapshot | null {
  const dir = snapshotsDir(root);
  if (!fs.existsSync(dir)) return null;
  const names = fs.readdirSync(dir).filter((name) => name.startsWith("snap-") && name.endsWith(".json")).sort();
  if (names.length === 0) return null;
  const file = path.join(dir, names[names.length - 1]);
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`代码快照 JSON 解析失败: ${file}: ${(error as Error).message}`);
  }
  const parsed = SnapshotSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`代码快照数据校验失败: ${file}: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
  }
  return parsed.data;
}

export function loadPortfolioProject(root: string): PortfolioProjectSnapshot {
  const absoluteRoot = path.resolve(root);
  const required = ["project.json", "roadmap.json", "tasks.json", "security.json", "governance.json"];
  const missing = required.filter((file) => !fs.existsSync(pmPath(absoluteRoot, file)));
  if (missing.length > 0) throw new Error(`项目账本缺失: ${missing.map((file) => `.pm/${file}`).join(", ")}`);
  const project = loadProject(absoluteRoot);
  const governance = loadGovernance(absoluteRoot);
  const localRepository = governance.repositories.find((repository) => path.resolve(absoluteRoot, repository.root) === absoluteRoot);
  return {
    id: localRepository?.id ?? `${project.name}@${path.basename(absoluteRoot)}`,
    name: project.name,
    root: absoluteRoot,
    phase: project.phase,
    milestones: loadRoadmap(absoluteRoot).milestones,
    tasks: loadTasks(absoluteRoot).tasks,
    findings: loadSecurity(absoluteRoot).findings,
    code_snapshot: latestSnapshotStrict(absoluteRoot),
    governance,
  };
}

export function buildPortfolioFromRegistry(file = registryFile()): PortfolioReport {
  if (!fs.existsSync(file)) {
    return buildPortfolioReport({ projectFailures: [{ name: "全局注册表", root: file, error: "注册表文件不存在" }], projectsRequested: 1 });
  }
  let registry: ReturnType<typeof RegistrySchema.parse>;
  try {
    registry = RegistrySchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch (error) {
    return buildPortfolioReport({ projectFailures: [{ name: "全局注册表", root: file, error: `注册表损坏: ${(error as Error).message}` }], projectsRequested: 1 });
  }
  const projects: PortfolioProjectSnapshot[] = [];
  const failures: ProjectFailure[] = [];
  for (const entry of registry.projects) {
    try {
      projects.push(loadPortfolioProject(entry.root));
    } catch (error) {
      failures.push({ name: entry.name, root: entry.root, error: (error as Error).message });
    }
  }
  return buildPortfolioReport({ projects, projectFailures: failures, projectsRequested: registry.projects.length });
}
