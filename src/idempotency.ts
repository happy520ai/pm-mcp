import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { atomicWrite, withLedgerLock } from "./store.ts";
import { pmPath, registryFile } from "./paths.ts";

export const IdempotencyKeySchema = z.string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, "仅允许 ASCII 字母、数字、点、下划线、冒号和连字符");

const OperationRecordSchema = z.object({
  schema_version: z.literal(1),
  key: z.string().min(1).max(256),
  explicit: z.boolean(),
  tool: z.string().min(1),
  args_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  mode: z.enum(["read", "write"]),
  status: z.enum(["pending", "completed"]),
  owner_pid: z.number().int().positive(),
  owner_token: z.string().uuid(),
  created_at: z.string().datetime({ offset: true }),
  updated_at: z.string().datetime({ offset: true }),
  result: z.string().nullable(),
});
type OperationRecord = z.infer<typeof OperationRecordSchema>;

export interface IdempotentResult {
  text: string;
  replayed: boolean;
  pending: boolean;
  key: string;
}

const AUTO_REPLAY_MS = 1_000;
const READ_WAIT_MS = 30_000;
const LOCK_STALE_MS = 10_000;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonical(item)]),
    );
  }
  return value;
}

export function operationArgsHash(args: unknown): string {
  return sha256(JSON.stringify(canonical(args)));
}

export function splitIdempotencyArgs<Args>(args: Args): { businessArgs: Args; explicitKey?: string } {
  if (!args || typeof args !== "object" || Array.isArray(args)) return { businessArgs: args };
  const { idempotency_key: rawKey, ...business } = args as Record<string, unknown>;
  const explicitKey = rawKey === undefined ? undefined : IdempotencyKeySchema.parse(rawKey);
  return { businessArgs: business as Args, ...(explicitKey ? { explicitKey } : {}) };
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function operationDirectory(root: string): string {
  return path.join(path.dirname(registryFile()), "idempotency", sha256(path.resolve(root)));
}

function revisionFile(root: string): string {
  return path.join(operationDirectory(root), "revision");
}

function readRevision(root: string): string {
  try {
    return fs.readFileSync(revisionFile(root), "utf8").trim() || "0";
  } catch {
    return "0";
  }
}

function bumpRevision(root: string): void {
  fs.mkdirSync(operationDirectory(root), { recursive: true });
  atomicWrite(revisionFile(root), randomUUID() + "\n");
}

function operationFile(root: string, key: string): string {
  return path.join(operationDirectory(root), `${sha256(key)}.json`);
}

function readRecord(file: string): OperationRecord | null {
  if (!fs.existsSync(file)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`幂等记录损坏，拒绝继续写入: ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = OperationRecordSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`幂等记录 schema 无效，拒绝继续写入: ${file}`);
  return parsed.data;
}

function lockOwner(file: string): { pid: number; token: string } | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { pid?: unknown; token?: unknown };
    return typeof parsed.pid === "number" && typeof parsed.token === "string" ? { pid: parsed.pid, token: parsed.token } : null;
  } catch {
    return null;
  }
}

function withOperationLock<T>(file: string, fn: () => T): T {
  const lock = `${file}.lock`;
  const token = randomUUID();
  const payload = JSON.stringify({ pid: process.pid, token });
  let held = false;
  for (let index = 0; index < 150 && !held; index += 1) {
    try {
      fs.writeFileSync(lock, payload, { flag: "wx" });
      held = true;
    } catch {
      try {
        const current = lockOwner(lock);
        const stale = Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS;
        if (stale && (!current || !processAlive(current.pid))) fs.rmSync(lock, { force: true });
      } catch {
        // The lock disappeared between checks; retry.
      }
      if (!held) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  if (!held) throw new Error("幂等键锁获取超时（3s），请稍后重试同一 idempotency_key。");
  try {
    return fn();
  } finally {
    try {
      if (lockOwner(lock)?.token === token) fs.rmSync(lock, { force: true });
    } catch {
      // Best-effort release; stale-owner recovery handles process crashes.
    }
  }
}

type Claim =
  | { kind: "execute"; file: string; record: OperationRecord }
  | { kind: "replay"; record: OperationRecord }
  | { kind: "pending"; file: string; record: OperationRecord };

function claim(root: string, tool: string, args: unknown, mode: "read" | "write", explicitKey?: string): Claim {
  const argsHash = operationArgsHash(args);
  const key = explicitKey ?? `auto:${mode}:${tool}:${argsHash}`;
  const file = operationFile(root, key);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return withOperationLock(file, () => {
    const existing = readRecord(file);
    if (existing) {
      if (existing.key !== key || existing.tool !== tool || existing.mode !== mode || existing.args_sha256 !== argsHash) {
        throw new Error(`idempotency_key 冲突：${key} 已绑定其他工具或参数，拒绝误复用。`);
      }
      if (existing.status === "completed") {
        const age = Date.now() - Date.parse(existing.updated_at);
        if (existing.explicit || (mode === "write" && age <= AUTO_REPLAY_MS)) return { kind: "replay", record: existing };
      } else if (processAlive(existing.owner_pid)) {
        return { kind: "pending", file, record: existing };
      }
    }
    const timestamp = new Date().toISOString();
    const record: OperationRecord = {
      schema_version: 1,
      key,
      explicit: explicitKey !== undefined,
      tool,
      args_sha256: argsHash,
      mode,
      status: "pending",
      owner_pid: process.pid,
      owner_token: randomUUID(),
      created_at: timestamp,
      updated_at: timestamp,
      result: null,
    };
    atomicWrite(file, JSON.stringify(OperationRecordSchema.parse(record), null, 2) + "\n");
    return { kind: "execute", file, record };
  });
}

function complete(file: string, reservation: OperationRecord, result: string): void {
  withOperationLock(file, () => {
    const current = readRecord(file);
    if (!current || current.owner_token !== reservation.owner_token || current.status !== "pending") {
      throw new Error(`幂等记录所有权变化，拒绝把结果写到其他操作: ${reservation.key}`);
    }
    current.status = "completed";
    current.result = result;
    current.updated_at = new Date().toISOString();
    atomicWrite(file, JSON.stringify(OperationRecordSchema.parse(current), null, 2) + "\n");
  });
}

function abandon(file: string, reservation: OperationRecord): void {
  try {
    withOperationLock(file, () => {
      const current = readRecord(file);
      if (current?.owner_token === reservation.owner_token && current.status === "pending") fs.rmSync(file, { force: true });
    });
  } catch {
    // Preserve the original operation error. A dead-owner retry can recover later.
  }
}

function replay(record: OperationRecord): IdempotentResult {
  return {
    text: record.result ?? `⏳ 相同业务正在由另一 Agent 执行：${record.key}`,
    replayed: record.status === "completed",
    pending: record.status === "pending",
    key: record.key,
  };
}

export function runIdempotentWriteSync<Args>(
  root: string,
  tool: string,
  args: Args,
  fn: (businessArgs: Args) => string,
): IdempotentResult {
  const { businessArgs, explicitKey } = splitIdempotencyArgs(args);
  const reservation = claim(root, tool, businessArgs, "write", explicitKey);
  if (reservation.kind !== "execute") return replay(reservation.record);
  try {
    const text = withLedgerLock(root, () => {
      const value = fn(businessArgs);
      bumpRevision(root);
      return value;
    });
    complete(reservation.file, reservation.record, text);
    return { text, replayed: false, pending: false, key: reservation.record.key };
  } catch (error) {
    abandon(reservation.file, reservation.record);
    throw error;
  }
}

export async function runIdempotentWrite<Args>(
  root: string,
  tool: string,
  args: Args,
  fn: (businessArgs: Args) => string | Promise<string>,
): Promise<IdempotentResult> {
  const { businessArgs, explicitKey } = splitIdempotencyArgs(args);
  const reservation = claim(root, tool, businessArgs, "write", explicitKey);
  if (reservation.kind !== "execute") return replay(reservation.record);
  try {
    const text = await fn(businessArgs);
    bumpRevision(root);
    complete(reservation.file, reservation.record, text);
    return { text, replayed: false, pending: false, key: reservation.record.key };
  } catch (error) {
    abandon(reservation.file, reservation.record);
    throw error;
  }
}

async function waitForRead(file: string, record: OperationRecord): Promise<OperationRecord | null> {
  const deadline = Date.now() + READ_WAIT_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    const current = readRecord(file);
    if (!current || current.owner_token !== record.owner_token) return null;
    if (current.status === "completed") return current;
    if (!processAlive(current.owner_pid)) return null;
  }
  return null;
}

export async function runCoalescedRead<Args>(
  root: string,
  tool: string,
  args: Args,
  fn: (businessArgs: Args) => string | Promise<string>,
): Promise<IdempotentResult> {
  // Read-only calls before project initialization must not create .pm state.
  if (!fs.existsSync(pmPath(root, "project.json"))) {
    const text = await fn(args);
    return { text, replayed: false, pending: false, key: "uncached:uninitialized" };
  }
  const readClaim = (): Claim => claim(root, tool, { revision: readRevision(root), args }, "read");
  let reservation = readClaim();
  if (reservation.kind === "replay") return replay(reservation.record);
  if (reservation.kind === "pending") {
    const completed = await waitForRead(reservation.file, reservation.record);
    if (completed) return replay(completed);
    reservation = readClaim();
    if (reservation.kind !== "execute") return replay(reservation.record);
  }
  try {
    const text = await fn(args);
    complete(reservation.file, reservation.record, text);
    return { text, replayed: false, pending: false, key: reservation.record.key };
  } catch (error) {
    abandon(reservation.file, reservation.record);
    throw error;
  }
}
