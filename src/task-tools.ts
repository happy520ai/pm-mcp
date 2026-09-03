import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { refreshDerived } from "./dashboard.ts";
import { foldLines, normSep } from "./budget.ts";
import { requireInitialized } from "./paths.ts";
import { loadRoadmap, loadTasks, nextId, saveTasks } from "./store.ts";
import { now, type TaskStatus, type TaskType } from "./types.ts";
import { budgetLines, toolR, toolW } from "./tool-base.ts";

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

  toolR<{ status?: TaskStatus; type?: TaskType; milestone?: string; tag?: string; include_done?: boolean }>(
    server, root,
    "list_tasks",
    "列出任务（默认不含 done/cancelled）。可按状态/类型/里程碑/标签过滤。",
    {
      status: z.enum(["backlog", "todo", "in_progress", "blocked", "done", "cancelled"]).optional(),
      type: z.enum(["feature", "refactor", "fix", "chore", "debt"]).optional(),
      milestone: z.string().optional(),
      tag: z.string().optional(),
      include_done: z.boolean().optional().describe("默认 false"),
    },
    (args) => {
      requireInitialized(root);
      const { tasks } = loadTasks(root);
      let list = tasks;
      if (args.status) list = list.filter((t) => t.status === args.status);
      else if (!args.include_done) list = list.filter((t) => t.status !== "done" && t.status !== "cancelled");
      if (args.type) list = list.filter((t) => t.type === args.type);
      if (args.milestone) list = list.filter((t) => t.milestone === args.milestone);
      if (args.tag) list = list.filter((t) => t.tags.includes(args.tag!));
      const L = list.map((t) => {
        const mark = t.status === "in_progress" ? "🔄" : t.status === "blocked" ? "🚫" : t.status === "done" ? "✅" : "☐";
        const extra: string[] = [];
        if (t.priority) extra.push(t.priority);
        if (t.type !== "feature") extra.push(t.type);
        if (t.checkpoint) extra.push(`下一步: ${t.checkpoint.next_step}`);
        return `${mark} ${t.id} ${t.title}${extra.length ? `（${extra.join(", ")}）` : ""}`;
      });
      return foldLines([`共 ${list.length} 个任务（全部 ${tasks.length} 个）:`, ...L], {
        maxLines: budgetLines(root),
        hint: "用 status/type/milestone 过滤",
      });
    },
  );

  toolW<{
    id: string;
    status?: TaskStatus;
    title?: string;
    detail?: string;
    priority?: "P0" | "P1" | "P2" | "P3" | null;
    milestone?: string | null;
    tags?: string[];
    files?: string[];
    acceptance?: string;
    result_note?: string;
    verification?: string;
    steps?: { text: string; done?: boolean }[];
    step_done?: number;
    author?: string;
  }>(
    server, root,
    "update_task",
    "更新任务。转 done 必须填 result_note；feature/fix 建议填 verification（用什么命令/测试证明）。step_done 勾选第 N 步（从 1 起）。steps 整体替换步骤清单。",
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
      steps: z.array(stepSchema).optional().describe("整体替换步骤清单"),
      step_done: z.number().int().min(1).optional().describe("勾选完成第 N 步"),
      author: z.string().optional(),
    },
    (args) => {
      requireInitialized(root);
      const data = loadTasks(root);
      const t = data.tasks.find((x) => x.id === args.id);
      if (!t) throw new Error(`找不到任务 ${args.id}。`);
      const tnow = now();

      if (args.title !== undefined) t.title = args.title;
      if (args.detail !== undefined) t.detail = args.detail;
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
      if (args.author !== undefined) t.author = args.author;
      if (args.steps !== undefined) t.steps = args.steps.map((s) => ({ text: s.text, done: s.done ?? false }));
      if (args.step_done !== undefined) {
        const s = t.steps[args.step_done - 1];
        if (!s) throw new Error(`步骤 ${args.step_done} 不存在（共 ${t.steps.length} 步）。`);
        s.done = true;
      }

      const notes: string[] = [];
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
          if (!t.verification.trim() && (args.verification === undefined || !args.verification.trim())) {
            if (t.type === "feature" || t.type === "fix") {
              notes.push("💡 提示: 该任务是 " + t.type + " 类型但没填 verification——用什么命令/测试证明它真的好了？建议补上（update_task id=" + t.id + " verification=...）。");
            }
          }
        }
        if (t.status === "done" && args.status !== "done") t.completed_at = null;
        if (args.status === "in_progress" && !t.started_at) t.started_at = tnow;
        t.status = args.status;
      }
      t.updated = tnow;
      saveTasks(root, data);
      refreshDerived(root);
      const stepsInfo = t.steps.length > 0 ? `，步骤 ${t.steps.filter((s) => s.done).length}/${t.steps.length}` : "";
      return [`✅ ${t.id} 已更新（${t.status}${stepsInfo}）。`, ...notes].join("\n");
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
