import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const ELECTION_POLL_MS = 1_000;
const ELECTION_BUSY_MS = 20;

export interface WatcherCoordinator {
  stop(): void;
}

export function watcherDirtyFile(root: string): string {
  return path.join(path.resolve(root), ".pm", ".runtime", "watcher-dirty");
}

export function markWatcherDirty(root: string): void {
  const file = watcherDirtyFile(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${new Date().toISOString()}\n`, "utf8");
}

export function clearWatcherDirty(root: string): void {
  try { fs.rmSync(watcherDirtyFile(root)); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export function watcherIsClean(root: string): boolean {
  return !fs.existsSync(watcherDirtyFile(root));
}

function sqliteBusy(error: unknown): boolean {
  const candidate = error as { errcode?: unknown; message?: unknown };
  return candidate.errcode === 5 ||
    (typeof candidate.message === "string" && /database is (?:locked|busy)/i.test(candidate.message));
}

function openElection(root: string): DatabaseSync {
  const file = path.join(path.resolve(root), ".pm", ".runtime", "watcher-leader.db");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  try {
    db.exec(`PRAGMA busy_timeout=${ELECTION_BUSY_MS}`);
    return db;
  } catch (error) {
    try { db.close(); } catch { /* best effort */ }
    throw error;
  }
}

function acquire(db: DatabaseSync): boolean {
  if (db.isTransaction) return true;
  try {
    // Avoid startup DDL so late standbys can join while a leader holds the DB.
    // The transactional header write forces ownership even when an empty DB
    // would otherwise defer materializing the write reservation on this OS.
    db.exec("BEGIN IMMEDIATE");
    db.exec("PRAGMA user_version=1");
    return true;
  } catch (error) {
    if (db.isTransaction) {
      try { db.exec("ROLLBACK"); } catch { /* close remains the fail-safe */ }
    }
    if (sqliteBusy(error)) return false;
    throw error;
  }
}

function release(db: DatabaseSync): void {
  if (db.isTransaction) db.exec("ROLLBACK");
}

/**
 * Elect exactly one watcher with a dedicated SQLite write transaction held for
 * its lifetime. The OS releases the transaction after a force kill; standbys
 * poll and take over without PID guesses, leases, or stale-file deletion.
 */
export function coordinateWatcherLeader(
  root: string,
  activate: () => (() => void) | null,
  report: (stage: string, error: unknown) => void,
): WatcherCoordinator | null {
  let election: DatabaseSync;
  try {
    election = openElection(root);
  } catch (error) {
    report("leader election unavailable", error);
    return null;
  }

  let cleanup: (() => void) | null = null;
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  let unavailable = false;

  const relinquish = (): void => {
    try { cleanup?.(); } catch (error) { report("leader cleanup", error); }
    cleanup = null;
    try { release(election); } catch (error) {
      report("leadership release", error);
      unavailable = true;
      try { election.close(); } catch { /* OS close releases the transaction */ }
    }
  };

  const elect = (): void => {
    if (stopped || unavailable || cleanup) return;
    let acquired = false;
    try {
      acquired = acquire(election);
    } catch (error) {
      report("leader election", error);
      unavailable = true;
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
      try { election.close(); } catch { /* best effort */ }
      return;
    }
    if (!acquired) return;
    try {
      const activated = activate();
      if (!activated) unavailable = true;
      else cleanup = activated;
    } catch (error) {
      report("leader activation", error);
    }
    if (!cleanup) relinquish();
    if (unavailable) {
      if (timer) clearInterval(timer);
      timer = null;
      stopped = true;
      try { election.close(); } catch { /* best effort */ }
    }
  };

  elect();
  if (unavailable) {
    try { election.close(); } catch { /* best effort */ }
    return null;
  }
  timer = setInterval(elect, ELECTION_POLL_MS);
  timer.unref();
  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
      relinquish();
      try { election.close(); } catch { /* best effort */ }
    },
  };
}
