import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { initProject } from "./init.ts";
import { pmPath, requireInitialized } from "./paths.ts";
import { refreshDerived } from "./dashboard.ts";
import { renderRoadmap, milestoneStats, checkpointSuffix } from "./roadmap.ts";
import { foldLines } from "./budget.ts";
import { loadGovernance } from "./governance-model.ts";
import {
  loadProject,
  loadRoadmap,
  loadSecurity,
  loadSessions,
  loadTasks,
  saveProject,
  saveRoadmap,
} from "./store.ts";
import { now, type Task } from "./types.ts";
import { budgetLines, tool, toolW } from "./tool-base.ts";

function taskLine(t: Task, withNext = false): string {
  const parts = [`[${t.status}]`, t.id, t.title, `(${t.type}${t.milestone ? `,${t.milestone}` : ""})`];
  if (withNext && t.checkpoint) {
    parts.push(`→ 下一步: ${t.checkpoint.next_step}${checkpointSuffix(t.checkpoint)}`);
  }
  return parts.join(" ");
}

export function registerProjectTools(server: McpServer, root: string): void {
  toolW<{ name: string; description?: string; stack?: string[]; goals?: string[]; license?: string; exposure?: "local" | "network" | "public"; modules?: string[] }>(
    server, root,
    "init_project",
    "初始化当前项目的 .pm/ 状态目录（单一事实来源）。每个新项目只调用一次；已初始化请用 update_project。",
    {
      name: z.string().min(1).describe("项目名"),
      description: z.string().optional().describe("一句话描述"),
      stack: z.array(z.string()).optional().describe("技术栈，如 [\"TypeScript\",\"React\"]"),
      goals: z.array(z.string()).optional().describe("项目目标列表"),
      license: z.string().optional().describe("项目许可证（SPDX 名，如 MIT）"),
      exposure: z.enum(["local", "network", "public"]).optional().describe("暴露面，影响安全告警力度"),
      modules: z.array(z.string()).optional().describe("初始模块登记"),
    },
    (args) => {
      const project = initProject(root, args);
      refreshDerived(root);
      return [
        `✅ 项目已初始化: ${project.name}`,
        `状态目录: ${pmPath(root, "")}（随 git 提交，团队/AI 共享）`,
        "仪表盘已生成: PROJECT.md",
        "建议顺序: upsert_module 声明模块/owner/语言 → add_milestone 建里程碑 → add_task 拆任务 → 开工前 get_status / 收工后 log_session。",
      ].join("\n");
    },
  );

  tool<{ since?: string }>(
    server,
    "get_status",
    "一站式「我在哪」：项目阶段 + 里程碑进度 + 进行中任务（含断点下一步）+ 健康摘要 + 最近变更。会话开工第一件事。since 可只看某日期以来的任务/会话变化。",
    { since: z.string().optional().describe("ISO 日期，如 2026-09-01：只看该日期以来的任务/会话变化") },
    (args) => {
      requireInitialized(root);
      const project = loadProject(root);
      const { milestones } = loadRoadmap(root);
      const { tasks } = loadTasks(root);
      const { sessions } = loadSessions(root);
      const security = loadSecurity(root);
      const L: string[] = [];

      L.push(`# ${project.name}${project.phase ? ` — ${project.phase}` : ""}`);
      if (project.description) L.push(project.description);

      L.push("");
      L.push("## 里程碑");
      L.push(...renderRoadmap(milestones, tasks, 1));

      L.push("");
      L.push("## 当前焦点（断点恢复点）");
      const active = tasks.filter((t) => t.status === "in_progress" || t.status === "blocked");
      if (active.length === 0) L.push("（无进行中任务——从 backlog 挑一个，或 add_task。）");
      for (const t of active.slice(0, 10)) {
        L.push(`- ${taskLine(t, true)}`);
        if (t.steps.length > 0) {
          const doneN = t.steps.filter((s) => s.done).length;
          L.push(`  步骤 ${doneN}/${t.steps.length}: ${t.steps.filter((s) => !s.done)[0]?.text ?? "全部完成"}`);
        }
      }

      L.push("");
      L.push("## 健康摘要");
      const openDebt = tasks.filter((t) => t.type === "debt" && t.status !== "done" && t.status !== "cancelled").length;
      const openFindings = security.findings.filter((f) => f.status === "open");
      L.push(`债务未清 ${openDebt} 条 · 安全未处理 ${openFindings.length} 个（高危 ${openFindings.filter((f) => f.severity === "high").length}）· 会话 ${sessions.length} 次。详细对账用 audit_structure / audit_security。`);
      try {
        const governance = loadGovernance(root);
        L.push(`治理模型 ${governance.modules.length} 模块 / ${governance.interfaces.length} 接口 / ${governance.repositories.length} 仓库；实时语义门禁用 audit_governance。`);
      } catch {
        L.push("⚠️ 治理模型未初始化；跨模块/语言边界尚未启用。");
      }

      const last = sessions[sessions.length - 1];
      if (last) {
        L.push("");
        L.push("## 最近会话");
        L.push(`${last.date.slice(0, 10)} [${last.author || "?"}] ${last.summary}`);
        if (last.next_steps.length > 0) L.push(`上次留下的下一步: ${last.next_steps.join("；")}`);
      }

      if (args.since) {
        const parsed = Date.parse(args.since);
        const since = Number.isNaN(parsed) ? args.since : new Date(parsed).toISOString();
        const newTasks = tasks.filter((t) => t.updated >= since);
        const newSessions = sessions.filter((s) => s.date >= since);
        L.push("");
        L.push(`## 自 ${since.slice(0, 10)} 以来`);
        L.push(`新增/更新任务 ${newTasks.length} 个，会话 ${newSessions.length} 次。`);
        for (const t of newTasks.slice(-8).reverse()) L.push(`- ${taskLine(t)}`);
      }

      L.push("");
      L.push("> 三段式定位：本状态 → search_code 精确到行 → 才读具体文件。别全量读代码。");
      return foldLines(L, { maxLines: budgetLines(root) });
    },
  );

  toolW<{ description?: string; stack?: string[]; goals?: string[]; phase?: string; license?: string; exposure?: "local" | "network" | "public"; modules?: string[]; max_file_loc?: number; refactor_quota_pct?: number; session_blast_radius?: number; output_budget_lines?: number }>(
    server, root,
    "update_project",
    "更新项目元信息/预算（描述、技术栈、目标、阶段、模块登记、许可证、暴露面、复杂度与输出预算）。",
    {
      description: z.string().optional(),
      stack: z.array(z.string()).optional(),
      goals: z.array(z.string()).optional(),
      phase: z.string().optional().describe("当前阶段，如 MVP 开发中"),
      license: z.string().optional(),
      exposure: z.enum(["local", "network", "public"]).optional(),
      modules: z.array(z.string()).optional().describe("模块登记（用于未登记目录检测）"),
      max_file_loc: z.number().int().min(10).optional().describe("单文件行数预算"),
      refactor_quota_pct: z.number().min(0).max(100).optional().describe("里程碑重构类任务最低占比%"),
      session_blast_radius: z.number().int().min(1).optional().describe("单会话波及文件阈值"),
      output_budget_lines: z.number().int().min(20).optional().describe("读类工具输出行数预算"),
    },
    (args) => {
      requireInitialized(root);
      const project = loadProject(root);
      if (args.description !== undefined) project.description = args.description;
      if (args.stack !== undefined) project.stack = args.stack;
      if (args.goals !== undefined) project.goals = args.goals;
      if (args.phase !== undefined) project.phase = args.phase;
      if (args.license !== undefined) project.license = args.license;
      if (args.exposure !== undefined) project.exposure = args.exposure;
      if (args.modules !== undefined) project.modules = args.modules;
      if (args.max_file_loc !== undefined) project.budgets.maxFileLoc = args.max_file_loc;
      if (args.refactor_quota_pct !== undefined) project.budgets.refactorQuotaPct = args.refactor_quota_pct;
      if (args.session_blast_radius !== undefined) project.budgets.sessionBlastRadius = args.session_blast_radius;
      if (args.output_budget_lines !== undefined) project.budgets.outputBudgetLines = args.output_budget_lines;
      saveProject(root, project);
      refreshDerived(root);
      return `✅ 项目信息已更新（阶段: ${project.phase || "—"}，模块: ${project.modules.join(", ") || "—"}）。仪表盘已刷新。`;
    },
  );

  tool(server, "regenerate_dashboard", "手动重新生成 PROJECT.md 仪表盘与 changelog.md（正常情况下每次写操作已自动刷新）。", {}, () => {
    requireInitialized(root);
    refreshDerived(root);
    return "✅ PROJECT.md 与 changelog.md 已重新生成。";
  });
}

export function registerRoadmapTools(server: McpServer, root: string): void {
  toolW<{ title: string; goal?: string }>(
    server, root,
    "add_milestone",
    "添加里程碑（M1/M2…，按顺序自动编号）。路线图的骨架；任务挂到里程碑上。",
    { title: z.string().min(1), goal: z.string().optional().describe("这个里程碑要达成什么") },
    (args) => {
      requireInitialized(root);
      const data = loadRoadmap(root);
      const id = `M${data.seq + 1}`;
      const t = now();
      data.seq += 1;
      data.milestones.push({
        id,
        title: args.title,
        goal: args.goal ?? "",
        status: "planned",
        order: data.milestones.length + 1,
        created: t,
        updated: t,
      });
      saveRoadmap(root, data);
      refreshDerived(root);
      return `✅ 里程碑 ${id}「${args.title}」已创建（planned）。开始推进时用 update_milestone 置为 active。`;
    },
  );

  toolW<{ id: string; status?: "planned" | "active" | "done" | "paused"; title?: string; goal?: string; order?: number }>(
    server, root,
    "update_milestone",
    "更新里程碑（状态流转 planned/active/done/paused、标题、目标、顺序）。",
    {
      id: z.string().describe("里程碑 id，如 M1"),
      status: z.enum(["planned", "active", "done", "paused"]).optional(),
      title: z.string().optional(),
      goal: z.string().optional(),
      order: z.number().int().optional(),
    },
    (args) => {
      requireInitialized(root);
      const data = loadRoadmap(root);
      const m = data.milestones.find((x) => x.id === args.id);
      if (!m) throw new Error(`找不到里程碑 ${args.id}。现有: ${data.milestones.map((x) => x.id).join(", ") || "无"}`);
      if (args.status !== undefined) m.status = args.status;
      if (args.title !== undefined) m.title = args.title;
      if (args.goal !== undefined) m.goal = args.goal;
      if (args.order !== undefined) m.order = args.order;
      m.updated = now();
      const warnings: string[] = [];
      if (m.status === "done") {
        const skipped = data.milestones.filter(
          (x) => x.id !== m.id && x.order < m.order && (x.status === "active" || x.status === "planned"),
        );
        if (skipped.length > 0) {
          warnings.push(`⚠️ 跳过前置里程碑：${skipped.map((x) => x.id).join(", ")} 尚未完成就被置后完成——确认是有意为之。`);
        }
      }
      saveRoadmap(root, data);
      refreshDerived(root);
      const { tasks } = loadTasks(root);
      const s = milestoneStats(tasks, m.id);
      return [`✅ ${m.id} 已更新（${m.status}）。进度: ${s.done}/${s.total}（${s.pct}%）。`, ...warnings].join("\n");
    },
  );

  tool<{ depth?: number }>(
    server,
    "get_roadmap",
    "查看路线图。depth=1 每个里程碑一行摘要（功能再多也不乱）；depth=2 额外展开活跃里程碑的任务明细与断点。",
    { depth: z.number().int().min(1).max(2).optional().describe("默认 1") },
    (args) => {
      requireInitialized(root);
      const { milestones } = loadRoadmap(root);
      const { tasks } = loadTasks(root);
      const project = loadProject(root);
      const L: string[] = ["# 路线图", ""];
      L.push(...renderRoadmap(milestones, tasks, args.depth ?? 1));
      const warns = milestones
        .map((m) => ({ m, s: milestoneStats(tasks, m.id) }))
        .filter(({ m, s }) => m.status !== "done" && s.total >= 5 && s.refactorPct < project.budgets.refactorQuotaPct);
      if (warns.length > 0) {
        L.push("");
        for (const { m, s } of warns) {
          L.push(`⚠️ 重构被挤出: ${m.id}（${s.total} 个任务中重构类仅 ${s.refactorPct}%，配额 ${project.budgets.refactorQuotaPct}%）——建议立 refactor/debt 任务。`);
        }
      }
      return foldLines(L, { maxLines: budgetLines(root) });
    },
  );
}
