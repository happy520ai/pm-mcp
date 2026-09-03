import fs from "node:fs";
import path from "node:path";
import { isTestFile, listFiles } from "./scan.ts";
import type { GovernanceFile, ModuleSpec } from "./governance-model.ts";
import {
  SOURCE_LANGUAGE,
  UNKNOWN_SOURCE_EXTS,
  candidates,
  contractKind,
  normalizedRoot,
  analyzeSource,
  relPath,
  type RawReference,
  type SemanticKind as ParsedSemanticKind,
} from "./semantic-parsers.ts";
import {
  SemanticEvidenceDocumentSchema,
  assuranceRank,
  verifySemanticEvidence,
  type AnalyzerProvenance,
  type SemanticAssurance,
  type SemanticEvidenceDocument,
  type SemanticExportRecord,
} from "./semantic-evidence.ts";
import { computeImpactAnalysis, findModuleCycles } from "./semantic-graph-algorithms.ts";

/** Structural subset: a validated GovernanceFile is assignable, while focused callers may pass only graph fields. */
export type ModuleSpecLike = Pick<ModuleSpec, "id" | "roots"> & Partial<
  Pick<ModuleSpec, "name" | "owners" | "public_interfaces" | "depends_on" | "allowed_dependencies" | "denied_dependencies">
>;

export type SemanticPolicies = Partial<GovernanceFile["policies"]> & {
  enforce_public_interfaces?: boolean;
  minimum_coverage_pct?: number;
  /** heuristic accepts explicit regex fallback; ast/runtime fail closed without stronger evidence. */
  minimum_semantic_assurance?: SemanticAssurance;
  fail_on_semantic_fallback?: boolean;
};

export interface GovernanceFileLike {
  modules: readonly ModuleSpecLike[];
  interfaces?: readonly Pick<GovernanceFile["interfaces"][number], "id" | "provider" | "consumers" | "contract_files">[];
  policies?: SemanticPolicies;
}

export type SemanticKind = ParsedSemanticKind;
export type Resolution = "file" | "module" | "external" | "signal" | "unresolved";

export interface SemanticFile {
  path: string;
  module: string | null;
  owners: string[];
  language: string;
  parser: string;
  confidence: number;
  status: "parsed" | "partial" | "rejected" | "unknown" | "oversize" | "unreadable";
  analyzers: AnalyzerProvenance[];
  diagnostics: string[];
  exports: SemanticExportRecord[];
}

export interface FileEdge {
  from: string;
  fromModule: string | null;
  to: string | null;
  toModule: string | null;
  specifier: string;
  kind: SemanticKind;
  line: number;
  parser: string;
  confidence: number;
  symbol?: string;
  resolution: Resolution;
  /** Governance interface proved by an exact contract file or explicit interface reference. */
  interfaceId: string | null;
}

export interface ModuleEdge {
  from: string;
  to: string;
  kinds: SemanticKind[];
  files: string[];
  confidence: number;
  declared: boolean;
}

export interface DependencyViolation {
  type: "denied-dependency" | "not-allowed-dependency" | "undeclared-dependency" | "private-interface" | "unowned-file" | "unresolved-reference" | "coverage-below-policy" | "semantic-evidence-below-policy" | "semantic-evidence-invalid";
  from: string;
  to: string;
  evidence: string[];
}

export interface SemanticGraph {
  analysis: {
    parser: "hybrid-semantic-v2";
    confidence: "heuristic" | "ast" | "runtime" | "mixed";
    analyzers: Array<AnalyzerProvenance & { files: number }>;
    fallbackFiles: string[];
    rejectedFiles: string[];
    evidenceErrors: string[];
    limitations: string[];
  };
  files: SemanticFile[];
  fileEdges: FileEdge[];
  moduleEdges: ModuleEdge[];
  exports: Array<SemanticExportRecord & { file: string; module: string | null }>;
  contracts: { file: string; kind: "openapi" | "protobuf" | "graphql"; module: string | null; confidence: number }[];
  unresolved: FileEdge[];
  cycles: string[][];
  violations: DependencyViolation[];
  coverage: {
    totalFiles: number;
    sourceCandidateFiles: number;
    sourceCoveragePct: number;
    parsedFiles: number;
    recognizedFiles: number;
    ownedFiles: number;
    unknownFiles: string[];
    skippedFiles: string[];
    references: number;
    resolvedInternal: number;
    unresolvedInternal: number;
    externalOrSignal: number;
    resolutionPct: number;
    astFiles: number;
    runtimeFiles: number;
    heuristicFiles: number;
    semanticAssurancePct: number;
  };
}

export interface SemanticGraphOptions {
  files?: readonly string[];
  maxFileBytes?: number;
  /** 测试源码常内嵌其他语言/路径 fixture；默认排除以避免把字符串样本当真实架构边。 */
  includeTests?: boolean;
  /** Portable native-AST/runtime evidence documents. Each document is schema- and hash-verified before use. */
  semanticEvidence?: readonly unknown[];
  minimumSemanticAssurance?: SemanticAssurance;
  failOnSemanticFallback?: boolean;
}

/** Assign by the longest matching module root; ties are deterministic by module id. */
export function moduleForFile(rel: string, modules: readonly ModuleSpecLike[]): string | null {
  const target = relPath(rel);
  const matches = modules.flatMap((module) => module.roots.map((root) => ({ module: module.id, root: normalizedRoot(root) })))
    .filter(({ root }) => root === "" || target === root || target.startsWith(`${root}/`))
    .sort((a, b) => b.root.length - a.root.length || a.module.localeCompare(b.module));
  return matches[0]?.module ?? null;
}

function moduleFromSpecifier(specifier: string, modules: readonly ModuleSpecLike[]): string | null {
  const value = specifier.toLowerCase().replace(/\\|::|\./g, "/");
  const ranked = modules.flatMap((module) => [module.id, module.name ?? "", ...module.roots]
    .filter(Boolean).map((token) => ({ id: module.id, token: normalizedRoot(token).toLowerCase() })))
    .filter(({ token }) => token && (value === token || value.startsWith(`${token}/`) || value.endsWith(`/${token}`) || value.includes(`/${token}/`)))
    .sort((a, b) => b.token.length - a.token.length || a.id.localeCompare(b.id));
  return ranked[0]?.id ?? null;
}

function analyzerMeetsPolicy(analyzers: readonly AnalyzerProvenance[], minimum: SemanticAssurance): boolean {
  const hasAst = analyzers.some((analyzer) => analyzer.assurance === "ast");
  const hasRuntime = analyzers.some((analyzer) => analyzer.assurance === "runtime");
  if (minimum === "runtime") return hasAst && hasRuntime;
  if (minimum === "ast") return hasAst;
  return analyzers.length > 0;
}

function emptySemanticFile(
  rel: string,
  module: string | null,
  owners: string[],
  language: string,
  parser: string,
  status: "unknown" | "oversize" | "unreadable",
  diagnostic?: string,
): SemanticFile {
  return { path: rel, module, owners, language, parser, confidence: 0, status, analyzers: [], diagnostics: diagnostic ? [diagnostic] : [], exports: [] };
}

function referencesFromEvidence(document: SemanticEvidenceDocument): RawReference[] {
  return document.references.map((reference, index) => ({
    kind: reference.kind,
    specifier: reference.specifier,
    line: reference.line,
    parser: document.analyzer.id,
    confidence: reference.confidence,
    forceLocal: reference.force_local,
    offset: index,
    symbol: reference.symbol,
  }));
}

function exportsFromEvidence(document: SemanticEvidenceDocument): SemanticExportRecord[] {
  return document.exports.map((item) => ({
    name: item.name,
    line: item.line,
    isTypeOnly: item.is_type_only,
    sourceSpecifier: item.source_specifier,
    parser: document.analyzer.id,
    confidence: item.confidence,
  }));
}

export function buildSemanticGraph(root: string, governance: GovernanceFileLike, options: SemanticGraphOptions = {}): SemanticGraph {
  const abs = path.resolve(root);
  const modules = governance.modules;
  const moduleMap = new Map(modules.map((m) => [m.id, m]));
  const requested = options.files?.map(relPath) ?? listFiles(abs, { content: false }).map((f) => f.rel);
  const paths = [...new Set(requested)]
    .filter((p) => p && p !== ".." && !p.startsWith("../"))
    .filter((p) => options.includeTests === true || !isTestFile(p))
    .sort();
  const maxBytes = options.maxFileBytes ?? 2 * 1024 * 1024;
  const minimumAssurance = options.minimumSemanticAssurance ?? governance.policies?.minimum_semantic_assurance ?? "heuristic";
  const failOnFallback = options.failOnSemanticFallback ?? governance.policies?.fail_on_semantic_fallback ?? false;
  const evidenceByFile = new Map<string, SemanticEvidenceDocument[]>();
  const evidenceErrors: string[] = [];
  for (const [index, input] of (options.semanticEvidence ?? []).entries()) {
    const parsed = SemanticEvidenceDocumentSchema.safeParse(input);
    if (!parsed.success) {
      evidenceErrors.push(`evidence[${index}] invalid: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "document"} ${issue.message}`).join("; ")}`);
      continue;
    }
    const evidenceFile = relPath(parsed.data.file);
    if (!evidenceFile || evidenceFile === ".." || evidenceFile.startsWith("../") || path.posix.isAbsolute(evidenceFile)) {
      evidenceErrors.push(`evidence[${index}] unsafe file path: ${parsed.data.file}`);
      continue;
    }
    evidenceByFile.set(evidenceFile, [...(evidenceByFile.get(evidenceFile) ?? []), parsed.data]);
  }
  const files: SemanticFile[] = []; const rawByFile = new Map<string, RawReference[]>();
  const contracts: SemanticGraph["contracts"] = [];
  const semanticViolations: DependencyViolation[] = evidenceErrors.map((error) => ({ type: "semantic-evidence-invalid", from: "evidence", to: "schema", evidence: [error] }));
  const analysisLimitations = new Set<string>();
  for (const rel of paths) {
    const ext = path.posix.extname(rel).slice(1).toLowerCase();
    const known = SOURCE_LANGUAGE[ext]; const module = moduleForFile(rel, modules);
    const owners = [...(module ? moduleMap.get(module)?.owners ?? [] : [])];
    let stat: fs.Stats;
    try { stat = fs.statSync(path.join(abs, ...rel.split("/"))); }
    catch { files.push(emptySemanticFile(rel, module, owners, known?.[0] ?? "unknown", known?.[1] ?? "none", "unreadable", "stat failed")); continue; }
    if (stat.size > maxBytes) { files.push(emptySemanticFile(rel, module, owners, known?.[0] ?? "unknown", known?.[1] ?? "none", "oversize", `${stat.size} bytes exceeds ${maxBytes}`)); continue; }
    let content: string;
    try { content = fs.readFileSync(path.join(abs, ...rel.split("/")), "utf8"); }
    catch { files.push(emptySemanticFile(rel, module, owners, known?.[0] ?? "unknown", known?.[1] ?? "none", "unreadable", "UTF-8 read failed")); continue; }
    const contract = contractKind(rel, content);
    const verifiedDocuments: SemanticEvidenceDocument[] = [];
    const diagnostics: string[] = [];
    for (const candidate of evidenceByFile.get(rel) ?? []) {
      const verified = verifySemanticEvidence(candidate, rel, content);
      if (!verified.ok || !verified.document) {
        const errors = verified.errors.map((error) => `${rel}: ${error}`);
        diagnostics.push(...errors); evidenceErrors.push(...errors);
        semanticViolations.push({ type: "semantic-evidence-invalid", from: rel, to: candidate.analyzer.id, evidence: errors });
        continue;
      }
      verifiedDocuments.push(verified.document);
    }
    const evidenceLanguage = verifiedDocuments[0]?.language;
    const language = known?.[0] ?? evidenceLanguage ?? (contract === "openapi" ? "openapi" : "unknown");
    for (const document of verifiedDocuments) {
      if (document.language !== language) {
        const error = `${rel}: evidence language ${document.language} does not match ${language}`;
        diagnostics.push(error); evidenceErrors.push(error);
        semanticViolations.push({ type: "semantic-evidence-invalid", from: rel, to: document.analyzer.id, evidence: [error] });
      }
    }
    const validDocuments = verifiedDocuments.filter((document) => document.language === language);
    const hasNativeStaticEvidence = validDocuments.some((document) => document.analyzer.assurance === "ast" && document.analyzer.capabilities.includes("imports"));
    const configuredParser = known?.[1] ?? (contract ? `regex:${contract}-contract-v1` : "none");
    const parseResults = [] as Array<ReturnType<typeof analyzeSource>>;
    if (configuredParser !== "none" && ((language === "typescript" || language === "javascript") || !hasNativeStaticEvidence)) {
      parseResults.push(analyzeSource(rel, language, configuredParser, content));
    }
    const analyzers = [
      ...parseResults.map((result) => result.analyzer),
      ...validDocuments.map((document) => document.analyzer),
    ];
    const analyzerById = new Map(analyzers.map((analyzer) => [analyzer.id, analyzer]));
    const candidateReferences = [
      ...parseResults.flatMap((result) => result.references),
      ...validDocuments.flatMap(referencesFromEvidence),
    ];
    const referenceMap = new Map<string, RawReference>();
    for (const reference of candidateReferences) {
      const key = `${reference.kind}|${reference.line}|${reference.specifier}|${reference.symbol ?? ""}`;
      const previous = referenceMap.get(key);
      const currentRank = assuranceRank(analyzerById.get(reference.parser)?.assurance ?? "heuristic");
      const previousRank = previous ? assuranceRank(analyzerById.get(previous.parser)?.assurance ?? "heuristic") : -1;
      if (!previous || currentRank > previousRank || (currentRank === previousRank && reference.confidence > previous.confidence)) referenceMap.set(key, reference);
    }
    const candidateExports = [
      ...parseResults.flatMap((result) => result.exports),
      ...validDocuments.flatMap(exportsFromEvidence),
    ];
    const exportMap = new Map<string, SemanticExportRecord>();
    for (const item of candidateExports) {
      const key = `${item.name}|${item.line}|${item.sourceSpecifier ?? ""}`;
      const previous = exportMap.get(key);
      const currentRank = assuranceRank(analyzerById.get(item.parser)?.assurance ?? "heuristic");
      const previousRank = previous ? assuranceRank(analyzerById.get(previous.parser)?.assurance ?? "heuristic") : -1;
      if (!previous || currentRank > previousRank || (currentRank === previousRank && item.confidence > previous.confidence)) exportMap.set(key, item);
    }
    for (const result of parseResults) { diagnostics.push(...result.diagnostics); for (const limitation of result.limitations) analysisLimitations.add(limitation); }
    const primary = [...analyzers].sort((a, b) => assuranceRank(b.assurance) - assuranceRank(a.assurance) || a.id.localeCompare(b.id))[0];
    const parser = primary?.id ?? configuredParser;
    const confidence = primary?.assurance === "runtime" ? 1 : primary?.assurance === "ast" ? 0.99 : primary ? known?.[2] ?? 0.8 : 0;
    const incomplete = parseResults.some((result) => result.status === "partial") || validDocuments.some((document) => document.status === "partial");
    const policyFailures: string[] = [];
    if (parser !== "none" && !analyzerMeetsPolicy(analyzers, minimumAssurance)) {
      policyFailures.push(`requires ${minimumAssurance}; analyzers provide ${[...new Set(analyzers.map((analyzer) => analyzer.assurance))].join("+") || "none"}`);
    }
    if (failOnFallback && analyzers.some((analyzer) => analyzer.family === "regex-fallback")) policyFailures.push("regex fallback is forbidden");
    if ((minimumAssurance === "ast" || minimumAssurance === "runtime") && incomplete) policyFailures.push("semantic evidence is partial");
    if (policyFailures.length > 0) {
      semanticViolations.push({ type: "semantic-evidence-below-policy", from: rel, to: minimumAssurance, evidence: policyFailures.map((failure) => `${rel}: ${failure}`) });
    }
    const status: SemanticFile["status"] = parser === "none" ? "unknown" : policyFailures.length > 0 ? "rejected" : incomplete ? "partial" : "parsed";
    const fileExports = [...exportMap.values()].sort((a, b) => a.line - b.line || a.name.localeCompare(b.name));
    files.push({ path: rel, module, owners, language, parser, confidence, status, analyzers, diagnostics, exports: fileExports });
    if (contract) contracts.push({ file: rel, kind: contract, module, confidence: contract === "openapi" ? 0.9 : 0.96 });
    if (parser !== "none" && status !== "rejected") rawByFile.set(rel, [...referenceMap.values()]);
  }
  const fileSet = new Set(files.filter((f) => f.status !== "unreadable").map((f) => f.path));
  const contractByBase = new Map<string, string[]>();
  for (const contract of contracts) contractByBase.set(path.posix.basename(contract.file), [...(contractByBase.get(path.posix.basename(contract.file)) ?? []), contract.file]);
  const interfaceEvidence = (fromModule: string | null, toModule: string | null, to: string | null, specifier: string, kind: SemanticKind): string | null => {
    if (!fromModule || !toModule) return null;
    const published = new Set(moduleMap.get(toModule)?.public_interfaces ?? []);
    for (const item of governance.interfaces ?? []) {
      if (!published.has(item.id) || item.provider !== toModule || !item.consumers.includes(fromModule)) continue;
      const contracts = item.contract_files.map(relPath);
      const exactContract = to !== null && contracts.includes(to);
      const explicit = (kind === "contract" || kind === "grpc" || kind === "http") &&
        (specifier === item.id || specifier === `interface:${item.id}`);
      if (exactContract || explicit) return item.id;
    }
    return null;
  };
  const fileEdges: FileEdge[] = [];
  for (const [from, refs] of rawByFile) {
    const fromModule = moduleForFile(from, modules); const owner = fromModule ? moduleMap.get(fromModule) : undefined;
    for (const ref of refs) {
      let to: string | null = null; let toModule: string | null = null; let resolution: Resolution = "external";
      if ((ref.kind === "http" && /^[a-z]+:\/\//i.test(ref.specifier)) || /^(?:inline GraphQL|C ABI)$/.test(ref.specifier)) resolution = ref.specifier === "inline GraphQL" || ref.specifier === "C ABI" ? "signal" : "external";
      else {
        to = candidates(from, ref.specifier, files.find((f) => f.path === from)?.language ?? "unknown", owner?.roots).find((p) => fileSet.has(p)) ?? null;
        if (!to && ref.kind === "contract") {
          const sameBase = contractByBase.get(path.posix.basename(ref.specifier));
          if (sameBase?.length === 1) to = sameBase[0];
        }
        if (to) { toModule = moduleForFile(to, modules); resolution = "file"; }
        else {
          toModule = moduleFromSpecifier(ref.specifier, modules);
          if (toModule) resolution = "module";
          else if (ref.forceLocal || ref.specifier.startsWith(".") || ref.specifier.startsWith("/")) resolution = "unresolved";
          else if (ref.kind === "grpc" || ref.kind === "ffi") resolution = "signal";
        }
      }
      const interfaceId = interfaceEvidence(fromModule, toModule, to, ref.specifier, ref.kind);
      fileEdges.push({ from, fromModule, to, toModule, specifier: ref.specifier, kind: ref.kind, line: ref.line, parser: ref.parser, confidence: ref.confidence, symbol: ref.symbol, resolution, interfaceId });
    }
  }
  fileEdges.sort((a, b) => a.from.localeCompare(b.from) || a.line - b.line || a.kind.localeCompare(b.kind) || a.specifier.localeCompare(b.specifier));
  const grouped = new Map<string, FileEdge[]>();
  for (const edge of fileEdges) if (edge.fromModule && edge.toModule && edge.fromModule !== edge.toModule) {
    const key = `${edge.fromModule}\0${edge.toModule}`; grouped.set(key, [...(grouped.get(key) ?? []), edge]);
  }
  const interfaceDeclared = (from: string, to: string, evidence: readonly FileEdge[]): boolean => (governance.interfaces ?? []).some((i) =>
    i.provider === to && i.consumers.includes(from) && evidence.some((e) => e.interfaceId === i.id));
  const moduleEdges: ModuleEdge[] = [...grouped].map(([key, evidence]) => {
    const [from, to] = key.split("\0"); const spec = moduleMap.get(from)!;
    return { from, to, kinds: [...new Set(evidence.map((e) => e.kind))].sort() as SemanticKind[], files: [...new Set(evidence.map((e) => e.from))].sort(), confidence: Math.max(...evidence.map((e) => e.confidence)), declared: (spec.depends_on ?? []).includes(to) || interfaceDeclared(from, to, evidence) };
  }).sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
  const violations: DependencyViolation[] = [...semanticViolations];
  for (const edge of moduleEdges) {
    const spec = moduleMap.get(edge.from)!; const evidence = edge.files;
    if ((spec.denied_dependencies ?? []).some((x) => x === "*" || x === edge.to)) violations.push({ type: "denied-dependency", from: edge.from, to: edge.to, evidence });
    if ((spec.allowed_dependencies?.length ?? 0) > 0 && !(spec.allowed_dependencies ?? []).some((x) => x === "*" || x === edge.to)) violations.push({ type: "not-allowed-dependency", from: edge.from, to: edge.to, evidence });
    if ((governance.policies?.enforce_declared_dependencies ?? true) && !edge.declared) violations.push({ type: "undeclared-dependency", from: edge.from, to: edge.to, evidence });
  }
  const unresolved = fileEdges.filter((e) => e.resolution === "unresolved");
  const resolvedInternal = fileEdges.filter((e) => e.resolution === "file" || e.resolution === "module").length;
  const internalTotal = resolvedInternal + unresolved.length;
  const unknownFiles = files.filter((f) => f.status === "unknown").map((f) => f.path);
  const skippedFiles = files.filter((f) => f.status === "oversize" || f.status === "unreadable").map((f) => f.path);
  const contractFiles = new Set(contracts.map((c) => c.file));
  const sourceCandidates = files.filter((file) => {
    const ext = path.posix.extname(file.path).slice(1).toLowerCase();
    return SOURCE_LANGUAGE[ext] !== undefined || UNKNOWN_SOURCE_EXTS.has(ext) || contractFiles.has(file.path) || file.analyzers.length > 0;
  });
  const sourceCandidateFiles = sourceCandidates.length;
  const sourceCoveragePct = sourceCandidateFiles === 0 ? 100 : Math.round((sourceCandidates.filter((f) => f.status === "parsed").length / sourceCandidateFiles) * 100);
  const astFiles = sourceCandidates.filter((file) => file.analyzers.some((analyzer) => analyzer.assurance === "ast")).length;
  const runtimeFiles = sourceCandidates.filter((file) => file.analyzers.some((analyzer) => analyzer.assurance === "runtime")).length;
  const heuristicFiles = sourceCandidates.filter((file) => file.analyzers.some((analyzer) => analyzer.assurance === "heuristic")).length;
  const assuredFiles = sourceCandidates.filter((file) => file.status === "parsed" && analyzerMeetsPolicy(file.analyzers, minimumAssurance)).length;
  const semanticAssurancePct = sourceCandidateFiles === 0 ? 100 : Math.round((assuredFiles / sourceCandidateFiles) * 100);

  if (governance.policies?.enforce_public_interfaces ?? true) {
    for (const edge of fileEdges) {
      if (!edge.to || !edge.fromModule || !edge.toModule || edge.fromModule === edge.toModule) continue;
      const target = moduleMap.get(edge.toModule);
      if ((target?.public_interfaces?.length ?? 0) === 0 || edge.interfaceId !== null) continue;
      violations.push({
        type: "private-interface",
        from: edge.fromModule,
        to: edge.toModule,
        evidence: [`${edge.from}:${edge.line} -> ${edge.to} (${edge.kind}); target publishes ${target!.public_interfaces!.join(", ")}`],
      });
    }
  }
  if (governance.policies?.enforce_ownership ?? false) {
    for (const file of sourceCandidates) {
      if (file.module !== null && file.owners.length > 0) continue;
      violations.push({
        type: "unowned-file",
        from: file.path,
        to: file.module ?? "(no-module)",
        evidence: [file.module === null ? `${file.path} matches no module root` : `${file.path} belongs to ${file.module}, whose owners list is empty`],
      });
    }
  }
  if (governance.policies?.fail_on_unresolved ?? false) {
    for (const edge of unresolved) {
      violations.push({ type: "unresolved-reference", from: edge.fromModule ?? edge.from, to: edge.specifier, evidence: [`${edge.from}:${edge.line} unresolved ${edge.kind} reference ${edge.specifier}`] });
    }
  }
  const minimumCoverage = governance.policies?.minimum_coverage_pct;
  if (minimumCoverage !== undefined && sourceCoveragePct < minimumCoverage) {
    violations.push({ type: "coverage-below-policy", from: "project", to: `${sourceCoveragePct}%`, evidence: [`source coverage ${sourceCoveragePct}% (${sourceCandidates.filter((f) => f.status === "parsed").length}/${sourceCandidateFiles}) is below policy ${minimumCoverage}%`] });
  }
  analysisLimitations.add("Static AST evidence does not prove runtime execution; reflection, generated code, and data-driven dispatch require separately hash-bound runtime evidence.");
  const analyzerGroups = new Map<string, AnalyzerProvenance & { files: number }>();
  for (const file of files) for (const analyzer of file.analyzers) {
    const current = analyzerGroups.get(analyzer.id);
    if (current) current.files += 1;
    else analyzerGroups.set(analyzer.id, { ...analyzer, capabilities: [...analyzer.capabilities], files: 1 });
  }
  const assurances = new Set(files.flatMap((file) => file.analyzers.map((analyzer) => analyzer.assurance)));
  const analysisConfidence: SemanticGraph["analysis"]["confidence"] = assurances.size > 1
    ? "mixed"
    : assurances.has("runtime")
      ? "runtime"
      : assurances.has("ast")
        ? "ast"
        : "heuristic";
  const exportedSymbols = files.flatMap((file) => file.exports.map((item) => ({ ...item, file: file.path, module: file.module })));
  return {
    analysis: {
      parser: "hybrid-semantic-v2",
      confidence: analysisConfidence,
      analyzers: [...analyzerGroups.values()].sort((a, b) => a.id.localeCompare(b.id)),
      fallbackFiles: sourceCandidates.filter((file) => file.analyzers.some((analyzer) => analyzer.family === "regex-fallback")).map((file) => file.path),
      rejectedFiles: files.filter((file) => file.status === "rejected").map((file) => file.path),
      evidenceErrors,
      limitations: [...analysisLimitations],
    },
    files, fileEdges, moduleEdges, exports: exportedSymbols, contracts, unresolved, cycles: findModuleCycles(moduleEdges), violations,
    coverage: {
      totalFiles: files.length,
      sourceCandidateFiles,
      sourceCoveragePct,
      parsedFiles: sourceCandidates.filter((f) => f.status === "parsed").length,
      recognizedFiles: files.filter((f) => f.language !== "unknown").length,
      ownedFiles: files.filter((f) => f.module !== null).length,
      unknownFiles,
      skippedFiles,
      references: fileEdges.length,
      resolvedInternal,
      unresolvedInternal: unresolved.length,
      externalOrSignal: fileEdges.filter((e) => e.resolution === "external" || e.resolution === "signal").length,
      resolutionPct: internalTotal === 0 ? 100 : Math.round((resolvedInternal / internalTotal) * 100),
      astFiles,
      runtimeFiles,
      heuristicFiles,
      semanticAssurancePct,
    },
  };
}

export interface ImpactResult { changedFiles: string[]; impactedFiles: string[]; dependentFiles: string[]; impactedModules: string[]; unknownChangedFiles: string[] }

/** Reverse closure over file targets and module-only contract/FFI edges. */
export function impactAnalysis(graph: SemanticGraph, changedFiles: readonly string[]): ImpactResult {
  return computeImpactAnalysis(graph, changedFiles);
}
