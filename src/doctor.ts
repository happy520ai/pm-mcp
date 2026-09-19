import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { PACKAGE_SPEC, RUNTIME_CONTRACT, SERVER_NAME, VERSION } from "./version.ts";
import { canonicalProjectRoot, findCodexProjectEntry, isLocalLaunch, isLocalServerEntry, isPackageLaunch, readCodexConfig, type ProjectLaunch } from "./setup-project.ts";
import { localProjectLaunch, workbuddyConfigPath } from "./setup.ts";

export interface DoctorOptions { root: string; entry?: string; config?: string; client?: "codex" | "workbuddy"; }
export function parseDoctorArgs(argv: string[]): DoctorOptions {
  const options: DoctorOptions = { root: process.cwd() };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index], value = argv[index + 1];
    if (!["--root", "--entry", "--config", "--client"].includes(arg) || !value || value.startsWith("--")) throw new Error(`doctor 参数无效: ${arg}`);
    if (arg === "--root") options.root = path.resolve(value);
    if (arg === "--entry") options.entry = path.resolve(value);
    if (arg === "--config") options.config = path.resolve(value);
    if (arg === "--client") {
      if (value !== "codex" && value !== "workbuddy") throw new Error("doctor 支持 --client codex|workbuddy，其他客户端可用 --entry 验证本地入口。");
      options.client = value;
    }
    index++;
  }
  if (options.entry && options.config) throw new Error("--entry 与 --config 不能同时使用。");
  return options;
}

/**
 * 从 WorkBuddy 的 `mcp.json` 中取出 pm-mcp 条目。
 *
 * 只读取启动定义（command/args），不复制也不输出任何自定义 env / 凭据。
 * 文件必须是**有界普通文件**：链接、目录、超 2MB 一律拒绝。
 */
function readWorkbuddyEntry(file: string): ProjectLaunch | undefined {
  if (!fs.existsSync(file)) return undefined;
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) throw new Error("WorkBuddy 配置必须为有界普通文件，禁止链接。");
  let parsed: unknown;
  try { parsed = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) { throw new Error(`WorkBuddy 配置不是合法 JSON：${(error as Error).message}`); }
  const servers = (parsed as { mcpServers?: Record<string, { command?: unknown; args?: unknown; disabled?: unknown }> } | null)?.mcpServers;
  const entry = servers?.[SERVER_NAME];
  if (!entry) return undefined;
  if (entry.disabled === true) throw new Error("WorkBuddy 中 pm-mcp 条目被禁用，现有客户端不会启动它。");
  if (typeof entry.command !== "string" || entry.command.length === 0) throw new Error("WorkBuddy 中 pm-mcp 条目缺少可识别的 command。");
  const args = entry.args === undefined ? [] : entry.args;
  if (!Array.isArray(args) || !args.every((value) => typeof value === "string")) throw new Error("WorkBuddy 中 pm-mcp 条目的 args 不是字符串数组。");
  return { command: entry.command, args: args as string[] };
}

/** 短期本地读连接；不把探测新进程冒充已重新连接的客户端。 */
export async function runDoctor(options: DoctorOptions) {
  const root = path.resolve(options.root);
  const report: { ok: boolean; expected_version: string; root: string; configuration: string; configured_server?: string; probe?: Record<string, unknown>; issues: string[]; existing_client: string; note: string } = {
    ok: false, expected_version: VERSION, root, configuration: options.entry ? "explicit_entry" : (options.client ?? "codex"), issues: [],
    existing_client: "not_observed", note: "这是新建的本地探测连接。现有客户端须重新连接，并在其中调用 get_status 核对运行版本；未读取或转发自定义凭据环境。",
  };
  let launch: ProjectLaunch;
  try {
    if (options.entry) launch = { command: process.execPath, args: [options.entry, "--root", root] };
    else if (options.client === "workbuddy") {
      const file = options.config ?? workbuddyConfigPath(process.env, os.homedir(), fs.existsSync);
      const entry = readWorkbuddyEntry(file);
      if (!entry) throw new Error("未在 WorkBuddy 的 mcp.json 中找到 pm-mcp 条目。");
      report.configured_server = SERVER_NAME;
      if (!isLocalServerEntry(entry)) throw new Error("WorkBuddy 中的 pm-mcp 不是可识别的本地 pm-mcp 启动项；未执行未知启动命令。");
      // 配置通常不钉根（由会话工作区决定）；探测需要明确目标根，故补上 --root。
      launch = entry.args.includes("--root") ? entry : { command: entry.command, args: [...entry.args, "--root", root] };
      report.configuration = "workbuddy_local_probe";
    } else {
      if (!options.config && fs.existsSync(path.join(root, ".codex", "config.toml"))) throw new Error("存在项目级 Codex 配置，可能覆盖全局设置；请用 --config 明确核验的配置文件并检查实际客户端。");
      const file = options.config ?? path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "config.toml");
      const entry = findCodexProjectEntry(readCodexConfig(file), root);
      if (!entry) throw new Error("未找到已明确绑定此项目的 Codex pm-mcp 配置。");
      report.configured_server = entry.name;
      if (!entry.enabled) throw new Error("该服务在配置中被禁用，现有客户端不会启动它。");
      if (entry.toolFilters) throw new Error("存在工具过滤设置，请核对后再确认全部49工具可用。");
      if (isPackageLaunch(entry)) {
        if (entry.args[1] !== PACKAGE_SPEC) throw new Error(`启动配置版本与本包 ${PACKAGE_SPEC} 不一致，请先预览并升级配置。`);
        launch = localProjectLaunch(root);
        report.configuration = "codex_package_matches_local_probe";
      } else launch = entry;
    }
    if (!isLocalLaunch(launch)) throw new Error("探测入口不是可识别的本地 pm-mcp 包；不执行未知启动命令。");
  } catch (error) { report.issues.push((error as Error).message); return report; }

  const client = new Client({ name: "pm-mcp-doctor", version: VERSION });
  const transport = new StdioClientTransport({ command: launch.command, args: launch.args,
    env: { PM_MCP_HOME: path.join(root, ".pm", ".runtime", "doctor-home") }, stderr: "pipe" });
  const timer = setTimeout(() => { void client.close(); }, 20_000);
  timer.unref();
  try {
    await client.connect(transport, { timeout: 10_000 });
    transport.stderr?.on("data", () => undefined);
    const info = client.getServerVersion();
    const inventory = await client.listTools({}, { timeout: 10_000 });
    const status = await client.callTool({ name: "get_status", arguments: {} }, undefined, { timeout: 10_000 });
    const runtime = (status.structuredContent as Record<string, unknown> | undefined)?.runtime as { root?: string; version?: string; contract?: string } | undefined;
    report.probe = { server: info?.name, version: info?.version, tools: inventory.tools.length, runtime };
    if (info?.name !== SERVER_NAME || info.version !== VERSION) report.issues.push("握手返回的服务名或运行版本不匹配。");
    if (status.isError || typeof runtime?.root !== "string" || canonicalProjectRoot(runtime.root) !== canonicalProjectRoot(root)) report.issues.push("实际状态读取未确认目标项目根。");
    if (runtime?.version !== VERSION || runtime?.contract !== RUNTIME_CONTRACT) report.issues.push("实际运行契约不支持本轮升级，不能仅凭配置宣称生效。");
    const list = inventory.tools.find((tool) => tool.name === "list_tasks");
    const project = inventory.tools.find((tool) => tool.name === "update_project");
    if (inventory.tools.length !== 49 || !list?.inputSchema.properties?.cursor || !project?.inputSchema.properties?.completion_evidence) report.issues.push("工具目录或新参数契约不完整。");
    report.ok = report.issues.length === 0;
  } catch (error) { report.issues.push(`本地连接验证失败: ${(error as Error).message}`); }
  finally { clearTimeout(timer); await client.close(); }
  return report;
}
