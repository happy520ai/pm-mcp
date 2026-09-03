import test from "node:test";
import assert from "node:assert/strict";
import { milestoneStats, quotaWarnings, renderRoadmap, mermaidRoadmap, bar } from "../src/roadmap.ts";
import { MilestoneSchema, ProjectSchema, TaskSchema, now } from "../src/types.ts";
import type { Milestone, Task } from "../src/types.ts";

function mkMilestone(id: string, status: Milestone["status"] = "active"): Milestone {
  return MilestoneSchema.parse({ id, title: `里程碑${id}`, status, created: now(), updated: now() });
}

function mkTask(id: string, status: Task["status"], type: Task["type"] = "feature", milestone = "M1"): Task {
  return TaskSchema.parse({ id, title: `任务${id}`, status, type, milestone, created: now(), updated: now() });
}

test("bar 生成 10 格进度条", () => {
  assert.equal(bar(40), "[████░░░░░░]");
  assert.equal(bar(100), "[██████████]");
  assert.equal(bar(0), "[░░░░░░░░░░]");
});

test("milestoneStats 统计进度与重构占比", () => {
  const tasks = [
    mkTask("T-1", "done"),
    mkTask("T-2", "done"),
    mkTask("T-3", "in_progress"),
    mkTask("T-4", "cancelled", "feature"), // 取消不计
    mkTask("T-5", "backlog", "refactor"),
    mkTask("T-6", "todo", "debt"),
  ];
  const s = milestoneStats(tasks, "M1");
  assert.equal(s.total, 5);
  assert.equal(s.done, 2);
  assert.equal(s.pct, 40);
  assert.equal(s.refactorish, 2);
  assert.equal(s.refactorPct, 40);
});

test("quotaWarnings：任务多且重构占比低于配额才告警", () => {
  const project = ProjectSchema.parse({ name: "p", created: now(), updated: now() });
  const m = [mkMilestone("M1", "active")];
  // 6 个纯 feature 任务 → 占比 0% < 20% → 告警
  const featureOnly = Array.from({ length: 6 }, (_, i) => mkTask(`T-${i}`, "backlog"));
  assert.equal(quotaWarnings(project, m, featureOnly).length, 1);
  // 2 refactor + 4 feature = 33% ≥ 20% → 不告警
  const mixed = [
    ...Array.from({ length: 4 }, (_, i) => mkTask(`F-${i}`, "backlog")),
    ...Array.from({ length: 2 }, (_, i) => mkTask(`R-${i}`, "backlog", "refactor")),
  ];
  assert.equal(quotaWarnings(project, m, mixed).length, 0);
  // 任务太少（<5）不告警，避免噪音
  assert.equal(quotaWarnings(project, m, featureOnly.slice(0, 3)).length, 0);
});

test("renderRoadmap depth=1 单行摘要，depth=2 展开活跃任务", () => {
  const ms = [mkMilestone("M1", "active"), mkMilestone("M2", "planned")];
  const tasks = [mkTask("T-1", "in_progress"), mkTask("T-2", "done")];
  const d1 = renderRoadmap(ms, tasks, 1).join("\n");
  assert.ok(d1.includes("[██"));
  assert.ok(d1.includes("M1"));
  assert.ok(!d1.includes("T-1"), "depth=1 不展开任务");
  const d2 = renderRoadmap(ms, tasks, 2).join("\n");
  assert.ok(d2.includes("T-1"), "depth=2 展开活跃里程碑任务");
  assert.ok(!d2.includes("T-2 任务T-2"), "done 任务不展开");
});

test("mermaidRoadmap 用代码块包裹且可含状态样式", () => {
  const out = mermaidRoadmap([mkMilestone("M1"), mkMilestone("M2")]).join("\n");
  assert.ok(out.startsWith("```mermaid"));
  assert.ok(out.includes("flowchart LR"));
  assert.ok(out.includes("classDef active"));
});

test("checkpoint 的下一步在 depth=2 中可见（断点续做）", () => {
  const ms = [mkMilestone("M1", "active")];
  const t = mkTask("T-9", "in_progress");
  t.checkpoint = { note: "写到一半", next_step: "补测试", at: now() };
  const d2 = renderRoadmap(ms, [t], 2).join("\n");
  assert.ok(d2.includes("下一步: 补测试"));
});
