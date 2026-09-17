import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initProject } from "../src/init.ts";
import { fingerprintProject } from "../src/project-fingerprint.ts";
import { saveQualityRun } from "../src/quality-store.ts";
import { runQualityPlan } from "../src/language-adapters.ts";

/** 建临时项目目录（含 fixture 文件），并把全局注册表重定向到临时家目录，避免污染真实注册表 */
export function mkProj(files: Record<string, string> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pm-test-"));
  process.env.PM_MCP_HOME = dir + "-home";
  for (const [rel, content] of Object.entries(files)) {
    write(root0(dir, rel), content);
  }
  return dir;
}

function root0(dir: string, rel: string): string {
  return path.join(dir, rel);
}

export function write(abs: string, content: string): void {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

export function writeRel(root: string, rel: string, content: string): void {
  write(path.join(root, rel), content);
}

export function readRel(root: string, rel: string): string {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

export function existsRel(root: string, rel: string): boolean {
  return fs.existsSync(path.join(root, rel));
}

export function rmRel(root: string, rel: string): void {
  fs.rmSync(path.join(root, rel), { force: true });
}

export function initTestProject(root: string): void {
  initProject(root, { name: "测试项目", modules: ["src"], license: "MIT" });
}

/** 合成质量报告仅用于已有工具参数/状态测试的夹具；真实执行另由 management-upgrade 覆盖。 */
export function qualityEvidenceFixture(root: string): string {
  const source = fingerprintProject(root);
  return saveQualityRun(root, { execute: true, ok: true, results: [{
    command: { command: process.execPath, args: ["--test", "fixture-only"], cwd: root, kind: "test", requiredExecutable: process.execPath, timeoutMs: 10000, maxOutputBytes: 65536 },
    status: "passed", exitCode: 0, signal: null, durationMs: 1, truncated: false,
    stdout: "ℹ tests 1\nℹ pass 1\nℹ fail 0\nℹ skipped 0\nℹ cancelled 0\nℹ todo 0", stderr: "",
  }] }, { source_before: source, source_after: source });
}

/** 端到端场景执行真实测试，再由生产报告器绑定前后源码摘要。 */
export async function runFixtureTestEvidence(root: string, testFile: string): Promise<string> {
  const before = fingerprintProject(root);
  const result = await runQualityPlan([{
    command: process.execPath, args: ["--test", testFile], cwd: root, kind: "test",
    requiredExecutable: process.execPath, timeoutMs: 10000, maxOutputBytes: 65536,
  }], { execute: true });
  if (!result.ok) throw new Error(`场景测试执行失败: ${result.results[0]?.stderr}`);
  return saveQualityRun(root, result, { source_before: before, source_after: fingerprintProject(root) });
}

/** 生成 n 行文本 */
export function lines(n: number, fill = "export const x = 1;"): string {
  return Array.from({ length: n }, () => fill).join("\n") + "\n";
}
