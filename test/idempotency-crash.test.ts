import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { initProject } from "../src/init.ts";
import { operationArgsHash, runIdempotentWrite, runIdempotentWriteSync, setWriteWaitMsForTests } from "../src/idempotency.ts";

const moduleUrl = pathToFileURL(path.resolve("src/idempotency.ts")).href;

async function waitUntil(predicate: () => boolean, timeoutMs: number, description: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`等待 ${description} 超时`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function waitForExit(child: ChildProcess, timeoutMs = 10_000): Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode, stderr: "" });
  }
  return new Promise((resolve, reject) => {
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`强杀后的子进程 ${child.pid ?? "unknown"} 未退出`));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stderr });
    });
  });
}

for (const stage of ["after-business", "after-revision", "before-complete"] as const) {
  test(`外部强杀故障注入 ${stage}：显式业务键不得自动重放`, { timeout: 30_000 }, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `pm-crash-${stage}-`));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    initProject(root, { name: stage });
    const marker = path.join(root, "business-marker.txt");
    const ready = path.join(root, "fault-ready");
    const key = `CRASH:${stage}`;
    const child = [
      `import fs from ${JSON.stringify("node:fs")};`,
      `import { runIdempotentWriteSync, setIdempotencyFaultHookForTests } from ${JSON.stringify(moduleUrl)};`,
      `const wait = new Int32Array(new SharedArrayBuffer(4));`,
      `setIdempotencyFaultHookForTests((value) => { if (value === ${JSON.stringify(stage)}) { fs.writeFileSync(${JSON.stringify(ready)}, "ready"); Atomics.wait(wait, 0, 0); } });`,
      `runIdempotentWriteSync(${JSON.stringify(root)}, "crash-write", { value: 1, idempotency_key: ${JSON.stringify(key)} }, () => { fs.appendFileSync(${JSON.stringify(marker)}, "applied\\n"); return "done"; });`,
    ].join("\n");
    const processUnderTest = spawn(process.execPath, ["--input-type=module", "-e", child], { stdio: ["ignore", "ignore", "pipe"] });
    await waitUntil(() => fs.existsSync(ready), 10_000, `${stage} 故障点`);
    assert.equal(processUnderTest.kill("SIGKILL"), true, "父进程必须成功发出外部强杀");
    const killed = await waitForExit(processUnderTest);
    assert.notEqual(killed.code, 0, killed.stderr);
    let replayExecuted = false;
    const retry = runIdempotentWriteSync(root, "crash-write", { value: 1, idempotency_key: key }, () => {
      replayExecuted = true;
      fs.appendFileSync(marker, "duplicate\n");
      return "duplicate";
    });
    assert.equal(replayExecuted, false, "不确定结果绝不能自动重放业务 handler");
    assert.equal(retry.pending, true);
    assert.equal(retry.uncertain, true);
    assert.match(retry.text, /结果不确定|禁止自动重放/);

    const recoveryStarted = Date.now();
    runIdempotentWriteSync(root, "crash-write", { value: 2, idempotency_key: `${key}:fresh` }, () => {
      fs.appendFileSync(marker, "fresh\n");
      return "fresh";
    });
    assert.ok(Date.now() - recoveryStarted < 3_000, "强杀遗留锁必须在正常 3s 超时内立即恢复");
    assert.deepEqual(fs.readFileSync(marker, "utf8").trim().split(/\r?\n/), ["applied", "fresh"]);
  });
}

test("真实路径、大小写别名和不同 PM_MCP_HOME 共用幂等域", (t) => {
  const realRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pm-alias-real-"));
  t.after(() => fs.rmSync(realRoot, { recursive: true, force: true }));
  initProject(realRoot, { name: "alias" });
  const aliasRoot = path.join(path.dirname(realRoot), path.basename(realRoot) + "-junction");
  try {
    fs.symlinkSync(realRoot, aliasRoot, process.platform === "win32" ? "junction" : "dir");
  } catch {
    // Some CI hosts disallow symlinks; realpath and PM_MCP_HOME isolation are still exercised below.
  }
  const usableAlias = fs.existsSync(aliasRoot) ? aliasRoot : realRoot;
  t.after(() => {
    if (fs.existsSync(aliasRoot)) fs.unlinkSync(aliasRoot);
  });
  let executions = 0;
  const previousHome = process.env.PM_MCP_HOME;
  try {
    process.env.PM_MCP_HOME = realRoot + "-home-a";
    runIdempotentWriteSync(realRoot, "alias-write", { value: 1, idempotency_key: "ALIAS:write" }, () => String(++executions));
    process.env.PM_MCP_HOME = realRoot + "-home-b";
    const replay = runIdempotentWriteSync(usableAlias, "alias-write", { value: 1, idempotency_key: "ALIAS:write" }, () => String(++executions));
    assert.equal(replay.replayed, true);
    assert.equal(executions, 1);
    if (process.platform === "win32") {
      const caseReplay = runIdempotentWriteSync(realRoot.toUpperCase(), "alias-write", { value: 1, idempotency_key: "ALIAS:write" }, () => String(++executions));
      assert.equal(caseReplay.replayed, true);
      assert.equal(executions, 1);
    }
  } finally {
    if (previousHome === undefined) delete process.env.PM_MCP_HOME;
    else process.env.PM_MCP_HOME = previousHome;
  }
});

test("真实路径、junction 与大小写入口并发争用同一幂等域", { timeout: 30_000 }, async (t) => {
  const realRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pm-alias-concurrent-"));
  const aliasRoot = `${realRoot}-junction`;
  t.after(() => {
    if (fs.existsSync(aliasRoot)) fs.unlinkSync(aliasRoot);
    fs.rmSync(realRoot, { recursive: true, force: true });
  });
  initProject(realRoot, { name: "alias-concurrent" });
  try {
    fs.symlinkSync(realRoot, aliasRoot, process.platform === "win32" ? "junction" : "dir");
  } catch {
    // Locked-down CI may not permit symlinks; the real path still participates.
  }
  const roots = [realRoot];
  if (fs.existsSync(aliasRoot)) roots.push(aliasRoot);
  if (process.platform === "win32") roots.push(realRoot.toUpperCase());

  const readyDir = path.join(realRoot, "ready");
  const go = path.join(realRoot, "go");
  const marker = path.join(realRoot, "alias-business-marker.txt");
  fs.mkdirSync(readyDir);
  const worker = [
    `import fs from ${JSON.stringify("node:fs")};`,
    `import path from ${JSON.stringify("node:path")};`,
    `import { runIdempotentWriteSync } from ${JSON.stringify(moduleUrl)};`,
    `const wait = new Int32Array(new SharedArrayBuffer(4));`,
    `fs.writeFileSync(path.join(${JSON.stringify(readyDir)}, process.env.ALIAS_WORKER), "ready");`,
    `while (!fs.existsSync(${JSON.stringify(go)})) Atomics.wait(wait, 0, 0, 5);`,
    `runIdempotentWriteSync(process.env.ALIAS_ROOT, "alias-concurrent-write", { value: 1, idempotency_key: "ALIAS:concurrent" }, () => { fs.appendFileSync(${JSON.stringify(marker)}, process.pid + "\\n"); Atomics.wait(wait, 0, 0, 100); return "done"; });`,
  ].join("\n");
  const children = roots.map((entry, index) => spawn(process.execPath, ["--input-type=module", "-e", worker], {
    env: { ...process.env, ALIAS_ROOT: entry, ALIAS_WORKER: String(index), PM_MCP_HOME: `${realRoot}-home-${index}` },
    stdio: ["ignore", "ignore", "pipe"],
  }));
  await waitUntil(() => fs.readdirSync(readyDir).length === roots.length, 10_000, "全部路径别名 worker barrier");
  fs.writeFileSync(go, "go");
  const exits = await Promise.all(children.map((child) => waitForExit(child)));
  assert.ok(exits.every((result) => result.code === 0), JSON.stringify(exits));
  assert.equal(fs.readFileSync(marker, "utf8").trim().split(/\r?\n/).length, 1, "三个别名入口只能执行一个业务 handler");
});

test("v0.1.3 全局 completed 记录升级后迁移并复用，业务 handler 不重跑", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pm-legacy-idempotency-"));
  const home = `${root}-home`;
  const previousHome = process.env.PM_MCP_HOME;
  process.env.PM_MCP_HOME = home;
  t.after(() => {
    if (previousHome === undefined) delete process.env.PM_MCP_HOME;
    else process.env.PM_MCP_HOME = previousHome;
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });
  initProject(root, { name: "legacy-idempotency" });
  const key = "LEGACY:completed";
  const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
  const legacyDir = path.join(home, ".pm-mcp", "idempotency", digest(path.resolve(root)));
  fs.mkdirSync(legacyDir, { recursive: true });
  const timestamp = new Date().toISOString();
  fs.writeFileSync(path.join(legacyDir, `${digest(key)}.json`), JSON.stringify({
    schema_version: 1,
    key,
    explicit: true,
    tool: "legacy-write",
    args_sha256: operationArgsHash({ value: 1 }),
    mode: "write",
    status: "completed",
    owner_pid: process.pid,
    owner_token: randomUUID(),
    created_at: timestamp,
    updated_at: timestamp,
    result: "legacy-result",
  }, null, 2));

  let executions = 0;
  const replay = runIdempotentWriteSync(root, "legacy-write", { value: 1, idempotency_key: key }, () => String(++executions));
  assert.equal(replay.replayed, true);
  assert.equal(replay.text, "legacy-result");
  assert.equal(executions, 0);
  assert.equal(fs.existsSync(path.join(root, ".pm", ".runtime", "idempotency", `${digest(key)}.json`)), true);
});

test("auto-key follower 在 claim 后遇到 leader 强杀必须返回 uncertain", { timeout: 20_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pm-auto-crash-"));
  const ready = path.join(root, "leader-ready");
  const marker = path.join(root, "auto-business-marker.txt");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  initProject(root, { name: "auto-crash" });
  const childCode = [
    `import fs from ${JSON.stringify("node:fs")};`,
    `import { runIdempotentWrite } from ${JSON.stringify(moduleUrl)};`,
    `await runIdempotentWrite(${JSON.stringify(root)}, "auto-crash-write", { value: 1 }, async () => { fs.appendFileSync(${JSON.stringify(marker)}, "applied\\n"); fs.writeFileSync(${JSON.stringify(ready)}, "ready"); await new Promise(() => setInterval(() => {}, 1000)); return "unreachable"; });`,
  ].join("\n");
  const leader = spawn(process.execPath, ["--input-type=module", "-e", childCode], { stdio: ["ignore", "ignore", "pipe"] });
  t.after(() => { if (leader.exitCode === null && leader.signalCode === null) leader.kill("SIGKILL"); });
  await waitUntil(() => fs.existsSync(ready), 10_000, "auto-key leader");
  setWriteWaitMsForTests(2_000);
  t.after(() => setWriteWaitMsForTests());
  let duplicate = false;
  const follower = runIdempotentWrite(root, "auto-crash-write", { value: 1 }, async () => {
    duplicate = true;
    return "duplicate";
  });
  setTimeout(() => leader.kill("SIGKILL"), 50).unref();
  const result = await follower;
  await waitForExit(leader);
  assert.equal(duplicate, false);
  assert.equal(result.pending, true);
  assert.equal(result.uncertain, true);
  assert.deepEqual(fs.readFileSync(marker, "utf8").trim().split(/\r?\n/), ["applied"]);
});
