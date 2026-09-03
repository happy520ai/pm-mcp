import path from "node:path";
import fs from "node:fs";
import os from "node:os";

/** 项目根解析顺序：--root 参数 > PM_ROOT 环境变量 > 当前工作目录 */
export function resolveRoot(explicit?: string): string {
  const raw = explicit?.trim() || process.env.PM_ROOT?.trim() || process.cwd();
  return path.resolve(raw);
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
}
