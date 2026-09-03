import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const DEFAULT_IGNORED_DIRECTORIES = new Set([
  ".git", ".pm", ".cache", ".gradle", ".idea", ".next", ".nuxt", ".output", ".turbo", ".venv", ".vscode", ".zcode",
  "__pycache__", "build", "coverage", "dist", "env", "node_modules", "out", "target", "venv",
]);

export interface ProjectFingerprint {
  algorithm: "sha256-tree-v1";
  sha256: string;
  files: number;
  bytes: number;
}

function hashRegularFile(file: string): { sha256: string; bytes: number } {
  const handle = fs.openSync(file, "r");
  const digest = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    const before = fs.fstatSync(handle);
    if (!before.isFile()) throw new Error(`项目指纹只接受普通文件: ${file}`);
    let offset = 0;
    while (offset < before.size) {
      const read = fs.readSync(handle, buffer, 0, Math.min(buffer.length, before.size - offset), offset);
      if (read === 0) break;
      digest.update(buffer.subarray(0, read));
      offset += read;
    }
    const after = fs.fstatSync(handle);
    if (offset !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      throw new Error(`生成项目指纹时文件发生变化: ${file}`);
    }
    return { sha256: digest.digest("hex"), bytes: before.size };
  } finally {
    fs.closeSync(handle);
  }
}

/**
 * Deterministic content fingerprint for source acceptance when no trusted VCS
 * revision exists. Directory entries are sorted, symlinks are rejected, and
 * generated/cache directories are excluded by an explicit stable policy.
 */
export function fingerprintProject(root: string): ProjectFingerprint {
  const absolute = path.resolve(root);
  const rootStat = fs.lstatSync(absolute);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error(`项目根必须是普通目录: ${absolute}`);
  const rootReal = fs.realpathSync.native(absolute);
  const tree = createHash("sha256");
  let files = 0;
  let bytes = 0;

  const visit = (directory: string, relativeDirectory: string): void => {
    const entries = fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, "en"));
    for (const entry of entries) {
      if (entry.isDirectory() && DEFAULT_IGNORED_DIRECTORIES.has(entry.name)) continue;
      const absoluteEntry = path.join(directory, entry.name);
      const relative = path.posix.join(relativeDirectory.replace(/\\/g, "/"), entry.name);
      if (relative === "PROJECT.md") continue; // generated dashboard; authoritative inputs live in .pm and source files
      const stat = fs.lstatSync(absoluteEntry);
      if (stat.isSymbolicLink()) throw new Error(`项目指纹拒绝符号链接: ${relative}`);
      if (stat.isDirectory()) {
        const real = fs.realpathSync.native(absoluteEntry);
        const escaped = path.relative(rootReal, real);
        if (escaped === ".." || escaped.startsWith(`..${path.sep}`) || path.isAbsolute(escaped)) throw new Error(`目录逃逸项目根: ${relative}`);
        visit(absoluteEntry, relative);
        continue;
      }
      if (!stat.isFile()) throw new Error(`项目指纹拒绝非普通文件: ${relative}`);
      const file = hashRegularFile(absoluteEntry);
      tree.update(relative, "utf8");
      tree.update("\0", "utf8");
      tree.update(String(file.bytes), "utf8");
      tree.update("\0", "utf8");
      tree.update(file.sha256, "ascii");
      tree.update("\n", "utf8");
      files += 1;
      bytes += file.bytes;
    }
  };

  visit(absolute, "");
  return { algorithm: "sha256-tree-v1", sha256: tree.digest("hex"), files, bytes };
}
