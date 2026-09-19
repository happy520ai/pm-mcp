import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { foldLines } from "./budget.ts";

/**
 * 公开代码反查（GitHub Code Search，联网，显式确认后才会发起请求）。
 *
 * 与 audit_osv 的本质差异：OSV 只发包名/版本，本工具会把一段**真实代码行**发到
 * GitHub——因此门控更强：confirm 必须显式为 true，且片段来自用户显式传入的
 * snippet 参数或 file+line 选择（在客户端审批界面全程可见）。
 * 仅做精确短语匹配：命中 ≠ 侵权结论，私有仓库不可见，配额 10 次/分钟。
 */

const GITHUB_SEARCH_ENDPOINT = "https://api.github.com/search/code";
const MIN_SNIPPET = 8;
const MAX_QUERY_CHARS = 200;

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface PublicSearchArgs { snippet?: string; file?: string; line?: number; maxResults?: number; token?: string; timeoutMs?: number; tokenResolver?: () => string; fetcher?: FetchLike; }
export interface PublicSearchHit { repo: string; path: string; url: string; }
export interface PublicSearchResult { snippet: string; totalCount: number; hits: PublicSearchHit[]; truncated: boolean; durationMs: number; }

/** 解析要外发的片段：显式 snippet 优先；否则 file（+可选 line，缺省取最长行）。 */
export function resolveSnippet(root: string, args: PublicSearchArgs): string {
  if (args.snippet !== undefined && args.snippet !== "") {
    const snippet = args.snippet.replace(/\s+/g, " ").trim();
    if (snippet.length < MIN_SNIPPET) throw new Error(`片段太短（≥${MIN_SNIPPET} 字符），太短会命中海量无关仓库。`);
    if (args.file !== undefined) throw new Error("snippet 与 file 二选一。");
    return snippet;
  }
  if (args.file !== undefined) {
    const absolute = path.resolve(root, args.file);
    if (absolute !== root && !absolute.startsWith(root + path.sep)) throw new Error("file 必须位于项目根内。");
    const raw = fs.readFileSync(absolute, "utf8");
    const lines = raw.split(/\r?\n/);
    const index = args.line === undefined
      ? lines.reduce((best, line, i) => (line.trim().length > (lines[best]?.trim().length ?? 0) ? i : best), 0)
      : args.line - 1;
    const line = lines[index];
    if (line === undefined) throw new Error(`行号越界：${args.file} 共 ${lines.length} 行，第 ${args.line ?? 0} 行不存在。`);
    const snippet = line.replace(/\s+/g, " ").trim();
    if (snippet.length < MIN_SNIPPET) throw new Error(`选中的行太短（≥${MIN_SNIPPET} 字符）：${snippet.slice(0, 40)}`);
    return snippet.slice(0, MAX_QUERY_CHARS);
  }
  throw new Error("需要 snippet 或 file 之一：确认要外发到 GitHub 的代码片段。");
}

function resolveToken(explicit?: string): string {
  if (explicit) return explicit;
  const fromEnv = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  if (fromEnv) return fromEnv;
  const gh = spawnSync("gh", ["auth", "token"], { encoding: "utf8", windowsHide: true });
  const fromGh = gh.status === 0 ? gh.stdout.trim() : "";
  if (fromGh) return fromGh;
  throw new Error("未找到 GitHub 凭据：设置 GH_TOKEN/GITHUB_TOKEN，或先 gh auth login。");
}

export async function searchPublicCode(root: string, args: PublicSearchArgs = {}): Promise<PublicSearchResult> {
  const started = Date.now();
  const snippet = resolveSnippet(root, args);
  const token = args.tokenResolver ? args.tokenResolver() : resolveToken(args.token);
  const fetcher = args.fetcher ?? (globalThis.fetch as unknown as FetchLike);
  const maxResults = Math.min(30, Math.max(1, Math.trunc(args.maxResults ?? 10)));
  // GitHub REST code search 是词项检索（不支持带引号短语）：按空白拆词、去掉引号后以 AND 语义提交。
  const query = snippet.replace(/"/g, " ").split(/\s+/).filter(Boolean).join(" ");
  const response = await fetcher(`${GITHUB_SEARCH_ENDPOINT}?q=${encodeURIComponent(query)}&per_page=${maxResults}`, {
    method: "GET",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "user-agent": "pm-mcp-public-search (single-line provenance lookup)",
      "x-github-api-version": "2022-11-28",
    },
    signal: AbortSignal.timeout(args.timeoutMs ?? 30_000),
  });
  if (response.status === 401) throw new Error("GitHub token 无效（401）。");
  if (response.status === 403) throw new Error("GitHub 拒绝（403）：可能触发了 code search 限流（10 次/分钟）或 token 权限不足。");
  if (response.status === 422) throw new Error("GitHub 拒绝查询（422）：短语可能不合法，换一段更普通的行试试。");
  if (!response.ok) throw new Error(`GitHub Code Search 失败：HTTP ${response.status}`);
  const payload = JSON.parse(await response.text()) as {
    total_count?: unknown;
    items?: Array<{ repository?: { full_name?: unknown }; path?: unknown; html_url?: unknown }>;
  };
  const items = Array.isArray(payload.items) ? payload.items : [];
  const hits = items.slice(0, maxResults).map((item) => ({
    repo: typeof item.repository?.full_name === "string" ? item.repository.full_name : "unknown",
    path: typeof item.path === "string" ? item.path : "",
    url: typeof item.html_url === "string" ? item.html_url : "",
  }));
  const totalCount = typeof payload.total_count === "number" ? payload.total_count : hits.length;
  return { snippet: snippet.slice(0, MAX_QUERY_CHARS), totalCount, hits, truncated: totalCount > hits.length, durationMs: Date.now() - started };
}

export function renderPublicSearch(result: PublicSearchResult, maxLines = 150): string {
  const lines = [
    "## 公开代码反查（GitHub Code Search，联网完成）",
    `- 外发片段（已确认）: "${result.snippet}"`,
    `- 命中: ${result.totalCount} 处（列出前 ${result.hits.length}${result.truncated ? "，已截断" : ""}）· 耗时 ${result.durationMs}ms`,
  ];
  for (const hit of result.hits) lines.push(`- 命中 ${hit.repo} · ${hit.path}${hit.url ? ` · ${hit.url}` : ""}`);
  if (result.hits.length === 0) lines.push("- ✅ 公开索引中未发现相同代码行");
  lines.push("> 命中是字面相同，不是侵权结论：可能是同一开源出处、常见写法或独立实现。私有仓库不可见；配额 10 次/分钟。");
  return foldLines(lines, { maxLines, hint: "换更长或更独特的行可提高区分度" });
}
