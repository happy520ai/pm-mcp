import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { parseManifestDependencies, type DependencyParseError, type DependencyRef } from "./language-dependencies.ts";
export type { DependencyParseError, DependencyRef } from "./language-dependencies.ts";

export type Language = "javascript" | "typescript" | "python" | "go" | "rust" | "java" | "kotlin" | "csharp";
export type ManifestKind = "node" | "python" | "go" | "rust" | "maven" | "gradle" | "dotnet";
export type QualityKind = "test" | "build" | "lint" | "typecheck" | "coverage" | "security";

export interface ManifestRef {
  kind: ManifestKind;
  path: string;
}

export interface QualityCommand {
  command: string;
  args: string[];
  cwd: string;
  kind: QualityKind;
  requiredExecutable: string;
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface LanguageUnit {
  id: string;
  root: string;
  languages: Language[];
  manifest: ManifestRef[];
  dependencies: DependencyRef[];
  dependencyErrors: DependencyParseError[];
  qualityCommands: QualityCommand[];
}

export interface QualityCoverageAssessment {
  totalUnits: number;
  unitsWithCommands: number;
  withoutCommands: string[];
  languages: Language[];
  commandKinds: QualityKind[];
  coveragePct: number;
}

export interface DiscoveryOptions {
  maxDepth?: number;
  ignoreDirs?: Iterable<string>;
}

const DEFAULT_IGNORE_DIRS = new Set([
  ".git", ".pm", ".idea", ".vscode", ".venv", "venv", "env", "__pycache__",
  "node_modules", "dist", "build", "out", "target", ".gradle", ".next", ".nuxt",
  ".output", ".turbo", "coverage", ".cache",
]);

const LANGUAGE_ORDER: Language[] = [
  "javascript", "typescript", "python", "go", "rust", "java", "kotlin", "csharp",
];
const KIND_ORDER: QualityKind[] = ["test", "build", "lint", "typecheck", "coverage", "security"];
const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_OUTPUT_BYTES = 64 * 1024;

function normalize(value: string): string {
  return value.replace(/\\/g, "/");
}

function manifestKind(name: string): ManifestKind | null {
  const lower = name.toLowerCase();
  if (lower === "package.json") return "node";
  if (lower === "pyproject.toml" || /^requirements(?:[-_.][^.]+)?\.txt$/i.test(name)) return "python";
  if (lower === "go.mod") return "go";
  if (name === "Cargo.toml") return "rust";
  if (lower === "pom.xml") return "maven";
  if (/^(?:build|settings)\.gradle(?:\.kts)?$/i.test(name)) return "gradle";
  if (/\.(?:sln|csproj)$/i.test(name)) return "dotnet";
  return null;
}

function readJson(file: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("root is not an object");
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new Error(`Cannot parse manifest ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function packageManager(unitRoot: string, repositoryRoot: string, pkg: Record<string, unknown>): string {
  const declared = typeof pkg.packageManager === "string" ? pkg.packageManager.split("@")[0].trim() : "";
  if (["npm", "pnpm", "yarn", "bun"].includes(declared)) return declared;
  let cursor = unitRoot;
  while (true) {
    if (fs.existsSync(path.join(cursor, "pnpm-lock.yaml"))) return "pnpm";
    if (fs.existsSync(path.join(cursor, "yarn.lock"))) return "yarn";
    if (fs.existsSync(path.join(cursor, "bun.lock")) || fs.existsSync(path.join(cursor, "bun.lockb"))) return "bun";
    if (cursor === repositoryRoot) break;
    const parent = path.dirname(cursor);
    const relativeParent = path.relative(repositoryRoot, parent);
    if (parent === cursor || relativeParent.startsWith("..") || path.isAbsolute(relativeParent)) break;
    cursor = parent;
  }
  return "npm";
}

function nodeToolInvocation(manager: string): { executable: string; prefix: string[] } {
  if (process.platform === "win32" && manager === "npm") {
    const candidates = [
      process.env.npm_execpath,
      path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    ].filter((candidate): candidate is string => Boolean(candidate));
    const cli = candidates.find((candidate) => fs.existsSync(candidate));
    if (cli) return { executable: process.execPath, prefix: [cli] };
  }
  return { executable: manager, prefix: [] };
}

function repositoryWrapper(
  unitRoot: string,
  repositoryRoot: string,
  posixName: string,
  windowsName: string,
): string | null {
  const names = process.platform === "win32" ? [windowsName, posixName] : [posixName, windowsName];
  let cursor = unitRoot;
  while (true) {
    for (const name of names) {
      const candidate = path.join(cursor, name);
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    }
    if (cursor === repositoryRoot) break;
    const parent = path.dirname(cursor);
    const relativeParent = path.relative(repositoryRoot, parent);
    if (parent === cursor || relativeParent.startsWith("..") || path.isAbsolute(relativeParent)) break;
    cursor = parent;
  }
  return null;
}

function command(
  cwd: string,
  kind: QualityKind,
  executable: string,
  args: string[],
  requiredExecutable = executable,
): QualityCommand {
  return {
    command: executable,
    args: [...args],
    cwd,
    kind,
    requiredExecutable,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    maxOutputBytes: DEFAULT_OUTPUT_BYTES,
  };
}

function nodeCommands(unitRoot: string, repositoryRoot: string, packageFile: string): QualityCommand[] {
  let pkg: Record<string, unknown>;
  try {
    pkg = readJson(packageFile);
  } catch {
    return [];
  }
  const scripts = pkg.scripts && typeof pkg.scripts === "object" && !Array.isArray(pkg.scripts)
    ? pkg.scripts as Record<string, unknown>
    : {};
  const manager = packageManager(unitRoot, repositoryRoot, pkg);
  const invocation = nodeToolInvocation(manager);
  const out: QualityCommand[] = [];
  // Deliberately exact and closed: arbitrary lifecycle scripts never enter the plan.
  for (const kind of KIND_ORDER) {
    if (typeof scripts[kind] === "string" && scripts[kind].trim()) {
      out.push(command(unitRoot, kind, invocation.executable, [...invocation.prefix, "run", kind], manager));
    }
  }
  return out;
}

function pythonCommands(unitRoot: string, manifests: ManifestRef[]): QualityCommand[] {
  const pyproject = manifests.find((m) => path.basename(m.path).toLowerCase() === "pyproject.toml");
  const out = [command(unitRoot, "test", "python", ["-m", "pytest"], "python")];
  if (!pyproject) return out;
  const text = fs.readFileSync(pyproject.path, "utf8");
  if (/^\s*\[build-system\]\s*$/m.test(text)) out.push(command(unitRoot, "build", "python", ["-m", "build"], "python"));
  if (/^\s*\[tool\.ruff(?:\.|\])/.test(text) || /^\s*\[tool\.ruff(?:\.|\])/m.test(text)) {
    out.push(command(unitRoot, "lint", "python", ["-m", "ruff", "check", "."], "python"));
  }
  if (/^\s*\[tool\.mypy(?:\.|\])/.test(text) || /^\s*\[tool\.mypy(?:\.|\])/m.test(text)) {
    out.push(command(unitRoot, "typecheck", "python", ["-m", "mypy", "."], "python"));
  }
  if (/^\s*\[tool\.coverage(?:\.|\])/m.test(text) || /pytest-cov/.test(text)) {
    out.push(command(unitRoot, "coverage", "python", ["-m", "coverage", "run", "-m", "pytest"], "python"));
  }
  if (/^\s*\[tool\.bandit(?:\.|\])/m.test(text) || /pip-audit/.test(text)) {
    out.push(command(unitRoot, "security", "python", ["-m", "bandit", "-r", "."], "python"));
  }
  return out;
}

function commandsForUnit(unitRoot: string, repositoryRoot: string, manifests: ManifestRef[]): QualityCommand[] {
  const out: QualityCommand[] = [];
  const byKind = (kind: ManifestKind): ManifestRef[] => manifests.filter((m) => m.kind === kind);

  for (const pkg of byKind("node")) out.push(...nodeCommands(unitRoot, repositoryRoot, pkg.path));
  if (byKind("python").length > 0) out.push(...pythonCommands(unitRoot, byKind("python")));
  if (byKind("go").length > 0) {
    out.push(command(unitRoot, "test", "go", ["test", "./..."]));
    out.push(command(unitRoot, "build", "go", ["build", "./..."]));
    out.push(command(unitRoot, "lint", "go", ["vet", "./..."]));
    out.push(command(unitRoot, "coverage", "go", ["test", "-coverprofile=coverage.out", "./..."]));
  }
  if (byKind("rust").length > 0) {
    out.push(command(unitRoot, "test", "cargo", ["test", "--all-targets"]));
    out.push(command(unitRoot, "build", "cargo", ["build"]));
    out.push(command(unitRoot, "lint", "cargo", ["clippy", "--all-targets", "--", "-D", "warnings"]));
    out.push(command(unitRoot, "typecheck", "cargo", ["check"]));
  }
  if (byKind("maven").length > 0) {
    const wrapper = repositoryWrapper(unitRoot, repositoryRoot, "mvnw", "mvnw.cmd");
    const executable = wrapper ?? "mvn";
    out.push(command(unitRoot, "test", executable, ["-B", "test"], executable));
    out.push(command(unitRoot, "build", executable, ["-B", "-DskipTests", "package"], executable));
  }
  if (byKind("gradle").length > 0) {
    const wrapper = repositoryWrapper(unitRoot, repositoryRoot, "gradlew", "gradlew.bat");
    const executable = wrapper ?? "gradle";
    out.push(command(unitRoot, "test", executable, ["test"], executable));
    out.push(command(unitRoot, "build", executable, ["build"], executable));
  }
  const dotnet = byKind("dotnet");
  if (dotnet.length > 0) {
    const target = dotnet.find((m) => m.path.toLowerCase().endsWith(".sln")) ?? dotnet[0];
    const rel = path.relative(unitRoot, target.path) || path.basename(target.path);
    out.push(command(unitRoot, "test", "dotnet", ["test", rel]));
    out.push(command(unitRoot, "build", "dotnet", ["build", rel]));
  }

  const seen = new Set<string>();
  return out.filter((item) => {
    const key = JSON.stringify([item.kind, item.command, item.args, item.cwd]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));
}

function languagesFor(unitRoot: string, manifests: ManifestRef[]): Language[] {
  const found = new Set<Language>();
  for (const item of manifests) {
    switch (item.kind) {
      case "node": {
        found.add("javascript");
        try {
          const pkg = readJson(item.path);
          const allDeps = { ...asRecord(pkg.dependencies), ...asRecord(pkg.devDependencies) };
          if (fs.existsSync(path.join(unitRoot, "tsconfig.json")) || "typescript" in allDeps) found.add("typescript");
        } catch {
          if (fs.existsSync(path.join(unitRoot, "tsconfig.json"))) found.add("typescript");
        }
        break;
      }
      case "python": found.add("python"); break;
      case "go": found.add("go"); break;
      case "rust": found.add("rust"); break;
      case "maven": found.add("java"); break;
      case "gradle":
        found.add("java");
        if (item.path.toLowerCase().endsWith(".kts")) found.add("kotlin");
        break;
      case "dotnet": found.add("csharp"); break;
    }
  }
  return LANGUAGE_ORDER.filter((lang) => found.has(lang));
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/**
 * Recursively discovers manifest-bearing project units. Node workspace packages are
 * naturally separate units because each workspace package.json is discovered.
 */
export function discoverProjectUnits(root: string, options: DiscoveryOptions = {}): LanguageUnit[] {
  const repositoryRoot = path.resolve(root);
  const stat = fs.statSync(repositoryRoot);
  if (!stat.isDirectory()) throw new Error(`Project root is not a directory: ${repositoryRoot}`);
  const maxDepth = options.maxDepth ?? 64;
  if (!Number.isInteger(maxDepth) || maxDepth < 0) throw new Error("maxDepth must be a non-negative integer");
  const ignored = new Set([...DEFAULT_IGNORE_DIRS, ...(options.ignoreDirs ?? [])]);
  const grouped = new Map<string, ManifestRef[]>();

  const walk = (dir: string, depth: number): void => {
    if (depth > maxDepth) throw new Error(`Manifest discovery exceeded maxDepth=${maxDepth}: ${dir}`);
    const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!ignored.has(entry.name)) walk(absolute, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const kind = manifestKind(entry.name);
      if (!kind) continue;
      const list = grouped.get(dir) ?? [];
      list.push({ kind, path: absolute });
      grouped.set(dir, list);
    }
  };
  walk(repositoryRoot, 0);

  return [...grouped.entries()].map(([unitRoot, manifest]) => {
    manifest.sort((a, b) => a.path.localeCompare(b.path));
    const relative = normalize(path.relative(repositoryRoot, unitRoot));
    const dependencyResult = parseManifestDependencies(manifest);
    return {
      id: relative || ".",
      root: unitRoot,
      languages: languagesFor(unitRoot, manifest),
      manifest,
      ...dependencyResult,
      qualityCommands: commandsForUnit(unitRoot, repositoryRoot, manifest),
    };
  }).sort((a, b) => a.id.localeCompare(b.id));
}

export function createQualityPlan(units: readonly LanguageUnit[]): QualityCommand[] {
  return units.flatMap((unit) => unit.qualityCommands.map((item) => ({ ...item, args: [...item.args] })));
}

export function assessQualityCoverage(units: readonly LanguageUnit[]): QualityCoverageAssessment {
  const covered = units.filter((unit) => unit.qualityCommands.length > 0);
  const languages = new Set<Language>();
  const commandKinds = new Set<QualityKind>();
  for (const unit of units) {
    for (const language of unit.languages) languages.add(language);
    for (const item of unit.qualityCommands) commandKinds.add(item.kind);
  }
  return {
    totalUnits: units.length,
    unitsWithCommands: covered.length,
    withoutCommands: units.filter((unit) => unit.qualityCommands.length === 0).map((unit) => unit.id),
    languages: LANGUAGE_ORDER.filter((language) => languages.has(language)),
    commandKinds: KIND_ORDER.filter((kind) => commandKinds.has(kind)),
    coveragePct: units.length === 0 ? 0 : Math.round((covered.length / units.length) * 100),
  };
}

export type QualityRunStatus = "planned" | "passed" | "failed" | "missing" | "timed_out" | "blocked";

export interface QualityCommandResult {
  command: QualityCommand;
  status: QualityRunStatus;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  durationMs: number;
  error?: string;
}

export interface QualityPlanResult {
  execute: boolean;
  ok: boolean;
  results: QualityCommandResult[];
}

export interface RunQualityPlanOptions {
  /** Execution is opt-in. Omitted/false returns a plan without starting processes. */
  execute?: boolean;
  /** Fail closed and do not run later commands after the first failure (default true). */
  stopOnFailure?: boolean;
}

function executableExists(executable: string): boolean {
  if (!executable.trim() || /[\r\n\0]/.test(executable)) return false;
  const hasPath = path.isAbsolute(executable) || executable.includes("/") || executable.includes("\\");
  const candidates: string[] = [];
  if (hasPath) candidates.push(path.resolve(executable));
  else {
    const pathDirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
    const extensions = process.platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
      : [""];
    for (const dir of pathDirs) {
      for (const ext of extensions) candidates.push(path.join(dir.replace(/^"|"$/g, ""), executable + ext));
      candidates.push(path.join(dir.replace(/^"|"$/g, ""), executable));
    }
  }
  return candidates.some((candidate) => {
    try {
      const st = fs.statSync(candidate);
      if (!st.isFile()) return false;
      if (process.platform !== "win32") fs.accessSync(candidate, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

function validateCommand(item: QualityCommand): string | null {
  if (!item.command.trim() || /[\r\n\0]/.test(item.command)) return "invalid command";
  if (!Array.isArray(item.args) || item.args.some((arg) => typeof arg !== "string" || /\0/.test(arg))) return "invalid args";
  if (!path.isAbsolute(item.cwd) || !fs.existsSync(item.cwd) || !fs.statSync(item.cwd).isDirectory()) return "invalid cwd";
  if (!Number.isFinite(item.timeoutMs) || item.timeoutMs < 1 || item.timeoutMs > 60 * 60_000) return "invalid timeoutMs";
  if (!Number.isFinite(item.maxOutputBytes) || item.maxOutputBytes < 1 || item.maxOutputBytes > 16 * 1024 * 1024) return "invalid maxOutputBytes";
  return null;
}

function baseResult(item: QualityCommand, status: QualityRunStatus): QualityCommandResult {
  return { command: item, status, exitCode: null, signal: null, stdout: "", stderr: "", truncated: false, durationMs: 0 };
}

async function runOne(item: QualityCommand): Promise<QualityCommandResult> {
  const invalid = validateCommand(item);
  if (invalid) return { ...baseResult(item, "failed"), error: invalid };
  if (!executableExists(item.requiredExecutable)) {
    return { ...baseResult(item, "missing"), error: `Required executable not found: ${item.requiredExecutable}` };
  }

  const started = Date.now();
  return await new Promise<QualityCommandResult>((resolve) => {
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let used = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;
    const capture = (stream: "stdout" | "stderr", chunk: Buffer): void => {
      const remaining = Math.max(0, item.maxOutputBytes - used);
      if (chunk.length > remaining) truncated = true;
      const kept = chunk.subarray(0, remaining);
      used += kept.length;
      if (stream === "stdout") stdout = Buffer.concat([stdout, kept]);
      else stderr = Buffer.concat([stderr, kept]);
    };
    let timer: NodeJS.Timeout | undefined;
    const finish = (result: QualityCommandResult): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ ...result, stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8"), truncated, durationMs: Date.now() - started });
    };

    // shell:false is intentional: arguments never undergo shell parsing.
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(item.command, item.args, { cwd: item.cwd, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      finish({ ...baseResult(item, err.code === "ENOENT" ? "missing" : "failed"), error: err.message });
      return;
    }
    child.stdout?.on("data", (chunk: Buffer) => capture("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer) => capture("stderr", chunk));
    child.once("error", (error: NodeJS.ErrnoException) => {
      finish({
        ...baseResult(item, error.code === "ENOENT" ? "missing" : "failed"),
        error: error.message,
      });
    });
    child.once("close", (code, signal) => {
      const status: QualityRunStatus = timedOut ? "timed_out" : code === 0 ? "passed" : "failed";
      finish({ ...baseResult(item, status), exitCode: code, signal });
    });
    timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, item.timeoutMs);
    timer.unref();
  });
}

/** Runs a plan only when execute:true. Missing tools, timeout and non-zero exits all make ok=false. */
export async function runQualityPlan(
  plan: readonly QualityCommand[],
  options: RunQualityPlanOptions = {},
): Promise<QualityPlanResult> {
  if (!options.execute) {
    return { execute: false, ok: true, results: plan.map((item) => baseResult(item, "planned")) };
  }
  const results: QualityCommandResult[] = [];
  const stopOnFailure = options.stopOnFailure ?? true;
  for (let index = 0; index < plan.length; index++) {
    const result = await runOne(plan[index]);
    results.push(result);
    if (result.status !== "passed" && stopOnFailure) {
      for (const blocked of plan.slice(index + 1)) {
        results.push({ ...baseResult(blocked, "blocked"), error: "Blocked by an earlier failed quality command" });
      }
      break;
    }
  }
  return { execute: true, ok: results.every((result) => result.status === "passed"), results };
}
