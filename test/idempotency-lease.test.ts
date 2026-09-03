import test from "node:test";
import assert from "node:assert/strict";
import {
  runCoalescedRead,
  runIdempotentWrite,
  runIdempotentWriteSync,
  setPendingLeaseMsForTests,
  setWriteWaitMsForTests,
} from "../src/idempotency.ts";
import { initProject } from "../src/init.ts";
import { mkProj } from "./helpers.ts";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("a live unexpired write owner remains pending and is not taken over", async (t) => {
  const root = mkProj();
  initProject(root, { name: "live-write-lease" });
  const entered = deferred();
  const finish = deferred();
  t.after(finish.resolve);
  setPendingLeaseMsForTests(500);
  t.after(() => setPendingLeaseMsForTests());
  setWriteWaitMsForTests(30);
  t.after(() => setWriteWaitMsForTests());
  let executions = 0;

  const leader = runIdempotentWrite(root, "leased-write", { value: 1, idempotency_key: "LEASE:live" }, async () => {
    executions += 1;
    entered.resolve();
    await finish.promise;
    return "leader-result";
  });
  await entered.promise;
  const follower = await runIdempotentWrite(root, "leased-write", { value: 1, idempotency_key: "LEASE:live" }, async () => {
    executions += 1;
    return "must-not-run";
  });

  assert.equal(follower.pending, true);
  assert.equal(follower.uncertain, false);
  assert.match(follower.text, /正在.*执行/);
  assert.equal(executions, 1);
  finish.resolve();
  assert.equal((await leader).text, "leader-result");
});

test("an expired pending write becomes uncertain even when its PID is still alive", async (t) => {
  const root = mkProj();
  initProject(root, { name: "expired-write-lease" });
  const entered = deferred();
  const finish = deferred();
  t.after(finish.resolve);
  setPendingLeaseMsForTests(30);
  t.after(() => setPendingLeaseMsForTests());
  let executions = 0;

  const leader = runIdempotentWrite(root, "leased-write", { value: 1, idempotency_key: "LEASE:expired" }, async () => {
    executions += 1;
    entered.resolve();
    await finish.promise;
    return "possibly-applied";
  });
  await entered.promise;
  await delay(50);
  const follower = await runIdempotentWrite(root, "leased-write", { value: 1, idempotency_key: "LEASE:expired" }, async () => {
    executions += 1;
    return "duplicate";
  });

  assert.equal(follower.pending, true);
  assert.equal(follower.uncertain, true);
  assert.match(follower.text, /结果不确定|禁止自动重放/);
  assert.equal(executions, 1, "an expired write reservation must never rerun the handler");
  finish.resolve();
  await assert.rejects(leader, /所有权变化/);
});

test("an expired pending read can be safely re-executed despite a reused live PID", async (t) => {
  const root = mkProj();
  initProject(root, { name: "expired-read-lease" });
  const entered = deferred();
  const finish = deferred();
  t.after(finish.resolve);
  setPendingLeaseMsForTests(30);
  t.after(() => setPendingLeaseMsForTests());
  let leaderExecutions = 0;
  let followerExecutions = 0;

  const leader = runCoalescedRead(root, "leased-read", { query: "x" }, async () => {
    leaderExecutions += 1;
    entered.resolve();
    await finish.promise;
    return "obsolete-result";
  });
  await entered.promise;
  await delay(50);
  const follower = await runCoalescedRead(root, "leased-read", { query: "x" }, async () => {
    followerExecutions += 1;
    return "fresh-result";
  });

  assert.equal(follower.text, "fresh-result");
  assert.equal(leaderExecutions, 1);
  assert.equal(followerExecutions, 1);
  finish.resolve();
  await assert.rejects(leader, /所有权变化/);
});

test("a synchronous write handler failure is uncertain and cannot auto-replay", () => {
  const root = mkProj();
  initProject(root, { name: "sync-partial-write" });
  let sideEffects = 0;
  assert.throws(() => runIdempotentWriteSync(root, "partial-sync", { value: 1 }, () => {
    sideEffects += 1;
    throw new Error("failed after a possible side effect");
  }), /possible side effect/);

  const retry = runIdempotentWriteSync(root, "partial-sync", { value: 1 }, () => {
    sideEffects += 1;
    return "duplicate";
  });
  assert.equal(sideEffects, 1);
  assert.equal(retry.pending, true);
  assert.equal(retry.uncertain, true);
  assert.match(retry.text, /结果不确定|禁止自动重放/);
});

test("an asynchronous write handler failure is uncertain and cannot auto-replay", async () => {
  const root = mkProj();
  initProject(root, { name: "async-partial-write" });
  let sideEffects = 0;
  await assert.rejects(runIdempotentWrite(root, "partial-async", { value: 1 }, async () => {
    sideEffects += 1;
    throw new Error("failed after an async side effect");
  }), /async side effect/);

  const retry = await runIdempotentWrite(root, "partial-async", { value: 1 }, async () => {
    sideEffects += 1;
    return "duplicate";
  });
  assert.equal(sideEffects, 1);
  assert.equal(retry.pending, true);
  assert.equal(retry.uncertain, true);
  assert.match(retry.text, /结果不确定|禁止自动重放/);
});

test("different idempotency keys serialize metadata but keep business handlers parallel", async (t) => {
  const root = mkProj();
  initProject(root, { name: "parallel-business-handlers" });
  const bothEntered = deferred();
  const finish = deferred();
  t.after(finish.resolve);
  let active = 0;
  let peak = 0;

  const execute = async (): Promise<string> => {
    active += 1;
    peak = Math.max(peak, active);
    if (active === 2) bothEntered.resolve();
    await finish.promise;
    active -= 1;
    return "done";
  };
  const first = runIdempotentWrite(root, "parallel-write", { value: 1, idempotency_key: "PARALLEL:A" }, execute);
  const second = runIdempotentWrite(root, "parallel-write", { value: 2, idempotency_key: "PARALLEL:B" }, execute);
  await Promise.race([
    bothEntered.promise,
    delay(2_000).then(() => { throw new Error("different-key handlers were unexpectedly serialized"); }),
  ]);
  assert.equal(peak, 2);
  finish.resolve();
  assert.deepEqual((await Promise.all([first, second])).map((result) => result.text), ["done", "done"]);
});
