# pm-mcp — 项目仪表盘

> ⚠️ 本文件由 pm-mcp 自动生成（勿手改）。状态账本写入后自动刷新；手动刷新用 regenerate_dashboard。
> 生成时间: 2026-09-19T05:52:20.295Z
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
▶ [█████████░] 90% M2 v2 增强（27/30）
- ⚠️ 重构被挤出: M2 v2 增强 重构类占比 17% < 配额 20%

## 🎯 当前焦点
- （无进行中任务。从 backlog 挑一个开始，或 add_task 创建。）
- 当前阶段: v0.3.0 本地验收通过：固定安装目录已配置，既有客户端待重连核验；未发布

## 🩺 健康摘要
| 账本 | 状态 |
|---|---|
| 漂移（防幻觉） | ✅ 无 |
| 债务（反挤出） | ✅ 无未清债务 |
| churn（变更率） | ⚠️ 热点 README.md(29), package.json(18), src/index.ts(14) |
| 安全 | ✅ 无未处理发现 |
| 调试知识 | 19 条记录 |
| 测试背书 | 28/28 个功能带测试 |
| 语义治理 | 1 模块 / 1 接口 / 1 仓库 |
| 质量矩阵 | ✅ 2026-09-19 05:35（命令 2/2；证据 tests_observed） |
| 标准化验收 | ✅ 2026-09-17 15:22（需求 33/33，errors 0） |

## 🧭 模块与语言治理
- pm-mcp [tool] typescript · owner project-maintainers · roots .
- 策略: ownership=true · declared-deps=true · public-interfaces=true · unresolved=true · source-coverage≥80% · semantic≥ast · regex-fallback=forbidden · quality=test,build,typecheck,coverage
- 实时语义结果：pm://architecture / audit_governance；跨仓：pm://portfolio。

## 📋 任务
- 总览: done 57 · backlog 4

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
### 语义治理
- ✅ F-024 dependency_graph 依赖图查询与文件级循环检测 — 查询跨文件/模块依赖图：全局摘要（关系/环/入出边枢纽 Top5）、模块与文件级循环列表、聚焦文件的依赖邻域（BFS，direction deps|depend
### 质量与组合
- ✅ F-025 find_duplicates 重复代码检测（行指纹聚类） — 零依赖重复代码检测：行指纹（注释剥离/字符串占位/空白归一化）滑动窗口聚类，跨文件重复块按长度降序；min_lines 4-20（默认 6）、limit 可调；
- ✅ F-026 audit_osv 联网漏洞查询（显式确认门控） — OSV.dev 已知漏洞查询（联网、默认关）：复用多语言 manifest 解析收集依赖，仅发送包名/版本/生态到 api.osv.dev querybatch
### 仪表盘
- ✅ F-027 pm-mcp ui 本地只读 Web 仪表盘 — 本地只读 Web 仪表盘：`pm-mcp ui [--root <项目>] [--port <端口>]`（端口 0 自动分配），仅绑定 127.0.0.1，GE
### 安全
- ✅ F-028 search_code_public 公开代码反查（ 版权溯源初版） — 公开代码反查（GitHub Code Search，联网默认关）：把一段本仓源码行作为词项 AND 查询发给 GitHub，列出包含相同代码的公开仓库；conf

## 🏛️ 架构决策（最近）
- [ADR-004-语义治理采用AST保证分层与运行时证据扩展](.pm/decisions/ADR-004-语义治理采用AST保证分层与运行时证据扩展.md)
- [ADR-003-标准化验收采用冻结基线与机器证据指针](.pm/decisions/ADR-003-标准化验收采用冻结基线与机器证据指针.md)
- [ADR-002-v1-全部离线，不联网](.pm/decisions/ADR-002-v1-全部离线，不联网.md)
- [ADR-001-状态存储用-git-友好的文件而非-SQLite](.pm/decisions/ADR-001-状态存储用-git-友好的文件而非-SQLite.md)

## 📜 最近会话
- 2026-09-19 [?] 0.5.0 发布完成：a72240d 版本+pin（sha 5428a7ac）→Release v0.5.0 资产（重打包确定性一致）→validate+publish 双 dispatch 全绿（核验轮询正常）→npm latest=0.5.0→冷安装自探 53 工具含 search_code_public。内容：search_code_public 版权溯源 + OSV lockfile 误报修复。台账 S-0059。
  - 改动: .github/workflows/publish-npm.yml, package.json, package-lock.json
- 2026-09-19 [?] 完成 T-009/T-061/F-028：search_code_public 公开代码反查（GitHub Code Search 词项 AND；grep.app 因 Vercel 反机器人弃用并记录；confirm=z.literal(true)+片段参数内可见的双重门控；凭据链 env→gh auth token；401/403/422 可行动错误）。契约 52→53。真网两连验证（独特行 0 命中/公开行 8 命中，跨项目同名常量碰撞实证）。全量 323/323（quality-20260919-053505）。仓库外：E:\\Codex\\.codex\\config.toml 增 search_code_public 条目。至此 M2 backlog 全部清零。
  - 改动: src/public-search.ts, src/audit-tools.ts, src/version.ts, test/public-search.test.ts, test/integration.test.ts, README.md
- 2026-09-19 [?] T-059 收口（结论反转：两条 GHSA 均为误报，实装版本已过修复线；根因=范围串发给 OSV 被解析到边界下；修复=npm 按 lockfile 实装版本查询，复扫 11/11 归零，fe83493）。0.4.0 发布全链路成功：21fb107 版本+pin→Release v0.4.0 资产 sha 一致（0bca3ece）→validate+publish 双 dispatch 全绿→npm latest=0.4.0→冷安装自探 52 工具齐。T-009 立项并完成选型调研（推荐 grep.app confirm 门控起步，代码片段外发边界需用户确认）。
  - 改动: src/osv.ts, test/osv.test.ts, .github/workflows/publish-npm.yml, package.json, package-lock.json
- 2026-09-19 [?] 完成 T-012/T-060/F-027：pm-mcp ui 本地只读 Web 仪表盘（零依赖 node:http，127.0.0.1 only，SSR + /api/state + /healthz，全插值 HTML 转义 + CSP 禁脚本，未纳管 fail-closed，SIGINT 优雅关闭）；CLI 冒烟通过；317/317（quality-20260919-043548）。不新增 MCP 工具（目录保持 52）。至此 M2 backlog 可实现项全部完成，仅剩 T-009 待用户选型。
  - 改动: src/ui.ts, src/cli.ts, test/ui.test.ts, README.md
- 2026-09-19 [?] 完成 T-008/T-058/F-026：audit_osv 联网漏洞查询（confirm=z.literal(true) 显式门控，只发包名/版本/生态，querybatch 100/批，fetcher 注入全 mock 测试），契约 51→52。真网首跑命中本仓 2 条 GHSA（SDK/zod），登记 T-059 处置。全量 313/313（quality-20260919-041919）。仓库外：E:\\Codex\\.codex\\config.toml 增 audit_osv 条目。
  - 改动: src/osv.ts, src/audit-tools.ts, src/version.ts, test/osv.test.ts, test/integration.test.ts, README.md

---
stack: TypeScript, Node.js>=22.18 · modules: src, test, scripts · exposure: public · license: MIT
