# pm-mcp — 项目仪表盘

> ⚠️ 本文件由 pm-mcp 自动生成（勿手改）。状态账本写入后自动刷新；手动刷新用 regenerate_dashboard。
> 生成时间: 2026-09-03T09:07:43.313Z
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
▶ [███████░░░] 70% M2 v2 增强（14/20）
- ⚠️ 重构被挤出: M2 v2 增强 重构类占比 15% < 配额 20%

## 🎯 当前焦点
- 🔄 T-033 强化多 Agent 强杀恢复、路径别名与持续压力（步骤 4/5）
- 当前阶段: v0.1.4 multi-agent crash hardening

## 🩺 健康摘要
| 账本 | 状态 |
|---|---|
| 漂移（防幻觉） | ✅ 无 |
| 债务（反挤出） | ✅ 无未清债务 |
| churn（变更率） | ⚠️ 热点 README.md(14), package.json(11), src/index.ts(9) |
| 安全 | ✅ 无未处理发现 |
| 调试知识 | 8 条记录 |
| 测试背书 | 14/14 个功能带测试 |
| 语义治理 | 1 模块 / 1 接口 / 1 仓库 |
| 质量矩阵 | ✅ 2026-09-03 06:43（4/4） |
| 标准化验收 | ✅ 2026-09-03 06:43（需求 33/33，errors 0） |

## 🧭 模块与语言治理
- pm-mcp [tool] typescript · owner project-maintainers · roots .
- 策略: ownership=true · declared-deps=true · public-interfaces=true · unresolved=true · source-coverage≥80% · semantic≥ast · regex-fallback=forbidden · quality=test,build,typecheck,coverage
- 实时语义结果：pm://architecture / audit_governance；跨仓：pm://portfolio。

## 📋 任务
- 总览: done 25 · backlog 7 · in_progress 1
- [in_progress] T-033 强化多 Agent 强杀恢复、路径别名与持续压力 (fix, M2)

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
- ✅ F-012 统一 MCP 客户端安装器 — 一个 npx setup 命令自动检测 Codex、Claude Code、ZCode、Cursor、VS Code；支持备份、dry-run、force 与通
- ✅ F-013 多 Agent 读写幂等协调 — 跨进程合并完全相同的并行读；写工具提供显式业务幂等键与自动瞬时去重；键冲突 fail-closed，长写锁按进程存活性安全接管。
- ✅ F-014 多 Agent 故障恢复与单 watcher 协调 — 业务提交间隙强杀采用 at-most-once + uncertain fail-closed；SQLite 生命周期锁消除 stale-lock ABA/PI
### scripts
- ✅ F-008 字节/超大LOC容量基准 — 按精确字节与LOC生成可扫描代码树，验证结构、watcher、安全、许可证覆盖并安全清理

## 🏛️ 架构决策（最近）
- [ADR-004-语义治理采用AST保证分层与运行时证据扩展](.pm/decisions/ADR-004-语义治理采用AST保证分层与运行时证据扩展.md)
- [ADR-003-标准化验收采用冻结基线与机器证据指针](.pm/decisions/ADR-003-标准化验收采用冻结基线与机器证据指针.md)
- [ADR-002-v1-全部离线，不联网](.pm/decisions/ADR-002-v1-全部离线，不联网.md)
- [ADR-001-状态存储用-git-友好的文件而非-SQLite](.pm/decisions/ADR-001-状态存储用-git-友好的文件而非-SQLite.md)

## 📜 最近会话
- 2026-09-03 [codex] 修复 v0.1.4 发布门禁首败：将 stale-lock 测试中的 secret-shaped 固定 token 改为运行时 UUID；保留 SEC-016 首次发现并由复扫自动关闭。
  - 改动: test/lock-stampede.test.ts
- 2026-09-03 [codex] 完成多 Agent 读写与重复调用治理并发布 v0.1.3：全部读工具跨进程合并在途同参请求，全部写工具支持显式业务幂等和自动瞬时去重，同键参数冲突拒绝；修复长锁误抢与读缓存新鲜度，npm 双 Agent 冷启动实证同业务只落一次。
  - 改动: src/idempotency.ts, src/tool-base.ts, src/store.ts, src/index.ts, src/acceptance-tools.ts, src/audit-tools.ts, src/governance-tools.ts, src/knowledge-tools.ts 等 22 个
- 2026-09-03 [codex] 发布 pm-mcp v0.1.2 统一安装入口：一个 npx setup 命令自动检测五类 AI 编程客户端，支持备份、dry-run、force、显式客户端和通用 JSON；CLI/MCP 双路径分流，npm 冷启动与 GitHub 双版本 CI 均通过。
  - 改动: src/cli.ts, src/setup.ts, test/setup.test.ts, test/realrepo.test.ts, package.json, package-lock.json, README.md, install.ps1 等 10 个
- 2026-09-03 [codex] 发布 @luckychen1993/pm-mcp@0.1.1 到 npm Registry：启用发布账号 2FA，统一包名/版本与安装命令，完成本地 gate、双版本 GitHub CI、匿名 Registry 元数据和全新缓存 MCP 冷启动验证，并创建 GitHub v0.1.1 Release。
  - 改动: package.json, package-lock.json, README.md, install.ps1, src/index.ts, scripts/create-pm-acceptance-profile.mts
- 2026-09-03 [codex] 公开发布 pm-mcp v0.1.0：建立 Git 仓库并推送 GitHub，补齐固定 Release 标签的一键 MCP 安装、精简发布包和双版本 CI；保留首轮托管失败并修复报告排序与 SQLite 并发启动问题，远端 npx MCP smoke 通过。
  - 改动: .gitattributes, .github/workflows/ci.yml, .gitignore, README.md, install.ps1, package.json, package-lock.json, src/dashboard.ts 等 16 个

---
stack: TypeScript, Node.js>=22.18 · modules: src, test, scripts · exposure: public · license: MIT
