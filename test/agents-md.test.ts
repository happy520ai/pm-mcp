/**
 * AGENTS.md 自动规矩：init 时创建/合并；已存在不覆盖；缺段插入；幂等；可显式关闭。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initProject } from "../src/init.ts";
import { syncAgentsMd, upsertAgentsMd } from "../src/agents-md.ts";

function mkRoot(files: Record<string, string> = {}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pm-am-"));
  process.env.PM_MCP_HOME = root + "-home";
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");
  }
  return root;
}

const PROCESS_ONLY = [
  "# 我的项目",
  "",
  "<!-- pm-mcp:agents-md:v1:begin -->",
  "旧流程段，保持不变。",
  "<!-- pm-mcp:agents-md:v1:end -->",
  "",
  "## 手工段",
  "",
  "这段必须保留。",
  "",
].join("\n");

test("init_project 自动创建流程段 + 判断段", () => {
  const root = mkRoot({ "src/a.ts": "export const a = 1;\n" });
  initProject(root, { name: "x" });
  const md = fs.readFileSync(path.join(root, "AGENTS.md"), "utf8");
  assert.ok(md.includes("pm-mcp:agents-md:v1:begin"));
  assert.ok(md.includes("pm-mcp:judgment:v1:begin"));
  assert.ok(md.includes("get_status"), "包含开工规矩");
  assert.ok(md.includes("log_session"), "包含收工规矩");
  assert.ok(md.includes("判断与交付"), "包含判断规矩");
  assert.ok(md.includes("pre-mortem"), "包含不可逆决策的前置检查");
  assert.ok(md.includes("expires_when"), "包含沉淀与退役");
});

test("已有 AGENTS.md：增量追加，绝不覆盖既有内容", () => {
  const root = mkRoot({ "AGENTS.md": "# 我的项目\n\n自有说明，不许动。\n" });
  initProject(root, { name: "x" });
  const md = fs.readFileSync(path.join(root, "AGENTS.md"), "utf8");
  assert.ok(md.startsWith("# 我的项目"), "原有开头保留");
  assert.ok(md.includes("自有说明，不许动。"), "原有内容保留");
  assert.ok(md.includes("pm-mcp:agents-md:v1:begin"), "流程段已追加");
  assert.ok(md.includes("pm-mcp:judgment:v1:begin"), "判断段已追加");
});

test("旧项目只有流程段：判断段插在流程段之后，后续手工内容保留", () => {
  const root = mkRoot({ "AGENTS.md": PROCESS_ONLY });
  const sync = syncAgentsMd(root);
  assert.equal(sync.result, "appended");
  assert.deepEqual(sync.added, ["judgment"]);
  assert.deepEqual(sync.present, ["process"]);
  const md = fs.readFileSync(path.join(root, "AGENTS.md"), "utf8");
  const processEnd = md.indexOf("<!-- pm-mcp:agents-md:v1:end -->");
  const judgmentBegin = md.indexOf("<!-- pm-mcp:judgment:v1:begin -->");
  const judgmentEnd = md.indexOf("<!-- pm-mcp:judgment:v1:end -->");
  const manual = md.indexOf("## 手工段");
  assert.ok(processEnd >= 0 && judgmentBegin > processEnd, "判断段在流程段之后");
  assert.ok(judgmentEnd > judgmentBegin && manual > judgmentEnd, "手工段仍在判断段之后");
  assert.ok(md.includes("旧流程段，保持不变。"), "旧流程段不被改写");
  assert.ok(md.includes("这段必须保留。"), "手工内容不被覆盖");
});

test("流程段在文件末尾：判断段直接接在后面", () => {
  const root = mkRoot({
    "AGENTS.md": "<!-- pm-mcp:agents-md:v1:begin -->\n旧流程\n<!-- pm-mcp:agents-md:v1:end -->\n",
  });
  const sync = syncAgentsMd(root);
  assert.equal(sync.result, "appended");
  const md = fs.readFileSync(path.join(root, "AGENTS.md"), "utf8");
  assert.ok(md.trimEnd().endsWith("<!-- pm-mcp:judgment:v1:end -->"));
});

test("CRLF 文件：插入判断段后保持 CRLF 且不产生多余空行", () => {
  const root = mkRoot({
    "AGENTS.md": [
      "# 项目",
      "",
      "<!-- pm-mcp:agents-md:v1:begin -->",
      "旧流程",
      "<!-- pm-mcp:agents-md:v1:end -->",
      "",
      "## 手工段",
      "",
      "保留",
      "",
    ].join("\r\n"),
  });
  const sync = syncAgentsMd(root);
  assert.equal(sync.result, "appended");
  const md = fs.readFileSync(path.join(root, "AGENTS.md"), "utf8");
  assert.ok(md.includes("<!-- pm-mcp:judgment:v1:end -->\r\n\r\n## 手工段"), JSON.stringify(md.slice(-240)));
  assert.ok(!md.includes("\r\n\r\n\r\n## 手工段"), "不得出现多余空行");
});

test("无标记且无结尾换行：追加时补分隔", () => {
  const root = mkRoot({ "AGENTS.md": "# 项目" });
  initProject(root, { name: "x" });
  const md = fs.readFileSync(path.join(root, "AGENTS.md"), "utf8");
  assert.ok(md.startsWith("# 项目\n\n"), md.slice(0, 40));
});

test("幂等：再次 upsert 不产生重复段", () => {
  const root = mkRoot();
  initProject(root, { name: "x" });
  const once = fs.readFileSync(path.join(root, "AGENTS.md"), "utf8");
  assert.equal(upsertAgentsMd(root), "unchanged");
  const twice = fs.readFileSync(path.join(root, "AGENTS.md"), "utf8");
  assert.equal(once, twice);
});

test("显式关闭：agents_md:false 跳过写入", () => {
  const root = mkRoot({ "src/a.ts": "export const a = 1;\n" });
  initProject(root, { name: "x", agentsMd: false });
  assert.ok(!fs.existsSync(path.join(root, "AGENTS.md")));
  assert.equal(upsertAgentsMd(root, false), "skipped");
});

test("CLI sync-agents：dry-run 预览不写，正式调用补齐两段", () => {
  const root = mkRoot({ "src/a.ts": "export const a = 1;\n" });
  initProject(root, { name: "x", agentsMd: false });
  const cli = path.resolve("src/cli.ts");
  const preview = execFileSync(process.execPath, [cli, "sync-agents", "--root", root, "--dry-run"], { encoding: "utf8" });
  assert.ok(preview.includes("预览"), preview);
  assert.ok(!fs.existsSync(path.join(root, "AGENTS.md")));
  const created = execFileSync(process.execPath, [cli, "sync-agents", "--root", root], { encoding: "utf8" });
  assert.ok(created.includes("已创建"), created);
  const md = fs.readFileSync(path.join(root, "AGENTS.md"), "utf8");
  assert.ok(md.includes("pm-mcp:agents-md:v1:begin"));
  assert.ok(md.includes("pm-mcp:judgment:v1:begin"));
});

test("CLI sync-agents：已有流程段时追加判断段，--help 与未初始化项目有明确输出", () => {
  const root = mkRoot({ "src/a.ts": "export const a = 1;\n" });
  initProject(root, { name: "x", agentsMd: false });
  fs.writeFileSync(path.join(root, "AGENTS.md"), [
    "<!-- pm-mcp:agents-md:v1:begin -->",
    "旧流程",
    "<!-- pm-mcp:agents-md:v1:end -->",
    "",
  ].join("\n"), "utf8");
  const cli = path.resolve("src/cli.ts");
  const appended = execFileSync(process.execPath, [cli, "sync-agents", "--root", root], { encoding: "utf8" });
  assert.ok(appended.includes("已同步"), appended);
  assert.ok(fs.readFileSync(path.join(root, "AGENTS.md"), "utf8").includes("pm-mcp:judgment:v1:begin"));
  const help = execFileSync(process.execPath, [cli, "sync-agents", "--help"], { encoding: "utf8" });
  assert.ok(help.includes("sync-agents"), help);
  const uninitialized = mkRoot({ "src/a.ts": "export const a = 1;\n" });
  const failed = spawnSync(process.execPath, [cli, "sync-agents", "--root", uninitialized], { encoding: "utf8" });
  assert.equal(failed.status, 1);
  assert.ok((failed.stderr ?? "").includes("项目未初始化"), failed.stderr);
});

test("dry-run：只报告将追加的段落，不写文件", () => {
  const root = mkRoot({ "AGENTS.md": PROCESS_ONLY });
  const before = fs.readFileSync(path.join(root, "AGENTS.md"), "utf8");
  const sync = syncAgentsMd(root, { dryRun: true });
  assert.equal(sync.result, "appended");
  assert.deepEqual(sync.added, ["judgment"]);
  assert.equal(fs.readFileSync(path.join(root, "AGENTS.md"), "utf8"), before);
});

test("dry-run：文件不存在时报告 created，但不创建文件", () => {
  const root = mkRoot();
  const sync = syncAgentsMd(root, { dryRun: true });
  assert.equal(sync.result, "created");
  assert.deepEqual(sync.added, ["process", "judgment"]);
  assert.ok(!fs.existsSync(path.join(root, "AGENTS.md")));
});

test("标记段只有 begin 没有 end：回退为末尾追加，不破坏原文", () => {
  const root = mkRoot({
    "AGENTS.md": "# 项目\n\n<!-- pm-mcp:agents-md:v1:begin -->\n半截段落\n",
  });
  const sync = syncAgentsMd(root);
  assert.equal(sync.result, "appended");
  assert.deepEqual(sync.added, ["judgment"]);
  const md = fs.readFileSync(path.join(root, "AGENTS.md"), "utf8");
  assert.ok(md.includes("半截段落"));
  assert.ok(md.includes("pm-mcp:judgment:v1:begin"));
});
