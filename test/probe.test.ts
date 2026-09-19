import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PROBE_USAGE, parseProbeArgs, runProbe } from "../src/probe.ts";

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "raw-mcp-server.mjs");
/** 模式经命令行参数传递：SDK transport 只继承白名单环境变量，自定义 env 到不了夹具进程。 */
const spawnFixture = (mode: string, overrides: Record<string, unknown> = {}) => ({
  command: process.execPath,
  args: [fixture, mode],
  timeoutMs: 10_000,
  ...overrides,
});

test("probe 直连标准 MCP 服务器拿到原始 tools/list 清单", async () => {
  const report = await runProbe(spawnFixture("ok"));
  assert.equal(report.ok, true);
  assert.equal(report.toolCount, 2);
  assert.deepEqual(report.tools.map((tool) => tool.name), ["alpha_tool", "beta_tool"]);
  assert.equal(report.serverInfo?.name, "raw-fixture");
  assert.equal(report.serverInfo?.version, "1.0.0");
  assert.equal(report.issues.length, 0);
});

test("probe 按 nextCursor 翻页取全工具", async () => {
  const report = await runProbe(spawnFixture("paged"));
  assert.equal(report.ok, true);
  assert.deepEqual(report.tools.map((tool) => tool.name), ["alpha_tool", "beta_tool"]);
});

test("probe --expect 比对：缺失与多余都进 issues 且 ok=false", async () => {
  const report = await runProbe(spawnFixture("ok", { expect: ["alpha_tool", "ghost_tool"] }));
  assert.equal(report.ok, false);
  assert.deepEqual(report.expect?.missing, ["ghost_tool"]);
  assert.deepEqual(report.expect?.extra, ["beta_tool"]);
  assert.equal(report.toolCount, 2);
});

test("probe --expect 全部一致时 ok=true", async () => {
  const report = await runProbe(spawnFixture("ok", { expect: ["beta_tool", "alpha_tool"] }));
  assert.equal(report.ok, true);
  assert.deepEqual(report.expect?.missing, []);
  assert.deepEqual(report.expect?.extra, []);
});

test("probe 对不回应 tools/list 的服务器按超时失败", async () => {
  const report = await runProbe(spawnFixture("hang", { timeoutMs: 1_500 }));
  assert.equal(report.ok, false);
  assert.equal(report.toolCount, 0);
  assert.ok(report.issues[0].includes("探测失败"));
});

test("parseProbeArgs 解析选项与 -- 之后的启动命令", () => {
  const options = parseProbeArgs(["--timeout", "5000", "--expect", "a,b,c", "--", "node", "server.js", "--root", "x"]);
  assert.equal(options.command, "node");
  assert.deepEqual(options.args, ["server.js", "--root", "x"]);
  assert.deepEqual(options.expect, ["a", "b", "c"]);
  assert.equal(options.timeoutMs, 5_000);
});

test("parseProbeArgs 接受上一轮 probe 报告作为 expect-file", () => {
  const file = path.join(os.tmpdir(), `pm-mcp-probe-expect-${process.pid}.json`);
  fs.writeFileSync(file, JSON.stringify({ ok: true, tools: [{ name: "t1" }, { name: "t2" }] }));
  try {
    const options = parseProbeArgs(["--expect-file", file, "--", "node", "server.js"]);
    assert.deepEqual(options.expect, ["t1", "t2"]);
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test("parseProbeArgs 拒绝缺 -- 分隔符、未知选项与重复 expect 来源", () => {
  assert.throws(() => parseProbeArgs(["node", "server.js"]), /--/);
  assert.throws(() => parseProbeArgs(["--wat", "--", "node"]), /参数无效/);
  assert.throws(() => parseProbeArgs(["--expect", "a", "--expect-file", "x.json", "--", "node"]), /只能用一个/);
  assert.match(PROBE_USAGE, /--expect/);
});
