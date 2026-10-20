import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/* Qoder 只派生一个常驻 stdio 子进程服务所有窗口（实测：同一 server uuid 被三个不同 session token 复用），
   所以项目根不能在启动时定格。本模块在每次工具调用时反查「是谁在调我」：客户端运行日志会先记下
   tool.requested（含工具名与参数原文），再发起调用，于是用本次请求做指纹就能锁定调用方那个会话的
   initial_cwd。取不到证据时一律如实降级并说明依据，绝不猜。 */

export const CLIENT_ADAPTER_ENV = "PM_MCP_CLIENT_ADAPTER";
export const ROOT_HINT_ENV = "PM_MCP_ROOT_HINT";
export const ROOT_HINT_SOURCE_ENV = "PM_MCP_ROOT_HINT_SOURCE";
export const QODER_ADAPTER = "qoder";

/** 服务端工具名前缀：客户端把工具暴露成 mcp__<server>__<tool>，服务名可能是 pm_mcp 或 pm-mcp */
const TOOL_NAME_PATTERN = /mcp__pm[_-]mcp__/;

export interface RequestRoot {
  root: string;
  source: string;
  candidates?: string[];
}

interface RunLog {
  file: string;
  mtime: number;
  size: number;
  workspace: string | null;
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** 显式给了 QODER_CONFIG_DIR 就只看它：否则本机的真实 ~/.qoder-cn 会混进测试与隔离环境 */
function configDirs(env: NodeJS.ProcessEnv): string[] {
  const fromEnv = env.QODER_CONFIG_DIR?.trim();
  if (fromEnv && isDir(fromEnv)) return [path.resolve(fromEnv)];
  const home = os.homedir();
  return [".qoder-cn", ".qoder"].map((name) => path.join(home, name)).filter(isDir);
}

/** 日志目录名以 -p<pid> 结尾，但 Qoder 全部会话共用主进程 pid，因此 ppid 不能用来区分会话 */
function runLogDirs(env: NodeJS.ProcessEnv): string[] {
  const out: string[] = [];
  for (const dir of configDirs(env)) {
    const runs = path.join(dir, "logs", "runs");
    let names: string[];
    try {
      names = fs.readdirSync(runs);
    } catch {
      continue;
    }
    for (const name of names) out.push(path.join(runs, name, "qodercli.log"));
  }
  return out;
}

function workspaceOfLog(file: string): string | null {
  let head: string;
  try {
    const fd = fs.openSync(file, "r");
    try {
      const buffer = Buffer.alloc(8192);
      const bytes = fs.readSync(fd, buffer, 0, 8192, 0);
      head = buffer.toString("utf8", 0, bytes);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
  const match = /initial_cwd=([\s\S]*?)\s+restore_cwd=/.exec(head);
  const value = match?.[1]?.trim();
  return value && isDir(value) ? path.resolve(value) : null;
}

function recentRunLogs(options: { env: NodeJS.ProcessEnv; now: number; windowMs: number }): RunLog[] {
  const logs: RunLog[] = [];
  for (const file of runLogDirs(options.env)) {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
    } catch {
      continue;
    }
    if (!stat.isFile() || options.now - stat.mtimeMs > options.windowMs) continue;
    logs.push({ file, mtime: stat.mtimeMs, size: stat.size, workspace: workspaceOfLog(file) });
  }
  return logs.sort((a, b) => b.mtime - a.mtime);
}

/** 从日志尾部按块往前扫，扫到比本次请求还早就停：活跃会话日志可能几 MB，但相关行永远在最后几秒 */
const CHUNK_BYTES = 256 * 1024;
const MAX_SCAN_BYTES = 8 * 1024 * 1024;

interface ScanWindow {
  now: number;
  maxAgeMs: number;
  tieMs: number;
}

/** 日志记的是客户端发出的原始参数，服务端拿到的是 zod 解析后的（可能补了默认值）：只要求日志参数被本次参数覆盖 */
function argsCovered(logged: unknown, received: unknown): boolean {
  if (logged === undefined || logged === null) return true;
  if (typeof logged !== "object" || typeof received !== "object" || received === null) return logged === received;
  if (Array.isArray(logged) !== Array.isArray(received)) return false;
  const loggedRecord = logged as Record<string, unknown>;
  const receivedRecord = received as Record<string, unknown>;
  return Object.keys(loggedRecord).every((key) => argsCovered(loggedRecord[key], receivedRecord[key]));
}

function extractArgsJson(line: string): unknown | undefined {
  const marker = line.indexOf(" args=");
  if (marker < 0) return undefined;
  try {
    return JSON.parse(line.slice(marker + " args=".length));
  } catch {
    return undefined;
  }
}

function lineMatchesRequest(line: string, tool: string, args: unknown): boolean {
  if (!TOOL_NAME_PATTERN.test(line)) return false;
  const payload = extractArgsJson(line);
  if (payload === undefined || payload === null || typeof payload !== "object") return false;
  const record = payload as Record<string, unknown>;
  if (typeof record.toolName === "string") {
    return record.toolName.endsWith(`__${tool}`) && argsCovered(record.arguments, args);
  }
  const name = /tool_name="([^"]+)"/.exec(line)?.[1];
  return name === `mcp__pm_mcp__${tool}` && argsCovered(record, args);
}

function lineTimestamp(line: string): number | null {
  const stamp = /^\s*(\d{4}-\d{2}-\d{2}T[\d:.]+(?:[+-]\d{2}:\d{2}|Z))/.exec(line)?.[1];
  if (!stamp) return null;
  const parsed = Date.parse(stamp);
  return Number.isNaN(parsed) ? null : parsed;
}

export interface CallerMatch {
  workspace: string;
  at: number;
}

function inWindow(at: number | null, window: ScanWindow): boolean {
  return at !== null && at <= window.now + window.tieMs && window.now - at <= window.maxAgeMs;
}

/** 倒着按块扫，按字节拼接后再解码，避免把多字节字符从中间截断成乱码 */
function scanLogForRequest(log: RunLog, tool: string, args: unknown, window: ScanWindow): CallerMatch | null {
  let fd: number;
  try {
    fd = fs.openSync(log.file, "r");
  } catch {
    return null;
  }
  let best: CallerMatch | null = null;
  try {
    let offset = log.size;
    let scanned = 0;
    let carry = Buffer.alloc(0);
    while (offset > 0 && scanned < MAX_SCAN_BYTES) {
      const length = Math.min(CHUNK_BYTES, offset);
      offset -= length;
      scanned += length;
      const chunk = Buffer.alloc(length);
      const bytes = fs.readSync(fd, chunk, 0, length, offset);
      const buffer = Buffer.concat([bytes === length ? chunk : chunk.subarray(0, bytes), carry]);
      const firstNewline = buffer.indexOf(0x0a);
      if (firstNewline === -1) {
        carry = buffer;
        continue;
      }
      carry = buffer.subarray(0, firstNewline + 1);
      const lines = buffer.subarray(firstNewline + 1).toString("utf8").split(/\r?\n/).filter((line) => line.length > 0);
      let oldest: number | null = null;
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        const line = lines[i]!;
        const at = lineTimestamp(line);
        if (at !== null) oldest = at;
        if (!inWindow(at, window)) continue;
        if (!line.includes(tool) || !lineMatchesRequest(line, tool, args)) continue;
        if (!best || at! > best.at) best = { workspace: log.workspace!, at: at! };
      }
      if (oldest !== null && window.now - oldest > window.maxAgeMs) break;
    }
  } catch {
    return best;
  } finally {
    fs.closeSync(fd);
  }
  return best;
}

/** 找出本次请求的指纹落在哪个会话日志里。
    必须按时间收紧：客户端日志会长期留着「工具名+参数」，两个窗口先后发同一个无参调用会留下同样的指纹，
    只有「刚刚写下」的那条才可能是本次调用方。 */
export function matchCallerWorkspaces(options: {
  tool: string;
  args: unknown;
  logs: RunLog[];
  now: number;
  /** 调用方的 tool.requested 就在本次请求前几毫秒写下 */
  maxAgeMs?: number;
  /** 两个不同工作区的命中挨得这么近才算真的分不清 */
  tieMs?: number;
}): CallerMatch[] {
  const window: ScanWindow = { now: options.now, maxAgeMs: options.maxAgeMs ?? 30_000, tieMs: options.tieMs ?? 2_000 };
  const hits: CallerMatch[] = [];
  for (const log of options.logs) {
    if (!log.workspace) continue;
    const hit = scanLogForRequest(log, options.tool, options.args, window);
    if (hit) hits.push(hit);
  }
  if (hits.length === 0) return [];
  hits.sort((a, b) => b.at - a.at);
  const newest = hits[0]!;
  return hits
    .filter((hit) => newest.at - hit.at <= window.tieMs)
    .filter((hit, index, all) => all.findIndex((other) => other.workspace === hit.workspace) === index);
}

export interface ResolveRequestRootOptions {
  tool: string;
  args: Record<string, unknown>;
  startupRoot: string;
  startupSource: string;
  env?: NodeJS.ProcessEnv;
  now?: number;
  /** 认为「正在活跃」的日志时间窗，命中指纹失败时只在唯一活跃会话上降级 */
  hotWindowMs?: number;
  /** 回溯多久内的会话日志，太旧的会话不可能是本次调用方 */
  scanWindowMs?: number;
}

/* 不缓存解析结果：两个窗口在几百毫秒内发同一个无参调用时，缓存会把前一个窗口的项目根串给后一个。
   单次解析只扫最近几秒的日志尾部，代价可以接受，正确性优先。 */

/** 每次工具调用解析项目根：显式 root 参数 > 请求指纹命中的会话工作区 > 唯一活跃会话 > 启动期提示 > 启动解析 */
export function resolveRequestRoot(options: ResolveRequestRootOptions): RequestRoot {
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now();
  const startup: RequestRoot = { root: options.startupRoot, source: options.startupSource };
  if (env[CLIENT_ADAPTER_ENV] !== QODER_ADAPTER) return startup;

  const explicit = typeof options.args.root === "string" ? options.args.root.trim() : "";
  if (explicit && isDir(explicit)) return { root: path.resolve(explicit), source: "argument" };

  const logs = recentRunLogs({ env, now, windowMs: options.scanWindowMs ?? 60_000 });
  const matched = matchCallerWorkspaces({ tool: options.tool, args: options.args, logs, now });
  if (matched.length === 1) return { root: matched[0]!.workspace, source: "qoder-session-log(request-match)" };
  if (matched.length > 1) {
    return {
      ...startup,
      source: `startup(${options.startupSource});请求指纹同时命中 ${matched.length} 个会话，未猜测`,
      candidates: matched.map((hit) => hit.workspace),
    };
  }

  const hot = logs.filter((log) => log.workspace && now - log.mtime <= (options.hotWindowMs ?? 10_000));
  const hotWorkspaces = [...new Set(hot.map((log) => log.workspace!))];
  if (hotWorkspaces.length === 1) return { root: hotWorkspaces[0]!, source: "qoder-session-log(only-active)" };
  // 多个会话同时活跃又没指纹：宁可如实报歧义，也不拿启动期那个可能早就过期的根去猜
  if (hotWorkspaces.length > 1) {
    return { ...startup, source: `startup(${options.startupSource});多个 Qoder 会话同时活跃，未猜测`, candidates: hotWorkspaces };
  }

  const hint = env[ROOT_HINT_ENV]?.trim();
  if (hint && isDir(hint)) {
    const basis = env[ROOT_HINT_SOURCE_ENV]?.trim() || "hint";
    return { root: path.resolve(hint), source: `${basis}(spawn-time)` };
  }
  return startup;
}

export const __test = { recentRunLogs, runLogDirs, configDirs, scanLogForRequest };
