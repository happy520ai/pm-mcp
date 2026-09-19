# pm-mcp — 项目仪表盘

> ⚠️ 本文件由 pm-mcp 自动生成（勿手改）。状态账本写入后自动刷新；手动刷新用 regenerate_dashboard。
> 生成时间: 2026-09-19T02:30:01.700Z
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
▶ [████████░░] 79% M2 v2 增强（19/24）
- ⚠️ 重构被挤出: M2 v2 增强 重构类占比 17% < 配额 20%

## 🎯 当前焦点
- （无进行中任务。从 backlog 挑一个开始，或 add_task 创建。）
- 当前阶段: v0.3.0 本地验收通过：固定安装目录已配置，既有客户端待重连核验；未发布

## 🩺 健康摘要
| 账本 | 状态 |
|---|---|
| 漂移（防幻觉） | ✅ 无 |
| 债务（反挤出） | ✅ 无未清债务 |
| churn（变更率） | ⚠️ 热点 README.md(24), package.json(16), src/index.ts(14) |
| 安全 | ✅ 无未处理发现 |
| 调试知识 | 19 条记录 |
| 测试背书 | 23/23 个功能带测试 |
| 语义治理 | 1 模块 / 1 接口 / 1 仓库 |
| 质量矩阵 | ✅ 2026-09-19 02:27（命令 2/2；证据 tests_observed） |
| 标准化验收 | ✅ 2026-09-17 15:22（需求 33/33，errors 0） |

## 🧭 模块与语言治理
- pm-mcp [tool] typescript · owner project-maintainers · roots .
- 策略: ownership=true · declared-deps=true · public-interfaces=true · unresolved=true · source-coverage≥80% · semantic≥ast · regex-fallback=forbidden · quality=test,build,typecheck,coverage
- 实时语义结果：pm://architecture / audit_governance；跨仓：pm://portfolio。

## 📋 任务
- 总览: done 49 · backlog 6

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
- ✅ F-015 使用日志与运行日志 — get_usage_log/get_runtime_log：工具调用计量（成败/耗时/输出与折叠省下的 token 估算，验证省不省 token）与服务级运行事
- ✅ F-016 任务合并更新与当前源码验证 — update_task合并进度、checkpoint和可选会话；feature/fix完成时校验最新真实质量报告、任务文件与当前源码摘要，保留48工具和旧账本读
- ✅ F-017 内容摘要对账与可配置扫描范围 — 按多会话内容摘要核对Git变化，识别删除和重命名；统一扫描、搜索、语言发现、指纹及实时索引的缓存排除范围，无文件名监听通知标脏恢复。
- ✅ F-021 WorkBuddy 客户端接入与配置核验 — 统一安装器新增 workbuddy 客户端：按 WORKBUDDY_CONFIG_DIR → ~/.workbuddy-ai → ~/.workbuddy 解析
### scripts
- ✅ F-008 字节/超大LOC容量基准 — 按精确字节与LOC生成可扫描代码树，验证结构、watcher、安全、许可证覆盖并安全清理
### MCP 运行与配置
- ✅ F-018 MCP 运行版本核验与受控本地升级 — setup 支持固定本地包升级、仅替换目标启动参数并备份；doctor 新建连接核验版本、项目根和48工具，明确区分既有客户端重连。
### 任务管理
- ✅ F-019 任务游标分页与结构化结果 — list_tasks 提供受预算约束的完整分页与 structuredContent；游标绑定项目、过滤条件和数据版本；pm://tasks 截断后提供续读入口
### 质量验证
- ✅ F-020 完成证据分级与明确兼容策略 — 区分未验证、仅执行、测试已观察和覆盖率已观察；默认拒绝未知测试计数完成任务，兼容策略须注明理由并保留失败/零测试/过期证据约束。
### 工具目录核验
- ✅ F-022 pm-mcp probe：标准 raw tools/list 直连探针 — 绕过宿主以 MCP client 身份直连任意 stdio 服务器，取标准 raw tools/list 原始响应（自动翻页取全），支持 --expect/--
- ✅ F-023 定时巡检工具目录探针（TOOL_CATALOG_SIZE 漂移检测） — 健康巡检（npm run audit → scripts/health-check.mts）在巡检 pm-mcp 自身仓库时，自动用 pm-mcp probe 

## 🏛️ 架构决策（最近）
- [ADR-004-语义治理采用AST保证分层与运行时证据扩展](.pm/decisions/ADR-004-语义治理采用AST保证分层与运行时证据扩展.md)
- [ADR-003-标准化验收采用冻结基线与机器证据指针](.pm/decisions/ADR-003-标准化验收采用冻结基线与机器证据指针.md)
- [ADR-002-v1-全部离线，不联网](.pm/decisions/ADR-002-v1-全部离线，不联网.md)
- [ADR-001-状态存储用-git-友好的文件而非-SQLite](.pm/decisions/ADR-001-状态存储用-git-友好的文件而非-SQLite.md)

## 📜 最近会话
- 2026-09-19 [?] 三件事执行：①推送 3 个提交（e910ca0/42c0e5a/e307ab6）到 origin main，CI 双节点全绿。②npm 0.3.0 发布：重打包并替换 Release v0.3.0 资产（d01d8603…含 probe），工作流重 pin 哈希，publish=false 验证跑全绿（OIDC 声明/SHA/干跑全对），publish=true 真发失败 ENEEDAUTH——官方文档确认这是 npm 网站侧 Trusted Publisher 未配置/不匹配的标准报错，待用户在 npmjs.com 配置（仓库外变更：GitHub Release 资产）。③工具目录探针接入 health-check（TOOL_CATALOG_SIZE 单一事实来源 + probe env 沙箱支持），真跑巡检绿，298/298（quality-20260919-022756），F-023 已登记。
  - 改动: src/version.ts, src/doctor.ts, src/probe.ts, scripts/health-check.mts, test/probe.test.ts, test/fixtures/raw-mcp-server.mjs, .github/workflows/publish-npm.yml
- 2026-09-19 [?] 「全部解决修复」收尾：①用 codex app-server mcpServerStatus/list 实证三宿主均全量暴露 49 工具，更正上轮「23 个不可见」误判（tools.X 子段是 output_token_limit 覆盖非过滤器）；为 Codex config.toml 补齐 23 个缺失工具的 output_token_limit 条目（备份 config.toml.backup-before-tools-49-20260919-095205，tomllib 校验过，名字与服务器 49/49 对齐）。②WorkBuddy/ZCode 配置核对无过滤。③把语义证据特性与 probe 特性分两个提交落账。仓库外变更：E:\\Codex\\.codex\\config.toml。
  - 改动: src/doctor.ts, test/upgrade-030.test.ts, src/probe.ts, src/cli.ts, test/probe.test.ts, test/fixtures/raw-mcp-server.mjs, README.md
- 2026-09-19 [?] 根治「宿主不提供标准 raw tools/list」：新增 pm-mcp probe 子命令（T-053/F-022），SDK client 直连任意 stdio MCP 服务器取原始 tools/list 并支持 expect 基线比对；真实验收列出 49 工具、对 Codex allowlist（26 个）比对 missing 0/extra 23。顺带修复并行会话造成的工具契约漂移 48→49（T-054：doctor/upgrade-030 测试/README），全量测试 297/297 全绿（正式报告 quality-20260919-014142-253-0000.json）。未提交任何 git 提交。
  - 改动: src/probe.ts, src/cli.ts, test/probe.test.ts, test/fixtures/raw-mcp-server.mjs, src/doctor.ts, test/upgrade-030.test.ts, README.md
- 2026-09-19 [?] 诊断「当前活动 MCP 宿主仍未提供标准 raw tools/list」：确认为宿主架构使然而非配置故障。排查了 pm-mcp 代码、共享目录、codex中间层对照验证、统一网关证据与 Codex 历史会话，溯源到 2026-09-07 Cursor 3.19.13 宿主验收会话；Cursor 仅有内部 IPC mcp.listToolsRaw 非公开 API，Codex app-server 用私有 mcpServerStatus/list，ZCode 只注入翻译后的函数 schema。未改任何文件。
- 2026-09-17 [workbuddy] 接手并行会话遗留的 src/dashboard.ts 改动并验证提交。该改动把仪表盘的漂移对账统一到 audit.ts 的 detectDrift，口径由「仅 implemented 功能的 entry_files」扩为「功能入口文件 + done 任务关联文件」，消除 dashboard 与 audit_structure 两处口径不一致。验证：重建 dist、tsc --noEmit 干净、dashboard.test.ts + realrepo.test.ts 10/10 通过，提交 8892eb5 并推送，CI（Node 22.18/24）全绿。同时排查了「同步更新 GitHub 时出现死循环」：源头是另一会话（工作区在 E:/AI-Data/AI网关系统/unified-ai-system）跨项目反复操作本仓库（931 次 Bash、49 轮重复 get_status/get_roadmap/list_tasks，会话日志 36MB），该会话现已停止；其遗留的 dist.bak-20260917T2226/ 与 .tmp-test-full-20260917.log 已由其自行移除，本仓库 git status 归零。远程 main = 本地 HEAD = 8892eb5。
  - 改动: src/dashboard.ts

---
stack: TypeScript, Node.js>=22.18 · modules: src, test, scripts · exposure: public · license: MIT
