#!/usr/bin/env node
/** 入口与装配：解析项目根、创建 server、按域注册 tools/resources/prompts、启动 watcher。 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { resolveRootWithSource, recordRootResolution, isInitialized, ensurePmRuntimeIgnored } from "./paths.ts";
import { registerAllTools } from "./tools.ts";
import { registerResources } from "./resources.ts";
import { registerPrompts } from "./prompts.ts";
import { startWatcher } from "./index-store.ts";
import { logRuntime } from "./usage-log.ts";
import { VERSION } from "./version.ts";

/* 启动根只是默认值：--root 参数 > PM_ROOT > 适配器提示 > 已初始化的启动目录 > 客户端工作区提示 > 启动时工作目录。
   客户端（如 Qoder）会把一个常驻子进程复用给所有窗口，真正的调用方工作区由 caller-workspace 按请求认领。 */
const argv = process.argv.slice(2);
let explicitRoot: string | undefined;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--root" && argv[i + 1]) explicitRoot = argv[i + 1];
}
const resolution = resolveRootWithSource(explicitRoot);
recordRootResolution(resolution);
const root = resolution.root;

const server = new McpServer(
  { name: "pm-mcp", version: VERSION },
  {
    instructions: [
      `pm-mcp ${VERSION}。get_status 返回实际运行版本与项目根；配置修改后须重连核验。list_tasks 有 has_more 时保持过滤条件并使用 next_cursor 续取，不能把一页当全量。feature/fix 默认要求 tests_observed，未知计数不冒充测试通过。`,
      "多 Agent 规则：相同业务的所有写工具调用必须携带相同 idempotency_key（建议 task-id:operation）；同键同参数只执行一次，同键不同参数会被拒绝。",
      "完全相同的并行读请求会由服务端合并并复用结果；不要让多个分支重复请求同一工具和参数。",
      "看到“幂等复用”时直接采用首次结果；看到“幂等占位/正在执行”时等待负责该业务的 Agent，不要换键重试。",
    ].join(" "),
  },
);
registerAllTools(server, root);
registerResources(server, root);
registerPrompts(server);

/* ---------------------------------- 启动 ---------------------------------- */

await server.connect(new StdioServerTransport());
// 超大项目核心：server 常驻期间用递归 watcher 持续保鲜 SQLite 索引，
// audit/快照稳态下免全量走查（失败自动降级为纯走查模式）
if (isInitialized(root)) {
  ensurePmRuntimeIgnored(root);
  const watcher = startWatcher(root);
  console.error(`[pm-mcp] watcher coordinator: ${watcher ? "active（同项目单 leader）" : "unavailable（降级为按需全量走查）"}`);
  logRuntime(root, watcher ? "info" : "warn", watcher ? "watcher.active" : "watcher.unavailable", watcher ? undefined : "降级为按需全量走查");
}
logRuntime(root, "info", "server.ready", `pid=${process.pid} node=${process.versions.node}`);
// stdio 是协议通道，日志只能走 stderr
console.error(`[pm-mcp] ready. default project root: ${root} (source: ${resolution.source})`);
