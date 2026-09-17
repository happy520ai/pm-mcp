import fs from "node:fs";
import path from "node:path";

/**
 * AGENTS.md 工作规矩：init_project 时自动写入/合并（"项目开启即有规矩"）。
 * - 文件不存在 → 创建
 * - 已存在且无标记段 → 末尾追加（绝不覆盖你的内容）
 * - 已存在且有标记段 → 原样保留（幂等；模板升级时用新版本号标记替换）
 */

const BEGIN = "<!-- pm-mcp:agents-md:v1:begin -->";
const END = "<!-- pm-mcp:agents-md:v1:end -->";

const SECTION = `${BEGIN}
# 项目管理规矩（pm-mcp 自动维护段落，可整体删除但不建议）

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
snapshot_codebase + audit_structure 对账；audit_security 安全体检；audit_license 许可证审计
${END}`;

export type AgentsMdResult = "created" | "appended" | "unchanged" | "skipped";

/** 幂等 upsert：返回发生了什么（skipped = 调用方显式关闭） */
export function upsertAgentsMd(root: string, enabled = true): AgentsMdResult {
  if (!enabled) return "skipped";
  const file = path.join(root, "AGENTS.md");
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, SECTION + "\n", "utf8");
    return "created";
  }
  const content = fs.readFileSync(file, "utf8");
  if (content.includes(BEGIN)) return "unchanged";
  const separator = content.endsWith("\n") ? "" : "\n";
  fs.writeFileSync(file, content + separator + "\n" + SECTION + "\n", "utf8");
  return "appended";
}
