import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { fingerprintProject } from "./project-fingerprint.ts";
import { changedGitFiles, projectFilePath } from "./git-state.ts";
import { SCAN_IGNORE_DIRS, ignoreMatcher, projectScanIgnores } from "./scan-policy.ts";
import { loadProject } from "./store.ts";
import { evidenceLevel, weakestEvidence } from "./quality-evidence.ts";

const fingerprint = z.object({ algorithm: z.literal("sha256-tree-v1"), sha256: z.string().regex(/^[a-f0-9]{64}$/) });
const count = z.number().int().nonnegative().nullable();
const reportSchema = z.object({
  schema_version: z.literal(2), run_at: z.string().datetime(), ok: z.boolean(), execute: z.boolean(),
  source: z.object({ before: fingerprint, after: fingerprint, stable: z.boolean() }).nullable(),
  results: z.array(z.object({
    unit_root: z.string(), kind: z.string(), command: z.string().min(1), args: z.array(z.string()),
    status: z.string(), exit_code: z.number().nullable(), signal: z.string().nullable(), output_truncated: z.boolean(),
    output_summary: z.object({ tests: count, passed: count.optional(), failed: count, skipped: count, cancelled: count, todo: count, coverage: z.unknown().optional() }),
  })).min(1),
});

/** 只读取当前项目内生成的质量报告；链接、损坏和旧格式不冒充证据。 */
export function verifiedTaskEvidence(root: string, requested?: string, files: string[] = []): string {
  const absolute = fs.realpathSync.native(path.resolve(root));
  const anchors = files.map(projectFilePath);
  if (anchors.length === 0) throw new Error("完成开发/修复任务需要通过 files 关联实际实现或测试文件。");
  const excluded = ignoreMatcher(projectScanIgnores(root));
  for (const rel of anchors) {
    const parts = rel.split("/");
    if (rel === "PROJECT.md" || parts.some((part, index) =>
      (index < parts.length - 1 && SCAN_IGNORE_DIRS.has(part)) || excluded(parts.slice(0, index + 1).join("/"), index < parts.length - 1))) {
      throw new Error(`任务文件不在源码验证范围内: ${rel}`);
    }
    for (let index = 0; index < parts.length; index++) {
      const target = path.join(absolute, ...parts.slice(0, index + 1));
      let stat: fs.Stats;
      try { stat = fs.lstatSync(target); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        if (!changedGitFiles(absolute).includes(rel)) throw new Error(`任务关联文件不存在，也没有 Git 删除记录: ${rel}`);
        break;
      }
      if (stat.isSymbolicLink() || (index === parts.length - 1 ? !stat.isFile() : !stat.isDirectory())) {
        throw new Error(`任务必须关联项目内的普通文件，禁止链接或目录: ${rel}`);
      }
    }
  }
  const directory = path.join(absolute, ".pm", "quality-runs");
  for (const part of [path.join(absolute, ".pm"), directory]) {
    if (!fs.existsSync(part)) throw new Error("完成开发/修复任务前请执行 run_quality_matrix，缺少质量验证报告。");
    const stat = fs.lstatSync(part);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("质量证据目录必须是项目内的普通目录。");
  }
  const reports = fs.readdirSync(directory).filter((name) => /^quality-.*\.json$/.test(name)).map((name) => {
    const file = path.join(directory, name);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024) throw new Error("质量证据必须是有界普通文件，禁止符号链接。");
    const raw = fs.readFileSync(file, "utf8");
    const value: unknown = JSON.parse(raw);
    const header = z.object({ run_at: z.string().datetime() }).safeParse(value);
    if (!header.success) throw new Error(`质量报告 ${name} 缺少有效生成时间，无法判断新鲜度。`);
    return { relative: `.pm/quality-runs/${name}`, raw, value, runAt: header.data.run_at };
  }).sort((a, b) => b.runAt.localeCompare(a.runAt) || b.relative.localeCompare(a.relative));
  const latest = reports[0];
  if (!latest) throw new Error("缺少质量验证报告，请先执行 run_quality_matrix。");
  if (requested !== undefined && projectFilePath(requested) !== latest.relative) throw new Error("必须使用最新质量报告，不能绕过后来出现的验证结果。");
  const parsed = reportSchema.safeParse(latest.value);
  if (!parsed.success) throw new Error("最新质量报告无效或格式过旧，请重新执行验证。");
  const report = parsed.data;
  if (!report.ok || !report.execute || !report.source?.stable || report.source.before.sha256 !== report.source.after.sha256 ||
    report.results.some((item) => item.status !== "passed" || item.exit_code !== 0 || item.signal !== null || item.output_truncated ||
      [item.output_summary.failed, item.output_summary.skipped, item.output_summary.cancelled, item.output_summary.todo].some((n) => n !== null && n > 0))) {
    throw new Error("最新质量验证失败、未执行、输出不完整或存在跳过项，不能标记完成。");
  }
  const tests = report.results.filter((item) => item.kind === "test" || item.kind === "coverage");
  if (tests.length === 0 || tests.some((item) => item.output_summary.tests === 0)) throw new Error("完成开发/修复任务需要实际测试或覆盖率执行证据。");
  const level = weakestEvidence(tests.map((item) => evidenceLevel(item.kind, item.output_summary, item.output_truncated)));
  const policy = loadProject(root).completion_evidence;
  if (level === "execution_only" && policy?.minimum !== "execution_only") {
    throw new Error("仅有命令执行证据，未观察到完整测试计数。默认完成策略要求 tests_observed；请使用可识别的测试摘要，或由项目负责人明确设置兼容策略并说明理由。");
  }
  const within = (base: string, target: string) => {
    const relative = path.relative(base, target);
    return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  };
  if (tests.some((item) => !path.isAbsolute(item.unit_root))) throw new Error("质量报告的执行目录不属于当前项目。");
  const unitRoots = tests.map((item) => fs.realpathSync.native(item.unit_root));
  if (unitRoots.some((unit) => !within(absolute, unit))) throw new Error("质量报告的执行目录不属于当前项目。");
  if (anchors.some((file) => !unitRoots.some((unit) => within(unit, path.join(absolute, file))))) {
    throw new Error("质量报告的测试单元未覆盖任务关联文件所在目录。");
  }
  const current = fingerprintProject(absolute);
  if (current.sha256 !== report.source.after.sha256) throw new Error("质量验证对应的源码已变化，证据过期，请重新验证。");
  const digest = createHash("sha256").update(latest.raw).digest("hex");
  return `质量报告: ${latest.relative}\n报告 SHA-256: ${digest}\n源码 SHA-256: ${current.sha256}\n执行时间: ${report.run_at}\n证据等级: ${level}${policy ? `\n项目策略: ${policy.minimum}；${policy.reason}` : "\n项目策略: tests_observed（默认）"}`;
}
