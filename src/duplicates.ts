import fs from "node:fs";
import path from "node:path";
import { foldLines } from "./budget.ts";
import { ensureFresh, getIndex } from "./index-store.ts";

/**
 * 重复代码检测（零依赖、确定性）：行指纹滑动窗口聚类。
 *
 * 归一化规则：剥离注释（按语言族：// 与 # 、块注释 /* *\/）、字符串字面量内容替换为占位符、
 * 空白折叠——因此注释/空白/字面量文本的差异不算差异，标识符与结构差异才算。
 * 聚类：对每个哈希相同且出现在 ≥2 个文件的窗口做连续对齐合并（成对扩展成长块），
 * 长度 ≥ minLines（有效代码行）的块按长度降序输出。仅跨文件重复计入 v1。
 */

export const DUPLICATE_SOURCE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts",
  ".py", ".go", ".rs", ".java", ".kt", ".kts", ".cs", ".c", ".h", ".cpp", ".hpp",
  ".php", ".rb", ".swift", ".scala", ".vue", ".svelte",
]);

const MAX_FILE_BYTES = 400 * 1024;
const MAX_RUNS = 5000;
const MAX_LOCATIONS_PER_HASH = 8;

export interface DuplicateOptions { minLines?: number; limit?: number; }
export interface DuplicateRange { file: string; start: number; end: number; }
export interface DuplicateGroup { lines: number; members: DuplicateRange[]; }
export interface DuplicateScan {
  scannedFiles: number;
  skippedOversize: number;
  threshold: number;
  groups: DuplicateGroup[];
  truncated: boolean;
  durationMs: number;
}

type CommentStyle = { lineMarkers: string[]; blockOpen: string | null; blockClose: string | null };

const SLASH_STYLE: CommentStyle = { lineMarkers: ["//"], blockOpen: "/*", blockClose: "*/" };
const HASH_STYLE: CommentStyle = { lineMarkers: ["#"], blockOpen: null, blockClose: null };

function styleFor(ext: string): CommentStyle {
  return ext === ".py" || ext === ".rb" ? HASH_STYLE : SLASH_STYLE;
}

interface NormalizedLine { norm: string; line: number; }

/** 单遍扫描：跨行维护块注释与字符串状态；字符串内容丢弃、留一个占位符。 */
function normalizeLines(content: string, style: CommentStyle): NormalizedLine[] {
  const out: NormalizedLine[] = [];
  let inBlock = false;
  let inString: string | null = null;
  let buffer = "";
  let lineNo = 1;
  const flush = (): void => {
    const norm = buffer.replace(/\s+/g, " ").trim();
    if (norm.length > 0) out.push({ norm, line: lineNo });
    buffer = "";
  };
  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    if (ch === "\n") { flush(); lineNo += 1; continue; }
    if (inBlock) {
      if (style.blockClose && content.startsWith(style.blockClose, i)) { inBlock = false; i += style.blockClose.length - 1; }
      continue;
    }
    if (inString) {
      if (ch === "\\") { i += 1; continue; }
      if (ch === inString) inString = null;
      continue;
    }
    if (style.blockOpen && content.startsWith(style.blockOpen, i)) { inBlock = true; i += style.blockOpen.length - 1; continue; }
    if (style.lineMarkers.some((marker) => content.startsWith(marker, i))) {
      while (i < content.length && content[i] !== "\n") i += 1;
      i -= 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { inString = ch; buffer += "s"; continue; }
    buffer += ch;
  }
  flush();
  return out;
}

/** 双 32 位 djb2 变体拼成 64-bit 指纹；跨平台确定性，够抵御行级指纹碰撞。 */
function hashLines(joined: string): string {
  let h1 = 5381;
  let h2 = 52711;
  for (let i = 0; i < joined.length; i++) {
    const code = joined.charCodeAt(i);
    h1 = ((h1 * 33) ^ code) >>> 0;
    h2 = (h2 * 31 + code) >>> 0;
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}

const clamp = (value: number | undefined, min: number, max: number, fallback: number): number => {
  const n = Math.trunc(value ?? fallback);
  return Math.min(max, Math.max(min, Number.isFinite(n) ? n : fallback));
};

interface Run { a: string; b: string; startA: number; startB: number; endA: number; endB: number; len: number; }

export function findDuplicateBlocks(root: string, options: DuplicateOptions = {}): DuplicateScan {
  const started = Date.now();
  const minLines = clamp(options.minLines, 4, 20, 6);
  const limit = clamp(options.limit, 1, 100, 20);
  ensureFresh(root);
  const db = getIndex(root);
  const rows = db.prepare("SELECT rel, size, oversize FROM files WHERE skip = 0").all() as Array<{ rel: string; size: number; oversize: number }>;
  let skippedOversize = rows.filter((row) => row.oversize !== 0).length;

  const normalized = new Map<string, NormalizedLine[]>();
  let scannedFiles = 0;
  for (const row of rows) {
    const ext = path.extname(row.rel).toLowerCase();
    if (!DUPLICATE_SOURCE_EXTENSIONS.has(ext)) continue;
    if (row.oversize !== 0 || row.size > MAX_FILE_BYTES) { skippedOversize += 1; continue; }
    let content: string;
    try { content = fs.readFileSync(path.join(root, row.rel), "utf8"); } catch { continue; }
    normalized.set(row.rel, normalizeLines(content, styleFor(ext)));
    scannedFiles += 1;
  }

  // 窗口指纹 → 位置（按文件名规范排序，保证成对遍历确定性）
  const windows = new Map<string, Array<{ file: string; index: number; line: number }>>();
  for (const [rel, lines] of normalized) {
    if (lines.length < minLines) continue;
    for (let i = 0; i + minLines <= lines.length; i++) {
      const slice = lines.slice(i, i + minLines);
      const key = hashLines(slice.map((item) => item.norm).join("\n"));
      const bucket = windows.get(key);
      if (bucket) bucket.push({ file: rel, index: i, line: slice[0].line });
      else windows.set(key, [{ file: rel, index: i, line: slice[0].line }]);
    }
  }

  // 先按哈希收集全部成对匹配，再按索引排序做连续对齐合并——顺序处理才能拼出完整长块
  const pairMatches = new Map<string, { a: string; b: string; indexA: number; indexB: number }[]>();
  let truncated = false;
  for (const locations of windows.values()) {
    if (locations.length < 2) continue;
    const sorted = [...locations].sort((x, y) => x.file.localeCompare(y.file) || x.index - y.index);
    if (sorted.length > MAX_LOCATIONS_PER_HASH) truncated = true;
    const capped = sorted.slice(0, MAX_LOCATIONS_PER_HASH);
    for (let i = 0; i < capped.length; i++) {
      for (let j = i + 1; j < capped.length; j++) {
        const p = capped[i], q = capped[j];
        if (p.file === q.file) continue; // v1 只报跨文件重复
        const pairKey = p.file < q.file ? `${p.file}\u0000${q.file}` : `${q.file}\u0000${p.file}`;
        const forward = p.file < q.file;
        const match = forward
          ? { a: p.file, b: q.file, indexA: p.index, indexB: q.index }
          : { a: q.file, b: p.file, indexA: q.index, indexB: p.index };
        const list = pairMatches.get(pairKey);
        if (list) list.push(match); else pairMatches.set(pairKey, [match]);
      }
    }
  }

  const pairRuns = new Map<string, Run[]>();
  const runs: Run[] = [];
  for (const [pairKey, matches] of pairMatches) {
    matches.sort((x, y) => x.indexA - y.indexA || x.indexB - y.indexB);
    for (const match of matches) {
      const list = pairRuns.get(pairKey);
      const previous = list?.[list.length - 1];
      if (previous && previous.endA === match.indexA - 1 && previous.endB === match.indexB - 1) {
        previous.endA = match.indexA;
        previous.endB = match.indexB;
        previous.len += 1;
        continue;
      }
      if (runs.length >= MAX_RUNS) { truncated = true; break; }
      const run: Run = { a: match.a, b: match.b, startA: match.indexA, startB: match.indexB, endA: match.indexA, endB: match.indexB, len: 1 };
      if (list) list.push(run); else pairRuns.set(pairKey, [run]);
      runs.push(run);
    }
    if (truncated) break;
  }

  const linesOf = (rel: string): NormalizedLine[] => normalized.get(rel) ?? [];
  const toRange = (file: string, startIndex: number, len: number): DuplicateRange => {
    const lines = linesOf(file);
    const first = lines[startIndex]?.line ?? startIndex + 1;
    const last = lines[Math.min(startIndex + len - 1, lines.length - 1)]?.line ?? first;
    return { file, start: first, end: Math.max(first, last) };
  };
  const groups: DuplicateGroup[] = runs
    .sort((x, y) => y.len - x.len || x.a.localeCompare(y.a) || x.b.localeCompare(y.b) || x.startA - y.startA)
    .slice(0, limit)
    .map((run) => ({
      lines: run.len + minLines - 1,
      members: [toRange(run.a, run.startA, run.len + minLines - 1), toRange(run.b, run.startB, run.len + minLines - 1)],
    }));

  return { scannedFiles, skippedOversize, threshold: minLines, groups, truncated, durationMs: Date.now() - started };
}

export function renderDuplicates(root: string, options: DuplicateOptions = {}, maxLines = 150): string {
  const scan = findDuplicateBlocks(root, options);
  const lines = [
    "## 重复代码",
    `- 扫描: ${scan.scannedFiles} 个源文件（超限跳过 ${scan.skippedOversize}）· 阈值 ≥${scan.threshold} 有效代码行 · 跨文件 · 耗时 ${scan.durationMs}ms`,
  ];
  if (scan.groups.length === 0) lines.push("- ✅ 未发现跨文件重复块");
  else {
    lines.push(`- 共列出 ${scan.groups.length} 组重复（按长度降序${scan.truncated ? "，已达运行上限截断" : ""}）：`);
    scan.groups.forEach((group, index) => {
      const members = group.members.map((m) => `${m.file}:${m.start}-${m.end}`).join(" ↔ ");
      lines.push(`- 组${index + 1}（${group.lines} 行）${members}`);
    });
  }
  return foldLines(lines, { maxLines, hint: "调高 min_lines 只看大块克隆；检测不改变任何台账状态" });
}
