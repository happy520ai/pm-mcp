# ADR-006 Qoder 项目根改为按请求认领：常驻子进程被所有窗口共用，ppid 与启动期 --root 都靠不住

- 日期: 2026-09-20
- 状态: 已接受

## 背景

2026-09-20 实测推翻了 ADR-005 的核心前提。证据：Qoder 主进程只派生一个常驻 stdio 子进程（node dist/qoder-launch.js，pid 24452 自 2026-09-19 22:55 存活至今），当天三个会话的 run manifest 里 pm_mcp 是三个不同的 /mcp/sessions/<token>/ 但指向同一个 server uuid 3548ba94；所有 run 日志目录名都是 -p30056，即主进程 pid。因此 (1) ppid 无法区分会话，ADR-005 的「按 ppid 精确匹配」实际退化成「取最新日志」，并发窗口会串项目；(2) 更根本的是，root 在 src/index.ts 启动时解析一次并被 registerAllTools 闭包进 54 个工具，进程既然被所有窗口共用，启动期解析出的根对其它窗口必然是错的——用户在 unified-ai-system 窗口调 get_status 拿到的却是 pm-mcp 自己的仓库。另外适配器把动态解析结果以 --root 传给服务器，导致 root_source 永远报「--root」，把来历抹掉了；get_status 的 structuredContent 只放 runtime，而 Qoder 的 mcp_call 只呈现 structuredContent，于是阶段/里程碑/进行中任务全看不见。

## 决定

项目根从「启动时定格」改为「每次调用认领」，并让依据自证。1) 新增 src/caller-workspace.ts：Qoder 在派发前会把 tool.requested（含工具名与参数原文）写进本会话 run 日志，用「工具名+参数+紧时间窗」做请求指纹反查，命中日志的 initial_cwd 就是调用方工作区；活跃日志可达数 MB，故从尾部按 256KB 分块倒扫、按字节拼接后解码、扫到早于时间窗即停。2) 解析顺序：显式 root 参数 > 请求指纹命中 > 唯一活跃会话 > 启动期提示（标 spawn-time）> 启动解析；指纹命中多个或活跃会话多个时一律不猜，回退启动根并在 root_source 里写明「未猜测」且列出候选。3) tool-base 的 toolR/toolW/toolI 每次调用构造 RequestContext 并作为第二参传给处理器；把 11 个 registrar 的形参从 root 改名为 startupRoot，使任何漏改的处理器直接编译不过（编译器兜底，而非靠人肉检查）。4) 适配器不再伪造 --root，改为传 PM_MCP_CLIENT_ADAPTER/PM_MCP_ROOT_HINT(_SOURCE)，服务器据此报出真实依据；调用方自己钉了 --root 时不标记适配器，固定根完全受尊重。5) get_status 的 structuredContent 补齐 project/milestones/focus/health/last_session/since。

## 后果

代价：pm-mcp 现在认识 Qoder 的日志布局（已隔离在 caller-workspace.ts，且仅在适配器打了标记时启用，CLI/ZCode/直接 stdio 行为完全不变，有回归测试守住）；每次调用多约 30ms 日志扫描，故不做结果缓存；歧义时会退回报错而非给一个可能错的根。修正了 ADR-005 的错误前提（ppid 可定位会话），ADR-005 标记为被取代。放弃的方案：在适配器里做多路复用按工作区转发到多个子进程（要改写 JSON-RPC id、重放 initialize、转发 server→client 回调，协议风险远高于收益）；给每个工作区配一条 mcpServers 条目（违背「全局一条配置」且无法自动跟随新工作区）；继续用「取最新运行日志」（并发窗口下必然串项目，昨天已实测被带偏）。遗留：watcher 与 SQLite 索引仍只为启动根预热，其他工作区的 audit/search 首次会走全量走查（正确但较慢）。
