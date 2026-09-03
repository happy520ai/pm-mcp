import { parse, registerDynamicLanguage, type SgNode } from "@ast-grep/napi";
import csharpGrammar from "@ast-grep/lang-csharp";
import goGrammar from "@ast-grep/lang-go";
import javaGrammar from "@ast-grep/lang-java";
import kotlinGrammar from "@ast-grep/lang-kotlin";
import pythonGrammar from "@ast-grep/lang-python";
import rustGrammar from "@ast-grep/lang-rust";
import type { AnalyzerProvenance, SemanticExportRecord } from "./semantic-evidence.ts";
import type { RawReference, SemanticKind } from "./semantic-parsers.ts";

export const POLYGLOT_AST_LANGUAGES = ["python", "go", "rust", "java", "kotlin", "csharp"] as const;
export type PolyglotAstLanguage = typeof POLYGLOT_AST_LANGUAGES[number];

export interface PolyglotAstResult {
  references: RawReference[];
  exports: SemanticExportRecord[];
  analyzer: AnalyzerProvenance;
  status: "complete" | "partial";
  diagnostics: string[];
  limitations: string[];
}

interface ImportBinding {
  local: string;
  specifier: string;
  symbol: string;
}

const NAPI_VERSION = "0.45.3";
const GRAMMAR_VERSIONS: Record<PolyglotAstLanguage, string> = {
  python: "0.0.6",
  go: "0.0.6",
  rust: "0.0.7",
  java: "0.0.7",
  kotlin: "0.0.7",
  csharp: "0.0.6",
};

// ast-grep requires one process-wide registration call. ESM module evaluation is
// cached, so importing this provider repeatedly cannot re-register the grammars.
registerDynamicLanguage({
  python: pythonGrammar,
  go: goGrammar,
  rust: rustGrammar,
  java: javaGrammar,
  kotlin: kotlinGrammar,
  csharp: csharpGrammar,
});

const STRING_KINDS = new Set([
  "string", "string_literal", "interpreted_string_literal", "raw_string_literal",
]);

function isSupportedLanguage(value: string): value is PolyglotAstLanguage {
  return (POLYGLOT_AST_LANGUAGES as readonly string[]).includes(value);
}

export function supportsPolyglotAstLanguage(value: string): value is PolyglotAstLanguage {
  return isSupportedLanguage(value);
}

function analyzerFor(language: PolyglotAstLanguage): AnalyzerProvenance {
  const grammarVersion = GRAMMAR_VERSIONS[language];
  return {
    id: `tree-sitter:${language}@${grammarVersion}`,
    family: "structured-parser",
    assurance: "ast",
    engine: "ast-grep Tree-sitter",
    version: `${NAPI_VERSION}+grammar-${grammarVersion}`,
    capabilities: ["imports", "calls", "contracts", "ffi"],
  };
}

function allNodes(root: SgNode): SgNode[] {
  const nodes: SgNode[] = [];
  const visit = (node: SgNode): void => {
    nodes.push(node);
    for (const child of node.children()) visit(child);
  };
  visit(root);
  return nodes;
}

function syntaxDiagnostics(root: SgNode): string[] {
  const diagnostics: string[] = [];
  for (const node of allNodes(root).slice(1)) {
    if (node.kind() !== "ERROR" && node.text().length > 0) continue;
    const start = node.range().start;
    const label = node.kind() === "ERROR" ? "syntax error" : `missing ${node.kind()}`;
    diagnostics.push(`${start.line + 1}:${start.column + 1} ${label}`);
  }
  return [...new Set(diagnostics)];
}

function stringValue(text: string): string | null {
  const trimmed = text.trim();
  const prefixed = trimmed.match(/^(?:[rubf]+|@)?("""|'''|"|'|`)([\s\S]*)(?:\1)$/i);
  if (!prefixed) return null;
  const quote = prefixed[1];
  const body = prefixed[2];
  if (quote === '"') {
    try { return JSON.parse(`"${body}"`) as string; } catch { return body; }
  }
  return body.replace(/\\(['`\\])/g, "$1");
}

function firstString(node: SgNode): string | null {
  if (STRING_KINDS.has(String(node.kind()))) return stringValue(node.text());
  for (const child of node.children()) {
    const value = firstString(child);
    if (value !== null) return value;
  }
  return null;
}

function contractSpecifier(value: string): string | null {
  const clean = value.trim();
  const pathPart = clean.split("#", 1)[0].replace(/\\/g, "/");
  const basename = pathPart.split("/").at(-1) ?? "";
  if (/^[^.\s][^/\s]*\.(?:proto|graphql|gql)$/i.test(basename)) return clean;
  const structured = basename.match(/^([^/\s]+)\.(?:ya?ml|json)$/i);
  if (structured && /(?:^|[-_.])(?:openapi|swagger|asyncapi|contracts?|schemas?)(?:$|[-_.])/i.test(structured[1])) return clean;
  return null;
}

function pythonImports(text: string): string[] {
  const from = text.match(/^\s*from\s+([.\w]+)\s+import\s+([\s\S]+)$/);
  if (from) {
    let specifier = from[1];
    if (/^\.+$/.test(specifier)) {
      const imported = from[2].replace(/[()]/g, "").split(",", 1)[0].trim().split(/\s+as\s+/, 1)[0];
      if (imported && imported !== "*") specifier += imported;
    }
    return [specifier];
  }
  const direct = text.match(/^\s*import\s+([\s\S]+)$/);
  return direct
    ? direct[1].replace(/[()]/g, "").split(",").map((item) => item.trim().split(/\s+as\s+/, 1)[0]).filter(Boolean)
    : [];
}

function importSpecifiers(language: PolyglotAstLanguage, node: SgNode): Array<{ value: string; forceLocal: boolean }> {
  const text = node.text().trim();
  if (language === "python" && (node.kind() === "import_statement" || node.kind() === "import_from_statement")) {
    return pythonImports(text).map((value) => ({ value, forceLocal: value.startsWith(".") }));
  }
  if (language === "go" && node.kind() === "import_spec") {
    const value = firstString(node);
    return value && value !== "C" ? [{ value, forceLocal: false }] : [];
  }
  if (language === "rust" && node.kind() === "use_declaration") {
    const value = text.replace(/^use\s+/, "").replace(/;\s*$/, "").replace(/\s+as\s+[A-Za-z_]\w*\s*$/, "").trim();
    return value ? [{ value, forceLocal: /^(?:crate|self|super)::/.test(value) }] : [];
  }
  if (language === "rust" && node.kind() === "mod_item" && /;\s*$/.test(text)) {
    const value = text.match(/^mod\s+([A-Za-z_]\w*)\s*;/)?.[1];
    return value ? [{ value, forceLocal: true }] : [];
  }
  if (language === "java" && node.kind() === "import_declaration") {
    const value = text.replace(/^import\s+/, "").replace(/^static\s+/, "").replace(/;\s*$/, "").trim();
    return value ? [{ value, forceLocal: false }] : [];
  }
  if (language === "kotlin" && node.kind() === "import_header") {
    const value = text.replace(/^import\s+/, "").replace(/\s+as\s+\w+\s*$/, "").trim();
    return value ? [{ value, forceLocal: false }] : [];
  }
  if (language === "csharp" && node.kind() === "using_directive") {
    const body = text.replace(/^global\s+/, "").replace(/^using\s+/, "").replace(/^static\s+/, "").replace(/;\s*$/, "").trim();
    const value = body.includes("=") ? body.slice(body.indexOf("=") + 1).trim() : body;
    return value ? [{ value, forceLocal: false }] : [];
  }
  return [];
}

function pythonBindings(text: string): ImportBinding[] {
  const from = text.match(/^\s*from\s+([.\w]+)\s+import\s+([\s\S]+)$/);
  if (from) {
    const base = from[1];
    return from[2].replace(/[()]/g, "").split(",").flatMap((raw) => {
      const parts = raw.trim().split(/\s+as\s+/);
      const imported = parts[0]?.trim() ?? "";
      if (!imported || imported === "*") return [];
      const local = (parts[1] ?? imported.split(".").at(-1) ?? "").trim();
      const specifier = /^\.+$/.test(base) ? `${base}${imported}` : base;
      return local ? [{ local, specifier, symbol: imported }] : [];
    });
  }
  const direct = text.match(/^\s*import\s+([\s\S]+)$/);
  if (!direct) return [];
  return direct[1].replace(/[()]/g, "").split(",").flatMap((raw) => {
    const parts = raw.trim().split(/\s+as\s+/);
    const specifier = parts[0]?.trim() ?? "";
    const local = (parts[1] ?? specifier.split(".")[0] ?? "").trim();
    return specifier && local ? [{ local, specifier, symbol: "*" }] : [];
  });
}

function importedBindings(language: PolyglotAstLanguage, node: SgNode): ImportBinding[] {
  const kind = String(node.kind());
  const text = node.text().trim();
  if (language === "python" && (kind === "import_statement" || kind === "import_from_statement")) return pythonBindings(text);
  if (language === "go" && kind === "import_spec") {
    const specifier = firstString(node);
    if (!specifier || specifier === "C") return [];
    const quote = text.search(/["`]/);
    const explicit = quote < 0 ? "" : text.slice(0, quote).trim().split(/\s+/).at(-1) ?? "";
    if (explicit === "_" || explicit === ".") return [];
    const local = explicit || (specifier.replace(/\/$/, "").split("/").at(-1) ?? "");
    return local ? [{ local, specifier, symbol: "*" }] : [];
  }
  if (language === "rust" && kind === "use_declaration") {
    const body = text.replace(/^use\s+/, "").replace(/;\s*$/, "").trim();
    if (!body || /[{}*]/.test(body)) return [];
    const alias = body.match(/\s+as\s+([A-Za-z_]\w*)\s*$/)?.[1];
    const specifier = body.replace(/\s+as\s+[A-Za-z_]\w*\s*$/, "");
    const symbol = specifier.split("::").at(-1) ?? "";
    const local = alias ?? symbol;
    return local ? [{ local, specifier, symbol }] : [];
  }
  if (language === "java" && kind === "import_declaration") {
    const specifier = importSpecifiers(language, node)[0]?.value ?? "";
    if (!specifier || specifier.endsWith(".*")) return [];
    const local = specifier.split(".").at(-1) ?? "";
    return local ? [{ local, specifier, symbol: local }] : [];
  }
  if (language === "kotlin" && kind === "import_header") {
    const specifier = importSpecifiers(language, node)[0]?.value ?? "";
    const alias = text.match(/\s+as\s+([A-Za-z_]\w*)\s*$/)?.[1];
    const symbol = specifier.split(".").at(-1) ?? "";
    const local = alias ?? symbol;
    return local ? [{ local, specifier, symbol }] : [];
  }
  if (language === "csharp" && kind === "using_directive" && text.includes("=")) {
    const body = text.replace(/^global\s+/, "").replace(/^using\s+/, "").replace(/;\s*$/, "").trim();
    const equal = body.indexOf("=");
    const local = body.slice(0, equal).trim();
    const specifier = body.slice(equal + 1).trim();
    return /^[A-Za-z_]\w*$/.test(local) && specifier ? [{ local, specifier, symbol: "*" }] : [];
  }
  return [];
}

function callBindingName(language: PolyglotAstLanguage, node: SgNode): string | null {
  const callKinds: Record<PolyglotAstLanguage, string> = {
    python: "call",
    go: "call_expression",
    rust: "call_expression",
    java: "method_invocation",
    kotlin: "call_expression",
    csharp: "invocation_expression",
  };
  if (String(node.kind()) !== callKinds[language]) return null;
  const callee = node.text().split("(", 1)[0].trim();
  return callee.match(/^([A-Za-z_]\w*)/)?.[1] ?? null;
}

function ffiSpecifier(language: PolyglotAstLanguage, node: SgNode): string | null {
  const kind = node.kind();
  const text = node.text().trim();
  if (language === "go" && kind === "import_spec" && firstString(node) === "C") return "C ABI";
  if (language === "rust" && kind === "foreign_mod_item" && /^extern\s+"C"/.test(text)) return "C ABI";
  if (language === "python" && kind === "call" && /^(?:ctypes\.(?:CDLL|PyDLL)|(?:cffi\.)?dlopen)\s*\(/.test(text)) return firstString(node);
  if (language === "rust" && kind === "call_expression" && /(?:\bdlopen|libloading::Library::new)\s*\(/.test(text)) return firstString(node);
  if (language === "java" && kind === "method_invocation" && /(?:System|Runtime)\.(?:load|loadLibrary)\s*\(/.test(text)) return firstString(node);
  if (language === "kotlin" && kind === "call_expression" && /(?:System|Runtime)\.(?:load|loadLibrary)\s*\(/.test(text)) return firstString(node);
  if (language === "csharp" && kind === "attribute" && /(?:^|\.)DllImport\s*\(/.test(text)) return firstString(node);
  if (language === "csharp" && kind === "invocation_expression" && /NativeLibrary\.Load\s*\(/.test(text)) return firstString(node);
  return null;
}

/**
 * Parses a single non-TS source file with a bundled Tree-sitter grammar.
 * Syntax recovery is deliberately rejected: an ERROR/missing node makes the
 * result partial and suppresses every edge from the recovered tree.
 */
export function analyzePolyglotAstSource(rel: string, language: string, content: string): PolyglotAstResult {
  if (!isSupportedLanguage(language)) throw new Error(`Unsupported polyglot AST language: ${language}`);
  const analyzer = analyzerFor(language);
  const root = parse(language, content).root();
  const diagnostics = syntaxDiagnostics(root);
  if (diagnostics.length > 0) {
    return {
      references: [], exports: [], analyzer, status: "partial", diagnostics,
      limitations: ["Tree-sitter recovered from invalid syntax; fail-closed mode discarded all recovered relations."],
    };
  }

  const references: RawReference[] = [];
  const add = (node: SgNode, kind: SemanticKind, specifier: string, confidence: number, forceLocal = false, symbol?: string): void => {
    if (!specifier.trim()) return;
    references.push({
      kind, specifier: specifier.trim(), line: node.range().start.line + 1,
      parser: analyzer.id, confidence, forceLocal, offset: node.range().start.index, symbol,
    });
  };
  const nodes = allNodes(root);
  const bindings = new Map<string, ImportBinding | null>();
  for (const node of nodes) {
    for (const binding of importedBindings(language, node)) {
      const previous = bindings.get(binding.local);
      bindings.set(binding.local, previous === undefined || (previous && previous.specifier === binding.specifier && previous.symbol === binding.symbol) ? binding : null);
    }
  }
  for (const node of nodes) {
    for (const item of importSpecifiers(language, node)) add(node, "import", item.value, 0.98, item.forceLocal);
    const bindingName = callBindingName(language, node);
    const binding = bindingName ? bindings.get(bindingName) : undefined;
    if (binding) add(node, "call", binding.specifier, 0.96, binding.specifier.startsWith("."), binding.symbol);
    if (STRING_KINDS.has(String(node.kind()))) {
      const value = stringValue(node.text());
      const contract = value === null ? null : contractSpecifier(value);
      if (contract) add(node, "contract", contract, 0.98, true);
    }
    const ffi = ffiSpecifier(language, node);
    if (ffi) add(node, "ffi", ffi, 0.98, ffi !== "C ABI" && /[\\/]/.test(ffi));
  }
  const unique = [...new Map(references.map((reference) => [
    `${reference.kind}|${reference.line}|${reference.specifier}|${reference.offset ?? ""}`,
    reference,
  ])).values()].sort((a, b) => a.line - b.line || a.kind.localeCompare(b.kind) || a.specifier.localeCompare(b.specifier));
  return {
    references: unique,
    exports: [],
    analyzer,
    status: "complete",
    diagnostics: [],
    limitations: [
      "Tree-sitter AST proves source syntax, not compiler symbol resolution or runtime execution.",
      `Source identity (${rel}) and content hash are bound by the semantic evidence layer when results are imported.`,
    ],
  };
}
