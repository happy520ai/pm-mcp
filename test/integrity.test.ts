/**
 * 完整性测试：数据与状态在真实文件系统上的不变式。
 * 全账本 schema、派生文件一致性、原子性、损坏恢复、中文/空格路径、CRLF/BOM、
 * 规模折叠、ID 唯一、路径规范化、并发写不产生半截 JSON、注册表隔离。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { initProject } from "../src/init.ts";
import {
  loadDebugLog,
  loadFeatures,
  loadFileNotes,
  loadProject,
  loadRoadmap,
  loadSecurity,
  loadSessions,
  loadTasks,
  saveFeatures,
  saveProject,
  saveSessions,
  saveTasks,
} from "../src/store.ts";
import { buildChangelog, buildDashboard, refreshDerived } from "../src/dashboard.ts";
import { TaskSchema, now } from "../src/types.ts";
import { detectDrift } from "../src/audit.ts";
import { loadGovernance } from "../src/governance-model.ts";
import { scanProject } from "../src/scan.ts";
import { loadRegistry, touchRegistry } from "../src/registry.ts";

const srcEntry = path.resolve("src/index.ts");

function mkProject(dirName: string, files: Record<string, string> = {}): string {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "pm-int-"));
  // 领域层直调会经 refreshDerived touch 全局注册表，必须沙箱化（真实教训：漏设会污染 ~/.pm-mcp）
  process.env.PM_MCP_HOME = base + "-home";
  const root = path.join(base, dirName); // dirName 可含中文/空格
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");
  }
  return root;
}

test("全账本：init 后每个状态文件都能通过对应 schema 回读", () => {
  const root = mkProject("完整账本");
  initProject(root, { name: "账本校验", license: "MIT" });
  const p = loadProject(root);
  assert.equal(p.license, "MIT");
  assert.deepEqual(loadRoadmap(root).milestones, []);
  assert.deepEqual(loadTasks(root).tasks, []);
  assert.deepEqual(loadFeatures(root).features, []);
  assert.deepEqual(loadSessions(root).sessions, []);
  assert.deepEqual(loadDebugLog(root).entries, []);
  assert.deepEqual(loadFileNotes(root).notes, {});
  const sec = loadSecurity(root);
  assert.deepEqual(sec.findings, []);
  assert.deepEqual(loadGovernance(root).modules, []);
  // 每个 JSON 文件都是合法 JSON 且无 BOM
  for (const f of fs.readdirSync(path.join(root, ".pm"))) {
    if (f.endsWith(".json")) {
      const buf = fs.readFileSync(path.join(root, ".pm", f));
      assert.ok(!buf.slice(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), `${f} 不应含 BOM`);
      JSON.parse(buf.toString("utf8"));
    }
  }
});

test("派生一致性：PROJECT.md 与 changelog.md 和状态逐字节一致（剔除时间戳行）", () => {
  const root = mkProject("派生一致");
  initProject(root, { name: "派生", modules: ["src"] });
  const data = loadTasks(root);
  data.tasks.push(TaskSchema.parse({ id: "T-001", title: "任务A", status: "in_progress", created: now(), updated: now() }));
  data.tasks[0].checkpoint = { note: "n", next_step: "s", at: now() };
  saveTasks(root, data);
  const sess = loadSessions(root);
  sess.seq = 1;
  sess.sessions.push({ id: "S-0001", date: now(), author: "zcode", summary: "做了A", files: ["a.ts"], next_steps: [] });
  saveSessions(root, sess);
  refreshDerived(root);
  const strip = (s: string): string => s.split("\n").filter((l) => !l.startsWith("> 生成时间:")).join("\n");
  assert.equal(strip(fs.readFileSync(path.join(root, "PROJECT.md"), "utf8")), strip(buildDashboard(root)));
  assert.equal(fs.readFileSync(path.join(root, ".pm/changelog.md"), "utf8"), buildChangelog(root));
});

test("原子性：写入后无 .tmp 残留；目录里不存在半截 JSON", () => {
  const root = mkProject("原子");
  initProject(root, { name: "原子" });
  for (let i = 0; i < 50; i++) {
    const p = loadProject(root);
    p.phase = `阶段${i}`;
    saveProject(root, p);
  }
  const leftovers = fs.readdirSync(path.join(root, ".pm")).filter((f) => f.endsWith(".tmp"));
  assert.deepEqual(leftovers, [], "不应有 tmp 残留");
  JSON.parse(fs.readFileSync(path.join(root, ".pm/project.json"), "utf8"));
});

test("交替读写 200 轮无损坏（读-改-写竞争下的最终一致性）", () => {
  const root = mkProject("交替");
  initProject(root, { name: "交替" });
  for (let i = 0; i < 200; i++) {
    const data = loadTasks(root);
    data.tasks.push(TaskSchema.parse({ id: `T-${String(i + 1).padStart(3, "0")}`, title: `t${i}`, created: now(), updated: now() }));
    saveTasks(root, data);
  }
  assert.equal(loadTasks(root).tasks.length, 200);
  // ID 唯一性
  const ids = loadTasks(root).tasks.map((t) => t.id);
  assert.equal(new Set(ids).size, 200);
});

test("损坏恢复：坏 JSON / 缺 project.json 给出含路径的可读错误", () => {
  const root = mkProject("损坏");
  initProject(root, { name: "损坏" });
  fs.writeFileSync(path.join(root, ".pm/tasks.json"), "{ broken", "utf8");
  assert.throws(() => loadTasks(root), (e: Error) => e.message.includes("tasks.json"));
  const root2 = mkProject("空项目");
  assert.throws(() => loadProject(root2), /init_project/);
});

test("中文与空格路径全链路可用", () => {
  const root = mkProject("订单 系统 中文 路径", { "src/功能.ts": "export const f = 1;\n" });
  initProject(root, { name: "中文路径项目", modules: ["src"] });
  const data = loadFeatures(root);
  data.seq = 1;
  data.features.push({ id: "F-001", name: "功能", description: "", module: "src", entry_files: ["src/功能.ts"], test_files: [], status: "implemented", created: now(), updated: now() });
  saveFeatures(root, data);
  assert.equal(detectDrift(root).length, 0);
  refreshDerived(root);
  assert.ok(fs.readFileSync(path.join(root, "PROJECT.md"), "utf8").includes("中文路径项目"));
});

test("CRLF 不影响行号与检索语义；BOM 文件不崩", async () => {
  const root = mkProject("行尾", {
    "src/crlf.ts": "line1\r\nline2 target\r\nline3\r\n",
    "src/bom.ts": "﻿export const b = 1;\n",
  });
  initProject(root, { name: "行尾" });
  const { searchCode } = await import("../src/search.ts");
  const res = searchCode(root, "target");
  const hit = res.matches.find((m) => m.rel === "src/crlf.ts");
  assert.ok(hit, "CRLF 文件可检索");
  assert.equal(hit!.line, 2, "行号从 1 起");
  assert.ok(!hit!.text.includes("\r"), "命中文本不含 \\r");
  const bomRes = searchCode(root, "export const b");
  assert.equal(bomRes.matches.length, 1, "BOM 文件不崩且可检索");
});

test("规模：500 任务折叠在输出预算内，ID 不溢出", async (t) => {
  const root = mkProject("规模");
  initProject(root, { name: "规模", exposure: "local", license: "MIT" });
  const data = loadTasks(root);
  data.seq = 500;
  for (let i = 1; i <= 500; i++) {
    data.tasks.push(TaskSchema.parse({ id: `T-${String(i).padStart(3, "0")}`, title: `任务${i}`, status: "backlog", created: now(), updated: now() }));
  }
  saveTasks(root, data);

  const client = new Client({ name: "scale", version: "0" });
  t.after(() => client.close().catch(() => undefined));
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [srcEntry, "--root", root], env: { PM_MCP_HOME: root + "-home" } }));
  const r = await client.callTool({ name: "list_tasks", arguments: {} });
  const out = ((r as { content: Array<{ text?: string }> }).content ?? []).map((c) => c.text ?? "").join("\n");
  const lineCount = out.split("\n").length;
  assert.ok(lineCount <= 152, `输出 ${lineCount} 行应被折叠到预算 150 内`);
  assert.ok(out.includes("另有"), "折叠提示出现");
  assert.ok(out.includes("共 500 个任务"));
  await client.close();
});

test("路径规范化：反斜杠路径入库为 / 分隔", () => {
  const root = mkProject("规范化", { "src/x.ts": "export const x = 1;\n" });
  initProject(root, { name: "规范化" });
  const data = loadTasks(root);
  data.tasks.push(TaskSchema.parse({ id: "T-001", title: "t", files: ["src\\x.ts", "src/y.ts"], created: now(), updated: now() }));
  saveTasks(root, data);
  assert.deepEqual(loadTasks(root).tasks[0].files, ["src/x.ts", "src/y.ts"]);
});

test("并发双进程写同一账本：最终 JSON 仍然合法（无半截文件）", async (t) => {
  const root = mkProject("并发");
  initProject(root, { name: "并发" });
  const clients: Client[] = [];
  t.after(() => Promise.all(clients.map((c) => c.close().catch(() => undefined))));
  const mk = async (): Promise<void> => {
    const client = new Client({ name: "concurrent", version: "0" });
    clients.push(client);
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [srcEntry, "--root", root], env: { PM_MCP_HOME: root + "-home" } }));
    for (let i = 0; i < 10; i++) {
      await client.callTool({ name: "add_task", arguments: { title: `并发任务` } });
    }
    await client.close();
  };
  await Promise.all([mk(), mk()]);
  // 账本锁生效后：不丢、不重、合法
  const parsed = loadTasks(root);
  assert.equal(parsed.tasks.length, 20, `两客户端各 10 个任务必须全部存活（实际 ${parsed.tasks.length}）`);
  const tmpLeftovers = fs.readdirSync(path.join(root, ".pm")).filter((f) => f.endsWith(".tmp"));
  assert.deepEqual(tmpLeftovers, [], "并发后无 tmp 残留");
});

test("增量索引：二次扫描全命中，改动单文件只失效一个，结果与全量一致", () => {
  const root = mkProject("增量索引", {
    "src/a.ts": "export const a = 1;\nexport const b = 2;\n",
    "src/c.py": "x = 1\n",
    "test/a.test.ts": "test('x', () => { assert.ok(true); });\n",
  });
  initProject(root, { name: "增量" });
  const s1 = scanProject(root);
  assert.equal(s1.cacheHits, 0, "首次扫描无缓存可命中");
  assert.ok(fs.existsSync(path.join(root, ".pm/index.db")), "索引已持久化（SQLite）");
  const s2 = scanProject(root);
  assert.equal(s2.cacheHits, s2.totalFiles, "二次扫描全部命中（未重读内容）");
  assert.equal(s2.totalLoc, s1.totalLoc, "增量结果与全量一致（loc）");
  assert.equal(s2.skipMarkers, s1.skipMarkers, "增量结果与全量一致（skip）");
  // 改动一个文件 → 只有它失效
  fs.writeFileSync(path.join(root, "src/a.ts"), "export const a = 1;\n".repeat(10), "utf8");
  const s3 = scanProject(root);
  assert.equal(s3.cacheHits, s3.totalFiles - 1, "只有变更文件未命中");
  assert.equal(s3.totalLoc, s2.totalLoc - 2 + 10, "变更文件重新计算 loc");
  // 删除文件 → 索引收敛
  fs.rmSync(path.join(root, "src/c.py"));
  const s4 = scanProject(root);
  assert.ok(!s4.files.some((f) => f.rel === "src/c.py"));
});

test("注册表隔离：不同 PM_MCP_HOME 互不可见", () => {
  const rootA = mkProject("注册A");
  const rootB = mkProject("注册B");
  const homeA = rootA + "-home";
  const homeB = rootB + "-home";
  const prev = process.env.PM_MCP_HOME;
  process.env.PM_MCP_HOME = homeA;
  touchRegistry(rootA, "项目A");
  process.env.PM_MCP_HOME = homeB;
  touchRegistry(rootB, "项目B");
  process.env.PM_MCP_HOME = homeA;
  assert.equal(loadRegistry().projects.length, 1);
  assert.equal(loadRegistry().projects[0].name, "项目A");
  process.env.PM_MCP_HOME = prev;
});
