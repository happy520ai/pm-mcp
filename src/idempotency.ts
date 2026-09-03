import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { atomicWrite, withFileRecoveryLock, withLedgerLock } from "./store.ts";
import { ensurePmRuntimeIgnored, pmPath, registryFile } from "./paths.ts";

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
  status: z.enum(["pending", "completed", "uncertain"]),
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
  uncertain: boolean;
  key: string;
}

const AUTO_REPLAY_MS = 1_000;
const DEFAULT_PENDING_LEASE_MS = 60 * 60_000;
const DEFAULT_WRITE_WAIT_MS = 3_000;
const MAX_CLOCK_SKEW_MS = 5_000;
const SYNC_WAIT = new Int32Array(new SharedArrayBuffer(4));
let readWaitMs = 30_000;
let pendingLeaseMs = DEFAULT_PENDING_LEASE_MS;
let writeWaitMs = DEFAULT_WRITE_WAIT_MS;

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
  let canonical = path.resolve(root);
  try { canonical = fs.realpathSync.native(canonical); } catch { /* init_project may not exist yet */ }
  ensurePmRuntimeIgnored(canonical);
  return pmPath(canonical, ".runtime", "idempotency");
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

function legacyOperationFiles(root: string, key: string): string[] {
  const resolved = path.resolve(root);
  let real = resolved;
  try { real = fs.realpathSync.native(resolved); } catch { /* keep resolved */ }
  const identities = new Set([resolved, real]);
  if (process.platform === "win32") {
    identities.add(resolved.toLowerCase());
    identities.add(resolved.toUpperCase());
    identities.add(real.toLowerCase());
    identities.add(real.toUpperCase());
  }
  const homes = new Set([path.dirname(registryFile()), path.join(os.homedir(), ".pm-mcp")]);
  const name = `${sha256(key)}.json`;
  return [...homes].flatMap((home) => [...identities].map((identity) =>
    path.join(home, "idempotency", sha256(identity), name)));
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

function migrateLegacyRecord(root: string, key: string, currentFile: string): OperationRecord | null {
  const legacy = [...new Set(legacyOperationFiles(root, key))].filter((file) => fs.existsSync(file));
  if (legacy.length === 0) return null;
  const records = legacy.map((file) => readRecord(file)!);
  const first = JSON.stringify(records[0]);
  if (records.some((record) => JSON.stringify(record) !== first)) {
    throw new Error(`检测到多个不一致的 v0.1.3 幂等记录，拒绝自动迁移业务键: ${key}`);
  }
  atomicWrite(currentFile, JSON.stringify(OperationRecordSchema.parse(records[0]), null, 2) + "\n");
  return records[0];
}

function pendingLeaseExpired(record: OperationRecord): boolean {
  const age = Date.now() - Date.parse(record.updated_at);
  return !Number.isFinite(age) || age < -MAX_CLOCK_SKEW_MS || age >= pendingLeaseMs;
}

function withOperationLock<T>(file: string, fn: () => T): T {
  return withFileRecoveryLock(`${file}.lock`, fn, {
    timeoutMessage: "幂等键锁获取超时（3s），请稍后重试同一 idempotency_key。",
  });
}

type Claim =
  | { kind: "execute"; file: string; record: OperationRecord }
  | { kind: "replay"; record: OperationRecord }
  | { kind: "pending"; file: string; record: OperationRecord }
  | { kind: "uncertain"; record: OperationRecord };

function claim(root: string, tool: string, args: unknown, mode: "read" | "write", explicitKey?: string): Claim {
  const argsHash = operationArgsHash(args);
  const key = explicitKey ?? `auto:${mode}:${tool}:${argsHash}`;
  const file = operationFile(root, key);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return withOperationLock(file, () => {
    const existing = readRecord(file) ?? migrateLegacyRecord(root, key, file);
    if (existing) {
      if (existing.key !== key || existing.tool !== tool || existing.mode !== mode || existing.args_sha256 !== argsHash) {
        throw new Error(`idempotency_key 冲突：${key} 已绑定其他工具或参数，拒绝误复用。`);
      }
      if (existing.status === "completed") {
        const age = Date.now() - Date.parse(existing.updated_at);
        if (
          existing.explicit ||
          (mode === "write" && age <= AUTO_REPLAY_MS)
        ) return { kind: "replay", record: existing };
      } else if (existing.status === "uncertain") {
        return { kind: "uncertain", record: existing };
      } else {
        const expired = pendingLeaseExpired(existing);
        const ownerAlive = processAlive(existing.owner_pid);
        if (mode === "write") {
          if (!expired && ownerAlive) return { kind: "pending", file, record: existing };
          // A write may already have changed external or ledger state. Neither an
          // expired lease nor a dead/reused PID proves that replay is safe.
          existing.status = "uncertain";
          existing.updated_at = new Date().toISOString();
          atomicWrite(file, JSON.stringify(OperationRecordSchema.parse(existing), null, 2) + "\n");
          return { kind: "uncertain", record: existing };
        }
        // Reads are side-effect-free by contract. Keep a real active lease, but
        // replace an expired or dead-owner reservation with a fresh execution.
        if (!expired && ownerAlive) return { kind: "pending", file, record: existing };
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

function markUncertain(file: string, reservation: OperationRecord): void {
  try {
    withOperationLock(file, () => {
      const current = readRecord(file);
      if (current?.owner_token !== reservation.owner_token || current.status !== "pending") return;
      current.status = "uncertain";
      current.updated_at = new Date().toISOString();
      atomicWrite(file, JSON.stringify(OperationRecordSchema.parse(current), null, 2) + "\n");
    });
  } catch {
    // Preserve the business error. The pending explicit key remains fail-closed.
  }
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
  const uncertain = record.status === "uncertain" || (
    record.status === "pending" && record.mode === "write" &&
    (!processAlive(record.owner_pid) || pendingLeaseExpired(record))
  );
  return {
    text: record.result ?? (uncertain
      ? `⚠️ 业务结果不确定，已禁止自动重放：${record.key}。请核对目标账本后决定是否使用新的业务键。`
      : `⏳ 相同业务正在由另一 Agent 执行：${record.key}`),
    replayed: record.status === "completed",
    pending: record.status !== "completed",
    uncertain,
    key: record.key,
  };
}

function currentWriteSettlement(file: string, reservation: OperationRecord): OperationRecord | null | undefined {
  const current = readRecord(file);
  if (!current || current.owner_token !== reservation.owner_token) return null;
  if (current.status !== "pending") return current;
  if (!processAlive(current.owner_pid) || pendingLeaseExpired(current)) return null;
  return undefined;
}

function waitForWriteSync(file: string, reservation: OperationRecord): OperationRecord | null {
  const deadline = Date.now() + writeWaitMs;
  while (Date.now() < deadline) {
    const current = currentWriteSettlement(file, reservation);
    if (current !== undefined) return current;
    Atomics.wait(SYNC_WAIT, 0, 0, Math.min(25, Math.max(0, deadline - Date.now())));
  }
  return null;
}

async function waitForWrite(file: string, reservation: OperationRecord): Promise<OperationRecord | null> {
  const deadline = Date.now() + writeWaitMs;
  while (Date.now() < deadline) {
    const current = currentWriteSettlement(file, reservation);
    if (current !== undefined) return current;
    await new Promise((resolve) => setTimeout(resolve, Math.min(25, Math.max(0, deadline - Date.now()))));
  }
  return null;
}

export function runIdempotentWriteSync<Args, Prepared = void>(
  root: string,
  tool: string,
  args: Args,
  fn: (businessArgs: Args, prepared: Prepared) => string,
  prepare?: (businessArgs: Args) => Prepared,
): IdempotentResult {
  const { businessArgs, explicitKey } = splitIdempotencyArgs(args);
  let reservation = claim(root, tool, businessArgs, "write", explicitKey);
  if (reservation.kind === "pending") {
    const settled = waitForWriteSync(reservation.file, reservation.record);
    if (settled) return replay(settled);
    reservation = claim(root, tool, businessArgs, "write", explicitKey);
  }
  if (reservation.kind !== "execute") return replay(reservation.record);
  let handlerStarted = false;
  try {
    const prepared = prepare?.(businessArgs) as Prepared;
    const text = withLedgerLock(root, () => {
      handlerStarted = true;
      const value = fn(businessArgs, prepared);
      idempotencyFault("after-business");
      bumpRevision(root);
      idempotencyFault("after-revision");
      return value;
    });
    idempotencyFault("before-complete");
    complete(reservation.file, reservation.record, text);
    return { text, replayed: false, pending: false, uncertain: false, key: reservation.record.key };
  } catch (error) {
    if (handlerStarted) markUncertain(reservation.file, reservation.record);
    else abandon(reservation.file, reservation.record);
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
  let reservation = claim(root, tool, businessArgs, "write", explicitKey);
  if (reservation.kind === "pending") {
    const settled = await waitForWrite(reservation.file, reservation.record);
    if (settled) return replay(settled);
    reservation = claim(root, tool, businessArgs, "write", explicitKey);
  }
  if (reservation.kind !== "execute") return replay(reservation.record);
  let handlerStarted = false;
  try {
    handlerStarted = true;
    const text = await fn(businessArgs);
    idempotencyFault("after-business");
    bumpRevision(root);
    idempotencyFault("after-revision");
    idempotencyFault("before-complete");
    complete(reservation.file, reservation.record, text);
    return { text, replayed: false, pending: false, uncertain: false, key: reservation.record.key };
  } catch (error) {
    if (handlerStarted) markUncertain(reservation.file, reservation.record);
    else abandon(reservation.file, reservation.record);
    throw error;
  }
}

async function waitForRead(file: string, record: OperationRecord): Promise<OperationRecord | null> {
  const deadline = Date.now() + readWaitMs;
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
    return { text, replayed: false, pending: false, uncertain: false, key: "uncached:uninitialized" };
  }
  const readClaim = (): Claim => claim(root, tool, { revision: readRevision(root), args }, "read");
  let reservation = readClaim();
  if (reservation.kind === "replay") return replay(reservation.record);
  if (reservation.kind === "uncertain") throw new Error("并行读取状态不确定；请稍后重试。");
  if (reservation.kind === "pending") {
    const completed = await waitForRead(reservation.file, reservation.record);
    if (completed) return replay(completed);
    reservation = readClaim();
    if (reservation.kind === "pending") throw new Error(`并行读取等待超过 ${readWaitMs}ms，leader 仍在执行；请稍后重试。`);
    if (reservation.kind === "uncertain") throw new Error("并行读取状态不确定；请稍后重试。");
    if (reservation.kind === "replay") return replay(reservation.record);
  }
  if (reservation.kind !== "execute") throw new Error("并行读取未获得执行权；请稍后重试。");
  try {
    const text = await fn(args);
    complete(reservation.file, reservation.record, text);
    return { text, replayed: false, pending: false, uncertain: false, key: reservation.record.key };
  } catch (error) {
    abandon(reservation.file, reservation.record);
    throw error;
  }
}

type FaultStage = "after-business" | "after-revision" | "before-complete";
let faultHook: ((stage: FaultStage) => void) | undefined;

function idempotencyFault(stage: FaultStage): void {
  faultHook?.(stage);
}

/** 仅供故障注入测试；生产调用方不应设置。 */
export function setIdempotencyFaultHookForTests(hook?: (stage: FaultStage) => void): void {
  faultHook = hook;
}

/** 仅供故障注入测试，传 undefined 恢复生产默认值。 */
export function setReadWaitMsForTests(value?: number): void {
  readWaitMs = value ?? 30_000;
}

/** 仅供 PID 复用与 lease 故障注入测试；传 undefined 恢复生产默认值。 */
export function setPendingLeaseMsForTests(value?: number): void {
  if (value !== undefined && (!Number.isFinite(value) || value <= 0)) {
    throw new RangeError("pending lease 必须大于 0ms。");
  }
  pendingLeaseMs = value ?? DEFAULT_PENDING_LEASE_MS;
}

/** 仅供 follower 等待边界测试；传 undefined 恢复生产默认值。 */
export function setWriteWaitMsForTests(value?: number): void {
  if (value !== undefined && (!Number.isFinite(value) || value < 0)) throw new RangeError("write wait 不得小于 0ms。");
  writeWaitMs = value ?? DEFAULT_WRITE_WAIT_MS;
}
