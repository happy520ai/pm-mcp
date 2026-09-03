import type { Milestone, Project, Task, Checkpoint } from "./types.ts";
import { ageDays } from "./health.ts";

/** 断点展示后缀：超过 7 天的旧断点标注可能过期 */
export function checkpointSuffix(cp: Checkpoint): string {
  const days = ageDays(cp.at);
  return days > 7 ? `（${days} 天前的断点，可能过期——建议刷新 checkpoint）` : "";
}

/** 进度条：10 格 */
export function bar(pct: number): string {
  const filled = Math.round((Math.max(0, Math.min(100, pct)) / 100) * 10);
  return "[" + "█".repeat(filled) + "░".repeat(10 - filled) + "]";
}

export interface MilestoneStats {
  total: number;
  done: number;
  pct: number;
  refactorish: number;
  refactorPct: number;
}

export function milestoneStats(tasks: Task[], milestoneId: string): MilestoneStats {
  const own = tasks.filter((t) => t.milestone === milestoneId && t.status !== "cancelled");
  const done = own.filter((t) => t.status === "done");
  const refactorish = own.filter((t) => t.type === "refactor" || t.type === "debt");
  return {
    total: own.length,
    done: done.length,
    pct: own.length === 0 ? 0 : Math.round((done.length / own.length) * 100),
    refactorish: refactorish.length,
    refactorPct: own.length === 0 ? 0 : Math.round((refactorish.length / own.length) * 100),
  };
}

const STATUS_ICON: Record<string, string> = {
  done: "✅",
  active: "▶",
  paused: "⏸",
  planned: "○",
};

/**
 * 分层渲染路线图。
 * depth=1：每个里程碑一行摘要（功能再多也不乱）；
 * depth=2：另展开活跃里程碑的任务明细（进行中优先，含断点 next_step）。
 */
export function renderRoadmap(milestones: Milestone[], tasks: Task[], depth = 1, maxTasksPerMilestone = 10): string[] {
  const lines: string[] = [];
  const sorted = [...milestones].sort((a, b) => a.order - b.order);
  if (sorted.length === 0) {
    lines.push("（尚无里程碑，用 add_milestone 创建）");
    return lines;
  }
  for (const m of sorted) {
    const s = milestoneStats(tasks, m.id);
    lines.push(
      `${STATUS_ICON[m.status] ?? "?"} ${bar(s.pct)} ${s.pct}% ${m.id} ${m.title}（${s.done}/${s.total}）`,
    );
    if (depth >= 2 && (m.status === "active" || m.status === "paused")) {
      const own = tasks
        .filter((t) => t.milestone === m.id && t.status !== "cancelled" && t.status !== "done")
        .sort((a, b) => {
          const order = ["in_progress", "blocked", "todo", "backlog"] as const;
          return order.indexOf(a.status as (typeof order)[number]) - order.indexOf(b.status as (typeof order)[number]);
        })
        .slice(0, maxTasksPerMilestone);
      if (own.length === 0) {
        lines.push(`   - （该里程碑暂无未完成任务）`);
      }
      for (const t of own) {
        const mark = t.status === "in_progress" ? "🔄" : t.status === "blocked" ? "🚫" : "☐";
        const next = t.checkpoint ? ` → 下一步: ${t.checkpoint.next_step}${checkpointSuffix(t.checkpoint)}` : "";
        lines.push(`   - ${mark} ${t.id} ${t.title}${next}`);
      }
    }
  }
  return lines;
}

export interface QuotaWarning {
  milestone: string;
  total: number;
  refactorPct: number;
  quotaPct: number;
}

/** 里程碑重构配额检查：任务数达到阈值后，refactor+debt 占比低于配额即告警 */
export function quotaWarnings(project: Project, milestones: Milestone[], tasks: Task[]): QuotaWarning[] {
  const out: QuotaWarning[] = [];
  for (const m of milestones) {
    const s = milestoneStats(tasks, m.id);
    if (s.total >= 5 && m.status !== "done" && s.refactorPct < project.budgets.refactorQuotaPct) {
      out.push({
        milestone: `${m.id} ${m.title}`,
        total: s.total,
        refactorPct: s.refactorPct,
        quotaPct: project.budgets.refactorQuotaPct,
      });
    }
  }
  return out;
}

/** mermaid 里程碑图（GitHub 可渲染；最多 8 个，防 token 膨胀） */
export function mermaidRoadmap(milestones: Milestone[]): string[] {
  const sorted = [...milestones].sort((a, b) => a.order - b.order).slice(0, 8);
  if (sorted.length === 0) return [];
  const lines = ["```mermaid", "flowchart LR"];
  for (const m of sorted) {
    const label = `${m.id} ${m.title}`.replace(/["<>]/g, "");
    lines.push(`  ${m.id.replace(/-/g, "_")}["${label}"]:::${m.status}`);
  }
  for (let i = 0; i + 1 < sorted.length; i++) {
    lines.push(`  ${sorted[i].id.replace(/-/g, "_")} --> ${sorted[i + 1].id.replace(/-/g, "_")}`);
  }
  lines.push(
    "  classDef done fill:#9ca3af,stroke:#6b7280",
    "  classDef active fill:#86efac,stroke:#16a34a",
    "  classDef planned fill:#e5e7eb,stroke:#9ca3af",
    "  classDef paused fill:#fde68a,stroke:#d97706",
    "```",
  );
  return lines;
}
