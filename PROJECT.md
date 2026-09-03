# pm-mcp — 项目仪表盘

> ⚠️ 本文件由 pm-mcp 自动生成（勿手改）。状态账本写入后自动刷新；手动刷新用 regenerate_dashboard。
> 生成时间: 2026-09-03T04:44:13.782Z
> AI 编码项目的单一事实来源 + 健康台账 MCP 服务

## 🗺️ 路线图

```mermaid
flowchart LR
  M1["M1 v1 核心能力"]:::done
  M2["M2 v2 增强"]:::active
  M1 --> M2
  classDef done fill:#9ca3af,stroke:#6b7280
  classDef active fill:#86efac,stroke:#16a34a
  classDef planned fill:#e5e7eb,stroke:#9ca3af
  classDef paused fill:#fde68a,stroke:#d97706
```

✅ [██████████] 100% M1 v1 核心能力（9/9）
▶ [██████░░░░] 63% M2 v2 增强（10/16）
- ⚠️ 重构被挤出: M2 v2 增强 重构类占比 19% < 配额 20%

## 🎯 当前焦点
- 🔄 T-029 发布 GitHub v0.1.0 并提供一键 MCP 安装（步骤 2/4）
- 当前阶段: v0.1.0 public release

## 🩺 健康摘要
| 账本 | 状态 |
|---|---|
| 漂移（防幻觉） | ✅ 无 |
| 债务（反挤出） | ✅ 无未清债务 |
| churn（变更率） | ⚠️ 热点 README.md(10), package.json(7), src/scan.ts(7) |
| 安全 | ✅ 无未处理发现 |
| 调试知识 | 5 条记录 |
| 测试背书 | 11/11 个功能带测试 |
| 语义治理 | 1 模块 / 1 接口 / 1 仓库 |
| 质量矩阵 | ✅ 2026-09-03 04:38（4/4） |
| 标准化验收 | ✅ 2026-09-03 04:38（需求 33/33，errors 0） |

## 🧭 模块与语言治理
- pm-mcp [tool] typescript · owner project-maintainers · roots .
- 策略: ownership=true · declared-deps=true · public-interfaces=true · unresolved=true · source-coverage≥80% · semantic≥ast · regex-fallback=forbidden · quality=test,build,typecheck,coverage
- 实时语义结果：pm://architecture / audit_governance；跨仓：pm://portfolio。

## 📋 任务
- 总览: done 21 · backlog 7 · in_progress 1
- [in_progress] T-029 发布 GitHub v0.1.0 并提供一键 MCP 安装 (chore, M2)

## 🧩 功能清单
### src
- ✅ F-001 状态与任务管理 — init/get_status/任务生命周期/checkpoint 断点
- ✅ F-002 路线图 — 里程碑+自适应渲染+重构配额告警
- ✅ F-003 结构对账审计 — 完整性/增长/漂移/债务/churn/复杂度/索引/足迹/测试/Git 十节对账
- ✅ F-004 安全体检 — 已识别密钥/危险模式/依赖元数据启发式扫描+台账闭环
- ✅ F-005 许可证审计 — copyleft 冲突+GPL 头+provenance
- ✅ F-006 求证检索 — search_code + 七类知识源（含治理模型）检索 + annotate_file
- ✅ F-007 自动仪表盘 — PROJECT.md 与 changelog.md 生成
- ✅ F-009 跨文件/模块/语言语义治理 — 结构化模块/owner/公开接口、TypeScript Compiler与六语言Tree-sitter AST、hash-bound runtime evide
- ✅ F-010 标准化产品验收与防伪证据链 — 版本化预批准质量基线、ISO 25010九特性/25040五阶段、需求风险测试追踪、冻结JSON Pointer、证据与报告SHA-256及机器判定门禁
- ✅ F-011 编译器与多语言 AST 语义治理 — TypeScript Compiler API与六语言Tree-sitter AST、symbol-bound调用边、hash-bound原生/运行时证据和严格
### scripts
- ✅ F-008 字节/超大LOC容量基准 — 按精确字节与LOC生成可扫描代码树，验证结构、watcher、安全、许可证覆盖并安全清理

## 🏛️ 架构决策（最近）
- [ADR-004-语义治理采用AST保证分层与运行时证据扩展](.pm/decisions/ADR-004-语义治理采用AST保证分层与运行时证据扩展.md)
- [ADR-003-标准化验收采用冻结基线与机器证据指针](.pm/decisions/ADR-003-标准化验收采用冻结基线与机器证据指针.md)
- [ADR-002-v1-全部离线，不联网](.pm/decisions/ADR-002-v1-全部离线，不联网.md)
- [ADR-001-状态存储用-git-友好的文件而非-SQLite](.pm/decisions/ADR-001-状态存储用-git-友好的文件而非-SQLite.md)

## 📜 最近会话
- 2026-09-03 [codex] 完成标准化产品验收与编译器/多语言AST语义治理：冻结33项量化需求、33项机器测试和8项风险；证据/源码/报告SHA-256防伪；46工具/7资源/5提示词；完整gate通过，183/183且覆盖率96.57/89.47/94.70，AST assurance与解析率100%，正式报告errors=0。
  - 改动: src/acceptance-model.ts, src/acceptance-evaluator.ts, src/acceptance-report.ts, src/acceptance-tools.ts, src/typescript-semantic.ts, src/polyglot-ast.ts, src/semantic-evidence.ts, src/semantic-evidence-store.ts 等 53 个
- 2026-09-02 [codex] 完成跨文件/模块/语言语义治理层：结构化owner/接口/依赖策略，多生态manifest与真实质量矩阵，import/call/RPC/FFI图，循环/越界/影响分析，跨仓semver组合；完整gate与133项测试通过。
  - 改动: src/governance-model.ts, src/language-adapters.ts, src/language-dependencies.ts, src/semantic-graph.ts, src/semantic-parsers.ts, src/governance-audit.ts, src/portfolio.ts, src/governance-tools.ts 等 33 个
- 2026-09-02 [codex] 完成20 GiB/约2.983亿行源码仓库基准：结构、watcher、快照、安全与许可证全部通过精确容量oracle；修复大批次物化、强制内容走查与跨项目内容缓存问题，原始JSON和人读报告已留存。
  - 改动: scripts/benchmark-volume.mts, src/search.ts, src/index-store.ts, src/scan.ts, scripts/health-check.mts, test/search.test.ts, test/index-store.test.ts, package.json 等 14 个
- 2026-09-02 [codex] 修复监管层核验发现：消除 watcher 重启旧索引、巡检基线覆盖/fail-open 和安全 note 泄漏；修复 npm test 与 rg ignore；新增可复跑正确性/性能基准并收紧 README 证据边界。
  - 改动: src/index-store.ts, src/audit.ts, src/security.ts, src/search.ts, src/tools.ts, src/dashboard.ts, src/index.ts, src/scan.ts 等 21 个
- 2026-09-02 [zcode] 处置巡检红旗 T-020：sql-concat 改静态 SQL 消除（SEC-011 自动关闭）；实现 watcher 就地排空解决变更风暴回退边界；巡检脚本补派生刷新修仪表盘失同步
  - 改动: src/index-store.ts, scripts/health-check.mts, test/index-store.test.ts, README.md

---
stack: TypeScript, Node.js>=22.18 · modules: src, test, scripts · exposure: public · license: MIT
