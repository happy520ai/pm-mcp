import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { initProject } from "../src/init.ts";
import { loadProject, loadTasks, saveProject, saveTasks } from "../src/store.ts";
import { TaskSchema, now } from "../src/types.ts";
import { loadGovernance } from "../src/governance-model.ts";
import { existsRel, mkProj, readRel, writeRel } from "./helpers.ts";

test("initProject 建全状态文件且可回读", () => {
  const root = mkProj();
  initProject(root, { name: "演示", modules: ["src"], license: "MIT" });
  assert.ok(existsRel(root, ".pm/project.json"));
  assert.ok(existsRel(root, ".pm/roadmap.json"));
  assert.ok(existsRel(root, ".pm/tasks.json"));
  assert.ok(existsRel(root, ".pm/security.json"));
  assert.ok(existsRel(root, ".pm/governance.json"));
  assert.ok(fs.existsSync(path.join(root, ".pm/decisions")));
  const p = loadProject(root);
  assert.equal(p.name, "演示");
  assert.equal(p.budgets.maxFileLoc, 500, "预算默认值");
  assert.equal(loadGovernance(root).schema_version, 1);
});

test("重复 init 报错（防覆盖）", () => {
  const root = mkProj();
  initProject(root, { name: "A" });
  assert.throws(() => initProject(root, { name: "B" }), /已初始化/);
});

test("损坏数据给出可读校验错误", () => {
  const root = mkProj();
  initProject(root, { name: "A" });
  writeRel(root, ".pm/tasks.json", JSON.stringify({ seq: 1, tasks: [{ id: "T-001" }] }));
  assert.throws(() => loadTasks(root), /数据校验失败/);
});

test("原子写不残留 tmp 文件", () => {
  const root = mkProj();
  initProject(root, { name: "A" });
  const data = loadTasks(root);
  data.tasks.push(TaskSchema.parse({ id: "T-001", title: "t", created: now(), updated: now() }));
  saveTasks(root, data);
  assert.ok(!fs.existsSync(path.join(root, ".pm/tasks.json.tmp")));
  assert.equal(loadTasks(root).tasks.length, 1);
});

test("saveProject 自动刷新 updated 时间", async () => {
  const root = mkProj();
  initProject(root, { name: "A" });
  const before = loadProject(root).updated;
  await new Promise((r) => setTimeout(r, 20));
  const p = loadProject(root);
  p.phase = "MVP";
  saveProject(root, p);
  assert.ok(loadProject(root).updated > before);
});
