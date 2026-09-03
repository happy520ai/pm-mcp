import { createHash } from "node:crypto";
import { z } from "zod";

export const SEMANTIC_EVIDENCE_SCHEMA_VERSION = 1 as const;

export const SemanticAssuranceSchema = z.enum(["heuristic", "ast", "runtime"]);
export const SemanticAnalyzerFamilySchema = z.enum([
  "compiler-ast",
  "language-native-ast",
  "structured-parser",
  "runtime-trace",
  "regex-fallback",
]);
export const SemanticCapabilitySchema = z.enum(["imports", "exports", "calls", "contracts", "http", "grpc", "ffi"]);
export const SemanticReferenceKindSchema = z.enum(["import", "export", "call", "contract", "http", "grpc", "ffi"]);

export const AnalyzerProvenanceSchema = z.object({
  id: z.string().trim().min(1),
  family: SemanticAnalyzerFamilySchema,
  assurance: SemanticAssuranceSchema,
  engine: z.string().trim().min(1),
  version: z.string().trim().min(1),
  capabilities: z.array(SemanticCapabilitySchema).min(1),
  /** Optional reproducibility detail. It must never contain source text or credentials. */
  command: z.string().trim().min(1).optional(),
}).superRefine((analyzer, ctx) => {
  const expected = analyzer.family === "runtime-trace"
    ? "runtime"
    : analyzer.family === "regex-fallback"
      ? "heuristic"
      : "ast";
  if (analyzer.assurance !== expected) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["assurance"], message: `${analyzer.family} requires assurance=${expected}` });
  }
});

const EvidenceReferenceSchema = z.object({
  kind: SemanticReferenceKindSchema,
  specifier: z.string().trim().min(1),
  line: z.number().int().positive(),
  confidence: z.number().min(0).max(1),
  force_local: z.boolean().default(false),
  symbol: z.string().trim().min(1).optional(),
});

const EvidenceExportSchema = z.object({
  name: z.string().trim().min(1),
  line: z.number().int().positive(),
  is_type_only: z.boolean().default(false),
  source_specifier: z.string().trim().min(1).optional(),
  confidence: z.number().min(0).max(1),
});

/**
 * Portable interchange format for compiler/native-AST analyzers and runtime tracers.
 * A content hash binds every claim to the exact source bytes that were analyzed.
 */
export const SemanticEvidenceDocumentSchema = z.object({
  schema_version: z.literal(SEMANTIC_EVIDENCE_SCHEMA_VERSION),
  file: z.string().trim().min(1),
  language: z.string().trim().min(1),
  content_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  generated_at: z.string().datetime({ offset: true }),
  status: z.enum(["complete", "partial"]),
  analyzer: AnalyzerProvenanceSchema,
  references: z.array(EvidenceReferenceSchema).default([]),
  exports: z.array(EvidenceExportSchema).default([]),
  diagnostics: z.array(z.string()).default([]),
}).superRefine((document, ctx) => {
  const provided = new Set(document.analyzer.capabilities);
  for (const [index, reference] of document.references.entries()) {
    const capability = reference.kind === "import" || reference.kind === "export" || reference.kind === "call" || reference.kind === "contract"
      ? `${reference.kind}s`
      : reference.kind;
    if (!provided.has(capability as z.infer<typeof SemanticCapabilitySchema>)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["references", index, "kind"], message: `reference requires analyzer capability ${capability}` });
    }
  }
  if (document.exports.length > 0 && !provided.has("exports")) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["exports"], message: "exports require analyzer capability exports" });
  }
});

export type SemanticAssurance = z.infer<typeof SemanticAssuranceSchema>;
export type SemanticAnalyzerFamily = z.infer<typeof SemanticAnalyzerFamilySchema>;
export type SemanticCapability = z.infer<typeof SemanticCapabilitySchema>;
export type AnalyzerProvenance = z.infer<typeof AnalyzerProvenanceSchema>;
export type SemanticEvidenceDocument = z.infer<typeof SemanticEvidenceDocumentSchema>;
export type EvidenceReference = z.infer<typeof EvidenceReferenceSchema>;
export type EvidenceExport = z.infer<typeof EvidenceExportSchema>;

export interface SemanticExportRecord {
  name: string;
  line: number;
  isTypeOnly: boolean;
  sourceSpecifier?: string;
  parser: string;
  confidence: number;
}

export interface EvidenceVerification {
  ok: boolean;
  document?: SemanticEvidenceDocument;
  errors: string[];
}

export function semanticContentHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function evidencePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

/** Parse and bind imported evidence to one exact repository-relative file and source revision. */
export function verifySemanticEvidence(input: unknown, expectedFile: string, content: string): EvidenceVerification {
  const parsed = SemanticEvidenceDocumentSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map((issue) => `${issue.path.join(".") || "document"}: ${issue.message}`) };
  }
  const errors: string[] = [];
  const expected = evidencePath(expectedFile);
  if (evidencePath(parsed.data.file) !== expected) errors.push(`file mismatch: expected ${expected}, received ${parsed.data.file}`);
  const actualHash = semanticContentHash(content);
  if (parsed.data.content_sha256 !== actualHash) errors.push(`content hash mismatch for ${expected}`);
  return errors.length === 0 ? { ok: true, document: parsed.data, errors: [] } : { ok: false, errors };
}

export function assuranceRank(value: SemanticAssurance): number {
  return value === "runtime" ? 3 : value === "ast" ? 2 : 1;
}
