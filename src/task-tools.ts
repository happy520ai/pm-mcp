import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { refreshDerived } from "./dashboard.ts";
import { normSep } from "./budget.ts";
import { requireInitialized } from "./paths.ts";
import { loadRoadmap, loadTasks, nextId, saveTasks } from "./store.ts";
import { now, type TaskStatus, type TaskType } from "./types.ts";
import { budgetLines, toolR, toolW } from "./tool-base.ts";
import { captureFileHashes } from "./git-state.ts";
import { appendSession } from "./session-log.ts";
import { verifiedTaskEvidence } from "./task-evidence.ts";
import { taskPage, taskPageText, TaskPageSchema, type TaskListQuery } from "./task-pagination.ts";

const stepSchema = z.object({ text: z.string(), done: z.boolean().optional() });

export function registerTaskTools(server: McpServer, root: string): void {
  toolW<{ title: string; detail?: string; type?: TaskType; priority?: "P0" | "P1" | "P2" | "P3"; milestone?: string; tags?: string[]; files?: string[]; acceptance?: string; steps?: { text: string; done?: boolean }[] }>(
    server, root,
    "add_task",
    "添加任务。长任务务必给 steps（显式步骤清单，断点续做的载体）；走了捷径 type=debt 登记（债务账）；修 bug type=fix。",
    {
      title: z.string().min(1),
      detail: z.string().optional(),
      type: z.enum(["feature", "refactor", "fix", "chore", "debt"]).optional().describe("默认 feature"),
      priority: z.enum(["P0", "P1", "P2", "P3"]).optional(),
      milestone: z.string().optional().describe("所属里程碑 id，如 M1"),
      tags: z.array(z.string()).optional(),
      files: z.array(z.string()).optional().describe("关联文件（相对路径）"),
      acceptance: z.string().optional().describe("验收标准"),
      steps: z.array(stepSchema).optional().describe("步骤清单（长任务必填）"),
    },
    (args) => {
      requireInitialized(root);
      const roadmap = loadRoadmap(root);
      if (args.milestone && !roadmap.milestones.some((m) => m.id === args.milestone)) {
        throw new Error(`里程碑 ${args.milestone} 不存在。现有: ${roadmap.milestones.map((m) => m.id).join(", ") || "无"}`);
      }
      const data = loadTasks(root);
      const id = nextId("T", data.seq);
      const t = now();
      data.seq += 1;
      data.tasks.push({
        id,
        title: args.title,
        detail: args.detail ?? "",
        type: args.type ?? "feature",
        status: "backlog",
        priority: args.priority ?? null,
        milestone: args.milestone ?? null,
        steps: (args.steps ?? []).map((s) => ({ text: s.text, done: s.done ?? false })),
        checkpoint: null,
        files: (args.files ?? []).map(normSep),
        acceptance: args.acceptance ?? "",
        result_note: "",
        verification: "",
        tags: args.tags ?? [],
        author: "",
        created: t,
        updated: t,
        started_at: null,
        completed_at: null,
      });
      saveTasks(root, data);
      refreshDerived(root);
      const tip =
        (args.steps ?? []).length === 0
          ? "\n提示: 长任务建议补 steps（update_task 传 steps），否则中断后续做只能靠回忆。"
          : "";
      return `✅ 任务 ${id}「${args.title}」已创建（${args.type ?? "feature"}/${args.milestone ?? "无里程碑"}）。${tip}`;
    },
  );

  toolR<TaskListQuery>(
    server, root,
    "list_tasks",
    "分页列出任务（默认不含 done/cancelled，每页25）。按原过滤条件传 next_cursor 可取下一页；数据变化会使游标失效。文字摘要与结构化分页结果同时返回，不漏掉折叠的中间任务。",
    {
      status: z.enum(["backlog", "todo", "in_progress", "blocked", "done", "cancelled"]).optional(),
      type: z.enum(["feature", "refactor", "fix", "chore", "debt"]).optional(),
      milestone: z.string().optional(),
      tag: z.string().optional(),
      include_done: z.boolean().optional().describe("默认 false"),
      page_size: z.number().int().min(1).max(100).optional().describe("默认25，受项目输出预算限制"),
      cursor: z.string().min(1).max(1024).optional().describe("上页返回的 next_cursor；保留相同过滤条件"),
    },
    (args) => {
      requireInitialized(root);
      return JSON.stringify(taskPage(root, args, budgetLines(root) - 4));
    },
    { outputSchema: TaskPageSchema.shape, decode: (value) => { const page = TaskPageSchema.parse(JSON.parse(value)); return { text: taskPageText(page), data: page }; } },
  );

  toolW<{
    id: string;
    status?: TaskStatus;
    title?: string;
    detail?: string;
    priority?: "P0" | "P1" | "P2" | "P3" | null;
    milestone?: string | null;
    type?: "feature" | "refactor" | "fix" | "chore" | "debt";
    tags?: string[];
    files?: string[];
    acceptance?: string;
    result_note?: string;
    verification?: string;
    verification_run?: string;
    checkpoint?: { note: string; next_step: string };
    record_session?: boolean;
    steps?: { text: string; done?: boolean }[];
    step_done?: number;
    author?: string;
  }, { evidence?: string; taskSnapshot: string; hashes: Record<string, string> }>(
    server, root,
    "update_task",
    "一次更新任务、checkpoint 与会话。checkpoint 默认记会话；完成时用 record_session:true 一并记录，不再另调 log_session；files 给实际关联文件。feature/fix 转 done 必须有最新成功且源码匹配的测试报告，verification_run 可指明报告。文字 verification 不能代替执行证据。",
    {
      id: z.string(),
      status: z.enum(["backlog", "todo", "in_progress", "blocked", "done", "cancelled"]).optional(),
      title: z.string().optional(),
      detail: z.string().optional(),
      priority: z.enum(["P0", "P1", "P2", "P3"]).nullable().optional(),
      milestone: z.string().nullable().optional(),
      tags: z.array(z.string()).optional(),
      files: z.array(z.string()).optional(),
      acceptance: z.string().optional(),
      result_note: z.string().optional().describe("完成笔记（转 done 必填）"),
      verification: z.string().optional().describe("怎么验证的：命令/测试名"),
      verification_run: z.string().min(1).optional().describe(".pm/quality-runs 内最新的质量报告；省略时自动选最新"),
      checkpoint: z.object({ note: z.string().trim().min(1), next_step: z.string().trim().min(1) }).optional(),
      record_session: z.boolean().optional().describe("checkpoint 默认 true；完成任务时设 true 合并会话。省略保留旧式单独记录方式"),
      steps: z.array(stepSchema).optional().describe("整体替换步骤清单"),
      step_done: z.number().int().min(1).optional().describe("勾选完成第 N 步"),
      author: z.string().optional(),
    },
    (args, prepared) => {
      requireInitialized(root);
      const data = loadTasks(root);
      const t = data.tasks.find((x) => x.id === args.id);
      if (!t) throw new Error(`找不到任务 ${args.id}。`);
      if (JSON.stringify(t) !== prepared.taskSnapshot) throw new Error("任务在证据校验期间发生变化，请重新读取状态。");
      const tnow = now();

      if (args.title !== undefined) t.title = args.title;
      if (args.detail !== undefined) t.detail = args.detail;
      if (args.type !== undefined) t.type = args.type; // schema 接受 type 但 handler 此前未应用（schema-handler 失配 bug）
      if (args.priority !== undefined) t.priority = args.priority ?? null;
      if (args.milestone !== undefined) {
        if (args.milestone) {
          const roadmap = loadRoadmap(root);
          if (!roadmap.milestones.some((m) => m.id === args.milestone)) {
            throw new Error(`里程碑 ${args.milestone} 不存在。`);
          }
        }
        t.milestone = args.milestone ?? null;
      }
      if (args.tags !== undefined) t.tags = args.tags;
      if (args.files !== undefined) t.files = args.files.map(normSep);
      if (args.acceptance !== undefined) t.acceptance = args.acceptance;
      if (args.result_note !== undefined) t.result_note = args.result_note;
      if (args.verification !== undefined) t.verification = args.verification;
      if (prepared.evidence) t.verification = prepared.evidence + (args.verification ? `\n验证说明: ${args.verification}` : "");
      if (args.author !== undefined) t.author = args.author;
      if (args.steps !== undefined) t.steps = args.steps.map((s) => ({ text: s.text, done: s.done ?? false }));
      if (args.step_done !== undefined) {
        const s = t.steps[args.step_done - 1];
        if (!s) throw new Error(`步骤 ${args.step_done} 不存在（共 ${t.steps.length} 步）。`);
        s.done = true;
      }

      const notes: string[] = [];
      if (args.checkpoint) {
        t.checkpoint = { ...args.checkpoint, at: tnow };
        if (args.status === undefined && (t.status === "backlog" || t.status === "todo")) {
          t.status = "in_progress";
          t.started_at ??= tnow;
        }
      }
      if (args.status !== undefined && args.status !== t.status) {
        if (args.status === "done") {
          const note = args.result_note !== undefined ? args.result_note : t.result_note;
          if (!note.trim()) {
            throw new Error(`转 done 必须填 result_note（完成笔记）——「声称做完」要有交代。当前任务 ${t.id} 缺少。`);
          }
          if (note.trim().length < 4) {
            throw new Error(`result_note 过于空洞（「${note.trim()}」）：完成笔记至少要说明做了什么（4 字以上），别拿一个字糊弄账本。`);
          }
          t.completed_at = tnow;
        }
        if (t.status === "done" && args.status !== "done") t.completed_at = null;
        if (args.status === "in_progress" && !t.started_at) t.started_at = tnow;
        t.status = args.status;
      }
      t.updated = tnow;
      saveTasks(root, data);
      if (args.record_session ?? (args.checkpoint !== undefined)) {
        const session = appendSession(root, {
          summary: `${t.id} ${t.title}：${args.status === "done" ? t.result_note : args.checkpoint?.note ?? `状态 ${t.status}`}`,
          files: args.files ?? [], next_steps: args.checkpoint ? [args.checkpoint.next_step] : [], author: args.author,
        }, prepared.hashes);
        notes.push(`会话 ${session} 已自动记录，无需重复 log_session。`);
      }
      refreshDerived(root);
      const stepsInfo = t.steps.length > 0 ? `，步骤 ${t.steps.filter((s) => s.done).length}/${t.steps.length}` : "";
      return [`✅ ${t.id} 已更新（${t.status}${stepsInfo}）。`, ...notes].join("\n");
    },
    (args) => {
      requireInitialized(root);
      const task = loadTasks(root).tasks.find((item) => item.id === args.id);
      if (!task) throw new Error(`找不到任务 ${args.id}。`);
      if (args.status === "done" && (args.result_note ?? task.result_note).trim().length < 4) {
        throw new Error("转 done 必须填写 result_note（至少4字，不能过于空洞）。");
      }
      const evidence = args.status === "done" && (task.type === "feature" || task.type === "fix")
        ? verifiedTaskEvidence(root, args.verification_run, args.files ?? task.files) : undefined;
      const record = args.record_session ?? (args.checkpoint !== undefined);
      return { evidence, taskSnapshot: JSON.stringify(task), hashes: record ? captureFileHashes(root, args.files ?? []) : {} };
    },
  );

  toolW<{ task_id: string; note: string; next_step: string }>(
    server, root,
    "checkpoint",
    "断点存档：长任务做到一半（或上下文快满）时随手保存「当前进度 + 下一步动作」。新会话 get_status 会直接给出恢复点，不用靠回忆。",
    {
      task_id: z.string(),
      note: z.string().describe("当前进展到哪了"),
      next_step: z.string().describe("下一个具体动作（新会话从这里续做）"),
    },
    (args) => {
      requireInitialized(root);
      const data = loadTasks(root);
      const t = data.tasks.find((x) => x.id === args.task_id);
      if (!t) throw new Error(`找不到任务 ${args.task_id}。`);
      t.checkpoint = { note: args.note, next_step: args.next_step, at: now() };
      if (t.status === "backlog" || t.status === "todo") t.status = "in_progress";
      t.updated = now();
      saveTasks(root, data);
      refreshDerived(root);
      return `✅ 断点已存档（${t.id}）。下次会话开工 get_status 会显示「下一步: ${args.next_step}」。`;
    },
  );
}
