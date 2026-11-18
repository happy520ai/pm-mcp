import fs from "node:fs";
import path from "node:path";
import { renderJudgmentSection } from "./work-protocol.ts";

/**
 * AGENTS.md 工作规矩：init_project 时自动写入/合并（"项目开启即有规矩"）。
 * - 文件不存在 → 创建
 * - 已存在且缺标记段 → 在最后一个已知段落之后插入（绝不覆盖你的内容）
 * - 已存在且标记段齐全 → 原样保留（幂等）
 * - 分两段：process（工具能强制的流程）+ judgment（工具验证不了的判断）
 */

export type AgentsMdSectionId = "process" | "judgment";

interface AgentsMdSection {
  id: AgentsMdSectionId;
  begin: string;
  end: string;
  body: string;
}

const PROCESS_SECTION: AgentsMdSection = {
  id: "process",
  begin: "<!-- pm-mcp:agents-md:v1:begin -->",
  end: "<!-- pm-mcp:agents-md:v1:end -->",
  body: `# 项目管理规矩（pm-mcp 自动维护段落，可整体删除但不建议）

本项目由 pm-mcp 管理，状态以 .pm/ 目录为准，禁止凭记忆陈述项目状态。

## 开工（每次会话第一件事）
1. get_status：了解阶段、里程碑、进行中任务与其 checkpoint 下一步
2. 不清楚的模块先 search_code 定位到 file:line 再读文件，不要全量读代码
3. 陈述本次计划：做哪个任务、动哪些文件、验收标准

## 做事过程
- 长任务：add_task 时给 steps；用 update_task 附 checkpoint 一次更新进度与会话；保留独立 checkpoint 兼容旧流程
- 走捷径：立刻 add_task(type=debt) 登记债务，不许无声欠债
- 修 bug：完成后 log_debug 记录症状/根因/修法/验证
- 陈述「某功能在某文件」之前，先 search_code 求证

## 收工（缺一不可）
1. feature/fix 先执行相应测试并生成当前源码的质量报告；update_task 置 done + result_note + files，设 record_session:true 一并归档
2. 未完成任务 checkpoint（进展 + 下一步具体动作）
3. 落地的功能 register_feature（入口文件 + 测试文件）
4. update_task 已返回自动会话编号时不重复 log_session；否则用 log_session 如实记录改动文件清单。纯问答无需新建任务或重复记账

## 每个里程碑节点
snapshot_codebase + audit_structure 对账；audit_security 安全体检；audit_license 许可证审计`,
};

const JUDGMENT_SECTION: AgentsMdSection = {
  id: "judgment",
  begin: "<!-- pm-mcp:judgment:v1:begin -->",
  end: "<!-- pm-mcp:judgment:v1:end -->",
  body: renderJudgmentSection(),
};

const SECTIONS: AgentsMdSection[] = [PROCESS_SECTION, JUDGMENT_SECTION];

export type AgentsMdResult = "created" | "appended" | "unchanged" | "skipped";

export interface AgentsMdSyncResult {
  result: AgentsMdResult;
  added: AgentsMdSectionId[];
  present: AgentsMdSectionId[];
}

export interface SyncAgentsMdOptions {
  enabled?: boolean;
  dryRun?: boolean;
}

function renderSection(section: AgentsMdSection): string {
  return `${section.begin}\n${section.body}\n${section.end}`;
}

/**
 * 把缺失的规矩段同步进 AGENTS.md。
 * 只追加/插入缺失段，不覆盖既有内容；dryRun 只计算不写盘。
 */
export function syncAgentsMd(root: string, options: SyncAgentsMdOptions = {}): AgentsMdSyncResult {
  const enabled = options.enabled !== false;
  const dryRun = options.dryRun === true;
  if (!enabled) return { result: "skipped", added: [], present: [] };

  const file = path.join(root, "AGENTS.md");
  const exists = fs.existsSync(file);
  const content = exists ? fs.readFileSync(file, "utf8") : "";
  const present = SECTIONS.filter((section) => content.includes(section.begin)).map((section) => section.id);
  const missing = SECTIONS.filter((section) => !content.includes(section.begin));

  if (!exists) {
    if (!dryRun) fs.writeFileSync(file, SECTIONS.map(renderSection).join("\n\n") + "\n", "utf8");
    return { result: "created", added: SECTIONS.map((section) => section.id), present: [] };
  }
  if (missing.length === 0) return { result: "unchanged", added: [], present };

  if (!dryRun) {
    const eol = content.includes("\r\n") ? "\r\n" : "\n";
    const addition = missing.map(renderSection).join("\n\n").replace(/\n/g, eol);
    let insertAt = -1;
    for (const section of SECTIONS) {
      if (!present.includes(section.id)) continue;
      const end = content.lastIndexOf(section.end);
      if (end >= 0) insertAt = Math.max(insertAt, end + section.end.length);
    }

    let next: string;
    if (insertAt >= 0) {
      const before = content.slice(0, insertAt);
      const after = content.slice(insertAt).replace(/^(?:\r?\n)+/, "");
      next = `${before}${eol}${eol}${addition}${after ? `${eol}${eol}${after}` : ""}`;
      if (!next.endsWith(eol)) next += eol;
    } else {
      const separator = content.endsWith("\n") ? "" : eol;
      next = `${content}${separator}${eol}${addition}${eol}`;
    }
    fs.writeFileSync(file, next, "utf8");
  }

  return { result: "appended", added: missing.map((section) => section.id), present };
}

/** 兼容旧调用：只关心 upsert 结果时使用。 */
export function upsertAgentsMd(root: string, enabled = true): AgentsMdResult {
  return syncAgentsMd(root, { enabled }).result;
}
