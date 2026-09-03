#!/usr/bin/env node
/**
 * pm-mcp 可复跑基准：只在系统临时目录生成合成项目，校验索引正确性并测量关键路径。
 *
 *   node scripts/benchmark.mts             # 默认 1,000 个文件
 *   node scripts/benchmark.mts --files N   # 显式指定 1..1,000,000
 *
 * 本脚本不接受项目根参数。清理前会同时校验临时目录位置、名称和随机所有权标记；
 * 校验失败时宁可保留临时目录并报错，也不会递归删除未经确认的路径。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { initProject } from "../src/init.ts";
import { auditStructure, snapshotCodebase } from "../src/audit.ts";
import {
  aggregates,
  closeIndex,
  ensureFresh,
  freshness,
  getIndex,
  startWatcher,
  walkRefresh,
  type WatcherHandle,
} from "../src/index-store.ts";

const DEFAULT_FILES = 1_000;
const MAX_FILES = 1_000_000;
const TEMP_PREFIX = "pm-mcp-benchmark-";
const OWNER_FILE = path.join(".pm", "benchmark-owner");

interface CountCheck {
  expected: number;
  actual: number;
  passed: true;
}

interface CleanupResult {
  attempted: boolean;
  removed: boolean;
  verified: boolean;
  detail: string;
}

function usage(): string {
  return [
    "用法: node scripts/benchmark.mts [--files N]",
    `默认 ${DEFAULT_FILES.toLocaleString("en-US")} 个文件；允许范围 1..${MAX_FILES.toLocaleString("en-US")}。`,
    "脚本不接受项目根路径，只使用并清理自己在系统临时目录创建的目录。",
  ].join("\n");
}

function parseArgs(args: string[]): { files: number; help: boolean } {
  let rawFiles: string | undefined;
  let help = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (arg === "--files") {
      if (rawFiles !== undefined) throw new Error("--files 只能指定一次");
      rawFiles = args[i + 1];
      if (rawFiles === undefined) throw new Error("--files 缺少数量");
      i += 1;
      continue;
    }
    if (arg.startsWith("--files=")) {
      if (rawFiles !== undefined) throw new Error("--files 只能指定一次");
      rawFiles = arg.slice("--files=".length);
      continue;
    }
    throw new Error(`未知参数: ${arg}`);
  }

  const text = rawFiles ?? String(DEFAULT_FILES);
  if (!/^[1-9]\d*$/.test(text)) throw new Error("--files 必须是正整数");
  const files = Number(text);
  if (!Number.isSafeInteger(files) || files > MAX_FILES) {
    throw new Error(`--files 必须在 1..${MAX_FILES.toLocaleString("en-US")} 之间`);
  }
  return { files, help };
}

function elapsedMs(start: number): number {
  return Number((performance.now() - start).toFixed(3));
}

function rate(count: number, durationMs: number): number {
  if (durationMs <= 0) return 0;
  return Math.round((count * 1_000) / durationMs);
}

function indexedFiles(root: string): number {
  const row = getIndex(root).prepare("SELECT COUNT(*) AS count FROM files").get() as { count: number };
  return row.count;
}

function checkIndexCount(root: string, expected: number, phase: string): CountCheck {
  const actual = indexedFiles(root);
  if (actual !== expected) {
    throw new Error(`${phase}: 索引文件数错误，期望 ${expected}，实际 ${actual}`);
  }
  return { expected, actual, passed: true };
}

function writeFixtureFiles(root: string, count: number): number {
  let written = 0;
  let currentDir = "";
  for (let i = 0; i < count; i += 1) {
    const moduleNo = Math.floor(i / 250);
    const dir = path.join(root, "src", `module-${String(moduleNo).padStart(5, "0")}`);
    if (dir !== currentDir) {
      fs.mkdirSync(dir, { recursive: true });
      currentDir = dir;
    }
    const name = `file-${String(i).padStart(7, "0")}.ts`;
    fs.writeFileSync(
      path.join(dir, name),
      `export const value_${i} = ${i};\nexport function get_${i}(): number { return value_${i}; }\n`,
      "utf8",
    );
    written += 1;
  }
  return written;
}

function cleanupOwnedRoot(root: string, ownerToken: string): CleanupResult {
  if (!fs.existsSync(root)) {
    return { attempted: false, removed: true, verified: true, detail: "临时目录已不存在" };
  }
  try {
    const tempReal = fs.realpathSync(os.tmpdir());
    const rootReal = fs.realpathSync(root);
    const relative = path.relative(tempReal, rootReal);
    const directChild =
      relative.length > 0 &&
      !relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative) &&
      !relative.includes(path.sep);
    const expectedName = path.basename(rootReal).startsWith(TEMP_PREFIX);
    const marker = fs.readFileSync(path.join(rootReal, OWNER_FILE), "utf8");
    if (!directChild || !expectedName || marker !== ownerToken) {
      return {
        attempted: false,
        removed: false,
        verified: false,
        detail: "所有权校验失败，已拒绝删除临时目录",
      };
    }
    fs.rmSync(rootReal, { recursive: true, force: false });
    const removed = !fs.existsSync(rootReal);
    return {
      attempted: true,
      removed,
      verified: true,
      detail: removed ? "已删除经所有权校验的临时目录" : "删除后目录仍存在",
    };
  } catch (error) {
    return {
      attempted: false,
      removed: false,
      verified: false,
      detail: `安全清理失败: ${(error as Error).message}`,
    };
  }
}

async function runBenchmark(fileCount: number): Promise<Record<string, unknown>> {
  const startedAt = new Date().toISOString();
  const ownerToken = randomUUID();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX));
  const phases: Record<string, unknown> = {};
  let watcher: WatcherHandle | null = null;
  let failure: string | null = null;
  let cleanup: CleanupResult = {
    attempted: false,
    removed: false,
    verified: false,
    detail: "尚未执行清理",
  };

  // 所有权标记先于其他工作落盘；它位于扫描器忽略的 .pm 内，不影响文件计数。
  fs.mkdirSync(path.join(root, ".pm"), { recursive: true });
  fs.writeFileSync(path.join(root, OWNER_FILE), ownerToken, "utf8");

  try {
    initProject(root, { name: "pm-mcp benchmark", modules: ["src"], license: "MIT" });

    let start = performance.now();
    const written = writeFixtureFiles(root, fileCount);
    const generateMs = elapsedMs(start);
    if (written !== fileCount) throw new Error(`生成阶段文件数错误，期望 ${fileCount}，实际 ${written}`);
    const preWalkIndex = checkIndexCount(root, 0, "生成阶段（首次走查前）");
    phases.generate = {
      duration_ms: generateMs,
      files_written: written,
      files_per_second: rate(written, generateMs),
      pre_walk_index: preWalkIndex,
    };

    start = performance.now();
    const firstWalk = walkRefresh(root);
    const firstWalkMs = elapsedMs(start);
    phases.first_exact_walk = {
      duration_ms: firstWalkMs,
      files_per_second: rate(fileCount, firstWalkMs),
      walk: firstWalk,
      index_count: checkIndexCount(root, fileCount, "首次精确走查"),
    };

    watcher = startWatcher(root);
    if (!watcher) throw new Error("当前平台或文件系统不支持递归 watcher，无法完成 watcher 基准");
    start = performance.now();
    const startupReconcile = ensureFresh(root);
    const startupReconcileMs = elapsedMs(start);
    if (startupReconcile.used !== "walk" || !startupReconcile.freshness.fresh) {
      throw new Error("watcher 新会话未通过精确走查建立可信基线");
    }
    phases.watcher_start_reconcile = {
      duration_ms: startupReconcileMs,
      required_path: startupReconcile.used,
      index_count: checkIndexCount(root, fileCount, "watcher 启动对账"),
    };

    if (!freshness(root).fresh) throw new Error("稳态 audit 前 watcher 索引不新鲜");
    start = performance.now();
    const audit = auditStructure(root, 120);
    const auditMs = elapsedMs(start);
    const auditUsedWatcher = audit.includes("新鲜度: watcher 保鲜");
    if (!auditUsedWatcher || !freshness(root).fresh) {
      throw new Error("audit_structure 未使用 watcher 稳态快路径");
    }
    phases.watcher_steady_audit_structure = {
      duration_ms: auditMs,
      indexed_files_per_second: rate(fileCount, auditMs),
      used_watcher: true,
      report_lines: audit.split("\n").length,
      index_count: checkIndexCount(root, fileCount, "watcher 稳态 audit_structure"),
    };

    start = performance.now();
    const snap = snapshotCodebase(root).snapshot;
    const snapshotMs = elapsedMs(start);
    const snapshotIndexCheck = checkIndexCount(root, fileCount, "snapshot");
    if (snap.total_files !== fileCount) {
      throw new Error(`snapshot 文件数错误，期望 ${fileCount}，实际 ${snap.total_files}`);
    }
    phases.snapshot = {
      duration_ms: snapshotMs,
      indexed_files_per_second: rate(fileCount, snapshotMs),
      snapshot_total_files: snap.total_files,
      snapshot_file: snap.file,
      index_count: snapshotIndexCheck,
    };

    // 模拟服务完全停止后发生的变更：新 watcher 的即时心跳不得把旧索引误判为新鲜。
    watcher.stop();
    watcher = null;
    closeIndex(root);
    const offlineRel = path.join(root, "src", "offline-added-after-stop.ts");
    fs.writeFileSync(offlineRel, "export const addedWhileStopped = true;\n", "utf8");
    const expectedAfterRestart = fileCount + 1;

    watcher = startWatcher(root);
    if (!watcher) throw new Error("watcher 重启失败");
    const freshBeforeReconcile = freshness(root).fresh;
    if (freshBeforeReconcile) throw new Error("watcher 重启后错误地信任了停机前索引");
    start = performance.now();
    const restartReconcile = ensureFresh(root);
    const restartMs = elapsedMs(start);
    if (restartReconcile.used !== "walk") {
      throw new Error(`watcher 重启对账错误地使用了 ${restartReconcile.used} 路径`);
    }
    const restartCount = checkIndexCount(root, expectedAfterRestart, "watcher 重启停机变更对账");
    const aggregateCount = aggregates(getIndex(root)).totalFiles;
    if (aggregateCount !== expectedAfterRestart) {
      throw new Error(`watcher 重启后聚合文件数错误，期望 ${expectedAfterRestart}，实际 ${aggregateCount}`);
    }
    const steadyAfterRestart = ensureFresh(root).used;
    if (steadyAfterRestart !== "watcher") {
      throw new Error("重启对账完成后未恢复 watcher 稳态快路径");
    }
    phases.watcher_restart_offline_add = {
      duration_ms: restartMs,
      fresh_before_reconcile: freshBeforeReconcile,
      required_reconcile_path: restartReconcile.used,
      steady_path_after_reconcile: steadyAfterRestart,
      offline_files_added: 1,
      index_count: restartCount,
      aggregate_total_files: aggregateCount,
      correctness_passed: true,
    };
  } catch (error) {
    failure = (error as Error).stack ?? (error as Error).message;
  } finally {
    try {
      watcher?.stop();
    } catch {
      // closeIndex 与所有权校验仍需继续执行。
    }
    closeIndex(root);
    cleanup = cleanupOwnedRoot(root, ownerToken);
  }

  const ok = failure === null && cleanup.removed && cleanup.verified;
  return {
    ok,
    benchmark: "pm-mcp synthetic index correctness/performance",
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    environment: {
      node: process.version,
      platform: process.platform,
      release: os.release(),
      arch: process.arch,
      logical_cpus: os.cpus().length,
    },
    configuration: {
      requested_files: fileCount,
      default_files: DEFAULT_FILES,
      max_files: MAX_FILES,
      data: "synthetic temporary files",
    },
    phases,
    cleanup,
    ...(failure ? { error: failure } : {}),
    ...(!cleanup.removed ? { cleanup_error: cleanup.detail } : {}),
  };
}

async function main(): Promise<void> {
  let parsed: { files: number; help: boolean };
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: (error as Error).message, usage: usage() }, null, 2));
    process.exitCode = 2;
    return;
  }
  if (parsed.help) {
    console.log(usage());
    return;
  }
  const result = await runBenchmark(parsed.files);
  console.log(JSON.stringify(result, null, 2));
  if (result.ok !== true) process.exitCode = 1;
}

await main();
