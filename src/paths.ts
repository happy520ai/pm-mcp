import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { randomUUID } from "node:crypto";

/** 客户端注入的工作区提示：部分客户端（如 Qoder）拉起 MCP 子进程时 cwd 是安装目录，工作区只存在于环境变量 */
export const WORKSPACE_HINT_ENV_VARS = ["QODER_WORKER_CWD"] as const;

/** 启动期适配器交下来的工作区提示与它的真实来历（适配器自己解析的，不能再报成 --root） */
export const ROOT_HINT_ENV_VAR = "PM_MCP_ROOT_HINT";
export const ROOT_HINT_SOURCE_ENV_VAR = "PM_MCP_ROOT_HINT_SOURCE";

/** 解析依据是给人核验用的自由文本：既包含固定来源，也包含「哪个会话日志/是否启动期定格」这类动态说明 */
export type RootSource = "--root" | "PM_ROOT" | "cwd" | (typeof WORKSPACE_HINT_ENV_VARS)[number] | (string & {});

/** 配置里写了 ${VAR} 但客户端没有插值时，这种字面量不能当路径用 */
function unexpanded(value: string): boolean {
  return value.includes("${") || value.includes("}");
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function usable(value: string | undefined): value is string {
  return !!value && value.trim().length > 0 && !unexpanded(value.trim());
}

function workspaceHints(): Array<{ name: RootSource; value: string }> {
  const out: Array<{ name: RootSource; value: string }> = [];
  for (const name of WORKSPACE_HINT_ENV_VARS) {
    const value = process.env[name]?.trim();
    if (value && !unexpanded(value)) out.push({ name, value });
  }
  return out;
}

/** 解析项目根并报告依据，供启动横幅与 get_status 核验 */
export function resolveRootWithSource(explicit?: string): { root: string; source: RootSource } {
  const flag = explicit?.trim();
  if (usable(flag)) return { root: path.resolve(flag), source: "--root" };
  const pmRoot = process.env.PM_ROOT?.trim();
  if (usable(pmRoot)) return { root: path.resolve(pmRoot), source: "PM_ROOT" };
  const hint = process.env[ROOT_HINT_ENV_VAR]?.trim();
  if (usable(hint) && isDir(hint)) {
    const basis = process.env[ROOT_HINT_SOURCE_ENV_VAR]?.trim() || ROOT_HINT_ENV_VAR;
    return { root: path.resolve(hint), source: `${basis}(spawn-time)` };
  }
  const cwd = process.cwd();
  if (isInitialized(cwd)) return { root: path.resolve(cwd), source: "cwd" };
  const hints = workspaceHints();
  const chosen = hints.find((h) => isInitialized(h.value)) ?? hints.find((h) => isDir(h.value));
  if (chosen) return { root: path.resolve(chosen.value), source: chosen.name };
  return { root: path.resolve(cwd), source: "cwd" };
}

/** 服务端启动时定格的一次解析；get_status 用它自证项目根从哪来 */
let startupResolution: { root: string; source: RootSource } | null = null;

export function recordRootResolution(resolution: { root: string; source: RootSource }): void {
  startupResolution = resolution;
}

export function rootResolution(): { root: string; source: RootSource } | null {
  return startupResolution;
}

/** 项目根解析顺序：--root 参数 > PM_ROOT > 已初始化的启动目录 > 客户端工作区提示 > 当前工作目录 */
export function resolveRoot(explicit?: string): string {
  return resolveRootWithSource(explicit).root;
}


export const PM_DIR = ".pm";

export function pmPath(root: string, ...segs: string[]): string {
  return path.join(root, PM_DIR, ...segs);
}

export const PROJECT_JSON = "project.json";
export const ROADMAP_JSON = "roadmap.json";
export const TASKS_JSON = "tasks.json";
export const FEATURES_JSON = "features.json";
export const SESSIONS_JSON = "sessions.json";
export const DEBUGLOG_JSON = "debuglog.json";
export const FILE_NOTES_JSON = "file-notes.json";
export const SECURITY_JSON = "security.json";
export const DECISIONS_DIR = "decisions";
export const SNAPSHOTS_DIR = "snapshots";
export const EXTRA_RULES_FILE = "security-rules.json";

export function decisionsDir(root: string): string {
  return pmPath(root, DECISIONS_DIR);
}

export function snapshotsDir(root: string): string {
  return pmPath(root, SNAPSHOTS_DIR);
}

/** 仓库根目录下自动生成的仪表盘 */
export function dashboardFile(root: string): string {
  return path.join(root, "PROJECT.md");
}

/** 全局项目注册表（跨项目查询用）；PM_MCP_HOME 可重定向（测试/多环境隔离用） */
export function registryFile(): string {
  const home = process.env.PM_MCP_HOME?.trim() || os.homedir();
  return path.join(home, ".pm-mcp", "registry.json");
}

export function isInitialized(root: string): boolean {
  return fs.existsSync(pmPath(root, PROJECT_JSON));
}

export function requireInitialized(root: string): void {
  if (!isInitialized(root)) {
    throw new Error(
      `项目未初始化（在 ${root} 下没有找到 ${PM_DIR}/${PROJECT_JSON}）。请先调用 init_project。`,
    );
  }
}

export function ensurePmDirs(root: string): void {
  fs.mkdirSync(pmPath(root), { recursive: true });
  fs.mkdirSync(decisionsDir(root), { recursive: true });
  fs.mkdirSync(snapshotsDir(root), { recursive: true });
  ensurePmRuntimeIgnored(root);
}

/** 本机协调/缓存状态必须留在 .pm 内共享，但绝不能进入项目 Git。 */
export function ensurePmRuntimeIgnored(root: string): void {
  const directory = pmPath(root);
  fs.mkdirSync(directory, { recursive: true });
  fs.mkdirSync(path.join(directory, ".runtime", "idempotency"), { recursive: true });
  const file = path.join(directory, ".gitignore");
  const required = [".lock", ".runtime/", "benchmarks/", "index.db*", "usage-log*.jsonl*", "runtime-log*.jsonl*"];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    const lines = current.split(/\r?\n/).map((line) => line.trim());
    const missing = required.filter((entry) => !lines.includes(entry));
    if (missing.length === 0) return;
    const separator = current.length === 0 || current.endsWith("\n") ? "" : "\n";
    const content = `${current}${separator}${missing.join("\n")}\n`;
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    fs.writeFileSync(temporary, content, "utf8");
    try {
      fs.renameSync(temporary, file);
    } catch (error) {
      try { fs.rmSync(temporary, { force: true }); } catch { /* best effort */ }
      const converged = fs.existsSync(file) && required.every((entry) =>
        fs.readFileSync(file, "utf8").split(/\r?\n/).map((line) => line.trim()).includes(entry));
      if (converged) return;
      if (attempt === 2) throw error;
    }
  }
}
