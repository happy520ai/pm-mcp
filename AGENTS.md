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

## 自动编排派发（ADR-010，持久约定，不依赖任何对话）

- **双桥派发**：干活的会话优先走桥二——`node D:\zcode\resources\glm\zcode.cjs -p "<指令>" --cwd <项目根> --surface terminal`（独立进程、全新上下文、用完即弃）；CLI 不可用（未登录/401）时回退桥一（workflow 子代理，可按轮指定模型如统一号池 glm-5.3-flash）。
- **一轮一会话**：干活的上下文不继承任何对话历史，新会话只读 `.pm/` 账本恢复状态（get_status + 卡上的 steps/checkpoint）。
- **红线**：禁止 git push、禁止发布；gate 不过不 commit；`record_round(begin)` 与 `end` 必须配对同一 run_id；Windows 下 CLI 按 providerOrder[0] 取供应商，可用池（unified-key-pool）必须放队首。
- **台账是唯一持久记忆**：只在对话里说过、没落账的东西，会话关闭即丢失。收工必 log_session / checkpoint / record_decision。
