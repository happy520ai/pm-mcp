# GitHub CI 首轮失败证据 — v0.1.0

- Run: https://github.com/happy520ai/pm-mcp/actions/runs/33715832154
- Commit: `e3773f574a9dad37a72f32e8a7206288988f34ec`
- 结论: 失败；不得用本地通过覆盖本结果。

## Node 24.x

- Job `100524704585` 在 `npm run coverage` 失败。
- 182/183 测试通过；失败项为“真实 PROJECT.md 与状态同步”。
- 原因：Git checkout 后多个验收报告 mtime 相同，仪表盘按 mtime 选择了旧报告。

## Node 22.18.0

- Job `100524704735` 在 `npm run coverage` 失败。
- 181/183 测试通过。
- 除同一仪表盘问题外，两个 MCP 进程并发启动时，其中一个在 `PRAGMA journal_mode=WAL` 报 `database is locked`；当时 `busy_timeout` 尚未设置。

## 修复验收

- 最新报告按报告内 `report_generated_at` 排序，并新增相同 mtime 回归测试。
- SQLite 在执行 WAL PRAGMA 前先设置 `busy_timeout`。
- 必须由后续 GitHub Actions Node 22.18 与 Node 24 两个 job 均通过后，才允许创建 `v0.1.0` Release。
