# ADR-013 ADR-013 同步简化为带安全门的 git push

- 日期: 2026-11-05
- 状态: 已接受

## 背景

ADR-011、ADR-012 按用户个人防泄露场景设计了全套出站同步工程（tier 分级、白名单+黑名单、age 客户端加密、离线批准 CLI、恢复演练）。随后用户澄清：pm-mcp 是开源产品，目标是让更多人来用；用户要同步的是自己的开源仓库代码，代码本身不保密。重方案对开源用户是使用负担而非保护。

## 决定

同步能力简化为「带安全门的 git push」，取代 ADR-011/ADR-012 的实现范围（两份决策历史保留，仅本 ADR 生效）：(a) 配置 .pm/sync.json 仅 enabled/remote/branch 三字段，支持零配置（用仓库已有 git remote）；(b) 命令 pm-mcp sync（status / push），推送前三步：git status 变更列表 → 密钥扫描（复用 security.ts，高危阻断）→ 展示 remote 地址与文件数并 y/N 确认，非 TTY 拒绝；(c) 不做 age 加密、tier 分级、白名单黑名单、manifest 哈希批准绑定、sync restore、watcher 防抖触发、sync-daemon；(d) 恢复即 git clone，不提供 restore；(e) AGENTS.md「禁止 git push」红线不变：编排会话不推送，只有用户在终端手动运行 pm-mcp sync 才推送；(f) MCP 工具侧不暴露 push 能力。

## 后果

代价：无实时同步与自动备份能力；换来的是实现量从 8 张任务卡降到 2 张、开源用户上手零负担。放弃：实时检测、客户端加密、多机守护（远期如需可另立 ADR）。泄露防线从多层收敛为一层密钥扫描加人工确认，扫描器漏检时依赖人工把关，这是简化方案的已知残余风险。
