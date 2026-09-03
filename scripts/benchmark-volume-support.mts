import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { getIndex } from "../src/index-store.ts";

const KIB = 1024n;
const MIB = 1024n * KIB;
export const GIB = 1024n * MIB;
const DEFAULT_GIB = 20n;
const DEFAULT_FILE_BYTES = 1024 * 1024;
const MAX_SCANNABLE_FILE_BYTES = 2 * 1024 * 1024;
const MAX_FILES = 1_000_000;
export const RESERVE_BYTES = 10n * GIB;
export const TEMP_PREFIX = "pm-mcp-volume-";
export const OWNER_FILE = path.join(".pm", "volume-benchmark-owner");
export const RESULT_SCHEMA = 1;

export interface VolumeBenchmarkOptions {
  totalBytes: bigint;
  fileBytes: number;
  fileCount: number;
  tempBase: string;
  resultPath: string;
  fullAudit: boolean;
}

export interface CleanupResult {
  attempted: boolean;
  verified: boolean;
  removed: boolean;
  detail: string;
}

export interface IndexOracle {
  files: number;
  bytes: number;
  loc: number;
  oversize: number;
  contentOk: number;
  skip: number;
}

let abortRequested: string | null = null;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    abortRequested = signal;
    console.error(`[volume-benchmark] 收到 ${signal}，将在当前同步步骤结束后安全清理。`);
  });
}

export function volumeBenchmarkUsage(): string {
  return [
    "用法: node scripts/benchmark-volume.mts [选项]",
    "  --size-gib N       总容量（整数 GiB，默认 20）",
    "  --size-mib N       小规模冒烟容量（整数 MiB；与 --size-gib 互斥）",
    "  --file-bytes N     单文件字节数（默认 1048576，必须 < 2 MiB）",
    "  --temp-base PATH   已存在的临时父目录（默认当前用户 os.tmpdir()）",
    "  --result PATH      持久化 JSON（默认 .pm/benchmarks/volume-<run>.json）",
    "  --full-audit       另跑安全与许可证内容扫描，并核对各自读取满目标字节",
  ].join("\n");
}

function positiveInteger(text: string | undefined, name: string): bigint {
  if (!text || !/^[1-9]\d*$/.test(text)) throw new Error(`${name} 必须是正整数`);
  return BigInt(text);
}

function valueAfter(args: string[], index: number, name: string): string {
  const value = args[index + 1];
  if (!value) throw new Error(`${name} 缺少值`);
  return value;
}

export function parseVolumeBenchmarkArgs(args: string[]): VolumeBenchmarkOptions | null {
  let sizeGib: bigint | undefined;
  let sizeMib: bigint | undefined;
  let fileBytes = DEFAULT_FILE_BYTES;
  let tempBase = os.tmpdir();
  let resultPath: string | undefined;
  let fullAudit = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") return null;
    if (arg === "--full-audit") {
      fullAudit = true;
      continue;
    }
    if (arg === "--size-gib") {
      sizeGib = positiveInteger(valueAfter(args, i, arg), arg);
      i += 1;
      continue;
    }
    if (arg === "--size-mib") {
      sizeMib = positiveInteger(valueAfter(args, i, arg), arg);
      i += 1;
      continue;
    }
    if (arg === "--file-bytes") {
      const parsed = positiveInteger(valueAfter(args, i, arg), arg);
      if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("--file-bytes 超出安全整数范围");
      fileBytes = Number(parsed);
      i += 1;
      continue;
    }
    if (arg === "--temp-base") {
      tempBase = valueAfter(args, i, arg);
      i += 1;
      continue;
    }
    if (arg === "--result") {
      resultPath = valueAfter(args, i, arg);
      i += 1;
      continue;
    }
    throw new Error(`未知参数: ${arg}`);
  }
  if (sizeGib !== undefined && sizeMib !== undefined) throw new Error("--size-gib 与 --size-mib 不能同时使用");
  if (fileBytes < 4096 || fileBytes >= MAX_SCANNABLE_FILE_BYTES) {
    throw new Error(`--file-bytes 必须在 4096..${MAX_SCANNABLE_FILE_BYTES - 1} 之间，确保内容不会进入 oversize 跳过路径`);
  }
  const totalBytes = sizeMib !== undefined ? sizeMib * MIB : (sizeGib ?? DEFAULT_GIB) * GIB;
  if (totalBytes % BigInt(fileBytes) !== 0n) {
    throw new Error(`目标字节 ${totalBytes} 不能被单文件字节 ${fileBytes} 整除；拒绝悄悄多写或少写`);
  }
  const countBig = totalBytes / BigInt(fileBytes);
  if (countBig > BigInt(MAX_FILES)) throw new Error(`文件数 ${countBig} 超过上限 ${MAX_FILES}`);
  const fileCount = Number(countBig);
  const run = `${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`;
  return {
    totalBytes,
    fileBytes,
    fileCount,
    tempBase: path.resolve(tempBase),
    resultPath: path.resolve(resultPath ?? path.join(".pm", "benchmarks", `volume-${run}.json`)),
    fullAudit,
  };
}

export function volumeBenchmarkJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item, 2) + "\n";
}

export function freeBytes(dir: string): bigint {
  const stats = fs.statfsSync(dir, { bigint: true });
  return stats.bavail * stats.bsize;
}

export function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) throw new Error(`${message}：期望 ${String(expected)}，实际 ${String(actual)}`);
}

export function checkAbort(): void {
  if (abortRequested) throw new Error(`测试被 ${abortRequested} 中断`);
}

export function phaseMetrics(startWall: number, startCpu: NodeJS.CpuUsage): Record<string, number> {
  const cpu = process.cpuUsage(startCpu);
  return {
    duration_ms: Number((performance.now() - startWall).toFixed(3)),
    cpu_user_ms: Number((cpu.user / 1000).toFixed(3)),
    cpu_system_ms: Number((cpu.system / 1000).toFixed(3)),
    rss_after_bytes: process.memoryUsage().rss,
    max_rss_kib: process.resourceUsage().maxRSS,
  };
}

export function fileRel(index: number): string {
  const digits = String(index).padStart(7, "0");
  const moduleNo = String(Math.floor(index / 250)).padStart(5, "0");
  return path.join("src", `module-${moduleNo}`, `file-${digits}.ts`);
}

export function makeTemplate(fileBytes: number): { buffer: Buffer; markerOffset: number; loc: number } {
  const buffer = Buffer.alloc(fileBytes, 0x20);
  const headerText = "export function synthetic_0000000(seed: number): number {\n  let value = seed;\n";
  const bodyText = "  value = Math.imul(value ^ 0x45d9f3b, 2654435761) >>> 0; // source-row\n";
  const footerText = "  return value;\n}\n";
  const header = Buffer.from(headerText, "ascii");
  const body = Buffer.from(bodyText, "ascii");
  const footer = Buffer.from(footerText, "ascii");
  if (header.length + body.length + footer.length > fileBytes) throw new Error("单文件大小不足以容纳 TypeScript 模板");
  header.copy(buffer, 0);
  const footerStart = fileBytes - footer.length;
  let offset = header.length;
  while (offset + body.length <= footerStart) {
    body.copy(buffer, offset);
    offset += body.length;
  }
  footer.copy(buffer, footerStart);
  let newlines = 0;
  for (const byte of buffer) if (byte === 0x0a) newlines += 1;
  return { buffer, markerOffset: headerText.indexOf("0000000"), loc: newlines + 1 };
}

export function writeTemplate(file: string, template: { buffer: Buffer; markerOffset: number }, index: number): void {
  const digits = String(index).padStart(7, "0");
  template.buffer.write(digits, template.markerOffset, 7, "ascii");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, template.buffer, { flag: "wx" });
}

export function indexOracle(root: string): IndexOracle {
  return getIndex(root).prepare(
    `SELECT COUNT(*) files, COALESCE(SUM(size),0) bytes, COALESCE(SUM(loc),0) loc,
            COALESCE(SUM(oversize),0) oversize, COALESCE(SUM(content_ok),0) contentOk,
            COALESCE(SUM(skip),0) skip
       FROM files WHERE root1='src'`,
  ).get() as unknown as IndexOracle;
}

export function sampleHash(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

export function cleanupOwnedRoot(baseReal: string, root: string, token: string): CleanupResult {
  if (!fs.existsSync(root)) return { attempted: false, verified: true, removed: true, detail: "临时目录已不存在" };
  try {
    const rootReal = fs.realpathSync(root);
    const relative = path.relative(baseReal, rootReal);
    const directChild = relative.length > 0 && !relative.includes(path.sep) && !relative.startsWith("..") && !path.isAbsolute(relative);
    const info = fs.lstatSync(rootReal);
    const marker = fs.readFileSync(path.join(rootReal, OWNER_FILE), "utf8");
    if (!directChild || !path.basename(rootReal).startsWith(TEMP_PREFIX) || !info.isDirectory() || info.isSymbolicLink() || marker !== token) {
      return { attempted: false, verified: false, removed: false, detail: `所有权校验失败，拒绝删除 ${rootReal}` };
    }
    fs.rmSync(rootReal, { recursive: true, force: false, maxRetries: 8, retryDelay: 250 });
    return { attempted: true, verified: true, removed: !fs.existsSync(rootReal), detail: `已删除 ${rootReal}` };
  } catch (error) {
    return { attempted: true, verified: false, removed: false, detail: `安全清理失败: ${(error as Error).message}` };
  }
}
