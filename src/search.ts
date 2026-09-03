import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { loadDebugLog, loadFeatures, loadFileNotes, loadSessions, loadTasks } from "./store.ts";
import { decisionsDir } from "./paths.ts";
import { loadGovernance } from "./governance-model.ts";
import { listFiles, DEFAULT_IGNORE_DIRS } from "./scan.ts";
import { foldLines, globToRegExp, normSep } from "./budget.ts";

/**
 * 求证与检索：search_code（锚定真实代码）+ search_knowledge（历史结论）。
 * token 经济的一部分：返回 file:line 片段而非整文件。
 * 超大项目：检测到 ripgrep 时优先用 rg（并行+SIMD+尊重 .gitignore），
 * 否则回退内置逐文件扫描。
 */

let rgCache: boolean | null = null;
function hasRg(): boolean {
  if (rgCache === null) {
    try {
      rgCache = spawnSync("rg", ["--version"], { timeout: 5000 }).status === 0;
    } catch {
      rgCache = false;
    }
  }
  return rgCache;
}

/** rg 后端：成功返回命中，失败/未安装返回 null（回退内置） */
export function rgSearch(root: string, query: string, glob: string | undefined, maxResults: number, regex: boolean): CodeMatch[] | null {
  if (!hasRg()) return null;
  // 项目根不一定已经 `git init`。显式允许 rg 在非 Git 目录中读取
  // .gitignore，避免同一份项目在初始化 Git 前后出现不同搜索语义。
  const args = ["-i", "-n", "--no-heading", "--no-messages", "--no-require-git", "--max-filesize", "4M"];
  for (const dir of DEFAULT_IGNORE_DIRS) {
    if (dir === ".pm") args.push("-g", "!.pm/**");
    else args.push("-g", `!${dir}/**`);
  }
  args.push("--max-count", String(maxResults * 3));
  if (regex) args.push("-e", query);
  else args.push("-F", query);
  if (glob) args.push("--glob", glob);
  args.push(".");
  const r = spawnSync("rg", args, { cwd: root, encoding: "utf8", timeout: 120_000, maxBuffer: 64 * 1024 * 1024 });
  if (process.env.PM_RG_DEBUG) console.error("[rgSearch]", JSON.stringify({ status: r.status, err: r.error?.message, stdout: (r.stdout ?? "").slice(0, 200), args }));
  if (r.error || r.status === null || r.status > 1) return null;
  const out: CodeMatch[] = [];
  for (const raw of (r.stdout ?? "").split("\n")) {
    // CRLF 文件：rg 输出行尾带 \r，而 JS 正则的 . 不匹配 \r，必须先剥掉
    const line = raw.replace(/\r$/, "");
    if (!line) continue;
    const m = line.match(/^(.*?):(\d+):(.*)$/);
    if (!m) continue;
    out.push({ rel: normSep(m[1]).replace(/^\.\//, ""), line: Number(m[2]), text: m[3].trim().slice(0, 200) });
    if (out.length >= maxResults) break;
  }
  return out;
}

/* --------------------------- 进程内容缓存（超大项目性能） --------------------------- */

const CACHE_LIMIT_BYTES = 32 * 1024 * 1024;
const contentCache = new Map<string, { mtime: number; size: number; bytes: number; content: string }>();
let cacheBytes = 0;
let diskReadFiles = 0;
let diskReadBytes = 0;
let cacheHits = 0;
let contentReadObserver: ((stats: { diskReadFiles: number; diskReadBytes: number; cacheHits: number }) => void) | null = null;

/** 读取文本内容：mtime+size 未变走进程缓存（server 常驻，二次搜索/扫描免重读）。返回 null=不可读/二进制。 */
export function readText(root: string, rel: string, force = false): string | null {
  const abs = path.join(root, rel);
  // 缓存必须按“项目根 + 相对路径”隔离；仅用 rel 会让两个项目在
  // mtime/size 恰好相同时串用彼此内容，安全与许可证扫描会随之失真。
  const cacheKey = `${path.resolve(root)}\0${normSep(rel)}`;
  let st: fs.Stats;
  try {
    st = fs.statSync(abs);
  } catch {
    return null;
  }
  const hit = contentCache.get(cacheKey);
  if (!force && hit && hit.mtime === st.mtimeMs && hit.size === st.size) {
    // LRU touch
    contentCache.delete(cacheKey);
    contentCache.set(cacheKey, hit);
    cacheHits += 1;
    return hit.content;
  }
  if (st.size > 4 * 1024 * 1024) return null; // 单文件上限 4MB
  let content: string;
  try {
    content = fs.readFileSync(abs, "utf8");
  } catch {
    return null;
  }
  if (content.includes("\0")) return null;
  diskReadFiles += 1;
  diskReadBytes += st.size;
  contentReadObserver?.({ diskReadFiles, diskReadBytes, cacheHits });
  if (hit) {
    cacheBytes -= hit.bytes;
    contentCache.delete(cacheKey);
  }
  const bytes = st.size;
  contentCache.set(cacheKey, { mtime: st.mtimeMs, size: st.size, bytes, content });
  cacheBytes += bytes;
  while (cacheBytes > CACHE_LIMIT_BYTES && contentCache.size > 1) {
    const oldest = contentCache.keys().next().value as string;
    const ev = contentCache.get(oldest);
    if (ev) cacheBytes -= ev.bytes;
    contentCache.delete(oldest);
  }
  return content;
}

/** 测试/诊断用：缓存状态 */
export function contentCacheStats(): { files: number; bytes: number; diskReadFiles: number; diskReadBytes: number; cacheHits: number } {
  return { files: contentCache.size, bytes: cacheBytes, diskReadFiles, diskReadBytes, cacheHits };
}

/** 基准/诊断阶段重置读取计数；可同时清空内容缓存，建立独立覆盖口径。 */
export function resetContentReadStats(clearCache = false): void {
  diskReadFiles = 0;
  diskReadBytes = 0;
  cacheHits = 0;
  if (clearCache) {
    contentCache.clear();
    cacheBytes = 0;
  }
}

/** 长时基准可订阅读取进度；正常 MCP 运行不设置 observer，因此不会产生额外输出。 */
export function setContentReadObserver(
  observer: ((stats: { diskReadFiles: number; diskReadBytes: number; cacheHits: number }) => void) | null,
): void {
  contentReadObserver = observer;
}

export interface CodeMatch {
  rel: string;
  line: number;
  text: string;
}

function buildRegex(query: string, regex: boolean): RegExp {
  if (!regex) {
    // 默认字面量：模型/用户输入的 query 不当正则用（灾难回溯会挂起进程）
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(escaped, "i");
  }
  try {
    return new RegExp(query, "i");
  } catch {
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(escaped, "i");
  }
}

export interface SearchCodeResult {
  matches: CodeMatch[];
  purposeHits: string[];
  scannedFiles: number;
  truncated: boolean;
}

export function searchCode(root: string, query: string, glob?: string, maxResults = 30, regex = false): SearchCodeResult {
  const re = buildRegex(query, regex);
  const notes = loadFileNotes(root).notes;
  const purposeHits: string[] = [];
  for (const [rel, note] of Object.entries(notes)) {
    if (re.test(note.purpose)) purposeHits.push(`${rel}（用途: ${note.purpose}）`);
  }

  // 首选 ripgrep（超大项目唯一可行的全库搜索）
  const rg = rgSearch(root, query, glob, maxResults, regex);
  if (rg !== null) {
    return {
      matches: rg.slice(0, maxResults),
      purposeHits: purposeHits.slice(0, 10),
      scannedFiles: -1,
      truncated: rg.length >= maxResults,
    };
  }

  // 内置回退：content:false 只枚举，内容按需经 readText 缓存读取
  const include = glob ? [glob] : undefined;
  const files = listFiles(root, { include, content: false });
  const matches: CodeMatch[] = [];
  let scanned = 0;
  for (const f of files) {
    if (f.isLockfile || f.oversize) continue;
    if (f.rel.startsWith(".pm/")) continue;
    scanned += 1;
    const content = readText(root, f.rel);
    if (content === null) continue;
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) {
        matches.push({ rel: f.rel, line: i + 1, text: lines[i].trim().slice(0, 200) });
        if (matches.length >= maxResults * 3) break;
      }
    }
    if (matches.length >= maxResults * 3) break;
  }
  const truncated = matches.length > maxResults;
  return {
    matches: matches.slice(0, maxResults),
    purposeHits: purposeHits.slice(0, 10),
    scannedFiles: scanned,
    truncated,
  };
}

export function formatCodeSearch(res: SearchCodeResult, query: string, maxLines = 60): string {
  const L: string[] = [];
  const backend = res.scannedFiles < 0 ? "，ripgrep 后端" : `，扫描文本文件 ${res.scannedFiles} 个`;
  L.push(`搜索 "${query}"：命中 ${res.matches.length} 行${res.truncated ? "（已截断，用 glob 缩小范围）" : ""}${backend}。`);
  for (const m of res.matches) {
    L.push(`${m.rel}:${m.line}  ${m.text}`);
  }
  if (res.purposeHits.length > 0) {
    L.push("文件索引命中:");
    L.push(...res.purposeHits);
  }
  if (res.matches.length === 0 && res.purposeHits.length === 0) {
    L.push("（无命中。换个关键词，或先 annotate_file 建立文件用途索引。）");
  }
  return foldLines(L, { maxLines, hint: "用 glob 参数限定文件范围" });
}

/* ------------------------------ 知识检索 ------------------------------ */

export function searchKnowledge(root: string, query: string, maxLines = 80): string {
  const re = buildRegex(query, false);
  const L: string[] = [];
  const hit = (s: string): boolean => re.test(s);

  const { tasks } = loadTasks(root);
  const taskHits = tasks.filter((t) => hit(t.title) || hit(t.detail) || hit(t.result_note) || hit(t.acceptance));
  if (taskHits.length > 0) {
    L.push("### 任务");
    for (const t of taskHits.slice(0, 10)) {
      L.push(`- [${t.status}] ${t.id} ${t.title}${t.result_note ? ` — 结果: ${t.result_note.slice(0, 100)}` : ""}`);
    }
  }

  const { features } = loadFeatures(root);
  const featureHits = features.filter((f) => hit(f.name) || hit(f.description));
  if (featureHits.length > 0) {
    L.push("### 功能");
    for (const f of featureHits.slice(0, 10)) {
      L.push(`- [${f.status}] ${f.id} ${f.name}${f.module ? `（${f.module}）` : ""} — ${f.description.slice(0, 80)}`);
    }
  }

  const { sessions } = loadSessions(root);
  const sessionHits = sessions.filter((s) => hit(s.summary) || s.next_steps.some(hit));
  if (sessionHits.length > 0) {
    L.push("### 会话");
    for (const s of sessionHits.slice(-10).reverse()) {
      L.push(`- ${s.date.slice(0, 10)} [${s.author || "?"}] ${s.summary.slice(0, 120)}`);
    }
  }

  const { entries } = loadDebugLog(root);
  const debugHits = entries.filter((d) => hit(d.symptom) || hit(d.root_cause) || hit(d.fix));
  if (debugHits.length > 0) {
    L.push("### 调试记录");
    for (const d of debugHits.slice(-10).reverse()) {
      L.push(`- ${d.id} ${d.date.slice(0, 10)} 症状: ${d.symptom.slice(0, 60)} → 根因: ${d.root_cause.slice(0, 60)} → 修法: ${d.fix.slice(0, 60)}`);
    }
  }

  const notes = loadFileNotes(root).notes;
  const noteHits = Object.entries(notes).filter(([, n]) => hit(n.purpose) || hit(n.source));
  if (noteHits.length > 0) {
    L.push("### 文件索引");
    for (const [file, n] of noteHits.slice(0, 10)) {
      L.push(`- ${file}: ${n.purpose}${n.source ? `（来源: ${n.source}）` : ""}`);
    }
  }

  try {
    const governance = loadGovernance(root);
    const moduleHits = governance.modules.filter((module) =>
      hit(module.id) || hit(module.name) || module.owners.some(hit) || module.languages.some(hit) || module.roots.some(hit));
    const interfaceHits = governance.interfaces.filter((item) =>
      hit(item.id) || hit(item.kind) || hit(item.provider) || item.consumers.some(hit) || item.contract_files.some(hit));
    const repositoryHits = governance.repositories.filter((repository) =>
      hit(repository.id) || hit(repository.name) || hit(repository.version) || repository.dependencies.some((dependency) => hit(dependency.repository) || hit(dependency.constraint)));
    if (moduleHits.length || interfaceHits.length || repositoryHits.length) {
      L.push("### 模块/接口/仓库治理");
      for (const module of moduleHits.slice(0, 8)) L.push(`- module ${module.id} [${module.kind}] owner=${module.owners.join(",") || "无"} roots=${module.roots.join(",")}`);
      for (const item of interfaceHits.slice(0, 8)) L.push(`- interface ${item.id}@${item.version}: ${item.provider} -> ${item.consumers.join(",") || "无"}`);
      for (const repository of repositoryHits.slice(0, 8)) L.push(`- repository ${repository.id}@${repository.version}`);
    }
  } catch {
    // 旧项目尚未迁移治理模型时，保留原有知识库检索能力。
  }

  // ADR 文件内容检索
  const dir = decisionsDir(root);
  if (fs.existsSync(dir)) {
    const adrHits: string[] = [];
    for (const name of fs.readdirSync(dir).filter((n) => n.endsWith(".md")).sort()) {
      const abs = path.join(dir, name);
      const content = fs.readFileSync(abs, "utf8");
      if (!hit(content) && !hit(name)) continue;
      const lines = content.split("\n");
      const idx = lines.findIndex((l) => hit(l));
      adrHits.push(`- ${name}: ${idx >= 0 ? lines[idx].trim().slice(0, 100) : "（标题命中）"}`);
    }
    if (adrHits.length > 0) {
      L.push("### 架构决策");
      L.push(...adrHits.slice(0, 10));
    }
  }

  if (L.length === 0) {
    L.push(`知识库中无 "${query}" 相关记录。可检索范围：任务/功能/会话/调试记录/文件索引/架构决策/治理模型。`);
  }
  return foldLines(L, { maxLines, hint: "可用更具体的关键词" });
}

export { normSep };
