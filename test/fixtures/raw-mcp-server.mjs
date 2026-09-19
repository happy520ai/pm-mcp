// 最小 raw stdio JSON-RPC MCP 服务器夹具：不经过 SDK，直接按协议线回答，
// 用于验证 pm-mcp probe 拿到的是标准 tools/list 原始响应。
// 用法：node raw-mcp-server.mjs [ok（默认，单页全量）| paged（nextCursor 翻页）| hang（收到 tools/list 后不回应）]
import readline from "node:readline";

const mode = process.argv[2] ?? "ok";
const alpha = { name: "alpha_tool", description: mode === "env" ? `env=${process.env.PROBE_ENV_PROOF ?? "unset"}` : "夹具工具 A", inputSchema: { type: "object", properties: {} } };
const beta = { name: "beta_tool", description: "夹具工具 B", inputSchema: { type: "object", properties: {} } };
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  let request;
  try { request = JSON.parse(line); } catch { return; }
  if (!request || typeof request.id === "undefined" || typeof request.method !== "string") return; // 通知直接忽略
  if (request.method === "initialize") {
    send({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "raw-fixture", version: "1.0.0" } } });
  } else if (request.method === "tools/list") {
    if (mode === "hang") return;
    if (mode === "paged" && !request.params?.cursor) send({ jsonrpc: "2.0", id: request.id, result: { tools: [alpha], nextCursor: "page-2" } });
    else send({ jsonrpc: "2.0", id: request.id, result: { tools: mode === "paged" ? [beta] : [alpha, beta] } });
  } else {
    send({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: `method not found: ${request.method}` } });
  }
});
