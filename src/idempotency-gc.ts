import fs from "node:fs";
import path from "node:path";

/* 幂等缓存回收策略：完成记录不是业务账本，不能无限增长。
   - 读记录：10 分钟（读结果只用于短窗合并，revision 变化后本就失效）
   - 自动写记录：24 小时（远大于 1s replay 窗口，保留足够排障线索）
   - 显式写记录：90 天（业务幂等键需要长期保留；到期后同名键会重新执行，调用方应确保键不复用）
   pending/uncertain 一律保留：它们代表在飞或结果未知，只能人工处置。 */
const READ_RECORD_TTL_MS = 10 * 60_000;
const AUTO_WRITE_RECORD_TTL_MS = 24 * 60 * 60_000;
const EXPLICIT_WRITE_RECORD_TTL_MS = 90 * 24 * 60 * 60_000;
const GC_INTERVAL_MS = 10 * 60_000;
const lastGcByDirectory = new Map<string, number>();

/** 业务处理器已确认「没有产生任何副作用」时抛出：幂等占位应放弃，允许同键重试。 */
export class NoSideEffectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoSideEffectError";
  }
}

export interface GcRecord {
  status: "pending" | "completed" | "uncertain";
  mode: "read" | "write";
  explicit: boolean;
  updated_at: string;
}

export interface IdempotencyGcStats {
  scanned: number;
  removed: number;
  kept: number;
}

/** 回收过期完成记录；进程内按目录节流。依赖注入读取器，避免与记录模块循环依赖。 */
export function gcOperationRecords(
  directory: string,
  read: (file: string) => GcRecord | null,
  options: { now?: number; force?: boolean } = {},
): IdempotencyGcStats {
  const now = options.now ?? Date.now();
  const last = lastGcByDirectory.get(directory) ?? 0;
  if (!options.force && now - last < GC_INTERVAL_MS) return { scanned: 0, removed: 0, kept: 0 };
  lastGcByDirectory.set(directory, now);
  let names: string[];
  try {
    names = fs.readdirSync(directory);
  } catch {
    return { scanned: 0, removed: 0, kept: 0 };
  }
  let scanned = 0;
  let removed = 0;
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(directory, name);
    let record: GcRecord;
    try {
      const current = read(file);
      if (!current) continue;
      record = current;
    } catch {
      continue; // 损坏记录交给人工处理，GC 不擅自删除
    }
    scanned += 1;
    if (record.status !== "completed") continue;
    const age = now - Date.parse(record.updated_at);
    const ttl = record.mode === "read"
      ? READ_RECORD_TTL_MS
      : record.explicit ? EXPLICIT_WRITE_RECORD_TTL_MS : AUTO_WRITE_RECORD_TTL_MS;
    if (!Number.isFinite(age) || age <= ttl) continue;
    try {
      fs.rmSync(file, { force: true });
      removed += 1;
    } catch {
      // 权限/占用导致的清理失败不能影响业务调用，下轮再试
    }
  }
  return { scanned, removed, kept: scanned - removed };
}

/** 缓存体量统计，供 doctor / 运维排查使用。 */
export function operationCacheStats(directory: string): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  try {
    for (const name of fs.readdirSync(directory)) {
      if (!name.endsWith(".json")) continue;
      try {
        const stat = fs.statSync(path.join(directory, name));
        if (stat.isFile()) {
          files += 1;
          bytes += stat.size;
        }
      } catch {
        // 统计尽力而为
      }
    }
  } catch {
    return { files: 0, bytes: 0 };
  }
  return { files, bytes };
}
