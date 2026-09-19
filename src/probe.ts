import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { VERSION } from "./version.ts";

/**
 * 标准 raw tools/list 直连探针。
 *
 * 宿主（ZCode/Codex/Cursor）是唯一 MCP client 持有者，不向模型透传原始
 * `tools/list`；本探针绕过宿主，自己以 MCP client 身份直连服务器进程，
 * 拿协议线上的原始工具清单，并可与期望表比对（如 Codex allowlist）。
 */

export const PROBE_USAGE = "pm-mcp probe [--timeout <毫秒>] [--expect <逗号分隔工具名> | --expect-file <json>] -- <启动 MCP 服务器的命令...>";

export interface ProbeOptions { command: string; args: string[]; timeoutMs: number; expect?: string[]; env?: Record<string, string>; }
export interface ProbeTool { name: string; description?: string; inputSchema?: unknown; }
export interface ProbeReport {
  ok: boolean;
  command: string;
  args: string[];
  serverInfo?: { name?: string; version?: string };
  toolCount: number;
  tools: ProbeTool[];
  expect?: { expected: string[]; missing: string[]; extra: string[] };
  issues: string[];
}

export function parseProbeArgs(argv: string[]): ProbeOptions {
  const separator = argv.indexOf("--");
  const optionArgs = separator >= 0 ? argv.slice(0, separator) : argv;
  const serverArgs = separator >= 0 ? argv.slice(separator + 1) : [];
  const options: ProbeOptions = { command: "", args: [], timeoutMs: 30_000 };
  let expectSeen = 0;
  for (let index = 0; index < optionArgs.length; index++) {
    const arg = optionArgs[index], value = optionArgs[index + 1];
    if (arg === "--timeout") {
      const parsed = Number(value);
      if (!value || !Number.isFinite(parsed) || parsed <= 0) throw new Error(`probe 参数无效: ${arg} ${value ?? "(缺值)"}`);
      options.timeoutMs = parsed;
      index++;
    } else if (arg === "--expect" || arg === "--expect-file") {
      if (!value) throw new Error(`probe 参数无效: ${arg} (缺值)`);
      if (++expectSeen > 1) throw new Error("--expect 与 --expect-file 只能用一个。");
      options.expect = arg === "--expect" ? parseExpectList(value) : readExpectFile(value);
      index++;
    } else throw new Error(`probe 参数无效: ${arg}。用法：${PROBE_USAGE}`);
  }
  if (separator < 0 || serverArgs.length === 0) throw new Error(`缺少 "-- <服务器启动命令>"。用法：${PROBE_USAGE}`);
  if (serverArgs.includes("--")) throw new Error("服务器启动命令内部不能再出现 -- 分隔符。");
  options.command = serverArgs[0];
  options.args = serverArgs.slice(1);
  return options;
}

function parseExpectList(value: string): string[] {
  const names = [...new Set(value.split(",").map((name) => name.trim()).filter(Boolean))];
  if (names.length === 0) throw new Error("--expect 至少需要一个工具名。");
  return names;
}

/** 期望表接受：字符串数组、上一轮 probe 报告、或 {tools:[名字|{name}]}。 */
function readExpectFile(file: string): string[] {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) throw new Error("expect 文件必须为有界普通文件，禁止链接。");
  let parsed: unknown;
  try { parsed = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) { throw new Error(`expect 文件不是合法 JSON：${(error as Error).message}`); }
  const list = Array.isArray(parsed) ? parsed
    : Array.isArray((parsed as { tools?: unknown } | null)?.tools) ? (parsed as { tools: unknown[] }).tools
    : undefined;
  if (!list) throw new Error("expect 文件格式不识别：应为字符串数组、probe 报告或 {tools:[...]}。");
  const names = [...new Set(list.map((entry) => typeof entry === "string" ? entry : (entry as { name?: unknown })?.name)
    .filter((name): name is string => typeof name === "string" && name.length > 0))];
  if (names.length === 0) throw new Error("expect 文件里没有可识别的工具名。");
  return names;
}

export async function runProbe(options: ProbeOptions): Promise<ProbeReport> {
  const timeoutMs = options.timeoutMs;
  const report: ProbeReport = { ok: false, command: options.command, args: options.args, toolCount: 0, tools: [], issues: [] };
  const client = new Client({ name: "pm-mcp-probe", version: VERSION });
  // env 为覆盖式合并（SDK 先取默认安全白名单再覆盖），供 PM_MCP_HOME 之类的沙箱重定向。
  const transport = new StdioClientTransport({ command: options.command, args: options.args, stderr: "pipe", env: options.env });
  try {
    await client.connect(transport, { timeout: timeoutMs });
    transport.stderr?.on("data", () => undefined);
    const info = client.getServerVersion();
    if (info) report.serverInfo = { name: info.name, version: info.version };
    const tools: ProbeTool[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : {}, { timeout: timeoutMs });
      for (const tool of page.tools) tools.push({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema });
      cursor = page.nextCursor;
    } while (cursor);
    report.tools = tools;
    report.toolCount = tools.length;
    if (tools.length === 0) report.issues.push("服务器未暴露任何工具。");
    if (options.expect) {
      const actual = new Set(tools.map((tool) => tool.name));
      const expected = [...new Set(options.expect)];
      const missing = expected.filter((name) => !actual.has(name));
      const extra = tools.map((tool) => tool.name).filter((name) => !expected.includes(name));
      report.expect = { expected, missing, extra };
      if (missing.length > 0) report.issues.push(`服务器未暴露 ${missing.length} 个期望工具: ${missing.join(", ")}`);
      if (extra.length > 0) report.issues.push(`服务器暴露了 ${extra.length} 个期望之外的工具: ${extra.join(", ")}`);
    }
    report.ok = report.issues.length === 0;
  } catch (error) {
    report.issues.push(`raw tools/list 探测失败: ${(error as Error).message}`);
  } finally {
    await client.close().catch(() => undefined);
    hardKill(transport);
  }
  return report;
}

/** client.close() 正常会终止子进程；这里兜底清理仍存活的残留，避免夹具/服务器挂死。 */
function hardKill(transport: StdioClientTransport) {
  const pid = transport.pid;
  if (!pid) return;
  try { process.kill(pid, 0); } catch { return; }
  try {
    if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
    else process.kill(pid, "SIGKILL");
  } catch { /* 尽力而为 */ }
}
