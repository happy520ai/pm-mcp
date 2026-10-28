# 1.4.0 首次失败保留记录

本文件记录升版前的真实失败与范围，不冒充本版新增失败。

## 本版升版背景

1.4.0 由 0.8.0 发布触发，不涉及质量阈值调整：`mcp_tools` 保持 59，其余门槛与 1.3.0 相同。升版前在 1.3.0 基线下执行 `npm run gate` 全绿：audit 无红旗、quality PASS、acceptance PASS errors=0（报告 `pm-mcp-local-20261028-163906-2c7ce2a7`）。

## 历史真实失败（1.2.0 基线）

在 1.2.0 基线下执行 `npm run acceptance:cycle` 失败，报告 `pm-mcp-local-20261028-162258-0f023758`，errors=27。独立根因三类：

1. `QR-FS-TOOLS` / `AT-FS-TOOLS`：实测 59，未达到 `equal 58`（新增 `complete_goal`）。
2. `QR-MA-LOC` / `AT-MA-LOC`：`src/orchestrator.ts` 557 行、`src/idempotency.ts` 549 行，超过 500 行预算。
3. `QR-RE-CURRENT` / `AT-RE-CURRENT`：验收前未重新运行质量矩阵，读到旧源码绑定的报告。

其余 24 条错误均由这三项级联产生。

## 修复边界

- 拆分 `orchestrator-state.ts` 与 `idempotency-gc.ts`，两个实现文件回到 500 行内。
- 1.3.0 只同步工具计数 58 → 59；1.4.0 只同步产品版本 0.7.0 → 0.8.0，均未放宽覆盖率、安全、治理或测试计数门槛。
- 发布前重新运行真实质量矩阵，确保质量报告源码摘要等于当前源码。
- 上述历史失败记录不因 0.8.0 发布而被覆盖。
