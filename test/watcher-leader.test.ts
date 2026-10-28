import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { initProject } from "../src/init.ts";
import { closeIndex, ensureFresh, freshness, getIndex, startWatcher } from "../src/index-store.ts";
import { isTransientActivationError } from "../src/watcher-coordinator.ts";

const agentCount = 20;

function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const check = (): void => {
      if (condition()) return resolve();
      if (Date.now() >= deadline) return reject(new Error(`condition not met within ${timeoutMs}ms`));
      setTimeout(check, 50);
    };
    check();
  });
}

/** 当前持有 fs.watch 的进程：拿到 watch 时写旗标，watcher 关闭时删除 */
function ownerFlags(flagDir: string): number[] {
  if (!fs.existsSync(flagDir)) return [];
  return fs.readdirSync(flagDir)
    .filter((name) => /watcher-\d+\.flag/.test(name))
    .map((name) => Number(name.replace(/watcher-/, "").replace(/.flag/, "")));
}

function unexpectedChildStderr(chunks: string[]): string {
  return chunks.join("").replace(
    /\(node:\d+\) ExperimentalWarning: SQLite is an experimental feature and might change at any time\r?\n(?:\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)\r?\n)?/g,
    "",
  ).trim();
}

function childProgram(moduleUrl: string): string {
  return `
    import fs from "node:fs";
    const [root, flagDir] = process.argv.slice(1);
    const flagFile = flagDir + "/watcher-" + process.pid + ".flag";
    const originalWatch = fs.watch;
    // 按进程计数：close 事件是异步的，同一进程「激活→降级→再激活」时迟到的回调
    // 会把新旗标删掉，导致持有者被少计。计数归零才删除旗标。
    let openWatchers = 0;
    fs.watch = function (...args) {
      const watcher = originalWatch.apply(this, args);
      openWatchers += 1;
      fs.writeFileSync(flagFile, String(openWatchers), "utf8");
      watcher.on("close", () => {
        openWatchers -= 1;
        try {
          if (openWatchers > 0) fs.writeFileSync(flagFile, String(openWatchers), "utf8");
          else fs.rmSync(flagFile, { force: true });
        } catch {}
      });
      return watcher;
    };
    const { startWatcher } = await import(${JSON.stringify(moduleUrl)});
    const handle = startWatcher(root);
    if (!handle) throw new Error("watcher coordinator unavailable");
    process.stdout.write("READY " + process.pid + "\\n");
    setInterval(() => {}, 1_000);
  `;
}

async function stopChildren(children: ChildProcess[]): Promise<void> {
  await Promise.all(children.map((child) => new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once("exit", () => resolve());
    child.kill();
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }, 2_000).unref();
  })));
}

test("Node 22 SQLite 实验性提示不冒充 watcher 业务错误", () => {
  const warning = "(node:123) ExperimentalWarning: SQLite is an experimental feature and might change at any time\n" +
    "(Use `node --trace-warnings ...` to show where the warning was created)\n";
  assert.equal(unexpectedChildStderr([warning]), "");
  assert.equal(unexpectedChildStderr([warning, "real watcher failure\n"]), "real watcher failure");
});

test("20 个 MCP 进程共享一个 watcher leader，leader 强杀后有界接管", { timeout: 30_000 }, async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "pm-watcher-leader-"));
  const root = path.join(base, "project");
  const flagDir = path.join(base, "watcher-flags");
  fs.mkdirSync(flagDir, { recursive: true });
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "a.ts"), "export const a = 1;\n", "utf8");
  process.env.PM_MCP_HOME = path.join(base, "home");
  initProject(root, { name: "watcher-leader" });

  const source = path.resolve("src/index-store.ts");
  const program = childProgram(pathToFileURL(source).href);
  const children: ChildProcess[] = [];
  const ready = new Set<number>();
  const failures: string[] = [];

  try {
    for (let index = 0; index < agentCount; index += 1) {
      const child = spawn(process.execPath, ["--input-type=module", "--eval", program, root, flagDir], {
        cwd: path.resolve("."),
        stdio: ["ignore", "pipe", "pipe"],
      });
      children.push(child);
      child.stdout!.setEncoding("utf8");
      child.stderr!.setEncoding("utf8");
      child.stdout!.on("data", (chunk: string) => {
        for (const match of chunk.matchAll(/READY (\d+)/g)) ready.add(Number(match[1]));
      });
      child.stderr!.on("data", (chunk: string) => failures.push(chunk));
    }

    await waitFor(() => ready.size === agentCount, 15_000);
    await waitFor(() => ownerFlags(flagDir).length === 1, 15_000);
    const late = spawn(process.execPath, ["--input-type=module", "--eval", program, root, flagDir], {
      cwd: path.resolve("."),
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(late);
    late.stdout!.setEncoding("utf8");
    late.stderr!.setEncoding("utf8");
    late.stdout!.on("data", (chunk: string) => {
      for (const match of chunk.matchAll(/READY (\d+)/g)) ready.add(Number(match[1]));
    });
    late.stderr!.on("data", (chunk: string) => failures.push(chunk));
    await waitFor(() => ready.size === agentCount + 1, 5_000);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const initial = [...new Set(ownerFlags(flagDir))];
    assert.equal(initial.length, 1, `迟到 standby 加入后仍只能有一个 fs.watch owner，实际 ${initial.length}: ${initial.join(",")}`);

    const leader = children.find((child) => child.pid === initial[0]);
    assert.ok(leader, `找不到 leader 子进程 ${initial[0]}`);
    leader.kill("SIGKILL");
    await waitFor(() => new Set(ownerFlags(flagDir)).size >= 2, 10_000);
    await new Promise((resolve) => setTimeout(resolve, 1_250));
    const afterFailover = [...new Set(ownerFlags(flagDir))];
    assert.equal(afterFailover.length, 2, `强杀后只能有一个新 owner 接管，实际 owner ${afterFailover.length} 个`);
    assert.notEqual(afterFailover[1], afterFailover[0]);
    const unexpectedStderr = unexpectedChildStderr(failures);
    assert.equal(unexpectedStderr, "", unexpectedStderr);
  } finally {
    await stopChildren(children);
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("watcher 的 SQLITE_BUSY 不得吞成成功，必须留下 dirty 并由精确走查恢复", { timeout: 15_000 }, async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "pm-watcher-busy-"));
  const root = path.join(base, "project");
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "a.ts"), "export const a = 1;\n", "utf8");
  process.env.PM_MCP_HOME = path.join(base, "home");
  initProject(root, { name: "watcher-busy" });
  const watcher = startWatcher(root);
  assert.ok(watcher);
  assert.equal(ensureFresh(root).used, "walk");

  const index = getIndex(root);
  index.exec("PRAGMA busy_timeout=25");
  const blocker = new DatabaseSync(path.join(root, ".pm", "index.db"));
  blocker.exec("PRAGMA busy_timeout=1000");
  blocker.exec("BEGIN IMMEDIATE");
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]): void => { errors.push(args.map(String).join(" ")); };

  try {
    fs.writeFileSync(path.join(root, "src", "a.ts"), "export const a = 2;\nexport const b = 3;\n", "utf8");
    const dirty = path.join(root, ".pm", ".runtime", "watcher-dirty");
    await waitFor(() => fs.existsSync(dirty), 3_000);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(freshness(root).fresh, false, "busy 事件不能留下看似 fresh 的索引");
    assert.ok(errors.some((line) => /watcher .*failed.*database is (?:locked|busy)/i.test(line)), errors.join("\n"));

    blocker.exec("ROLLBACK");
    blocker.close();
    const recovered = ensureFresh(root);
    assert.equal(recovered.used, "walk", "dirty 状态必须用精确走查恢复，不能冒充 watcher 命中");
    assert.equal(freshness(root).fresh, true);
    assert.equal(fs.existsSync(dirty), false);
  } finally {
    console.error = originalError;
    try { if (blocker.isTransaction) blocker.exec("ROLLBACK"); } catch { /* already closed */ }
    try { blocker.close(); } catch { /* already closed */ }
    watcher?.stop();
    closeIndex(root);
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("瞬态激活错误被识别为可重试，真故障不算", () => {
  const transient = [
    "disk I/O error",
    "SQLITE_IOERR: disk I/O error",
    "database is locked",
    "database is busy",
    "SQLITE_BUSY",
    "EBUSY: resource busy or locked",
  ];
  for (const message of transient) {
    assert.equal(isTransientActivationError(new Error(message)), true, message);
  }
  const real = [
    "EACCES: permission denied",
    "ENOENT: no such file or directory",
    "watcher coordinator unavailable",
  ];
  for (const message of real) {
    assert.equal(isTransientActivationError(new Error(message)), false, message);
  }
  assert.equal(isTransientActivationError("plain string error"), false);
});
