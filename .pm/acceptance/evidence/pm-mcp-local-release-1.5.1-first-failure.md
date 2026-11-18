# 1.5.1 首次失败保留记录

本文件记录升版前的真实失败与范围，不冒充本版新增失败。

## 1.4.0 升版背景（历史）

1.4.0 由 0.8.0 发布触发，不涉及质量阈值调整：`mcp_tools` 保持 59，其余门槛与 1.3.0 相同。升版前在 1.3.0 基线下执行 `npm run gate` 全绿：audit 无红旗、quality PASS、acceptance PASS errors=0（报告 `pm-mcp-local-20261028-163906-2c7ce2a7`）。

## 1.5.1 升版说明（0.9.0 prompt 计数修正）

1.5.1 由 1.5.0 的门禁失败触发，不涉及阈值放宽。在 1.5.0 基线下执行验收，报告 `pm-mcp-local-20261118-021023-b5b8eb2c`，errors=8：0.9.0 新增 work-protocol prompt 后 `mcp_prompts` 实测为 6，而基线仍冻结为 `equal 5`，`QR-FS-PROMPTS` / `AT-FS-PROMPTS` 因 5 ≠ 6 失败，其余 7 条错误为需求—风险—测试—证据追踪级联。1.5.1 仅把 `QR-FS-PROMPTS.metric.threshold` 与 `AT-FS-PROMPTS.assertion.expected` 修正为 6；`mcp_tools` 保持 59，其余门槛与 1.5.0 相同。1.5.0 已批准不可修改，保留原样并由 1.5.1 取代。

## 历史真实失败（1.2.0 基线）

在 1.2.0 基线下执行 `npm run acceptance:cycle` 失败，报告 `pm-mcp-local-20261028-162258-0f023758`，errors=27。独立根因三类：

1. `QR-FS-TOOLS` / `AT-FS-TOOLS`：实测 59，未达到 `equal 58`（新增 `complete_goal`）。
2. `QR-MA-LOC` / `AT-MA-LOC`：`src/orchestrator.ts` 557 行、`src/idempotency.ts` 549 行，超过 500 行预算。
3. `QR-RE-CURRENT` / `AT-RE-CURRENT`：验收前未重新运行质量矩阵，读到旧源码绑定的报告。

其余 24 条错误均由这三项级联产生。

## 修复边界

- 拆分 `orchestrator-state.ts` 与 `idempotency-gc.ts`，两个实现文件回到 500 行内。
- 1.3.0 只同步工具计数 58 → 59；1.4.0 只同步产品版本 0.7.0 → 0.8.0；1.5.0 只同步产品版本 0.8.0 → 0.9.0；1.5.1 只把 `mcp_prompts` 5 → 6，`mcp_tools` 保持 59。以上均未放宽覆盖率、安全、治理或测试计数门槛。
- 发布前重新运行真实质量矩阵，确保质量报告源码摘要等于当前源码。
- 上述历史失败记录不因 0.8.0 或 0.9.0 发布而被覆盖。
