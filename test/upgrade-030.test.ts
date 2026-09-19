import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTaskTools } from "../src/task-tools.ts";
import { registerProjectTools } from "../src/project-tools.ts";
import { loadTasks, saveTasks, loadProject } from "../src/store.ts";
import { closeIndex } from "../src/index-store.ts";
import { runQualityPlan } from "../src/language-adapters.ts";
import { fingerprintProject } from "../src/project-fingerprint.ts";
import { saveQualityRun } from "../src/quality-store.ts";
import { TOOL_CATALOG_SIZE } from "../src/version.ts";
import { appendCodexProjectConfig, codexProjectServerKey, PACKAGE_SPEC } from "../src/setup.ts";
import { initTestProject, mkProj, writeRel } from "./helpers.ts";
import { qualityOutputSummary } from "../src/quality-evidence.ts";
import { runDoctor, parseDoctorArgs } from "../src/doctor.ts";
import { acceptanceTarget } from "../scripts/acceptance-target.mts";

function fixture(t: { after: (fn: () => void) => void }) {
  const root = mkProj({ "src/app.mjs": "export const value = 1;\n" });
  initTestProject(root);
  t.after(() => { closeIndex(root); fs.rmSync(root, { recursive: true, force: true }); });
  const handlers = new Map<string, (args: any) => any>();
  const server = { registerTool: (name: string, _schema: unknown, handler: any) => handlers.set(name, handler) } as unknown as McpServer;
  registerTaskTools(server, root); registerProjectTools(server, root);
  let sequence = 0;
  const call = async (name: string, args: Record<string, unknown> = {}) => handlers.get(name)!({ ...args, ...(name === "list_tasks" || name === "get_status" ? {} : { idempotency_key: `upgrade030:${++sequence}` }) });
  const ok = async (name: string, args: Record<string, unknown> = {}) => { const result = await call(name, args); assert.ok(!result.isError, JSON.stringify(result)); return result; };
  const seed = async (n: number) => {
    await ok("add_task", { title: "相同属性的任务", files: ["src/app.mjs"] });
    const template = loadTasks(root).tasks[0];
    saveTasks(root, { seq: n, tasks: Array.from({ length: n }, (_, i) => ({ ...template, id: `T-${String(i + 1).padStart(3, "0")}` })) });
  };
  return { root, call, ok, seed };
}

async function emptyExecution(root: string): Promise<any> {
  const before = fingerprintProject(root);
  const result = await runQualityPlan([{ command: process.execPath, args: ["-e", "process.exit(0)"], cwd: root, kind: "test", requiredExecutable: process.execPath, timeoutMs: 5000, maxOutputBytes: 65536 }], { execute: true });
  const file = saveQualityRun(root, result, { source_before: before, source_after: fingerprintProject(root) });
  return JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
}

test("1000条同属性任务能按游标完整取回，文字和结构化分页元数据一致", async (t) => {
  const { ok, seed } = fixture(t); await seed(1000);
  const ids: string[] = []; let cursor: string | undefined;
  do {
    const response = await ok("list_tasks", { page_size: 37, ...(cursor ? { cursor } : {}) });
    const page = response.structuredContent;
    assert.ok(page, "应有可解析分页结果");
    assert.equal(page.total, 1000); assert.equal(page.returned, page.items.length);
    assert.ok(page.returned <= 37); assert.equal(page.offset, ids.length);
    const text = response.content[0].text;
    for (const item of page.items) { assert.ok(text.includes(item.id)); ids.push(item.id); }
    assert.equal(page.has_more, page.next_cursor !== null);
    cursor = page.next_cursor ?? undefined;
  } while (cursor);
  assert.equal(ids.length, 1000); assert.equal(new Set(ids).size, 1000);
});

test("分页游标绑定数据、过滤与项目根，不能静默跨快照翻页", async (t) => {
  const { root, ok, call, seed } = fixture(t); await seed(50);
  const first = (await ok("list_tasks", { page_size: 10 })).structuredContent;
  assert.ok(first?.next_cursor);
  assert.equal((await call("list_tasks", { cursor: first.next_cursor, include_done: true })).isError, true);
  const other = fixture(t); await other.seed(50);
  saveTasks(other.root, loadTasks(root)); // 账本内容完全相同，仍不得跨项目复用游标
  assert.equal((await other.call("list_tasks", { cursor: first.next_cursor })).isError, true);
  const data = loadTasks(root); data.tasks[0].title = "发生变化"; saveTasks(root, data);
  const stale = await call("list_tasks", { cursor: first.next_cursor });
  assert.equal(stale.isError, true); assert.match(stale.content[0].text, /变化|失效/);
  assert.equal((await call("list_tasks", { cursor: "not-a-valid-cursor" })).isError, true);
});

test("空成功命令只提供执行证据，默认不能把feature标为完成", async (t) => {
  const { root, ok, call } = fixture(t);
  await ok("add_task", { title: "需要观察到测试", files: ["src/app.mjs"] });
  const report = await emptyExecution(root);
  const result = await call("update_task", { id: "T-001", status: "done", result_note: "空命令不证明测试" });
  assert.equal(result.isError, true);
  assert.equal(loadTasks(root).tasks[0].status, "backlog");
  assert.equal(report.results[0].output_summary.evidence_level, "execution_only");
  assert.equal(report.results[0].output_summary.tests, null);
});

test("兼容未知计数必须有明确项目策略和理由，完成笔记仍说明证据等级", async (t) => {
  const { root, ok } = fixture(t);
  await ok("add_task", { title: "兼容遗留运行器", files: ["src/app.mjs"] });
  await ok("update_project", { completion_evidence: { minimum: "execution_only", reason: "遗留运行器暂时只提供命令退出状态，已明确接受此证据边界。" } });
  await emptyExecution(root);
  await ok("update_task", { id: "T-001", status: "done", result_note: "按明确的兼容策略完成" });
  assert.match(loadTasks(root).tasks[0].verification, /execution_only/);
  assert.ok((loadProject(root) as any).completion_evidence.reason);
});

test("状态输出提供实际运行包版本与项目根，而不是从项目phase推测", async (t) => {
  const { root, ok } = fixture(t);
  await ok("update_project", { phase: "历史版本描述，不是当前进程版本" });
  const response = await ok("get_status");
  const expected = JSON.parse(fs.readFileSync("package.json", "utf8")).version;
  assert.equal(response.structuredContent?.runtime?.version, expected);
  assert.equal(fs.realpathSync(response.structuredContent.runtime.root), fs.realpathSync(root));
  assert.match(response.content[0].text, /运行版本/);
});

test("Codex已绑定项目可安全升级命令参数，保留其他配置与工具预算", (t) => {
  const { root } = fixture(t); const file = path.join(root, "client", "config.toml");
  const name = codexProjectServerKey(root);
  const prefix = '# user configuration\nmodel = "preserve-native-model"\n';
  const suffix = `\n[mcp_servers.${name}.tools.search_code]\noutput_token_limit = 1500\n\n[mcp_servers.other]\ncommand = "preserve-other"\n`;
  const original = `${prefix}\n[mcp_servers.${name}]\ncommand = "npx"\nargs = ["-y", "@luckychen1993/pm-mcp@0.1.5", "--root", ${JSON.stringify(root.replace(/\\/g, "/"))}]\nenabled = true\n${suffix}`;
  writeRel(root, "client/config.toml", original);
  appendCodexProjectConfig(file, root, true, true, () => {});
  assert.equal(fs.readFileSync(file, "utf8"), original);
  appendCodexProjectConfig(file, root, true, false, () => {});
  const updated = fs.readFileSync(file, "utf8");
  assert.ok(updated.startsWith(prefix)); assert.ok(updated.endsWith(suffix));
  assert.ok(updated.includes(PACKAGE_SPEC)); assert.ok(updated.includes("enabled = true"));
  assert.equal(fs.readdirSync(path.dirname(file)).filter(name => name.startsWith("config.toml.backup-")).length, 1);
});

test("常用运行器摘要标明来源，未知或矛盾计数不能提升证据等级", () => {
  for (const [source, output] of [
    ["jest_summary", "Tests: 2 passed, 2 total\n"],
    ["vitest_summary", " Tests 2 passed (2)\n"],
    ["pytest_summary", "================ 2 passed, 1 warning in 0.03s ================\n"],
  ]) {
    const summary = qualityOutputSummary("test", output, "");
    assert.equal(summary.counter_source, source); assert.equal(summary.tests, 2);
    assert.equal(summary.evidence_level, "tests_observed");
  }
  const inconsistent = qualityOutputSummary("test", "Tests: 3 passed, 2 total\n", "");
  assert.equal(inconsistent.evidence_level, "execution_only");
  assert.equal(qualityOutputSummary("test", "unknown output", "").evidence_level, "execution_only");
  assert.equal(qualityOutputSummary("test", "Tests: 2 passed, 2 total\n", "", true).evidence_level, "execution_only");
});

test("兼容策略拒绝空洞理由，不改变项目设置", async (t) => {
  const { root, call } = fixture(t);
  const result = await call("update_project", { completion_evidence: { minimum: "execution_only", reason: "ok" } });
  assert.equal(result.isError, true); assert.equal(loadProject(root).completion_evidence, undefined);
});

test("质量子进程不会继承Node内部测试上下文而静默跳过文件", async (t) => {
  const { root } = fixture(t);
  writeRel(root, "test/real.test.mjs", "import test from 'node:test'; import assert from 'node:assert/strict'; test('really runs',()=>assert.equal(2+2,4));\n");
  const previous = process.env.NODE_TEST_CONTEXT;
  try {
    process.env.NODE_TEST_CONTEXT = "child-v8";
    const result = await runQualityPlan([{ command: process.execPath, args: ["--test", "test/real.test.mjs"], cwd: root, kind: "test", requiredExecutable: process.execPath, timeoutMs: 10000, maxOutputBytes: 65536 }], { execute: true });
    assert.equal(result.ok, true);
    const summary = qualityOutputSummary("test", result.results[0].stdout, result.results[0].stderr);
    assert.equal(summary.tests, 1); assert.equal(summary.passed, 1); assert.equal(summary.evidence_level, "tests_observed");
  } finally { if (previous === undefined) delete process.env.NODE_TEST_CONTEXT; else process.env.NODE_TEST_CONTEXT = previous; }
});

test("doctor 对本地配置执行真实握手，拒绝旧版本与禁用设置", async (t) => {
  const { root } = fixture(t); const file = path.join(root, "client", "config.toml");
  const launch = { command: process.execPath, args: [path.resolve("dist/index.js"), "--root", root] };
  appendCodexProjectConfig(file, root, false, false, () => {}, launch);
  const result = await runDoctor({ root, config: file });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.probe?.tools, TOOL_CATALOG_SIZE); assert.equal(result.existing_client, "not_observed");
  const config = fs.readFileSync(file, "utf8");
  fs.writeFileSync(file, config + "enabled = false\n");
  assert.equal((await runDoctor({ root, config: file })).ok, false);
  fs.writeFileSync(file, config.replace(JSON.stringify(launch.command), '"npx"').replace(JSON.stringify(launch.args), JSON.stringify(["-y", "@luckychen1993/pm-mcp@0.1.5", "--root", root])));
  const old = await runDoctor({ root, config: file });
  assert.equal(old.ok, false); assert.ok(old.issues.some((issue) => issue.includes("不一致")));
});

test("doctor 参数接受 codex|workbuddy，拒绝其他客户端", () => {
  assert.equal(parseDoctorArgs(["--root", ".", "--client", "workbuddy"]).client, "workbuddy");
  assert.equal(parseDoctorArgs(["--root", ".", "--client", "codex"]).client, "codex");
  assert.throws(() => parseDoctorArgs(["--root", ".", "--client", "cursor"]), /codex\|workbuddy/);
});

test("doctor 读取 WorkBuddy 标准 mcp.json：补 --root 真实握手，拒绝非本地入口与禁用条目", async (t) => {
  const { root } = fixture(t);
  const configDir = path.join(root, "wb-config");
  fs.mkdirSync(configDir, { recursive: true });
  const file = path.join(configDir, "mcp.json");
  const write = (server: Record<string, unknown>) => fs.writeFileSync(file, JSON.stringify({ mcpServers: { "pm-mcp": server } }), "utf8");

  write({ command: process.execPath, args: [path.resolve("dist/index.js")], env: {} });
  const result = await runDoctor({ root, client: "workbuddy", config: file });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.probe?.tools, TOOL_CATALOG_SIZE);
  assert.equal(result.configuration, "workbuddy_local_probe");
  assert.equal(result.configured_server, "pm-mcp");

  write({ command: "npx", args: ["-y", PACKAGE_SPEC] });
  const rejected = await runDoctor({ root, client: "workbuddy", config: file });
  assert.equal(rejected.ok, false);
  assert.ok(rejected.issues.some((issue) => issue.includes("本地 pm-mcp")));

  write({ command: process.execPath, args: [path.resolve("dist/index.js")], disabled: true });
  const disabled = await runDoctor({ root, client: "workbuddy", config: file });
  assert.equal(disabled.ok, false);
  assert.ok(disabled.issues.some((issue) => issue.includes("禁用")));
});

test("doctor 对 WorkBuddy 配置缺失/坏 JSON/非法字段一律 fail-closed，已带 --root 时不重复追加", async (t) => {
  const { root } = fixture(t);
  const configDir = path.join(root, "wb-config");
  fs.mkdirSync(configDir, { recursive: true });
  const file = path.join(configDir, "mcp.json");
  const write = (text: string) => fs.writeFileSync(file, text, "utf8");
  const probe = (target: string) => runDoctor({ root, client: "workbuddy", config: target });

  const missing = await probe(path.join(configDir, "absent.json"));
  assert.equal(missing.ok, false);
  assert.ok(missing.issues.some((issue) => issue.includes("未在 WorkBuddy")));

  write("{broken");
  const broken = await probe(file);
  assert.equal(broken.ok, false);
  assert.ok(broken.issues.some((issue) => issue.includes("合法 JSON")));

  write(JSON.stringify({ mcpServers: { "pm-mcp": { command: process.execPath, args: "nope" } } }));
  const badArgs = await probe(file);
  assert.equal(badArgs.ok, false);
  assert.ok(badArgs.issues.some((issue) => issue.includes("字符串数组")));

  write(JSON.stringify({ mcpServers: { "pm-mcp": { args: [] } } }));
  const noCommand = await probe(file);
  assert.equal(noCommand.ok, false);
  assert.ok(noCommand.issues.some((issue) => issue.includes("command")));

  write(JSON.stringify({ mcpServers: { "pm-mcp": { command: process.execPath, args: [path.resolve("dist/index.js"), "--root", root] } } }));
  const pinned = await probe(file);
  assert.equal(pinned.ok, true, JSON.stringify(pinned));
  assert.equal(pinned.probe?.tools, TOOL_CATALOG_SIZE);
});

test("验收选择来自单一项目配置，CLI可显式覆盖且非法版本拒绝", (t) => {
  const { root } = fixture(t);
  writeRel(root, "package.json", JSON.stringify({ pm_mcp: { acceptance_baseline: { id: "custom", version: "1.1.0" } } }));
  assert.deepEqual(acceptanceTarget(root, []), { id: "custom", version: "1.1.0" });
  assert.deepEqual(acceptanceTarget(root, ["--baseline-id", "other", "--baseline-version", "2.0.0"]), { id: "other", version: "2.0.0" });
  assert.throws(() => acceptanceTarget(root, ["--baseline-version", "../invalid"]));
  assert.throws(() => acceptanceTarget(root, ["--baseline-version"]));
});

test("有界分页保留全部编号，缩略文本不突破项目行数预算", async (t) => {
  const { root, ok, seed } = fixture(t); await seed(50);
  await ok("update_project", { output_budget_lines: 20 });
  const data = loadTasks(root); data.tasks[0].title = "很长的标题\n".repeat(80); saveTasks(root, data);
  const result = await ok("list_tasks", { page_size: 100 });
  assert.equal(result.structuredContent.returned, 16);
  assert.equal(result.structuredContent.items[0].abbreviated, true);
  assert.ok(result.content[0].text.split("\n").length <= 20);
  const empty = await ok("list_tasks", { tag: "没有这个标签" });
  assert.equal(empty.structuredContent.total, 0); assert.equal(empty.structuredContent.next_cursor, null);
});

test("配置含BOM仍能升级；歧义条目与未知启动器拒绝改写", (t) => {
  const { root } = fixture(t); const file = path.join(root, "client", "config.toml");
  const header = `[mcp_servers.${codexProjectServerKey(root)}]\n`;
  const args = `args = ${JSON.stringify(["-y", "@luckychen1993/pm-mcp@0.1.5", "--root", root])}\n`;
  const original = '\uFEFF' + header + 'command = "npx"\n' + args;
  writeRel(root, "client/config.toml", original);
  appendCodexProjectConfig(file, root, true, false, () => {});
  assert.ok(fs.readFileSync(file, "utf8").startsWith('\uFEFF'));
  const ambiguous = header + 'command = "npx"\n' + args + '\n[mcp_servers.pm-mcp]\ncommand = "npx"\n' + args;
  fs.writeFileSync(file, ambiguous);
  assert.throws(() => appendCodexProjectConfig(file, root, true, false, () => {}), /多个/);
  assert.equal(fs.readFileSync(file, "utf8"), ambiguous);
  const unknown = header + 'command = "unknown-launcher"\n' + args;
  fs.writeFileSync(file, unknown);
  assert.throws(() => appendCodexProjectConfig(file, root, true, false, () => {}), /不是可识别/);
  assert.equal(fs.readFileSync(file, "utf8"), unknown);
});
