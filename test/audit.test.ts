import test from "node:test";
import assert from "node:assert/strict";
import { auditStructure, detectDrift, snapshotCodebase, latestSnapshot } from "../src/audit.ts";
import { loadFeatures, saveFeatures } from "../src/store.ts";
import { FeatureSchema, now } from "../src/types.ts";
import { initTestProject, lines, mkProj, rmRel, writeRel } from "./helpers.ts";

test("快照保存并被读取为最新基线", () => {
  const root = mkProj({ "src/a.ts": lines(10) });
  initTestProject(root);
  const { snapshot } = snapshotCodebase(root);
  assert.equal(snapshot.total_loc >= 10, true);
  const latest = latestSnapshot(root);
  assert.equal(latest?.file, snapshot.file);
});

test("漂移对账：功能指向不存在的文件被点名（防幻觉）", () => {
  const root = mkProj({ "src/real.ts": lines(5) });
  initTestProject(root);
  const data = loadFeatures(root);
  data.features.push(
    FeatureSchema.parse({ id: "F-001", name: "真实功能", entry_files: ["src/real.ts"], created: now(), updated: now() }),
    FeatureSchema.parse({ id: "F-002", name: "幻觉功能", entry_files: ["src/ghost.ts"], created: now(), updated: now() }),
  );
  saveFeatures(root, data);
  const drift = detectDrift(root);
  assert.equal(drift.length, 1);
  assert.equal(drift[0].id, "F-002");
  assert.deepEqual(drift[0].missing, ["src/ghost.ts"]);
  const report = auditStructure(root);
  assert.ok(report.includes("F-002") && report.includes("漂移"));
});

test("结构对账抓四类红旗：测试蒸发 / 新增 skip / 超预算文件 / 新增依赖", () => {
  const root = mkProj({
    "src/big.ts": lines(600), // 超过默认预算 500
    "src/app.ts": lines(20),
    "test/a.test.ts": "import test from 'node:test';\ntest('a', () => {});\n",
    "test/b.test.ts": "test('b', () => { assert.ok(true); });\n",
    "node_modules/junk/index.js": lines(999), // 应被忽略
    "package.json": JSON.stringify({ name: "x", dependencies: { old: "^1.0.0" } }),
  });
  initTestProject(root);
  snapshotCodebase(root); // 基线：2 个测试文件、0 个 skip

  // 恶化：删测试（1→0 个会蒸发）、给剩余测试加 skip、加依赖
  rmRel(root, "test/a.test.ts");
  writeRel(root, "test/b.test.ts", "it.skip('broken', () => {});\ntest('ok', () => { assert.ok(true); });\n");
  writeRel(root, "package.json", JSON.stringify({ name: "x", dependencies: { old: "^1.0.0", "ai-added": "^2.0.0" } }));

  const report = auditStructure(root);
  assert.ok(report.includes("测试蒸发"), "测试文件数下降被点名");
  assert.ok(report.includes("禁用/独占测试标记") || report.includes("skip"), "新增 skip 被点名");
  assert.ok(report.includes("src/big.ts"), "超预算大文件被点名");
  assert.ok(report.includes("ai-added"), "AI 新增依赖被点名");
  assert.ok(!report.includes("node_modules/junk"), "忽略目录不进报告");
});

test("未登记目录提示登记为模块", () => {
  const root = mkProj({ "src/a.ts": lines(5), "scripts/build.ts": lines(5) });
  initTestProject(root); // modules: ["src"] → scripts 未登记
  const report = auditStructure(root);
  assert.ok(report.includes("scripts"), "提示登记 scripts 模块");
});

test("非 Git 项目明确显示对账未启用", () => {
  const root = mkProj({ "src/a.ts": lines(5) });
  initTestProject(root);
  const report = auditStructure(root);
  assert.ok(report.includes("不是 Git 工作区") && report.includes("Git 对账未启用"));
});

test("git status 失败不能显示工作区一致", () => {
  const root = mkProj({ "src/a.ts": lines(5) });
  initTestProject(root);
  // 存在 .git 但不是合法仓库，稳定触发 git status 非零。
  writeRel(root, ".git/placeholder", "broken\n");
  const report = auditStructure(root);
  assert.ok(report.includes("git status 对账失败") && report.includes("fail-closed"), report);
  assert.ok(!report.includes("工作区变更与最近会话足迹一致"));
});

test("测试背书占比与空测试嫌疑", () => {
  const root = mkProj({
    "src/a.ts": lines(5),
    "test/trivial.test.ts": "test('t', () => {\n  expect(true).toBe(true);\n});\n",
  });
  initTestProject(root);
  const data = loadFeatures(root);
  data.features.push(
    FeatureSchema.parse({ id: "F-001", name: "有测试", entry_files: ["src/a.ts"], test_files: ["test/trivial.test.ts"], created: now(), updated: now() }),
    FeatureSchema.parse({ id: "F-002", name: "无测试", entry_files: ["src/a.ts"], created: now(), updated: now() }),
  );
  saveFeatures(root, data);
  const report = auditStructure(root);
  assert.ok(report.includes("空测试嫌疑") || report.includes("trivial"), "恒真断言测试被点名");
  assert.ok(report.includes("50%"), "已验证功能占比 1/2");
});
