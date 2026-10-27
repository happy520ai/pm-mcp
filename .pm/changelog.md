# 变更日志（自动生成，来自 sessions.json）

## 2026-10-27 — 未知

T-075 README 与 ADR 记录「心跳 + workflow」五段闭环约定：README「自动编排闭环」小节与 ADR-009 落地；独立复核发现的 7 处与代码不符已逐条修正（budgetLabel 适用范围、get_orchestrator 无 structuredContent、begin/end 真实幂等行为补幂等层说明、只写路径持账本锁、重置计数需 enabled 真实翻转、自愈结算代价）。卡原验收要求的 gate 全绿经由基线 1.2.0 升版达成（48→58），升版由用户授权「修好他」。

改动文件（6）: README.md, .pm/acceptance/baselines/pm-mcp-local-release/1.2.0.json, .pm/acceptance/evidence/pm-mcp-local-release-1.2.0-plan.md, .pm/acceptance/evidence/pm-mcp-local-release-1.2.0-first-failure.md, package.json, .pm/decisions/ADR-009-编排闭环五段分工与-active_run_id-自愈指针（ADR-009）.md

## 2026-10-27 — zcode

修复验收门禁死锁并纠正文档：①基线升版 1.1.0→1.2.0（QR-FS-TOOLS 阈值与 AT-FS-TOOLS 断言 48→58，其余门槛不变），draft→approve 走工具链，同步 package.json 指向 1.2.0，补 1.2.0 的 plan 与 first-failure 证据（升版必需，否则 acceptance 脚本 ENOENT）；②按独立复核意见修正 README「自动编排闭环」七处表述（budgetLabel 适用范围、get_orchestrator 无 structuredContent、begin/end 的真实幂等行为、缺幂等层说明、只写路径持锁、重置计数需 enabled 真实翻转、自愈结算会吃预算并清零停滞）；③workflow 门禁命令改为 cmd.exe /c npm run gate（Windows 下 shell-less spawn 起不了 npm，实测 exit 0）。

改动文件（6）: README.md, package.json, .pm/acceptance/baselines/pm-mcp-local-release/1.2.0.json, .pm/acceptance/evidence/pm-mcp-local-release-1.2.0-plan.md, .pm/acceptance/evidence/pm-mcp-local-release-1.2.0-first-failure.md, .zcode/workflow-drafts/T-075-编排闭环文档化.dwf.ts

下一步: 跑 npm run gate 验证 1.2.0 基线全绿后提交；把升基线流程（draft→approve→package.json 版本→plan/first-failure 证据）写进 ADR-010；心跳的 record_round(begin) 应存 workflow 运行 id 而非时间戳，才能用 active_run_id 直查 GetWorkflowRun

## 2026-10-27 — 未知

T-075 README 与 ADR 记录「心跳 + workflow」五段闭环约定：README「自动编排闭环」小节与 ADR-009 已写入，但独立复核指出 7 处与代码不符（budgetLabel 并非全站渲染、get_orchestrator 无 structuredContent、record_round 幂等层未被说明、enabled 未翻转时重置计数是静默 no-op、纯读路径不持锁、自愈 end 会推进轮数等）。npm run gate 退出码 1：audit 无红旗、quality PASS，acceptance-gate errors=8——已批准基线把 mcp_tools 固定为 equal 48，实测 58。

下一步: 按复核意见逐条修正 README 表述；baseline 升版（48→58）属人工批准动作，不在循环权限内

## 2026-10-27 — zcode

T-075 收尾：把 README「自动编排闭环」预算渲染示例改写为 budgetLabel 的精确输出（`7/40 轮（上限 24h）`、`7/不限 轮（上限 不限）`），使会话内容证据重新覆盖 README 当前内容。前一条会话 S-0074 已记录本节与 ADR-009 的主体内容；本次仅一处措辞修正，未改源码，未 commit。

改动文件（1）: README.md

下一步: 心跳复核阶段：npm run gate 仍因验收基线把 mcp_tools 固定为 48（现 58）而失败，需另立任务升版基线后再重跑

## 2026-10-27 — zcode

T-075 文档与决策：README.md 新增「自动编排闭环（心跳 + 动态工作流）」一节——五段分工（拆卡 / 派发动态工作流 / 结束 tick / 复核 / commit 收轮）、get_orchestrator 七个状态取值与优先级、record_round 的 begin/end 语义与单轮互斥三层保证、预算 null=不限（并如实标注 max_hours 目前不参与状态判定）、active_run_id 作为互斥令牌与「同 id 结算」的自愈指针、复核通过才 commit、禁止 push 与发布；同时用 record_decision 落了 ADR-009《编排闭环五段分工与 active_run_id 自愈指针》。未改源码，未 commit。

改动文件（1）: README.md

下一步: 重跑 npm run gate，确认 audit / quality / acceptance-cycle 全绿后再把 T-075 置 done；本轮不 commit：等心跳复核阶段决定是否提交

## 2026-10-27 — zcode

无人值守前提验证：CreateWorkflow 只读探针（dwfrun-5e0ee337）未卡确认、后台启动、完成通知正常送达——前提成立。目标换为循环内可判定验收（去掉发布到 npm）；旧心跳 automation-37cc9e0c 的 prompt 原位重写为五段式（拆卡→派发workflow→结束tick→复核→commit+record_round(end)），running 分支改为查 GetWorkflowRun 自愈，保留原 */5 schedule，未新建任务。注意：仓库处于 detached HEAD（心跳第5段已加护栏），开启编排前需先切回分支。

改动文件（2）: .pm/orchestrator.json, .zcode/workflow-drafts/无人值守启动探针.dwf.ts

下一步: 切回正常分支（当前 detached HEAD，commit 会丢失）；set_orchestrator(enabled:true, reason:...) 开启编排，观察前几轮五段式心跳是否按预期推进；若第2段派发 workflow 的脚本质量不稳，考虑把脚本沉淀为 saved workflow（SaveWorkflow）让心跳按名字派发

## 2026-10-27 — zcode

预算支持「不限」：max_rounds / max_hours 改为 nullable，null = 不限，此时只剩停滞（连续3轮无新证据）与连续失败（2次）两个进度型刹车。新增 budgetLabel 统一渲染，get_status/PROJECT.md/各工具文案一致显示「不限」。验证：npm run quality PASS（quality-20261027-044522-304，test/build/typecheck/coverage 四项全绿），全量 374 项通过。注意：当前运行的 MCP 进程仍是旧 schema，需重连后才能接受 null 参数。

改动文件（7）: src/orchestrator.ts, src/orchestrator-tools.ts, src/project-tools.ts, src/dashboard.ts, test/orchestrator.test.ts, PROJECT.md, .pm/quality-runs/quality-20261027-044522-304-0000.json

下一步: 重连 MCP 后调用 set_orchestrator(max_rounds:null, max_hours:null) 把本项目预算改为不限（当前运行进程仍是旧 schema，会拒绝 null）；观察心跳前几轮记录，确认拆卡与开轮按预期推进

## 2026-10-27 — zcode

按用户指定的参数建成自动编排心跳：每 5 分钟一次（*/5 * * * *），并发每轮 = min(随机3-8, 可认领任务数, 硬上限8)；任务数为 0 的 tick 只拆卡不开轮；连续无证据/连续失败自动退出；只本地 commit，禁止 push/发布。pm-mcp 侧把 max_concurrency 硬上限设为 8、max_rounds 预算提到 200 轮。心跳只读 get_orchestrator 决定开不开轮，禁止自改开关。

改动文件（2）: .pm/orchestrator.json, PROJECT.md

下一步: 观察前几轮心跳的台账记录（get_orchestrator 的最近记录），确认轮次记账与停滞检测按预期推进

## 2026-10-27 — zcode

首次真实调用新编排工具验证闭环：get_orchestrator 初始 no-goal（台账缺失=禁用）→ 两次违规调用均被拒（开关缺 reason；并发 9 被 schema 上限拒绝）→ set_goal 记录演示目标 → set_orchestrator 开启（并发 3）→ record_round begin/end 记账成功，重复 begin 被拒 → get_status 已显示「## 编排」段与 structuredContent.orchestrator。结论：开关、留痕、单轮互斥、预算推进、状态可见性全部经真实 MCP 调用生效。

改动文件（2）: .pm/orchestrator.json, PROJECT.md

下一步: 待用户确认后创建定时任务（每 30 分钟读 get_orchestrator，ready 才开轮），未创建前编排开关处于开启但无执行者；用 set_goal 覆盖演示目标为真实最终目标

## 2026-10-27 — zcode

M4 第一段落地：pm-mcp 成为「目标锚定 + 可开关编排 + 轮次记账」的被动驱动账本（ADR-008，控制流外置，仍不联网/不调模型/不唤起会话）。新增 src/orchestrator.ts（Goal/Settings/Run schema、fail-closed 读取：缺失=禁用、损坏=阻止写入且不覆盖、校验不截断、七种状态推导）与 src/orchestrator-tools.ts（set_goal/set_orchestrator/record_round/get_orchestrator，工具目录 54→58）；get_status 与 PROJECT.md 暴露编排状态。修两个真实缺陷：①toolW 自带账本锁不可重入导致编排工具全部 3s 超时（改走 toolI 并写明约束）②完成门禁选中外来质量报告（unit_root=E:\\通用型项目管理，目录已不存在）裸抛 ENOENT，改为跳过外来报告并给可读指引。验证：npm run gate PASS（quality-20261027-040236-550，test/build/typecheck/coverage 四项全绿），全量 373 项通过，orchestrator.ts 分支覆盖 96.59%。注：package-lock.json 的改动来自本会话开始之前，非本次改动。用户确认前不创建定时任务。

改动文件（22）: .pm/debuglog.json, .pm/features.json, .pm/roadmap.json, .pm/security.json, .pm/tasks.json, PROJECT.md, README.md, package-lock.json, src/dashboard.ts, src/project-tools.ts, src/task-evidence.ts, src/tools.ts, src/version.ts, test/management-upgrade.test.ts, .pm/decisions/ADR-008-ADR-008-编排分工定位：控制流外置，pm-mcp-只记账与发指令.md, .pm/quality-runs/quality-20261027-035320-448-0000.json, .pm/quality-runs/quality-20261027-035436-338-0000.json, .pm/quality-runs/quality-20261027-035546-974-0000.json, .pm/quality-runs/quality-20261027-040236-550-0000.json, src/orchestrator-tools.ts, src/orchestrator.ts, test/orchestrator.test.ts

下一步: M4 剩余：把「定时任务 + 短轮次」实际跑通一次（需用户确认后再建自动化，不在本会话范围内）；编排台账目前只在读取时 fail-closed；可考虑 audit_structure 增加「编排台账损坏/停滞」的显式告警节；dist 已重建（58 工具），发布前仍需 npm pack→SHA→publish-npm.yml 流程（沿用 0.6.0 已验证流程）

## 2026-10-20 — zcode

T-069 根治质量矩阵/gate 偶发 6-7 失败：根因是测试子进程继承发起方 PATH（服务端无 git），测试里 5 处裸 spawnSync("git") 全挂，与共享状态无关。测试改用共享 resolveGitCommand；gate 失败时打印摘录；报告持久化 output_excerpt。最小 PATH gate ×3 PASS、真实矩阵 352/352、全量测试全绿。

改动文件（9）: src/quality-store.ts, scripts/quality-gate.mts, test/exploit.test.ts, test/management-upgrade.test.ts, test/usage-log.test.ts, .pm/debuglog.json, .pm/tasks.json, .pm/quality-runs/quality-20261020-162704-148-0000.json, .pm/quality-runs/quality-20261020-162958-542-0000.json

下一步: git fallback 的 0.6.0 修复尚未随包发布（发布在 0.7.0 或下个补丁版：重建 dist→npm pack→更新 publish-npm.yml TARBALL/SHA→gh release→dispatch）；文件用途索引 33% 可继续提升；M3 Web UI 仪表盘（T-012）暂不排期

## 2026-10-20 — zcode

0.6.0 发布闭环完成：git ENOENT fallback（T-065）、update_task 报错带指引（T-066）、index.ts 拆分 52 行（T-067）、审计误报修复（T-068）、install.ps1 qoder 分支与版本修复（T-062）；npm 0.6.0 经 CI trusted publishing 上线（运行 39446179769），GitHub Release v0.6.0；M2 收口 30/30，功能 F-032/F-033、ADR-007 登记。

改动文件（21）: package.json, install.ps1, README.md, .github/workflows/publish-npm.yml, src/git-state.ts, src/task-evidence.ts, src/index.ts, src/resources.ts, src/prompts.ts, src/scan.ts, src/index-store.ts, test/realrepo.test.ts, test/management-upgrade.test.ts, PROJECT.md, .pm/tasks.json, .pm/roadmap.json, .pm/features.json, .pm/file-notes.json, .pm/decisions/ADR-007-输出行数预算显式设为-100（默认-150）.md, .pm/quality-runs/quality-20261020-151706-277-0000.json, .pm/snapshots/snap-20261020-151745.json

下一步: 重启客户端（/mcp reload）后重调 audit_structure：确认 skip/only 与空测试嫌疑清零、git 对账不再 ENOENT（当前残留来自运行中旧版服务进程，watcher 用旧逻辑刷新过索引）；观察 test/quality 子进程在 gate 环境的偶发抖动（矩阵/gate 偶报 6 失败但单跑全过，疑并发 .pm 状态争用），值得立任务排查；M3：Web UI 仪表盘（T-012）暂不排期；文件用途索引 33% 可继续提升；README 的 churn 热点（README 30 次/package.json 18 次）随会话自然衰减，不必立任务

## 2026-09-20 — qoder

修好 Qoder 多窗口共用常驻进程时项目根被启动期定格的缺陷（T-064）。取证：Qoder 只派生一个 stdio 子进程给所有窗口（pid 24452 自 09-19 22:55 存活，09-20 三个 session token 共用同一 server uuid），所有 run 日志目录名都是主进程 pid，所以 ADR-005 的 ppid 匹配不成立。改为按请求认领：新增 caller-workspace.ts 用「工具名+参数+紧时间窗」指纹倒扫会话日志拿 initial_cwd，tool-base 每次调用下发 RequestContext，54 个工具全部改用当次根；registrar 形参改名 startupRoot 让漏改编译不过。适配器不再伪造 --root，改传 PM_MCP_ROOT_HINT(_SOURCE)，root_source 不再永远报 --root；歧义时不猜并列出候选。get_status 的 structuredContent 补齐全量状态（Qoder 的 mcp_call 只呈现结构化载荷）。ADR-006 记录并标记 ADR-005 被取代。351 测试全过，quality gate PASS，并用 dist 真实派生 + 真实日志回放双重取证。

改动文件（15）: src/caller-workspace.ts, src/tool-base.ts, src/qoder-launch.ts, src/paths.ts, src/project-tools.ts, src/index.ts, src/governance-tools.ts, src/audit-tools.ts, src/knowledge-tools.ts, src/acceptance-tools.ts, src/task-tools.ts, test/caller-workspace.test.ts, test/qoder-launch.test.ts, .pm/decisions/ADR-005-Qoder-项目根解析：按-ppid-匹配会话运行日志，而不是钉死---root.md, .pm/decisions/ADR-006-Qoder-项目根改为按请求认领：常驻子进程被所有窗口共用，ppid-与启动期-.md

下一步: 用户重启 Qoder 或 /mcp reload 后，在 unified-ai-system 窗口重调 get_status，确认 root 指向该仓库、root_source=qoder-session-log(request-match)、且返回带里程碑/焦点/健康段；T-062：把本次修复随下个版本发到 npm（已发布的 0.5.0 不含按请求认领），并给 install.ps1 补 qoder 分支；评估要不要给非启动根的工作区也预热 watcher/SQLite 索引（目前其他工作区首次 audit/search 走全量走查，正确但慢）；把「跑 npm run quality 期间不要并发写 .pm/」写进贡献者须知：本次第一次跑 gate 就是被并发账本写入弄成 test 失败（重跑即全绿）

## 2026-09-19 — 未知

T-063 Qoder 客户端接入：工作区提示解析 + qoder-launch 适配器：Qoder 真实派生的新会话已实测通过：新建独立会话调用 mcp__pm_mcp__get_status 返回 root=E:\通用型项目管理、root_source=--root、version 0.5.0，证明用户级一条配置（node .../dist/qoder-launch.js，不带 --root）在 Qoder 里能起服务并把项目根钉到当前工作区。换工作区验证同一条配置：QODER_WORKER_CWD 指向 unified-ai-system 时 root 随之切换，各工作区各归各账本。当前这个会话需 /mcp reload 才会拿到连接。

## 2026-09-19 — qoder

把 pm-mcp 接入 Qoder 做成受支持能力：根解析支持客户端工作区提示与未插值占位符防护，新增 qoder-launch 适配器 + launch 子命令，setup/doctor 支持 --client qoder，并用真命令把用户级配置改写为一条不钉根的适配器条目；配套 11 个用例与 README 章节。

改动文件（12）: src/paths.ts, src/qoder-launch.ts, src/index.ts, src/project-tools.ts, src/setup.ts, src/setup-project.ts, src/doctor.ts, src/cli.ts, test/qoder-launch.test.ts, test/setup.test.ts, test/tooling-coverage.test.ts, README.md

下一步: Qoder 里 /mcp reload 后调用 get_status 复核项目根与依据（预期 E:\通用型项目管理、依据 --root），确认后 T-063 置 done 并补 verification；T-062：发布含 launch/--client qoder 的版本，并给 install.ps1 补 qoder 分支；可选：把 qoder-launch 的解析依据也接进 audit_structure/usage-log 便于跨机诊断

## 2026-09-19 — 未知

T-063 Qoder 客户端接入：工作区提示解析 + qoder-launch 适配器：代码/测试/文档/真机配置全部落地：coverage 336 通过、doctor --client qoder 返回 ok:true 且 root 正确、用户级配置已由 setup --client qoder --local 写成 dist/qoder-launch.js 一条（其他 server 保留，写前有备份）。

下一步: 在 Qoder 里执行 /mcp reload，调用 get_status 核对项目根与解析依据（预期 root=E:\通用型项目管理、依据 --root）；若依据为 cwd，则说明 Qoder 的 MCP 子进程 ppid 与运行日志目录的 -p<pid> 不对应，据此再改适配器解析顺序。

## 2026-09-19 — zcode

完成 T-055：changedGitFiles/gitAudit 现在尊重项目级 scan_ignore，补充忽略路径、规则清空恢复及普通源码保留的回归测试；typecheck 与 325 项全量测试通过。

改动文件（2）: src/git-state.ts, test/management-upgrade.test.ts

下一步: M2 余下 T-008/T-011/T-012 可继续规划实施；T-055 已闭环。

## 2026-09-19 — 未知

T-055 git 对账应尊重 project.json scan_ignore（客户端运行时目录不再误报）：完成：git 对账现在读取 project.json 的 scan_ignore，并按文件自身及父目录过滤变更；重命名两端同样生效。新增回归验证忽略运行时嵌套文件、保留普通源码、清空规则后恢复检测。

改动文件（2）: src/git-state.ts, test/management-upgrade.test.ts

下一步: 无；T-055 已完成并通过定向及全量验证。

## 2026-09-19 — 未知

T-055 git 对账应尊重 project.json scan_ignore（客户端运行时目录不再误报）：已从工作日志恢复，确认缺口是 gitAudit/changedGitFiles 未消费 scan_ignore；准备实现并补测。

改动文件（2）: src/git-state.ts, test/management-upgrade.test.ts

下一步: 修改 src/git-state.ts 并新增管理升级回归测试。

## 2026-09-19 — 未知

0.5.0 发布完成：a72240d 版本+pin（sha 5428a7ac）→Release v0.5.0 资产（重打包确定性一致）→validate+publish 双 dispatch 全绿（核验轮询正常）→npm latest=0.5.0→冷安装自探 53 工具含 search_code_public。内容：search_code_public 版权溯源 + OSV lockfile 误报修复。台账 S-0059。

改动文件（3）: .github/workflows/publish-npm.yml, package.json, package-lock.json

下一步: 各宿主可选升级 npx @luckychen1993/pm-mcp@0.5.0 或保持钉根 dist；M2 完成后可规划 M3（或收尾 v2 增强）

## 2026-09-19 — 未知

完成 T-009/T-061/F-028：search_code_public 公开代码反查（GitHub Code Search 词项 AND；grep.app 因 Vercel 反机器人弃用并记录；confirm=z.literal(true)+片段参数内可见的双重门控；凭据链 env→gh auth token；401/403/422 可行动错误）。契约 52→53。真网两连验证（独特行 0 命中/公开行 8 命中，跨项目同名常量碰撞实证）。全量 323/323（quality-20260919-053505）。仓库外：E:\\Codex\\.codex\\config.toml 增 search_code_public 条目。至此 M2 backlog 全部清零。

改动文件（6）: src/public-search.ts, src/audit-tools.ts, src/version.ts, test/public-search.test.ts, test/integration.test.ts, README.md

下一步: 0.5.0 发布可随时走已验证流程（打包→资产→pin→dispatch）；search_code_public 如需语义级相似度可再议 Sourcegraph v7 或本地 embedding 方案

## 2026-09-19 — 未知

T-059 收口（结论反转：两条 GHSA 均为误报，实装版本已过修复线；根因=范围串发给 OSV 被解析到边界下；修复=npm 按 lockfile 实装版本查询，复扫 11/11 归零，fe83493）。0.4.0 发布全链路成功：21fb107 版本+pin→Release v0.4.0 资产 sha 一致（0bca3ece）→validate+publish 双 dispatch 全绿→npm latest=0.4.0→冷安装自探 52 工具齐。T-009 立项并完成选型调研（推荐 grep.app confirm 门控起步，代码片段外发边界需用户确认）。

改动文件（5）: src/osv.ts, test/osv.test.ts, .github/workflows/publish-npm.yml, package.json, package-lock.json

下一步: T-009 待用户拍板服务选型（推荐 grep.app 适配器起步）；各宿主可选升级到 npx @luckychen1993/pm-mcp@0.4.0

## 2026-09-19 — 未知

完成 T-012/T-060/F-027：pm-mcp ui 本地只读 Web 仪表盘（零依赖 node:http，127.0.0.1 only，SSR + /api/state + /healthz，全插值 HTML 转义 + CSP 禁脚本，未纳管 fail-closed，SIGINT 优雅关闭）；CLI 冒烟通过；317/317（quality-20260919-043548）。不新增 MCP 工具（目录保持 52）。至此 M2 backlog 可实现项全部完成，仅剩 T-009 待用户选型。

改动文件（4）: src/ui.ts, src/cli.ts, test/ui.test.ts, README.md

下一步: T-009 版权相似度：唯一剩余 backlog 项，需用户选定外部服务后再动工；0.4.0 发布：本轮 4 个提交（3 新工具 + ui 子命令）待打包发布；T-059：升级 SDK/zod 消除 OSV 命中

## 2026-09-19 — 未知

完成 T-008/T-058/F-026：audit_osv 联网漏洞查询（confirm=z.literal(true) 显式门控，只发包名/版本/生态，querybatch 100/批，fetcher 注入全 mock 测试），契约 51→52。真网首跑命中本仓 2 条 GHSA（SDK/zod），登记 T-059 处置。全量 313/313（quality-20260919-041919）。仓库外：E:\\Codex\\.codex\\config.toml 增 audit_osv 条目。

改动文件（6）: src/osv.ts, src/audit-tools.ts, src/version.ts, test/osv.test.ts, test/integration.test.ts, README.md

下一步: T-059：升级 @modelcontextprotocol/sdk 与 zod 消除 OSV 命中；T-012 Web UI 仪表盘（backlog 最后一个可实现项）

## 2026-09-19 — 未知

完成 T-011/T-057/F-025：零依赖行指纹重复代码检测（注释剥离/字符串占位/空白归一化，64-bit 指纹滑窗，成对连续对齐合并），find_duplicates 工具 + 契约 50→51。dogfood 检出本仓 audit.ts↔governance-audit.ts 真实 8 行重复。全量 307/307（quality-20260919-032302）。仓库外：E:\\Codex\\.codex\\config.toml 增 find_duplicates 条目。

改动文件（5）: src/duplicates.ts, src/audit-tools.ts, src/version.ts, test/duplicates.test.ts, README.md

下一步: T-008 OSV 联网漏洞查询（默认关，需设计 flag 门控）；T-012 Web UI 仪表盘；T-009 版权相似度需外部服务选型，待用户决策

## 2026-09-19 — 未知

M2 backlog 动工：完成 T-010/T-056/F-024——SemanticGraph.fileCycles（Tarjan 复用）、audit_governance file-cycle 警告、dependency_graph 工具（摘要/环/枢纽/聚焦 BFS 邻域，foldLines 折叠）、契约 49→50 且全部测试断言改用 TOOL_CATALOG_SIZE 常量（upgrade-030 三处硬编码一并消灭）；README/Codex config 同步。验证：301/301（quality-20260919-030433）+ probe 实测 50 工具 + 巡检探针绿。仓库外：E:\\Codex\\.codex\\config.toml 增 dependency_graph 条目。

改动文件（9）: src/semantic-graph.ts, src/governance-audit.ts, src/governance-tools.ts, src/version.ts, test/semantic-graph.test.ts, test/integration.test.ts, test/realrepo.test.ts, test/upgrade-030.test.ts, README.md

下一步: T-011 重复代码检测（下一个动工项）；T-008 OSV 联网查询（默认关）；T-012 Web UI 仪表盘

## 2026-09-19 — 未知

0.3.0 发布完成：用户配置 npm Trusted Publisher 后重发 publish=true，OIDC 发布成功（ Publish 步 success）；工作流核验步因 registry CDN 复制延迟误报 404，已改 180 秒轮询（223cec0 已推送）。registry 实证：latest=0.3.0、integrity 与验证过的 tarball 一致（Fzrco6lOPFvhx…）；冷安装 @0.3.0 并用其自带 probe 自探 49 工具全通过。记忆已更新。

改动文件（1）: .github/workflows/publish-npm.yml

下一步: 各宿主按需切换到 npx @luckychen1993/pm-mcp@0.3.0（本地钉根 dist 的安装不受影响）；T-008~T-012 等 M2 backlog 待排期

## 2026-09-19 — 未知

三件事执行：①推送 3 个提交（e910ca0/42c0e5a/e307ab6）到 origin main，CI 双节点全绿。②npm 0.3.0 发布：重打包并替换 Release v0.3.0 资产（d01d8603…含 probe），工作流重 pin 哈希，publish=false 验证跑全绿（OIDC 声明/SHA/干跑全对），publish=true 真发失败 ENEEDAUTH——官方文档确认这是 npm 网站侧 Trusted Publisher 未配置/不匹配的标准报错，待用户在 npmjs.com 配置（仓库外变更：GitHub Release 资产）。③工具目录探针接入 health-check（TOOL_CATALOG_SIZE 单一事实来源 + probe env 沙箱支持），真跑巡检绿，298/298（quality-20260919-022756），F-023 已登记。

改动文件（7）: src/version.ts, src/doctor.ts, src/probe.ts, scripts/health-check.mts, test/probe.test.ts, test/fixtures/raw-mcp-server.mjs, .github/workflows/publish-npm.yml

下一步: 用户在 npmjs.com 为 @luckychen1993/pm-mcp 配置 Trusted Publisher（happy520ai/pm-mcp + publish-npm.yml + 环境留空）后，gh workflow run publish-npm.yml -f publish=true 重发；工作流自带完整性核验；Codex 侧新的 output_token_limit 条目在重开会话后生效

## 2026-09-19 — 未知

「全部解决修复」收尾：①用 codex app-server mcpServerStatus/list 实证三宿主均全量暴露 49 工具，更正上轮「23 个不可见」误判（tools.X 子段是 output_token_limit 覆盖非过滤器）；为 Codex config.toml 补齐 23 个缺失工具的 output_token_limit 条目（备份 config.toml.backup-before-tools-49-20260919-095205，tomllib 校验过，名字与服务器 49/49 对齐）。②WorkBuddy/ZCode 配置核对无过滤。③把语义证据特性与 probe 特性分两个提交落账。仓库外变更：E:\\Codex\\.codex\\config.toml。

改动文件（7）: src/doctor.ts, test/upgrade-030.test.ts, src/probe.ts, src/cli.ts, test/probe.test.ts, test/fixtures/raw-mcp-server.mjs, README.md

下一步: T-051 safe-delete 钩子方向仍未选（需用户拍板）；npm 发布 0.3.0 待可信发布通道解决后再推（delivery 副本已含 49 工具目录）

## 2026-09-19 — 未知

根治「宿主不提供标准 raw tools/list」：新增 pm-mcp probe 子命令（T-053/F-022），SDK client 直连任意 stdio MCP 服务器取原始 tools/list 并支持 expect 基线比对；真实验收列出 49 工具、对 Codex allowlist（26 个）比对 missing 0/extra 23。顺带修复并行会话造成的工具契约漂移 48→49（T-054：doctor/upgrade-030 测试/README），全量测试 297/297 全绿（正式报告 quality-20260919-014142-253-0000.json）。未提交任何 git 提交。

改动文件（7）: src/probe.ts, src/cli.ts, test/probe.test.ts, test/fixtures/raw-mcp-server.mjs, src/doctor.ts, test/upgrade-030.test.ts, README.md

下一步: 决定是否把 Codex config.toml 的 pm-mcp allowlist 从 26 个扩充（当前 23 个工具对 Codex 不可见），改完用 pm-mcp probe --expect 复核；并行会话遗留的语义证据未提交改动（semantic-* 文件）仍待处置；本次已把其工具契约（49）补齐；T-051 safe-delete 钩子方向仍未选

## 2026-09-19 — 未知

诊断「当前活动 MCP 宿主仍未提供标准 raw tools/list」：确认为宿主架构使然而非配置故障。排查了 pm-mcp 代码、共享目录、codex中间层对照验证、统一网关证据与 Codex 历史会话，溯源到 2026-09-07 Cursor 3.19.13 宿主验收会话；Cursor 仅有内部 IPC mcp.listToolsRaw 非公开 API，Codex app-server 用私有 mcpServerStatus/list，ZCode 只注入翻译后的函数 schema。未改任何文件。

下一步: 如需标准 raw tools/list 响应：仿照 v6/mcp-observer.mjs 写一个直接 spawn pm-mcp 服务器进程的主动 stdio MCP client 探针（initialize → tools/list）；Codex 侧宿主暴露面继续用 app-server 的 mcpServerStatus/list 枚举

## 2026-09-17 — workbuddy

接手并行会话遗留的 src/dashboard.ts 改动并验证提交。该改动把仪表盘的漂移对账统一到 audit.ts 的 detectDrift，口径由「仅 implemented 功能的 entry_files」扩为「功能入口文件 + done 任务关联文件」，消除 dashboard 与 audit_structure 两处口径不一致。验证：重建 dist、tsc --noEmit 干净、dashboard.test.ts + realrepo.test.ts 10/10 通过，提交 8892eb5 并推送，CI（Node 22.18/24）全绿。同时排查了「同步更新 GitHub 时出现死循环」：源头是另一会话（工作区在 E:/AI-Data/AI网关系统/unified-ai-system）跨项目反复操作本仓库（931 次 Bash、49 轮重复 get_status/get_roadmap/list_tasks，会话日志 36MB），该会话现已停止；其遗留的 dist.bak-20260917T2226/ 与 .tmp-test-full-20260917.log 已由其自行移除，本仓库 git status 归零。远程 main = 本地 HEAD = 8892eb5。

改动文件（1）: src/dashboard.ts

下一步: T-051（safe-delete 钩子拦截 pm-mcp 幂等记录清理）仍未处置，三个方向待选；跨项目操作时不要依赖 pm-mcp 的 cwd 推断，建议在目标项目会话内操作

## 2026-09-17 — workbuddy

将本地 0.3.0 候选合并远程 v0.1.5 历史并推送到 GitHub main（4557cea → 13fec02，4 个提交）。本地 HEAD 原为远程祖先、工作区含 0.3.0 全部未提交工作：先分两个提交固化（feat: 0.3.0 任务分页/证据分级/WorkBuddy 客户端；chore: 账本与验收证据），再 merge origin/main。12 个冲突文件全部取本地，并逐一核验远程独有内容均为 0.1.5 旧实现（旧版本号、_TRUNCATED_ 截断逻辑、旧 setup.ts 无 WorkBuddy/无 version.ts 抽取），确认本地 0.3.0 已取代；合并额外引入远程的 .github/workflows/publish-npm.yml。全量 287 项测试 286 通过；唯一失败的「真实 PROJECT.md 与状态同步」经 regenerate_dashboard 修复后 realrepo 7/7 通过。类型检查与构建通过。已 push。

改动文件（13）: package.json, package-lock.json, README.md, install.ps1, PROJECT.md, .github/workflows/publish-npm.yml, src/setup.ts, src/index.ts, src/tool-base.ts, src/project-tools.ts, src/agents-md.ts, test/setup.test.ts, .pm/changelog.md

下一步: 等待 CI（run 35231890524）结果；若失败优先看 coverage 门槛；如需正式发布 0.3.0：统一 README 示例版本号、打 v0.3.0 tag、再走 publish-npm 工作流

## 2026-09-13 — zcode

修复到清零会话：T-034/T-045 根治（SCAN_IGNORE_DIRS 增补 10 个运行时/缓存目录；touchRegistry 温目录跳过+大小写去重；quality-gate 测试补沙箱；真实注册表 74→3）；修复 update_task type 字段 schema-handler 失配 bug；网关项目（跨仓库，改动已记其自身账本）元数据补全+首拍快照+安全台账 577 条全闭环；积压任务 7 项全部事实核销

改动文件（7）: src/scan-policy.ts, src/registry.ts, src/task-tools.ts, test/quality-gate.test.ts, .pm/tasks.json, .pm/sessions.json, .pm/security.json

下一步: 观察下一轮巡检应全绿；网关 WIP 15 个 in_progress 建议收敛；文件用途索引从核心模块建起

## 2026-09-11 — workbuddy

覆盖率补口与复核：为 localProjectLaunch 补直接单元测试（此前唯一未覆盖的本次新增代码），setup.ts 覆盖率升至 line 83.04% / branch 68.55% / funcs 80.95%（funcs +4.76）；此时未覆盖行全部为既有的 --help、commandExists、appendCodexConfig、configureCliClient 等路径。doctor.ts line 98.2%、setup-project.ts line 100%。setup+upgrade-030 共 38 项通过。注：单文件覆盖率是只跑安装器测试的抽样值，不代表 CI 的全局门槛。

改动文件（1）: test/setup.test.ts

下一步: 在 WorkBuddy「连接器管理 → 自定义连接器」中信任 pm-mcp，重开会话用 get_status 核验运行版本；发布 0.3.0 前跑完整 npm run coverage 确认全局门槛（沙箱内 3 项环境测试必失败，无法给出可信的全量覆盖率）；README 第 71 行「本页安装示例固定使用 0.1.5」与主示例的 @latest 措辞不一致，发布前统一

## 2026-09-11 — workbuddy

修复 auto 模式收尾提示退化并复核：setup 在多客户端同时配置时改为逐条列出各自的重连/授权要求（此前只要 selected 含 workbuddy 就只提 WorkBuddy，配置了 codex 等 5 个客户端时提示误导）；补多客户端提示测试。重新构建 dist，setup+upgrade-030 共 37 项通过，install.ps1 解析 OK，CI 配置无需改动（不涉及客户端分支）。覆盖率抽样：doctor.ts line 98.2%、setup-project.ts line 100%、setup.ts line 82.5%（未覆盖行多为既有的 codex/claude/vscode 分支，非本次引入）。

改动文件（2）: src/setup.ts, test/setup.test.ts

下一步: 在 WorkBuddy「连接器管理 → 自定义连接器」中信任 pm-mcp，重开会话用 get_status 核验运行版本；发布 0.3.0 前跑完整 npm run coverage 确认全局门槛（沙箱内 3 项环境测试必失败，无法给出可信的全量覆盖率）；README 第 71 行「本页安装示例固定使用 0.1.5」与主示例的 @latest 措辞不一致，发布前统一

## 2026-09-11 — workbuddy

收尾 WorkBuddy 接入：跑通 pm-mcp 自带巡检并消除两处自造红旗（临时脚本 .tmp-*.mjs 触发 javascript 未声明语言、巡检输出文件触发未入账变更）；.gitignore 增加 .workbuddy-ai/（与既有 .zcode/ 同类工具工作区目录，否则每次 memory 写入都会产生未入账变更）；补充边界测试：WorkBuddy 检测的 5 种入口条件、doctor 对缺失文件/坏 JSON/args 非数组/缺 command 的 fail-closed 及「已带 --root 不重复追加」。setup+upgrade-030 共 36 项通过，巡检无红旗。

改动文件（3）: .gitignore, test/setup.test.ts, test/upgrade-030.test.ts

下一步: 在 WorkBuddy「连接器管理 → 自定义连接器」中信任 pm-mcp，重开会话用 get_status 核验运行版本；发布 0.3.0 前确认 README 的 WorkBuddy 示例版本号与 registry 一致

## 2026-09-11 — workbuddy

接入 WorkBuddy 客户端并核验：setup --client workbuddy 写入标准 mcp.json（数据目录按 WORKBUDDY_CONFIG_DIR → ~/.workbuddy-ai → ~/.workbuddy 解析；写前备份、保留未知字段与既有 server），刻意不钉 --root——WorkBuddy 以会话工作区作为 MCP 子进程 cwd，服务端按 cwd 解析项目根，因此一条配置服务所有工作区；doctor --client workbuddy 读该配置并补 --root 做真实握手。本机已用 --local 绑定 E 盘构建入口，doctor 核验 48 工具 / 0.3.0 / 根正确；以工作区为 cwd 的模拟启动确认根解析正确，未初始化目录只返回错误且零写入。类型检查、构建与 setup/upgrade-030 测试（34 项）全通过；全量 283 项中 3 项失败均为沙箱环境限制（符号链接被禁、nul.ts 保留名被 fs shim 拦截、20 进程抢锁超时），三个失败文件均不引用本次改动模块。

改动文件（8）: src/setup.ts, src/doctor.ts, src/setup-project.ts, src/cli.ts, test/setup.test.ts, test/upgrade-030.test.ts, README.md, install.ps1

下一步: 在 WorkBuddy「连接器管理 → 自定义连接器」中信任 pm-mcp，重开会话用 get_status 核验运行版本；考虑把 workbuddy 纳入 CI 与发布走查清单

## 2026-09-09 — codex

核对网关项目 pm-mcp 调用开销与触发规则：保留601次业务调用，服务端平均325ms、中位81ms；get_status89次平均66ms，search_code205次平均788ms。全局及网关AGENTS要求开工/收工闭环，但缺少纯咨询和同任务连续追问的豁免；提出按实际工作节点触发。未修改产品代码、网关规则或配置，计量无轮次ID，不能据此推算每轮对话额外耗时。

## 2026-09-08 — codex

T-049 0.3.0 升级：版本生效检查、任务分页与证据分级：前三项升级已交付0.3.0：有界分页/结构化结果、完成证据分级、版本核验与受控升级。保持48工具、7资源和5提示。完整276测试及覆盖率通过，安装包冷启动通过；本机配置已绑定E盘固定安装目录，独立doctor核验0.3.0及正确root。配置其余字节受保护，旧会话保留；既有Codex会话须重连后再次核验，未推送或发布。

改动文件（28）: package.json, package-lock.json, README.md, install.ps1, src/cli.ts, src/dashboard.ts, src/doctor.ts, src/governance-tools.ts, src/index.ts, src/language-adapters.ts, src/project-tools.ts, src/quality-evidence.ts, src/quality-store.ts, src/setup-project.ts, src/setup.ts, src/task-evidence.ts, src/task-pagination.ts, src/task-tools.ts, src/tool-base.ts, src/types.ts, src/version.ts, test/exploit.test.ts, test/integrity.test.ts, test/quality-evidence.test.ts, test/upgrade-030.test.ts, scripts/acceptance-cycle.mts, scripts/acceptance-target.mts, scripts/create-pm-acceptance-evaluation.mts

## 2026-09-08 — codex

T-047 0.3.0 正式验收基线升版与重新评价：新1.1.0基线已按直接开工授权采用并在验证前批准；原1.0.0字节摘要未变。0.3.0隔离副本完整质量通过，正式第一方本地评价33/33要求与33/33评价测试通过，8/8风险受控、5/5阶段完成；旧失败保留，远程发布未执行。

改动文件（7）: package.json, scripts/acceptance-target.mts, scripts/acceptance-cycle.mts, scripts/create-pm-acceptance-evaluation.mts, .pm/acceptance/baselines/pm-mcp-local-release/1.1.0.json, .pm/acceptance/evidence/pm-mcp-local-release-1.1.0-plan.md, .pm/acceptance/evidence/pm-mcp-local-release-1.1.0-first-failure.md

## 2026-09-08 — codex

完成pm-mcp深度研究，交付7页PDF。未改产品代码；提出版本生效与验收衔接、任务分页/结构化结果、完成证据分级、任务依赖、条件性桌面常驻与小型指标。两项隔离实验确认边界；官方资料与本地证据交叉核验。

下一步: 优先审阅PDF并明确下一轮实施范围；T-047正式基线仍待批准。；此前桌面面板常驻请求仍需确认具体程序入口；系统启动配置尚未修改。

## 2026-09-07 — codex

T-046 极简项目管理升级：准确对账、合并操作与完成证据：三项验收条件均已实现并验证：多会话内容对账与扫描边界、一次更新合并断点/会话、完成绑定当前源码真实报告。保留48工具；最终隔离263测试与263覆盖率均通过，构建/类型检查通过；当前项目12项通过；最终tarball空目录安装与真实MCP闭环通过。正式旧基线32/33通过，工具数46与48冲突转T-047跟进；本候选未发布且当前客户端未切换。

改动文件（31）: package.json, package-lock.json, README.md, install.ps1, src/agents-md.ts, src/audit.ts, src/index-db.ts, src/index-store.ts, src/index.ts, src/knowledge-tools.ts, src/language-adapters.ts, src/license.ts, src/project-fingerprint.ts, src/project-tools.ts, src/scan.ts, src/search.ts, src/security.ts, src/setup.ts, src/task-tools.ts, src/types.ts, test/exploit.test.ts, test/helpers.ts, test/idempotency-lease.test.ts, test/integration.test.ts, test/scenario.test.ts, test/tooling-coverage.test.ts, src/git-state.ts, src/scan-policy.ts, src/session-log.ts, src/task-evidence.ts, test/management-upgrade.test.ts

下一步: T-047审核并批准新的48工具基线后重新正式验收；T-045需在原触发项目配置并复验产物排除；发布/客户端切换尚未执行。

## 2026-09-07 — codex

评估后续调优空间，未改产品代码。确认Git对账只比较最后一次会话、feature/fix缺verification仍可done；建议优先减少重复管理调用、降低对账/扫描噪音、增强完成证据和阻塞分类，再用对照测试衡量性能/token估算。当前保留111调用平均87ms，折叠节省记录0；不能据此承诺账户额度节省。

改动文件（3）: .pm/sessions.json, .pm/changelog.md, PROJECT.md

下一步: 若推进下一版，先复核并修复对账/扫描边界，再优化默认管理流程，保留完整能力和简单使用方式。

## 2026-09-07 — codex

完成npm 0.1.5同步：经用户明确授权和本人安全密钥验证，临时绑定GitHub OIDC；PR#2已合并，固定制品验证预演和正式发布工作流均成功。npm version/latest=0.1.5，公开全新缓存安装真实MCP验证通过，tarball与GitHub SHA256一致。已移除临时连接并获网页回执；GitHub Release说明和本地README状态已更新，T-043/T-033闭环。

改动文件（6）: README.md, .pm/project.json, .pm/tasks.json, .pm/sessions.json, .pm/changelog.md, PROJECT.md

下一步: 本次GitHub/npm发布完成；临时发布授权已撤销，当前没有待执行的发布步骤。

## 2026-09-07 — codex

核验用户已打开的npm包页面，确认当前版本0.1.4；包设置入口由npm要求二次验证。已选择网站提供的密码确认方式，未修改安全设置；等待用户在网页完成密码确认，未读取密码或发布新版本。

改动文件（4）: .pm/tasks.json, .pm/sessions.json, .pm/changelog.md, PROJECT.md

下一步: 网页完成密码确认后继续检查可用发布方式及CLI认证，完成已授权的0.1.5 npm同步。

## 2026-09-07 — codex

直接核验用户指定npm后台：网站登录确实有效，包仍0.1.4；未把网站登录和CLI发布验证混为一谈。已停止过期CLI尝试，保留用户后台页面；后续仅需确认可用安全密钥并完成本人2FA，不再反复请求首页登录。

改动文件（4）: .pm/tasks.json, .pm/sessions.json, .pm/changelog.md, PROJECT.md

下一步: 确认npm账号绑定的通行密钥/安全密钥是否可用，再继续有效CLI登录和已授权发布。

## 2026-09-07 — codex

继续处理npm同步。核对默认npm用户配置和兼容新版CLI后，浏览器明确显示账号已登录但停在安全密钥双因素验证。已启动验证入口并保留交接页面；CLI仍等待网页回调，尚未发布。不读取密码/PIN/令牌，等待用户完成本人安全密钥确认。

改动文件（4）: .pm/tasks.json, .pm/sessions.json, .pm/changelog.md, PROJECT.md

下一步: 完成npm安全密钥验证后发布，不再重复请求发布授权或首页登录。

## 2026-09-07 — codex

继续同步npm：再次核对最终包与GitHub附件一致；旧npm配置E401，默认网页登录回退legacy后已取消，改用独立受保护配置成功发起官方web CLI登录。网站账号登录尚未形成CLI登录，当前ENEEDAUTH，仍等待新页面确认；未发布npm，授权无需重复。

改动文件（4）: .pm/tasks.json, .pm/sessions.json, .pm/changelog.md, PROJECT.md

下一步: 用户完成当前CLI网页登录后直接继续npm发布和registry/公开安装验证。

## 2026-09-07 — codex

核验发现v0.1.5此前仍为GitHub草稿，依据既有明确发布授权已完成正式公开发布。读回draft=false/prerelease=false，published_at=2026-09-07T08:00:17Z；附件SHA256与已验证最终包一致。GitHub发布不再依赖npm登录；npm上架仍单独待完成。

改动文件（4）: .pm/tasks.json, .pm/sessions.json, .pm/changelog.md, PROJECT.md

下一步: 只剩npm发布：恢复登录后继续，不重复创建GitHub Release。

## 2026-09-07 — codex

按用户要求直接更新GitHub仓库：合并PR#1至main3273aee，合并文件树与已验证43b89f9完全一致；主分支托管CI34097925292的Node22.18/24均通过。本地工作区未切换/拉取/清理，已有修改与HEAD保留。

改动文件（4）: .pm/tasks.json, .pm/sessions.json, .pm/changelog.md, PROJECT.md

下一步: GitHub main更新已完成。npm发布单独由T-043跟踪，仍等待登录恢复。

## 2026-09-07 — codex

按明确授权执行0.1.5发布：独立克隆推送发布分支和PR#1，首轮Linux CI失败暴露备份重名并已修复，43b89f9在Node22.18/24托管CI全通过。最终包上传GitHub草稿并读回digest一致，隔离安装真实MCP通过。npm登录持续E401，未上架npm，也未把草稿当正式发布；授权已记录，等待用户网页登录。

改动文件（12）: src/project-tools.ts, src/paths.ts, src/setup.ts, test/integration.test.ts, test/usage-log.test.ts, test/setup.test.ts, .pm/.gitignore, .pm/tasks.json, .pm/debuglog.json, .pm/sessions.json, .pm/changelog.md, PROJECT.md

下一步: 恢复npm登录后直接发布最终已核验0.1.5 tarball并做registry/公开冷安装回验，再发布GitHub草稿。发布授权无需重复索取。

## 2026-09-07 — codex

完成T-042本地修复：安全扫描证据约束/落账指纹复核、项目唯一服务键与root核对、rg字面量参数。准备0.1.5候选，253测试及coverage通过，冷安装包真实MCP与两中文项目setup通过；未发布或升级真实客户端。完整报告与原始失败证据保存于Temp/pm-fix-T042-265c516deef94752973133e760545195。

改动文件（17）: src/security.ts, src/search.ts, src/setup.ts, src/index.ts, test/security.test.ts, test/search.test.ts, test/setup.test.ts, package.json, package-lock.json, install.ps1, README.md, .pm/tasks.json, .pm/debuglog.json, .pm/sessions.json, .pm/changelog.md, PROJECT.md, .pm/quality-runs/quality-20260907-054702-793-0000.json

下一步: T-033：0.1.5发布、托管CI与真实客户端升级需要后续明确授权。；本轮未做完整全仓安全扫描及完整acceptance/20GiB门禁，不将局部修复外推为绝对零漏洞。

## 2026-09-07 — codex

核验pm-mcp真实可用性：242测试/typecheck通过、npm audit 0，但复现安全跳扫误关闭、中文项目命名碰撞、字面量rg选项误解析，并确认npm发布包缺setup --project。完成部分安全报告，未改产品源码；未完成全仓安全逐行覆盖、完整gate、托管CI或跨客户端验证。

改动文件（4）: .pm/tasks.json, .pm/sessions.json, .pm/changelog.md, PROJECT.md

下一步: 按报告修复3处已复现缺陷并增加针对性回归测试。；T-033继续处理新版发布与冷安装/托管CI；本次不发布。；若要断言全部功能可靠，继续剩余安全源码审查与客户端验收；实际节省额度需对照实验。

## 2026-09-06 — codex

按你的“1和2”同时执行：1）执行了冷安装命令 `npx -y @luckychen1993/pm-mcp@latest setup --client codex --project`；2）把结果回填到 pm-mcp 任务台账。结果：当前版本分发只到 0.1.4，命令返回 `unknown setup argument: --project`，步骤4仍阻塞。

改动文件（2）: E:/PM/unified-ai-system/N/A, pm 任务台账 T-033

下一步: 请在 pm-mcp 仓库发布 `setup --project` 支持的新版本并更新 `@luckychen1993/pm-mcp`；重跑 `npx -y @luckychen1993/pm-mcp@latest setup --client codex --project`，确认生成 `.pm/project.json`；完成托管CI 冷安装回归（`github actions` 的相关 step）并回写 `T-033`

## 2026-09-06 — codex

完成复现与阻塞闭环：确认 `@luckychen1993/pm-mcp` 当前仅有 0.1.1-0.1.4；旧版 0.1.4 不识别 `setup --project`。当前任务 T-033 已置于 blocked，`T-033` 下一步为发布 0.1.5 并回归冷安装。

改动文件（1）: N/A

下一步: 发布 pm-mcp 0.1.5（包含 setup --project/--client 参数）；在 unified-ai-system 根目录执行 `npx -y @luckychen1993/pm-mcp@latest setup --client codex --project` 验证

## 2026-09-05 — zcode

setup --project 上线：Codex 新项目一条命令自动钉定注册+初始化；realrepo 功能数断言改 >=；Codex 全局 AGENTS.md 升级自助纳管规则

改动文件（4）: src/setup.ts, test/setup.test.ts, test/realrepo.test.ts, README.md

下一步: npm publish 0.1.5 后，新项目才能真正用 npx @latest 跑通 --project（当前 npm 上是 0.1.4 无此参数）；watcher leader 事件接入运行日志（T-037 留下的候选）

## 2026-09-03 — zcode

实现使用日志 + 运行日志 + 省 token 统计：新增 src/usage-log.ts（JSONL 追加、1MB 轮转、绝不抛错），在 toolR/toolW/toolI 三包装器与资源读取统一挂载，budget.ts 折叠省量记账（drainFoldSavings），新工具 get_usage_log / get_runtime_log（工具数 46→48）

改动文件（10）: src/usage-log.ts, src/budget.ts, src/tool-base.ts, src/index.ts, src/paths.ts, src/project-tools.ts, test/usage-log.test.ts, test/integration.test.ts, test/realrepo.test.ts, README.md

下一步: 把 watcher leader 选举/接管/降级事件接入运行日志（index-store.ts / watcher-coordinator.ts 层）；考虑把使用日志的省 token 汇总摘要并入 PROJECT.md 仪表盘健康区

## 2026-09-03 — zcode

实现 init_project 自动写入 AGENTS.md 工作规矩（标记段幂等合并、不覆盖已有内容、可关），并应用到本仓库

改动文件（6）: src/agents-md.ts, src/init.ts, src/project-tools.ts, test/agents-md.test.ts, test/index-store.test.ts, AGENTS.md

## 2026-09-03 — codex

修复 v0.1.4 第二次托管 CI 首败：精确过滤 Node 22 node:sqlite ExperimentalWarning，任何其他 watcher stderr 仍严格失败。

改动文件（1）: test/watcher-leader.test.ts

下一步: 提交并重跑完整 gate 与 Node 22.18/24 CI

## 2026-09-03 — codex

修复 v0.1.4 托管 CI 首败：Linux 空 SQLite 选举事务增加实际 header 写以物化唯一写锁；watcher 测试仅统计成功创建的唯一 owner。

改动文件（2）: src/watcher-coordinator.ts, test/watcher-leader.test.ts

下一步: 提交后重跑完整本地 gate 并推送新的 Node 22.18/24 CI

## 2026-09-03 — codex

修复 v0.1.4 发布门禁首败：将 stale-lock 测试中的 secret-shaped 固定 token 改为运行时 UUID；保留 SEC-016 首次发现并由复扫自动关闭。

改动文件（1）: test/lock-stampede.test.ts

下一步: 提交门禁修复后从干净提交重新执行完整 gate

## 2026-09-03 — codex

完成多 Agent 读写与重复调用治理并发布 v0.1.3：全部读工具跨进程合并在途同参请求，全部写工具支持显式业务幂等和自动瞬时去重，同键参数冲突拒绝；修复长锁误抢与读缓存新鲜度，npm 双 Agent 冷启动实证同业务只落一次。

改动文件（22）: src/idempotency.ts, src/tool-base.ts, src/store.ts, src/index.ts, src/acceptance-tools.ts, src/audit-tools.ts, src/governance-tools.ts, src/knowledge-tools.ts, src/project-tools.ts, src/task-tools.ts, src/tools.ts, test/idempotency.test.ts, test/exploit.test.ts, test/integration.test.ts, test/integrity.test.ts, test/store.test.ts, test/tooling-coverage.test.ts, test/realrepo.test.ts, README.md, package.json, package-lock.json, install.ps1

## 2026-09-03 — codex

发布 pm-mcp v0.1.2 统一安装入口：一个 npx setup 命令自动检测五类 AI 编程客户端，支持备份、dry-run、force、显式客户端和通用 JSON；CLI/MCP 双路径分流，npm 冷启动与 GitHub 双版本 CI 均通过。

改动文件（10）: src/cli.ts, src/setup.ts, test/setup.test.ts, test/realrepo.test.ts, package.json, package-lock.json, README.md, install.ps1, src/index.ts, scripts/create-pm-acceptance-profile.mts

## 2026-09-03 — codex

发布 @luckychen1993/pm-mcp@0.1.1 到 npm Registry：启用发布账号 2FA，统一包名/版本与安装命令，完成本地 gate、双版本 GitHub CI、匿名 Registry 元数据和全新缓存 MCP 冷启动验证，并创建 GitHub v0.1.1 Release。

改动文件（6）: package.json, package-lock.json, README.md, install.ps1, src/index.ts, scripts/create-pm-acceptance-profile.mts

## 2026-09-03 — codex

公开发布 pm-mcp v0.1.0：建立 Git 仓库并推送 GitHub，补齐固定 Release 标签的一键 MCP 安装、精简发布包和双版本 CI；保留首轮托管失败并修复报告排序与 SQLite 并发启动问题，远端 npx MCP smoke 通过。

改动文件（16）: .gitattributes, .github/workflows/ci.yml, .gitignore, README.md, install.ps1, package.json, package-lock.json, src/dashboard.ts, src/index-db.ts, test/dashboard.test.ts, test/exploit.test.ts, test/integration.test.ts, test/runner.test.ts, test/scenario.test.ts, test/security.test.ts, .pm/acceptance/evidence/github-ci-first-failure-v0.1.0.md

## 2026-09-03 — codex

完成标准化产品验收与编译器/多语言AST语义治理：冻结33项量化需求、33项机器测试和8项风险；证据/源码/报告SHA-256防伪；46工具/7资源/5提示词；完整gate通过，183/183且覆盖率96.57/89.47/94.70，AST assurance与解析率100%，正式报告errors=0。

改动文件（53）: src/acceptance-model.ts, src/acceptance-evaluator.ts, src/acceptance-report.ts, src/acceptance-tools.ts, src/typescript-semantic.ts, src/polyglot-ast.ts, src/semantic-evidence.ts, src/semantic-evidence-store.ts, src/semantic-parsers.ts, src/semantic-graph.ts, src/semantic-graph-algorithms.ts, src/governance-model.ts, src/governance-audit.ts, src/governance-tools.ts, src/project-fingerprint.ts, src/quality-store.ts, src/dashboard.ts, src/index.ts, src/tools.ts, src/project-tools.ts, src/task-tools.ts, src/knowledge-tools.ts, src/audit-tools.ts, src/index-store.ts, src/index-db.ts, scripts/acceptance-gate.mts, scripts/acceptance-cycle.mts, scripts/collect-acceptance-evidence.mts, scripts/create-pm-acceptance-profile.mts, scripts/create-pm-acceptance-evaluation.mts, scripts/quality-gate.mts, scripts/benchmark-volume.mts, scripts/benchmark-volume-support.mts, test/acceptance-evaluator.test.ts, test/acceptance-tools.test.ts, test/acceptance-gate.test.ts, test/acceptance-coverage.test.ts, test/typescript-semantic.test.ts, test/polyglot-ast.test.ts, test/semantic-evidence.test.ts, test/semantic-evidence-store.test.ts, test/semantic-graph.test.ts, test/semantic-coverage.test.ts, test/project-fingerprint.test.ts, test/quality-evidence.test.ts, test/tooling-coverage.test.ts, test/governance-model.test.ts, test/integration.test.ts, test/realrepo.test.ts, package.json, package-lock.json, README.md, .pm/governance.json

下一步: 如需把本次第一方本地验收提升为独立/跨平台发布证明，另行配置Git托管CI、MCP当前规范conformance与第三方评价。

## 2026-09-02 — codex

完成跨文件/模块/语言语义治理层：结构化owner/接口/依赖策略，多生态manifest与真实质量矩阵，import/call/RPC/FFI图，循环/越界/影响分析，跨仓semver组合；完整gate与133项测试通过。

改动文件（33）: src/governance-model.ts, src/language-adapters.ts, src/language-dependencies.ts, src/semantic-graph.ts, src/semantic-parsers.ts, src/governance-audit.ts, src/portfolio.ts, src/governance-tools.ts, src/quality-store.ts, src/tool-base.ts, scripts/quality-gate.mts, src/dashboard.ts, src/index.ts, src/init.ts, src/search.ts, src/audit.ts, src/tools.ts, test/governance-model.test.ts, test/language-adapters.test.ts, test/semantic-graph.test.ts, test/governance-audit.test.ts, test/portfolio.test.ts, test/governance-mcp.test.ts, test/quality-gate.test.ts, test/audit.test.ts, test/search.test.ts, test/store.test.ts, test/integrity.test.ts, test/integration.test.ts, test/realrepo.test.ts, .pm/governance.json, README.md, package.json

下一步: 在实际多语言目标仓库用upsert_module/upsert_interface配置边界并运行npm run gate；编译器/LSP/运行时trace属于增强证据，不把regex启发式冒充运行时真相

## 2026-09-02 — codex

完成20 GiB/约2.983亿行源码仓库基准：结构、watcher、快照、安全与许可证全部通过精确容量oracle；修复大批次物化、强制内容走查与跨项目内容缓存问题，原始JSON和人读报告已留存。

改动文件（14）: scripts/benchmark-volume.mts, src/search.ts, src/index-store.ts, src/scan.ts, scripts/health-check.mts, test/search.test.ts, test/index-store.test.ts, package.json, README.md, .pm/benchmarks/volume-20g-3e8-20260902.json, .pm/benchmarks/volume-20g-3e8-20260902.md, dist/search.js, dist/index-store.js, dist/scan.js

下一步: 按T-023拆分581行volume基准脚本；如需覆盖百万小文件形态，另跑1M×约20KiB；如需容量级检出穿透，另做首/中/尾canary阶段

## 2026-09-02 — codex

修复监管层核验发现：消除 watcher 重启旧索引、巡检基线覆盖/fail-open 和安全 note 泄漏；修复 npm test 与 rg ignore；新增可复跑正确性/性能基准并收紧 README 证据边界。

改动文件（21）: src/index-store.ts, src/audit.ts, src/security.ts, src/search.ts, src/tools.ts, src/dashboard.ts, src/index.ts, src/scan.ts, scripts/health-check.mts, scripts/benchmark.mts, test/index-store.test.ts, test/audit.test.ts, test/security.test.ts, test/search.test.ts, test/runner.test.ts, package.json, package-lock.json, tsconfig.scripts.json, README.md, .pm/project.json, .pm/features.json

## 2026-09-02 — zcode

处置巡检红旗 T-020：sql-concat 改静态 SQL 消除（SEC-011 自动关闭）；实现 watcher 就地排空解决变更风暴回退边界；巡检脚本补派生刷新修仪表盘失同步

改动文件（4）: src/index-store.ts, scripts/health-check.mts, test/index-store.test.ts, README.md

下一步: Linux 无原生递归 watch：维持文档化回退（inotify 每目录监听在 10 万目录级不可行，需 libuv 上游或 chokidar 评估，列为 v3.2 候选）

## 2026-09-02 — zcode

落地 v3 事件驱动架构：探针揪出两个真实缺陷（长走查期间心跳写不进→走查完即续心跳；持锁期事件计数抛错卡死→定时器先行+计数自愈），1M 文件稳态审计 222s→2.85s

改动文件（14）: src/index-store.ts, src/scan.ts, src/search.ts, src/security.ts, src/license.ts, src/audit.ts, src/index.ts, test/index-store.test.ts, test/integrity.test.ts, test/search.test.ts, test/realrepo.test.ts, README.md, .gitignore, package.json

下一步: 变更风暴后免回退全量（pending>0 时只补差异）是 v3.1 候选；Linux inotify 布局适配

## 2026-09-02 — zcode

处置定时巡检首报红旗：SEC-010 fixture 带理由接受闭环；修复巡检汇总红旗明细不可见缺陷；巡检复跑转绿

改动文件（3）: scripts/health-check.mts, .pm/security.json, .pm/tasks.json

## 2026-09-02 — zcode

落地定时巡检强制层：独立巡检脚本（npm run audit，红旗即非零退出）+ 每 2 小时定时自动化 + 红旗查重自动登记；巡检中发现并处置 2 个高危 fixture 发现

改动文件（4）: scripts/health-check.mts, test/runner.test.ts, package.json, README.md

下一步: 观察定时巡检运行情况；v2 继续推进 M2

## 2026-09-02 — zcode

超大项目适配：修复深度静默丢失与传递依赖盲区，落地增量索引与内容缓存（万文件 audit 19.9s→1.9s）

改动文件（9）: src/scan.ts, src/search.ts, src/license.ts, src/security.ts, src/types.ts, test/exploit.test.ts, test/integrity.test.ts, test/search.test.ts, README.md

下一步: v3 候选：目录级枚举缓存（readdir/stat 是剩余瓶颈）、分支级漂移检测、跨仓库聚合

## 2026-09-01 — zcode

红队评审加固：发现并修复 17 项可钻空子（安全闭环/扫描盲区/审计盲区/账本纪律/并发与资源五类），新增钻空失败测试层

改动文件（15）: src/security.ts, src/scan.ts, src/license.ts, src/search.ts, src/audit.ts, src/tools.ts, src/store.ts, src/types.ts, src/roadmap.ts, src/dashboard.ts, src/index.ts, test/exploit.test.ts, test/integrity.test.ts, test/audit.test.ts, README.md

下一步: v2：M2 任务（OSV/相似度检索/依赖图/拆分 tools.ts 债务）

## 2026-09-01 — zcode

完整性测试完成：三层真实测试（场景/完整性/真实仓库）59/59 全绿；发现并修复 5 个真实问题：SDK env 白名单导致注册表污染、测试孤儿进程挂死、Windows 并发 rename EPERM、GPL 头对测试 fixture 误报、路径规范化层级错位

改动文件（12）: test/scenario.test.ts, test/integrity.test.ts, test/realrepo.test.ts, test/integration.test.ts, src/store.ts, src/registry.ts, src/dashboard.ts, src/license.ts, src/types.ts, src/tools.ts, src/scan.ts, src/audit.ts

下一步: v2：M2 任务（OSV/相似度检索/依赖图/拆分 tools.ts）

## 2026-09-01 — zcode

v1 完成：27 工具 + 4 资源 + 3 提示词，40/40 测试通过，tsc 构建成功，并用工具完成本仓库自管理初始化

改动文件（32）: package.json, tsconfig.json, .gitignore, README.md, LICENSE, src/index.ts, src/types.ts, src/paths.ts, src/store.ts, src/init.ts, src/registry.ts, src/budget.ts, src/scan.ts, src/roadmap.ts, src/health.ts, src/audit.ts, src/security.ts, src/license.ts, src/search.ts, src/dashboard.ts, src/tools.ts, test/helpers.ts, test/budget.test.ts, test/store.test.ts, test/roadmap.test.ts, test/health.test.ts, test/security.test.ts, test/license.test.ts, test/audit.test.ts, test/search.test.ts, test/dashboard.test.ts, test/integration.test.ts

下一步: v2：按 M2 任务推进（OSV/相似度检索/依赖图）

