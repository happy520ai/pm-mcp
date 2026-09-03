import path from "node:path";
import { normSep } from "./budget.ts";
import { analyzeTypeScriptSource } from "./typescript-semantic.ts";
import { analyzePolyglotAstSource, supportsPolyglotAstLanguage } from "./polyglot-ast.ts";
import type { AnalyzerProvenance, SemanticExportRecord } from "./semantic-evidence.ts";

export type SemanticKind = "import" | "export" | "call" | "contract" | "http" | "grpc" | "ffi";

export interface RawReference {
  kind: SemanticKind;
  specifier: string;
  line: number;
  parser: string;
  confidence: number;
  forceLocal?: boolean;
  /** Internal-only source offset used to keep distinct calls on the same line. */
  offset?: number;
  /** Imported/exported symbol when the analyzer can prove one. */
  symbol?: string;
}

export interface SemanticParseResult {
  references: RawReference[];
  exports: SemanticExportRecord[];
  analyzer: AnalyzerProvenance;
  status: "complete" | "partial";
  diagnostics: string[];
  limitations: string[];
}

export const SOURCE_LANGUAGE: Readonly<Record<string, readonly [string, string, number]>> = {
  ts: ["typescript", "typescript:compiler-api-ast", 0.99], tsx: ["typescript", "typescript:compiler-api-ast", 0.99],
  mts: ["typescript", "typescript:compiler-api-ast", 0.99], cts: ["typescript", "typescript:compiler-api-ast", 0.99],
  js: ["javascript", "typescript:compiler-api-ast", 0.99], jsx: ["javascript", "typescript:compiler-api-ast", 0.99],
  mjs: ["javascript", "typescript:compiler-api-ast", 0.99], cjs: ["javascript", "typescript:compiler-api-ast", 0.99],
  py: ["python", "regex:python-import-v1", 0.82], go: ["go", "regex:go-import-v1", 0.86],
  rs: ["rust", "regex:rust-use-v1", 0.76], java: ["java", "regex:jvm-import-v1", 0.86],
  kt: ["kotlin", "regex:jvm-import-v1", 0.84], kts: ["kotlin", "regex:jvm-import-v1", 0.84],
  cs: ["csharp", "regex:csharp-using-v1", 0.78], proto: ["protobuf", "regex:protobuf-import-v1", 0.94],
  graphql: ["graphql", "regex:graphql-import-v1", 0.92], gql: ["graphql", "regex:graphql-import-v1", 0.92],
};

const RESOLVE_EXTS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs", ".java", ".kt", ".kts", ".cs", ".proto", ".graphql", ".gql", ".yaml", ".yml", ".json"];
export const UNKNOWN_SOURCE_EXTS: ReadonlySet<string> = new Set(["rb", "php", "swift", "scala", "c", "h", "cc", "cpp", "cxx", "hpp", "vue", "svelte", "lua", "sh", "bash", "zsh"]);

export function relPath(value: string): string {
  return normSep(value).replace(/^\.\//, "").replace(/^\/+/, "");
}

export function normalizedRoot(value: string): string {
  const root = relPath(value).replace(/\/$/, "");
  return root === "." ? "" : root;
}

function lineLocator(content: string): (index: number) => number {
  const starts = [0];
  for (let i = 0; i < content.length; i += 1) if (content.charCodeAt(i) === 10) starts.push(i + 1);
  return (index) => {
    let lo = 0; let hi = starts.length;
    while (lo + 1 < hi) { const mid = (lo + hi) >>> 1; if (starts[mid] <= index) lo = mid; else hi = mid; }
    return lo + 1;
  };
}

/** Replace comments and string/template literals with spaces while preserving offsets/newlines. */
function maskNonCode(content: string, python: boolean): string {
  const chars = [...content];
  let quote = ""; let triple = false; let blockComment = false;
  for (let i = 0; i < chars.length; i += 1) {
    const c = chars[i]; const next = chars[i + 1] ?? ""; const third = chars[i + 2] ?? "";
    if (blockComment) {
      if (c === "*" && next === "/") { chars[i] = chars[i + 1] = " "; i += 1; blockComment = false; }
      else if (c !== "\n" && c !== "\r") chars[i] = " ";
      continue;
    }
    if (quote) {
      if (c === "\\" && !triple) { chars[i] = " "; if (i + 1 < chars.length && chars[i + 1] !== "\n") chars[++i] = " "; continue; }
      if (triple && c === quote && next === quote && third === quote) { chars[i] = chars[i + 1] = chars[i + 2] = " "; i += 2; quote = ""; triple = false; }
      else if (!triple && c === quote) { chars[i] = " "; quote = ""; }
      else if (c !== "\n" && c !== "\r") chars[i] = " ";
      continue;
    }
    if (!python && c === "/" && next === "*") { chars[i] = chars[i + 1] = " "; i += 1; blockComment = true; continue; }
    if ((!python && c === "/" && next === "/") || (python && c === "#")) {
      while (i < chars.length && chars[i] !== "\n") chars[i++] = " ";
      i -= 1; continue;
    }
    if (c === "\"" || c === "'" || (!python && c === "`")) {
      triple = python && next === c && third === c; quote = c; chars[i] = " ";
      if (triple) { chars[i + 1] = chars[i + 2] = " "; i += 2; }
    }
  }
  return chars.join("");
}

export function referencesFor(language: string, parser: string, content: string): RawReference[] {
  const out: RawReference[] = [];
  const lineAt = lineLocator(content);
  const callableCode = maskNonCode(content, language === "python");
  const add = (re: RegExp, kind: SemanticKind, confidence: number, group = 1, forceLocal = false): void => {
    for (const match of content.matchAll(re)) {
      const specifier = match[group]?.trim();
      if (specifier) out.push({ kind, specifier, line: lineAt(match.index ?? 0), parser, confidence, forceLocal });
    }
  };
  const addBoundCalls = (binding: string, specifier: string, namespace: boolean, callParser: string, confidence: number): void => {
    if (!/^[A-Za-z_$][\w$]*$/.test(binding)) return;
    const escaped = binding.replace(/[$]/g, "\\$");
    const re = namespace
      ? new RegExp(`\\b${escaped}\\s*(?:\\?\\.|\\.)\\s*[A-Za-z_$][\\w$]*\\s*\\(`, "g")
      : new RegExp(`\\b${escaped}\\s*(?:\\?\\.)?\\(`, "g");
    for (const match of callableCode.matchAll(re)) {
      out.push({ kind: "call", specifier, line: lineAt(match.index ?? 0), parser: callParser, confidence, offset: match.index ?? 0 });
    }
  };

  if (language === "typescript" || language === "javascript") {
    add(/\b(?:import|export)\s+(?:type\s+)?(?:[^;"']*?\s+from\s*)?["']([^"']+)["']/g, "import", 0.88);
    add(/\brequire\s*\(\s*["']([^"']+)["']\s*\)/g, "import", 0.84);
    add(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g, "import", 0.82);
    for (const match of content.matchAll(/\bimport\s+(?!type\b)(?:[A-Za-z_$][\w$]*\s*,\s*)?\{([^}]+)\}\s+from\s*["']([^"']+)["']/g)) {
      for (const item of match[1].split(",")) {
        const part = item.trim(); if (!part || part.startsWith("type ")) continue;
        const names = part.split(/\s+as\s+/); addBoundCalls((names[1] ?? names[0]).trim(), match[2], false, "regex:ts-js-import-call-v1", 0.72);
      }
    }
    for (const match of content.matchAll(/\bimport\s+(?:[A-Za-z_$][\w$]*\s*,\s*)?\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s*["']([^"']+)["']/g)) addBoundCalls(match[1], match[2], true, "regex:ts-js-import-call-v1", 0.74);
    for (const match of content.matchAll(/\bimport\s+(?!type\b)([A-Za-z_$][\w$]*)\s*(?:,\s*(?:\{[^}]*\}|\*\s+as\s+[A-Za-z_$][\w$]*))?\s+from\s*["']([^"']+)["']/g)) addBoundCalls(match[1], match[2], false, "regex:ts-js-import-call-v1", 0.72);
  } else if (language === "python") {
    for (const match of content.matchAll(/^\s*from\s+([.\w]+)\s+import\s+([^#\n]+)/gm)) {
      let specifier = match[1];
      if (/^\.+$/.test(specifier)) {
        const imported = match[2].split(",")[0].trim().split(/\s+as\s+/)[0];
        if (imported && imported !== "*") specifier += imported;
      }
      out.push({ kind: "import", specifier, line: lineAt(match.index ?? 0), parser, confidence: 0.84 });
      for (const item of match[2].split(",")) {
        const names = item.trim().replace(/[()]/g, "").split(/\s+as\s+/); const original = names[0];
        if (!original || original === "*") continue;
        const binding = (names[1] ?? original).trim(); const target = /^\.+$/.test(match[1]) ? match[1] + original : match[1];
        addBoundCalls(binding, target, false, "regex:python-import-call-v1", 0.68);
        addBoundCalls(binding, target, true, "regex:python-import-call-v1", 0.7);
      }
    }
    for (const match of content.matchAll(/^\s*import\s+([^#\n]+)/gm)) {
      for (const item of match[1].split(",")) {
        const specifier = item.trim().split(/\s+as\s+/)[0];
        if (!specifier) continue;
        out.push({ kind: "import", specifier, line: lineAt(match.index ?? 0), parser, confidence: 0.82 });
        const alias = item.trim().split(/\s+as\s+/)[1] ?? specifier.split(".")[0];
        addBoundCalls(alias, specifier, false, "regex:python-import-call-v1", 0.66);
        addBoundCalls(alias, specifier, true, "regex:python-import-call-v1", 0.7);
      }
    }
  } else if (language === "go") {
    add(/\bimport\s+(?:[\w.]+\s+)?["`]([^"`]+)["`]/g, "import", 0.88);
    for (const block of content.matchAll(/\bimport\s*\(([\s\S]*?)\)/g)) for (const item of block[1].matchAll(/["`]([^"`]+)["`]/g)) out.push({ kind: "import", specifier: item[1], line: lineAt((block.index ?? 0) + (item.index ?? 0)), parser, confidence: 0.86 });
  } else if (language === "rust") {
    add(/^\s*use\s+([^;]+);/gm, "import", 0.78); add(/^\s*mod\s+([A-Za-z_]\w*)\s*;/gm, "import", 0.86, 1, true);
  } else if (language === "java" || language === "kotlin") add(/^\s*import\s+(?:static\s+)?([\w.*]+)(?:\s+as\s+\w+)?\s*;?/gm, "import", 0.86);
  else if (language === "csharp") add(/^\s*(?:global\s+)?using\s+(?:\w+\s*=\s*)?([\w.]+)\s*;/gm, "import", 0.78);
  else if (language === "protobuf") add(/^\s*import\s+(?:public\s+|weak\s+)?["']([^"']+)["']\s*;/gm, "contract", 0.95, 1, true);
  else if (language === "graphql") add(/^\s*#import\s+["']([^"']+)["']/gm, "contract", 0.9, 1, true);

  add(/["'`]([^"'`\n]+\.(?:proto|graphql|gql))(?:#[^"'`]*)?["'`]/gi, "contract", 0.88, 1, true);
  add(/["'`]([^"'`\n]*(?:openapi|swagger|asyncapi|contracts?|schemas?)[^"'`\n]*\.(?:ya?ml|json))(?:#[^"'`]*)?["'`]/gi, "contract", 0.82, 1, true);
  add(/\$ref\s*[:=]\s*["']([^"']+)["']/gi, "contract", 0.86, 1, true);
  add(/\b(?:fetch|axios\.(?:get|post|put|patch|delete)|requests\.(?:get|post|put|patch|delete)|http\.(?:Get|Post)|GrpcChannel\.ForAddress)\s*\(\s*["']([^"']+)["']/g, "http", 0.68);
  add(/\b(?:grpc\.(?:Dial|insecure_channel|secure_channel)|new\s+\w*(?:Client|Stub))\s*\(?\s*["']?([^"'\s,)]+)?/g, "grpc", 0.56);
  add(/(?:DllImport\s*\(|ctypes\.(?:CDLL|PyDLL)\s*\(|dlopen\s*\(|ffi\.Library\s*\()\s*["']([^"']+)["']/g, "ffi", 0.82);
  if (/extern\s+["']C["']|import\s+["']C["']/.test(content)) out.push({ kind: "ffi", specifier: "C ABI", line: 1, parser, confidence: 0.72 });
  if (/\b(?:gql|graphql)\s*`|\b(?:useQuery|useMutation)\s*\(/.test(content)) out.push({ kind: "contract", specifier: "inline GraphQL", line: 1, parser, confidence: 0.62 });
  return [...new Map(out.map((r) => [`${r.kind}|${r.line}|${r.specifier}|${r.kind === "call" ? r.offset ?? "" : ""}`, r])).values()];
}

/**
 * Select the strongest built-in analyzer. Regex extraction is retained only as an
 * explicit, provenance-labelled fallback for languages without an embedded parser.
 */
export function analyzeSource(rel: string, language: string, parser: string, content: string): SemanticParseResult {
  if (language === "typescript" || language === "javascript") {
    try {
      return analyzeTypeScriptSource(rel, content);
    } catch (error) {
      const fallback = "regex:ts-js-fallback-v2";
      return {
        references: referencesFor(language, fallback, content),
        exports: [],
        analyzer: {
          id: fallback,
          family: "regex-fallback",
          assurance: "heuristic",
          engine: "pm-mcp masked-regex fallback",
          version: "2",
          capabilities: ["imports", "calls", "contracts", "http", "grpc", "ffi"],
        },
        status: "partial",
        diagnostics: [`TypeScript compiler analyzer failed: ${error instanceof Error ? error.message : String(error)}`],
        limitations: ["Compiler AST analysis failed; all emitted relations are heuristic fallback evidence."],
      };
    }
  }
  if (supportsPolyglotAstLanguage(language)) {
    // Parser/ABI failures intentionally propagate: an unavailable AST provider
    // must not be converted into a green heuristic result. Syntax recovery is
    // represented as partial by the provider and rejected by strict policy.
    return analyzePolyglotAstSource(rel, language, content);
  }
  const references = referencesFor(language, parser, content);
  const capabilities = [...new Set(references.map((reference) => reference.kind === "export" ? "exports" : reference.kind === "import" ? "imports" : reference.kind === "call" ? "calls" : reference.kind))] as AnalyzerProvenance["capabilities"];
  if (capabilities.length === 0) capabilities.push("imports");
  return {
    references,
    exports: [],
    analyzer: {
      id: parser,
      family: "regex-fallback",
      assurance: "heuristic",
      engine: "pm-mcp masked-regex fallback",
      version: "1",
      capabilities,
    },
    status: "complete",
    diagnostics: [],
    limitations: ["No embedded language-native AST analyzer is available; emitted relations are heuristic fallback evidence."],
  };
}

export function contractKind(rel: string, content: string): "openapi" | "protobuf" | "graphql" | null {
  if (/\.proto$/i.test(rel) || /^\s*syntax\s*=\s*["']proto[23]["']/m.test(content)) return "protobuf";
  if (/\.(graphql|gql)$/i.test(rel) || /^\s*(?:schema\s*\{|type\s+(?:Query|Mutation)\b)/m.test(content)) return "graphql";
  if (/\.(?:ya?ml|json)$/i.test(rel) && /(?:^\s*openapi\s*:|["']openapi["']\s*:|^\s*swagger\s*:)/m.test(content)) return "openapi";
  return null;
}

export function candidates(from: string, specifier: string, language: string, ownerRoots: readonly string[] = []): string[] {
  const clean = specifier.split(/[?#]/, 1)[0].replace(/\\/g, "/"); const bases = new Set<string>();
  if (clean.startsWith(".")) {
    if (language === "python" && /^\.+[\w.]*$/.test(clean)) {
      const dots = clean.match(/^\.+/)?.[0].length ?? 1; let base = path.posix.dirname(from);
      for (let i = 1; i < dots; i += 1) base = path.posix.dirname(base);
      bases.add(path.posix.join(base, clean.slice(dots).replace(/\./g, "/")));
    } else bases.add(path.posix.join(path.posix.dirname(from), clean));
  } else if (clean.startsWith("/")) bases.add(clean.slice(1));
  else {
    const logical = /^(?:python|java|kotlin|csharp)$/.test(language) ? clean.replace(/\./g, "/").replace(/\/\*$/, "") : clean.replace(/::/g, "/");
    bases.add(logical.replace(/^crate\//, ""));
    for (const root of ownerRoots) bases.add(path.posix.join(normalizedRoot(root), logical.replace(/^crate\//, "")));
  }
  const out = new Set<string>();
  for (const raw of bases) {
    const base = relPath(path.posix.normalize(raw));
    if (base === ".." || base.startsWith("../")) continue;
    out.add(base);
    if (!path.posix.extname(base)) {
      for (const ext of RESOLVE_EXTS) out.add(base + ext);
      for (const ext of RESOLVE_EXTS) out.add(`${base}/index${ext}`);
      out.add(`${base}/__init__.py`); out.add(`${base}/mod.rs`);
    }
  }
  return [...out];
}
