# ADR-014 工作协议分层：流程归工具，判断归 AGENTS.md 与 prompt

- 日期: 2026-11-17
- 状态: 已接受

## 背景

原 10 条提示词把根因修复、三选方案、历史考古、PR 复盘等混在一个常驻人格里。pm-mcp 已经能验证 goal/acceptance/evidence/done gate，但提示词仍在重复这些可机器验证的流程；同时，问题定义、根因判断、反例、停止规则又无法被 governance 强制。混在一起会导致上下文稀释和“清单表演”。

## 决定

不合并文本，合并工作流：AGENTS.md 自动写入两段——process（工具能强制的流程）与 judgment（工具验证不了的判断）；存量项目用 `pm-mcp sync-agents` 幂等补齐；新增 MCP prompt `work-protocol` 作为按需入口。judgment 段不进入 governance，避免不可执行的空转条款；工具目录保持 59 个，不新增 MCP 工具。

## 后果

1. 新项目 init_project 自动获得两段规矩；存量项目需显式运行 `pm-mcp sync-agents`（`--dry-run` 可预览）。
2. judgment 段靠会话加载，不能被机器门禁强制，仍需人工审查；process 段继续由 update_task / 质量矩阵 / 验收基线强制执行。
3. 未来修改判断规则只需改 `src/work-protocol.ts`，AGENTS.md 与 `work-protocol` prompt 共用同一份文本，避免文档漂移。
4. 选择 CLI 而不是新 MCP 工具，保持工具目录契约（59）与验收基线不变；升级操作不应扩大每会话工具面。
