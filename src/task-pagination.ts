import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { loadTasks } from "./store.ts";
import { TaskStatusSchema, TaskTypeSchema, type TasksFile } from "./types.ts";

export interface TaskListQuery {
  status?: z.infer<typeof TaskStatusSchema>;
  type?: z.infer<typeof TaskTypeSchema>;
  milestone?: string;
  tag?: string;
  include_done?: boolean;
  page_size?: number;
  cursor?: string;
}

const CursorSchema = z.object({ v: z.literal(1), revision: z.string().regex(/^[a-f0-9]{64}$/), offset: z.number().int().positive(), size: z.number().int().min(1).max(100) }).strict();
export const TaskPageSchema = z.object({
  total: z.number().int().nonnegative(), all_total: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(), page_size: z.number().int().min(1).max(100), returned: z.number().int().nonnegative(),
  has_more: z.boolean(), next_cursor: z.string().nullable(), revision: z.string(),
  items: z.array(z.object({ id: z.string(), title: z.string(), status: TaskStatusSchema, type: TaskTypeSchema,
    priority: z.string().nullable(), milestone: z.string().nullable(), next_step: z.string().nullable(), abbreviated: z.boolean() })),
});
export type TaskPage = z.infer<typeof TaskPageSchema>;

/** 游标是读取位置，不是授权凭据；绑定项目、过滤及同一份已读取的账本快照。 */
export function taskPage(root: string, query: TaskListQuery, maximum = 100, data: TasksFile = loadTasks(root)): TaskPage {
  const filters = { status: query.status ?? null, type: query.type ?? null, milestone: query.milestone ?? null, tag: query.tag ?? null, include_done: query.include_done ?? false };
  let canonical = fs.realpathSync.native(path.resolve(root));
  if (process.platform === "win32") canonical = canonical.toLowerCase();
  const revision = createHash("sha256").update(canonical).update("\0").update(JSON.stringify(filters)).update("\0").update(JSON.stringify(data)).digest("hex");
  let cursor: z.infer<typeof CursorSchema> | undefined;
  if (query.cursor !== undefined) {
    try {
      if (query.cursor.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(query.cursor)) throw new Error();
      cursor = CursorSchema.parse(JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8")));
    } catch { throw new Error("分页游标无效，请从第一页重新读取。"); }
    if (cursor.revision !== revision) throw new Error("任务数据、项目或过滤条件已变化，游标失效，请重新读取第一页。");
  }
  const limit = Math.max(1, Math.min(100, Math.floor(maximum)));
  const requested = query.page_size ?? cursor?.size ?? 25;
  if (!Number.isInteger(requested) || requested < 1 || requested > 100) throw new Error("page_size 必须为 1 到 100。");
  const size = Math.min(requested, limit);
  if (cursor && (cursor.size !== size || cursor.offset % size !== 0)) throw new Error("分页大小或输出预算已变化，请重新读取第一页。");
  const list = data.tasks.filter((task) =>
    (query.status ? task.status === query.status : query.include_done || !["done", "cancelled"].includes(task.status)) &&
    (!query.type || task.type === query.type) && (!query.milestone || task.milestone === query.milestone) && (!query.tag || task.tags.includes(query.tag)));
  const offset = cursor?.offset ?? 0;
  if (cursor && offset >= list.length) throw new Error("分页游标越界，请重新读取第一页。");
  const brief = (text: string, length: number) => { const one = text.replace(/\s+/g, " "); return one.length > length ? one.slice(0, length) + "…" : one; };
  const items = list.slice(offset, offset + size).map((task) => {
    const title = brief(task.title, 160), nextStep = task.checkpoint ? brief(task.checkpoint.next_step, 80) : null;
    return { id: task.id, title, status: task.status, type: task.type, priority: task.priority, milestone: task.milestone,
      next_step: nextStep, abbreviated: title !== task.title || nextStep !== (task.checkpoint?.next_step ?? null) };
  });
  const next = offset + items.length;
  return { total: list.length, all_total: data.tasks.length, offset, page_size: size, returned: items.length, has_more: next < list.length,
    next_cursor: next < list.length ? Buffer.from(JSON.stringify({ v: 1, revision, offset: next, size })).toString("base64url") : null, revision, items };
}

export function taskPageText(page: TaskPage): string {
  return [
    `共 ${page.total} 个任务（全部 ${page.all_total} 个）；本页 ${page.offset + (page.returned ? 1 : 0)}-${page.offset + page.returned}，返回 ${page.returned} 个。`,
    ...page.items.map((task) => `${task.status === "in_progress" ? "🔄" : task.status === "blocked" ? "🚫" : task.status === "done" ? "✅" : "☐"} ${task.id} [${task.status}/${task.type}${task.priority ? `/${task.priority}` : ""}] ${task.title}${task.next_step ? ` → ${task.next_step}` : ""}`),
    page.next_cursor ? `下一页：保持过滤条件，list_tasks 传 cursor=${page.next_cursor}` : "已到末页，无更多任务。",
    ...(page.items.some((task) => task.abbreviated) ? ["长标题或下一步已缩略；任务编号与分页条目完整。"] : []),
  ].join("\n");
}
