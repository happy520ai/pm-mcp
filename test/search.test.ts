import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { contentCacheStats, readText, resetContentReadStats, rgSearch, searchCode, searchKnowledge } from "../src/search.ts";
import { loadDebugLog, loadSessions, loadTasks, saveDebugLog, saveSessions, saveTasks } from "../src/store.ts";
import { DebugEntrySchema, SessionSchema, TaskSchema, now } from "../src/types.ts";
import { saveGovernance } from "../src/governance-model.ts";
import { initTestProject, mkProj } from "./helpers.ts";

test("search_code 返回 file:line 并支持 glob 收窄", () => {
  const root = mkProj({
    "src/a.ts": "export function findUser() {}\nexport const x = 1;\n",
    "src/b.md": "这里提到 findUser 的文档\n",
    "dist/gen.ts": "findUser\n", // dist 应被忽略
  });
  initTestProject(root);
  const res = searchCode(root, "findUser");
  assert.ok(res.matches.some((m) => m.rel === "src/a.ts" && m.line === 1));
  assert.ok(res.matches.some((m) => m.rel === "src/b.md" && m.line === 1));
  assert.ok(!res.matches.some((m) => m.rel === "dist/gen.ts"), "忽略目录不进结果");
  const narrowed = searchCode(root, "findUser", "src/*.ts");
  assert.ok(narrowed.matches.every((m) => m.rel.startsWith("src/") && m.rel.endsWith(".ts")));
});

test("search_code 正则非法时按字面量处理", () => {
  const root = mkProj({ "src/a.ts": "const re = '(a+';\n" });
  initTestProject(root);
  const res = searchCode(root, "(a+");
  assert.equal(res.matches.length, 1);
});

test("search_knowledge 检索调试记录（用历史结论代替重新推理）", () => {
  const root = mkProj({ "src/a.ts": "export const x = 1;\n" });
  initTestProject(root);
  const data = loadDebugLog(root);
  data.entries.push(
    DebugEntrySchema.parse({
      id: "D-0001",
      date: now(),
      symptom: "构建后样式丢失",
      root_cause: "CSS 顺序依赖打包器的副作用分组",
      fix: "显式 import 顺序并关闭 optimize 选项",
    }),
  );
  saveDebugLog(root, data);
  const out = searchKnowledge(root, "样式丢失");
  assert.ok(out.includes("调试记录"));
  assert.ok(out.includes("CSS 顺序"));
});

test("内容缓存：readText 二次命中；rg 可用时搜索走 rg 后端且结果稳定", async () => {
  const root = mkProj({
    "src/one.ts": "export const alpha = 1;\r\nexport const beta = 2;\r\n",
    "src/two.ts": "export const alpha2 = 3;\n",
  });
  initTestProject(root);
  // readText（安全/许可证/内置回退共用）：首次入缓存，二次命中
  const before = contentCacheStats();
  assert.ok(readText(root, "src/one.ts")?.includes("alpha"));
  assert.ok(contentCacheStats().files >= before.files + 1, "首次读取后内容进入缓存");
  assert.ok(readText(root, "src/one.ts")?.includes("alpha"), "二次读取命中缓存");
  // 搜索结果稳定（rg 或内置后端均可），且 CRLF 行号正确
  const r1 = searchCode(root, "beta");
  const r2 = searchCode(root, "beta");
  assert.deepEqual(r1.matches, r2.matches);
  assert.equal(r1.matches[0]?.line, 2, "CRLF 文件行号从 1 起");
});

test("内容缓存按项目根隔离并记录真实读取字节", () => {
  const rootA = mkProj({ "src/same.ts": "export const side = 'A';\n" });
  const rootB = mkProj({ "src/same.ts": "export const side = 'B';\n" });
  const stamp = new Date("2026-01-01T00:00:00.000Z");
  const fileA = `${rootA}/src/same.ts`;
  const fileB = `${rootB}/src/same.ts`;
  // 同相对路径、同尺寸、同 mtime，仍必须按项目根返回各自内容。
  fs.utimesSync(fileA, stamp, stamp);
  fs.utimesSync(fileB, stamp, stamp);

  resetContentReadStats(true);
  assert.equal(readText(rootA, "src/same.ts"), "export const side = 'A';\n");
  assert.equal(readText(rootB, "src/same.ts"), "export const side = 'B';\n");
  assert.equal(readText(rootA, "src/same.ts"), "export const side = 'A';\n");
  const stats = contentCacheStats();
  assert.equal(stats.diskReadFiles, 2);
  assert.equal(stats.diskReadBytes, fs.statSync(fileA).size + fs.statSync(fileB).size);
  assert.equal(stats.cacheHits, 1);
});

test("rg 后端在非 Git 项目中也尊重 .gitignore", () => {
  const root = mkProj({
    ".gitignore": "ignored.ts\n",
    "ignored.ts": "export const ignoreNeedle = 1;\n",
    "visible.ts": "export const ignoreNeedle = 2;\n",
  });
  initTestProject(root);
  const matches = rgSearch(root, "ignoreNeedle", undefined, 30, false);
  // 未安装 rg 时产品会走内置回退；此用例只约束可用时的 rg 参数语义。
  if (matches === null) return;
  assert.deepEqual(matches.map((m) => m.rel), ["visible.ts"]);
});

test("search_knowledge 检索任务与会话", () => {
  const root = mkProj();
  initTestProject(root);
  const tasks = loadTasks(root);
  tasks.tasks.push(TaskSchema.parse({ id: "T-001", title: "接入微信支付", created: now(), updated: now() }));
  saveTasks(root, tasks);
  const sessions = loadSessions(root);
  sessions.sessions.push(SessionSchema.parse({ id: "S-0001", date: now(), summary: "完成了微信支付的沙箱联调" }));
  saveSessions(root, sessions);
  const out = searchKnowledge(root, "微信支付");
  assert.ok(out.includes("T-001"));
  assert.ok(out.includes("沙箱联调"));
});

test("search_knowledge 检索模块、owner、接口与仓库治理", () => {
  const root = mkProj({ "src/a.ts": "export const a = 1;\n" });
  initTestProject(root);
  saveGovernance(root, {
    modules: [{ id: "billing", name: "Billing", roots: ["src"], kind: "service", owners: ["team-payments"], languages: ["typescript"], public_interfaces: ["billing-api"], depends_on: [], allowed_dependencies: [], denied_dependencies: [] }],
    interfaces: [{ id: "billing-api", kind: "http", provider: "billing", consumers: [], contract_files: ["src/a.ts"], version: "1.0.0" }],
    repositories: [{ id: "billing-repo", name: "Billing repo", root: ".", version: "1.0.0", dependencies: [] }],
  });
  const out = searchKnowledge(root, "team-payments");
  assert.ok(out.includes("模块/接口/仓库治理") && out.includes("billing"));
});
