import fs from "node:fs";
import path from "node:path";
import { pmPath } from "./paths.ts";
import { atomicWrite, withLedgerLock } from "./store.ts";
import { SemanticEvidenceDocumentSchema, type SemanticEvidenceDocument } from "./semantic-evidence.ts";

export const SEMANTIC_EVIDENCE_DIR = "semantic-evidence";
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

export interface SemanticEvidenceSummary {
  id: string;
  file: string;
  language: string;
  analyzer: string;
  assurance: SemanticEvidenceDocument["analyzer"]["assurance"];
  status: SemanticEvidenceDocument["status"];
  generated_at: string;
  content_sha256: string;
}

export function validateSemanticEvidenceId(id: string): string {
  if (id !== id.trim() || !SAFE_ID.test(id) || id.endsWith(".") || WINDOWS_DEVICE.test(id)) {
    throw new Error(`非法语义证据 ID: ${JSON.stringify(id)}；仅允许 1-128 位 ASCII 字母、数字、点、下划线和连字符，且不得使用路径或 Windows 设备名`);
  }
  return id;
}

export function semanticEvidenceDir(root: string): string {
  return pmPath(path.resolve(root), SEMANTIC_EVIDENCE_DIR);
}

function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function assertRealDirectoryWithinRoot(root: string, directory: string, create: boolean): void {
  const absoluteRoot = path.resolve(root);
  if (!fs.existsSync(absoluteRoot) || !fs.statSync(absoluteRoot).isDirectory()) throw new Error(`项目根目录不存在或不是目录: ${absoluteRoot}`);
  if (create) fs.mkdirSync(directory, { recursive: true });
  if (!fs.existsSync(directory)) return;
  const realRoot = fs.realpathSync.native(absoluteRoot);
  const realDirectory = fs.realpathSync.native(directory);
  if (!isWithin(realRoot, realDirectory)) throw new Error(`语义证据目录逃逸项目根目录: ${directory}`);
}

export function semanticEvidencePath(root: string, id: string): string {
  const safeId = validateSemanticEvidenceId(id);
  const directory = semanticEvidenceDir(root);
  const file = path.resolve(directory, `${safeId}.json`);
  if (!isWithin(path.resolve(directory), file)) throw new Error(`语义证据路径逃逸: ${id}`);
  return file;
}

function parseDocument(file: string): SemanticEvidenceDocument {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`语义证据 JSON 解析失败: ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = SemanticEvidenceDocumentSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`语义证据 schema 校验失败: ${file}: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "document"}: ${issue.message}`).join("; ")}`);
  }
  return parsed.data;
}

function assertRegularEvidenceFile(root: string, file: string): void {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`语义证据必须是普通文件，拒绝符号链接或目录: ${file}`);
  const realRoot = fs.realpathSync.native(path.resolve(root));
  const realFile = fs.realpathSync.native(file);
  if (!isWithin(realRoot, realFile)) throw new Error(`语义证据文件逃逸项目根目录: ${file}`);
}

function evidenceIdsUnlocked(root: string): string[] {
  const directory = semanticEvidenceDir(root);
  assertRealDirectoryWithinRoot(root, directory, false);
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.name.endsWith(".json"))
    .map((entry) => {
      if (!entry.isFile() || entry.isSymbolicLink()) throw new Error(`语义证据目录包含非普通 JSON 文件: ${entry.name}`);
      return validateSemanticEvidenceId(entry.name.slice(0, -".json".length));
    })
    .sort((a, b) => a.localeCompare(b));
}

function loadUnlocked(root: string, id: string): SemanticEvidenceDocument {
  const file = semanticEvidencePath(root, id);
  const directory = semanticEvidenceDir(root);
  assertRealDirectoryWithinRoot(root, directory, false);
  if (!fs.existsSync(file)) throw new Error(`语义证据不存在: ${id}`);
  assertRegularEvidenceFile(root, file);
  return parseDocument(file);
}

/** Validate first, then atomically replace one evidence document under the project ledger lock. */
export function saveSemanticEvidence(root: string, id: string, input: unknown): SemanticEvidenceDocument {
  const safeId = validateSemanticEvidenceId(id);
  const parsed = SemanticEvidenceDocumentSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(`语义证据 schema 校验失败: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "document"}: ${issue.message}`).join("; ")}`);
  }
  const absoluteRoot = path.resolve(root);
  const directory = semanticEvidenceDir(absoluteRoot);
  assertRealDirectoryWithinRoot(absoluteRoot, directory, true);
  return withLedgerLock(absoluteRoot, () => {
    assertRealDirectoryWithinRoot(absoluteRoot, directory, false);
    atomicWrite(semanticEvidencePath(absoluteRoot, safeId), `${JSON.stringify(parsed.data, null, 2)}\n`);
    return parsed.data;
  });
}

export function loadSemanticEvidence(root: string, id: string): SemanticEvidenceDocument {
  return loadUnlocked(path.resolve(root), validateSemanticEvidenceId(id));
}

/** List is schema-validating: a corrupt document makes the operation fail closed. */
export function listSemanticEvidence(root: string): SemanticEvidenceSummary[] {
  const absoluteRoot = path.resolve(root);
  return evidenceIdsUnlocked(absoluteRoot).map((id) => {
    const document = loadUnlocked(absoluteRoot, id);
    return {
      id,
      file: document.file,
      language: document.language,
      analyzer: document.analyzer.id,
      assurance: document.analyzer.assurance,
      status: document.status,
      generated_at: document.generated_at,
      content_sha256: document.content_sha256,
    };
  });
}

/** Load a consistent, validated snapshot; no corrupt document is silently skipped. */
export function loadAllSemanticEvidence(root: string): SemanticEvidenceDocument[] {
  const absoluteRoot = path.resolve(root);
  const directory = semanticEvidenceDir(absoluteRoot);
  assertRealDirectoryWithinRoot(absoluteRoot, directory, false);
  if (!fs.existsSync(directory)) return [];
  return withLedgerLock(absoluteRoot, () => evidenceIdsUnlocked(absoluteRoot).map((id) => loadUnlocked(absoluteRoot, id)));
}
