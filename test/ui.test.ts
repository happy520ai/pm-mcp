import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initProject } from "../src/init.ts";
import { closeIndex } from "../src/index-store.ts";
import { saveTasks, saveRoadmap, loadTasks, loadRoadmap } from "../src/store.ts";
import { TaskSchema, MilestoneSchema, now } from "../src/types.ts";
import { buildDashboardState, renderDashboardHtml, startUiServer } from "../src/ui.ts";

const roots: string[] = [];
after(() => {
  for (const root of roots) {
    closeIndex(root);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function fixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pm-ui-"));
  process.env.PM_MCP_HOME = root + "-home";
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "app.ts"), "export const app = 1;\n", "utf8");
  initProject(root, { name: "仪表盘项目", description: "UI 测试 <script>alert(1)</script>", agentsMd: false });
  const roadmap = loadRoadmap(root);
  roadmap.milestones.push(MilestoneSchema.parse({ id: "M1", title: "核心能力", order: 0, created: now(), updated: now() }));
  saveRoadmap(root, roadmap);
  const tasks = loadTasks(root);
  tasks.seq += 1;
  tasks.tasks.push(TaskSchema.parse({
    id: "T-001",
    title: "<script>alert('xss')</script>",
    type: "feature",
    status: "done",
    milestone: "M1",
    author: "test",
    created: now(),
    updated: now(),
    completed_at: now(),
  }));
  saveTasks(root, tasks);
  roots.push(root);
  return root;
}

test("仪表盘状态：账本聚合与里程碑进度", () => {
  const state = buildDashboardState(fixture());
  assert.equal(state.name, "仪表盘项目");
  assert.equal(state.tasks.total, 1);
  assert.equal(state.tasks.byStatus["done"], 1);
  assert.equal(state.features.total, 0);
  assert.equal(state.milestones[0]?.done, 1);
  assert.equal(state.milestones[0]?.total, 1);
  assert.equal(state.security.open, 0);
});

test("HTML 渲染强制转义用户内容，脚本不可注入", () => {
  const html = renderDashboardHtml(buildDashboardState(fixture()));
  assert.ok(!html.includes("<script>alert"), "任务标题必须被转义");
  assert.ok(html.includes("&lt;script&gt;alert"), "应出现转义后的文本");
  assert.ok(html.includes("仪表盘项目"));
  assert.ok(html.includes("M1"));
});

test("UI 服务：只绑 127.0.0.1，GET 只读，未知路径 404", async (t) => {
  const root = fixture();
  const server = await startUiServer(root, { port: 0 });
  t.after(() => server.close());
  assert.ok(server.url.startsWith("http://127.0.0.1:"), server.url);

  const page = await fetch(server.url);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.ok(html.includes("仪表盘项目"));
  assert.ok((page.headers.get("content-security-policy") ?? "").includes("default-src 'none'"));

  const state = await (await fetch(new URL("api/state", server.url))).json() as { name: string; tasks: { total: number } };
  assert.equal(state.name, "仪表盘项目");
  assert.equal(state.tasks.total, 1);

  const health = await fetch(new URL("healthz", server.url));
  assert.equal(await health.text(), "ok");

  const missing = await fetch(new URL("nope", server.url));
  assert.equal(missing.status, 404);

  const post = await fetch(server.url, { method: "POST" });
  assert.equal(post.status, 405);
});

test("未纳管项目 fail-closed 拒绝启动", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pm-ui-empty-"));
  roots.push(root);
  await assert.rejects(startUiServer(root), /已纳管/);
});
