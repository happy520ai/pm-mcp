<!-- pm-mcp:agents-md:v1:begin -->
# 项目管理规矩（pm-mcp 自动维护段落，可整体删除但不建议）

本项目由 pm-mcp 管理，状态以 .pm/ 目录为准，禁止凭记忆陈述项目状态。

## 开工（每次会话第一件事）
1. get_status：了解阶段、里程碑、进行中任务与其 checkpoint 下一步
2. 不清楚的模块先 search_code 定位到 file:line 再读文件，不要全量读代码
3. 陈述本次计划：做哪个任务、动哪些文件、验收标准

## 做事过程
- 长任务：add_task 时给 steps；上下文快满或中断前 checkpoint 存断点
- 走捷径：立刻 add_task(type=debt) 登记债务，不许无声欠债
- 修 bug：完成后 log_debug 记录症状/根因/修法/验证
- 陈述「某功能在某文件」之前，先 search_code 求证

## 收工（缺一不可）
1. 完成的任务 update_task 置 done + result_note；feature/fix 补 verification
2. 未完成任务 checkpoint（进展 + 下一步具体动作）
3. 落地的功能 register_feature（入口文件 + 测试文件）
4. log_session 如实记录改动文件清单

## 每个里程碑节点
snapshot_codebase + audit_structure 对账；audit_security 安全体检；audit_license 许可证审计
<!-- pm-mcp:agents-md:v1:end -->

<!-- pm-mcp:judgment:v1:begin -->
## 判断与交付（pm-mcp 判断协议，工具验证不了的部分）

工具能验证的（测试、验收、证据、依赖）以工具结果为准；以下是不能外包给工具的判断：

1. 先定义再动手：一句话复述问题与“修好了”的判据；判据不清时只问会改变方案的问题，其余按假设推进并标注。
2. 证据先于结论：每个“原因”都要能指到证据（复现、失败测试、日志、代码位置）；指不到就写“假设”，不写“根因”。测试绿 ≠ 根因成立，至少写一个替代解释。
3. 修复必须可验收：能自动验证的走 run_quality_matrix / evaluate_acceptance；不能自动验证的标“未验证”，不要用分析篇幅代替证据。
4. 先给推荐：默认“结论 + 依据 + 下一步”；仅当决策不可逆、跨模块或用户明确要求时，给至多两个机制不同的备选；不可逆决策先做 pre-mortem（假设 6 个月后失败，写最可能路径）。
5. 只写会改变决策的影响：impact_analysis 给闭包，重要性由人判断；跨领域类比只在因果机制相同时采用。
6. 历史结论先查再推：search_knowledge / list_decisions 优先；考古结论必须有 commit/PR/issue 证据，没有就标“未知”；不知道为何而立的历史包袱先保留（Chesterton 栅栏），找到引入它的 commit/PR/issue 或证明约束已不存在再拆；非显而易见的文件用途用 annotate_file 登记。
7. 数据不足就降级，重复就沉淀：缺 PR/事故数据时写“假设 + 验证计划”，不编造；同一纠正出现第二次，转成 governance policy / quality gate / skill / 测试，并写 expires_when。
<!-- pm-mcp:judgment:v1:end -->

## 自动编排派发（ADR-010，持久约定，不依赖任何对话）

- **双桥派发**：干活的会话优先走桥二——`node D:\zcode\resources\glm\zcode.cjs -p "<指令>" --cwd <项目根> --surface terminal`（独立进程、全新上下文、用完即弃）；CLI 不可用（未登录/401）时回退桥一（workflow 子代理，可按轮指定模型如统一号池 glm-5.3-flash）。
- **一轮一会话**：干活的上下文不继承任何对话历史，新会话只读 `.pm/` 账本恢复状态（get_status + 卡上的 steps/checkpoint）。
- **红线**：禁止 git push、禁止发布；gate 不过不 commit；`record_round(begin)` 与 `end` 必须配对同一 run_id；Windows 下 CLI 按 providerOrder[0] 取供应商，可用池（unified-key-pool）必须放队首。
- **台账是唯一持久记忆**：只在对话里说过、没落账的东西，会话关闭即丢失。收工必 log_session / checkpoint / record_decision。
- **记账要诚实**：`record_round(begin, run_id, run_kind: workflow|cli|manual)` 会记录源码指纹与质量报告基线；`end` 声称 `produced_evidence:true` 时会核验是否真有变化——没变会被降级为无证据并计入停滞。**真无产出就传 `produced_evidence:false`**，不要用 true 刷掉停滞计数。
- **成本要上报**：`end` 传 `tokens_used`（本轮实际消耗），累计进台账供 `max_total_tokens` 判定；不要虚报也不要省略。
