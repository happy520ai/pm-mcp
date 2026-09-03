import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { withLedgerLock } from "../src/store.ts";

const WAIT = new Int32Array(new SharedArrayBuffer(4));
const STORE_URL = pathToFileURL(path.resolve("src/store.ts")).href;

function pause(ms: number): void {
  Atomics.wait(WAIT, 0, 0, ms);
}

function fixture(t: test.TestContext, name: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `pm-mcp-${name}-`));
  fs.mkdirSync(path.join(root, ".pm"), { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function deadPid(): number {
  // This value is outside the Windows PID range and is also rejected by POSIX kernels.
  return 2_147_483_647;
}

function waitForExit(child: ChildProcess, timeoutMs = 15_000): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`child ${child.pid ?? "unknown"} did not exit in ${timeoutMs}ms`));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stderr });
    });
  });
}

async function waitUntil(predicate: () => boolean, timeoutMs: number, description: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const stampedeWorker = String.raw`
  import fs from "node:fs";
  import path from "node:path";
  const { withLedgerLock } = await import(process.env.LOCK_STORE_URL);
  const root = process.env.LOCK_ROOT;
  const id = process.env.LOCK_WORKER_ID;
  const ready = path.join(root, ".pm", "ready", id);
  const go = path.join(root, ".pm", "go");
  const stateFile = path.join(root, ".pm", "stampede.json");
  fs.writeFileSync(ready, "ready");
  const wait = new Int32Array(new SharedArrayBuffer(4));
  while (!fs.existsSync(go)) Atomics.wait(wait, 0, 0, 5);
  try {
    withLedgerLock(root, () => {
      let state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
      state.active += 1;
      state.peak = Math.max(state.peak, state.active);
      fs.writeFileSync(stateFile, JSON.stringify(state));
      Atomics.wait(wait, 0, 0, 15);
      state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
      state.records.push(id);
      state.active -= 1;
      fs.writeFileSync(stateFile, JSON.stringify(state));
    });
  } catch (error) {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  }
`;

test("20 processes reclaim one dead stale owner without ABA or overlapping writes", { timeout: 25_000 }, async (t) => {
  const root = fixture(t, "lock-stampede");
  const pm = path.join(root, ".pm");
  const ready = path.join(pm, "ready");
  const lock = path.join(pm, ".lock");
  const stateFile = path.join(pm, "stampede.json");
  fs.mkdirSync(ready);
  fs.writeFileSync(stateFile, JSON.stringify({ active: 0, peak: 0, records: [] }));
  fs.writeFileSync(lock, JSON.stringify({ pid: deadPid(), token: randomUUID(), created_at: new Date(0).toISOString() }));
  const stale = new Date(Date.now() - 20_000);
  fs.utimesSync(lock, stale, stale);

  const children = Array.from({ length: 20 }, (_, index) => spawn(process.execPath, ["--input-type=module", "-e", stampedeWorker], {
    env: {
      ...process.env,
      NODE_NO_WARNINGS: "1",
      LOCK_STORE_URL: STORE_URL,
      LOCK_ROOT: root,
      LOCK_WORKER_ID: `worker-${index}`,
    },
    stdio: ["ignore", "ignore", "pipe"],
  }));
  t.after(() => children.forEach((child) => {
    if (child.exitCode === null) child.kill();
  }));

  await waitUntil(() => fs.readdirSync(ready).length === children.length, 12_000, "all workers to reach the barrier");
  fs.writeFileSync(path.join(pm, "go"), "go");
  const exits = await Promise.all(children.map((child) => waitForExit(child)));
  assert.deepEqual(exits.map((entry) => entry.code), Array(children.length).fill(0), exits.map((entry) => entry.stderr).join("\n"));

  const state = JSON.parse(fs.readFileSync(stateFile, "utf8")) as { active: number; peak: number; records: string[] };
  assert.equal(state.peak, 1, "the critical section must never overlap");
  assert.equal(state.active, 0);
  assert.equal(state.records.length, children.length, "all distinct writes must survive");
  assert.equal(new Set(state.records).size, children.length, "each worker must commit exactly one record");
  assert.ok(!fs.existsSync(lock), "the final owner must release the observable lock file");
});

const longHolder = String.raw`
  import fs from "node:fs";
  import path from "node:path";
  const { withLedgerLock } = await import(process.env.LOCK_STORE_URL);
  const root = process.env.LOCK_ROOT;
  const marker = path.join(root, ".pm", "holder-ready");
  const wait = new Int32Array(new SharedArrayBuffer(4));
  withLedgerLock(root, () => {
    fs.writeFileSync(marker, "ready");
    Atomics.wait(wait, 0, 0, 4_500);
  });
`;

test("a live process keeps an old-looking long-held lock", { timeout: 12_000 }, async (t) => {
  const root = fixture(t, "live-long-lock");
  const lock = path.join(root, ".pm", ".lock");
  const marker = path.join(root, ".pm", "holder-ready");
  const holder = spawn(process.execPath, ["--input-type=module", "-e", longHolder], {
    env: { ...process.env, NODE_NO_WARNINGS: "1", LOCK_STORE_URL: STORE_URL, LOCK_ROOT: root },
    stdio: ["ignore", "ignore", "pipe"],
  });
  t.after(() => {
    if (holder.exitCode === null) holder.kill();
  });
  await waitUntil(() => fs.existsSync(marker), 5_000, "long-held lock");
  const stale = new Date(Date.now() - 20_000);
  fs.utimesSync(lock, stale, stale);

  assert.throws(() => withLedgerLock(root, () => "must not run"), /账本锁获取超时/);
  assert.equal((await waitForExit(holder, 5_000)).code, 0);
  assert.ok(!fs.existsSync(lock));
});

test("release requires the complete pid and lock ownership stamp", (t) => {
  const root = fixture(t, "lock-owner");
  const lock = path.join(root, ".pm", ".lock");

  withLedgerLock(root, () => {
    const acquired = JSON.parse(fs.readFileSync(lock, "utf8")) as { token: string; created_at: string };
    fs.writeFileSync(lock, JSON.stringify({ ...acquired, pid: deadPid() }));
  });

  assert.ok(fs.existsSync(lock), "a same-token file with a different PID must not be deleted");
  const retained = JSON.parse(fs.readFileSync(lock, "utf8")) as { pid: number };
  assert.equal(retained.pid, deadPid());
});

test("a killed current-protocol owner is recovered immediately even after PID reuse", (t) => {
  const root = fixture(t, "lock-protocol-crash");
  const lock = path.join(root, ".pm", ".lock");
  const marker = path.join(root, ".pm", "crash-entered");
  const child = String.raw`
    import fs from "node:fs";
    import path from "node:path";
    const { withLedgerLock } = await import(process.env.LOCK_STORE_URL);
    const root = process.env.LOCK_ROOT;
    withLedgerLock(root, () => {
      fs.writeFileSync(path.join(root, ".pm", "crash-entered"), "yes");
      process.exit(91);
    });
  `;
  const crashed = spawnSync(process.execPath, ["--input-type=module", "-e", child], {
    env: { ...process.env, NODE_NO_WARNINGS: "1", LOCK_STORE_URL: STORE_URL, LOCK_ROOT: root },
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(crashed.status, 91, crashed.stderr);
  assert.ok(fs.existsSync(marker));

  const residual = JSON.parse(fs.readFileSync(lock, "utf8")) as Record<string, unknown>;
  assert.equal(residual.protocol, "sqlite-guard-v1");
  fs.writeFileSync(lock, JSON.stringify({ ...residual, pid: process.pid }));
  const started = Date.now();
  assert.equal(withLedgerLock(root, () => "recovered"), "recovered");
  assert.ok(Date.now() - started < 1_000, "guard-owned residue must not wait for the 10s legacy lease");
  assert.ok(!fs.existsSync(lock));
});
