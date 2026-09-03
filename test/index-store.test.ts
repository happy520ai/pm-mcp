/**
 * watcher 增量正确性：事件驱动的索引维护（增/改/删/新目录子树）+ 新鲜度判定 + 降级回退。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initProject } from "../src/init.ts";
import { aggregates, closeIndex, ensureFresh, freshness, getIndex, startWatcher, walkRefresh, type WatcherHandle } from "../src/index-store.ts";

function fixture(name: string, files: Record<string, string>): string {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "pm-w-"));
  process.env.PM_MCP_HOME = base + "-home";
  const root = path.join(base, name);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");
  }
  return root;
}

/** 轮询等待条件成立（事件是异步防抖的） */
async function waitFor(cond: () => boolean, ms = 6000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 120));
  }
  return cond();
}

test("watcher 事件增量：新增/修改/删除/新目录子树都反映到聚合", async () => {
  const root = fixture("watch", {
    "src/a.ts": "export const a = 1;\n",
    "src/b.ts": "export const b = 1;\nexport const b2 = 2;\n",
  });
  initProject(root, { name: "w" });
  walkRefresh(root);
  const before = aggregates(getIndex(root));
  assert.equal(before.totalFiles, 2);

  const watcher: WatcherHandle | null = startWatcher(root);
  assert.ok(watcher, "Windows 递归 watch 应可用");
  const startup = ensureFresh(root);
  assert.equal(startup.used, "walk", "新 watcher 会话必须先建立精确基线");

  // 新增
  fs.writeFileSync(path.join(root, "src/new.ts"), "export const n = 1;\n", "utf8");
  assert.ok(await waitFor(() => aggregates(getIndex(root)).totalFiles === 3), "新文件 500ms 内入索引");

  // 修改（loc 变化）
  fs.writeFileSync(path.join(root, "src/a.ts"), "export const a = 1;\n".repeat(5), "utf8");
  assert.ok(
    await waitFor(() => {
      const agg = aggregates(getIndex(root));
      const a = agg.largestFiles.find((f) => f.path === "src/a.ts");
      return a?.loc === 6;
    }),
    "修改后 loc 重算",
  );

  // 删除
  fs.rmSync(path.join(root, "src/b.ts"));
  assert.ok(await waitFor(() => aggregates(getIndex(root)).totalFiles === 2), "删除后行移除");

  // 新目录子树
  fs.mkdirSync(path.join(root, "pkg", "deep"), { recursive: true });
  fs.writeFileSync(path.join(root, "pkg", "deep", "x.ts"), "export const x = 1;\n", "utf8");
  assert.ok(await waitFor(() => aggregates(getIndex(root)).totalFiles === 3), "新目录子树补扫");

  // watcher 新鲜度：心跳在 90s 内、无积压 → fresh，ensureFresh 免走查
  await waitFor(() => freshness(root).fresh);
  const f = freshness(root);
  assert.equal(f.mode, "watcher");
  assert.equal(f.fresh, true);
  const used = ensureFresh(root);
  assert.equal(used.used, "watcher", "watcher 保鲜时 ensureFresh 不做全量走查");

  // 停止 → 降级为 walk 模式，ensureFresh 回退走查且数据仍正确
  watcher!.stop();
  assert.equal(freshness(root).mode, "walk");
  const used2 = ensureFresh(root);
  assert.equal(used2.used, "walk");
  assert.equal(aggregates(getIndex(root)).totalFiles, 3, "回退走查结果与事件维护一致");

  closeIndex(root);
  fs.rmSync(root, { recursive: true, force: true });
});

test("变更风暴后就地排空：ensureFresh 不回退全量走查", async () => {
  const root = fixture("storm", { "src/a.ts": "export const a = 1;\n" });
  initProject(root, { name: "storm" });
  const w = startWatcher(root);
  walkRefresh(root);
  await waitFor(() => freshness(root).fresh);
  const before = ensureFresh(root);
  assert.equal(before.used, "watcher");

  // 风暴：连写 5 个新文件后立刻审计。事件是分批送达的：已送达的在防抖队列里（pending>0），
  // 排空契约 = 处理已送达事件 + 残余由防抖定时器毫秒级收敛——两种时序都不允许回退全量走查。
  for (let i = 0; i < 5; i++) {
    fs.writeFileSync(path.join(root, `src/storm-${i}.ts`), "export const s = 1;\n", "utf8");
  }
  await new Promise((r) => setImmediate(r)); // 让首批事件送达
  const used = ensureFresh(root);
  assert.equal(used.used, "watcher", "风暴后应就地排空/等防抖收敛，绝不回退全量走查");
  assert.ok(
    await waitFor(() => aggregates(getIndex(root)).totalFiles === 6, 3000),
    "索引毫秒级收敛到 6 个文件",
  );

  w!.stop();
  closeIndex(root);
  fs.rmSync(root, { recursive: true, force: true });
});

test("watcher 重启先对账停机窗口，不能用新心跳误信旧索引", () => {
  const root = fixture("restart", {
    "src/deleted.ts": "export const deleted = 1;\n",
    "src/changed.ts": "export const changed = 1;\n",
  });
  initProject(root, { name: "restart" });

  const first = startWatcher(root);
  assert.ok(first, "Windows 递归 watch 应可用");
  assert.equal(ensureFresh(root).used, "walk", "首次 watcher 会话建立自己的走查基线");
  assert.equal(aggregates(getIndex(root)).totalFiles, 2);
  first!.stop();
  closeIndex(root);

  // 模拟服务完全停止期间的删除、修改与新增；这些变化不可能产生 watcher 事件。
  fs.rmSync(path.join(root, "src/deleted.ts"));
  fs.writeFileSync(path.join(root, "src/changed.ts"), "export const changed = 1;\n".repeat(5), "utf8");
  fs.writeFileSync(path.join(root, "src/added.ts"), "export const added = 1;\n", "utf8");

  const restarted = startWatcher(root);
  assert.ok(restarted, "watcher 应可重新启动");
  assert.equal(freshness(root).fresh, false, "新心跳不能让上次会话的旧索引变 fresh");

  const reconciled = ensureFresh(root);
  assert.equal(reconciled.used, "walk", "重启后第一次 ensureFresh 必须精确走查停机窗口");
  const after = aggregates(getIndex(root));
  assert.equal(after.totalFiles, 2, "删除与新增均已对账");
  assert.equal(after.largestFiles.find((f) => f.path === "src/changed.ts")?.loc, 6, "离线修改已重算");
  assert.equal(ensureFresh(root).used, "watcher", "完成基线后恢复稳态 watcher 快路径");

  restarted!.stop();
  closeIndex(root);
  fs.rmSync(root, { recursive: true, force: true });
});

test("强制内容走查不被相同 mtime/size 欺骗", () => {
  const root = fixture("force-content", { "src/a.ts": "a\nb\n" });
  initProject(root, { name: "force-content" });
  walkRefresh(root);
  const originalTime = fs.statSync(path.join(root, "src/a.ts")).mtime;
  assert.equal(aggregates(getIndex(root)).totalLoc, 3);

  fs.writeFileSync(path.join(root, "src/a.ts"), "abcd", "utf8");
  fs.utimesSync(path.join(root, "src/a.ts"), originalTime, originalTime);
  // NTFS/Node 时间戳往返精度可能有细微差异；把索引设为 stat 实际返回值，
  // 确定性模拟攻击者恢复了相同 size/mtime 的元数据。
  const restored = fs.statSync(path.join(root, "src/a.ts"));
  getIndex(root).prepare("UPDATE files SET mtime=?, size=? WHERE rel=?").run(restored.mtimeMs, restored.size, "src/a.ts");
  const cached = walkRefresh(root);
  assert.equal(cached.hits, 1, "普通增量走查按 mtime/size 命中缓存");
  assert.equal(aggregates(getIndex(root)).totalLoc, 3, "此对抗场景证明普通缓存无法发现内容替换");

  const forced = walkRefresh(root, { forceContent: true });
  assert.equal(forced.changed, 1);
  assert.equal(aggregates(getIndex(root)).totalLoc, 1, "独立巡检强制重读后 LOC 必须反映真实内容");
  closeIndex(root);
  fs.rmSync(root, { recursive: true, force: true });
});

test("rootPath 守卫：索引库随目录拷贝后不被信任（自动回退走查）", async () => {
  const root = fixture("guard", { "src/a.ts": "export const a = 1;\n" });
  initProject(root, { name: "g" });
  const w = startWatcher(root);
  walkRefresh(root);
  await waitFor(() => freshness(root).fresh);
  assert.equal(freshness(root).fresh, true);

  // 整目录拷贝（含 index.db 与新鲜心跳）——旧库属于原路径，副本不得信任
  const copy = root + "-copy";
  fs.cpSync(root, copy, { recursive: true });
  closeIndex(root); // 释放原库句柄，让拷贝可读
  const f2 = freshness(copy);
  assert.equal(f2.fresh, false, "副本的 watcher 心跳/索引不得被信任");
  const used = ensureFresh(copy);
  assert.equal(used.used, "walk", "副本回退全量走查重建自己的索引");
  assert.ok(used.freshness.files >= 1);

  w?.stop();
  closeIndex(copy);
  closeIndex(root);
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(copy, { recursive: true, force: true });
});
