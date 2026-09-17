/**
 * AGENTS.md 自动规矩：init 时创建/合并；已存在不覆盖；幂等；可显式关闭。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initProject } from "../src/init.ts";
import { upsertAgentsMd } from "../src/agents-md.ts";

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

test("init_project 自动创建 AGENTS.md 规矩段", () => {
  const root = mkRoot({ "src/a.ts": "export const a = 1;\n" });
  initProject(root, { name: "x" });
  const md = fs.readFileSync(path.join(root, "AGENTS.md"), "utf8");
  assert.ok(md.includes("pm-mcp:agents-md:v1:begin"));
  assert.ok(md.includes("get_status"), "包含开工规矩");
  assert.ok(md.includes("log_session"), "包含收工规矩");
});

test("已有 AGENTS.md：增量追加，绝不覆盖既有内容", () => {
  const root = mkRoot({ "AGENTS.md": "# 我的项目\n\n自有说明，不许动。\n" });
  initProject(root, { name: "x" });
  const md = fs.readFileSync(path.join(root, "AGENTS.md"), "utf8");
  assert.ok(md.startsWith("# 我的项目"), "原有开头保留");
  assert.ok(md.includes("自有说明，不许动。"), "原有内容保留");
  assert.ok(md.includes("pm-mcp:agents-md:v1:begin"), "规矩段已追加");
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
