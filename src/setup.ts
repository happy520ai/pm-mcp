import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { initProject } from "./init.ts";
import { isInitialized } from "./paths.ts";
import { refreshDerived } from "./dashboard.ts";

import { PACKAGE_SPEC, SERVER_NAME } from "./version.ts";
export { PACKAGE_SPEC, SERVER_NAME } from "./version.ts";
import { appendCodexProjectConfig } from "./setup-project.ts";
export { appendCodexProjectConfig, codexProjectServerKey } from "./setup-project.ts";

export type SetupClient = "auto" | "all" | "codex" | "claude" | "zcode" | "cursor" | "vscode" | "workbuddy" | "print";
type ConcreteClient = Exclude<SetupClient, "auto" | "all" | "print">;

export interface SetupOptions {
  client: SetupClient;
  force: boolean;
  dryRun: boolean;
  help: boolean;
  /** --project：把当前（或指定）目录按项目钉定注册到 Codex 并初始化 .pm（新项目一条命令上手） */
  project: boolean;
  projectDir?: string;
  local?: boolean;
}

export interface DetectionContext {
  env: NodeJS.ProcessEnv;
  home: string;
  cwd?: string;
  commandExists: (command: string) => boolean;
  exists: (target: string) => boolean;
}

const CLIENTS: ConcreteClient[] = ["codex", "claude", "zcode", "cursor", "vscode", "workbuddy"];

export function parseSetupArgs(argv: string[]): SetupOptions {
  const options: SetupOptions = { client: "auto", force: false, dryRun: false, help: false, project: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--client") {
      const value = argv[index + 1] as SetupClient | undefined;
      if (!value || !["auto", "all", "codex", "claude", "zcode", "cursor", "vscode", "workbuddy", "print"].includes(value)) {
        throw new Error("--client must be auto, all, codex, claude, zcode, cursor, vscode, workbuddy, or print");
      }
      options.client = value;
      index += 1;
    } else if (arg === "--project") {
      options.project = true;
      const value = argv[index + 1];
      if (value && !value.startsWith("--")) {
        options.projectDir = value;
        index += 1;
      }
    } else if (arg === "--force") {
      options.force = true;
    } else if (arg === "--local") {
      options.local = true;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`unknown setup argument: ${arg}`);
    }
  }
  if (options.local && options.client !== "codex" && options.client !== "workbuddy" && options.client !== "print") throw new Error("--local 目前只支持 --client codex、workbuddy 或 print");
  if (options.local && options.client === "codex" && !options.project) throw new Error("Codex --local 需要 --project 明确项目根");
  return options;
}

/**
 * 本地已构建入口的启动定义。
 *
 * root 省略时不写 `--root`：宿主客户端会把**会话工作区**作为子进程 cwd，
 * 服务端按 cwd 解析项目根。WorkBuddy 这类多项目宿主依赖这一行为，
 * 显式钉根反而会把所有工作区都指到同一个项目。
 */
export function localServerLaunch(root?: string) {
  const entry = fileURLToPath(new URL("../dist/index.js", import.meta.url));
  if (!fs.existsSync(entry) || !fs.lstatSync(entry).isFile()) throw new Error("本地入口未构建，请先 npm run build。");
  return { command: process.execPath, args: root ? [entry, "--root", path.resolve(root)] : [entry] };
}

/** 钉定单个项目根的本地启动定义（Codex `--project` 等场景）。 */
export function localProjectLaunch(root: string) {
  return localServerLaunch(root);
}

export function commandExists(command: string, env: NodeJS.ProcessEnv = process.env, platform = process.platform): boolean {
  const searchPath = env.PATH ?? env.Path ?? "";
  const suffixes = platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  return searchPath.split(path.delimiter).filter(Boolean).some((directory) =>
    suffixes.some((suffix) => {
      try {
        return fs.statSync(path.join(directory, command + suffix)).isFile();
      } catch {
        return false;
      }
    }),
  );
}

export function detectClients(context: DetectionContext): ConcreteClient[] {
  const found: ConcreteClient[] = [];
  const { env, home, exists } = context;
  if (context.commandExists("codex") || Boolean(env.CODEX_HOME) || exists(path.join(home, ".codex"))) found.push("codex");
  if (context.commandExists("claude")) found.push("claude");
  if (context.commandExists("zcode") || Boolean(env.ZCODE_HOME) || exists(path.join(home, ".zcode"))) found.push("zcode");
  if (context.commandExists("cursor") || exists(path.join(home, ".cursor"))) found.push("cursor");
  if (context.commandExists("code")) found.push("vscode");
  // WorkBuddy 桌面版：`codebuddy`/`workbuddy` 命令、WORKBUDDY_CONFIG_DIR，或既有配置目录任一命中即视为已安装。
  if (context.commandExists("workbuddy") || context.commandExists("codebuddy") || Boolean(env.WORKBUDDY_CONFIG_DIR) || exists(path.join(home, ".workbuddy-ai")) || exists(path.join(home, ".workbuddy"))) found.push("workbuddy");
  return found;
}

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be a JSON object`);
  return value as Record<string, unknown>;
}

/** JSON 客户端配置里写入的 server 启动定义。 */
export interface JsonServerLaunch {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

function defaultJsonLaunch(): JsonServerLaunch {
  return { command: "npx", args: ["-y", PACKAGE_SPEC], env: {} };
}

export function mergeJsonServer(
  document: unknown,
  shape: "zcode" | "standard",
  launch: JsonServerLaunch = defaultJsonLaunch(),
): Record<string, unknown> {
  const root = asObject(document, "configuration root");
  let servers: Record<string, unknown>;
  if (shape === "zcode") {
    const mcp = root.mcp === undefined ? (root.mcp = {}) : root.mcp;
    const mcpObject = asObject(mcp, "mcp");
    const currentServers = mcpObject.servers === undefined ? (mcpObject.servers = {}) : mcpObject.servers;
    servers = asObject(currentServers, "mcp.servers");
  } else {
    const currentServers = root.mcpServers === undefined ? (root.mcpServers = {}) : root.mcpServers;
    servers = asObject(currentServers, "mcpServers");
  }
  servers[SERVER_NAME] = { ...launch, env: launch.env ?? {} };
  return root;
}

function backupName(file: string): string {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "");
  return `${file}.backup-${stamp}-${process.pid}-${randomUUID()}`;
}

export function writeJsonClientConfig(file: string, shape: "zcode" | "standard", dryRun = false, launch?: JsonServerLaunch): string | null {
  const absolute = path.resolve(file);
  const exists = fs.existsSync(absolute);
  let document: unknown = {};
  if (exists) {
    const stat = fs.lstatSync(absolute);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`refusing non-regular config file: ${absolute}`);
    try {
      document = JSON.parse(fs.readFileSync(absolute, "utf8"));
    } catch (error) {
      throw new Error(`invalid JSON in ${absolute}; no changes made: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const merged = mergeJsonServer(document, shape, launch);
  if (dryRun) return null;
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  const backup = exists ? backupName(absolute) : null;
  if (backup) fs.copyFileSync(absolute, backup, fs.constants.COPYFILE_EXCL);
  const temporary = `${absolute}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(merged, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
    fs.renameSync(temporary, absolute);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch { /* nothing to clean */ }
    throw error;
  }
  return backup;
}

function codexConfigPath(env: NodeJS.ProcessEnv, home: string): string {
  return path.join(env.CODEX_HOME || path.join(home, ".codex"), "config.toml");
}

function zcodeConfigPath(env: NodeJS.ProcessEnv, home: string): string {
  return path.join(env.ZCODE_HOME || path.join(home, ".zcode"), "cli", "config.json");
}

/**
 * WorkBuddy 桌面版的用户级 MCP 配置路径。
 *
 * 优先级：`WORKBUDDY_CONFIG_DIR` → `~/.workbuddy-ai`（当前版本数据目录）→ `~/.workbuddy`（旧版目录）→ 默认当前版本目录。
 * 文件名固定 `mcp.json`，结构为标准 `{ "mcpServers": { ... } }`。
 *
 * 注意：WorkBuddy 的 MCP 子进程由会话工作区拉起，cwd 即当前项目，
 * 因此这里**不写 `--root`**，一个条目即可服务所有工作区。
 */
export function workbuddyConfigPath(env: NodeJS.ProcessEnv, home: string, exists: (target: string) => boolean): string {
  if (env.WORKBUDDY_CONFIG_DIR) return path.join(env.WORKBUDDY_CONFIG_DIR, "mcp.json");
  const current = path.join(home, ".workbuddy-ai");
  if (exists(current)) return path.join(current, "mcp.json");
  const legacy = path.join(home, ".workbuddy");
  if (exists(legacy)) return path.join(legacy, "mcp.json");
  return path.join(current, "mcp.json");
}

function hasCodexServer(text: string): boolean {
  return /^\s*\[mcp_servers\.(?:pm-mcp|"pm-mcp")\]\s*$/m.test(text);
}

function appendCodexConfig(file: string, dryRun: boolean, log: (message: string) => void): void {
  const absolute = path.resolve(file);
  const existing = fs.existsSync(absolute) ? fs.readFileSync(absolute, "utf8") : "";
  if (hasCodexServer(existing)) {
    log(`[skip] Codex already has ${SERVER_NAME}; use --force with the Codex CLI to replace it.`);
    return;
  }
  log(`[${dryRun ? "plan" : "write"}] Codex: ${absolute}`);
  if (dryRun) return;
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  if (fs.existsSync(absolute)) fs.copyFileSync(absolute, backupName(absolute), fs.constants.COPYFILE_EXCL);
  const separator = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
  const block = `${separator}\n[mcp_servers.${SERVER_NAME}]\ncommand = "npx"\nargs = ["-y", "${PACKAGE_SPEC}"]\n`;
  fs.appendFileSync(absolute, block, "utf8");
}

function run(command: string, args: string[], visible: boolean): number {
  const result = spawnSync(command, args, {
    shell: false,
    windowsHide: true,
    stdio: visible ? "inherit" : "ignore",
  });
  if (result.error) return -1;
  return result.status ?? -1;
}

function configureCliClient(
  client: "codex" | "claude",
  options: SetupOptions,
  available: boolean,
  log: (message: string) => void,
): boolean {
  if (!available) return false;
  const getArgs = ["mcp", "get", SERVER_NAME];
  const exists = run(client, getArgs, false) === 0;
  if (exists && !options.force) {
    log(`[skip] ${client} already has ${SERVER_NAME}; run setup --force to replace it.`);
    return true;
  }
  const addArgs = client === "codex"
    ? ["mcp", "add", SERVER_NAME, "--", "npx", "-y", PACKAGE_SPEC]
    : ["mcp", "add", SERVER_NAME, "--scope", "user", "--", "npx", "-y", PACKAGE_SPEC];
  log(`[${options.dryRun ? "plan" : "run"}] ${client} ${addArgs.join(" ")}`);
  if (options.dryRun) return true;
  if (exists && run(client, ["mcp", "remove", SERVER_NAME], true) !== 0) throw new Error(`${client} could not remove the existing server`);
  if (run(client, addArgs, true) !== 0) throw new Error(`${client} could not add ${SERVER_NAME}`);
  return true;
}

function configureClient(
  client: ConcreteClient,
  options: SetupOptions,
  context: DetectionContext,
  log: (message: string) => void,
  projectRoot?: string,
): void {
  if (client === "codex") {
    if (options.project && projectRoot) {
      appendCodexProjectConfig(codexConfigPath(context.env, context.home), projectRoot, options.force, options.dryRun, log, options.local ? localProjectLaunch(projectRoot) : undefined);
      return;
    }
    if (configureCliClient("codex", options, context.commandExists("codex"), log)) return;
    appendCodexConfig(codexConfigPath(context.env, context.home), options.dryRun, log);
    return;
  }
  if (client === "claude") {
    if (!configureCliClient("claude", options, context.commandExists("claude"), log)) throw new Error("claude was not found in PATH");
    return;
  }
  if (client === "zcode" || client === "cursor") {
    const file = client === "zcode" ? zcodeConfigPath(context.env, context.home) : path.join(context.home, ".cursor", "mcp.json");
    log(`[${options.dryRun ? "plan" : "write"}] ${client}: ${file}`);
    const backup = writeJsonClientConfig(file, client === "zcode" ? "zcode" : "standard", options.dryRun);
    if (backup) log(`[backup] ${backup}`);
    return;
  }
  if (client === "workbuddy") {
    const file = workbuddyConfigPath(context.env, context.home, context.exists);
    log(`[${options.dryRun ? "plan" : "write"}] workbuddy: ${file}`);
    // 默认写 npx 发布版；--local 绑定已构建入口，未发布候选走这条路径。
    const launch = options.local ? localServerLaunch() : undefined;
    const backup = writeJsonClientConfig(file, "standard", options.dryRun, launch);
    if (backup) log(`[backup] ${backup}`);
    return;
  }
  if (!context.commandExists("code")) throw new Error("code was not found in PATH");
  const definition = JSON.stringify({ name: SERVER_NAME, command: "npx", args: ["-y", PACKAGE_SPEC] });
  log(`[${options.dryRun ? "plan" : "run"}] code --add-mcp ${definition}`);
  if (!options.dryRun && run("code", ["--add-mcp", definition], true) !== 0) throw new Error("VS Code could not add pm-mcp");
}

function printHelp(log: (message: string) => void): void {
  log("pm-mcp setup — configure local AI coding clients");
  log("");
  log(`Usage: npx -y ${PACKAGE_SPEC} setup [--client auto|all|codex|claude|zcode|cursor|vscode|workbuddy|print] [--project [dir]] [--force] [--dry-run] [--local]`);
  log("Default auto mode configures every detected supported client.");
  log("--project [dir]: 在 Codex 把该目录注册为钉定项目并初始化 .pm（新项目一条命令上手；默认当前目录）");
  log("--local: 使用本包已构建的本地入口，适合未发布候选；--force 仅升级已确认项目的 command/args。");
  log("workbuddy: 写入 <WorkBuddy 数据目录>/mcp.json（标准 mcpServers），不钉根——服务端按会话工作区解析项目根。");
  log("升级后运行 pm-mcp doctor --root <项目目录> 核验；现有客户端仍需重新连接。");
}

export function runSetup(
  argv: string[],
  overrides: Partial<DetectionContext> & { log?: (message: string) => void } = {},
): number {
  const options = parseSetupArgs(argv);
  const log = overrides.log ?? console.log;
  if (options.help) {
    printHelp(log);
    return 0;
  }
  if (options.client === "print") {
    const launch = options.local ? localProjectLaunch(options.projectDir ?? overrides.cwd ?? process.cwd()) : { command: "npx", args: ["-y", PACKAGE_SPEC] };
    log(JSON.stringify({ mcpServers: { [SERVER_NAME]: { ...launch, env: {} } } }, null, 2));
    return 0;
  }
  const env = overrides.env ?? process.env;
  const home = overrides.home ?? os.homedir();
  const context: DetectionContext = {
    env,
    home,
    cwd: overrides.cwd,
    commandExists: overrides.commandExists ?? ((command) => commandExists(command, env)),
    exists: overrides.exists ?? fs.existsSync,
  };
  const projectRoot = options.project ? path.resolve(options.projectDir?.trim() || context.cwd || process.cwd()) : undefined;
  const selected = options.client === "all"
    ? CLIENTS
    : options.client === "auto"
      ? detectClients(context)
      : [options.client];
  if (selected.length === 0 && !options.project) {
    log("No supported client was detected. Use --client <name>, or --client print for generic JSON.");
    return 1;
  }
  log(`pm-mcp setup ${PACKAGE_SPEC}`);
  if (selected.length > 0) log(`clients: ${selected.join(", ")}`);
  if (options.project && projectRoot) {
    const name = path.basename(projectRoot) || "project";
    log(`project: ${projectRoot}`);
    if (options.dryRun) {
      log(`[plan] init_project ${name}（.pm/ + PROJECT.md + AGENTS.md 工作规矩）`);
    } else if (isInitialized(projectRoot)) {
      log("[skip] 项目已初始化（.pm/project.json 已存在）。");
    } else {
      initProject(projectRoot, { name });
      refreshDerived(projectRoot);
      log(`[init] ✅ ${name} 已初始化：.pm/ 状态目录 + PROJECT.md 仪表盘 + AGENTS.md 工作规矩`);
    }
  }
  let failures = 0;
  for (const client of selected) {
    try {
      configureClient(client, options, context, log, projectRoot);
    } catch (error) {
      failures += 1;
      console.error(`[failed] ${client}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (failures > 0) return 1;
  if (options.project && selected.includes("codex")) {
    log("完成。请完全退出并重启 Codex，开新会话即可使用（工具名前缀 pm-mcp-<项目名>）。");
  } else if (selected.length === 1 && selected[0] === "workbuddy") {
    log("完成。请在 WorkBuddy 的「连接器管理 → 自定义连接器」中确认信任 pm-mcp，再重开会话调用 get_status 核验。");
  } else {
    // 多客户端时逐条给出各自的重连/授权要求，避免只提其中一个造成误导。
    const notes: string[] = [];
    if (selected.includes("workbuddy")) notes.push("WorkBuddy 需在「连接器管理 → 自定义连接器」确认信任 pm-mcp");
    if (selected.includes("codex")) notes.push("Codex 需完全退出并重启");
    log(notes.length > 0
      ? `完成。重启已配置的客户端后调用 get_status 核验；${notes.join("；")}。`
      : "Done. Restart the configured client and ask it to call pm-mcp get_status.");
  }
  return 0;
}
