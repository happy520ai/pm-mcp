/**
 * 真实仓库测试：以本仓库（E:\通用型项目管理，真实中文路径）为被测对象。
 * 只读校验真实状态；变更型审计在全仓拷贝上执行，不碰真实状态。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  loadDebugLog,
  loadFeatures,
  loadFileNotes,
  loadProject,
  loadRoadmap,
  loadSecurity,
  loadSessions,
  loadTasks,
} from "../src/store.ts";
import { buildChangelog, buildDashboard } from "../src/dashboard.ts";
import { detectDrift, auditStructure, latestSnapshot } from "../src/audit.ts";
import { auditLicense } from "../src/license.ts";
import { closeIndex } from "../src/index-store.ts";

const REPO = path.resolve(".");

test("真实 .pm 全账本通过 schema 校验（自家数据先合规）", () => {
  const p = loadProject(REPO);
  assert.equal(p.name, "pm-mcp");
  assert.equal(p.license, "MIT");
  assert.ok(p.modules.includes("src"));
  const roadmap = loadRoadmap(REPO);
  assert.deepEqual(roadmap.milestones.map((m) => m.id), ["M1", "M2"]);
  const tasks = loadTasks(REPO);
  assert.ok(tasks.tasks.length >= 12, `真实任务数 ${tasks.tasks.length}`);
  const features = loadFeatures(REPO).features;
  assert.equal(features.length, 11);
  assert.ok(features.some((f) => f.id === "F-008" && f.name === "字节/超大LOC容量基准"));
  assert.ok(features.some((f) => f.id === "F-009" && f.name === "跨文件/模块/语言语义治理"));
  assert.ok(features.some((f) => f.id === "F-010" && f.name === "标准化产品验收与防伪证据链"));
  assert.ok(features.some((f) => f.id === "F-011" && f.name === "编译器与多语言 AST 语义治理"));
  assert.ok(loadSessions(REPO).sessions.length >= 1);
  assert.ok(loadDebugLog(REPO) !== undefined);
  assert.ok(Object.keys(loadFileNotes(REPO).notes).length >= 6);
  assert.ok(latestSnapshot(REPO) !== null, "存在真实快照");
});

test("真实漂移为零：全部功能的入口与测试文件真实存在（防幻觉自查）", () => {
  assert.deepEqual(detectDrift(REPO), []);
  const feats = loadFeatures(REPO).features;
  for (const f of feats) {
    for (const file of [...f.entry_files, ...f.test_files]) {
      assert.ok(fs.existsSync(path.join(REPO, file)), `${f.id} 引用的 ${file} 应真实存在`);
    }
  }
});

test("真实 PROJECT.md 与状态同步（无人手改、无漂移）", () => {
  const strip = (s: string): string => s.split("\n").filter((l) => !l.startsWith("> 生成时间:")).join("\n");
  const onDisk = strip(fs.readFileSync(path.join(REPO, "PROJECT.md"), "utf8"));
  assert.equal(onDisk, strip(buildDashboard(REPO)), "PROJECT.md 应与最新状态一致（不一致=有人手改或忘记刷新）");
  assert.equal(fs.readFileSync(path.join(REPO, ".pm/changelog.md"), "utf8"), buildChangelog(REPO));
});

test("真实任务纪律：ID 唯一、seq 对齐、done 有笔记与验证、已完成维护债务闭环", () => {
  const file = loadTasks(REPO);
  const tasks = file.tasks;
  const ids = tasks.map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length, "任务 ID 必须唯一（绕过工具层直写会破坏，一旦出现立即修复）");
  const maxNum = Math.max(...ids.map((id) => Number(id.replace("T-", ""))));
  assert.ok(file.seq >= maxNum, `seq(${file.seq}) 必须 >= 最大任务号(${maxNum})`);
  const done = tasks.filter((t) => t.status === "done");
  assert.ok(done.length >= 7);
  for (const t of done) {
    assert.ok(t.result_note.trim(), `${t.id} done 必须有 result_note`);
    assert.ok(t.verification.trim(), `${t.id} done 必须有 verification`);
    assert.ok(t.completed_at, `${t.id} done 必须有时间戳`);
  }
  const debt = tasks.find((t) => t.type === "debt" && t.title.includes("tools.ts"));
  assert.ok(debt && debt.status === "done", "tools.ts 拆分债务应在账并已闭环");
  const benchmarkDebt = tasks.find((t) => t.type === "debt" && t.title.includes("benchmark-volume"));
  assert.ok(benchmarkDebt && benchmarkDebt.status === "done", "benchmark-volume 拆分债务应在账并已闭环");
});

test("真实安全台账：全部发现已处置且 accepted 都留了理由", () => {
  const sec = loadSecurity(REPO);
  assert.ok(sec.findings.length >= 5, `真实发现数 ${sec.findings.length}`);
  for (const f of sec.findings) {
    assert.notEqual(f.status, "open", `${f.id} 不应有未处理发现`);
    if (f.status === "accepted") {
      assert.ok(f.note.trim().length >= 5, `${f.id} 接受风险必须留理由`);
    }
  }
  // 红线：真实台账不含任何密钥形态明文
  const raw = fs.readFileSync(path.join(REPO, ".pm/security.json"), "utf8");
  assert.ok(!raw.includes("AKIA"), "台账无 AWS key 明文");
  assert.ok(!raw.includes("sk-"), "台账无 API key 明文");
});

test("真实 server 起在本仓库：46 工具可用，路线图与状态如实", async (t) => {
  const client = new Client({ name: "realrepo", version: "0" });
  t.after(() => client.close().catch(() => undefined));
  await client.connect(
    new StdioClientTransport({ command: process.execPath, args: [path.resolve("src/index.ts"), "--root", REPO], env: { PM_MCP_HOME: REPO + "-test-home" } }),
  );
  const tools = await client.listTools();
  assert.equal(tools.tools.length, 46);
  const r = await client.callTool({ name: "get_status", arguments: {} });
  const text = ((r as { content: Array<{ text?: string }> }).content ?? []).map((c) => c.text ?? "").join("\n");
  assert.ok(text.includes("pm-mcp"));
  assert.ok(text.includes("M1"));
  assert.ok(text.includes("M2"));
  const rr = await client.callTool({ name: "get_roadmap", arguments: { depth: 1 } });
  const rt = ((rr as { content: Array<{ text?: string }> }).content ?? []).map((c) => c.text ?? "").join("\n");
  assert.ok(rt.includes("[██████████] 100% M1"), "M1 完成态如实呈现");
  await client.close();
});

test("全仓拷贝上跑变更型审计：结构对账与许可证审计不误报（node_modules 缺失可容忍）", () => {
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), "pm-realcopy-"));
  // 拷贝除 node_modules/dist 外的真实仓库（含 .pm）
  fs.cpSync(REPO, copy, {
    recursive: true,
    filter: (src: string): boolean => {
      const rel = path.relative(REPO, src);
      if (rel === "") return true;
      const top = rel.split(path.sep)[0];
      if (top === "node_modules" || top === "dist") return false;
      // index.db 是机器本地缓存（.gitignore 之），拷贝会把原仓库的索引行集带进副本
      if (top === ".pm" && path.basename(rel).startsWith("index.db")) return false;
      return true;
    },
  });

  const audit = auditStructure(copy, 200);
  assert.ok(audit.includes("② 漂移对账"), "报告结构完整");
  assert.ok(audit.includes("无漂移") || audit.includes("✅"), "真实代码无漂移");
  assert.ok(!audit.includes("测试蒸发"), "真实仓库不应报告测试蒸发");
  assert.ok(!audit.includes("新增依赖"), "无未知新增依赖");

  const lic = auditLicense(copy, 200);
  assert.ok(lic.includes("项目许可证: MIT"));
  assert.ok(lic.includes("LICENSE 文件: 存在"));
  assert.ok(!lic.includes("🔴"), "无 copyleft 冲突");

  closeIndex(copy); // 打开中的 SQLite 文件在 Windows 上无法删除
  fs.rmSync(copy, { recursive: true, force: true });
});
