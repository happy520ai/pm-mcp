import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initProject } from "../src/init.ts";

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

/** 生成 n 行文本 */
export function lines(n: number, fill = "export const x = 1;"): string {
  return Array.from({ length: n }, () => fill).join("\n") + "\n";
}
