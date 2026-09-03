import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { isInitialized } from "./paths.ts";
import { normSep } from "./budget.ts";
import { getIndex, getMeta, setMeta } from "./index-db.ts";
export { aggregates, closeIndex, getIndex, getMeta, iterateFileRows, setMeta } from "./index-db.ts";
export type { Aggregates } from "./index-db.ts";
import {
  BINARY_EXTS,
  countLoc,
  isLockfile,
  isTestFile,
  extOf,
  countSkipLines,
  needsSkipCount,
  looksTrivialTest,
  DEFAULT_IGNORE_DIRS,
  walkStatEntries,
  type WalkOptions,
} from "./scan.ts";

/**
 * SQLite 扫描索引（超大项目核心）：
 * - .pm/index.db 取代 index.json：增量 upsert 而非全量重写（10M 行 JSON 会膨胀到 GB 级）
 * - 索引是可重建的缓存（.gitignore 它），账本仍走 git 友好的 JSON——两者是两回事
 * - 走查 = temp 表集合 diff：未变更文件不重读内容（与旧 JSON 索引同语义）
 * - 聚合全部走 SQL：避免把大规模索引整体物化进 JS 内存
 * - watcher 活跃时索引持续保鲜，audit/快照可免走查（见 ensureFresh）
 */

const MAX_FILE_BYTES = 2 * 1024 * 1024;

/* ------------------------------ 条目计算/写入 ------------------------------ */

export interface ComputedEntry {
  loc: number;
  skip: number;
  trivial: boolean;
  oversize: boolean;
  contentOk: boolean;
}

/** 读单个文件内容并计算索引字段（watcher 与走查共用同一条语义） */
export function computeEntry(root: string, rel: string, stat: fs.Stats): ComputedEntry {
  const ext = extOf(rel);
  const lock = isLockfile(rel);
  const isTest = isTestFile(rel);
  if (BINARY_EXTS.has(ext) || lock) {
    return { loc: 0, skip: 0, trivial: false, oversize: false, contentOk: false };
  }
  if (stat.size > MAX_FILE_BYTES) {
    return { loc: 0, skip: 0, trivial: false, oversize: true, contentOk: false };
  }
  try {
    const content = fs.readFileSync(path.join(root, ...rel.split("/")), "utf8");
    if (content.includes("\0")) return { loc: 0, skip: 0, trivial: false, oversize: false, contentOk: false };
    return {
      loc: countLoc(content),
      skip: needsSkipCount(rel, isTest) ? countSkipLines(content) : 0,
      trivial: isTest && looksTrivialTest(content),
      oversize: false,
      contentOk: true,
    };
  } catch {
    return { loc: 0, skip: 0, trivial: false, oversize: false, contentOk: false };
  }
}

function topOf(rel: string): string {
  const parts = rel.split("/");
  if (parts.length <= 1) return ".";
  return parts.slice(0, Math.min(2, parts.length - 1)).join("/");
}

export function upsertFile(root: string, db: DatabaseSync, rel: string, stat: fs.Stats, entry: ComputedEntry): void {
  const parts = rel.split("/");
  db.prepare(
    `INSERT INTO files(rel,top,root1,dir,ext,is_test,is_lock,mtime,size,loc,skip,trivial,oversize,content_ok)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(rel) DO UPDATE SET top=excluded.top,root1=excluded.root1,dir=excluded.dir,ext=excluded.ext,
       is_test=excluded.is_test,is_lock=excluded.is_lock,mtime=excluded.mtime,size=excluded.size,
       loc=excluded.loc,skip=excluded.skip,trivial=excluded.trivial,oversize=excluded.oversize,
       content_ok=excluded.content_ok`,
  ).run(
    rel,
    topOf(rel),
    parts.length > 1 ? parts[0] : ".",
    parts.slice(0, -1).join("/") || ".",
    extOf(rel),
    isTestFile(rel) ? 1 : 0,
    isLockfile(rel) ? 1 : 0,
    stat.mtimeMs,
    stat.size,
    entry.loc,
    entry.skip,
    entry.trivial ? 1 : 0,
    entry.oversize ? 1 : 0,
    entry.contentOk ? 1 : 0,
  );
}

export function deleteFile(db: DatabaseSync, rel: string): void {
  db.prepare("DELETE FROM files WHERE rel=?").run(rel);
}

export function deleteSubtree(db: DatabaseSync, prefix: string): void {
  db.prepare("DELETE FROM files WHERE rel LIKE ?").run(prefix.replace(/[%_]/g, (c) => "\\" + c) + "/%");
}

/* ------------------------------- 走查刷新（精确） ------------------------------ */

export interface WalkRefreshResult {
  totalFiles: number;
  changed: number;
  deleted: number;
  /** 与索引一致（未重读内容）的文件数 */
  hits: number;
  skippedDeep: number;
}

export function walkRefresh(root: string, opts: WalkOptions = {}): WalkRefreshResult {
  const db = getIndex(root);
  db.exec("CREATE TEMP TABLE IF NOT EXISTS walked(rel TEXT PRIMARY KEY, mtime REAL, size INTEGER)");
  db.exec("DELETE FROM walked");
  const ins = db.prepare("INSERT OR REPLACE INTO walked VALUES(?,?,?)");

  let total = 0;
  let batch: unknown[][] = [];
  const flush = (): void => {
    if (batch.length === 0) return;
    db.exec("BEGIN");
    for (const b of batch) ins.run(...b as [string, number, number]);
    db.exec("COMMIT");
    batch = [];
  };
  let skippedDeep = 0;
  for (const e of walkStatEntries(root, opts, () => (skippedDeep += 1))) {
    total += 1;
    batch.push([e.rel, e.mtime, e.size]);
    if (batch.length >= 2000) flush();
  }
  flush();

  const changedSql = opts.forceContent
    ? `SELECT w.rel AS rel, w.mtime AS mtime, w.size AS size FROM walked w
       WHERE w.rel > ? ORDER BY w.rel LIMIT ?`
    : `SELECT w.rel AS rel, w.mtime AS mtime, w.size AS size FROM walked w
       LEFT JOIN files f ON f.rel = w.rel
       WHERE w.rel > ? AND (f.rel IS NULL OR f.mtime <> w.mtime OR f.size <> w.size)
       ORDER BY w.rel LIMIT ?`;
  const changedStmt = db.prepare(changedSql);

  let processed = 0;
  const upsertStmt = db.prepare(
    `INSERT INTO files(rel,top,root1,dir,ext,is_test,is_lock,mtime,size,loc,skip,trivial,oversize,content_ok)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(rel) DO UPDATE SET top=excluded.top,root1=excluded.root1,dir=excluded.dir,ext=excluded.ext,
       is_test=excluded.is_test,is_lock=excluded.is_lock,mtime=excluded.mtime,size=excluded.size,
       loc=excluded.loc,skip=excluded.skip,trivial=excluded.trivial,oversize=excluded.oversize,
       content_ok=excluded.content_ok`,
  );
  interface UpsertRow {
    rel: string; top: string; root1: string; dir: string; ext: string;
    isTest: number; isLock: number; mtime: number; size: number;
    loc: number; skip: number; trivial: number; oversize: number; contentOk: number;
  }
  let upBatch: UpsertRow[] = [];
  const flushUp = (): void => {
    if (upBatch.length === 0) return;
    db.exec("BEGIN");
    for (const r of upBatch) {
      upsertStmt.run(r.rel, r.top, r.root1, r.dir, r.ext, r.isTest, r.isLock, r.mtime, r.size, r.loc, r.skip, r.trivial, r.oversize, r.contentOk);
    }
    db.exec("COMMIT");
    upBatch = [];
  };
  // 游标分页而不是 .all() 物化全部变更行；20GiB/百万文件首次走查也只保留一批。
  let changedCursor = "";
  while (true) {
    const changedRows = changedStmt.all(changedCursor, 500) as Array<{ rel: string; mtime: number; size: number }>;
    if (changedRows.length === 0) break;
    for (const row of changedRows) {
      const rel = row.rel;
      const statLike = { mtimeMs: row.mtime, size: row.size } as fs.Stats;
      const entry = computeEntry(root, rel, statLike);
      const parts = rel.split("/");
      upBatch.push({
        rel,
        top: topOf(rel),
        root1: parts.length > 1 ? parts[0] : ".",
        dir: parts.slice(0, -1).join("/") || ".",
        ext: extOf(rel),
        isTest: isTestFile(rel) ? 1 : 0,
        isLock: isLockfile(rel) ? 1 : 0,
        mtime: row.mtime,
        size: row.size,
        loc: entry.loc,
        skip: entry.skip,
        trivial: entry.trivial ? 1 : 0,
        oversize: entry.oversize ? 1 : 0,
        contentOk: entry.contentOk ? 1 : 0,
      });
      processed += 1;
      if (upBatch.length >= 500) flushUp();
    }
    changedCursor = changedRows[changedRows.length - 1].rel;
  }
  flushUp();

  const del = db.prepare(`DELETE FROM files WHERE rel NOT IN (SELECT rel FROM walked)`).run();
  setMeta(db, "lastWalk", new Date().toISOString());
  setMeta(db, "skippedDeep", String(skippedDeep));
  setMeta(db, "rootPath", path.resolve(root));
  // 走查刚完成的这一刻索引就是最新的：watcher 模式下立即续心跳，
  // 否则长走查期间（库忙）心跳可能一直写不进，走查一结束就被判"过期"再走一遍
  if (getMeta(db, "mode") === "watcher") {
    setMeta(db, "lastBeat", new Date().toISOString());
    // watcher 心跳只能证明“现在有人监听”，不能证明它覆盖了进程停机期间的改动。
    // 将精确走查绑定到本次 watcher 会话；下次进程启动会换代，旧索引因而必须先对账。
    const watcherSession = getMeta(db, "watcherSession");
    if (watcherSession !== null) setMeta(db, "lastWalkSession", watcherSession);
  }
  return { totalFiles: total, changed: processed, deleted: Number(del.changes ?? 0), hits: total - processed, skippedDeep };
}

/* ------------------------------ watcher 新鲜度 ------------------------------ */

export interface Freshness {
  mode: "watcher" | "walk";
  fresh: boolean;
  /** 索引内文件数（0=从未走查） */
  files: number;
  lastWalk: string | null;
  lastBeat: string | null;
  pendingEvents: number;
}

const BEAT_STALE_MS = 90_000;

export function freshness(root: string): Freshness {
  const db = getIndex(root);
  const files = (db.prepare(`SELECT COUNT(*) c FROM files`).get() as { c: number }).c;
  const lastWalk = getMeta(db, "lastWalk");
  const lastBeat = getMeta(db, "lastBeat");
  const mode = (getMeta(db, "mode") ?? "walk") as "watcher" | "walk";
  const pending = Number(getMeta(db, "pending") ?? 0);
  const beatAge = lastBeat ? Date.now() - Date.parse(lastBeat) : Number.POSITIVE_INFINITY;
  // rootPath 守卫：索引库随项目目录被拷贝/移动时，旧心跳与行集都属于原路径——不可信任
  const owned = getMeta(db, "rootPath") === path.resolve(root);
  const lastEvent = getMeta(db, "lastEvent");
  const eventAge = lastEvent ? Date.now() - Date.parse(lastEvent) : Number.POSITIVE_INFINITY;
  const watcherSession = getMeta(db, "watcherSession");
  const sessionReconciled = watcherSession !== null && getMeta(db, "lastWalkSession") === watcherSession;
  // 卡死计数自愈：防抖 150ms，若计数>0 但 30s 无任何事件推进，说明计数器失真（如持锁期抛错），不再信任
  const pendingClean = pending === 0 || eventAge > 30_000;
  const fresh =
    files > 0 &&
    lastWalk !== null &&
    owned &&
    mode === "watcher" &&
    sessionReconciled &&
    pendingClean &&
    beatAge < BEAT_STALE_MS;
  return { mode, fresh, files, lastWalk, lastBeat, pendingEvents: pending };
}

/**
 * 确保索引可用：watcher 活跃且心跳新鲜 → 直接用（稳态免走查）；
 * 否则精确全量走查（冷启动/巡检进程/server 未运行时）。
 */
export function ensureFresh(root: string): { used: "watcher" | "walk"; freshness: Freshness } {
  let f = freshness(root);
  if (!f.fresh && f.mode === "watcher" && f.pendingEvents > 0) {
    // 变更风暴刚过：事件还在防抖队列里。本进程有 watcher 时就地排空（毫秒级），
    // 免得为几十个文件的变更回退一次全量走查（分钟级）
    if (drainWatcher(root)) f = freshness(root);
  }
  if (f.fresh) return { used: "watcher", freshness: f };
  walkRefresh(root);
  return { used: "walk", freshness: freshness(root) };
}

/* --------------------------------- watcher --------------------------------- */

export interface WatcherHandle {
  stop(): void;
}

/** 本进程内的活跃 watcher（供审计前就地排空事件队列，免回退全量走查） */
interface ActiveWatcher {
  timers: Map<string, { timer: NodeJS.Timeout; due: number; run: () => void }>;
  closed: () => boolean;
}
const activeWatchers = new Map<string, ActiveWatcher>();

/**
 * 就地排空本进程 watcher 的事件队列：把已排队的防抖定时器立即执行。
 * 场景：变更风暴后紧接着调 audit——事件本要 150ms 后才消化、pending>0 导致回退全量走查；
 * 排空后索引立即反映全部变更，审计直接走 SQL。返回是否发生排空。
 */
export function drainWatcher(root: string): boolean {
  const w = activeWatchers.get(path.resolve(root));
  if (!w || w.closed()) return false;
  let drained = 0;
  for (const [, entry] of [...w.timers]) {
    clearTimeout(entry.timer);
    entry.run();
    drained += 1;
  }
  return drained > 0;
}

/**
 * 递归 watcher（Windows 原生 ReadDirectoryChangesW，单调用监视全树）持续维护索引。
 * - 事件防抖 150ms；新增目录补扫子树；删除事件清行
 * - 每 30s 写心跳；unref 保证 server 随 stdio 关闭退出
 * - 失败（网络盘/权限）静默降级为纯走查模式（freshness.mode=walk）
 */
export function startWatcher(root: string): WatcherHandle | null {
  const abs = path.resolve(root);
  const db = getIndex(abs);
  let pending = 0;
  const timers = new Map<string, { timer: NodeJS.Timeout; due: number; run: () => void }>();
  let closed = false;

  const ignored = (rel: string): boolean => {
    const first = rel.split("/")[0];
    return DEFAULT_IGNORE_DIRS.has(first) || first === ".pm";
  };

  const bumpPending = (d: number): void => {
    pending = Math.max(0, pending + d);
    try {
      setMeta(db, "pending", String(pending));
    } catch {
      /* 库忙时持久化失败无所谓——内存计数仍准，meta 会随后续写收敛 */
    }
  };

  const process = (rel: string): void => {
    if (closed) return;
    try {
      const full = path.join(abs, ...rel.split("/"));
      const st = fs.statSync(full);
      if (st.isDirectory()) {
        // 新目录：补扫该子树（走 walkStatEntries 的 include 限定）
        for (const e of walkStatEntries(abs, { include: [rel + "/**"] }, () => undefined)) {
          const st2 = fs.statSync(path.join(abs, ...e.rel.split("/")));
          upsertFile(abs, db, e.rel, st2, computeEntry(abs, e.rel, st2));
        }
      } else if (st.isFile()) {
        if (ignored(rel)) return;
        upsertFile(abs, db, rel, st, computeEntry(abs, rel, st));
      }
    } catch {
      // 消失了 → 删行
      try {
        deleteFile(db, rel);
        deleteSubtree(db, rel);
      } catch {
        /* ignore */
      }
    } finally {
      bumpPending(-1);
      try {
        setMeta(db, "lastEvent", new Date().toISOString());
      } catch {
        /* ignore */
      }
    }
  };

  let watcher: fs.FSWatcher;
  try {
    watcher = fs.watch(abs, { recursive: true }, (_event, filename) => {
      if (closed || !filename) return;
      let rel: string;
      try {
        rel = normSep(String(filename));
        if (ignored(rel)) return;
      } catch {
        return;
      }
      // 先建定时器再计数：即使计数持久化撞锁抛错，定时器也已就位（否则计数永不归零）
      const prev = timers.get(rel);
      if (prev) {
        clearTimeout(prev.timer);
        bumpPending(-1);
      }
      bumpPending(1);
      const run = (): void => {
        timers.delete(rel);
        try {
          process(rel);
        } catch {
          bumpPending(-1);
        }
      };
      timers.set(rel, { timer: setTimeout(run, 150), due: Date.now() + 150, run });
    });
  } catch {
    setMeta(db, "mode", "walk");
    return null;
  }
  watcher.unref();
  // 每次 watcher 启动都换一个会话代次。只有本次会话建立后的精确走查
  // 会把 lastWalkSession 对齐，因此停机窗口内的增删改不可能被旧心跳掩盖。
  setMeta(db, "watcherSession", randomUUID());
  setMeta(db, "pending", "0");
  setMeta(db, "mode", "watcher");
  let stopped = false;
  activeWatchers.set(abs, { timers, closed: () => stopped });
  const beat = setInterval(() => {
    if (closed) return;
    try {
      setMeta(db, "lastBeat", new Date().toISOString());
    } catch {
      /* ignore */
    }
  }, 10_000);
  beat.unref();
  // 立刻打一次心跳（避免刚启动的 90s 空窗被判不新鲜）
  setMeta(db, "lastBeat", new Date().toISOString());
  return {
    stop(): void {
      stopped = true;
      activeWatchers.delete(abs);
      closed = true;
      clearInterval(beat);
      for (const t of timers.values()) clearTimeout(t.timer);
      try {
        watcher.close();
      } catch {
        /* ignore */
      }
      try {
        setMeta(db, "mode", "walk");
      } catch {
        /* 库可能已被关闭（closeIndex 先行）——telemetry 失败无所谓 */
      }
    },
  };
}

/** 巡检/诊断用：索引概况一行 */
export function indexSummary(root: string): string {
  const f = freshness(root);
  if (f.files === 0) return "索引：空（未走查）";
  const age = f.lastWalk ? `，走查于 ${f.lastWalk.slice(0, 16).replace("T", " ")}` : "";
  const beat = f.fresh ? "，watcher 保鲜中" : `（watcher ${f.mode === "watcher" ? "心跳过期" : "未运行"}，下次审计将全量走查）`;
  return `索引：${f.files} 文件${age}${beat}`;
}

export { isInitialized };
