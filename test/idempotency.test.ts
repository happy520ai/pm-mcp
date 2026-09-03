import test from "node:test";
import assert from "node:assert/strict";
import { initProject } from "../src/init.ts";
import {
  operationArgsHash,
  runCoalescedRead,
  runIdempotentWrite,
  runIdempotentWriteSync,
  splitIdempotencyArgs,
} from "../src/idempotency.ts";
import { mkProj } from "./helpers.ts";

test("参数摘要与对象键顺序无关，幂等键不会传入业务 handler", () => {
  assert.equal(operationArgsHash({ a: 1, b: [2] }), operationArgsHash({ b: [2], a: 1 }));
  const split = splitIdempotencyArgs({ title: "任务", idempotency_key: "T-1:add" });
  assert.deepEqual(split, { businessArgs: { title: "任务" }, explicitKey: "T-1:add" });
});

test("显式业务键永久复用首次写结果，同键不同参数拒绝", () => {
  const root = mkProj();
  initProject(root, { name: "x" });
  let executions = 0;
  const execute = (args: { value: number; idempotency_key?: string }): string => `result-${args.value}-${++executions}`;
  const args = { value: 1, idempotency_key: "ORDER-1:create" };
  const first = runIdempotentWriteSync(root, "create", args, execute);
  const second = runIdempotentWriteSync(root, "create", args, execute);
  assert.equal(first.text, "result-1-1");
  assert.equal(second.text, first.text);
  assert.equal(second.replayed, true);
  assert.equal(executions, 1);
  assert.throws(
    () => runIdempotentWriteSync(root, "create", { value: 2, idempotency_key: "ORDER-1:create" }, execute),
    /冲突/,
  );
});

test("未传键的完全相同瞬时写调用自动去重", () => {
  const root = mkProj();
  initProject(root, { name: "x" });
  let executions = 0;
  const first = runIdempotentWriteSync(root, "auto-write", { value: 1 }, () => String(++executions));
  const second = runIdempotentWriteSync(root, "auto-write", { value: 1 }, () => String(++executions));
  assert.equal(first.text, "1");
  assert.equal(second.text, "1");
  assert.equal(second.replayed, true);
  assert.equal(executions, 1);
});

test("并行异步写首个执行，其余调用得到进行中占位", async () => {
  const root = mkProj();
  initProject(root, { name: "x" });
  let executions = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const firstPromise = runIdempotentWrite(root, "async-write", { value: 1, idempotency_key: "ASYNC-1" }, async () => {
    executions += 1;
    await gate;
    return "done";
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const second = await runIdempotentWrite(root, "async-write", { value: 1, idempotency_key: "ASYNC-1" }, async () => {
    executions += 1;
    return "duplicate";
  });
  assert.equal(second.pending, true);
  assert.equal(executions, 1);
  release();
  assert.equal((await firstPromise).text, "done");
});

test("并行读取等待首个执行并复用同一结果", async () => {
  const root = mkProj();
  initProject(root, { name: "x" });
  let executions = 0;
  const read = (): Promise<string> => new Promise((resolve) => {
    executions += 1;
    setTimeout(() => resolve("shared-result"), 80);
  });
  const [first, second] = await Promise.all([
    runCoalescedRead(root, "read", { query: "x" }, read),
    runCoalescedRead(root, "read", { query: "x" }, read),
  ]);
  assert.equal(first.text, "shared-result");
  assert.equal(second.text, "shared-result");
  assert.equal(executions, 1);
  assert.ok(first.replayed !== second.replayed);
});

test("未初始化项目的只读失败不创建 .pm 运行态", async () => {
  const root = mkProj();
  await assert.rejects(() => runCoalescedRead(root, "read", {}, async () => { throw new Error("not initialized"); }), /not initialized/);
  assert.equal(await import("node:fs").then((fs) => fs.existsSync(`${root}/.pm`)), false);
});
