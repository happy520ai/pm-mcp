import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveQoderWorkspace, usableDir, workspaceFromRunLog, qoderLaunchEnv, qoderLaunchArgs } from "../src/qoder-launch.ts";
import { CLIENT_ADAPTER_ENV, QODER_ADAPTER, ROOT_HINT_ENV, ROOT_HINT_SOURCE_ENV } from "../src/caller-workspace.ts";
import { parseDoctorArgs, runDoctor } from "../src/doctor.ts";
import { initTestProject } from "./helpers.ts";

const NOW = Date.parse("2026-09-20T11:00:00.000Z");

/** Qoder 所有会话共用主进程 pid，日志目录名的 -p<pid> 区分不了会话；只有 mtime 能表达「谁最近在写」 */
function fakeConfigDir(t: { after: (fn: () => void) => void }, runs: Array<{ pid?: number; initialCwd: string; ageMs?: number }>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pm-qoder-launch-"));
  for (const [index, run] of runs.entries()) {
    const stamp = `2026-09-19T21-00-0${index}-000+08-00-abc123`;
    const runDir = path.join(dir, "logs", "runs", `${stamp}-p${run.pid ?? 30056}`);
    fs.mkdirSync(runDir, { recursive: true });
    const file = path.join(runDir, "qodercli.log");
    fs.writeFileSync(
      file,
      `INFO debug.message [qoder-worker-runtime] installed worker cwd shim initial_cwd=${run.initialCwd} restore_cwd=D:\\Qoder CN\n`,
      "utf8",
    );
    const mtime = new Date(NOW - (run.ageMs ?? index * 60_000));
    fs.utimesSync(file, mtime, mtime);
  }
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("usableDir rejects unexpanded placeholders and non-directories", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pm-qoder-usabledir-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(usableDir(undefined), null);
  assert.equal(usableDir("   "), null);
  assert.equal(usableDir("${QODER_WORKER_CWD}"), null);
  assert.equal(usableDir(path.join(dir, "missing")), null);
  assert.equal(usableDir(` ${dir} `), path.resolve(dir));
  assert.equal(usableDir(path.join(dir, "a file")), null);
  fs.writeFileSync(path.join(dir, "a file"), "x", "utf8");
  assert.equal(usableDir(path.join(dir, "a file")), null);
});

test("workspaceFromRunLog 取最近在写的会话，保留路径里的空格，并且不再假装 ppid 能区分会话", (t) => {
  const spaced = fs.mkdtempSync(path.join(os.tmpdir(), "pm qoder spaced "));
  const other = fs.mkdtempSync(path.join(os.tmpdir(), "pm-qoder-other-"));
  // 两份日志的 -p<pid> 完全相同（Qoder 真实情况就是共用主进程 pid），只能靠 mtime 区分
  const configDir = fakeConfigDir(t, [
    { pid: 30056, initialCwd: other, ageMs: 120_000 },
    { pid: 30056, initialCwd: spaced, ageMs: 1_000 },
  ]);
  t.after(() => { fs.rmSync(spaced, { recursive: true, force: true }); fs.rmSync(other, { recursive: true, force: true }); });
  assert.equal(workspaceFromRunLog({ env: { QODER_CONFIG_DIR: configDir } }), path.resolve(spaced));

  // 最近那份日志的工作区已被删掉时，退回下一份还在的，而不是直接放弃
  const gone = fs.mkdtempSync(path.join(os.tmpdir(), "pm-qoder-gone-"));
  const alive = fs.mkdtempSync(path.join(os.tmpdir(), "pm-qoder-alive-"));
  t.after(() => { fs.rmSync(alive, { recursive: true, force: true }); });
  const partlyStale = fakeConfigDir(t, [
    { initialCwd: alive, ageMs: 120_000 },
    { initialCwd: path.join(gone, "removed"), ageMs: 1_000 },
  ]);
  fs.rmSync(gone, { recursive: true, force: true });
  assert.equal(workspaceFromRunLog({ env: { QODER_CONFIG_DIR: partlyStale } }), path.resolve(alive));

  // 全部日志的工作区都不存在时如实返回 null
  const stale = fs.mkdtempSync(path.join(os.tmpdir(), "pm-qoder-stale-"));
  const staleDir = fakeConfigDir(t, [{ initialCwd: path.join(stale, "removed") }]);
  fs.rmSync(stale, { recursive: true, force: true });
  assert.equal(workspaceFromRunLog({ env: { QODER_CONFIG_DIR: staleDir } }), null);

  // 同名目录缺日志文件、或日志路径根本不是文件，都不能带崩解析
  const broken = fs.mkdtempSync(path.join(os.tmpdir(), "pm-qoder-broken-"));
  t.after(() => fs.rmSync(broken, { recursive: true, force: true }));
  fs.mkdirSync(path.join(broken, "logs", "runs", "2026-09-19T21-00-00-000+08-00-x1-p30056"), { recursive: true });
  fs.mkdirSync(path.join(broken, "logs", "runs", "2026-09-19T21-00-01-000+08-00-x2-p30056", "qodercli.log"), { recursive: true });
  assert.equal(workspaceFromRunLog({ env: { QODER_CONFIG_DIR: broken } }), null);
});

test("resolveQoderWorkspace prefers the inherited hint and falls back to the run log", (t) => {
  const hint = fs.mkdtempSync(path.join(os.tmpdir(), "pm-qoder-hint-"));
  const logged = fs.mkdtempSync(path.join(os.tmpdir(), "pm-qoder-logged-"));
  const configDir = fakeConfigDir(t, [{ initialCwd: logged }]);
  t.after(() => { fs.rmSync(hint, { recursive: true, force: true }); fs.rmSync(logged, { recursive: true, force: true }); });
  assert.deepEqual(
    resolveQoderWorkspace({ QODER_WORKER_CWD: hint, QODER_CONFIG_DIR: configDir }),
    { root: path.resolve(hint), source: "QODER_WORKER_CWD" },
  );
  assert.deepEqual(
    resolveQoderWorkspace({ QODER_WORKER_CWD: "${QODER_WORKER_CWD}", QODER_CONFIG_DIR: configDir }),
    { root: path.resolve(logged), source: "qodercli run log" },
  );
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "pm-qoder-empty-"));
  t.after(() => fs.rmSync(empty, { recursive: true, force: true }));
  assert.equal(resolveQoderWorkspace({ QODER_CONFIG_DIR: empty }), null);
});

test("适配器把来历交给服务器，而不是伪造 --root；调用方自己钉了 --root 就完全尊重", (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "pm-qoder-env-"));
  const configDir = fakeConfigDir(t, [{ initialCwd: workspace }]);
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const base = { QODER_WORKER_CWD: "", QODER_CONFIG_DIR: configDir } as NodeJS.ProcessEnv;

  const env = qoderLaunchEnv([], base);
  assert.equal(env[CLIENT_ADAPTER_ENV], QODER_ADAPTER);
  assert.equal(env[ROOT_HINT_ENV], path.resolve(workspace));
  assert.equal(env[ROOT_HINT_SOURCE_ENV], "qodercli run log");
  assert.deepEqual(qoderLaunchArgs([]), []);

  // 显式钉根＝明确要求固定项目，不能再标记适配器让服务器按请求改根
  const pinned = qoderLaunchEnv(["--root", workspace], base);
  assert.equal(pinned[CLIENT_ADAPTER_ENV], undefined);
  assert.equal(pinned[ROOT_HINT_ENV], undefined);
  assert.deepEqual(qoderLaunchArgs(["--root", workspace]), ["--root", workspace]);

  // 一条线索都没有时仍然标记适配器：按请求认领才是主路径，启动期提示只是可选
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), "pm-qoder-bare-"));
  t.after(() => fs.rmSync(bare, { recursive: true, force: true }));
  const hopeless = qoderLaunchEnv([], { QODER_WORKER_CWD: "", QODER_CONFIG_DIR: bare } as NodeJS.ProcessEnv);
  assert.equal(hopeless[CLIENT_ADAPTER_ENV], QODER_ADAPTER);
  assert.equal(hopeless[ROOT_HINT_ENV], undefined);
});

test("launching through the adapter hands over the real basis instead of faking --root", async (t) => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "pm-qoder-launch-proj-"));
  initTestProject(project);
  const configDir = fakeConfigDir(t, [{ pid: process.pid, initialCwd: project }]);
  const pmHome = `${project}-home`;
  const launcher = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "qoder-launch.ts");
  const child = spawn(process.execPath, [launcher], {
    cwd: path.parse(process.execPath).root,
    env: { ...process.env, QODER_WORKER_CWD: "", QODER_CONFIG_DIR: configDir, PM_MCP_HOME: pmHome },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const killTree = () => {
    if (process.platform === "win32" && child.pid) spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    else if (!child.killed) child.kill("SIGKILL");
  };
  const cleanup = async () => {
    killTree();
    await exited;
    for (const dir of [project, pmHome]) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  };
  t.after(cleanup);

  const banner = await new Promise<string>((resolve, reject) => {
    let err = "";
    const timer = setTimeout(() => reject(new Error(`未看到启动横幅: ${err}`)), 30_000);
    child.stderr.on("data", (chunk: Buffer) => {
      err += chunk.toString();
      if (err.includes("project root:")) { clearTimeout(timer); resolve(err); }
    });
    child.on("exit", () => clearTimeout(timer));
  });
  const expected = path.resolve(project).replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
  assert.match(banner, /\[pm-mcp qoder-launch\] 启动期默认根: .* \(source: qodercli run log\)/);
  assert.match(banner, new RegExp(`\\[pm-mcp\\] ready\\. default project root: ${expected} \\(source: qodercli run log\\(spawn-time\\)\\)`));
  assert.doesNotMatch(banner, /source: --root/);
});

test("the adapter refuses to guess a root when no workspace signal survives", async (t) => {
  const emptyConfig = fs.mkdtempSync(path.join(os.tmpdir(), "pm-qoder-nolog-"));
  const pmHome = `${emptyConfig}-home`;
  const launcher = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "qoder-launch.ts");
  const child = spawn(process.execPath, [launcher], {
    cwd: path.parse(process.execPath).root,
    env: { ...process.env, QODER_WORKER_CWD: "", QODER_CONFIG_DIR: emptyConfig, PM_MCP_HOME: pmHome },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  t.after(async () => {
    if (process.platform === "win32" && child.pid) spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    else if (!child.killed) child.kill("SIGKILL");
    await exited;
    for (const dir of [emptyConfig, pmHome]) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  });

  const stderr = await new Promise<string>((resolve, reject) => {
    let err = "";
    const timer = setTimeout(() => reject(new Error(`未看到降级提示: ${err}`)), 30_000);
    child.stderr.on("data", (chunk: Buffer) => {
      err += chunk.toString();
      if (err.includes("未取到")) { clearTimeout(timer); resolve(err); }
    });
    child.on("exit", () => clearTimeout(timer));
  });
  assert.match(stderr, /\[pm-mcp qoder-launch\] 启动期未取到 Qoder 工作区/);
});

test("doctor --client qoder 能对适配器条目做真实握手并确认项目根", async (t) => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "pm-qoder-doctor-"));
  initTestProject(project);
  const settings = path.join(project, "settings.json");
  fs.writeFileSync(settings, JSON.stringify({
    mcpServers: { "pm-mcp": { command: process.execPath, args: [path.resolve("dist", "qoder-launch.js")] } },
  }), "utf8");
  t.after(() => fs.rmSync(project, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }));

  assert.equal(parseDoctorArgs(["--client", "qoder"]).client, "qoder");
  assert.throws(() => parseDoctorArgs(["--client", "cursor"]), /codex\|workbuddy\|qoder/);

  const report = await runDoctor({ root: project, client: "qoder", config: settings });
  assert.deepEqual(report.issues, [], JSON.stringify(report));
  assert.equal(report.configuration, "qoder_local_probe");
  assert.equal((report.probe as { runtime?: { root?: string } } | undefined)?.runtime?.root, path.resolve(project));
});
