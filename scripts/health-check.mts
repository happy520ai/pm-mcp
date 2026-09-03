#!/usr/bin/env node
/**
 * pm-mcp 定时健康巡检（独立于 MCP 客户端，供定时器/CI/人直接跑）：
 *   node scripts/health-check.mts            # 巡检全局注册表内全部项目
 *   node scripts/health-check.mts --root <p> # 巡检单个项目
 *   node scripts/health-check.mts --tasks <p># 列出项目任务（登记红旗前查重用）
 *   node scripts/health-check.mts --add-task <p> <title> [type]  # 走账本锁登记任务
 *
 * 行为：只读巡检为主（结构对账/安全体检/许可证审计；安全台账按设计闭环更新）；
 * 发现 🚩/🔴 级红旗时退出码 1（CI 可直接当门禁），⚠️ 级只报告。
 */
import { withLedgerLock, loadProject, loadTasks, saveTasks, nextId } from "../src/store.ts";
import { listRegistry } from "../src/registry.ts";
import { auditStructure, snapshotCodebase } from "../src/audit.ts";
import { auditSecurity, listFindings, prepareSecurityAudit } from "../src/security.ts";
import { auditLicense } from "../src/license.ts";
import { walkRefresh } from "../src/index-store.ts";
import { TaskSchema, now } from "../src/types.ts";
import { isInitialized } from "../src/paths.ts";
import path from "node:path";

const HARD_FLAG = /🚩|🔴/;

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/* ------------------------------ 任务登记通道 ------------------------------ */

async function printTasks(root: string): Promise<void> {
  const abs = path.resolve(root);
  const { tasks } = loadTasks(abs);
  console.log(tasks.map((t) => `[${t.status}] ${t.id} ${t.title} (${t.type})`).join("\n") || "（无任务）");
}

async function addTask(root: string, title: string, type: string): Promise<void> {
  const abs = path.resolve(root);
  const id = withLedgerLock(abs, () => {
    const data = loadTasks(abs);
    const newId = nextId("T", data.seq);
    data.seq += 1;
    data.tasks.push(
      TaskSchema.parse({
        id: newId,
        title,
        detail: "由定时健康巡检自动登记，请人工确认后处置",
        type: (["fix", "debt", "feature", "chore", "refactor"].includes(type) ? type : "fix") as never,
        status: "backlog",
        priority: "P1",
        milestone: null,
        steps: [],
        checkpoint: null,
        files: [],
        acceptance: "",
        result_note: "",
        verification: "",
        tags: ["巡检"],
        author: "cron",
        created: now(),
        updated: now(),
        started_at: null,
        completed_at: null,
      }),
    );
    saveTasks(abs, data);
    return newId;
  });
  const { refreshDerived } = await import("../src/dashboard.ts");
  refreshDerived(abs);
  console.log(`✅ 已登记任务 ${id}: ${title}`);
}

/* -------------------------------- 巡检主体 -------------------------------- */

interface ProjectReport {
  name: string;
  root: string;
  sections: string[];
  hardFlags: string[];
}

async function inspectProject(root: string): Promise<ProjectReport> {
  const abs = path.resolve(root);
  const project = loadProject(abs);
  const { refreshDerived } = await import("../src/dashboard.ts");
  // 把本次巡检自身会维护的派生文件先建立，再冻结唯一一次精确索引基线。
  refreshDerived(abs);
  // 独立巡检/CI 必须建立自己的精确文件基线，不能仅凭另一个 MCP 进程
  // 留下的心跳推断索引完整；这条路径以正确性优先，稳态低延迟由 MCP watcher 提供。
  const exactWalk = walkRefresh(abs, { forceContent: true });
  const sections: string[] = [
    `## 巡检索引基线\n独立精确走查 ${exactWalk.totalFiles} 个文件（变更 ${exactWalk.changed}，删除 ${exactWalk.deleted}，缓存命中 ${exactWalk.hits}）。`,
  ];
  const hardFlags: string[] = [];
  const collect = (text: string): void => {
    sections.push(text);
    for (const line of text.split("\n")) {
      if (HARD_FLAG.test(line)) hardFlags.push(line.trim());
    }
  };
  collect(auditStructure(abs, 120, false, true));
  // 安全扫描会更新台账；与 MCP 写工具使用同一把跨进程锁，避免巡检与客户端
  // 同时读-改-写 security.json 时覆盖彼此的发现或处置结果。
  const preparedSecurity = prepareSecurityAudit(abs, { forceIndex: false, forceContent: true, indexPrepared: true });
  const sec = withLedgerLock(abs, () => auditSecurity(abs, preparedSecurity));
  // 巡检经领域层写安全台账（闭环/自动关闭），必须同步刷新派生仪表盘——
  // tools 层会刷，这里不刷会导致 PROJECT.md 与状态失同步（被 realrepo 测试抓到过）
  refreshDerived(abs);
  collect(sec.text.join("\n"));
  // 门禁使用结构化发现，不能依赖报告文案里恰好出现哪种 emoji。
  // 公网项目按既有 exposure 规则把中危也纳入必须处置口径。
  const publicMustFix = project.exposure === "public"
    ? listFindings(abs, "open").filter((f) => f.severity === "high" || f.severity === "medium")
    : [];
  if (publicMustFix.length > 0) {
    hardFlags.push(
      `安全体检：公网项目中危及以上未处理 ${publicMustFix.length} 个（高危 ${sec.highCount}，中危 ${publicMustFix.length - sec.highCount}）`,
    );
  } else if (sec.highCount > 0) {
    hardFlags.push(`安全体检：高危未处理 ${sec.highCount} 个（含 ${sec.newFindings} 个本次新发现）`);
  }
  collect(auditLicense(abs, 120, false, true));
  // 只有无硬红旗的完整巡检才推进基线。否则同一坏状态在持久化工作区内
  // 第二次运行会因“已成为新基线”而假绿；显式修复后再由绿灯运行推进。
  if (hardFlags.length === 0) snapshotCodebase(abs, false, true);
  return { name: project.name, root: abs, sections, hardFlags };
}

async function runAudit(): Promise<number> {
  const roots: { name: string; root: string }[] = [];
  const single = argValue("--root");
  if (single) {
    roots.push({ name: single, root: single });
  } else {
    roots.push(...listRegistry());
  }
  if (roots.length === 0) {
    console.error("巡检失败：注册表为空（先在项目里 init_project），也没有 --root 指定。");
    return 1;
  }
  const reports: ProjectReport[] = [];
  const failures: string[] = [];
  for (const r of roots) {
    if (!isInitialized(path.resolve(r.root))) {
      failures.push(`${r.root}（.pm 缺失，可能已移动）`);
      continue;
    }
    try {
      reports.push(await inspectProject(r.root));
    } catch (e) {
      failures.push(`${r.root}（巡检失败: ${(e as Error).message}）`);
    }
  }
  console.log(`# pm-mcp 健康巡检报告 ${new Date().toISOString()}`);
  for (const r of reports) {
    console.log(`\n===== ${r.name}（${r.root}）=====`);
    console.log(r.sections.join("\n\n"));
  }
  if (failures.length > 0) {
    console.log(`\n巡检失败（fail-closed）: ${failures.join("；")}`);
  }
  const totalFlags = reports.reduce((s, r) => s + r.hardFlags.length, 0);
  console.log(`\n===== 汇总 =====`);
  for (const r of reports) {
    console.log(`- ${r.name}: ${r.hardFlags.length === 0 ? "✅ 无红旗" : `🚩 ${r.hardFlags.length} 个红旗`}`);
    for (const flag of r.hardFlags) console.log(`  · ${flag.slice(0, 160)}`);
  }
  for (const failure of failures) console.log(`- 🚩 ${failure}`);
  console.log(`共 ${reports.length} 个成功巡检项目，硬红旗 ${totalFlags} 个，巡检失败 ${failures.length} 个。`);
  return totalFlags > 0 || failures.length > 0 ? 1 : 0;
}

/* --------------------------------- 入口 --------------------------------- */

const tasksRoot = argValue("--tasks");
const addRoot = argValue("--add-task");
if (tasksRoot) {
  await printTasks(tasksRoot);
} else if (addRoot) {
  const i = process.argv.indexOf("--add-task");
  const title = process.argv[i + 2];
  const type = process.argv[i + 3] ?? "fix";
  if (!title) {
    console.error("用法: --add-task <root> <title> [type]");
    process.exit(2);
  }
  await addTask(addRoot, title, type);
} else {
  process.exit(await runAudit());
}
