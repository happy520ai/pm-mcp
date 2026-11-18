# pm-mcp 本地评价计划（基线 1.5.1）

基线：`pm-mcp-local-release@1.5.1`。本版为 0.9.0 发布同步的修订：产品版本从 0.8.0 更新为 0.9.0，`mcp_tools` 保持 `equal 59`；0.9.0 新增 work-protocol prompt，`mcp_prompts` 由 5 更新为 `equal 6`，仅修正 `QR-FS-PROMPTS.metric.threshold` 与 `AT-FS-PROMPTS.assertion.expected`，其余全部量化阈值、验收要求、风险控制、测试追踪、评价策略与证据摘要规则不变。1.5.0 已批准不可修改，由本版取代。

发布内容：新增 `sync` 命令（ADR-013）与工作协议两段式（ADR-014，含 AGENTS.md process/judgment、work-protocol prompt、sync-agents CLI）。0.9.0 不新增 MCP 工具，工具目录仍为 59；prompt 目录为 6（新增 work-protocol prompt）。

执行顺序：

1. 基线批准后在当前工作区重新采集产品证据，绑定当次源码摘要。
2. 先运行 `npm run quality` 生成与当前源码绑定的质量报告，再执行结构、安全、许可证与治理检查；有硬红旗不推进。
3. 完整执行 test、build、typecheck、coverage；门槛维持 package.json 的 lines 95%、branches 85%、functions 93%，保留全部失败/跳过/缺失结果。
4. 按冻结指针复算证据 SHA-256，生成不可覆盖的机器判定报告。
5. 报告、发布 tarball 与基线一并入库；1.5.0 及其评价证据保持原样。

范围边界：Windows x64 本地第一方评价，Node.js ≥ 22.18。批准用于 0.9.0 发布前的本地质量基线同步，不构成独立认证；GitHub Release 与 npm 发布是后续独立操作。

回滚：`package.json` 的 `pm_mcp.acceptance_baseline.version` 指回 1.4.0 即回到旧基线；1.5.0 因 prompt 计数错误不作为回滚目标；0.9.0 发布本身不可通过此回滚撤销。
