import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { foldLines, normSep } from "./budget.ts";
import { refreshDerived } from "./dashboard.ts";
import { decisionsDir, requireInitialized } from "./paths.ts";
import { formatCodeSearch, searchCode, searchKnowledge } from "./search.ts";
import {
  loadDebugLog,
  loadFeatures,
  loadFileNotes,
  loadProject,
  loadSessions,
  nextId,
  saveDebugLog,
  saveFeatures,
  saveFileNotes,
  saveSessions,
} from "./store.ts";
import { budgetLines, tool, toolW } from "./tool-base.ts";
import { now } from "./types.ts";

export function registerFeatureTools(server: McpServer, root: string): void {
  toolW<{ name: string; description?: string; entry_files?: string[]; module?: string; test_files?: string[]; status?: "planned" | "implemented" | "deprecated" }>(
    server, root,
    "register_feature",
    "登记功能（回答「这个项目有哪些功能」）。entry_files=入口文件（漂移对账锚点），test_files=测试文件（测试背书）。",
    {
      name: z.string().min(1),
      description: z.string().optional(),
      entry_files: z.array(z.string()).optional().describe("入口/实现文件相对路径"),
      module: z.string().optional().describe("所属模块"),
      test_files: z.array(z.string()).optional().describe("对应测试文件"),
      status: z.enum(["planned", "implemented", "deprecated"]).optional().describe("默认 implemented"),
    },
    (args) => {
      requireInitialized(root);
      const data = loadFeatures(root);
      const id = nextId("F", data.seq);
      const t = now();
      data.seq += 1;
      data.features.push({
        id,
        name: args.name,
        description: args.description ?? "",
        module: args.module ?? "",
        entry_files: (args.entry_files ?? []).map(normSep),
        test_files: (args.test_files ?? []).map(normSep),
        status: args.status ?? "implemented",
        created: t,
        updated: t,
      });
      saveFeatures(root, data);
      refreshDerived(root);
      const dup = data.features.find((f) => f.id !== id && f.name === args.name);
      const hint = dup
        ? `\n⚠️ 已存在同名功能 ${dup.id}（${dup.status}）——若是一物重复登记请梳理，别让功能账出现双胞胎。`
        : "";
      return `✅ 功能 ${id}「${args.name}」已登记${args.module ? `（${args.module}）` : ""}。audit_structure 会核对其入口文件是否真实存在（防幻觉对账）。${hint}`;
    },
  );

  tool<{ module?: string; status?: "planned" | "implemented" | "deprecated" }>(
    server,
    "list_features",
    "列出功能清单（可按模块/状态过滤）。",
    { module: z.string().optional(), status: z.enum(["planned", "implemented", "deprecated"]).optional() },
    (args) => {
      requireInitialized(root);
      let list = loadFeatures(root).features;
      if (args.module) list = list.filter((f) => f.module === args.module);
      if (args.status) list = list.filter((f) => f.status === args.status);
      const L = list.map((f) => {
        const missing = f.entry_files.filter((p) => !fs.existsSync(path.join(root, p)));
        const mark = f.status !== "implemented" ? "○" : missing.length > 0 ? "⚠️漂移" : f.test_files.length === 0 ? "🧪无测试" : "✅";
        return `${mark} ${f.id} ${f.name}${f.module ? `（${f.module}）` : ""}${f.description ? ` — ${f.description.slice(0, 80)}` : ""}`;
      });
      return foldLines([`共 ${list.length} 个功能:`, ...L], { maxLines: budgetLines(root), hint: "用 module/status 过滤" });
    },
  );
}

export function registerDecisionTools(server: McpServer, root: string): void {
  toolW<{ title: string; context: string; decision: string; consequences?: string }>(
    server, root,
    "record_decision",
    "记录架构决策（ADR）：为什么这么选、决定了什么、有什么后果。认知债务的解药——半年后还能回答「当时为什么」。",
    {
      title: z.string().min(1),
      context: z.string().describe("背景与约束（为什么需要做选择）"),
      decision: z.string().describe("决定与理由"),
      consequences: z.string().optional().describe("后果/代价/被放弃的方案"),
    },
    (args) => {
      requireInitialized(root);
      ensureDecisionDir(root);
      const existing = fs.readdirSync(decisionsDir(root)).filter((n) => n.endsWith(".md"));
      const num = String(existing.length + 1).padStart(3, "0");
      const slug = args.title
        .replace(/[\\/:*?"<>|\s]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40) || "decision";
      const file = `ADR-${num}-${slug}.md`;
      const content = [
        `# ADR-${num} ${args.title}`,
        "",
        `- 日期: ${new Date().toISOString().slice(0, 10)}`,
        "- 状态: 已接受",
        "",
        "## 背景",
        "",
        args.context,
        "",
        "## 决定",
        "",
        args.decision,
        "",
        "## 后果",
        "",
        args.consequences ?? "（未记录）",
        "",
      ].join("\n");
      fs.writeFileSync(path.join(decisionsDir(root), file), content, "utf8");
      refreshDerived(root);
      return `✅ 决策已记录: .pm/decisions/${file}（不可变编号，git 友好）。search_knowledge 可检索。`;
    },
  );

  tool(server, "list_decisions", "列出全部架构决策（ADR）。", {}, () => {
    requireInitialized(root);
    const dir = decisionsDir(root);
    const names = fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.endsWith(".md")).sort() : [];
    if (names.length === 0) return "（暂无决策记录。重要取舍用 record_decision 留痕。）";
    return foldLines(names.map((n) => `- ${n.replace(/\.md$/, "")}`), { maxLines: budgetLines(root) });
  });
}

function ensureDecisionDir(root: string): void {
  fs.mkdirSync(decisionsDir(root), { recursive: true });
}

export function registerSessionTools(server: McpServer, root: string): void {
  toolW<{ summary: string; files?: string[]; next_steps?: string[]; author?: string }>(
    server, root,
    "log_session",
    "收工仪式：记录本次会话（做了什么、改了哪些文件、下一步）。files 是变更足迹（churn 账与波及面告警的数据源），务必如实列出。",
    {
      summary: z.string().min(1).describe("本次做了什么（一两句）"),
      files: z.array(z.string()).optional().describe("本次改动/新增/删除的文件（相对路径）"),
      next_steps: z.array(z.string()).optional().describe("留给下次的下一步"),
      author: z.string().optional().describe("署名：zcode / codex / human:名字"),
    },
    (args) => {
      requireInitialized(root);
      const project = loadProject(root);
      const data = loadSessions(root);
      const id = nextId("S", data.seq, 4);
      data.seq += 1;
      data.sessions.push({
        id,
        date: now(),
        author: args.author ?? "",
        summary: args.summary,
        files: (args.files ?? []).map(normSep),
        next_steps: args.next_steps ?? [],
      });
      saveSessions(root, data);
      refreshDerived(root);
      const L = [`✅ 会话 ${id} 已记录，changelog.md 已更新。`];
      if ((args.files ?? []).length > project.budgets.sessionBlastRadius) {
        L.push(`⚠️ 本次波及 ${(args.files ?? []).length} 个文件，超过阈值 ${project.budgets.sessionBlastRadius}——波及面过大，考虑拆任务或立重构任务。`);
      }
      return L.join("\n");
    },
  );

  toolW<{ symptom: string; root_cause: string; fix: string; verified_how?: string; files?: string[]; task_id?: string }>(
    server, root,
    "log_debug",
    "记录调试过程：症状 / 根因 / 修法 / 怎么验证的。调试知识账——下次同样的错不用从零猜，search_knowledge 可查。",
    {
      symptom: z.string().describe("症状：什么现象、报什么错"),
      root_cause: z.string().describe("根因（诊断出的真正原因，不是表面现象）"),
      fix: z.string().describe("修法"),
      verified_how: z.string().optional().describe("怎么确认修好了"),
      files: z.array(z.string()).optional(),
      task_id: z.string().optional().describe("关联任务 id"),
    },
    (args) => {
      requireInitialized(root);
      const data = loadDebugLog(root);
      const id = nextId("D", data.seq, 4);
      data.seq += 1;
      data.entries.push({
        id,
        date: now(),
        author: "",
        symptom: args.symptom,
        root_cause: args.root_cause,
        fix: args.fix,
        verified_how: args.verified_how ?? "",
        files: (args.files ?? []).map(normSep),
        task_id: args.task_id ?? null,
      });
      saveDebugLog(root, data);
      refreshDerived(root);
      return `✅ 调试记录 ${id} 已存档。这份诊断经验已进入项目知识库。`;
    },
  );
}

export function registerSearchTools(server: McpServer, root: string): void {
  tool<{ query: string; glob?: string; max_results?: number; regex?: boolean }>(
    server,
    "search_code",
    "在真实代码里检索（防幻觉事中防线）：谈某个功能/文件之前先搜实码。返回 file:line 片段而非整文件（token 经济）。默认按字面量匹配；regex=true 时按 JavaScript 正则（仅在你确需时开启）。",
    {
      query: z.string().min(1).describe("关键词（默认字面量匹配）"),
      glob: z.string().optional().describe("限定文件范围，如 src/**/*.ts"),
      max_results: z.number().int().min(1).max(100).optional().describe("默认 30"),
      regex: z.boolean().optional().describe("默认 false；true 时 query 按正则解释"),
    },
    (args) => {
      requireInitialized(root);
      const res = searchCode(root, args.query, args.glob, args.max_results ?? 30, args.regex ?? false);
      return formatCodeSearch(res, args.query);
    },
  );

  tool<{ query: string }>(
    server,
    "search_knowledge",
    "检索六类项目知识源（ADR/任务/功能/会话/调试记录/文件索引）——回答「之前为什么这么做」「上次这个错怎么解的」，用历史结论代替重新推理。代码内容请用 search_code。",
    { query: z.string().min(1) },
    (args) => {
      requireInitialized(root);
      return searchKnowledge(root, args.query);
    },
  );

  toolW<{ path: string; purpose: string; source?: string; license?: string }>(
    server, root,
    "annotate_file",
    "给文件登记一行用途（文件用途索引）：之后任何会话靠索引定位，不用打开文件。引用外部代码时可登记 source/license（provenance）。",
    {
      path: z.string().min(1).describe("相对路径"),
      purpose: z.string().min(1).describe("一句话用途"),
      source: z.string().optional().describe("代码来源（URL/仓库），如引用自外部"),
      license: z.string().optional().describe("该文件引用代码的许可证"),
    },
    (args) => {
      requireInitialized(root);
      const rel = normSep(args.path);
      if (!fs.existsSync(path.join(root, rel))) {
        throw new Error(`文件不存在: ${rel}（注意用相对路径，如 src/index.ts）`);
      }
      const data = loadFileNotes(root);
      data.notes[rel] = {
        ...(data.notes[rel] ?? {}),
        purpose: args.purpose,
        source: args.source ?? data.notes[rel]?.source ?? "",
        license: args.license ?? data.notes[rel]?.license ?? "",
        updated: now(),
      };
      saveFileNotes(root, data);
      refreshDerived(root);
      return `✅ 已登记 ${rel}: ${args.purpose}。索引覆盖率上升，后续会话省 token。`;
    },
  );
}
