import test from "node:test";
import assert from "node:assert/strict";
import {
  POLYGLOT_AST_LANGUAGES,
  analyzePolyglotAstSource,
  supportsPolyglotAstLanguage,
  type PolyglotAstLanguage,
} from "../src/polyglot-ast.ts";

interface Fixture {
  source: string;
  grammarVersion: string;
  expected: Array<[kind: string, specifier: string, line: number, symbol?: string]>;
}

const fixtures: Record<PolyglotAstLanguage, Fixture> = {
  python: {
    grammarVersion: "0.0.6",
    source: [
      "from .core import run as execute",
      "import os.path as osp",
      "# import ghost.module",
      "execute()",
      "osp.join(\"a\", \"b\")",
      "local_call()",
      "native = ctypes.CDLL(\"../native/libcore.so\")",
      "schema = \"../contracts/service.proto\"",
      "",
    ].join("\n"),
    expected: [
      ["import", ".core", 1, undefined],
      ["import", "os.path", 2, undefined],
      ["call", ".core", 4, "run"],
      ["call", "os.path", 5, "*"],
      ["ffi", "../native/libcore.so", 7, undefined],
      ["contract", "../contracts/service.proto", 8, undefined],
    ],
  },
  go: {
    grammarVersion: "0.0.6",
    source: [
      "package main",
      "import (",
      " \"fmt\"",
      " core \"example.test/core\"",
      " \"C\"",
      ")",
      "func main() {",
      " core.Run()",
      " fmt.Println(\"x\")",
      " local()",
      "}",
      "var schema = \"../contracts/openapi.yaml\"",
      "",
    ].join("\n"),
    expected: [
      ["import", "fmt", 3, undefined],
      ["import", "example.test/core", 4, undefined],
      ["ffi", "C ABI", 5, undefined],
      ["call", "example.test/core", 8, "*"],
      ["call", "fmt", 9, "*"],
      ["contract", "../contracts/openapi.yaml", 12, undefined],
    ],
  },
  rust: {
    grammarVersion: "0.0.7",
    source: [
      "mod util;",
      "use crate::core::Thing;",
      "use crate::core::run as execute;",
      "extern \"C\" { fn run(); }",
      "fn main() {",
      " Thing::new();",
      " execute();",
      " local();",
      "}",
      "const SCHEMA: &str = \"../contracts/schema.graphql\";",
      "",
    ].join("\n"),
    expected: [
      ["import", "util", 1, undefined],
      ["import", "crate::core::Thing", 2, undefined],
      ["import", "crate::core::run", 3, undefined],
      ["ffi", "C ABI", 4, undefined],
      ["call", "crate::core::Thing", 6, "Thing"],
      ["call", "crate::core::run", 7, "run"],
      ["contract", "../contracts/schema.graphql", 10, undefined],
    ],
  },
  java: {
    grammarVersion: "0.0.7",
    source: [
      "import static com.acme.Util.run;",
      "import com.acme.Core;",
      "class Main {",
      " static { System.loadLibrary(\"core_native\"); }",
      " void invoke() {",
      "  run();",
      "  Core.execute();",
      "  local();",
      " }",
      " String schema = \"../contracts/service.proto\";",
      "}",
      "",
    ].join("\n"),
    expected: [
      ["import", "com.acme.Util.run", 1, undefined],
      ["import", "com.acme.Core", 2, undefined],
      ["ffi", "core_native", 4, undefined],
      ["call", "com.acme.Util.run", 6, "run"],
      ["call", "com.acme.Core", 7, "Core"],
      ["contract", "../contracts/service.proto", 10, undefined],
    ],
  },
  kotlin: {
    grammarVersion: "0.0.7",
    source: [
      "import com.acme.Core as C",
      "import com.acme.execute",
      "fun main() {",
      " System.loadLibrary(\"core_native\")",
      " C.run()",
      " execute()",
      " local()",
      " val schema = \"../contracts/schema.graphql\"",
      "}",
      "",
    ].join("\n"),
    expected: [
      ["import", "com.acme.Core", 1, undefined],
      ["import", "com.acme.execute", 2, undefined],
      ["ffi", "core_native", 4, undefined],
      ["call", "com.acme.Core", 5, "Core"],
      ["call", "com.acme.execute", 6, "execute"],
      ["contract", "../contracts/schema.graphql", 8, undefined],
    ],
  },
  csharp: {
    grammarVersion: "0.0.6",
    source: [
      "global using IO = System.IO;",
      "using App.Core;",
      "class Native {",
      " [DllImport(\"native.dll\")]",
      " static extern int Run();",
      " static void Invoke() {",
      "  IO.File.Open(\"x\");",
      "  Local();",
      " }",
      " const string Schema = \"../contracts/openapi.json\";",
      "}",
      "",
    ].join("\n"),
    expected: [
      ["import", "System.IO", 1, undefined],
      ["import", "App.Core", 2, undefined],
      ["ffi", "native.dll", 4, undefined],
      ["call", "System.IO", 7, "*"],
      ["contract", "../contracts/openapi.json", 10, undefined],
    ],
  },
};

test("Tree-sitter provider extracts an exact AST-backed polyglot oracle", () => {
  assert.deepEqual(POLYGLOT_AST_LANGUAGES, ["python", "go", "rust", "java", "kotlin", "csharp"]);
  for (const language of POLYGLOT_AST_LANGUAGES) {
    const fixture = fixtures[language];
    const result = analyzePolyglotAstSource(`fixture.${language}`, language, fixture.source);
    assert.equal(result.status, "complete", `${language}: ${result.diagnostics.join("; ")}`);
    assert.deepEqual(
      result.references.map((item) => [item.kind, item.specifier, item.line, item.symbol]),
      fixture.expected,
      `${language} exact reference set`,
    );
    assert.deepEqual(result.exports, []);
    assert.deepEqual(result.diagnostics, []);
    assert.equal(result.analyzer.id, `tree-sitter:${language}@${fixture.grammarVersion}`);
    assert.equal(result.analyzer.family, "structured-parser");
    assert.equal(result.analyzer.assurance, "ast");
    assert.equal(result.analyzer.version, `0.45.3+grammar-${fixture.grammarVersion}`);
    assert.deepEqual(result.analyzer.capabilities, ["imports", "calls", "contracts", "ffi"]);
    assert.ok(result.references.every((item) => item.parser === result.analyzer.id && (item.confidence === 0.98 || item.confidence === 0.96)));
    assert.ok(!result.references.some((item) => item.kind === "call" && item.specifier.includes("local")), `${language} must not guess local calls`);
  }
});

test("syntax recovery is fail-closed for every bundled grammar", () => {
  const invalid: Record<PolyglotAstLanguage, string> = {
    python: "from import",
    go: "package main\nimport (",
    rust: "use ;",
    java: "import ; class X {}",
    kotlin: "import\nfun x() {}",
    csharp: "using ; class X {}",
  };
  for (const language of POLYGLOT_AST_LANGUAGES) {
    const result = analyzePolyglotAstSource(`broken.${language}`, language, invalid[language]);
    assert.equal(result.status, "partial", language);
    assert.deepEqual(result.references, [], `${language} recovered nodes must not leak evidence`);
    assert.ok(result.diagnostics.length > 0, `${language} must explain the parse failure`);
  }
});

test("unsupported languages throw instead of silently falling back", () => {
  assert.equal(supportsPolyglotAstLanguage("python"), true);
  assert.equal(supportsPolyglotAstLanguage("ruby"), false);
  assert.throws(() => analyzePolyglotAstSource("x.rb", "ruby", "require 'x'"), /Unsupported polyglot AST language/);
});
