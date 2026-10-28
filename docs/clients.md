# 客户端接入细节

本文件承接 README 的「客户端官方命令」一节：各客户端（Codex / Claude Code / ZCode / Cursor / VS Code / WorkBuddy / Qoder）在自动检测失败时的手工配置备用命令与适配器写法。

> 常规路径优先用 `npx -y @luckychen1993/pm-mcp setup`（见 README「一个命令自动添加到 AI 编程助手」）；本文件是检测失败或需要手工核验时的备用说明。

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

要求 pm-mcp ≥ 0.3.0（`--client workbuddy` 为 0.3.0 新增）。一条命令接入：

```bash
npx -y @luckychen1993/pm-mcp@latest setup --client workbuddy
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

#### Qoder CLI / Qoder CN

```bash
npx -y @luckychen1993/pm-mcp setup --client qoder          # 发布版：条目写 ~/.qoder-cn/settings.json，走 `pm-mcp launch`
node dist/cli.js setup --client qoder --local              # 本仓库：绑定已构建的 dist/qoder-launch.js
node dist/cli.js doctor --root . --client qoder            # 真实握手核验（配置改完先跑这个）
```

Qoder 拉起 MCP 子进程时 cwd 是它的安装目录（worker cwd shim），且 1.1.57 实测不加载 `.qoder/settings.local.json` 的 `mcpServers`。**更关键的是：Qoder 只派生一个常驻 stdio 子进程，再用本地路由把所有窗口/会话复用到它上面**（实测同一 server uuid 被多个不同 session token 共用，进程可存活数天）。因此任何「启动时解析一次项目根」的做法对其它窗口必然是错的——运行日志目录名结尾的 `-p<pid>` 也是主进程 pid，`process.ppid` 无法区分会话。

所以项目根是**每次调用重新认领**的：Qoder 在派发前会把 `tool.requested`（含工具名与参数原文）写进本会话运行日志，服务端用「工具名 + 参数 + 紧时间窗」做请求指纹倒扫最近日志，命中那份日志头部的 `initial_cwd` 就是调用方工作区。适配器 `dist/qoder-launch.js` 只负责打标记与给出启动期默认值：继承到的 `QODER_WORKER_CWD`，否则取最近在写的那份运行日志的 `initial_cwd`，通过 `PM_MCP_ROOT_HINT(_SOURCE)` 交给服务端，并**不再伪造 `--root`**，所以 `get_status` 报出的依据是真实来历而不是清一色的 `--root`。认领顺序：调用时显式传的 `root` 参数 > 请求指纹命中 > 唯一活跃会话 > 启动期提示（标 `spawn-time`）> 启动解析。指纹命中多个会话、或多个会话同时活跃又无指纹时**一律不猜**：退回启动根，在 `root_source` 里写明「未猜测」并列出候选，此时给本次调用传 `root` 即可确定。

你在 `args` 里显式写 `--root` 时适配器完全尊重它：不打适配器标记，服务端也就不会按请求改根（适合「一个固定账本」的用法）。

等价的手写配置（`setup --client qoder --local` 写的就是这个形状）：

```json
{
  "mcpServers": {
    "pm-mcp": {
      "command": "node",
      "args": ["<本仓库绝对路径>/dist/qoder-launch.js"]
    }
  }
}
```

也可以跳过适配器直接指服务器：`["<绝对路径>/dist/index.js", "--root", "${QODER_WORKER_CWD}"]`。客户端支持 args 插值时直接生效；不支持时留在 `args` 里的字面量会被 pm-mcp 判为无效值忽略，转而采用继承到的 `QODER_WORKER_CWD` 本身。**但这条写法把项目根钉在派生那一刻**：进程被所有窗口共用时，后开的窗口会读到先开窗口的项目，只适合单工作区或你确实想要一个固定账本的场景。

推荐用适配器写法：一条配置服务所有工作区，且每个窗口各归各的账本。核验：重连（`/mcp reload` 或重开会话）后调用 `get_status`，「项目根」后面会标出本次认领依据（正常应是 `qoder-session-log(request-match)`）；`structuredContent` 里同时带 `project`/`milestones`/`focus`/`health`/`last_session`，只呈现结构化载荷的客户端也能看到完整状态。

> `launch` 子命令与 `--client qoder` 自 **0.6.0** 起随 npm 发布；旧版本请升级，或用 `setup --client qoder --local` 从源码构建后的入口接入。
