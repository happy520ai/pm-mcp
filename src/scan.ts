import fs from "node:fs";
import path from "node:path";
import { globToRegExp, normSep } from "./budget.ts";
import { aggregates, getIndex, walkRefresh } from "./index-store.ts";

/**
 * 代码树扫描：低层走查（生成器，内存恒定）+ scanProject 聚合入口。
 * 内容级结果存 SQLite 索引（index-store），未变更文件永不重读。
 * 超大项目保护：>10 万文件不物化 files 数组（聚合与点名走 SQL）。
 */

export const DEFAULT_IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  ".output",
  ".turbo",
  "coverage",
  "__pycache__",
  ".venv",
  "venv",
  "env",
  ".pm",
  ".idea",
  ".vscode",
  "target",
  ".cache",
  ".gradle",
]);

/** 真实目录树不太可能超过 64 层；超限的计数上报，绝不静默丢失 */
export const DEPTH_LIMIT = 64;

export const BINARY_EXTS = new Set([
  "png", "jpg", "jpeg", "gif", "ico", "webp", "bmp", "pdf",
  "zip", "gz", "tar", "7z", "rar", "bz2", "xz",
  "exe", "dll", "so", "dylib", "bin", "class", "jar", "wasm", "pyc", "o", "a",
  "woff", "woff2", "ttf", "eot", "otf",
  "mp3", "mp4", "mov", "avi", "mkv", "wav", "flac",
  "db", "sqlite", "sqlite3", "mdb", "whl", "egg",
  "node", "map",
]);

const LOCKFILES = new Set([
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "npm-shrinkwrap.json",
  "poetry.lock",
  "Pipfile.lock",
  "Cargo.lock",
  "composer.lock",
  "Gemfile.lock",
  "go.sum",
]);

const SKIP_MARKER_PATTERNS = [
  /\.skip\s*\(/,
  /\.only\s*\(/,
  /\bfit\s*\(/,
  /\bxit\s*\(/,
  /\bxdescribe\s*\(/,
  /@unittest\.skip/,
  /@pytest\.mark\.skip/,
  /pytest\.mark\.xfail/,
  /@Ignore\b/,
  /@Disabled\b/,
];

export interface ScannedFile {
  /** 相对路径（/ 分隔） */
  rel: string;
  loc: number;
  ext: string;
  isTest: boolean;
  isLockfile: boolean;
  /** 疑似空测试（无断言或恒真断言） */
  trivialTest: boolean;
  /** 超过扫描大小上限（>2MB）：loc 记 0 但必须点名，否则巨文件逃过复杂度预算 */
  oversize: boolean;
}

export interface ScanResult {
  files: ScannedFile[];
  totalFiles: number;
  totalLoc: number;
  testFiles: number;
  skipMarkers: number;
  trivialTests: string[];
  lockfiles: string[];
  /** 根 package.json / requirements.txt 的直接依赖名 */
  deps: string[];
  /** 依赖版本说明（含 risky 标记） */
  depSpecs: { name: string; version: string; risky: boolean }[];
  warnings: string[];
  /** 增量索引命中数（命中=未重读内容） */
  cacheHits: number;
}

export function extOf(rel: string): string {
  const base = rel.split("/").pop() ?? rel;
  const idx = base.lastIndexOf(".");
  return idx <= 0 ? "" : base.slice(idx + 1).toLowerCase();
}

export function isTestFile(rel: string): boolean {
  if (/\.(test|spec)\.[a-z]+$/i.test(rel)) return true;
  return /(^|\/)(tests?|__tests__|spec)(\/|$)/i.test(rel);
}

export function isLockfile(rel: string): boolean {
  return LOCKFILES.has(rel.split("/").pop() ?? rel);
}

export function countLoc(content: string): number {
  return content.split("\n").length;
}

/**
 * 空测试启发式：
 * ① 恒真断言——必须是独立断言行（行首就是 expect(true)/assert true），任何行数都报；
 * ② 完全无断言——仅小文件（≤30 行）报，大文件可能断言在别的辅助文件里。
 */
export function looksTrivialTest(content: string): boolean {
  const lines = content.split("\n");
  const tautology = /^\s*(?:expect\s*\(\s*(?:true|1)\s*\)|assert\s+(?:True|true)\s*(?:#.*)?$)/;
  if (lines.some((l) => tautology.test(l))) return true;
  if (lines.length > 30) return false;
  const hasAssert = /assert|expect|should\.|\.equal|\.toBe|\.toBeTruthy|unittest|raises?\(/.test(content);
  return !hasAssert;
}

export function countSkipLines(content: string): number {
  let n = 0;
  for (const line of content.split("\n")) {
    if (SKIP_MARKER_PATTERNS.some((re) => re.test(line))) n += 1;
  }
  return n;
}

/** 需要 skip 统计的文件（测试文件 + 主流语言源码） */
export function needsSkipCount(rel: string, isTest: boolean): boolean {
  return isTest || /\.(ts|js|mjs|cjs|py|java)$/.test(rel);
}

export interface WalkOptions {
  /** 附加忽略 glob（相对路径匹配） */
  extraIgnores?: string[];
  /** 只扫这些 glob（不给则全扫） */
  include?: string[];
  maxFileBytes?: number;
  /** true = 即使 mtime/size 未变也重读全部文件内容（独立巡检的 fail-closed 基线） */
  forceContent?: boolean;
  /** false = 只枚举不读内容（供自行读取内容的调用方；loc 等无意义） */
  content?: boolean;
}

/** 走查条目：stat 级信息（不含内容） */
export interface StatEntry {
  rel: string;
  mtime: number;
  size: number;
}

/**
 * 生成器式目录走查：逐个 yield 文件 stat，避免把完整文件树常驻内存。
 * onSkippedDeep 在超深路径被跳过时回调（计数上报用）。
 */
export function* walkStatEntries(
  root: string,
  opts: WalkOptions = {},
  onSkippedDeep?: () => void,
): Generator<StatEntry> {
  const extraRe = (opts.extraIgnores ?? []).map(globToRegExp);
  const includeRe = opts.include?.map(globToRegExp);
  const maxBytes = opts.maxFileBytes ?? 2 * 1024 * 1024;
  void maxBytes;

  const walk = function* (dir: string, depth: number): Generator<StatEntry> {
    if (depth > DEPTH_LIMIT) {
      onSkippedDeep?.();
      return;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      const rel = normSep(path.relative(root, abs));
      if (entry.isDirectory()) {
        if (DEFAULT_IGNORE_DIRS.has(entry.name)) continue;
        if (extraRe.some((re) => re.test(rel))) continue;
        yield* walk(abs, depth + 1);
      } else if (entry.isFile()) {
        if (extraRe.some((re) => re.test(rel))) continue;
        if (includeRe && !includeRe.some((re) => re.test(rel))) continue;
        let st: fs.Stats;
        try {
          st = fs.statSync(abs);
        } catch {
          continue;
        }
        yield { rel, mtime: st.mtimeMs, size: st.size };
      }
    }
  };

  yield* walk(root, 0);
}

/** 只要文件清单（零值字段；调用方自行读取内容） */
export function listFiles(root: string, opts: WalkOptions = {}): ScannedFile[] {
  const out: ScannedFile[] = [];
  for (const e of walkStatEntries(root, opts)) {
    out.push({
      rel: e.rel,
      loc: 0,
      ext: extOf(e.rel),
      isTest: isTestFile(e.rel),
      isLockfile: isLockfile(e.rel),
      trivialTest: false,
      oversize: e.size > 2 * 1024 * 1024,
    });
  }
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

/** 读直接依赖：package.json dependencies/devDependencies + requirements.txt */
export function readDirectDeps(root: string): {
  deps: string[];
  depSpecs: { name: string; version: string; risky: boolean }[];
} {
  const specs: { name: string; version: string; risky: boolean }[] = [];
  const pkgFile = path.join(root, "package.json");
  if (fs.existsSync(pkgFile)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8"));
      for (const section of ["dependencies", "devDependencies", "optionalDependencies"]) {
        const map = pkg[section] ?? {};
        for (const [name, version] of Object.entries(map)) {
          const v = String(version);
          specs.push({ name, version: v, risky: v === "*" || v === "latest" || v === "" });
        }
      }
    } catch {
      /* 非法 package.json 由审计报告提示 */
    }
  }
  const reqFile = path.join(root, "requirements.txt");
  if (fs.existsSync(reqFile)) {
    for (const line of fs.readFileSync(reqFile, "utf8").split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#") || t.startsWith("-")) continue;
      const m = t.match(/^([A-Za-z0-9_.\-\[\]]+)/);
      if (m) specs.push({ name: m[1], version: t.slice(m[1].length).trim(), risky: false });
    }
  }
  return { deps: specs.map((s) => s.name), depSpecs: specs };
}

/** 超过该文件数不再物化 files 数组（防大规模目录内存膨胀；聚合与点名始终可用） */
const MATERIALIZE_LIMIT = 100_000;

/** 完整扫描：走查→SQLite 集合 diff→只读变更文件→SQL 聚合（增量，索引持久化 .pm/index.db） */
export function scanProject(root: string, opts: WalkOptions = {}): ScanResult {
  if (opts.content === false) {
    // 清单模式：不碰索引（调用方要的是"现在"的文件集合）
    const files = listFiles(root, opts);
    return {
      files,
      totalFiles: files.length,
      totalLoc: 0,
      testFiles: files.filter((f) => f.isTest).length,
      skipMarkers: 0,
      trivialTests: [],
      lockfiles: files.filter((f) => f.isLockfile).map((f) => f.rel),
      deps: [],
      depSpecs: [],
      warnings: [],
      cacheHits: 0,
    };
  }
  const walkRes = walkRefresh(root, opts);
  const db = getIndex(root);
  const agg = aggregates(db);
  const { deps, depSpecs } = readDirectDeps(root);
  const warnings: string[] = [];
  if (walkRes.skippedDeep > 0) {
    warnings.push(`${walkRes.skippedDeep} 个路径超过 ${DEPTH_LIMIT} 层深度未扫描（极罕见，请检查目录结构）`);
  }
  const pkgFile = path.join(root, "package.json");
  if (fs.existsSync(pkgFile)) {
    try {
      JSON.parse(fs.readFileSync(pkgFile, "utf8"));
    } catch {
      warnings.push("package.json 不是合法 JSON");
    }
  }
  // 大项目不物化（点名类字段仍是 SQL 结果）
  const files: ScannedFile[] =
    agg.totalFiles <= MATERIALIZE_LIMIT
      ? (db.prepare(`SELECT rel, loc, ext, is_test, is_lock, trivial, oversize FROM files ORDER BY rel`).all() as Array<{
          rel: string; loc: number; ext: string; is_test: number; is_lock: number; trivial: number; oversize: number;
        }>).map((r) => ({
          rel: r.rel,
          loc: r.loc,
          ext: r.ext,
          isTest: r.is_test === 1,
          isLockfile: r.is_lock === 1,
          trivialTest: r.trivial === 1,
          oversize: r.oversize === 1,
        }))
      : [];
  const lockfiles = (db.prepare(`SELECT rel FROM files WHERE is_lock=1 ORDER BY rel LIMIT 100`).all() as Array<{ rel: string }>).map((r) => r.rel);
  return {
    files,
    totalFiles: agg.totalFiles,
    totalLoc: agg.totalLoc,
    testFiles: agg.testFiles,
    skipMarkers: agg.skipMarkers,
    trivialTests: agg.trivialTests,
    lockfiles,
    deps,
    depSpecs,
    warnings,
    cacheHits: walkRes.hits,
  };
}
