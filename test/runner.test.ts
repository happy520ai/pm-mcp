/**
 * 定时巡检脚本测试：健康项目退出 0；红旗项目退出 1；--tasks/--add-task 登记通道可用。
 * 脚本按真实方式 spawn（node 子进程），验证 CI/定时器的实际行为。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { initProject } from "../src/init.ts";
import { latestSnapshot } from "../src/audit.ts";
import { closeIndex, getIndex, setMeta } from "../src/index-store.ts";
import { loadFeatures, saveFeatures } from "../src/store.ts";
import { FeatureSchema, now } from "../src/types.ts";

const runner = path.resolve("scripts/health-check.mts");

function mkProject(name: string, files: Record<string, string> = {}): string {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "pm-hc-"));
  process.env.PM_MCP_HOME = base + "-home";
  const root = path.join(base, name);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");
  }
  return root;
}

function run(args: string[]): { code: number; out: string } {
  const r = spawnSync(process.execPath, [runner, ...args], { encoding: "utf8", timeout: 120_000, env: { ...process.env } });
  return { code: r.status ?? -1, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

test("健康项目：巡检退出 0，报告含全部小节", () => {
  const root = mkProject("healthy", { "src/app.ts": "export const a = 1;\n" });
  initProject(root, { name: "健康项目", license: "MIT", modules: ["src"] });
  const r = run(["--root", root]);
  assert.equal(r.code, 0, r.out.slice(-400));
  assert.ok(r.out.includes("账本完整性"));
  assert.ok(r.out.includes("巡检索引基线") && r.out.includes("独立精确走查"));
  assert.ok(r.out.includes("漂移对账"));
  assert.ok(r.out.includes("安全体检"));
  assert.ok(r.out.includes("许可证审计"));
  assert.ok(r.out.includes("无红旗"));
});

test("红旗项目：高危密钥 + 漂移 + 巨文件 → 退出 1 并点名", () => {
  const root = mkProject("risky", {
    "src/leak.ts": `export const K = "${"AKIA" + "IOSFODNN7EXAMPLE"}";\n`,
    "src/monster.ts": "export const x = 1;\n".repeat(150_000),
  });
  initProject(root, { name: "红旗项目", license: "MIT", modules: ["src"] });
  // 登记一个指向不存在文件的功能 → 漂移红旗
  const data = loadFeatures(root);
  data.features.push(FeatureSchema.parse({ id: "F-001", name: "幻觉功能", entry_files: ["src/ghost.ts"], created: now(), updated: now() }));
  saveFeatures(root, data);
  const r = run(["--root", root]);
  assert.equal(r.code, 1, "有红旗必须退出 1（CI 门禁语义）");
  assert.ok(r.out.includes("AKIA") || r.out.includes("高危"), "密钥被点名");
  assert.ok(r.out.includes("F-001"), "漂移被点名");
  assert.ok(r.out.includes("monster.ts"), "巨文件被点名");
});

test("增量门禁：先对比旧快照，审计成功后才推进基线", () => {
  const root = mkProject("delta", {
    "src/app.ts": "export const a = 1;\n",
    "test/a.test.ts": "test('a', () => { assert.equal(1, 1); });\n",
    "test/b.test.ts": "test('b', () => { assert.equal(2, 2); });\n",
    "package.json": JSON.stringify({ name: "delta", dependencies: { old: "^1.0.0" } }),
  });
  initProject(root, { name: "增量项目", license: "MIT", modules: ["src", "test"] });

  const baseline = run(["--root", root]);
  assert.equal(baseline.code, 0, baseline.out.slice(-600));
  assert.equal(latestSnapshot(root)?.test_files, 2, "首次成功巡检应建立基线");

  fs.rmSync(path.join(root, "test/a.test.ts"));
  fs.writeFileSync(path.join(root, "test/b.test.ts"), "it." + "skip('broken', () => {});\ntest('b', () => { assert.equal(2, 2); });\n", "utf8");
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "delta", dependencies: { old: "^1.0.0", "ai-added": "^2.0.0" } }),
    "utf8",
  );
  // 本测试只验证巡检编排；删掉可重建缓存，避免依赖 watcher 的独立新鲜度语义。
  fs.rmSync(path.join(root, ".pm/index.db"), { force: true });
  fs.rmSync(path.join(root, ".pm/index.db-shm"), { force: true });
  fs.rmSync(path.join(root, ".pm/index.db-wal"), { force: true });

  const changed = run(["--root", root]);
  assert.equal(changed.code, 1, changed.out.slice(-800));
  assert.ok(changed.out.includes("测试蒸发"), "必须用旧快照发现测试文件下降");
  assert.ok(changed.out.includes("禁用/独占测试标记"), "必须用旧快照发现新增 skip");
  assert.ok(changed.out.includes("ai-added"), "必须用旧快照发现新增依赖");
  assert.equal(latestSnapshot(root)?.test_files, 2, "有硬红旗时不得用坏状态覆盖绿灯基线");
  assert.equal(latestSnapshot(root)?.skip_markers, 0);

  const repeated = run(["--root", root]);
  assert.equal(repeated.code, 1, "未修复的同一坏状态不得在第二次巡检时假绿");
  assert.ok(repeated.out.includes("测试蒸发") && repeated.out.includes("禁用/独占测试标记"));

  fs.writeFileSync(path.join(root, "test/a.test.ts"), "test('a', () => { assert.equal(1, 1); });\n", "utf8");
  fs.writeFileSync(path.join(root, "test/b.test.ts"), "test('b', () => { assert.equal(2, 2); });\n", "utf8");
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "delta", dependencies: { old: "^1.0.0" } }), "utf8");
  const resolved = run(["--root", root]);
  assert.equal(resolved.code, 0, resolved.out.slice(-800));
  assert.equal(latestSnapshot(root)?.test_files, 2, "修复并转绿后才推进基线");
  assert.equal(latestSnapshot(root)?.skip_markers, 0);
});

test("公网项目：未处理的中危发现也会阻断 CI", () => {
  const root = mkProject("public-medium", { "src/app.ts": "export const run = (input: string) => e" + "val(input);\n" });
  initProject(root, { name: "公网项目", exposure: "public", license: "MIT", modules: ["src"] });
  const r = run(["--root", root]);
  assert.equal(r.code, 1, r.out);
  assert.ok(r.out.includes("公网项目中危及以上未处理 1 个"), r.out.slice(-800));
});

test("独立巡检强制走查，不信任外部进程遗留的新鲜心跳", () => {
  const root = mkProject("stale-heartbeat", { "src/a.ts": "export const a = 1;\n" });
  initProject(root, { name: "心跳项目", license: "MIT", modules: ["src"] });
  const baseline = run(["--root", root]);
  assert.equal(baseline.code, 0, baseline.out);
  const baselineFiles = latestSnapshot(root)?.total_files;
  assert.ok(baselineFiles !== undefined);

  // 模拟另一个 MCP 进程在停止前留下仍处于 90 秒窗口内的心跳；新增文件发生在其停机后。
  const db = getIndex(root);
  setMeta(db, "mode", "watcher");
  setMeta(db, "rootPath", path.resolve(root));
  setMeta(db, "watcherSession", "dead-session");
  setMeta(db, "lastWalkSession", "dead-session");
  setMeta(db, "lastBeat", new Date().toISOString());
  setMeta(db, "pending", "0");
  closeIndex(root);
  fs.writeFileSync(path.join(root, "src/offline.ts"), "export const offline = 1;\n", "utf8");

  const checked = run(["--root", root]);
  assert.equal(checked.code, 0, checked.out);
  assert.equal(latestSnapshot(root)?.total_files, baselineFiles + 1, "巡检必须把停机期间新增文件纳入精确基线");
});

test("fail-closed：目标缺失或账本损坏时退出 1，且不写快照", () => {
  const missing = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pm-hc-missing-")), "gone");
  const absent = run(["--root", missing]);
  assert.equal(absent.code, 1, absent.out);
  assert.ok(absent.out.includes("fail-closed") && absent.out.includes(".pm 缺失"), absent.out);
  assert.ok(absent.out.includes("巡检失败 1 个"), absent.out);

  const root = mkProject("corrupt", { "src/app.ts": "export const a = 1;\n" });
  initProject(root, { name: "损坏项目", license: "MIT", modules: ["src"] });
  fs.writeFileSync(path.join(root, ".pm/tasks.json"), "{not-json", "utf8");
  const corrupt = run(["--root", root]);
  assert.equal(corrupt.code, 1, corrupt.out);
  assert.ok(corrupt.out.includes("巡检失败") && corrupt.out.includes("JSON 解析失败"), corrupt.out);
  assert.equal(latestSnapshot(root), null, "巡检未完整成功不得推进快照");
});

test("fail-closed：无显式目标且注册表为空时退出 1", () => {
  process.env.PM_MCP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "pm-hc-empty-home-"));
  const r = run([]);
  assert.equal(r.code, 1, r.out);
  assert.ok(r.out.includes("注册表为空"), r.out);
});

test("登记通道：--add-task 走账本锁，--tasks 可见", () => {
  const root = mkProject("reg", { "src/a.ts": "export const a = 1;\n" });
  initProject(root, { name: "登记", modules: ["src"] });
  const add = run(["--add-task", root, "[巡检] 发现测试问题", "fix"]);
  assert.equal(add.code, 0, add.out);
  assert.ok(add.out.includes("已登记任务"));
  const list = run(["--tasks", root]);
  assert.ok(list.out.includes("[巡检] 发现测试问题"));
  assert.ok(list.out.includes("(fix)"));
  // 空标题报用法错误
  const bad = run(["--add-task", root]);
  assert.notEqual(bad.code, 0);
});
