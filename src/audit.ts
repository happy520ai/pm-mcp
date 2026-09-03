import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  loadFeatures,
  loadFileNotes,
  loadProject,
  loadRoadmap,
  loadSessions,
  loadTasks,
  saveJson,
} from "./store.ts";
import { decisionsDir, pmPath, snapshotsDir } from "./paths.ts";
import { normSep, foldLines } from "./budget.ts";
import { readDirectDeps } from "./scan.ts";
import { aggregates, ensureFresh, getIndex, getMeta } from "./index-store.ts";
import { quotaWarnings, milestoneStats } from "./roadmap.ts";
import { blastRadiusWarning, churnStats, debtAging, footprint } from "./health.ts";
import { now, type Snapshot } from "./types.ts";

/* --------------------------------- 快照 ---------------------------------- */

/** 用途索引覆盖：登记过用途且真实存在的文件数 */
export function annotatedCount(root: string, db: ReturnType<typeof getIndex>): number {
  const notes = loadFileNotes(root).notes;
  const stmt = db.prepare("SELECT 1 FROM files WHERE rel=?");
  let n = 0;
  for (const key of Object.keys(notes)) {
    if (stmt.get(key)) n += 1;
  }
  return n;
}

export function snapshotCodebase(root: string): { snapshot: Snapshot; summary: string[] } {
  ensureFresh(root);
  const db = getIndex(root);
  const agg = aggregates(db);
  const annotated = annotatedCount(root, db);
  const coverage = agg.indexCoverageBase === 0 ? 0 : Math.round((annotated / agg.indexCoverageBase) * 100);
  const { deps } = readDirectDeps(root);

  const stamp = now().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
  const snapName = `snap-${stamp}.json`;
  const snapshot: Snapshot = {
    taken_at: now(),
    file: `.pm/snapshots/${snapName}`,
    total_files: agg.totalFiles,
    total_loc: agg.totalLoc,
    test_files: agg.testFiles,
    skip_markers: agg.skipMarkers,
    deps,
    by_ext: agg.byExt.map((e) => ({ ext: e.ext || "(无扩展名)", files: e.files, loc: e.loc })),
    top_dirs: agg.topDirs,
    largest_files: agg.largestFiles,
    index_coverage_pct: coverage,
  };
  saveJson(pmPath(root, "snapshots", snapName), snapshot);
  return {
    snapshot,
    summary: [
      `快照已保存: ${snapshot.file}`,
      `文件 ${snapshot.total_files} 个，总行数 ${snapshot.total_loc}，测试文件 ${snapshot.test_files} 个，skip 标记 ${snapshot.skip_markers} 处`,
      `索引覆盖率 ${coverage}%（${annotated}/${agg.indexCoverageBase} 个源文件有用途注解）`,
    ],
  };
}

export function latestSnapshot(root: string): Snapshot | null {
  const dir = snapshotsDir(root);
  if (!fs.existsSync(dir)) return null;
  const names = fs
    .readdirSync(dir)
    .filter((n) => n.startsWith("snap-") && n.endsWith(".json"))
    .sort();
  if (names.length === 0) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, names[names.length - 1]), "utf8")) as Snapshot;
  } catch {
    return null;
  }
}

/* -------------------------------- 对账报告 -------------------------------- */

export interface DriftItem {
  kind: "feature" | "task";
  id: string;
  name: string;
  missing: string[];
}

/** 漂移检测：功能/任务引用的文件是否真实存在（防幻觉对账） */
export function detectDrift(root: string): DriftItem[] {
  const out: DriftItem[] = [];
  const features = loadFeatures(root).features;
  for (const f of features) {
    const missing = (f.status === "implemented" ? f.entry_files : []).filter(
      (p) => !fs.existsSync(path.join(root, p)),
    );
    if (missing.length > 0) out.push({ kind: "feature", id: f.id, name: f.name, missing });
  }
  const tasks = loadTasks(root).tasks;
  for (const t of tasks) {
    if (t.status !== "done") continue;
    const missing = t.files.filter((p) => !fs.existsSync(path.join(root, p)));
    if (missing.length > 0) out.push({ kind: "task", id: t.id, name: t.title, missing });
  }
  return out;
}

/** 功能验证状态（仪表盘用）：✅ 入口文件齐全 / ⚠️ 漂移 / ○ 无锚点 / 🧪 无测试 */
export function featureVerifyMark(root: string, entryFiles: string[], testFiles: string[]): string {
  if (entryFiles.length === 0) return "○ 无锚点";
  const missing = entryFiles.filter((p) => !fs.existsSync(path.join(root, p)));
  if (missing.length > 0) return "⚠️ 漂移";
  if (testFiles.filter((p) => fs.existsSync(path.join(root, p))).length === 0) return "🧪 无测试";
  return "✅";
}

/* ------------------------- 完整性 / git 对账（防钻空） ------------------------- */

const PM_REQUIRED_FILES = [
  "project.json",
  "roadmap.json",
  "tasks.json",
  "features.json",
  "sessions.json",
  "debuglog.json",
  "file-notes.json",
  "security.json",
  "governance.json",
];

/** .pm 完整性：账本文件被删不能静默回退空表，必须点名 */
export function pmIntegrity(root: string): string[] {
  const missing: string[] = [];
  for (const f of PM_REQUIRED_FILES) {
    if (!fs.existsSync(pmPath(root, f))) missing.push(f);
  }
  if (!fs.existsSync(decisionsDir(root))) missing.push("decisions/");
  if (!fs.existsSync(snapshotsDir(root))) missing.push("snapshots/");
  return missing;
}

export interface GitAudit {
  available: boolean;
  /** 有变更但未在最近一次会话入账的文件 */
  unaccounted: string[];
  ignoresPm: boolean;
  error: string | null;
}

/** git 对账：自报变更足迹 vs 真实工作区状态 */
export function gitAudit(root: string): GitAudit {
  const out: GitAudit = { available: false, unaccounted: [], ignoresPm: false, error: null };
  if (!fs.existsSync(path.join(root, ".git"))) return out;
  out.available = true;
  // .gitignore 是否把 .pm 排除出版本控制
  const gi = path.join(root, ".gitignore");
  if (fs.existsSync(gi)) {
    for (const line of fs.readFileSync(gi, "utf8").split("\n")) {
      const t = line.trim();
      if (t.startsWith("#") || !t) continue;
      if (t === ".pm" || t === ".pm/" || t === "/.pm" || t === "/.pm/") {
        out.ignoresPm = true;
        break;
      }
    }
  }
  // -uall：未跟踪目录展开为具体文件（默认只给 "?? src/" 目录缩写，抓不到文件）
  const status = spawnSync("git", ["status", "--porcelain", "-uall"], { cwd: root, encoding: "utf8", timeout: 10_000 });
  if (status.error || status.status !== 0) {
    out.error = status.error?.message ?? `git status 退出码 ${status.status ?? "未知"}: ${(status.stderr ?? "").trim().slice(0, 200)}`;
    return out;
  }
  const changed = new Set<string>();
  for (const line of status.stdout.split("\n")) {
    const rel = normSep(line.slice(3).trim().split(" -> ").pop() ?? "");
    if (!rel) continue;
    if (rel.startsWith(".pm/") || rel === "PROJECT.md" || rel === ".gitignore") continue;
    changed.add(rel);
  }
  const sessions = loadSessions(root).sessions;
  const lastFiles = new Set(sessions[sessions.length - 1]?.files ?? []);
  out.unaccounted = [...changed].filter((f) => !lastFiles.has(f));
  return out;
}

/** 完整结构对账：九项报告 */
export function auditStructure(root: string, maxLines = 150): string {
  const project = loadProject(root);
  const { features } = loadFeatures(root);
  const { tasks } = loadTasks(root);
  const { milestones } = loadRoadmap(root);
  const { sessions } = loadSessions(root);
  const fresh = ensureFresh(root);
  const db = getIndex(root);
  const agg = aggregates(db);
  const deps = readDirectDeps(root).deps;
  const prev = latestSnapshot(root);
  const L: string[] = [];
  const budgets = project.budgets;
  const topLoc = (top: string): number =>
    (db.prepare(`SELECT COALESCE(SUM(loc),0) s FROM files WHERE top=?`).get(top) as { s: number }).s;

  /* ⓪ .pm 完整性（账本被删不得静默回退空表） */
  const missing = pmIntegrity(root);
  L.push("## ⓪ 账本完整性");
  if (missing.length === 0) {
    L.push("✅ .pm 账本文件齐全。");
  } else {
    L.push(`- 🚩 账本文件丢失: ${missing.join(", ")}——数据可能被误删，请从 git 历史恢复（load 层的空表回退只是应急，不是恢复）。`);
  }

  /* ① 增长 */
  L.push("");
  L.push("## ① 增长（对比上次快照）");
  L.push(`新鲜度: ${fresh.used === "watcher" ? "watcher 保鲜（免全量走查）" : "全量走查"}`);
  if (prev) {
    const dFiles = agg.totalFiles - prev.total_files;
    const dLoc = agg.totalLoc - prev.total_loc;
    L.push(
      `基线快照: ${prev.file}（${prev.taken_at.slice(0, 16).replace("T", " ")}）`,
    );
    L.push(
      `文件 ${prev.total_files} → ${agg.totalFiles}（${dFiles >= 0 ? "+" : ""}${dFiles}），行数 ${prev.total_loc} → ${agg.totalLoc}（${dLoc >= 0 ? "+" : ""}${dLoc}）`,
    );
    // 增长热点：历史 top + 当前 top-30 的并集，逐 top SUM 查询
    const prevDirs = new Map(prev.top_dirs.map((d) => [d.dir, d.loc]));
    const unionTops = new Set([...prevDirs.keys(), ...agg.topDirs.map((d) => d.dir)]);
    const growth = [...unionTops]
      .map((dir) => ({ dir, delta: topLoc(dir) - (prevDirs.get(dir) ?? 0) }))
      .filter((g) => g.delta > 0)
      .sort((a, b) => b.delta - a.delta)
      .slice(0, 5);
    for (const g of growth) L.push(`- 增长热点: ${g.dir} +${g.delta} 行`);
    const newDeps = deps.filter((d) => !prev.deps.includes(d));
    if (newDeps.length > 0) L.push(`- ⚠️ 新增依赖（AI 本次引入，需审查）: ${newDeps.join(", ")}`);
  } else {
    L.push(`（这是首次对账，无历史快照。当前：文件 ${agg.totalFiles}，行数 ${agg.totalLoc}。下次先 snapshot_codebase 建立基线。）`);
  }

  /* 未登记目录（只看真实目录：嵌套文件的首段；根级文件不算目录） */
  const topDirSet = new Set(agg.rootDirs.filter((d) => d !== "." && !d.startsWith(".")));
  const modules = new Set(project.modules);
  const unregistered = [...topDirSet].filter((d) => !modules.has(d) && d !== "node_modules");
  if (unregistered.length > 0) {
    L.push(`- 💡 未登记为模块的顶层目录（update_project 登记后纳入管理）: ${unregistered.join(", ")}`);
  }

  /* ② 漂移（防幻觉对账） */
  L.push("");
  L.push("## ② 漂移对账（功能/任务 ↔ 真实文件）");
  const drift = detectDrift(root);
  const noAnchor = features.filter((f) => f.status === "implemented" && f.entry_files.length === 0);
  if (drift.length === 0 && noAnchor.length === 0) {
    L.push("✅ 无漂移：所有 implemented 功能的入口文件与 done 任务的关联文件均真实存在。");
  } else {
    for (const d of drift.slice(0, 10)) {
      L.push(`- ⚠️ ${d.kind === "feature" ? "功能" : "任务"} ${d.id} ${d.name} 引用了不存在的文件: ${d.missing.slice(0, 3).join(", ")}`);
    }
    if (drift.length > 10) L.push(`…另有 ${drift.length - 10} 项漂移未列出`);
    for (const f of noAnchor.slice(0, 10)) {
      L.push(`- ○ 功能 ${f.id} ${f.name} 无锚点（entry_files 为空，无法对账）——补 register 信息或改 planned/deprecated，别让它逃过对账。`);
    }
  }

  /* ③ 债务与重构占比 */
  L.push("");
  L.push("## ③ 债务账（反挤出）");
  const aging = debtAging(tasks);
  L.push(`未清债务 ${aging.openDebt} 条` + (aging.oldestTask ? `，最老 ${aging.oldestDays} 天（${aging.oldestTask}）` : ""));
  const warns = quotaWarnings(project, milestones, tasks);
  if (warns.length > 0) {
    for (const w of warns) {
      L.push(`- ⚠️ 重构被挤出: ${w.milestone}（${w.total} 个任务中重构类仅 ${w.refactorPct}%，低于配额 ${w.quotaPct}%）`);
    }
  } else {
    const actives = milestones.filter((m) => m.status === "active");
    if (actives.length > 0) {
      for (const m of actives) {
        const s = milestoneStats(tasks, m.id);
        if (s.total > 0) L.push(`- ${m.id} 重构类占比 ${s.refactorPct}%（配额 ${budgets.refactorQuotaPct}%）`);
      }
    } else {
      L.push("- （无活跃里程碑）");
    }
  }

  /* ④ churn */
  L.push("");
  L.push("## ④ churn（变更率）");
  const churn = churnStats(sessions);
  if (churn.sessionCount === 0) {
    L.push("（暂无会话记录，用 log_session 记录变更足迹后这里会出现热点分析）");
  } else if (churn.hotspots.length === 0) {
    L.push(`✅ ${churn.sessionCount} 次会话，无被反复波及（≥3 次）的热点文件。`);
  } else {
    L.push(`⚠️ 热点文件（被多次会话波及 = 散弹式修改嫌疑，建议立 refactor 任务）:`);
    for (const h of churn.hotspots.slice(0, 5)) L.push(`- ${h.file}（${h.count} 次）`);
    const bw = blastRadiusWarning(sessions, budgets);
    if (bw) L.push(`- ${bw}`);
  }

  /* ⑤ 复杂度预算 */
  L.push("");
  L.push("## ⑤ 复杂度预算");
  const oversized = agg.largestFiles.filter((f) => f.loc > budgets.maxFileLoc);
  if (oversized.length === 0 && agg.oversizeFiles.length === 0) {
    L.push(`✅ 无超过 ${budgets.maxFileLoc} 行的文件。`);
  } else {
    for (const f of oversized) L.push(`- ⚠️ ${f.path}: ${f.loc} 行（预算 ${budgets.maxFileLoc}）`);
    for (const rel of agg.oversizeFiles.slice(0, 10)) {
      L.push(`- 🚩 ${rel}: 超过扫描上限（>2MB），行数未计——巨文件同样逃不过点名，请拆分。`);
    }
  }
  // 预算偏离提示：调大预算能让告警消失，这本身必须可见（防"预算自肥"）
  const defaults = { maxFileLoc: 500, refactorQuotaPct: 20, sessionBlastRadius: 15, outputBudgetLines: 150 };
  const drifted = (["maxFileLoc", "refactorQuotaPct", "sessionBlastRadius", "outputBudgetLines"] as const).filter(
    (k) => budgets[k] !== defaults[k],
  );
  if (drifted.length > 0) {
    L.push(`- 💡 预算已偏离默认值: ${drifted.map((k) => `${k}=${budgets[k]}（默认 ${defaults[k]}）`).join("，")}——确认这是显式决定而非为了消除告警。`);
  }

  /* ⑥ 索引覆盖 */
  L.push("");
  L.push("## ⑥ 文件索引（token 经济）");
  const srcCount = agg.indexCoverageBase;
  const annotated = annotatedCount(root, db);
  const pct = srcCount === 0 ? 0 : Math.round((annotated / srcCount) * 100);
  L.push(`用途索引覆盖率 ${pct}%（${annotated}/${srcCount}）。覆盖越高，后续会话越不需要打开文件读代码。`);

  /* ⑦ 足迹/产出 */
  L.push("");
  L.push("## ⑦ 足迹/产出（空转代理指标）");
  const fp = footprint(sessions, tasks);
  L.push(`近 30 天完成任务 ${fp.tasksCompleted30d} 个；平均每次会话波及 ${fp.avgFilesPerSession} 个文件。`);
  for (const s of fp.recentSessions.slice(0, 5)) {
    L.push(`- ${s.date} [${s.author}] ${s.files} 文件 — ${s.summary}`);
  }

  /* ⑧ 测试健康 */
  L.push("");
  L.push("## ⑧ 测试健康（反投机）");
  L.push(`测试文件 ${agg.testFiles} 个` + (prev ? `（上次 ${prev.test_files}，${agg.testFiles - prev.test_files >= 0 ? "+" : ""}${agg.testFiles - prev.test_files}）` : ""));
  if (prev && agg.testFiles < prev.test_files) {
    L.push(`- 🚩 测试蒸发：测试文件数下降（${prev.test_files} → ${agg.testFiles}）。删除测试来"修复"构建是严重信号。`);
  }
  L.push(`skip/only 标记 ${agg.skipMarkers} 处` + (prev ? `（上次 ${prev.skip_markers}，${agg.skipMarkers - prev.skip_markers >= 0 ? "+" : ""}${agg.skipMarkers - prev.skip_markers}）` : ""));
  if (prev && agg.skipMarkers > prev.skip_markers) {
    L.push(`- 🚩 新增 ${agg.skipMarkers - prev.skip_markers} 处禁用/独占测试标记（.skip/.only/xfail 等）——让测试变绿的捷径。`);
  }
  if (agg.trivialTests.length > 0) {
    L.push(`- ⚠️ 空测试嫌疑: ${agg.trivialTests.slice(0, 5).join(", ")}`);
  }
  const implemented = features.filter((f) => f.status === "implemented");
  const withTests = implemented.filter((f) =>
    f.test_files.some((p) => fs.existsSync(path.join(root, p))),
  );
  const ratio = implemented.length === 0 ? 0 : Math.round((withTests.length / implemented.length) * 100);
  L.push(`已验证功能占比 ${ratio}%（${withTests.length}/${implemented.length} 个 implemented 功能有真实存在的测试文件；代理指标，非行覆盖率）`);

  /* ⑨ git 对账（变更足迹真实性） */
  const git = gitAudit(root);
  L.push("");
  L.push("## ⑨ git 对账（自报足迹 vs 真实工作区）");
  if (git.available) {
    if (git.error) {
      L.push(`- 🚩 git status 对账失败（fail-closed）: ${git.error}`);
    }
    if (git.ignoresPm) {
      L.push("- 🚩 .gitignore 把 .pm/ 排除出版本控制——团队与多 AI 共享失效，状态只活在你本机。请移除该规则并提交 .pm/。");
    }
    if (git.unaccounted.length > 0) {
      L.push(`- 🚩 ${git.unaccounted.length} 个文件有 git 变更但未在最近一次会话入账（log_session 漏报会被这里抓到）: ${git.unaccounted.slice(0, 5).join(", ")}`);
    }
    if (!git.error && !git.ignoresPm && git.unaccounted.length === 0) {
      L.push("✅ 工作区变更与最近会话足迹一致。");
    }
  } else {
    L.push("- ⚠️ 当前项目根不是 Git 工作区，无法核验 log_session 足迹或 .pm/ 是否会被版本控制；Git 对账未启用。");
  }

  const deepSkipped = Number(getMeta(db, "skippedDeep") ?? 0);
  if (deepSkipped > 0) {
    L.push("");
    L.push(`⚠️ ${deepSkipped} 个路径超过 64 层深度未扫描（极罕见，请检查目录结构）`);
  }
  return foldLines(L, { maxLines: maxLines, hint: "各报告均可通过参数过滤" });
}
