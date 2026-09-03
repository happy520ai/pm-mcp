import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
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

/**
 * 账本互斥锁：把「读账本 → 改 → 写」整个事务串行化，多客户端（如 ZCode+Codex 并行）
 * 不再互相覆盖丢数据。锁文件 .pm/.lock（O_EXCL 创建）；超过 10s 且持锁进程已死亡
 * 才视为残留并接管。活着的长任务不会被误抢锁；释放时也只删除自己的 token。
 * 等待上限 3s，超时明确报错而非静默丢写。
 */
export function withLedgerLock<T>(root: string, fn: () => T): T {
  const lockFile = pmPath(root, ".lock");
  fs.mkdirSync(pmPath(root), { recursive: true });
  const token = randomUUID();
  const payload = JSON.stringify({ pid: process.pid, token, created_at: new Date().toISOString() });
  const owner = (): { pid: number; token?: string } | null => {
    try {
      const raw = fs.readFileSync(lockFile, "utf8");
      try {
        const parsed = JSON.parse(raw) as { pid?: unknown; token?: unknown };
        return typeof parsed.pid === "number"
          ? { pid: parsed.pid, ...(typeof parsed.token === "string" ? { token: parsed.token } : {}) }
          : null;
      } catch {
        const pid = Number(raw.trim());
        return Number.isInteger(pid) && pid > 0 ? { pid } : null;
      }
    } catch {
      return null;
    }
  };
  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  };
  const acquire = (): boolean => {
    try {
      fs.writeFileSync(lockFile, payload, { flag: "wx" });
      return true;
    } catch {
      try {
        const st = fs.statSync(lockFile);
        const current = owner();
        if (Date.now() - st.mtimeMs > 10_000 && (!current || !alive(current.pid))) {
          fs.rmSync(lockFile, { force: true });
          try {
            fs.writeFileSync(lockFile, payload, { flag: "wx" });
            return true;
          } catch {
            return false;
          }
        }
      } catch {
        /* 锁文件刚好消失，下轮重试 */
      }
      return false;
    }
  };
  let held = false;
  for (let i = 0; i < 150 && !held; i++) {
    held = acquire();
    if (!held) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
  if (!held) {
    throw new Error("账本锁获取超时（3s）：另一进程正在写入本项目，请稍后重试。");
  }
  try {
    return fn();
  } finally {
    try {
      if (owner()?.token === token) fs.rmSync(lockFile, { force: true });
    } catch {
      /* 尽力释放 */
    }
  }
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
