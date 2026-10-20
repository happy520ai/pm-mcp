#!/usr/bin/env node
/** Resources: 只读状态资源注册（仪表盘/路线图/任务/变更/治理/组合视图/验收）。 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import fs from "node:fs";
import path from "node:path";
import { dashboardFile, pmPath } from "./paths.ts";
import { loadRoadmap, loadTasks } from "./store.ts";
import { renderRoadmap } from "./roadmap.ts";
import { buildChangelog } from "./dashboard.ts";
import { auditGovernance } from "./governance-audit.ts";
import { buildPortfolioReport, loadPortfolioProject } from "./portfolio.ts";
import { listAcceptanceBaselines } from "./acceptance-tools.ts";
import { AcceptanceReportSchema } from "./acceptance-report.ts";
import { runCoalescedRead } from "./idempotency.ts";
import { budgetLines, recordUsage, requestContext } from "./tool-base.ts";
import { taskPage } from "./task-pagination.ts";

export function registerResources(server: McpServer, root: string): void {
  function safeText(fn: () => string): string {
    try {
      return fn();
    } catch (e) {
      return `（不可用: ${(e as Error).message}）`;
    }
  }

  async function resourceText(name: string, fn: (root: string) => string): Promise<string> {
    const started = Date.now();
    const target = requestContext(name, {}, root).root;
    try {
      const text = (await runCoalescedRead(target, `resource:${name}`, {}, () => safeText(() => fn(target)))).text;
      recordUsage(target, `resource:${name}`, "read", started, { ok: true, text });
      return text;
    } catch (error) {
      recordUsage(target, `resource:${name}`, "read", started, { ok: false, error: (error as Error).message });
      throw error;
    }
  }

  server.registerResource(
    "dashboard",
    "pm://dashboard",
    { description: "项目仪表盘（与仓库根 PROJECT.md 同源），路线图/健康摘要/任务/功能清单" },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "text/markdown",
          text: await resourceText("dashboard", (r) => fs.readFileSync(dashboardFile(r), "utf8")),
        },
      ],
    }),
  );

  server.registerResource(
    "roadmap",
    "pm://roadmap",
    { description: "路线图（里程碑进度 + 活跃里程碑任务明细）" },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "text/markdown",
          text: await resourceText("roadmap", (r) => renderRoadmap(loadRoadmap(r).milestones, loadTasks(r).tasks, 2).join("\n")),
        },
      ],
    }),
  );

  server.registerResource(
    "tasks",
    "pm://tasks",
    { description: "任务原始数据；大列表末尾返回 continuation，可通过 list_tasks 保持 include_done:true 连续取回后续任务" },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: await resourceText("tasks", (r) => {
            const data = loadTasks(r);
            const tasks = data.tasks;
            // 资源也要守 token 预算：全量 dump 大账本会吃爆上下文（截断后仍是合法 JSON）
            if (tasks.length <= 100) return JSON.stringify(tasks, null, 2);
            const page = taskPage(r, { include_done: true, page_size: 100 }, budgetLines(r) - 4, data);
            const shown = tasks.slice(0, page.returned) as Array<Record<string, unknown>>;
            shown.push({
              id: `_TRUNCATED_${tasks.length - page.returned}`,
              title: `…本次输出已截断，另有 ${tasks.length - page.returned} 个任务，用 continuation 连续读取`,
              continuation: { tool: "list_tasks", arguments: { include_done: true, cursor: page.next_cursor } },
            });
            return JSON.stringify(shown, null, 2);
          }),
        },
      ],
    }),
  );

  server.registerResource(
    "changelog",
    "pm://changelog",
    { description: "变更日志（由 sessions.json 生成的人类可读版本）" },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "text/markdown",
          text: await resourceText("changelog", (r) => buildChangelog(r)),
        },
      ],
    }),
  );

  server.registerResource(
    "architecture",
    "pm://architecture",
    { description: "跨文件/模块/语言治理审计：语义覆盖、依赖边界、接口、循环与质量矩阵" },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "text/markdown", text: await resourceText("architecture", (r) => auditGovernance(r, 150).report) }],
    }),
  );

  server.registerResource(
    "portfolio",
    "pm://portfolio",
    { description: "当前项目的组合视图与跨仓依赖/版本风险" },
    async (uri) => ({
      contents: [{
        uri: uri.href,
        mimeType: "application/json",
        text: await resourceText("portfolio", (r) => JSON.stringify(buildPortfolioReport({ projects: [loadPortfolioProject(r)], projectsRequested: 1 }), null, 2)),
      }],
    }),
  );

  server.registerResource(
    "acceptance",
    "pm://acceptance",
    { description: "标准化产品验收概览：版本化预批准基线与最近一次机器判定报告" },
    async (uri) => ({
      contents: [{
        uri: uri.href,
        mimeType: "application/json",
        text: await resourceText("acceptance", (r) => {
          const reportDir = pmPath(r, "acceptance", "reports");
          let latestReport: unknown = null;
          if (fs.existsSync(reportDir)) {
            const candidates = fs.readdirSync(reportDir, { withFileTypes: true })
              .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
              .map((entry) => ({ name: entry.name, mtime: fs.statSync(path.join(reportDir, entry.name)).mtimeMs }))
              .sort((a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name));
            if (candidates[0]) latestReport = AcceptanceReportSchema.parse(JSON.parse(fs.readFileSync(path.join(reportDir, candidates[0].name), "utf8")));
          }
          return JSON.stringify({ baselines: listAcceptanceBaselines(r), latest_report: latestReport }, null, 2);
        }),
      }],
    }),
  );
}
