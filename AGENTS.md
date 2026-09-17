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
