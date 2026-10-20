import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { normSep } from "./budget.ts";
import { hashRegularFile } from "./project-fingerprint.ts";
import { ignoreMatcher, projectScanIgnores } from "./scan-policy.ts";

export function projectFilePath(relative: string): string {
  const rel = path.posix.normalize(normSep(relative));
  if (!relative || path.isAbsolute(rel) || /^[a-z]:/i.test(rel) || rel === "." || rel === ".." || rel.startsWith("../")) {
    throw new Error("文件必须是项目内的相对路径");
  }
  return rel;
}

let gitCommandCache: string | null | undefined;

/** PATH 缺 git 的宿主进程（对账 fail-closed 恒红）按常见安装路径兜底解析并缓存。 */
export function resolveGitCommand(): string | null {
  if (gitCommandCache !== undefined) return gitCommandCache;
  const probe = (command: string): boolean =>
    spawnSync(command, ["--version"], { encoding: "utf8", timeout: 5000, windowsHide: true }).status === 0;
  if (probe("git")) {
    gitCommandCache = "git";
  } else if (process.platform === "win32") {
    const where = spawnSync("where", ["git"], { encoding: "utf8", timeout: 5000, windowsHide: true });
    const located = where.status === 0 ? where.stdout.split(/\r?\n/).find(Boolean)?.trim() : undefined;
    const programFiles = process.env["ProgramFiles"] ?? "C:\\Program Files";
    const candidates = [
      ...(located ? [located] : []),
      path.join(programFiles, "Git", "cmd", "git.exe"),
      "C:\\Program Files (x86)\\Git\\cmd\\git.exe",
      path.join(process.env["LOCALAPPDATA"] ?? "", "Programs", "Git", "cmd", "git.exe"),
    ];
    gitCommandCache = candidates.find((candidate) => candidate && fs.existsSync(candidate) && probe(candidate)) ?? null;
  } else {
    gitCommandCache = ["/usr/bin/git", "/usr/local/bin/git", "/opt/homebrew/bin/git"].find((candidate) => probe(candidate)) ?? null;
  }
  return gitCommandCache;
}

/** 仅测试用：清空解析缓存，模拟不同 PATH 环境。 */
export function resetGitCommandCache(): void {
  gitCommandCache = undefined;
}

/** 使用 NUL 分隔，避免中文转义、空格及文件名中的箭头被误解析。 */
export function changedGitFiles(root: string): string[] {
  const excluded = ignoreMatcher(projectScanIgnores(root));
  const git = resolveGitCommand();
  if (!git) throw new Error("找不到 git 可执行文件（PATH 与常见安装路径均未命中），git 对账不可用");
  const result = spawnSync(git, ["status", "--porcelain=v1", "-z", "-uall"], { cwd: root, encoding: "utf8", timeout: 10000, maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(result.error?.message ?? `git status 退出码 ${result.status}`);
  const records = result.stdout.split("\0");
  const changed = new Set<string>();
  const add = (file: string) => {
    const rel = projectFilePath(file);
    const parts = rel.split("/");
    if (
      !rel.startsWith(".pm/") &&
      rel !== "PROJECT.md" &&
      rel !== ".gitignore" &&
      !parts.some((_, index) => excluded(parts.slice(0, index + 1).join("/"), index < parts.length - 1))
    ) changed.add(rel);
  };
  for (let i = 0; i < records.length; i++) {
    const row = records[i];
    if (!row) continue;
    add(row.slice(3));
    const status = row.slice(0, 2);
    if (/[RC]/.test(status)) {
      const original = records[++i]; // -z 先输出目标，再输出原路径
      if (/R/.test(status)) add(original); // 重命名还需要核对旧路径的删除；复制不改原文件
    }
  }
  return [...changed];
}

/** 只对调用者声明的文件流式取摘要，不跟随父目录链接或读取链接指向的内容。 */
export function captureFileHashes(root: string, files: string[]): Record<string, string> {
  const hashes: Record<string, string> = Object.create(null);
  for (const file of files) {
    const rel = projectFilePath(file);
    let current = path.resolve(root);
    let signature = "missing";
    const parts = rel.split("/");
    for (let index = 0; index < parts.length; index++) {
      current = path.join(current, parts[index]);
      let stat: fs.Stats;
      try { stat = fs.lstatSync(current); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") break; throw error; }
      if (stat.isSymbolicLink()) {
        if (index !== parts.length - 1) throw new Error(`文件路径穿过符号链接: ${rel}`);
        signature = `link\0${fs.readlinkSync(current)}`;
      } else if (index === parts.length - 1) {
        if (!stat.isFile()) throw new Error(`会话文件必须是普通文件或已删除文件: ${rel}`);
        signature = `file\0${hashRegularFile(current).sha256}`;
      } else if (!stat.isDirectory()) throw new Error(`文件路径不是目录: ${rel}`);
    }
    hashes[rel] = createHash("sha256").update(signature).digest("hex");
  }
  return hashes;
}
