#!/usr/bin/env node
/* Qoder 客户端适配器。实测事实：Qoder 主进程只派生一个常驻 stdio 子进程，并用本地路由把
   所有窗口/会话复用到它上面（同一 server uuid、不同 session token），子进程 cwd 是安装目录。
   因此启动期解析出的工作区只能是「默认值」，绝不能当成 --root 钉死，否则别的窗口会读到错项目。
   本适配器的职责：把客户端标记与启动期提示如实交给服务器，由服务器在每次调用时反查真正的调用方工作区。 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CLIENT_ADAPTER_ENV, QODER_ADAPTER, ROOT_HINT_ENV, ROOT_HINT_SOURCE_ENV } from "./caller-workspace.ts";

const PLACEHOLDER = /\$\{[^}]*\}/;

export function usableDir(value: string | undefined | null): string | null {
  const trimmed = value?.trim() ?? "";
  if (!trimmed || PLACEHOLDER.test(trimmed)) return null;
  const resolved = path.resolve(trimmed);
  try {
    return fs.statSync(resolved).isDirectory() ? resolved : null;
  } catch {
    return null;
  }
}

/** 显式给了 QODER_CONFIG_DIR 就只看它，避免真实 ~/.qoder-cn 混进隔离环境 */
function configDirs(env: NodeJS.ProcessEnv): string[] {
  const fromEnv = usableDir(env.QODER_CONFIG_DIR);
  if (fromEnv) return [fromEnv];
  const home = os.homedir();
  return [path.join(home, ".qoder-cn"), path.join(home, ".qoder")];
}

/** 运行日志目录名虽然以 `-p<pid>` 结尾，但 Qoder 所有会话共用主进程 pid，ppid 无法区分会话；
    启动期只能取「最近在写」的那份日志作为默认提示，真正的认领交给服务器按请求指纹完成。 */
export function workspaceFromRunLog(options: { env?: NodeJS.ProcessEnv; limit?: number } = {}): string | null {
  const env = options.env ?? process.env;
  const candidates: Array<{ file: string; mtime: number }> = [];
  for (const dir of configDirs(env)) {
    const runs = path.join(dir, "logs", "runs");
    let names: string[];
    try {
      names = fs.readdirSync(runs);
    } catch {
      continue;
    }
    for (const name of names) {
      const file = path.join(runs, name, "qodercli.log");
      try {
        const stat = fs.statSync(file);
        if (stat.isFile()) candidates.push({ file, mtime: stat.mtimeMs });
      } catch {
        continue;
      }
    }
  }
  const limit = options.limit ?? 8;
  for (const candidate of candidates.sort((a, b) => b.mtime - a.mtime).slice(0, limit)) {
    let head = "";
    try {
      head = fs.readFileSync(candidate.file, "utf8").slice(0, 8192);
    } catch {
      continue;
    }
    const match = /initial_cwd=([\s\S]*?)\s+restore_cwd=/.exec(head);
    const root = usableDir(match?.[1]);
    if (root) return root;
  }
  return null;
}

export function resolveQoderWorkspace(env: NodeJS.ProcessEnv = process.env): { root: string; source: string } | null {
  const fromEnv = usableDir(env.QODER_WORKER_CWD);
  if (fromEnv) return { root: fromEnv, source: "QODER_WORKER_CWD" };
  const fromLog = workspaceFromRunLog({ env });
  if (fromLog) return { root: fromLog, source: "qodercli run log" };
  return null;
}

/** 调用方自己钉了 --root 时完全尊重它：不标记适配器，服务器就不会按请求改根 */
export function qoderLaunchEnv(
  argv: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  if (argv.includes("--root")) return env;
  const resolved = resolveQoderWorkspace(env);
  return {
    ...env,
    [CLIENT_ADAPTER_ENV]: QODER_ADAPTER,
    ...(resolved ? { [ROOT_HINT_ENV]: resolved.root, [ROOT_HINT_SOURCE_ENV]: resolved.source } : {}),
  };
}

/** 参数原样透传：适配器不再伪造 --root，免得服务器把动态解析的依据报成「启动参数写死」 */
export function qoderLaunchArgs(argv: string[] = process.argv.slice(2)): string[] {
  return argv;
}

export function qoderServerEntry(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = ["index.js", "index.ts"].map((name) => path.resolve(here, name));
  return candidates.find((file) => fs.existsSync(file)) ?? candidates[0]!;
}

export function runQoderLaunch(argv: string[] = process.argv.slice(2)): void {
  const env = qoderLaunchEnv(argv);
  const pinned = argv.includes("--root");
  if (pinned) {
    console.error("[pm-mcp qoder-launch] 调用方已钉 --root，按固定项目根运行（不做按请求认领）");
  } else if (env[ROOT_HINT_ENV]) {
    console.error(`[pm-mcp qoder-launch] 启动期默认根: ${env[ROOT_HINT_ENV]} (source: ${env[ROOT_HINT_SOURCE_ENV]})；每次调用会按会话日志重新认领工作区`);
  } else {
    console.error("[pm-mcp qoder-launch] 启动期未取到 Qoder 工作区，交给服务器按请求认领（get_status 会报告依据）");
  }
  const child = spawn(process.execPath, [qoderServerEntry(), ...qoderLaunchArgs(argv)], { stdio: "inherit", env });
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 1);
  });
  child.on("error", (error) => {
    console.error(`[pm-mcp qoder-launch] 启动失败: ${error.message}`);
    process.exit(1);
  });
  for (const name of ["SIGINT", "SIGTERM"] as const) process.on(name, () => child.kill(name));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runQoderLaunch();
