# pm-mcp — 项目仪表盘

> ⚠️ 本文件由 pm-mcp 自动生成（勿手改）。状态账本写入后自动刷新；手动刷新用 regenerate_dashboard。
> 生成时间: 2026-10-27T08:23:29.440Z
> AI 编码项目的单一事实来源 + 健康台账 MCP 服务

## 🗺️ 路线图

```mermaid
flowchart LR
  M1["M1 v1 核心能力"]:::done
  M2["M2 v2 增强"]:::done
  M3["M3 v3 体验增强（Web UI 仪表盘等，暂不排期）"]:::planned
  M4["M4 M4 目标锚定与编排开关（被动驱动的持久账本）"]:::done
  M5["M5 M5 编排闭环文档化"]:::active
  M1 --> M2
  M2 --> M3
  M3 --> M4
  M4 --> M5
  classDef done fill:#9ca3af,stroke:#6b7280
  classDef active fill:#86efac,stroke:#16a34a
  classDef planned fill:#e5e7eb,stroke:#9ca3af
  classDef paused fill:#fde68a,stroke:#d97706
```

✅ [██████████] 100% M1 v1 核心能力（9/9）
✅ [██████████] 100% M2 v2 增强（30/30）
○ [░░░░░░░░░░] 0% M3 v3 体验增强（Web UI 仪表盘等，暂不排期）（0/1）
✅ [██████████] 100% M4 M4 目标锚定与编排开关（被动驱动的持久账本）（5/5）
▶ [██████████] 100% M5 M5 编排闭环文档化（2/2）

## 🎯 当前焦点
- （无进行中任务。从 backlog 挑一个开始，或 add_task 创建。）
- 当前阶段: v0.3.0 本地验收通过：固定安装目录已配置，既有客户端待重连核验；未发布

## 🩺 健康摘要
| 账本 | 状态 |
|---|---|
| 漂移（防幻觉） | ✅ 无 |
| 债务（反挤出） | ✅ 无未清债务 |
| churn（变更率） | ⚠️ 热点 README.md(37), package.json(21), src/index.ts(17) |
| 安全 | ✅ 无未处理发现 |
| 调试知识 | 27 条记录 |
| 测试背书 | 34/34 个功能带测试 |
| 语义治理 | 1 模块 / 1 接口 / 1 仓库 |
| 质量矩阵 | ✅ 2026-10-27 08:23（命令 4/4；证据 tests_observed） |
| 标准化验收 | ✅ 2026-10-27 08:23（需求 33/33，errors 0） |
| 自动编排 | ✅ running（一轮正在执行：cron-2026-10-27T08:11:29Z）· 并发 8 · 轮次 2/不限 |

## 🧭 模块与语言治理
- pm-mcp [tool] typescript · owner project-maintainers · roots .
- 策略: ownership=true · declared-deps=true · public-interfaces=true · unresolved=true · source-coverage≥80% · semantic≥ast · regex-fallback=forbidden · quality=test,build,typecheck,coverage
- 实时语义结果：pm://architecture / audit_governance；跨仓：pm://portfolio。

## 📋 任务
- 总览: done 75 · backlog 1

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
### audit
- ✅ F-029 Git 对账应用项目级扫描排除 — Git 工作区对账尊重项目级 scan_ignore，避免显式排除的运行时/产物变更进入 unaccounted 或 unverified。
### clients
- ✅ F-030 Qoder 客户端接入（工作区解析适配器） — 让 Qoder 用户级一条 MCP 配置服务所有工作区：resolveRoot 支持客户端工作区提示与未插值占位符防护；dist/qoder-launch.js
### MCP 服务端
- ✅ F-031 按请求认领项目根（多窗口共用常驻进程） — 客户端（如 Qoder）把一个常驻 MCP 子进程复用给所有窗口时，项目根不再在启动时定格，而是每次工具调用重新认领调用方工作区：显式 root 参数 > 会话
### pm-mcp
- ✅ F-032 Qoder 按请求认领工作区与 launch 接入 — Qoder 多窗口共用常驻子进程时项目根不再启动期钉死：服务端按「工具名+参数+紧时间窗」指纹倒扫会话运行日志拿调用方 cwd，root_source 如实标注
- ✅ F-033 git 对账 fallback 解析 — 宿主进程 PATH 缺 git 时 resolveGitCommand 按 PATH → where git → 常见安装路径兜底解析并缓存；changedGi
### 编排
- ✅ F-034 自动编排：目标锚定、手动开关、并发与轮次记账 — 自动编排的持久账本与指令源（ADR-008）：set_goal 写最终目标与机器可判定的验收锚点；set_orchestrator 手动开关（enabled 变

## 🏛️ 架构决策（最近）
- [ADR-009-编排闭环五段分工与-active_run_id-自愈指针（ADR-009）](.pm/decisions/ADR-009-编排闭环五段分工与-active_run_id-自愈指针（ADR-009）.md)
- [ADR-008-ADR-008-编排分工定位：控制流外置，pm-mcp-只记账与发指令](.pm/decisions/ADR-008-ADR-008-编排分工定位：控制流外置，pm-mcp-只记账与发指令.md)
- [ADR-007-输出行数预算显式设为-100（默认-150）](.pm/decisions/ADR-007-输出行数预算显式设为-100（默认-150）.md)
- [ADR-006-Qoder-项目根改为按请求认领：常驻子进程被所有窗口共用，ppid-与启动期-](.pm/decisions/ADR-006-Qoder-项目根改为按请求认领：常驻子进程被所有窗口共用，ppid-与启动期-.md)
- [ADR-005-Qoder-项目根解析：按-ppid-匹配会话运行日志，而不是钉死---root](.pm/decisions/ADR-005-Qoder-项目根解析：按-ppid-匹配会话运行日志，而不是钉死---root.md)

## 📜 最近会话
- 2026-10-27 [zcode] T-076：README.md 新增「验收基线升版流程」一节——四步升版（旧版 JSON 生成新版本号文件只改必要阈值 / save_acceptance_baseline_draft 存 draft / approve_acceptance_baseline 按 fingerprint 批准 / package.json 指向新版），并写明升版必须同时提供 <baseline-id>-<version>-plan.md 与 <baseline-id>-<version>-first-failure.md 两份证据，缺任一 acceptance 脚本直接 ENOENT。
  - 改动: README.md
- 2026-10-27 [?] T-075 README 与 ADR 记录「心跳 + workflow」五段闭环约定：README「自动编排闭环」小节与 ADR-009 落地；独立复核发现的 7 处与代码不符已逐条修正（budgetLabel 适用范围、get_orchestrator 无 structuredContent、begin/end 真实幂等行为补幂等层说明、只写路径持账本锁、重置计数需 enabled 真实翻转、自愈结算代价）。卡原验收要求的 gate 全绿经由基线 1.2.0 升版达成（48→58），升版由用户授权「修好他」。
  - 改动: README.md, .pm/acceptance/baselines/pm-mcp-local-release/1.2.0.json, .pm/acceptance/evidence/pm-mcp-local-release-1.2.0-plan.md, .pm/acceptance/evidence/pm-mcp-local-release-1.2.0-first-failure.md, package.json, .pm/decisions/ADR-009-编排闭环五段分工与-active_run_id-自愈指针（ADR-009）.md
- 2026-10-27 [zcode] 修复验收门禁死锁并纠正文档：①基线升版 1.1.0→1.2.0（QR-FS-TOOLS 阈值与 AT-FS-TOOLS 断言 48→58，其余门槛不变），draft→approve 走工具链，同步 package.json 指向 1.2.0，补 1.2.0 的 plan 与 first-failure 证据（升版必需，否则 acceptance 脚本 ENOENT）；②按独立复核意见修正 README「自动编排闭环」七处表述（budgetLabel 适用范围、get_orchestrator 无 structuredContent、begin/end 的真实幂等行为、缺幂等层说明、只写路径持锁、重置计数需 enabled 真实翻转、自愈结算会吃预算并清零停滞）；③workflow 门禁命令改为 cmd.exe /c npm run gate（Windows 下 shell-less spawn 起不了 npm，实测 exit 0）。
  - 改动: README.md, package.json, .pm/acceptance/baselines/pm-mcp-local-release/1.2.0.json, .pm/acceptance/evidence/pm-mcp-local-release-1.2.0-plan.md, .pm/acceptance/evidence/pm-mcp-local-release-1.2.0-first-failure.md, .zcode/workflow-drafts/T-075-编排闭环文档化.dwf.ts
- 2026-10-27 [?] T-075 README 与 ADR 记录「心跳 + workflow」五段闭环约定：README「自动编排闭环」小节与 ADR-009 已写入，但独立复核指出 7 处与代码不符（budgetLabel 并非全站渲染、get_orchestrator 无 structuredContent、record_round 幂等层未被说明、enabled 未翻转时重置计数是静默 no-op、纯读路径不持锁、自愈 end 会推进轮数等）。npm run gate 退出码 1：audit 无红旗、quality PASS，acceptance-gate errors=8——已批准基线把 mcp_tools 固定为 equal 48，实测 58。
- 2026-10-27 [zcode] T-075 收尾：把 README「自动编排闭环」预算渲染示例改写为 budgetLabel 的精确输出（`7/40 轮（上限 24h）`、`7/不限 轮（上限 不限）`），使会话内容证据重新覆盖 README 当前内容。前一条会话 S-0074 已记录本节与 ADR-009 的主体内容；本次仅一处措辞修正，未改源码，未 commit。
  - 改动: README.md

---
stack: TypeScript, Node.js>=22.18 · modules: src, test, scripts · exposure: public · license: MIT
