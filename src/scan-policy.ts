import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { globToRegExp, normSep } from "./budget.ts";

export const SCAN_IGNORE_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", ".next", ".nuxt", ".output", ".turbo", "coverage",
  "__pycache__", ".venv", "venv", "env", ".pm", ".idea", ".vscode", "target", ".cache", ".gradle",
  ".zcode", ".runtime", "EBWebView",
  // 包管理器缓存 / 运行时数据 / 临时与上下文目录：属于环境而非项目源码（T-045）
  ".pnpm-cache", ".pnpm-store", ".npm-cache", ".yarn-cache", ".data", ".tmp", ".temp",
  ".codex-context", "userdata", "logs",
]);

export const ScanIgnoreSchema = z.array(z.string().trim().min(1).max(512).transform(normSep).refine(
  (glob) => !glob.startsWith("/") && !glob.startsWith("!") && !/^[a-z]:/i.test(glob) && !glob.split("/").includes(".."),
  "扫描排除必须是项目内的正向相对 glob",
)).max(100);

export function projectScanIgnores(root: string): string[] {
  const file = path.join(root, ".pm", "project.json");
  let raw: string;
  try { raw = fs.readFileSync(file, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  return [...new Set(ScanIgnoreSchema.parse(JSON.parse(raw).scan_ignore ?? []))].sort();
}

export function ignoreMatcher(globs: string[]): (rel: string, directory?: boolean) => boolean {
  const patterns = globs.map(globToRegExp);
  return (rel, directory = false) => patterns.some((pattern) => pattern.test(rel) || (directory && pattern.test(`${rel}/`)));
}

export function scanExclusionNote(root: string): string[] {
  const ignores = projectScanIgnores(root);
  return ignores.length ? [`扫描范围排除：${ignores.join(", ")}；排除内容不属于本次检查结论。`] : [];
}
