import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z, type ZodType } from "zod";
import {
  AcceptanceBaselineSchema,
  AcceptanceEvaluationSchema,
  JsonPointerSchema,
  acceptanceBaselinePath,
  loadAcceptanceBaseline,
  saveAcceptanceBaseline,
  type AcceptanceBaseline,
  type AcceptanceEvaluation,
  type MachineAssertion,
} from "./acceptance-model.ts";
import { acceptanceBaselineFingerprint, evaluateAcceptance } from "./acceptance-evaluator.ts";
import { writeAcceptanceReport, type AcceptanceReport } from "./acceptance-report.ts";
import { requireInitialized } from "./paths.ts";
import { loadJson, saveJson, withLedgerLock } from "./store.ts";
import { toolI, toolR } from "./tool-base.ts";
import { refreshDerived } from "./dashboard.ts";

const IdSchema = z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const SemVerSchema = z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/);
const JsonPathSchema = z.string().trim().min(1).max(1_000);
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/i);

export interface AcceptanceBaselineSummary {
  id: string;
  version: string;
  title: string;
  status: AcceptanceBaseline["approval"]["status"];
  fingerprint_sha256: string;
  requirements: number;
  risks: number;
  tests: number;
  file: string;
}

function inside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export function acceptanceDataRoot(root: string): string {
  return path.resolve(root, ".pm", "acceptance");
}

/** Resolve an existing ordinary file without permitting lexical or symlink escape. */
export function resolveAcceptanceFile(root: string, locator: string, requireJson = false): string {
  const projectRoot = path.resolve(root);
  const allowedRoot = acceptanceDataRoot(projectRoot);
  const candidate = path.resolve(projectRoot, locator);
  if (!inside(allowedRoot, candidate)) throw new Error(`路径必须位于项目内 .pm/acceptance：${locator}`);
  if (requireJson && path.extname(candidate).toLowerCase() !== ".json") throw new Error(`只允许读取 JSON 文件：${locator}`);
  if (!fs.existsSync(allowedRoot)) throw new Error(`验收目录不存在：${allowedRoot}`);
  if (!fs.existsSync(candidate)) throw new Error(`文件不存在：${locator}`);
  if (fs.lstatSync(candidate).isSymbolicLink()) throw new Error(`不允许使用符号链接作为验收文件：${locator}`);
  const realAllowedRoot = fs.realpathSync(allowedRoot);
  const realCandidate = fs.realpathSync(candidate);
  if (!inside(realAllowedRoot, realCandidate)) throw new Error(`文件真实路径逃逸 .pm/acceptance：${locator}`);
  if (!fs.statSync(realCandidate).isFile()) throw new Error(`验收路径必须是普通文件：${locator}`);
  return realCandidate;
}

export function readAcceptanceJson<T>(root: string, locator: string, schema: ZodType<T>): T {
  const file = resolveAcceptanceFile(root, locator, true);
  const parsed = loadJson(file, schema);
  if (parsed === undefined) throw new Error(`文件不存在：${locator}`);
  return parsed;
}

export function sha256AcceptanceFile(file: string): string {
  const digest = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const handle = fs.openSync(file, "r");
  try {
    const before = fs.fstatSync(handle);
    let offset = 0;
    while (offset < before.size) {
      const read = fs.readSync(handle, buffer, 0, Math.min(buffer.length, before.size - offset), offset);
      if (read === 0) break;
      digest.update(buffer.subarray(0, read));
      offset += read;
    }
    const after = fs.fstatSync(handle);
    if (offset !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      throw new Error(`证据文件在摘要计算期间发生变化：${file}`);
    }
    return digest.digest("hex");
  } finally {
    fs.closeSync(handle);
  }
}

export function verifyEvaluationEvidence(root: string, evaluation: AcceptanceEvaluation): void {
  for (const evidence of evaluation.evidence) {
    const file = resolveAcceptanceFile(root, evidence.locator, false);
    const actual = sha256AcceptanceFile(file);
    if (actual.toLowerCase() !== evidence.sha256.toLowerCase()) {
      throw new Error(`证据摘要不一致：${evidence.id} 声明 ${evidence.sha256}，实际 ${actual}`);
    }
  }
}

const FORBIDDEN_POINTER_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);

/** Safe RFC 6901 resolver: own properties only, canonical array indexes only. */
export function resolveJsonPointer(document: unknown, pointerInput: string): unknown {
  const pointer = JsonPointerSchema.parse(pointerInput);
  if (pointer === "") return document;
  let current: unknown = document;
  for (const encoded of pointer.slice(1).split("/")) {
    const token = encoded.replace(/~1/g, "/").replace(/~0/g, "~");
    if (FORBIDDEN_POINTER_SEGMENTS.has(token)) throw new Error(`JSON Pointer 包含禁止字段：${token}`);
    if (Array.isArray(current)) {
      if (!/^(0|[1-9]\d*)$/.test(token)) throw new Error(`JSON Pointer 数组索引非法：${token}`);
      const index = Number(token);
      if (!Number.isSafeInteger(index) || index >= current.length) throw new Error(`JSON Pointer 数组越界：${token}`);
      current = current[index];
      continue;
    }
    if (current !== null && typeof current === "object") {
      if (!Object.prototype.hasOwnProperty.call(current, token)) throw new Error(`JSON Pointer 字段不存在：${token}`);
      current = (current as Record<string, unknown>)[token];
      continue;
    }
    throw new Error(`JSON Pointer 无法继续解析：${token}`);
  }
  return current;
}

function readVerifiedJsonEvidence(root: string, evidence: AcceptanceEvaluation["evidence"][number]): unknown {
  const file = resolveAcceptanceFile(root, evidence.locator, false);
  const bytes = fs.readFileSync(file);
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest.toLowerCase() !== evidence.sha256.toLowerCase()) {
    throw new Error(`证据摘要不一致：${evidence.id} 声明 ${evidence.sha256}，实际 ${digest}`);
  }
  try {
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch (error) {
    throw new Error(`机器断言证据不是合法 JSON：${evidence.id}: ${(error as Error).message}`);
  }
}

function machineAssertionPassed(actual: unknown, assertion: MachineAssertion): boolean {
  if (assertion.operator === "at_least" || assertion.operator === "at_most") {
    if (typeof actual !== "number" || !Number.isFinite(actual) || typeof assertion.expected !== "number") {
      throw new Error(`${assertion.operator} 断言的实际值和期望值必须是有限数字`);
    }
    return assertion.operator === "at_least" ? actual >= assertion.expected : actual <= assertion.expected;
  }
  const equal = Object.is(actual, assertion.expected);
  return assertion.operator === "equal" ? equal : !equal;
}

/**
 * Reconstruct observed values and automated test outcomes from the approved
 * baseline's frozen JSON evidence pointers. Evaluation fields are assertions
 * about evidence, never an alternative source of truth.
 */
export function verifyFrozenAcceptanceAssertions(
  root: string,
  baseline: AcceptanceBaseline,
  evaluation: AcceptanceEvaluation,
): void {
  const evidenceById = new Map(evaluation.evidence.map((item) => [item.id, item]));
  const measurementById = new Map(evaluation.measurements.map((item) => [item.requirement_id, item]));
  const testResultById = new Map(evaluation.test_results.map((item) => [item.test_id, item]));
  const documents = new Map<string, unknown>();
  const documentFor = (evidenceId: string): unknown => {
    const evidence = evidenceById.get(evidenceId);
    if (!evidence) throw new Error(`基线冻结的机器证据不存在：${evidenceId}`);
    if (!documents.has(evidenceId)) documents.set(evidenceId, readVerifiedJsonEvidence(root, evidence));
    return documents.get(evidenceId);
  };

  for (const requirement of baseline.requirements) {
    const measurement = measurementById.get(requirement.id);
    if (!measurement) throw new Error(`缺少基线需求的测量结果：${requirement.id}`);
    const source = requirement.measurement_source;
    if (!measurement.evidence_ids.includes(source.evidence_id)) {
      throw new Error(`测量 ${requirement.id} 未引用冻结证据 ${source.evidence_id}`);
    }
    const actual = resolveJsonPointer(documentFor(source.evidence_id), source.json_pointer);
    if (typeof actual !== "number" || !Number.isFinite(actual)) {
      throw new Error(`测量源 ${requirement.id}${source.json_pointer} 不是有限数字`);
    }
    if (!Object.is(actual, measurement.observed_value)) {
      throw new Error(`伪造或过期测量值：${requirement.id} 填写 ${measurement.observed_value}，证据实际 ${actual}`);
    }
  }

  for (const definition of baseline.tests) {
    if (definition.verification_mode === "manual") continue;
    const assertion = definition.assertion!;
    const result = testResultById.get(definition.id);
    if (!result) throw new Error(`缺少基线测试结果：${definition.id}`);
    if (!result.evidence_ids.includes(assertion.evidence_id)) {
      throw new Error(`测试 ${definition.id} 未引用冻结断言证据 ${assertion.evidence_id}`);
    }
    const actual = resolveJsonPointer(documentFor(assertion.evidence_id), assertion.json_pointer);
    const passed = machineAssertionPassed(actual, assertion);
    const expectedStatus = passed ? "passed" : "failed";
    if (result.status !== expectedStatus) {
      throw new Error(`伪造或不一致测试状态：${definition.id} 填写 ${result.status}，机器断言结果为 ${expectedStatus}`);
    }
  }
}

export function listAcceptanceBaselines(root: string): AcceptanceBaselineSummary[] {
  const base = path.join(acceptanceDataRoot(root), "baselines");
  if (!fs.existsSync(base)) return [];
  const summaries: AcceptanceBaselineSummary[] = [];
  for (const idEntry of fs.readdirSync(base, { withFileTypes: true })) {
    if (!idEntry.isDirectory() || idEntry.isSymbolicLink()) continue;
    const id = IdSchema.parse(idEntry.name);
    const idDir = path.join(base, idEntry.name);
    for (const versionEntry of fs.readdirSync(idDir, { withFileTypes: true })) {
      if (!versionEntry.isFile() || path.extname(versionEntry.name).toLowerCase() !== ".json") continue;
      const version = SemVerSchema.parse(path.basename(versionEntry.name, ".json"));
      const value = loadAcceptanceBaseline(root, id, version);
      summaries.push({
        id: value.baseline_id,
        version: value.baseline_version,
        title: value.title,
        status: value.approval.status,
        fingerprint_sha256: acceptanceBaselineFingerprint(value),
        requirements: value.requirements.length,
        risks: value.risks.length,
        tests: value.tests.length,
        file: path.relative(path.resolve(root), acceptanceBaselinePath(root, id, version)).replace(/\\/g, "/"),
      });
    }
  }
  return summaries.sort((left, right) => `${left.id}@${left.version}`.localeCompare(`${right.id}@${right.version}`, "en"));
}

export function saveDraftAcceptanceBaselineFile(root: string, locator: string): AcceptanceBaseline {
  const baseline = readAcceptanceJson(root, locator, AcceptanceBaselineSchema);
  if (baseline.approval.status !== "draft") throw new Error("save_acceptance_baseline_draft 只接受 approval.status=draft 的基线。");
  return saveAcceptanceBaseline(root, baseline);
}

export interface ApproveAcceptanceBaselineInput {
  baseline_id: string;
  baseline_version: string;
  expected_fingerprint_sha256: string;
  approved_by: string;
  approval_rationale: string;
  approved_at?: string;
}

/** Atomic compare-fingerprint-and-approve transaction; never nests the model lock. */
export function approveAcceptanceBaseline(root: string, input: ApproveAcceptanceBaselineInput): AcceptanceBaseline {
  const parsed = {
    baseline_id: IdSchema.parse(input.baseline_id),
    baseline_version: SemVerSchema.parse(input.baseline_version),
    expected_fingerprint_sha256: Sha256Schema.parse(input.expected_fingerprint_sha256).toLowerCase(),
    approved_by: z.string().trim().min(1).parse(input.approved_by),
    approval_rationale: z.string().trim().min(8).parse(input.approval_rationale),
    approved_at: input.approved_at ? z.string().datetime({ offset: true }).parse(input.approved_at) : new Date().toISOString(),
  };
  return withLedgerLock(path.resolve(root), () => {
    const current = loadAcceptanceBaseline(root, parsed.baseline_id, parsed.baseline_version);
    if (current.approval.status !== "draft") throw new Error(`只有 draft 基线可批准；当前状态为 ${current.approval.status}。`);
    const fingerprint = acceptanceBaselineFingerprint(current);
    if (fingerprint.toLowerCase() !== parsed.expected_fingerprint_sha256) {
      throw new Error(`基线 fingerprint 已变化：期望 ${parsed.expected_fingerprint_sha256}，当前 ${fingerprint}；请重新审阅，修改内容必须升版。`);
    }
    if (Date.parse(parsed.approved_at) < Date.parse(current.created_at)) throw new Error("批准时间不得早于基线创建时间。");
    const approved = AcceptanceBaselineSchema.parse({
      ...current,
      approval: {
        status: "approved",
        approved_by: parsed.approved_by,
        approved_at: parsed.approved_at,
        rationale: parsed.approval_rationale,
      },
    });
    saveJson(acceptanceBaselinePath(root, approved.baseline_id, approved.baseline_version), approved);
    return approved;
  });
}

export interface EvaluateAcceptanceFileInput {
  baseline_id: string;
  baseline_version: string;
  evaluation_file: string;
}

export function evaluateAcceptanceFile(
  root: string,
  input: EvaluateAcceptanceFileInput,
): { report: AcceptanceReport; json_file: string; markdown_file: string; manifest_file: string } {
  const baseline = loadAcceptanceBaseline(root, IdSchema.parse(input.baseline_id), SemVerSchema.parse(input.baseline_version));
  const evaluation = readAcceptanceJson(root, input.evaluation_file, AcceptanceEvaluationSchema);
  verifyEvaluationEvidence(root, evaluation);
  verifyFrozenAcceptanceAssertions(root, baseline, evaluation);
  const report = evaluateAcceptance(baseline, evaluation);
  const files = writeAcceptanceReport(root, report);
  refreshDerived(root);
  return { report, ...files };
}

export function registerAcceptanceTools(server: McpServer, root: string): void {
  toolR(server, root, "list_acceptance_baselines", "列出版本化验收基线、审批状态、当前 fingerprint 和规模。", {}, () => {
    requireInitialized(root);
    return JSON.stringify(listAcceptanceBaselines(root), null, 2);
  });

  toolR<{ baseline_id: string; baseline_version: string; full?: boolean }>(server, root, "get_acceptance_baseline", "读取一个验收基线；默认返回摘要，full=true 返回严格 JSON。", {
    baseline_id: IdSchema,
    baseline_version: SemVerSchema,
    full: z.boolean().optional(),
  }, (args) => {
    requireInitialized(root);
    const baseline = loadAcceptanceBaseline(root, args.baseline_id, args.baseline_version);
    if (args.full) return JSON.stringify(baseline, null, 2);
    return JSON.stringify(listAcceptanceBaselines(root).find((item) => item.id === args.baseline_id && item.version === args.baseline_version), null, 2);
  });

  toolI<{ baseline_file: string }>(server, root, "save_acceptance_baseline_draft", "从项目内 .pm/acceptance 下的严格 JSON 保存 draft 基线；批准后的同版本不可覆盖。", {
    baseline_file: JsonPathSchema,
  }, (args) => {
    requireInitialized(root);
    const baseline = saveDraftAcceptanceBaselineFile(root, args.baseline_file);
    return `✅ draft ${baseline.baseline_id}@${baseline.baseline_version} 已保存；fingerprint=${acceptanceBaselineFingerprint(baseline)}`;
  });

  toolI<ApproveAcceptanceBaselineInput>(server, root, "approve_acceptance_baseline", "按当前 SHA-256 fingerprint 原子批准基线；fingerprint 变化即拒绝，批准后修改必须升版。", {
    baseline_id: IdSchema,
    baseline_version: SemVerSchema,
    expected_fingerprint_sha256: Sha256Schema,
    approved_by: z.string().trim().min(1),
    approval_rationale: z.string().trim().min(8),
    approved_at: z.string().datetime({ offset: true }).optional(),
  }, (args) => {
    requireInitialized(root);
    const approved = approveAcceptanceBaseline(root, args);
    return `✅ baseline ${approved.baseline_id}@${approved.baseline_version} 已批准；approved fingerprint=${acceptanceBaselineFingerprint(approved)}`;
  });

  toolI<EvaluateAcceptanceFileInput>(server, root, "evaluate_acceptance", "读取项目内 .pm/acceptance evaluation JSON，逐项复算证据 SHA-256，再生成不可手填、不可覆盖的正式报告。", {
    baseline_id: IdSchema,
    baseline_version: SemVerSchema,
    evaluation_file: JsonPathSchema,
  }, (args) => {
    requireInitialized(root);
    const result = evaluateAcceptanceFile(root, args);
    const relativeJson = path.relative(path.resolve(root), result.json_file).replace(/\\/g, "/");
    const relativeMarkdown = path.relative(path.resolve(root), result.markdown_file).replace(/\\/g, "/");
    const relativeManifest = path.relative(path.resolve(root), result.manifest_file).replace(/\\/g, "/");
    return `${result.report.verdict === "accepted" ? "✅ PASS" : "🚩 FAIL"} ${result.report.report_id} · errors=${result.report.summary.errors} · JSON=${relativeJson} · Markdown=${relativeMarkdown} · SHA256=${relativeManifest}`;
  });
}
