import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import { isInitialized } from "./paths.ts";
import { loadProject, loadTasks, loadRoadmap, loadFeatures, loadSessions, loadSecurity } from "./store.ts";
import { milestoneStats } from "./roadmap.ts";
import { aggregates, ensureFresh, getIndex } from "./index-store.ts";
import { VERSION } from "./version.ts";

/**
 * 本地只读 Web 仪表盘（零依赖 node:http）：
 *   pm-mcp ui [--root <项目>] [--port <端口>]
 *
 * 安全边界：仅绑定 127.0.0.1、纯 GET 只读、未初始化 fail-closed、无外部资源、
 * 所有插值经 HTML 转义（任务标题等用户内容不可注入）；响应 CSP 禁止脚本。
 */

const esc = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

export interface DashboardState {
  name: string;
  description: string;
  phase: string;
  exposure: string;
  version: string;
  milestones: Array<{ id: string; title: string; status: string; done: number; total: number; pct: number }>;
  tasks: { total: number; byStatus: Record<string, number>; recent: Array<{ id: string; title: string; status: string; priority: string }> };
  features: { total: number; implemented: number; planned: number; deprecated: number };
  security: { open: number; high: number; accepted: number };
  sessions: { count: number; last: { at: string; author: string; summary: string } | null };
  index: { files: number; loc: number } | null;
  quality: { at: string; ok: boolean; tests: string } | null;
}

function latestQualityRun(root: string): DashboardState["quality"] {
  const dir = path.join(root, ".pm", "quality-runs");
  try {
    const latest = fs.readdirSync(dir).filter((name) => name.endsWith(".json")).sort().pop();
    if (!latest) return null;
    const raw = JSON.parse(fs.readFileSync(path.join(dir, latest), "utf8")) as {
      run_at?: string; ok?: boolean; results?: Array<{ output_summary?: { passed?: number; tests?: number } }>;
    };
    const summary = raw.results?.[0]?.output_summary;
    return { at: raw.run_at ?? "", ok: raw.ok === true, tests: summary ? `${summary.passed}/${summary.tests}` : "n/a" };
  } catch { return null; }
}

export function buildDashboardState(root: string): DashboardState {
  const absolute = path.resolve(root);
  const project = loadProject(absolute);
  const { tasks } = loadTasks(absolute);
  const { milestones } = loadRoadmap(absolute);
  const features = loadFeatures(absolute).features;
  const security = loadSecurity(absolute).findings;
  const sessions = loadSessions(absolute).sessions;

  const byStatus: Record<string, number> = {};
  for (const task of tasks) byStatus[task.status] = (byStatus[task.status] ?? 0) + 1;
  const recent = [...tasks]
    .sort((a, b) => b.id.localeCompare(a.id))
    .slice(0, 10)
    .map((task) => ({ id: task.id, title: task.title, status: task.status, priority: task.priority ?? "" }));

  let index: DashboardState["index"] = null;
  try {
    ensureFresh(absolute);
    const agg = aggregates(getIndex(absolute));
    index = { files: agg.totalFiles, loc: agg.totalLoc };
  } catch { index = null; }

  const last = sessions.length > 0 ? sessions[sessions.length - 1] : null;
  return {
    name: project.name,
    description: project.description,
    phase: project.phase,
    exposure: project.exposure,
    version: VERSION,
    milestones: milestones.map((milestone) => {
      const stats = milestoneStats(tasks, milestone.id);
      return { id: milestone.id, title: milestone.title, status: milestone.status, done: stats.done, total: stats.total, pct: stats.total === 0 ? 0 : stats.pct };
    }),
    tasks: { total: tasks.length, byStatus, recent },
    features: {
      total: features.length,
      implemented: features.filter((f) => f.status === "implemented").length,
      planned: features.filter((f) => f.status === "planned").length,
      deprecated: features.filter((f) => f.status === "deprecated").length,
    },
    security: {
      open: security.filter((f) => f.status === "open").length,
      high: security.filter((f) => f.status === "open" && f.severity === "high").length,
      accepted: security.filter((f) => f.status === "accepted").length,
    },
    sessions: {
      count: sessions.length,
      last: last ? { at: last.date, author: last.author, summary: last.summary } : null,
    },
    index,
    quality: latestQualityRun(absolute),
  };
}

export function renderDashboardHtml(state: DashboardState): string {
  const taskStatus = Object.entries(state.tasks.byStatus).map(([status, count]) => `${esc(status)} ${count}`).join(" · ") || "无";
  const milestoneRows = state.milestones.map((m) => {
    const statusIcon = m.status === "done" ? "✅" : m.status === "active" ? "▶" : "☐";
    return `<tr><td>${esc(m.id)}</td><td>${statusIcon} ${esc(m.title)}</td><td>${m.done}/${m.total}</td>` +
      `<td><div class="bar"><div class="fill" style="width:${Math.min(100, Math.max(0, m.pct))}%"></div></div>${m.pct}%</td></tr>`;
  }).join("");
  const taskRows = state.tasks.recent.map((task) =>
    `<tr><td>${esc(task.id)}</td><td>${esc(task.title)}</td><td>${esc(task.status)}</td><td>${esc(task.priority)}</td></tr>`,
  ).join("");
  const lastSession = state.sessions.last
    ? `<p>最近：${esc(state.sessions.last.at)} · ${esc(state.sessions.last.author)} — ${esc(state.sessions.last.summary.slice(0, 160))}</p>`
    : "<p>（无会话记录）</p>";
  const quality = state.quality
    ? `<span class="${state.quality.ok ? "ok" : "bad"}">${state.quality.ok ? "✅" : "🚩"} ${esc(state.quality.tests)}</span> @ ${esc(state.quality.at)}`
    : "（暂无质量报告）";
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(state.name)} · pm-mcp</title>
<style>
body{font-family:system-ui,"Segoe UI",sans-serif;margin:0;background:#f6f7f9;color:#1c2733}
main{max-width:960px;margin:0 auto;padding:24px}
h1{font-size:22px}h2{font-size:16px;margin:28px 0 8px;border-bottom:1px solid #dde3ea;padding-bottom:6px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}
.card{background:#fff;border:1px solid #dde3ea;border-radius:8px;padding:12px}
.card b{display:block;font-size:20px}.card span{color:#5b6b7c;font-size:12px}
table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #dde3ea}
td,th{padding:6px 10px;border-bottom:1px solid #eef1f4;text-align:left;font-size:13px}
.bar{background:#e8edf2;border-radius:6px;height:10px;min-width:80px;display:inline-block;vertical-align:middle;margin-right:6px}
.fill{background:#3d7bd9;height:10px;border-radius:6px}
.ok{color:#1a7f37}.bad{color:#c62828}
footer{color:#8a97a5;font-size:12px;margin-top:24px}
</style></head><body><main>
<h1>${esc(state.name)} <small style="font-size:13px;color:#5b6b7c">pm-mcp v${esc(state.version)}</small></h1>
<p>${esc(state.description || "（无描述）")} · 阶段：${esc(state.phase || "未设置")} · 暴露面：${esc(state.exposure)}</p>
<h2>概览</h2>
<div class="grid">
<div class="card"><b>${state.tasks.total}</b><span>任务</span></div>
<div class="card"><b>${state.features.implemented}</b><span>功能已实现 / 共 ${state.features.total}</span></div>
<div class="card"><b class="${state.security.high > 0 ? "bad" : "ok"}">${state.security.open}</b><span>安全未处理（高危 ${state.security.high}）</span></div>
<div class="card"><b>${state.sessions.count}</b><span>会话记录</span></div>
<div class="card"><b>${state.index ? state.index.files : "—"}</b><span>索引文件${state.index ? ` / ${state.index.loc} 行` : ""}</span></div>
<div class="card"><b>${quality}</b><span>最近质量门禁</span></div>
</div>
<h2>里程碑</h2>
${milestoneRows ? `<table><tr><th>ID</th><th>标题</th><th>任务</th><th>进度</th></tr>${milestoneRows}</table>` : "<p>（无里程碑）</p>"}
<h2>最近任务</h2>
${taskRows ? `<table><tr><th>ID</th><th>标题</th><th>状态</th><th>优先级</th></tr>${taskRows}</table><p style="font-size:12px;color:#5b6b7c">状态分布：${esc(taskStatus)}</p>` : "<p>（无任务）</p>"}
<h2>会话</h2>
${lastSession}
<footer>只读视图 · 仅绑定 127.0.0.1 · 数据来自 ${esc(state.name)} 的 .pm/ 台账 · ${new Date().toISOString()}</footer>
</main></body></html>`;
}

const HEAD_405 = { allow: "GET, HEAD" };

export async function startUiServer(root: string, options: { port?: number } = {}): Promise<{ url: string; close: () => Promise<void> }> {
  const absolute = path.resolve(root);
  if (!isInitialized(absolute)) throw new Error(`目标不是已纳管项目（缺 .pm/）：${absolute}`);
  const server = http.createServer((request, response) => {
    response.setHeader("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'");
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("cache-control", "no-store");
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method !== "GET" && request.method !== "HEAD") {
        response.writeHead(405, HEAD_405); response.end("只读服务"); return;
      }
      if (url.pathname === "/healthz") { response.writeHead(200, { "content-type": "text/plain" }); response.end("ok"); return; }
      if (url.pathname === "/api/state") {
        response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        response.end(JSON.stringify(buildDashboardState(absolute)));
        return;
      }
      if (url.pathname === "/") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(renderDashboardHtml(buildDashboardState(absolute)));
        return;
      }
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" }); response.end("404");
    } catch (error) {
      // fail-closed：不泄漏堆栈，只给一条简短原因
      response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      response.end(`500: ${(error as Error).message.slice(0, 200)}`);
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") { server.close(); throw new Error("UI 服务监听失败。"); }
  return {
    url: `http://127.0.0.1:${address.port}/`,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}
