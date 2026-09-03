#!/usr/bin/env node
/**
 * pm-mcp 字节规模基准：生成精确容量的可扫描 TypeScript 文本，分别验证结构索引、
 * watcher 重启对账，以及可选的安全/许可证内容读取覆盖。
 *
 * 20 GiB 示例：
 *   node scripts/benchmark-volume.mts --size-gib 20 --file-bytes 1048576 \
 *     --full-audit --result .pm/benchmarks/volume-20g.json
 *
 * 安全边界：只在给定的既有 temp-base 下创建随机直属子目录；不接受既有项目根，
 * 清理前校验父目录、前缀、目录类型和随机所有权标记。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { initProject } from "../src/init.ts";
import { auditStructure, snapshotCodebase } from "../src/audit.ts";
import { auditSecurity } from "../src/security.ts";
import { auditLicense } from "../src/license.ts";
import { atomicWrite } from "../src/store.ts";
import {
  aggregates,
  closeIndex,
  ensureFresh,
  freshness,
  startWatcher,
  walkRefresh,
  type WatcherHandle,
} from "../src/index-store.ts";
import { contentCacheStats, resetContentReadStats, setContentReadObserver } from "../src/search.ts";
import {
  GIB,
  OWNER_FILE,
  RESERVE_BYTES,
  RESULT_SCHEMA,
  TEMP_PREFIX,
  assertEqual,
  checkAbort,
  cleanupOwnedRoot,
  fileRel,
  freeBytes,
  indexOracle,
  makeTemplate,
  parseVolumeBenchmarkArgs,
  phaseMetrics,
  sampleHash,
  volumeBenchmarkJson,
  volumeBenchmarkUsage,
  writeTemplate,
  type CleanupResult,
  type VolumeBenchmarkOptions,
} from "./benchmark-volume-support.mts";

async function run(options: VolumeBenchmarkOptions): Promise<Record<string, unknown>> {
  const tempInfo = fs.statSync(options.tempBase);
  if (!tempInfo.isDirectory()) throw new Error(`temp-base 不是目录: ${options.tempBase}`);
  const baseReal = fs.realpathSync(options.tempBase);
  const resultPath = path.resolve(options.resultPath);
  if (fs.existsSync(resultPath)) throw new Error(`结果文件已存在，拒绝覆盖: ${resultPath}`);
  fs.mkdirSync(path.dirname(resultPath), { recursive: true });
  const initialFree = freeBytes(baseReal);
  if (initialFree < options.totalBytes + RESERVE_BYTES) {
    throw new Error(`空间不足：可用 ${initialFree}，需要目标 ${options.totalBytes} + 保留 ${RESERVE_BYTES}`);
  }

  const runId = randomUUID();
  const token = randomUUID();
  const root = fs.mkdtempSync(path.join(baseReal, TEMP_PREFIX));
  const state: Record<string, any> = {
    schema_version: RESULT_SCHEMA,
    run_id: runId,
    status: "running",
    started_at: new Date().toISOString(),
    request: {
      payload_bytes: options.totalBytes.toString(),
      payload_gib: Number(options.totalBytes) / Number(GIB),
      file_bytes: options.fileBytes,
      files: options.fileCount,
      full_audit: options.fullAudit,
    },
    environment: {
      node: process.version,
      platform: process.platform,
      release: os.release(),
      arch: process.arch,
      logical_cpus: os.cpus().length,
      total_memory_bytes: os.totalmem(),
      free_memory_at_start_bytes: os.freemem(),
      temp_base: baseReal,
      temp_volume: path.parse(baseReal).root,
      note: "warm-after-write synthetic benchmark; not a cold-disk or production workload",
    },
    paths: { fixture_root: root, result: resultPath },
    disk: { free_before_bytes: initialFree.toString(), reserve_bytes: RESERVE_BYTES.toString() },
    phases: {},
    cleanup: { attempted: false, verified: false, removed: false, detail: "pending" },
  };
  const persist = (): void => atomicWrite(resultPath, volumeBenchmarkJson(state));
  const beginReadProgress = (phase: string): (() => void) => {
    let nextProgress = GIB;
    setContentReadObserver((stats) => {
      const bytes = BigInt(stats.diskReadBytes);
      if (bytes < nextProgress && stats.diskReadFiles !== options.fileCount) return;
      const pct = Number((bytes * 10_000n) / options.totalBytes) / 100;
      console.error(`[volume-benchmark] ${phase} ${Math.min(100, pct).toFixed(2)}% (${bytes}/${options.totalBytes} bytes)`);
      state.progress = { phase, files: stats.diskReadFiles, bytes: bytes.toString(), percent: pct };
      persist();
      while (nextProgress <= bytes) nextProgress += GIB;
      checkAbort();
    });
    return () => setContentReadObserver(null);
  };
  let watcher: WatcherHandle | null = null;
  let cleanup: CleanupResult = state.cleanup;
  let failure: string | null = null;

  try {
    persist();
    fs.mkdirSync(path.join(root, ".pm"), { recursive: true });
    fs.writeFileSync(path.join(root, OWNER_FILE), token, { encoding: "utf8", flag: "wx" });
    initProject(root, { name: "pm-mcp volume benchmark", modules: ["src"], license: "MIT" });
    const template = makeTemplate(options.fileBytes);
    const expectedLoc = template.loc * options.fileCount;
    state.request.expected_loc = expectedLoc;
    state.request.loc_per_file = template.loc;
    persist();

    console.error(`[volume-benchmark] 生成 ${options.fileCount} 个文件，共 ${options.totalBytes} 字节、预期 ${expectedLoc} 行；root=${root}`);
    let startWall = performance.now();
    let startCpu = process.cpuUsage();
    let written = 0n;
    let nextProgress = GIB;
    for (let i = 0; i < options.fileCount; i += 1) {
      writeTemplate(path.join(root, fileRel(i)), template, i);
      written += BigInt(options.fileBytes);
      if (written >= nextProgress || i + 1 === options.fileCount) {
        const pct = Number((written * 10_000n) / options.totalBytes) / 100;
        console.error(`[volume-benchmark] generate ${pct.toFixed(2)}% (${written}/${options.totalBytes} bytes)`);
        state.progress = { phase: "generate", files: i + 1, bytes: written.toString(), percent: pct };
        state.disk.free_current_bytes = freeBytes(baseReal).toString();
        if (BigInt(state.disk.free_current_bytes) < RESERVE_BYTES) throw new Error("生成途中剩余空间低于 10 GiB，已停止");
        persist();
        while (nextProgress <= written) nextProgress += GIB;
        checkAbort();
      }
    }
    assertEqual(written, options.totalBytes, "生成逻辑字节");
    const freeAfterGenerate = freeBytes(baseReal);
    const allocatedDelta = initialFree - freeAfterGenerate;
    if (allocatedDelta < options.totalBytes * 9n / 10n) {
      throw new Error(`卷可用空间只减少 ${allocatedDelta}，不足目标字节的 90%；疑似稀疏/压缩/去重或并发释放空间`);
    }
    state.phases.generate = {
      ...phaseMetrics(startWall, startCpu),
      files_written: options.fileCount,
      logical_bytes_written: written.toString(),
      free_after_bytes: freeAfterGenerate.toString(),
      volume_free_delta_bytes: allocatedDelta.toString(),
    };
    persist();

    console.error("[volume-benchmark] 独立 stat 核验文件数、字节和样本哈希");
    startWall = performance.now();
    startCpu = process.cpuUsage();
    let statBytes = 0n;
    let minSize = Number.MAX_SAFE_INTEGER;
    let maxSize = 0;
    for (let i = 0; i < options.fileCount; i += 1) {
      const stat = fs.lstatSync(path.join(root, fileRel(i)));
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`非普通文件: ${fileRel(i)}`);
      minSize = Math.min(minSize, stat.size);
      maxSize = Math.max(maxSize, stat.size);
      statBytes += BigInt(stat.size);
    }
    assertEqual(statBytes, options.totalBytes, "独立 stat 总字节");
    assertEqual(minSize, options.fileBytes, "最小文件大小");
    assertEqual(maxSize, options.fileBytes, "最大文件大小");
    const sampleIndexes = [...new Set([0, Math.floor(options.fileCount / 2), options.fileCount - 1])];
    state.phases.filesystem_oracle = {
      ...phaseMetrics(startWall, startCpu),
      files: options.fileCount,
      bytes: statBytes.toString(),
      min_file_bytes: minSize,
      max_file_bytes: maxSize,
      all_below_2_mib: maxSize < 2 * 1024 * 1024,
      sample_sha256: Object.fromEntries(sampleIndexes.map((i) => [fileRel(i).replace(/\\/g, "/"), sampleHash(path.join(root, fileRel(i)))])),
    };
    persist();
    checkAbort();

    console.error("[volume-benchmark] 首次结构走查（会读取全部 payload 内容）");
    startWall = performance.now();
    startCpu = process.cpuUsage();
    const firstWalk = walkRefresh(root);
    const firstOracle = indexOracle(root);
    assertEqual(firstWalk.totalFiles, options.fileCount, "首次走查文件数");
    assertEqual(firstWalk.changed, options.fileCount, "首次走查重算数");
    assertEqual(firstWalk.hits, 0, "首次走查缓存命中");
    assertEqual(firstWalk.skippedDeep, 0, "深目录跳过数");
    assertEqual(firstOracle.files, options.fileCount, "SQLite 文件数");
    assertEqual(BigInt(firstOracle.bytes), options.totalBytes, "SQLite SUM(size)");
    assertEqual(firstOracle.loc, expectedLoc, "SQLite SUM(loc)");
    assertEqual(firstOracle.oversize, 0, "SQLite oversize");
    assertEqual(firstOracle.contentOk, options.fileCount, "SQLite content_ok");
    assertEqual(firstOracle.skip, 0, "SQLite skip markers");
    state.phases.first_structure_walk = { ...phaseMetrics(startWall, startCpu), walk: firstWalk, oracle: firstOracle, expected_loc: expectedLoc };
    persist();
    checkAbort();

    console.error("[volume-benchmark] 暖结构走查（应全部命中，不读内容）");
    startWall = performance.now();
    startCpu = process.cpuUsage();
    const warmWalk = walkRefresh(root);
    assertEqual(warmWalk.changed, 0, "暖走查重算数");
    assertEqual(warmWalk.hits, options.fileCount, "暖走查命中数");
    state.phases.warm_structure_walk = { ...phaseMetrics(startWall, startCpu), walk: warmWalk, oracle: indexOracle(root) };
    persist();

    watcher = startWatcher(root);
    if (!watcher) throw new Error("当前平台/文件系统不支持递归 watcher");
    startWall = performance.now();
    startCpu = process.cpuUsage();
    const startup = ensureFresh(root);
    if (startup.used !== "walk") throw new Error(`watcher 新会话应先走查，实际 ${startup.used}`);
    state.phases.watcher_start_reconcile = { ...phaseMetrics(startWall, startCpu), used: startup.used, oracle: indexOracle(root) };
    persist();

    if (!freshness(root).fresh) throw new Error("watcher 对账后仍不新鲜");
    startWall = performance.now();
    startCpu = process.cpuUsage();
    const structureReport = auditStructure(root, 120);
    if (!structureReport.includes("新鲜度: watcher 保鲜")) throw new Error("稳态 audit_structure 未走 watcher SQL 路径");
    state.phases.watcher_steady_audit_structure = {
      ...phaseMetrics(startWall, startCpu),
      used_watcher_sql: true,
      report_lines: structureReport.split("\n").length,
      oracle: indexOracle(root),
    };
    persist();

    startWall = performance.now();
    startCpu = process.cpuUsage();
    const snapshot = snapshotCodebase(root).snapshot;
    assertEqual(snapshot.total_files, options.fileCount, "snapshot 文件数");
    assertEqual(snapshot.total_loc, expectedLoc, "snapshot LOC");
    state.phases.snapshot = { ...phaseMetrics(startWall, startCpu), total_files: snapshot.total_files, total_loc: snapshot.total_loc };
    persist();

    console.error("[volume-benchmark] watcher 重启停机窗口对账（等量替换，保持目标容量）");
    watcher.stop();
    watcher = null;
    closeIndex(root);
    fs.rmSync(path.join(root, fileRel(0)));
    writeTemplate(path.join(root, "src", "offline-replacement.ts"), template, 9_999_999);
    watcher = startWatcher(root);
    if (!watcher) throw new Error("watcher 重启失败");
    if (freshness(root).fresh) throw new Error("watcher 重启错误信任停机前索引");
    startWall = performance.now();
    startCpu = process.cpuUsage();
    const restart = ensureFresh(root);
    assertEqual(restart.used, "walk", "watcher 重启对账路径");
    const restartOracle = indexOracle(root);
    assertEqual(restartOracle.files, options.fileCount, "重启后文件数");
    assertEqual(BigInt(restartOracle.bytes), options.totalBytes, "重启后 payload 字节");
    state.phases.watcher_restart_offline_replace = {
      ...phaseMetrics(startWall, startCpu),
      fresh_before_reconcile: false,
      used: restart.used,
      steady_after: ensureFresh(root).used,
      oracle: restartOracle,
    };
    persist();

    if (options.fullAudit) {
      console.error("[volume-benchmark] 安全内容扫描：要求实际读取满 payload 字节");
      resetContentReadStats(true);
      startWall = performance.now();
      startCpu = process.cpuUsage();
      const endSecurityProgress = beginReadProgress("security");
      let security: ReturnType<typeof auditSecurity>;
      try {
        security = auditSecurity(root);
      } finally {
        endSecurityProgress();
      }
      const securityReads = contentCacheStats();
      assertEqual(securityReads.diskReadFiles, options.fileCount, "安全扫描读取文件数");
      assertEqual(BigInt(securityReads.diskReadBytes), options.totalBytes, "安全扫描读取字节");
      assertEqual(security.openCount, 0, "安全扫描未处理发现");
      state.phases.security_content_scan = {
        ...phaseMetrics(startWall, startCpu),
        disk_read_files: securityReads.diskReadFiles,
        disk_read_bytes: String(securityReads.diskReadBytes),
        cache_hits: securityReads.cacheHits,
        open_findings: security.openCount,
        high_findings: security.highCount,
      };
      persist();
      checkAbort();

      console.error("[volume-benchmark] 许可证内容扫描：要求实际读取满 payload 字节");
      resetContentReadStats(true);
      startWall = performance.now();
      startCpu = process.cpuUsage();
      const endLicenseProgress = beginReadProgress("license");
      let license: string;
      try {
        license = auditLicense(root, 120);
      } finally {
        endLicenseProgress();
      }
      const licenseReads = contentCacheStats();
      assertEqual(licenseReads.diskReadFiles, options.fileCount, "许可证扫描读取文件数");
      assertEqual(BigInt(licenseReads.diskReadBytes), options.totalBytes, "许可证扫描读取字节");
      if (license.includes("🔴")) throw new Error("干净 fixture 出现许可证红旗");
      state.phases.license_content_scan = {
        ...phaseMetrics(startWall, startCpu),
        disk_read_files: licenseReads.diskReadFiles,
        disk_read_bytes: String(licenseReads.diskReadBytes),
        cache_hits: licenseReads.cacheHits,
        report_lines: license.split("\n").length,
      };
      persist();
    }
    checkAbort();
  } catch (error) {
    failure = (error as Error).stack ?? (error as Error).message;
    state.error = failure;
  } finally {
    console.error("[volume-benchmark] 停止 watcher、关闭 SQLite 并执行所有权校验清理");
    try {
      watcher?.stop();
    } catch {
      // 仍需继续关闭 DB 和做安全清理。
    }
    setContentReadObserver(null);
    closeIndex(root);
    cleanup = cleanupOwnedRoot(baseReal, root, token);
    state.cleanup = cleanup;
    state.disk.free_after_cleanup_bytes = freeBytes(baseReal).toString();
    state.finished_at = new Date().toISOString();
    state.status = failure === null && cleanup.verified && cleanup.removed ? "complete" : "failed";
    delete state.progress;
    persist();
  }
  return state;
}

async function main(): Promise<void> {
  let options: VolumeBenchmarkOptions | null;
  try {
    options = parseVolumeBenchmarkArgs(process.argv.slice(2));
  } catch (error) {
    console.error(volumeBenchmarkJson({ status: "rejected", error: (error as Error).message, usage: volumeBenchmarkUsage() }));
    process.exitCode = 2;
    return;
  }
  if (options === null) {
    console.log(volumeBenchmarkUsage());
    return;
  }
  try {
    const result = await run(options);
    console.log(volumeBenchmarkJson(result));
    if (result.status !== "complete") process.exitCode = 1;
  } catch (error) {
    console.error(volumeBenchmarkJson({ status: "failed-before-run", error: (error as Error).stack ?? (error as Error).message }));
    process.exitCode = 1;
  }
}

await main();
