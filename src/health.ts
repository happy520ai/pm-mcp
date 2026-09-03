import type { Budgets, Session, Task } from "./types.ts";

/** 距今天数 */
export function ageDays(iso: string, nowMs = Date.now()): number {
  return Math.max(0, Math.floor((nowMs - Date.parse(iso)) / 86_400_000));
}

/* --------------------------------- churn 账 -------------------------------- */

export interface ChurnStats {
  /** 被波及 >= threshold 次的文件，按次数降序 */
  hotspots: { file: string; count: number }[];
  sessionCount: number;
}

export function churnStats(sessions: Session[], threshold = 3, topN = 10): ChurnStats {
  const counts = new Map<string, number>();
  for (const s of sessions) {
    for (const f of s.files) counts.set(f, (counts.get(f) ?? 0) + 1);
  }
  const hotspots = [...counts.entries()]
    .filter(([, c]) => c >= threshold)
    .map(([file, count]) => ({ file, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, topN);
  return { hotspots, sessionCount: sessions.length };
}

/* --------------------------------- 债务账 --------------------------------- */

export interface DebtAging {
  openDebt: number;
  oldestDays: number;
  oldestTask: string | null;
}

export function debtAging(tasks: Task[], nowMs = Date.now()): DebtAging {
  const open = tasks.filter((t) => t.type === "debt" && t.status !== "done" && t.status !== "cancelled");
  let oldestDays = 0;
  let oldestTask: string | null = null;
  for (const t of open) {
    const d = ageDays(t.created, nowMs);
    if (d > oldestDays) {
      oldestDays = d;
      oldestTask = `${t.id} ${t.title}`;
    }
  }
  return { openDebt: open.length, oldestDays, oldestTask };
}

/* -------------------------------- 波及面告警 ------------------------------- */

export function blastRadiusWarning(sessions: Session[], budgets: BudgetRadius): string | null {
  const last = sessions[sessions.length - 1];
  if (!last) return null;
  if (last.files.length > budgets.sessionBlastRadius) {
    return `最近一次会话波及 ${last.files.length} 个文件，超过阈值 ${budgets.sessionBlastRadius}——建议拆小任务或先立重构任务（散弹式修改嫌疑：${last.files.slice(0, 5).join(", ")}…）`;
  }
  return null;
}

interface BudgetRadius {
  sessionBlastRadius: number;
}

/* ------------------------------- 足迹/产出比 ------------------------------- */

export interface Footprint {
  recentSessions: { date: string; author: string; files: number; summary: string }[];
  tasksCompleted30d: number;
  avgFilesPerSession: number;
}

export function footprint(sessions: Session[], tasks: Task[], nowMs = Date.now()): Footprint {
  const recent = sessions.slice(-5).reverse();
  const cutoff = nowMs - 30 * 86_400_000;
  const completed30d = tasks.filter(
    (t) => t.completed_at && Date.parse(t.completed_at) >= cutoff,
  ).length;
  const avg =
    sessions.length === 0
      ? 0
      : Math.round((sessions.reduce((s, x) => s + x.files.length, 0) / sessions.length) * 10) / 10;
  return {
    recentSessions: recent.map((s) => ({
      date: s.date.slice(0, 10),
      author: s.author || "未知",
      files: s.files.length,
      summary: s.summary.length > 60 ? s.summary.slice(0, 60) + "…" : s.summary,
    })),
    tasksCompleted30d: completed30d,
    avgFilesPerSession: avg,
  };
}
