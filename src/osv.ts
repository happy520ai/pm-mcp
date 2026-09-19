import { discoverProjectUnits } from "./language-adapters.ts";
import { foldLines } from "./budget.ts";

/**
 * OSV.dev 已知漏洞查询（联网，显式确认后才会发起请求）。
 *
 * 依赖来源是本地 manifest 解析（discoverProjectUnits），只把「包名/版本/生态」
 * 三个字段发给 api.osv.dev querybatch；不发送代码、路径或任何项目内容。
 * 版本为范围声明（^ ~ >=）时按原样精确匹配，可能漏报——在报告中如实声明该边界。
 */

const OSV_ENDPOINT = "https://api.osv.dev/v1/querybatch";
const BATCH_SIZE = 100;

export function ecosystemFor(parser: string): string | null {
  if (parser === "package-json") return "npm";
  if (parser.startsWith("requirements") || parser.startsWith("pyproject")) return "PyPI";
  if (parser.startsWith("go-mod")) return "Go";
  if (parser.startsWith("cargo")) return "crates.io";
  if (parser.startsWith("maven") || parser.startsWith("gradle")) return "Maven";
  if (parser.startsWith("msbuild")) return "NuGet";
  return null;
}

export interface OsvQuery { name: string; version: string; ecosystem: string; sourceManifests: string[]; }

export function collectOsvQueries(root: string): { queries: OsvQuery[]; skippedUnknownEcosystem: number; } {
  const merged = new Map<string, OsvQuery>();
  let skippedUnknownEcosystem = 0;
  for (const unit of discoverProjectUnits(root)) {
    for (const dep of unit.dependencies) {
      const ecosystem = ecosystemFor(dep.parser);
      if (!ecosystem) { skippedUnknownEcosystem += 1; continue; }
      const key = `${dep.name}@${dep.version}@${ecosystem}`;
      const existing = merged.get(key);
      if (existing) {
        if (!existing.sourceManifests.includes(dep.sourceManifest)) existing.sourceManifests.push(dep.sourceManifest);
      } else merged.set(key, { name: dep.name, version: dep.version, ecosystem, sourceManifests: [dep.sourceManifest] });
    }
  }
  return { queries: [...merged.values()].sort((a, b) => a.ecosystem.localeCompare(b.ecosystem) || a.name.localeCompare(b.name)), skippedUnknownEcosystem };
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface OsvVuln { id: string; summary: string; aliases: string[]; }
export interface OsvFinding { name: string; version: string; ecosystem: string; sourceManifests: string[]; vulns: OsvVuln[]; }
export interface OsvScan {
  queried: number;
  batches: number;
  vulnerablePackages: OsvFinding[];
  vulnCount: number;
  durationMs: number;
}

interface OsvBatchResult { vulns?: Array<{ id?: unknown; summary?: unknown; details?: unknown; aliases?: unknown }>; }

/** 分批查询 OSV；fetcher 可注入以便测试全程离线。 */
export async function auditOsv(root: string, options: { timeoutMs?: number; fetcher?: FetchLike; maxPackages?: number } = {}): Promise<OsvScan> {
  const started = Date.now();
  const timeoutMs = options.timeoutMs ?? 30_000;
  const fetcher = options.fetcher ?? (globalThis.fetch as unknown as FetchLike);
  const { queries } = collectOsvQueries(root);
  const capped = typeof options.maxPackages === "number" ? queries.slice(0, options.maxPackages) : queries;
  const batches = Math.ceil(capped.length / BATCH_SIZE);
  const vulnerablePackages: OsvFinding[] = [];
  let vulnCount = 0;
  for (let batch = 0; batch < batches; batch += 1) {
    const slice = capped.slice(batch * BATCH_SIZE, (batch + 1) * BATCH_SIZE);
    const response = await fetcher(OSV_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "pm-mcp-osv (project ledger; reports only package name/version/ecosystem)" },
      body: JSON.stringify({ queries: slice.map((q) => ({ package: { name: q.name, ecosystem: q.ecosystem }, version: q.version })) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`OSV 查询失败：HTTP ${response.status}（第 ${batch + 1}/${batches} 批）`);
    const payload = JSON.parse(await response.text()) as { results?: OsvBatchResult[] };
    const results = payload.results ?? [];
    for (let i = 0; i < slice.length; i += 1) {
      const vulns = (results[i]?.vulns ?? []).map((v) => ({
        id: typeof v.id === "string" ? v.id : "UNKNOWN",
        summary: typeof v.summary === "string" ? v.summary : typeof v.details === "string" ? v.details.slice(0, 160) : "",
        aliases: Array.isArray(v.aliases) ? v.aliases.filter((a): a is string => typeof a === "string") : [],
      }));
      if (vulns.length === 0) continue;
      vulnerablePackages.push({ ...slice[i], vulns });
      vulnCount += vulns.length;
    }
  }
  return { queried: capped.length, batches, vulnerablePackages, vulnCount, durationMs: Date.now() - started };
}

export function renderOsv(scan: OsvScan, maxLines = 150, skippedUnknownEcosystem = 0): string {
  const lines = [
    "## OSV 已知漏洞查询（联网完成）",
    `- 查询: ${scan.queried} 个依赖（${scan.batches} 批，仅发送 包名/版本/生态）· 命中 ${scan.vulnerablePackages.length} 个包 / ${scan.vulnCount} 条漏洞 · 耗时 ${scan.durationMs}ms`,
  ];
  for (const finding of scan.vulnerablePackages) {
    for (const vuln of finding.vulns) {
      const aliases = vuln.aliases.length > 0 ? `（${vuln.aliases.slice(0, 3).join(", ")}）` : "";
      lines.push(`- 🚩 ${finding.ecosystem}/${finding.name}@${finding.version} ${vuln.id}${aliases} ${vuln.summary.slice(0, 120)}`);
    }
  }
  if (scan.vulnerablePackages.length === 0) lines.push("- ✅ 未命中已知漏洞");
  else lines.push(`- ✅ 其余 ${scan.queried - scan.vulnerablePackages.length} 个依赖未命中已知漏洞`);
  lines.push("> 边界：范围声明（^ ~ >=）按原样精确匹配可能漏报；devDependencies 一并计入；结果不写台账，联网由每次调用显式 confirm 门控。" + (skippedUnknownEcosystem > 0 ? ` 未识别生态依赖 ${skippedUnknownEcosystem} 个已跳过。` : ""));
  return foldLines(lines, { maxLines, hint: "修复后可再次 audit_osv 复核" });
}
