# ADR-005 Qoder 项目根解析：按 ppid 匹配会话运行日志，而不是钉死 --root 或赌 args 插值

- 日期: 2026-09-19
- 状态: 已被 ADR-006 取代（实测：所有 run 日志目录名共用主进程 pid，ppid 区分会话不成立；且 Qoder 只派生一个常驻子进程给所有窗口，启动期定根对其它窗口必然错）

## 背景

Qoder 拉起 MCP 子进程时 cwd 是安装目录，工作区只在 QODER_WORKER_CWD / args 插值 / 会话日志里；同时 1.1.57 不加载 .qoder/settings.local.json 的 mcpServers。用户要求「全局一条配置」且「每个项目各归各的账本」，写错根会把任务记到别的项目。

## 决定

三级线索按可靠性依次尝试并在失败时拒绝猜根：显式 --root/PM_ROOT > 已初始化的 cwd > QODER_WORKER_CWD > 本会话 qodercli 日志的 initial_cwd。会话归属用运行日志目录名结尾的 -p<CLI进程号> 与子进程 process.ppid 精确匹配；get_status 与启动横幅报告本次解析依据，让错配可被立刻看见。

## 后果

代价是 pm-mcp 认识了一个客户端专有变量与 Qoder 的日志布局（已限定在 qoder-launch 适配器内，核心解析只多一级）。放弃了两个方案：把 --root 钉死在配置里（在其他项目会话会读到错误账本）、只赌 args 插值（实测 figma 条目里 ${FIGMA_API_KEY} 原样透传，插值不可依赖）。曾试「取最新运行日志」，会被其他并发会话的日志带偏（挑到 C:\Users\Administrator），已废弃。
