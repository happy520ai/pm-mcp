# ADR-009 编排闭环五段分工与 active_run_id 自愈指针（ADR-009）

- 日期: 2026-10-27
- 状态: 已接受

## 背景

M4 已落地 set_goal / set_orchestrator / record_round / get_orchestrator（src/orchestrator.ts、src/orchestrator-tools.ts），ADR-008 确立「控制流外置，pm-mcp 只记账与发指令」。M5 要把本仓库真实运行的心跳 + 动态工作流闭环约定写进 README，并由独立核对员先行确认了实现事实：status 七个取值按 running > no-goal > disabled > failed-out > stalled > budget-exhausted > ready 的优先级判定（orchestrator.ts:200-217）；record_round 同一时间只允许一轮（begin 拒绝不同 run_id，:289-291；读写经账本文件锁，store.ts；台账损坏 fail-closed，orchestrator.ts:144-146）；max_rounds=null 时跳过预算判定，只剩停滞（3）与连续失败（2）两个刹车，而 max_hours 在任何状态下都不参与判定、只是展示与回显字段（全仓 grep 无 started_at 时长消费点）；active_run_id 只在 endRound 内部清零（:314），全仓没有超时/租约回收。约束：README 只能写代码已实现的行为，不得把未实现能力写成已实现；文档与决策都要与 ADR-008 的定位一致。

## 决定

决定两条：①README 新增「自动编排闭环（心跳 + 动态工作流）」一节，把一次闭环固定为五段外部约定——拆卡（读 status，仅 ready 开轮）→ 派发动态工作流（record_round begin + 启动 workflow）→ 结束 tick（不阻塞等待，轮数在 end 才 +1）→ 复核（核对证据/测试/文档与验收项）→ commit 收轮（复核通过才 commit，随后 produced_evidence:true 收轮）；心跳与 workflow 只做本地 commit，禁止 git push、打 tag 与发布。②active_run_id 定位为「互斥令牌 + 自愈指针」：互斥由状态机 running 优先、begin 的 id 校验、账本锁三层保证；自愈明确限定为「后继 tick 从 get_orchestrator 读到遗留 id，用同一个 run_id 调 record_round(end) 结算」这一调用方约定，不写成 pm-mcp 会自动清理或超时回收。预算 null=不限时如实写明：max_rounds=null 只剩停滞与失败两个刹车，max_hours 目前不参与状态判定。

## 后果

好处：任何 AI 或人凭 README 一节 + 本 ADR 能复现同一套闭环，自愈语义可操作（同 id 结算遗留轮次）；文档与代码可被独立复核员逐条比对。代价与被放弃的方案：(a) 不做服务端租约/超时回收——begin 后进程崩溃且未 end 时，台账永久停在 running，不同 run_id 的后续 begin 一律被拒，只能靠后继 tick 用同 id 结算；(b) begin 不检查 enabled、预算与停滞/失败阈值，stalled / failed-out / budget-exhausted 不会在开轮时被硬拦，开轮前的把关依赖调用方先读 status（与 ADR-008 一致，但意味着约定靠自律）；(c) end 不强制与 begin 配对，无在飞轮次时 end 也会推进 round_count；(d) max_hours 仍是纯展示字段，若未来要硬性时长上限需新增 started_at 消费点并另立 ADR。复核与 commit 的真实性 pm-mcp 无法验证，闭环的诚实性最终依赖外部 workflow 与 git 对账交叉印证。
