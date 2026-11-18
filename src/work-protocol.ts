/**
 * 工作协议：判断层（工具验证不了的部分）。
 * - AGENTS.md 的 judgment 段与 MCP prompt `work-protocol` 共用同一份文本，避免文档漂移。
 * - 工具能验证的流程（测试、验收、证据、依赖）留在 agents-md 的 process 段与 PM 工具里，不在这里重复。
 */

export const TRIAGE_RULES = [
  "快修：单文件/单行为、可逆、能快速复现或有现成测试。",
  "深挖：跨模块、不可逆、无测试覆盖、涉及数据/安全/迁移，或用户明确要求“深入”。",
  "复盘：对象是一类已发生的问题（多个 bug/返工/回滚/PR 延迟），不是单个 bug。",
] as const;

export const JUDGMENT_RULES = [
  "先定义再动手：一句话复述问题与“修好了”的判据；判据不清时只问会改变方案的问题，其余按假设推进并标注。",
  "证据先于结论：每个“原因”都要能指到证据（复现、失败测试、日志、代码位置）；指不到就写“假设”，不写“根因”。测试绿 ≠ 根因成立，至少写一个替代解释。",
  "修复必须可验收：能自动验证的走 run_quality_matrix / evaluate_acceptance；不能自动验证的标“未验证”，不要用分析篇幅代替证据。",
  "先给推荐：默认“结论 + 依据 + 下一步”；仅当决策不可逆、跨模块或用户明确要求时，给至多两个机制不同的备选；不可逆决策先做 pre-mortem（假设 6 个月后失败，写最可能路径）。",
  "只写会改变决策的影响：impact_analysis 给闭包，重要性由人判断；跨领域类比只在因果机制相同时采用。",
  "历史结论先查再推：search_knowledge / list_decisions 优先；考古结论必须有 commit/PR/issue 证据，没有就标“未知”；不知道为何而立的历史包袱先保留（Chesterton 栅栏），找到引入它的 commit/PR/issue 或证明约束已不存在再拆；非显而易见的文件用途用 annotate_file 登记。",
  "数据不足就降级，重复就沉淀：缺 PR/事故数据时写“假设 + 验证计划”，不编造；同一纠正出现第二次，转成 governance policy / quality gate / skill / 测试，并写 expires_when。",
] as const;

export function renderJudgmentSection(): string {
  return [
    "## 判断与交付（pm-mcp 判断协议，工具验证不了的部分）",
    "",
    "工具能验证的（测试、验收、证据、依赖）以工具结果为准；以下是不能外包给工具的判断：",
    "",
    ...JUDGMENT_RULES.map((rule, index) => `${index + 1}. ${rule}`),
  ].join("\n");
}

export function renderWorkProtocolPrompt(): string {
  return [
    "按 pm-mcp 工作协议执行：先判档，再动手；一次只跑一档。",
    "",
    "## 分档",
    ...TRIAGE_RULES.map((rule) => `- ${rule}`),
    "分档不明按快修开始；出现深挖信号就停下来说明并升级，不偷偷扩大范围。",
    "",
    "## 判断规则（工具验证不了的部分）",
    ...JUDGMENT_RULES.map((rule, index) => `${index + 1}. ${rule}`),
    "",
    "工具能验证的部分（测试、验收、证据、依赖）以 run_quality_matrix / evaluate_acceptance / update_task 的 done 门禁为准；不要用文字篇幅代替工具证据。",
  ].join("\n");
}
