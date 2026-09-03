import fs from "node:fs";
import path from "node:path";
import {
  atomicWrite,
  loadDebugLog,
  loadFeatures,
  loadProject,
  loadRoadmap,
  loadSecurity,
  loadSessions,
  loadTasks,
} from "./store.ts";
import { decisionsDir, pmPath, dashboardFile, SESSIONS_JSON } from "./paths.ts";
import { mermaidRoadmap, quotaWarnings, renderRoadmap, checkpointSuffix } from "./roadmap.ts";
import { churnStats, debtAging } from "./health.ts";
import { featureVerifyMark } from "./audit.ts";
import { loadGovernance, type GovernanceFile } from "./governance-model.ts";
import { touchRegistry } from "./registry.ts";

/** 生成 PROJECT.md 全文 */
export function buildDashboard(root: string): string {
  const project = loadProject(root);
  const { milestones } = loadRoadmap(root);
  const { tasks } = loadTasks(root);
  const { features } = loadFeatures(root);
  const { sessions } = loadSessions(root);
  const { entries: debugEntries } = loadDebugLog(root);
  const security = loadSecurity(root);
  let governance: GovernanceFile | null = null;
  try {
    governance = loadGovernance(root);
  } catch {
    // 旧项目迁移前在仪表盘显式显示缺失，不让派生刷新整体失败。
  }
  let latestQuality: { run_at: string; ok: boolean; results: Array<{ status: string }> } | null = null;
  try {
    const dir = pmPath(root, "quality-runs");
    const latest = fs.readdirSync(dir).filter((name) => name.endsWith(".json")).sort().at(-1);
    if (latest) latestQuality = JSON.parse(fs.readFileSync(path.join(dir, latest), "utf8"));
  } catch {
    // 尚未运行真实质量矩阵。
  }
  let latestAcceptance: { report_generated_at: string; verdict: "accepted" | "rejected"; summary: { errors: number; requirements_passed: number; requirements_total: number } } | null = null;
  try {
    const dir = pmPath(root, "acceptance", "reports");
    const latest = fs.readdirSync(dir)
      .filter((name) => name.endsWith(".json") && !name.endsWith(".sha256.json"))
      .flatMap((name) => {
        try {
          const report = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")) as typeof latestAcceptance;
          const timestamp = report ? Date.parse(report.report_generated_at) : Number.NaN;
          return Number.isFinite(timestamp) ? [{ name, timestamp, report }] : [];
        } catch {
          return [];
        }
      })
      // Git checkout commonly gives every tracked report the same mtime, so
      // report content—not filesystem metadata—must determine recency.
      .sort((a, b) => b.timestamp - a.timestamp || b.name.localeCompare(a.name))[0];
    if (latest) latestAcceptance = latest.report;
  } catch {
    // 尚未执行标准化验收。
  }

  const L: string[] = [];
  L.push(`# ${project.name} — 项目仪表盘`);
  L.push("");
  L.push(`> ⚠️ 本文件由 pm-mcp 自动生成（勿手改）。状态账本写入后自动刷新；手动刷新用 regenerate_dashboard。`);
  L.push(`> 生成时间: ${new Date().toISOString()}`);
  if (project.description) L.push(`> ${project.description}`);
  L.push("");

  /* 路线图置顶 */
  L.push("## 🗺️ 路线图");
  L.push("");
  const mm = mermaidRoadmap(milestones);
  if (mm.length > 0) L.push(...mm, "");
  L.push(...renderRoadmap(milestones, tasks, 1));
  const warns = quotaWarnings(project, milestones, tasks);
  for (const w of warns) {
    L.push(`- ⚠️ 重构被挤出: ${w.milestone} 重构类占比 ${w.refactorPct}% < 配额 ${w.quotaPct}%`);
  }
  L.push("");

  /* 当前焦点（断点恢复点） */
  L.push("## 🎯 当前焦点");
  const active = tasks.filter((t) => t.status === "in_progress" || t.status === "blocked");
  if (active.length === 0) {
    L.push("- （无进行中任务。从 backlog 挑一个开始，或 add_task 创建。）");
  } else {
    for (const t of active.slice(0, 10)) {
      const next = t.checkpoint ? ` → 下一步: ${t.checkpoint.next_step}${checkpointSuffix(t.checkpoint)}` : "";
      const steps = t.steps.length > 0 ? `（步骤 ${t.steps.filter((s) => s.done).length}/${t.steps.length}）` : "";
      L.push(`- ${t.status === "blocked" ? "🚫" : "🔄"} ${t.id} ${t.title}${steps}${next}`);
    }
  }
  if (project.phase) L.push(`- 当前阶段: ${project.phase}`);
  L.push("");

  /* 健康摘要 */
  L.push("## 🩺 健康摘要");
  const aging = debtAging(tasks);
  const openFindings = security.findings.filter((f) => f.status === "open");
  const highFindings = openFindings.filter((f) => f.severity === "high");
  const churn = churnStats(sessions);
  const implemented = features.filter((f) => f.status === "implemented");
  const drifted = implemented.filter((f) => f.entry_files.some((p) => !fs.existsSync(path.join(root, p))));
  L.push(`| 账本 | 状态 |`);
  L.push(`|---|---|`);
  L.push(`| 漂移（防幻觉） | ${drifted.length === 0 ? "✅ 无" : `⚠️ ${drifted.length} 个功能入口文件缺失`} |`);
  L.push(`| 债务（反挤出） | ${aging.openDebt === 0 ? "✅ 无未清债务" : `⚠️ ${aging.openDebt} 条，最老 ${aging.oldestDays} 天`} |`);
  L.push(`| churn（变更率） | ${churn.hotspots.length === 0 ? "✅ 无热点" : `⚠️ 热点 ${churn.hotspots.slice(0, 3).map((h) => `${h.file}(${h.count})`).join(", ")}`} |`);
  L.push(`| 安全 | ${openFindings.length === 0 ? "✅ 无未处理发现" : `⚠️ ${openFindings.length} 个未处理（高危 ${highFindings.length}）`} |`);
  L.push(`| 调试知识 | ${debugEntries.length} 条记录 |`);
  L.push(`| 测试背书 | ${implemented.length === 0 ? "—" : `${implemented.filter((f) => f.test_files.length > 0).length}/${implemented.length} 个功能带测试`} |`);
  L.push(`| 语义治理 | ${governance ? `${governance.modules.length} 模块 / ${governance.interfaces.length} 接口 / ${governance.repositories.length} 仓库` : "⚠️ 未初始化"} |`);
  L.push(`| 质量矩阵 | ${latestQuality ? `${latestQuality.ok ? "✅" : "🚩"} ${latestQuality.run_at.slice(0, 16).replace("T", " ")}（${latestQuality.results.filter((item) => item.status === "passed").length}/${latestQuality.results.length}）` : "⚠️ 尚无真实执行记录"} |`);
  L.push(`| 标准化验收 | ${latestAcceptance ? `${latestAcceptance.verdict === "accepted" ? "✅" : "🚩"} ${latestAcceptance.report_generated_at.slice(0, 16).replace("T", " ")}（需求 ${latestAcceptance.summary.requirements_passed}/${latestAcceptance.summary.requirements_total}，errors ${latestAcceptance.summary.errors}）` : "⚠️ 尚无正式评价报告"} |`);
  L.push("");

  /* 跨模块/语言治理（这里只读账本，不在每次写操作时重跑全仓语义图） */
  L.push("## 🧭 模块与语言治理");
  if (!governance) {
    L.push("- ⚠️ governance.json 缺失；用 init_governance/upsert_module 完成迁移。");
  } else if (governance.modules.length === 0) {
    L.push("- ⚠️ 尚未登记结构化模块；文件级账本可用，但依赖/owner/接口边界尚未启用。");
  } else {
    for (const module of governance.modules.slice(0, 12)) {
      L.push(`- ${module.id} [${module.kind}] ${module.languages.join("+") || "未知语言"} · owner ${module.owners.join(",") || "未声明"} · roots ${module.roots.join(",")}`);
    }
    L.push(`- 策略: ownership=${governance.policies.enforce_ownership} · declared-deps=${governance.policies.enforce_declared_dependencies} · public-interfaces=${governance.policies.enforce_public_interfaces} · unresolved=${governance.policies.fail_on_unresolved} · source-coverage≥${governance.policies.minimum_coverage_pct}% · semantic≥${governance.policies.minimum_semantic_assurance} · regex-fallback=${governance.policies.fail_on_semantic_fallback ? "forbidden" : "allowed"} · quality=${governance.policies.required_quality_kinds.join(",")}`);
    L.push("- 实时语义结果：pm://architecture / audit_governance；跨仓：pm://portfolio。");
  }
  L.push("");

  /* 任务概览 */
  L.push("## 📋 任务");
  const byStatus = new Map<string, number>();
  for (const t of tasks) byStatus.set(t.status, (byStatus.get(t.status) ?? 0) + 1);
  L.push(
    `- 总览: ${[...byStatus.entries()].map(([k, v]) => `${k} ${v}`).join(" · ") || "（无任务）"}`,
  );
  const todo = tasks
    .filter((t) => t.status === "todo" || t.status === "in_progress")
    .slice(0, 8);
  for (const t of todo) L.push(`- [${t.status}] ${t.id} ${t.title} (${t.type}${t.milestone ? `, ${t.milestone}` : ""})`);
  L.push("");

  /* 功能清单（按模块分组，带验证状态） */
  L.push("## 🧩 功能清单");
  if (features.length === 0) {
    L.push("- （暂无登记。功能落地后用 register_feature 登记，回答「这个项目有哪些功能」。）");
  } else {
    const groups = new Map<string, typeof features>();
    for (const f of features) {
      const key = f.module || "未分组";
      const arr = groups.get(key) ?? [];
      arr.push(f);
      groups.set(key, arr);
    }
    for (const [mod, list] of groups) {
      L.push(`### ${mod}`);
      for (const f of list) {
        const mark = f.status !== "implemented" ? "○" : featureVerifyMark(root, f.entry_files, f.test_files);
        L.push(`- ${mark} ${f.id} ${f.name} — ${f.description.slice(0, 80)}`);
      }
    }
  }
  L.push("");

  /* 架构决策 */
  L.push("## 🏛️ 架构决策（最近）");
  const adrDir = decisionsDir(root);
  if (fs.existsSync(adrDir)) {
    const names = fs.readdirSync(adrDir).filter((n) => n.endsWith(".md")).sort().reverse().slice(0, 5);
    if (names.length === 0) L.push("- （暂无）");
    for (const n of names) L.push(`- [${n.replace(/\.md$/, "")}](${`.pm/decisions/${n}`})`);
  } else {
    L.push("- （暂无）");
  }
  L.push("");

  /* 最近会话 */
  L.push("## 📜 最近会话");
  if (sessions.length === 0) {
    L.push("- （暂无。收工时用 log_session 记录。）");
  } else {
    for (const s of sessions.slice(-5).reverse()) {
      L.push(`- ${s.date.slice(0, 10)} [${s.author || "?"}] ${s.summary}`);
      if (s.files.length > 0) L.push(`  - 改动: ${s.files.slice(0, 8).join(", ")}${s.files.length > 8 ? ` 等 ${s.files.length} 个` : ""}`);
    }
  }
  L.push("");
  L.push("---");
  L.push(`stack: ${project.stack.join(", ") || "—"} · modules: ${project.modules.join(", ") || "—"} · exposure: ${project.exposure} · license: ${project.license || "未声明"}`);
  return L.join("\n") + "\n";
}

/** 从 sessions.json 生成 changelog.md */
export function buildChangelog(root: string): string {
  const { sessions } = loadSessions(root);
  const L: string[] = ["# 变更日志（自动生成，来自 sessions.json）", ""];
  for (const s of [...sessions].reverse()) {
    L.push(`## ${s.date.slice(0, 10)} — ${s.author || "未知"}`);
    L.push("");
    L.push(s.summary);
    if (s.files.length > 0) {
      L.push("");
      L.push(`改动文件（${s.files.length}）: ${s.files.join(", ")}`);
    }
    if (s.next_steps.length > 0) {
      L.push("");
      L.push(`下一步: ${s.next_steps.join("；")}`);
    }
    L.push("");
  }
  if (sessions.length === 0) L.push("（暂无会话记录。）");
  return L.join("\n") + "\n";
}

/**
 * 派生刷新：每次写操作后调用。重写 PROJECT.md 与 changelog.md，并 touch 全局注册表。
 * 任何派生失败只写 stderr，绝不回滚主操作。
 */
export function refreshDerived(root: string): void {
  try {
    let name = "";
    try {
      name = loadProject(root).name;
    } catch {
      return;
    }
    // 原子写：多进程并发刷新仪表盘时不会产生半截文件
    atomicWrite(dashboardFile(root), buildDashboard(root));
    atomicWrite(pmPath(root, "changelog.md"), buildChangelog(root));
    if (name) touchRegistry(root, name);
  } catch (e) {
    console.error(`[pm-mcp] 派生刷新失败（不影响主操作）: ${(e as Error).message}`);
  }
}
