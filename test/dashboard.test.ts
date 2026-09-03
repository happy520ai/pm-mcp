import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { buildChangelog, buildDashboard } from "../src/dashboard.ts";
import { loadFeatures, loadRoadmap, loadSessions, loadTasks, saveFeatures, saveRoadmap, saveSessions, saveTasks } from "../src/store.ts";
import { FeatureSchema, MilestoneSchema, SessionSchema, TaskSchema, now } from "../src/types.ts";
import { initTestProject, mkProj } from "./helpers.ts";

function seed(root: string): void {
  const roadmap = loadRoadmap(root);
  roadmap.milestones.push(MilestoneSchema.parse({ id: "M1", title: "MVP", status: "active", created: now(), updated: now() }));
  saveRoadmap(root, roadmap);

  const tasks = loadTasks(root);
  tasks.tasks.push(
    TaskSchema.parse({ id: "T-001", title: "用户登录", status: "in_progress", milestone: "M1", created: now(), updated: now() }),
  );
  tasks.tasks[0].checkpoint = { note: "表单完成", next_step: "接后端接口", at: now() };
  saveTasks(root, tasks);

  const features = loadFeatures(root);
  features.features.push(
    FeatureSchema.parse({ id: "F-001", name: "登录页", entry_files: ["src/login.ts"], created: now(), updated: now() }),
    FeatureSchema.parse({ id: "F-002", name: "幻觉页", entry_files: ["src/ghost.ts"], created: now(), updated: now() }),
  );
  saveFeatures(root, features);

  const sessions = loadSessions(root);
  sessions.sessions.push(SessionSchema.parse({ id: "S-0001", date: now(), author: "zcode", summary: "搭好登录表单", files: ["src/login.ts"] }));
  saveSessions(root, sessions);
}

test("仪表盘包含路线图/焦点/健康/功能验证状态/会话", () => {
  const root = mkProj({ "src/login.ts": "export const login = 1;\n" });
  initTestProject(root);
  seed(root);
  const md = buildDashboard(root);
  assert.ok(md.includes("# 测试项目"));
  assert.ok(md.includes("## 🗺️ 路线图"));
  assert.ok(md.includes("M1"));
  assert.ok(md.includes("下一步: 接后端接口"), "断点在焦点区可见");
  assert.ok(md.includes("⚠️ 漂移"), "幻觉功能标 ⚠️");
  assert.ok(md.includes("✅"), "真实功能标 ✅ 或提示无测试");
  assert.ok(md.includes("zcode"), "会话署名");
  assert.ok(md.includes("自动生成"));
});

test("changelog 由 sessions 生成且含改动文件", () => {
  const root = mkProj({ "src/login.ts": "export const login = 1;\n" });
  initTestProject(root);
  seed(root);
  const md = buildChangelog(root);
  assert.ok(md.includes("搭好登录表单"));
  assert.ok(md.includes("src/login.ts"));
});

test("仪表盘按报告生成时间选择最新验收，不依赖 checkout 后的文件 mtime", () => {
  const root = mkProj({ "src/login.ts": "export const login = 1;\n" });
  initTestProject(root);
  const reports = path.join(root, ".pm", "acceptance", "reports");
  fs.mkdirSync(reports, { recursive: true });
  const summary = { errors: 0, requirements_passed: 1, requirements_total: 1 };
  const oldFile = path.join(reports, "report-old.json");
  const newFile = path.join(reports, "report-new.json");
  fs.writeFileSync(oldFile, JSON.stringify({ report_generated_at: "2026-01-01T00:00:00.000Z", verdict: "accepted", summary }));
  fs.writeFileSync(newFile, JSON.stringify({ report_generated_at: "2026-02-01T00:00:00.000Z", verdict: "accepted", summary }));
  const sameMtime = new Date("2026-03-01T00:00:00.000Z");
  fs.utimesSync(oldFile, sameMtime, sameMtime);
  fs.utimesSync(newFile, sameMtime, sameMtime);

  const md = buildDashboard(root);
  assert.ok(md.includes("2026-02-01 00:00"), "应选择报告内容中生成时间最新的一份");
  assert.ok(!md.includes("2026-01-01 00:00"));
});
