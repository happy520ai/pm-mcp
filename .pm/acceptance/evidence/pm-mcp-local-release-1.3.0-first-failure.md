# 1.3.0 首次失败保留记录

本文件记录升版之前真实发生的失败与范围，作为复核说明，不是测试通过数据。

## 失败一：验收门禁在旧基线下失败

在基线 `1.2.0` 下执行 `npm run acceptance:cycle`，退出码 1，报告 `pm-mcp-local-20261028-162258-0f023758`，errors=27。直接根因有三类：

1. `QR-FS-TOOLS` / `AT-FS-TOOLS`：实测 59，未达到 `equal 58`。新增 `complete_goal` 工具使工具目录从 58 变为 59。
2. `QR-MA-LOC` / `AT-MA-LOC`：实现文件超 500 行数为 2，阈值为 0。具体为 `src/orchestrator.ts` 557 行、`src/idempotency.ts` 549 行，均是本次硬化新增逻辑导致。
3. `QR-RE-CURRENT` / `AT-RE-CURRENT`：`quality_source_matches_current=0`。验收采集器读取 `.pm/quality-runs` 中最新质量报告；本次在代码改动后直接跑验收，没有先重新运行 `npm run quality`，读到的是旧源码绑定的报告。

其余 24 条错误（`REQUIREMENT_TESTS_NOT_PASSED`、`RISK_CONTROLS_NOT_VERIFIED`、`TEST_NOT_PASSED`、`TRACEABILITY_INCOMPLETE`）均由上述三项级联产生，没有第四类独立根因。

## 修复边界

- 将 `src/orchestrator.ts` 拆分为 `orchestrator-state.ts`（schema/持久化/校验）与 `orchestrator.ts`（状态/证据/轮次），353 + 221 行；将幂等 GC 拆到 `idempotency-gc.ts`，`idempotency.ts` 471 行。两个实现文件均回到 500 行预算内。
- 工具计数 58 → 59，仅同步新增的 `complete_goal`；没有放宽覆盖率、安全、治理或测试计数门槛。
- 验收前先运行真实质量矩阵，确保质量报告的 `source.after.sha256` 等于采集时的源码摘要。
- 上述失败记录不因本版通过而被覆盖；1.2.0 基线与其评价报告保持原样。
