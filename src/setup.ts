import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const PACKAGE_SPEC = "@luckychen1993/pm-mcp@0.1.3";
export const SERVER_NAME = "pm-mcp";

export type SetupClient = "auto" | "all" | "codex" | "claude" | "zcode" | "cursor" | "vscode" | "print";
type ConcreteClient = Exclude<SetupClient, "auto" | "all" | "print">;

export interface SetupOptions {
  client: SetupClient;
  force: boolean;
  dryRun: boolean;
  help: boolean;
}

export interface DetectionContext {
  env: NodeJS.ProcessEnv;
  home: string;
  commandExists: (command: string) => boolean;
  exists: (target: string) => boolean;
}

const CLIENTS: ConcreteClient[] = ["codex", "claude", "zcode", "cursor", "vscode"];

export function parseSetupArgs(argv: string[]): SetupOptions {
  const options: SetupOptions = { client: "auto", force: false, dryRun: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--client") {
      const value = argv[index + 1] as SetupClient | undefined;
      if (!value || !["auto", "all", "codex", "claude", "zcode", "cursor", "vscode", "print"].includes(value)) {
        throw new Error("--client must be auto, all, codex, claude, zcode, cursor, vscode, or print");
      }
      options.client = value;
      index += 1;
    } else if (arg === "--force") {
      options.force = true;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`unknown setup argument: ${arg}`);
    }
  }
  return options;
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
  return found;
}

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be a JSON object`);
  return value as Record<string, unknown>;
}

export function mergeJsonServer(document: unknown, shape: "zcode" | "standard"): Record<string, unknown> {
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
  servers[SERVER_NAME] = { command: "npx", args: ["-y", PACKAGE_SPEC], env: {} };
  return root;
}

function backupName(file: string): string {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "");
  return `${file}.backup-${stamp}-${process.pid}`;
}

export function writeJsonClientConfig(file: string, shape: "zcode" | "standard", dryRun = false): string | null {
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
  const merged = mergeJsonServer(document, shape);
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
): void {
  if (client === "codex") {
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
  if (!context.commandExists("code")) throw new Error("code was not found in PATH");
  const definition = JSON.stringify({ name: SERVER_NAME, command: "npx", args: ["-y", PACKAGE_SPEC] });
  log(`[${options.dryRun ? "plan" : "run"}] code --add-mcp ${definition}`);
  if (!options.dryRun && run("code", ["--add-mcp", definition], true) !== 0) throw new Error("VS Code could not add pm-mcp");
}

function printHelp(log: (message: string) => void): void {
  log("pm-mcp setup — configure local AI coding clients");
  log("");
  log(`Usage: npx -y ${PACKAGE_SPEC} setup [--client auto|all|codex|claude|zcode|cursor|vscode|print] [--force] [--dry-run]`);
  log("Default auto mode configures every detected supported client.");
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
    log(JSON.stringify({ mcpServers: { [SERVER_NAME]: { command: "npx", args: ["-y", PACKAGE_SPEC], env: {} } } }, null, 2));
    return 0;
  }
  const env = overrides.env ?? process.env;
  const home = overrides.home ?? os.homedir();
  const context: DetectionContext = {
    env,
    home,
    commandExists: overrides.commandExists ?? ((command) => commandExists(command, env)),
    exists: overrides.exists ?? fs.existsSync,
  };
  const selected = options.client === "all"
    ? CLIENTS
    : options.client === "auto"
      ? detectClients(context)
      : [options.client];
  if (selected.length === 0) {
    log("No supported client was detected. Use --client <name>, or --client print for generic JSON.");
    return 1;
  }
  log(`pm-mcp setup ${PACKAGE_SPEC}`);
  log(`clients: ${selected.join(", ")}`);
  let failures = 0;
  for (const client of selected) {
    try {
      configureClient(client, options, context, log);
    } catch (error) {
      failures += 1;
      console.error(`[failed] ${client}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (failures > 0) return 1;
  log("Done. Restart the configured client and ask it to call pm-mcp get_status.");
  return 0;
}
