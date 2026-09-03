import test from "node:test";
import assert from "node:assert/strict";
import { blastRadiusWarning, churnStats, debtAging, footprint } from "../src/health.ts";
import { SessionSchema, TaskSchema, now } from "../src/types.ts";
import type { Session, Task } from "../src/types.ts";

function mkSession(files: string[], daysAgo = 0): Session {
  return SessionSchema.parse({
    id: "S-0001",
    date: new Date(Date.now() - daysAgo * 86_400_000).toISOString(),
    summary: "做事",
    files,
  });
}

test("churnStats 识别被波及 >=3 次的热点文件", () => {
  const sessions = [
    mkSession(["a.ts", "b.ts"]),
    mkSession(["a.ts", "b.ts"]),
    mkSession(["a.ts", "c.ts"]),
  ];
  const s = churnStats(sessions, 3);
  assert.deepEqual(s.hotspots, [{ file: "a.ts", count: 3 }]);
});

test("debtAging 计算最老债务账龄", () => {
  const old = TaskSchema.parse({
    id: "T-001",
    title: "走捷径的债务",
    type: "debt",
    status: "backlog",
    created: new Date(Date.now() - 10 * 86_400_000).toISOString(),
    updated: now(),
  });
  const fresh = TaskSchema.parse({ id: "T-002", title: "新债", type: "debt", status: "backlog", created: now(), updated: now() });
  const done = TaskSchema.parse({ id: "T-003", title: "已清", type: "debt", status: "done", created: now(), updated: now() });
  const a = debtAging([old, fresh, done]);
  assert.equal(a.openDebt, 2);
  assert.equal(a.oldestDays, 10);
  assert.ok(a.oldestTask?.includes("T-001"));
});

test("blastRadiusWarning 超阈值告警", () => {
  const many = mkSession(Array.from({ length: 20 }, (_, i) => `f${i}.ts`));
  const budgets = { sessionBlastRadius: 15 };
  assert.ok(blastRadiusWarning([many], budgets)?.includes("波及 20 个文件"));
  assert.equal(blastRadiusWarning([mkSession(["a.ts"])], budgets), null);
});

test("footprint 汇总近期会话与产出", () => {
  const sessions = [mkSession(["a.ts", "b.ts"]), mkSession(["c.ts"])];
  const done = TaskSchema.parse({
    id: "T-001",
    title: "t",
    status: "done",
    completed_at: now(),
    created: now(),
    updated: now(),
  });
  const fp = footprint(sessions, [done]);
  assert.equal(fp.tasksCompleted30d, 1);
  assert.equal(fp.avgFilesPerSession, 1.5);
});
