# pm-mcp 0.1.0 标准化产品评价计划

- 基线：`pm-mcp-local-release@1.0.0`
- 批准后基线 SHA-256：`168301bde37500dfee0d6cbba9a76efee7d30752d6ff86eef44e101027c1a195`
- 基线批准时间：`2026-09-02T16:03:38.734Z`
- 评价类型：开发组织第一方、限定用途产品质量验收
- 规范基础：ISO/IEC 25010:2023、25023:2016、25030:2019、25040:2024、ISO/IEC/IEEE 29119-2:2021

## 对象、用途与边界

评价对象是本目录中 `pm-mcp 0.1.0` 的当前源码树，以及由该源码构建的本地 stdio MCP 服务。目标环境为 Windows x64、当前 Node.js 25.8.1；发布包声明的最低 Node.js 版本仍是 22.13。本次包含项目事实账本、治理门禁、质量执行与已留存的 20 GiB 合成容量资格证据。

本次不评价托管 CI、生产 HA/DR、真实组织采纳、独立第三方认证、safety-critical 用途，也不把静态 AST 冒充运行时执行证明。若产品用于反射、动态分发、生成代码或线上拓扑决策，必须把绑定源码摘要的 runtime trace 纳入新版本基线。

## 冻结准则

批准基线包含 33 项量化需求、33 项验收测试和 8 项风险。主要门槛为：

- MCP inventory：46 tools、7 resources、5 prompts；名称唯一。
- 测试：至少 160 项；failed/cancelled/skipped/todo 均为 0；所有质量命令通过。
- 覆盖率：lines ≥90%、branches ≥85%、functions ≥90%。
- 维护性：`src` 与 `scripts` 中实现文件超过 500 行的数量为 0。
- 20 GiB：容量和全字节读取 oracle 一致；峰值 RSS ≤1024 MiB；总时长 ≤3600 秒；warm walk ≤5 秒；steady audit ≤1 秒；snapshot ≤3 秒。
- 语义治理：八种内置 AST 语言；当前声明源码 assurance=100%、internal resolution=100%；fallback/unresolved/cycle/violation 均为 0。
- 安全：open finding=0；accepted finding 缺少 note=0。
- 质量执行前后源码树 SHA-256 必须一致，且终验当前源码摘要必须与质量结果绑定值一致。

具体指标、证据 ID、RFC 6901 JSON Pointer、比较运算与期望值以已批准基线 JSON 为唯一事实来源；不得通过修改本计划降低门槛。

## ISO/IEC 25040 五阶段

1. Define：确认对象、版本、用途、环境、利益相关方和排除项；输出批准基线。
2. Design：把八项适用质量特性转成量化需求、风险、测试和机器证据指针；Safety 仅因明确排除 safety-critical 用途而裁剪。
3. Plan：冻结执行顺序、进入/退出准则、停止条件和报告格式；批准后同版本不可修改。
4. Execute：运行本地 audit、AST governance、test/build/typecheck/coverage；采集 MCP inventory、源码树指纹、安全台账与 20 GiB 原始证据摘要。
5. Conclude：复算所有证据 SHA-256，从冻结 JSON Pointer 重建实测值和测试状态；计算风险和追踪闭环；生成不可覆盖 JSON、Markdown 和 SHA-256 manifest。

## 进入、停止、重测与完成准则

- Execute 只能在基线批准后开始。
- 任一命令失败、缺工具、超时、blocked、证据缺失/越界/摘要不一致、源码执行期间变化或测试跳过，立即判定不通过。
- 修复后必须使用新的 quality/evaluation/report 证据；不得覆盖第一次失败记录。
- 所有适用特性、33 项需求、33 项测试、8 项风险和五阶段均通过，追踪链 100% 完整，才允许 `accepted`。
- 正式报告三件套任何一件缺失或变化时，不允许原地修补；必须重新评价并使用新的 report ID。

## 残余风险规则

基线允许的最高残余风险为 Low。每项风险必须有 owner、likelihood、impact、treatment 和补偿控制。若使用 accepted 处置，接受人必须在冻结授权名单中，包含明确理由和未来复审日期；过期、越权、开放或高于 Low 均阻断。

本计划与最终报告仅构成第一方产品验收证据，不构成 ISO 或其他机构颁发的认证。
