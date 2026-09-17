import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pmPath } from "./paths.ts";
import { watcherIsClean } from "./watcher-coordinator.ts";

/** Low-level SQLite lifecycle, metadata, row iteration, and aggregate queries. */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS files(
  rel TEXT PRIMARY KEY,
  top TEXT NOT NULL,
  root1 TEXT NOT NULL,
  dir TEXT NOT NULL,
  ext TEXT NOT NULL,
  is_test INTEGER NOT NULL,
  is_lock INTEGER NOT NULL,
  mtime REAL NOT NULL,
  size INTEGER NOT NULL,
  loc INTEGER NOT NULL DEFAULT 0,
  skip INTEGER NOT NULL DEFAULT 0,
  trivial INTEGER NOT NULL DEFAULT 0,
  oversize INTEGER NOT NULL DEFAULT 0,
  content_ok INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_files_top ON files(top);
CREATE INDEX IF NOT EXISTS idx_files_root1 ON files(root1);
CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT NOT NULL);
`;

const dbs = new Map<string, DatabaseSync>();

export function getIndex(root: string): DatabaseSync {
  const abs = path.resolve(root);
  let db = dbs.get(abs);
  if (db) return db;
  fs.mkdirSync(pmPath(abs), { recursive: true });
  db = new DatabaseSync(pmPath(abs, "index.db"));
  // journal_mode=WAL itself may need an exclusive lock. Configure the wait
  // policy first so two MCP clients starting together do not race and crash.
  db.exec("PRAGMA busy_timeout=8000");
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA synchronous=NORMAL");
  db.exec(SCHEMA);
  dbs.set(abs, db);
  return db;
}

/** 关闭并释放索引连接（Windows 上打开的 SQLite 文件无法被删除/移动） */
export function closeIndex(root: string): void {
  const abs = path.resolve(root);
  const db = dbs.get(abs);
  if (db) {
    try {
      db.close();
    } catch {
      /* ignore */
    }
    dbs.delete(abs);
  }
}

export function getMeta(db: DatabaseSync, key: string): string | null {
  const row = db.prepare("SELECT v FROM meta WHERE k=?").get(key) as { v: string } | undefined;
  return row?.v ?? null;
}

export function setMeta(db: DatabaseSync, key: string, value: string): void {
  db.prepare("INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(key, value);
}

// Static SQL variants keep statements reusable and avoid dynamic SQL construction.
const SQL_ROWS_ALL = "SELECT rel, ext, is_test, oversize FROM files WHERE is_lock=0 ORDER BY rel";
const SQL_ROWS_NO_OVERSIZE = "SELECT rel, ext, is_test, oversize FROM files WHERE is_lock=0 AND oversize=0 ORDER BY rel";

/** 流式遍历索引行（不整体物化；filter 缺省=全部非锁文件） */
export function* iterateFileRows(
  db: DatabaseSync,
  filter: { excludeTest?: boolean; excludeOversize?: boolean } = {},
): Generator<{ rel: string; ext: string; is_test: number; oversize: number }> {
  const stmt = db.prepare(filter.excludeOversize ? SQL_ROWS_NO_OVERSIZE : SQL_ROWS_ALL);
  for (const row of stmt.iterate() as Iterable<{ rel: string; ext: string; is_test: number; oversize: number }>) {
    if (filter.excludeTest && row.is_test === 1) continue;
    yield row;
  }
}

export interface Aggregates {
  totalFiles: number;
  totalLoc: number;
  testFiles: number;
  skipMarkers: number;
  trivialTests: string[];
  oversizeFiles: string[];
  largestFiles: { path: string; loc: number }[];
  byExt: { ext: string; files: number; loc: number }[];
  topDirs: { dir: string; files: number; loc: number }[];
  rootDirs: string[];
  contentOk: number;
  indexCoverageBase: number;
}

export function aggregates(db: DatabaseSync): Aggregates {
  const one = <T>(sql: string): T => db.prepare(sql).get() as T;
  const total = one<{ c: number; loc: number }>(
    `SELECT COUNT(*) c, COALESCE(SUM(CASE WHEN is_lock=0 THEN loc ELSE 0 END),0) loc FROM files`,
  );
  const test = one<{ c: number }>(`SELECT COUNT(*) c FROM files WHERE is_test=1`);
  const skip = one<{ s: number }>(`SELECT COALESCE(SUM(skip),0) s FROM files`);
  const contentOk = one<{ c: number }>(`SELECT COUNT(*) c FROM files WHERE content_ok=1`);
  return {
    totalFiles: total.c,
    totalLoc: total.loc,
    testFiles: test.c,
    skipMarkers: skip.s,
    trivialTests: (db.prepare(`SELECT rel FROM files WHERE trivial=1 ORDER BY rel LIMIT 20`).all() as Array<{ rel: string }>).map((r) => r.rel),
    oversizeFiles: (db.prepare(`SELECT rel FROM files WHERE oversize=1 ORDER BY rel LIMIT 20`).all() as Array<{ rel: string }>).map((r) => r.rel),
    largestFiles: db.prepare(`SELECT rel AS path, loc FROM files WHERE is_lock=0 ORDER BY loc DESC, rel LIMIT 10`).all() as never,
    byExt: db.prepare(`SELECT ext, COUNT(*) files, COALESCE(SUM(loc),0) loc FROM files WHERE is_lock=0 GROUP BY ext ORDER BY loc DESC`).all() as never,
    topDirs: db.prepare(`SELECT top AS dir, COUNT(*) files, COALESCE(SUM(loc),0) loc FROM files GROUP BY top ORDER BY loc DESC LIMIT 10`).all() as never,
    rootDirs: (db.prepare(`SELECT DISTINCT root1 FROM files`).all() as Array<{ root1: string }>).map((r) => r.root1),
    contentOk: contentOk.c,
    indexCoverageBase: contentOk.c,
  };
}

/** 只读索引状态与摘要，与元数据及聚合查询放在同一模块。 */
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
  const watcherHealthy = !(getMeta(db, "watcherError") ?? "");
  const watcherClean = watcherIsClean(root);
  // 卡死计数自愈：防抖 150ms，若计数>0 但 30s 无任何事件推进，说明计数器失真（如持锁期抛错），不再信任
  const pendingClean = pending === 0 || eventAge > 30_000;
  const fresh =
    files > 0 &&
    lastWalk !== null &&
    owned &&
    mode === "watcher" &&
    sessionReconciled &&
    watcherHealthy &&
    watcherClean &&
    pendingClean &&
    beatAge < BEAT_STALE_MS;
  return { mode, fresh, files, lastWalk, lastBeat, pendingEvents: pending };
}

/** 巡检/诊断用：索引概况一行 */
export function indexSummary(root: string): string {
  const f = freshness(root);
  if (f.files === 0) return "索引：空（未走查）";
  const age = f.lastWalk ? `，走查于 ${f.lastWalk.slice(0, 16).replace("T", " ")}` : "";
  const beat = f.fresh ? "，watcher 保鲜中" : `（watcher ${f.mode === "watcher" ? "心跳过期" : "未运行"}，下次审计将全量走查）`;
  return `索引：${f.files} 文件${age}${beat}`;
}

