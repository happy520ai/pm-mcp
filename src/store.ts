import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { ZodTypeAny, output } from "zod";
import {
  DebugLogFileSchema,
  FeaturesFileSchema,
  FileNotesFileSchema,
  now,
  ProjectSchema,
  RoadmapFileSchema,
  SecurityFileSchema,
  SessionsFileSchema,
  TasksFileSchema,
  type DebugLogFile,
  type FeaturesFile,
  type FileNotesFile,
  type Project,
  type RoadmapFile,
  type SecurityFile,
  type SessionsFile,
  type TasksFile,
} from "./types.ts";
import {
  DEBUGLOG_JSON,
  EXTRA_RULES_FILE,
  FEATURES_JSON,
  FILE_NOTES_JSON,
  PROJECT_JSON,
  ROADMAP_JSON,
  SECURITY_JSON,
  SESSIONS_JSON,
  TASKS_JSON,
  pmPath,
} from "./paths.ts";
import { ExtraRulesFileSchema, type ExtraRulesFile } from "./types.ts";

/* ------------------------------ 通用 JSON 读写 ------------------------------ */

/**
 * 原子写：唯一命名临时文件 + rename。
 * Windows 上目标被并发的读/写短暂持有时 rename 可能抛 EPERM/EACCES/EBUSY，
 * 做指数退避重试；最终失败则清理 tmp 后抛出（不留半截文件）。
 */
export function atomicWrite(file: string, content: string): void {
  const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  fs.writeFileSync(tmp, content, "utf8");
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if ((code === "EPERM" || code === "EACCES" || code === "EBUSY") && i < 20) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5 + i * 5);
        continue;
      }
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        /* 尽力清理 */
      }
      throw e;
    }
  }
}

/** 原子写 JSON（经 schema 校验后的账本数据） */
export function saveJson(file: string, data: unknown): void {
  atomicWrite(file, JSON.stringify(data, null, 2) + "\n");
}

type FileLockOwner = { pid: number; token?: string; created_at?: string; protocol?: string };

export interface FileRecoveryLockOptions {
  /** SQLite file used only to serialize lock-file recovery operations. */
  guardFile?: string;
  timeoutMs?: number;
  staleMs?: number;
  timeoutMessage?: string;
}

const FILE_LOCK_TIMEOUT_MS = 3_000;
const FILE_LOCK_STALE_MS = 10_000;
const FILE_LOCK_POLL_MS = 20;
const FILE_LOCK_PROTOCOL = "sqlite-guard-v1";
const FILE_LOCK_WAIT = new Int32Array(new SharedArrayBuffer(4));

function readFileLockOwner(lockFile: string): FileLockOwner | null {
  let raw: string;
  try {
    raw = fs.readFileSync(lockFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const parsed = JSON.parse(raw) as { pid?: unknown; token?: unknown; created_at?: unknown; protocol?: unknown };
    if (!Number.isSafeInteger(parsed.pid) || (parsed.pid as number) <= 0) return null;
    return {
      pid: parsed.pid as number,
      ...(typeof parsed.token === "string" && parsed.token.length > 0 ? { token: parsed.token } : {}),
      ...(typeof parsed.created_at === "string" && parsed.created_at.length > 0 ? { created_at: parsed.created_at } : {}),
      ...(typeof parsed.protocol === "string" && parsed.protocol.length > 0 ? { protocol: parsed.protocol } : {}),
    };
  } catch {
    const pid = Number(raw.trim());
    return Number.isSafeInteger(pid) && pid > 0 ? { pid } : null;
  }
}

function fileLockOwnerAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM proves that the process exists even when signalling it is forbidden.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function sqliteBusy(error: unknown): boolean {
  const candidate = error as { errcode?: unknown; message?: unknown };
  return candidate.errcode === 5 ||
    (typeof candidate.message === "string" && /database is (?:locked|busy)/i.test(candidate.message));
}

function rollbackRecoveryGuard(db: DatabaseSync): void {
  if (!db.isTransaction) return;
  try {
    db.exec("ROLLBACK");
  } catch {
    // close() below is the final fail-safe and also rolls an open transaction back.
  }
}

/**
 * 通用跨进程文件锁。SQLite 写事务覆盖 .lock 的检查、接管、创建、调用方临界区和
 * 释放，从而消除 check-then-rm ABA，并在进程崩溃时由操作系统释放真实所有权。
 * 成功取得同一 guard 后，带当前 protocol 的残留 .lock 可立即核销，即使 PID 已复用；
 * 无 protocol 的旧版锁仍须「超过 staleMs 且 PID 已死」才接管，以兼容滚动升级。
 * 释放必须完整匹配 protocol、PID、token 与 created_at，否则保留并 fail-closed。
 * 共享同一 guardFile 的不同 lockFile 会串行，调用方应只在短元数据事务中共享 guard。
 */
export function withFileRecoveryLock<T>(
  lockFile: string,
  fn: () => T,
  options: FileRecoveryLockOptions = {},
): T {
  const timeoutMs = options.timeoutMs ?? FILE_LOCK_TIMEOUT_MS;
  const staleMs = options.staleMs ?? FILE_LOCK_STALE_MS;
  const guardFile = options.guardFile ?? path.join(path.dirname(lockFile), ".file-recovery-guard.db");
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isFinite(staleMs) || staleMs < 0) {
    throw new RangeError("文件锁 timeoutMs 必须大于 0，staleMs 不得小于 0。");
  }
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  fs.mkdirSync(path.dirname(guardFile), { recursive: true });
  const token = randomUUID();
  const createdAt = new Date().toISOString();
  const payload = JSON.stringify({ pid: process.pid, token, created_at: createdAt, protocol: FILE_LOCK_PROTOCOL });
  const deadline = Date.now() + timeoutMs;
  let fileLockHeld = false;

  const acquireFileLock = (): boolean => {
    try {
      fs.writeFileSync(lockFile, payload, { flag: "wx" });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }

    let stat: fs.Stats;
    try {
      stat = fs.statSync(lockFile);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    const current = readFileLockOwner(lockFile);
    const guardedResidual = current?.protocol === FILE_LOCK_PROTOCOL;
    if (!guardedResidual && (Date.now() - stat.mtimeMs <= staleMs || (current && fileLockOwnerAlive(current.pid)))) {
      return false;
    }

    // Every current-version acquirer and releaser holds the SQLite write transaction
    // here, so no compliant peer can replace .lock between this removal and creation.
    try {
      fs.rmSync(lockFile);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    try {
      fs.writeFileSync(lockFile, payload, { flag: "wx" });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
  };

  const beginGuard = (db: DatabaseSync, until: number): boolean => {
    while (Date.now() < until) {
      const remaining = until - Date.now();
      if (remaining <= 0) return false;
      db.exec(`PRAGMA busy_timeout=${Math.max(1, Math.min(100, remaining))}`);
      try {
        db.exec("BEGIN IMMEDIATE");
        return true;
      } catch (error) {
        if (!sqliteBusy(error)) throw error;
        const pause = Math.min(FILE_LOCK_POLL_MS, Math.max(0, until - Date.now()));
        if (pause > 0) Atomics.wait(FILE_LOCK_WAIT, 0, 0, pause);
      }
    }
    return false;
  };

  const acquisitionGuard = new DatabaseSync(guardFile);
  try {
    while (!fileLockHeld && Date.now() < deadline) {
      if (!beginGuard(acquisitionGuard, deadline)) break;
      try {
        fileLockHeld = acquireFileLock();
      } catch (error) {
        rollbackRecoveryGuard(acquisitionGuard);
        throw error;
      }
      if (!fileLockHeld) {
        rollbackRecoveryGuard(acquisitionGuard);
        const pause = Math.min(FILE_LOCK_POLL_MS, Math.max(0, deadline - Date.now()));
        if (pause > 0) Atomics.wait(FILE_LOCK_WAIT, 0, 0, pause);
      }
    }

    if (!fileLockHeld) {
      throw new Error(options.timeoutMessage ?? "文件锁获取超时（3s），请稍后重试。");
    }

    try {
      return fn();
    } finally {
      try {
        const current = readFileLockOwner(lockFile);
        if (
          current?.protocol === FILE_LOCK_PROTOCOL &&
          current.pid === process.pid &&
          current.token === token &&
          current.created_at === createdAt
        ) {
          fs.rmSync(lockFile);
        }
      } catch {
        // Ownership cannot be proven: leave the file for guarded recovery.
      }
    }
  } finally {
    rollbackRecoveryGuard(acquisitionGuard);
    try {
      acquisitionGuard.close();
    } catch {
      /* close after rollback is best effort */
    }
  }
}

/**
 * 账本专用互斥锁：把「读账本 → 改 → 写」整个事务串行化。活着的长任务不会被误抢，
 * 等待上限 3s，超时明确报错而非静默丢写。
 */
export function withLedgerLock<T>(root: string, fn: () => T): T {
  const runtimeDirectory = pmPath(root, ".runtime");
  return withFileRecoveryLock(pmPath(root, ".lock"), fn, {
    guardFile: path.join(runtimeDirectory, "ledger-lock.db"),
    timeoutMessage: "账本锁获取超时（3s）：另一进程正在写入本项目，请稍后重试。",
  });
}

export function loadJson<S extends ZodTypeAny>(file: string, schema: S, fallback: output<S>): output<S>;
export function loadJson<S extends ZodTypeAny>(file: string, schema: S): output<S> | undefined;
export function loadJson<S extends ZodTypeAny>(file: string, schema: S, fallback?: output<S>): output<S> | undefined {
  if (!fs.existsSync(file)) return fallback;
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`JSON 解析失败: ${file}: ${(e as Error).message}`);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `数据校验失败: ${file}: ${parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    );
  }
  return parsed.data;
}

/* ------------------------------- 各账本读写 ------------------------------- */

export function loadProject(root: string): Project {
  const file = pmPath(root, PROJECT_JSON);
  if (!fs.existsSync(file)) {
    throw new Error(`项目未初始化（缺少 ${file}），请先调用 init_project。`);
  }
  // budgets 的各字段在 schema 内有默认值；对空对象 parse 即可补全
  const data = loadJson(file, ProjectSchema);
  if (data === undefined) {
    throw new Error(`项目未初始化（缺少 ${file}），请先调用 init_project。`);
  }
  return data;
}

export function saveProject(root: string, project: Project): void {
  project.updated = now();
  saveJson(pmPath(root, PROJECT_JSON), ProjectSchema.parse(project));
}

export function loadTasks(root: string): TasksFile {
  return loadJson(pmPath(root, TASKS_JSON), TasksFileSchema, { seq: 0, tasks: [] });
}
export function saveTasks(root: string, data: TasksFile): void {
  // 写入即校验：绕过工具层直写也过不了 schema（空白标题/非法枚举在闸门被拒）
  saveJson(pmPath(root, TASKS_JSON), TasksFileSchema.parse(data));
}

export function loadRoadmap(root: string): RoadmapFile {
  return loadJson(pmPath(root, ROADMAP_JSON), RoadmapFileSchema, { seq: 0, milestones: [] });
}
export function saveRoadmap(root: string, data: RoadmapFile): void {
  saveJson(pmPath(root, ROADMAP_JSON), RoadmapFileSchema.parse(data));
}

export function loadFeatures(root: string): FeaturesFile {
  return loadJson(pmPath(root, FEATURES_JSON), FeaturesFileSchema, { seq: 0, features: [] });
}
export function saveFeatures(root: string, data: FeaturesFile): void {
  saveJson(pmPath(root, FEATURES_JSON), FeaturesFileSchema.parse(data));
}

export function loadSessions(root: string): SessionsFile {
  return loadJson(pmPath(root, SESSIONS_JSON), SessionsFileSchema, { seq: 0, sessions: [] });
}
export function saveSessions(root: string, data: SessionsFile): void {
  saveJson(pmPath(root, SESSIONS_JSON), SessionsFileSchema.parse(data));
}

export function loadDebugLog(root: string): DebugLogFile {
  return loadJson(pmPath(root, DEBUGLOG_JSON), DebugLogFileSchema, { seq: 0, entries: [] });
}
export function saveDebugLog(root: string, data: DebugLogFile): void {
  saveJson(pmPath(root, DEBUGLOG_JSON), DebugLogFileSchema.parse(data));
}

export function loadFileNotes(root: string): FileNotesFile {
  return loadJson(pmPath(root, FILE_NOTES_JSON), FileNotesFileSchema, { notes: {} });
}
export function saveFileNotes(root: string, data: FileNotesFile): void {
  saveJson(pmPath(root, FILE_NOTES_JSON), FileNotesFileSchema.parse(data));
}

export function loadSecurity(root: string): SecurityFile {
  return loadJson(pmPath(root, SECURITY_JSON), SecurityFileSchema, {
    findings: [],
    last_scan: null,
  });
}
export function saveSecurity(root: string, data: SecurityFile): void {
  saveJson(pmPath(root, SECURITY_JSON), SecurityFileSchema.parse(data));
}

export function loadExtraRules(root: string): ExtraRulesFile {
  return loadJson(pmPath(root, EXTRA_RULES_FILE), ExtraRulesFileSchema, { rules: [] });
}

/* --------------------------------- ID 生成 -------------------------------- */

export function nextId(prefix: string, seq: number, width = 3): string {
  return `${prefix}-${String(seq + 1).padStart(width, "0")}`;
}

/** 判断文件是否被 .pm 之外的额外忽略规则命中（v1 内置目录级忽略在 scan.ts） */
export function fileExists(root: string, rel: string): boolean {
  return fs.existsSync(path.join(root, rel));
}
