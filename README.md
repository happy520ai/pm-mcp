# pm-mcp — AI 编码项目的「项目大脑」MCP 服务

[![CI](https://github.com/happy520ai/pm-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/happy520ai/pm-mcp/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@luckychen1993/pm-mcp.svg)](https://www.npmjs.com/package/@luckychen1993/pm-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

给每个用 AI 写代码的项目一个**单一事实来源（Single Source of Truth）**：结构化状态文件（`.pm/`，在 Git 项目中随仓库提交）+ 带校验的 MCP 读写工具 + 对账审计。人和任何 AI 客户端（ZCode / Codex / Cursor…）可共享同一份项目状态；未初始化 Git 时，审计会明确提示 Git 对账尚未启用。

> 核心理念：**把恶化从「无声发生」变成「显式记账」，把上下文从「模型记忆」搬到「仓库文件」。**

当前源码为 **0.3.0 本地候选版本，尚未由本轮工作发布**。下方公共安装示例仍使用已发布的 0.1.5。候选版可用 `setup --local` 绑定已构建的本地入口；未发布前不要配置依赖注册表中 0.3.0 的 npx 启动项。

## 0.3.0：升级生效、任务取全与证据分级

- `get_status` 同时显示当前进程的运行版本、项目根和结构化 runtime，避免把项目 phase 中的旧文字当作实际版本。
- `list_tasks` 默认每页 25 条，可用 `page_size`（1–100，受输出预算限制）和 `next_cursor` 连续读取；保持原过滤条件，数据变化会使游标失效。文字及结构化结果都给出本页范围、总数和后续游标。长标题/下一步可能缩略，但编号与分页条目完整。`pm://tasks` 的大列表也提供 continuation。
- 质量摘要标明 `execution_only`、`tests_observed`、`coverage_observed` 等观测等级及计数来源。支持 Node、Jest、Vitest、pytest 的常见英文摘要；无法识别时明确保留未知计数，不猜测为零。等级不等于测试充分性、通过结果或防篡改认证。
- feature/fix 默认必须具有可识别的非零测试及完整状态计数。需要兼容无计数运行器时，由项目负责人明确设置 `update_project({completion_evidence:{minimum:"execution_only",reason:"说明至少八个字的具体理由"}})`；完成记录仍标出弱证据等级。已知零测试、失败、跳过、截断或过期证据始终拒绝。
- 质量子进程不会继承 Node 宿主的内部 `NODE_TEST_CONTEXT`，避免嵌套 `node --test` 跳过文件却退出 0。

本地候选的 Codex 项目升级在构建后按以下步骤执行。先预览，再替换该项目的 command/args，保留其他设置与工具预算：

```powershell
npm run build
node dist/cli.js setup --client codex --project --local --force --dry-run
node dist/cli.js setup --client codex --project --local --force
node dist/cli.js doctor --root .
```

`doctor` 会核对配置并建立短期本地 MCP 读连接，检查实际版本、项目根、48 工具与新参数契约；不会把探测新进程冒充已经重连的客户端。探测不复制自定义凭据环境；结果会产生既有运行计量。显式 `--entry <本地入口>` 可用于安装包检查。配置更新后仍需在实际客户端重新连接，再调用 get_status 确认版本。复杂或歧义配置会拒绝自动替换，已有配置与升级前备份保留。

验收脚本从 `package.json` 的 `pm_mcp.acceptance_baseline` 统一读取基线 ID/版本，命令行可显式覆盖。批准记录不自动升版、不选择猜测的“最新”文件；本仓选择 1.1.0，原 1.0.0 保留。新版评价使用对应版本的计划与失败记录。

## 已有管理流程

用户仍然直接说“继续这个任务”“保存进度”“完成后帮我验收”。50 个工具全部保留，由 AI 组合调用，无需用户记工具名。

- `update_task` 可同时更新进度、保存 `checkpoint:{note,next_step}` 并记录会话；完成时给 `record_session:true`，返回会话编号后不再另调 `log_session`。省略该参数仍兼容旧的手动记会话流程。同一幂等键重放不会重复落账；跨多个文件的异常仍遵守原有“不确定状态需核对”规则，不宣称事务原子性。
- `feature/fix` 转 `done` 必须关联实际文件，并先通过 `run_quality_matrix` 执行相应测试。系统自动选择最新报告，核对执行成功、测试前后与当前源码摘要、测试单元目录和项目证据策略。`verification_run` 可明确指向最新报告，文字 `verification` 只作补充说明。报告存于 `.pm/quality-runs/`，任务保存报告与源码 SHA-256。目录范围匹配不等于代码覆盖率证明；第一方报告也不构成防篡改认证。
- Git 对账按所有会话的文件内容摘要核对，保留删除、重命名和中文路径。旧版只有路径的记录标为“未验证”；同一路径内容再次变化仍会告警。这里只核对当前工作区内容，不代替暂存区审查或提交验收。
- 扫描、索引、搜索、语言发现和源码指纹共用排除规则，默认排除 `.runtime`、`.zcode`、`EBWebView` 等缓存。含义不明确的 `release`、`userdata` 不默认隐藏；确认是产物后由 AI 用 `update_project({scan_ignore:["release/**"]})` 配置，传 `[]` 恢复。报告列明自定义排除范围，规则变动会刷新索引并使旧质量证据失效。

旧账本保持可读，历史已完成任务不会自动重开；新增字段为可选字段。所有读写同一项目的 MCP 进程应统一升级并重启，旧版本写入可能丢弃新元数据。已有 `AGENTS.md` 保留原文；新初始化项目和内置 `end-session` 提示使用合并流程。

仓库测试默认同时运行两个测试文件，避免文件级并发与内部进程压力叠加；20 进程竞争等测试的内部并发、锁超时和覆盖率门槛保持原设定。这是测试资源控制，不是产品并发能力或生产负载的证明。

## 为什么需要它

AI 编码项目的典型失控（本工具逐一给出机制）：

| 痛点 | 机制 |
|---|---|
| 不知道做到哪、有哪些功能 | `get_status` + 功能清单 + 自动仪表盘 PROJECT.md |
| 功能无限多，路线图失控 | 里程碑 + 自适应折叠渲染（`get_roadmap depth=1/2`） |
| 模型幻觉（声称的功能不存在） | 三道防线：开工定位 / 事中 `search_code` 求证 / 事后漂移对账 |
| 重构被新功能挤出 | 债务账 + 里程碑重构配额告警（默认 20%） |
| 变更率飙升（改一处动全身） | 会话变更足迹 → churn 热点 + 单会话波及面告警 |
| 复杂度爆炸 | 复杂度预算（文件行数阈值）+ 模块登记 + 增长率排行 |
| 认知债务（为什么这么做没人知道） | ADR 决策记录 + `search_knowledge` 历史检索 |
| 安全隐患（密钥硬编码、危险模式） | `audit_security` 离线启发式扫描 → 台账闭环（接受风险必须留理由） |
| 调试过程随会话消失 | `log_debug` 调试知识账（症状/根因/修法/验证） |
| 长任务崩溃、上下文丢失 | 任务步骤清单 + `checkpoint` 断点存档，新会话从恢复点续做 |
| 团队协作与知识传递 | Git 项目中共享 `.pm/` + 会话署名 + `onboard` 入职简报工作流 |
| 多 Agent 重复读写 | 实际重叠的同参读跨进程合并；写工具支持业务幂等键、瞬时自动去重与故障不确定态 fail-closed |
| token 猛烧 | 三段式定位 + 读类工具输出硬预算 + 文件用途索引 |
| 法律知识产权 | `audit_license` 依赖许可证/copyleft 冲突 + 来源登记（provenance） |
| 测试投机（删测试、skip 凑绿） | 禁用/蒸发/空测试检测 + 功能测试背书占比 + done 必附验证 |

## 一个命令自动添加到 AI 编程助手

本页安装示例使用 npm 上最新的**已发布**版本（当前为 **0.1.5**）。0.1.4 不支持 `setup --project`；验证这些能力时请确认实际运行版本为 0.1.5 或更新版本。仓库源码当前为 **0.3.0**（新增任务游标分页、完成证据分级、受控升级与 WorkBuddy 客户端等），**尚未发布到 npm**——需要这些能力时请从源码构建，或见下方各客户端的本地入口用法。

要求：Node.js ≥ 22.18。Windows、macOS 和 Linux 使用同一条命令：

```bash
npx -y @luckychen1993/pm-mcp@latest setup
```

安装器自动检测本机的 Codex、Claude Code、ZCode、Cursor、VS Code 和 WorkBuddy，并配置所有检测到的客户端。JSON 配置会先备份；已经存在的 Codex/Claude 配置默认保留，用 `setup --force` 才替换。先预览、不写配置：

```bash
npx -y @luckychen1993/pm-mcp@latest setup --dry-run
```

非标准安装路径无法自动发现时，可在同一命令末尾指定 `--client codex|claude|zcode|cursor|vscode|workbuddy`；`--client print` 输出通用 MCP JSON。首次启动由 `npx` 下载并在本机运行，pm-mcp 本身不需要 API Key，也不会调用远程模型。

### 新项目一条命令上手（Codex 必用）

Codex 桌面版启动 MCP 服务时不带工作区路径，逐项目钉根才能用。在项目目录里跑一条命令，自动完成「注册钉定条目 + 初始化 .pm + 写 AGENTS.md 工作规矩」：

```bash
npx -y @luckychen1993/pm-mcp@0.1.5 setup --client codex --project
```

跑完完全重启 Codex，新会话即可用（工具名前缀 `pm-mcp-<目录名>-<路径摘要>`）。不同中文目录和同名目录独立注册；重复执行会核对项目路径，匹配的旧版条目仍可复用。

### 新项目一条命令上手（Codex 必用）

Codex 桌面版启动 MCP 服务时不带工作区路径，逐项目钉根才能用。在项目目录里跑一条命令，自动完成「注册钉定条目 + 初始化 .pm + 写 AGENTS.md 工作规矩」：

```bash
npx -y @luckychen1993/pm-mcp@0.1.5 setup --client codex --project
```

跑完完全重启 Codex，新会话即可用（工具名前缀 `pm-mcp-<目录名>-<路径摘要>`）。不同中文目录和同名目录独立注册；重复执行会核对项目路径，匹配的旧版条目仍可复用。

### 客户端官方命令（自动检测失败时备用）

#### Codex / ChatGPT 桌面版 / Codex IDE 扩展

Codex 的本地客户端共享同一份 MCP 配置。复制执行：

```bash
codex mcp add pm-mcp -- npx -y @luckychen1993/pm-mcp@0.1.5
```

重启客户端后可用 `codex mcp list` 检查。该命令遵循 [OpenAI 官方 MCP CLI 格式](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)。

#### Claude Code

```bash
claude mcp add pm-mcp --scope user -- npx -y @luckychen1993/pm-mcp@0.1.5
```

#### ZCode、Cursor、VS Code（Windows 备用脚本）

将 `<client>` 替换为 `zcode`、`cursor` 或 `vscode`，整行复制到 PowerShell：

```powershell
$u='https://raw.githubusercontent.com/happy520ai/pm-mcp/v0.1.5/install.ps1'; $f=Join-Path $env:TEMP 'install-pm-mcp.ps1'; Invoke-WebRequest $u -OutFile $f; & $f -Client <client>
```

脚本只写对应客户端的 MCP 配置；已有 JSON 配置会先生成带时间戳的备份。建议执行前先打开 [`install.ps1`](install.ps1) 审阅。ZCode 默认写入 `$ZCODE_HOME/cli/config.json` 或 `~/.zcode/cli/config.json`，Cursor 默认写入 `~/.cursor/mcp.json`；也可用 `-ConfigPath` 指定路径。

#### WorkBuddy 桌面版

> **要求 pm-mcp ≥ 0.3.0**：`--client workbuddy` 是 0.3.0 新增的客户端；npm 上当前的 0.1.5 **不支持**该参数，直接跑会报 `--client must be auto, all, codex, claude, zcode, cursor, vscode, or print`。

0.3.0 发布后：

```bash
npx -y @luckychen1993/pm-mcp@latest setup --client workbuddy
```

0.3.0 发布前，从源码构建后用本地入口接入（`--local` 绑定本包已构建的 `dist/index.js`）：

```bash
npm ci && npm run build
node dist/cli.js setup --client workbuddy --local
```

写入 `<WorkBuddy 数据目录>/mcp.json`，结构与下方通用 JSON 一致。数据目录按 `WORKBUDDY_CONFIG_DIR` → `~/.workbuddy-ai`（当前版本）→ `~/.workbuddy`（旧版）顺序解析，写入前会生成带时间戳的备份，未知顶层字段与既有 server 全部保留。

与其他客户端的关键差别：**WorkBuddy 的条目刻意不写 `--root`**。它的 MCP 子进程由会话工作区拉起，cwd 即当前项目，服务端按 cwd 解析项目根——因此一条配置同时服务所有工作区，不需要逐项目钉根；未初始化的目录只返回「未初始化」，不会写入任何文件。

⚠️ 注意该设计的边界：**跨项目操作会失效**。若在 A 项目的会话里让 pm-mcp 去改 B 项目，它读到的始终是 A（MCP 子进程的 cwd 就是会话工作区）。跨项目时请在目标项目的会话内操作，或改用显式钉根的配置。

接入后用 `doctor` 核验（它会读取该 `mcp.json` 的 pm-mcp 条目并做真实握手）：

```bash
node dist/cli.js doctor --root . --client workbuddy           # 核验 48 工具与项目根
```

`doctor` 会读取该 `mcp.json` 的 pm-mcp 条目，只认可识别的本地 pm-mcp 启动项（npx 发布版或 node + 本包 `dist/index.js`），被 `disabled` 的条目与未知启动器一律拒绝，且不读取或转发自定义凭据环境。配置完成后需在 WorkBuddy 的「连接器管理 → 自定义连接器」中确认信任 pm-mcp，再重开会话调用 `get_status` 核验。

#### 其他支持 stdio MCP 的客户端

```json
{
  "mcpServers": {
    "pm-mcp": {
      "command": "npx",
      "args": ["-y", "@luckychen1993/pm-mcp@0.1.5"],
      "env": {}
    }
  }
}
```

服务默认以客户端启动它时的工作目录作为项目根。若客户端不从项目目录启动，可在 `args` 末尾增加 `"--root", "项目绝对路径"`，或设置 `PM_ROOT`。第一次使用未初始化的项目时，让 AI 调用 `init_project`；MCP 工具可能读写目标项目的 `.pm/`，请按客户端提示确认信任。

### 环境变量与参数

| 变量/参数 | 作用 |
|---|---|
| `--root <path>` | 项目根（最高优先级） |
| `PM_ROOT` | 项目根（次优先级） |
| `PM_MCP_HOME` | 全局注册表重定向（默认 `~`；多环境/测试隔离用） |

### pm-mcp probe：标准 raw tools/list 直连探针

宿主（ZCode/Codex/Cursor 等）是唯一 MCP client 持有者，不会向模型透传原始 `tools/list`；要拿服务器在协议线上的真实工具清单，用 `probe` 绕过宿主直连：

```bash
node dist/cli.js probe -- node dist/index.js --root .
node dist/cli.js probe --timeout 10000 --expect get_status,list_tasks,search_code -- node dist/index.js --root .
node dist/cli.js probe --expect-file 上一轮probe报告.json -- node 其他服务器/dist/index.js
```

- 输出原始工具清单 JSON（`tools` 含 name/description/inputSchema，自动翻页取全）与 `serverInfo`；退出码 0/1。
- `--expect` 与期望工具表比对（如从 Codex `config.toml` 的 `[mcp_servers.X.tools.*]` 提取），缺失/多余都会列进 `issues` 并置 `ok:false`。
- `--expect-file` 接受上一轮 probe 报告、字符串数组或 `{tools:[...]}`，便于跨项目基线比对。
- 探测进程与服务器子进程在结束时都会被清理，不会残留。

## 推荐工作流（写给 AI 的规矩）

把下面这段放进目标项目的 `AGENTS.md`，任何 AI 会话自动遵守：

```markdown
# 项目管理规矩（pm-mcp）

本项目由 pm-mcp 管理，状态以 .pm/ 目录为准，禁止凭记忆陈述项目状态。

## 开工（每次会话第一件事）
1. get_status：了解阶段、里程碑、进行中任务与其 checkpoint 下一步
2. 不清楚的模块先 search_code 定位到 file:line 再读文件，不要全量读代码
3. 跨模块/语言变更先 audit_governance，再用 impact_analysis 计算反向影响闭包
4. 陈述本次计划：做哪个任务、动哪些文件、验收标准

## 做事过程
- 长任务：add_task 时给 steps；update_task 附 checkpoint 一次更新进度与会话
- 走捷径：立刻 add_task(type=debt) 登记债务，不许无声欠债
- 修 bug：完成后 log_debug 记录症状/根因/修法/验证
- 陈述"某功能在某文件"之前，先 search_code 求证

## 收工（缺一不可）
1. feature/fix 先 run_quality_matrix 执行测试；update_task 置 done + result_note + files，record_session:true 一并归档
2. 未完成任务 checkpoint（进展 + 下一步）
3. 落地的功能 register_feature（入口文件 + 测试文件）
4. update_task 已返回自动会话编号时不重复 log_session；否则如实记录改动文件清单。纯问答无需新建任务或重复记账

## 每个里程碑节点
snapshot_codebase + audit_structure 对账；audit_security 安全体检；audit_license 许可证审计；audit_governance 模块/语言边界审计；plan_quality_matrix 生成真实质量矩阵
```

也可以直接用内置 prompts：`start-session` / `end-session` / `onboard` / `architecture-review` / `acceptance-review`；其中 `onboard` 会引导客户端读取状态并生成新人/AI 入职简报。

## 工具清单（50 个）

| 域 | 工具 | 说明 |
|---|---|---|
| 状态 | `init_project` / `get_status` / `update_project` / `regenerate_dashboard` | 初始化、一站式「我在哪」（`since` 汇总任务/会话变化）、改元信息与预算、重生成仪表盘 |
| 路线图 | `add_milestone` / `update_milestone` / `get_roadmap` | 里程碑生命周期；depth=1 单行摘要 / depth=2 展开活跃任务 |
| 任务 | `add_task` / `list_tasks` / `update_task` / `checkpoint` | 进度/断点/会话合并更新；feature/fix 完成强制关联文件与最新真实测试报告 |
| 功能 | `register_feature` / `list_features` | 功能地图（入口文件 = 漂移对账锚点；测试文件 = 测试背书） |
| 决策 | `record_decision` / `list_decisions` | ADR 架构决策记录（不可变编号） |
| 会话 | `log_session` | 摘要 + 变更足迹/内容摘要 + 下一步（churn 与 Git 内容对账来源） |
| 调试 | `log_debug` | 调试知识账：症状/根因/修法/验证 |
| 求证 | `search_code` / `search_knowledge` / `annotate_file` | 代码检索（file:line）、七类知识源检索（含模块/接口/仓库治理）、文件用途索引 |
| 审计 | `snapshot_codebase` / `audit_structure` | 结构快照；完整性/增长/漂移/债务/churn/复杂度/索引/足迹/测试/Git 十节对账 |
| 安全 | `audit_security` / `list_findings` / `resolve_finding` | 密钥+危险模式+新增/通配依赖提示；扫描命中原文不落盘，处置 note 拒绝内置密钥形态 |
| 法律 | `audit_license` | 依赖许可证清单、copyleft 冲突、GPL 头检测、LICENSE 检查、来源登记 |
| 可观测 | `get_usage_log` / `get_runtime_log` | 使用日志（工具调用统计、错误率、耗时、输出与折叠省下的 token 估算——验证省不省 token）与运行日志（server/watcher/工具报错）；只记计量不记参数内容 |
| 注册表 | `list_projects` | 本机所有被管理项目 |
| 治理模型 | `init_governance` / `get_governance` / `upsert_module` / `upsert_interface` / `upsert_repository` / `set_governance_policies` | 结构化模块根、owner、语言、公开接口、允许/禁止依赖、跨仓版本约束与强制策略 |
| 语义治理 | `discover_languages` / `audit_governance` / `dependency_graph` / `impact_analysis` / `list_semantic_evidence` / `save_semantic_evidence` / `replace_semantic_evidence_for_file` | 编译器/Tree-sitter AST 关系、hash-bound 原生分析器/运行时证据、模块与文件级循环、依赖邻域/枢纽/unresolved/覆盖率与变更反向闭包 |
| 质量与组合 | `plan_quality_matrix` / `run_quality_matrix` / `get_portfolio` | plan 与真实执行严格分离；shell=false；跨仓阶段/债务/安全/版本/cycle 聚合 |
| 标准化验收 | `list_acceptance_baselines` / `get_acceptance_baseline` / `save_acceptance_baseline_draft` / `approve_acceptance_baseline` / `evaluate_acceptance` | ISO/SQuaRE 对齐的版本化质量基线、冻结证据指针、需求—风险—测试追踪、机器判定报告与 SHA-256 manifest |

Resources：`pm://dashboard`、`pm://roadmap`、`pm://tasks`、`pm://changelog`、`pm://architecture`、`pm://portfolio`、`pm://acceptance`。

所有写工具都接受可选 `idempotency_key`。同一业务的多个 Agent 应传同一个稳定键（例如 `T-123:add-login-task`）：同键同参数只执行一次并复用首次结果，同键不同参数直接拒绝。即使没有显式键，完全相同的并发写也会在短窗口内自动合并；完全相同的并行读会等待首个执行者并复用结果。

并发保证有明确边界：正常运行的同键写只落一次，follower 最多等待 3 秒复用首次结果；仍未完成时以 MCP error 返回 pending，不把占位冒充成功。若进程在业务写入后、幂等完成记录前被强杀，pm-mcp 会把该键标为 `uncertain` 并禁止自动重放。它提供的是 **at-most-once + 不确定时 fail-closed**，不是跨多个 JSON 文件的事务型 exactly-once；核对目标账本后才能决定是否换新键。v0.1.3 的标准全局幂等记录会在首次复用时迁移到项目运行态，旧文件保留以便回滚。读合并只覆盖业务处理实际重叠的在途请求，完成结果不会继续缓存，避免外部代码刚变化却返回旧内容。每个项目由 SQLite 生命周期选举一个 watcher leader，其余进程低频待命；leader 被强杀后由一个 standby 接管。结构、安全、许可证与快照等权威审计强制重读内容，不把 `fs.watch` 或 mtime/size 缓存的最终一致性冒充强一致性。

## 数据模型（被管理项目内的 `.pm/`；JSON/Markdown 账本可 git diff，`index.db` 是忽略并可重建的缓存）

```
.pm/
  project.json    # 元信息 + 预算（maxFileLoc=500 / refactorQuotaPct=20 / sessionBlastRadius=15 / outputBudgetLines=150）+ exposure + license
  roadmap.json    # 里程碑（进度由任务推导）
  tasks.json      # 任务（type/steps/checkpoint/verification/result_note/author）
  features.json   # 功能（module/entry_files/test_files）
  sessions.json   # 结构化会话日志（→ 自动生成 changelog.md）
  debuglog.json   # 调试记录
  file-notes.json # 文件用途索引（+ source/license 来源登记）
  decisions/      # ADR-NNN-*.md
  security.json   # 安全体检台账（指纹去重；可选 security-rules.json 自定义规则）
  governance.json # 结构化模块/owner/接口/仓库依赖与强制策略
  semantic-evidence/ # 按源码 SHA-256 绑定的语言原生 AST/编译器/运行时证据
  quality-runs/   # 质量矩阵结构化摘要、测试/覆盖率计数、输出摘要哈希与测试前后源码树指纹
  acceptance/     # 预批准基线、评价输入、原始证据、不可覆盖正式报告与 SHA-256 manifest
  snapshots/      # 代码结构快照
PROJECT.md        # 仓库根，自动生成的仪表盘（勿手改）
changelog.md      # 自动生成
```

全局注册表：`~/.pm-mcp/registry.json`。跨进程读合并、写幂等、恢复锁与 watcher 选举运行态位于被管理项目的 `.pm/.runtime/`，由 `.pm/.gitignore` 排除；因此路径别名、不同客户端或不同 `PM_MCP_HOME` 仍共享同一协调域，但运行态不会进入 Git。

## 跨文件、跨模块、跨语言治理

- **模块实体**：每个模块有稳定 ID、一个或多个 root、owner、语言、公开接口以及声明/允许/禁止依赖。重复 ID、无 root、无 owner、未知引用和策略冲突在 schema 层拒绝。
- **语义关系图**：TS/JS 使用 TypeScript Compiler API（含 symbol binding）；Python、Go、Rust、Java、Kotlin、C# 使用固定版本的 Tree-sitter grammar。import/export/call/contract/HTTP/gRPC/FFI 边均保留 analyzer family/version、confidence、symbol 与 file:line。
- **语义保证门禁**：策略可要求 `minimum_semantic_assurance=ast|runtime` 并禁止 regex fallback。外部语言原生分析器与 runtime trace 使用 `semantic-evidence v1`，每份证据绑定目标文件 SHA-256；损坏、路径逃逸、源码变化、partial 或低于策略的证据都失败。
- **边界门禁**：检测模块循环、未声明/禁止/未允许依赖、绕过公开接口、无归属源码、未解析本地引用与低于策略的源码覆盖率。`depends_on` 不能绕过私有入口。
- **影响分析**：从变更文件沿文件边和模块反向依赖计算受影响闭包，未知输入单独列出。
- **语言质量矩阵**：递归发现 Node workspaces、Python、Go、Cargo、Maven/Gradle、.NET；Node 只运行明确存在的白名单脚本，Maven/Gradle 优先仓内 wrapper。缺工具、超时和非零退出均失败。
- **跨仓组合**：全局注册项目加载失败不会变成空项目假绿；组合图检查缺失仓库、依赖循环及 `*`/exact/`^`/`~`/比较符 semver 约束。

`plan_quality_matrix` 和 `npm run quality:plan` 永远只表示计划。真实证据必须来自 `run_quality_matrix(confirm_execute=true)` 或 `npm run quality`。

## 标准化产品验收

验收层对齐 ISO/IEC 25010:2023 的九项产品质量特性、ISO/IEC 25040:2024 的 define/design/plan/execute/conclude 五阶段，以及 ISO/IEC/IEEE 29119 的测试可追踪思想。它是项目内第一方评价框架，不是 ISO 机构认证。

- 基线必须逐项声明适用特性；裁剪必须给理由。每条需求必须有量化阈值、风险、测试以及冻结的 `evidence_id + RFC 6901 JSON Pointer`。
- draft 以 fingerprint 原子批准；批准后同 ID/版本不可修改，任何调整必须升版。
- 自动测试的比较运算和期望值在批准前冻结；评价时重算证据 SHA-256 并从原始 JSON 重新提取实测值。手填更高数值或把失败改成 passed 会被拒绝。
- 风险强制 owner、likelihood、impact、treatment、补偿控制；残余风险超过基线、未授权接受或复审过期都会阻断。
- 正式结论只能由 evaluator 计算；JSON、Markdown 与 `.sha256.json` 三件套不可覆盖，缺一或被改即失败。

## 防钻空设计（红队评审加固）

这套机制的对手是"想抄近路的 AI（和偷懒的人）"。以下空子已被逐一堵上；`test/exploit.test.ts` 当前包含 20 个名称明确的“钻空”用例，另有边界与精确性用例：

| 钻法 | 反制 |
|---|---|
| 安全发现标 fixed 后不修，绿灯永驻 | 复现即自动重开并注明"曾 fixed 又检出" |
| 接受一次风险 = 永久免疫 | accepted 复现时在报告中单独点名 |
| 把代码堆进 >2MB 巨文件逃过行数预算 | 超扫描上限的文件单独点名"请拆分" |
| 恒真断言塞进大测试文件绕过空测试检测 | 独立断言行不限行数都抓（内嵌字符串不误报） |
| pnpm 符号链接布局躲过许可证审计 | 链接目录按依赖候选盘点 |
| search 的 query 含灾难正则挂起进程 | 默认字面量匹配，正则需显式 `regex: true` |
| `entry_files: []` 让功能永不漂移 | 审计点名"无锚点功能" |
| 调大预算让告警消失（预算自肥） | 预算偏离默认值必须在审计中可见 |
| 删掉账本文件让数据无声丢失 | 审计检查 .pm 完整性，缺文件点名"从 git 恢复" |
| `.pm` 塞进 .gitignore 让共享失效 | git 对账节检测并警告 |
| log_session 漏报改动文件 | git status 对账：未入账变更点名 |
| result_note 填「好」糊弄 done 门槛 | 过于空洞（<4 字）直接拒绝 |
| 空白标题/摘要混进账本 | save 层 schema 闸门（trim + min），绕过工具直写也被拦 |
| 双客户端并发写丢任务 | 账本锁（读-改-写原子化，超时明确报错不静默丢） |
| 跳过前置里程碑直接完成 | 乱序警告 |
| 旧 checkpoint 冒充新鲜断点 | >7 天标注"可能过期" |
| done 后改回进行时残留完成时间 | 重开自动清 completed_at |

## 超大项目架构与可复跑基准

v3 的实现由四部分组成：

1. **SQLite 索引**：使用 Node 内置 `node:sqlite` 与 `.pm/index.db`；SQL 聚合避免把百万行索引整体物化到内存，索引仍只是可重建缓存。
2. **递归 FS watcher**：server 常驻期间增量维护增/改/删与新目录子树，150ms 防抖，并可排空已送达的变更队列。
3. **分代新鲜度**：每次 watcher 进程启动后，第一次审计必须完成该会话的精确走查；只有同一会话完成对账后才进入 SQL 稳态。独立巡检/CI 每次都自行走查，不信任其他进程遗留的心跳。
4. **ripgrep 集成**：检测到 `rg` 时 `search_code` 使用 rg，并显式让非 Git 项目也读取 `.gitignore`；未安装则回退内置扫描。

可用 `npm run benchmark -- --files 10000` 在系统临时目录复跑基准。脚本同时核验索引计数和 watcher 重启后的停机窗口对账，默认清理自己创建的临时目录。性能必须连同 Node 版本、平台、磁盘、文件形态与正确性断言一起解读。

按真实可扫描字节测试可用：

```bash
npm run benchmark:volume -- --size-gib 20 --file-bytes 1048576 --full-audit --temp-base E:/UserData/Administrator/Temp --result .pm/benchmarks/volume-20g.json
```

该模式生成 20,480 个、每个 1 MiB 且低于 oversize 阈值的 TypeScript 文本；同时核对文件系统与 SQLite 总字节、LOC、`content_ok`、`oversize`、暖/冷结构路径、重启对账，并分别要求安全与许可证扫描实际读取满 20 GiB。结果逐阶段原子持久化，fixture 只在所有权校验后删除。这里的读取字节是应用层成功读取的逻辑字节，不冒充物理磁盘读取计数。

此前记录过 1M 文件稳态 `audit_structure` 2.85s、快照 2.58s、冷走查 186s；仓库当时没有保留原始日志、机器规格或生成脚本，因此这些数字现在只作为**历史自报记录**，不作为当前发布门禁。10M 约 30s 是线性外推，不是实测。完整 `health-check.mts` 还会扫描安全与许可证，不能拿 `audit_structure` 的耗时代表整套巡检。

边界：`fs.watch` 是平台事件接口，不承诺永不丢事件；进程重启分代走查与独立巡检全量走查负责恢复精确基线。Linux 不提供同等的原生递归 watch 时会退回走查路径。全库搜索和冷走查仍受磁盘 I/O 限制；超大 monorepo 建议按包分治。

## 能力边界（诚实声明）

- **安全扫描**是离线启发式（正则规则 + 依赖元数据），只保证已识别命中原文不写台账且内置密钥形态不能进入 note；它不替代专业 SAST / gitleaks，不做运行时防护，也不联网查 CVE。
- **许可证审计**覆盖直接+传递 Node 依赖（npm 嵌套与 pnpm 布局）；语言单元虽可跨生态发现，但许可证深度仍不是所有生态的通用供应链图，也不替代法务意见。
- **测试背书占比**是代理指标（功能是否挂了真实存在的测试文件），不是行覆盖率。
- **token 消耗**本身是客户端的账，工具用「足迹/产出比」做空转代理指标。
- 幂等层能避免重复计算、重复落账并缩短重复调用输出，但无法返还模型在发起 MCP 调用前已经消耗的推理 token；客户端/Agent 编排仍应避免无意义扇出。
- 结构/安全扫描忽略内置目录（node_modules/.git/dist/build/venv 等）与常见二进制/锁文件，尚不通用解析 `.gitignore`；`search_code` 的 rg 后端会解析。目录深度上限 64 层（超限计数上报，不静默）。
- **仓库提供 fail-closed 巡检命令**；定时器、托管 CI 与会话 hooks 属部署层，必须在相应环境单独配置和监控。
- 语义层面无法强制的（笔记内容是否属实、AI 是否真跑了测试）依赖 git 对账与审计交叉验证，不承诺语义级防伪。
- 静态语义层已使用编译器/Tree-sitter AST，但 AST 证明的是源码结构，不证明真实执行。反射、动态分发、依赖注入、生成代码和线上调用仍必须导入 hash-bound runtime trace；要求 runtime 保证时，仅有 AST 会严格失败。
- 标准化验收报告只对其冻结 scope、版本、环境与证据成立；第一方验收不等于独立评价、托管 CI、生产证明或 ISO 认证。

## 定时巡检（强制层）

监管不能只靠 AI 自觉调用审计工具。仓库自带独立巡检脚本，不依赖 MCP 客户端，供定时器/CI/人直接跑：

```bash
npm run audit                          # 巡检全局注册表内全部项目
npm run audit -- --root <项目根>       # CI 推荐：显式巡检当前项目
npm run quality:plan                   # 只生成跨语言质量计划，不执行
npm run quality                        # 架构门禁通过后真实执行质量矩阵
npm run acceptance:evidence            # 采集当前源码指纹、MCP inventory、治理/质量/安全/20GiB证据
npm run acceptance:prepare             # 从冻结 Pointer 生成评价输入（不能手填 PASS）
npm run acceptance                     # 复算证据并生成正式三件套报告
npm run acceptance:cycle               # 为重复门禁创建唯一 evidence/evaluation/report ID
npm run gate                           # audit + AST architecture + 真实质量矩阵 + 标准化验收
node scripts/health-check.mts --root <项目根>   # 源码方式巡检单个项目
node scripts/health-check.mts --tasks <项目根>  # 列任务（红旗登记前查重）
node scripts/health-check.mts --add-task <根> "[巡检] 摘要" fix  # 走账本锁登记任务
```

行为：巡检先做独立精确走查，再以旧快照执行结构对账 + 安全体检 + 许可证审计；只有完整执行且无硬红旗时才推进当前快照，坏状态重复巡检不会因覆盖基线而假绿。红旗、公网项目未处理中危、目标缺失、账本损坏或巡检异常均**退出码 1**。`--tasks`/`--add-task` 提供查重和登记通道，但自动解析与查重由外部调度工作流负责。

本机另有每 2 小时运行的 ZCode 自动化；它是仓库外的部署状态，需与脚本本身分开监控。GitHub Actions 在 Node 22.18 与 24 上执行类型检查、183 项测试与覆盖率门禁、构建和发布包走查；这仍是托管 CI 证据，不代表用户环境或生产证明。

## 开发

```bash
npm ci             # 按 lockfile 安装依赖，并通过 prepare 构建 dist/
npm test           # node --test 显式 glob（当前 183 个用例）
npm run coverage   # Node 原生覆盖率门禁：lines 90% / branches 85% / functions 90%
npm run build      # tsc 构建 dist/
npm run typecheck  # 类型检查
npm start          # 运行编译后的 dist MCP server
npm run dev        # 直接跑源码（Node ≥ 22.18 原生 TypeScript）
npm run benchmark -- --files 10000  # 临时目录可复跑性能/正确性基准
npm run benchmark:volume -- --size-mib 8 --file-bytes 65536 --full-audit  # 字节覆盖冒烟
npm run quality:plan  # 跨语言质量矩阵计划（不执行）
npm run gate          # 完整本地门禁
```

源码可双路运行：Node 原生 type stripping（开发/测试直接跑 `src/*.ts`）与 tsc 编译（`dist/`，import 扩展名自动重写）。

### 测试体系（八层，全部真实）

| 层 | 文件 | 测什么 |
|---|---|---|
| 单元 | budget/store/roadmap/health/security/license/audit/search/dashboard | 各账本与机制的正确性（含伪造密钥/危险模式 fixture、已识别命中原文不落盘断言） |
| 治理 | governance-model/language-adapters/semantic-graph/semantic-evidence/polyglot-ast/portfolio/governance-audit | 模块 schema、八语言 AST、symbol-bound call、原生/runtime证据、私有接口、循环、影响闭包、semver 与跨仓 fail-closed |
| 标准化验收 | acceptance-evaluator/acceptance-tools/acceptance-gate/quality-evidence | 九特性/五阶段、冻结指标与断言、双向追踪、风险接受、源码/证据/报告 SHA-256、伪造 PASS 失败 |
| 集成 | integration/governance-mcp/quality-gate | 真实拉起 stdio server 全链路：48 工具、7 资源、5 提示词；真实执行安全 argv 质量命令 |
| 场景 | scenario.test.ts | **对 dist 产物**跑三段会话生命周期：中文+空格路径、CRLF、断点跨进程恢复、故障注入（删测试/加 skip/删入口文件/新增依赖/伪造密钥/GPL 头）、三种根解析方式（cwd / PM_ROOT / --root）各用一遍 |
| 完整性 + 真实仓库 | integrity.test.ts / realrepo.test.ts | 状态不变式（全账本 schema、派生逐字节一致、原子性、损坏恢复、500 任务规模折叠、并发双进程零丢失）；并以本仓库真实 `.pm` 为被测对象（漂移为零、PROJECT.md 同步、done 纪律、全仓拷贝审计不误报） |
| 钻空（红队） | exploit.test.ts | 每个反制机制配一个「先钻、再断言钻不进」的测试（见上表） |

两条真实教训写进了测试：**SDK 默认只继承白名单环境变量**，脚本化测试必须在 spawn 参数里显式传 `PM_MCP_HOME`，否则会污染真实 `~/.pm-mcp/registry.json`；测试里 spawn 的子进程要用 `t.after` 兜底关闭，断言失败留下的孤儿 server 会握着管道让测试进程永不退出。

## 后续增强候选

更深的语言编译器/LSP provider、自动运行时 instrumentation 与服务拓扑、OSV 联网漏洞查询（默认关）、全生态许可证/SBOM、受版权代码外部相似度检索、重复代码检测、Web UI、多用户权限。
