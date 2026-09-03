import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { analyzeTypeScriptSource } from "../src/typescript-semantic.ts";
import { semanticContentHash, verifySemanticEvidence } from "../src/semantic-evidence.ts";
import { buildSemanticGraph, type GovernanceFileLike } from "../src/semantic-graph.ts";
import { mkProj } from "./helpers.ts";

const roots: string[] = [];
after(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });

test("TypeScript compiler AST has exact import/export/symbol-bound-call oracle", () => {
  const content = [
    "import DefaultThing, { remote as invoke, type Shape } from './dep.ts';",
    "import * as ns from './ns.ts';",
    "import type { OnlyType } from './types.ts';",
    "invoke(); new DefaultThing(); ns.run();",
    "function shadow(invoke: () => void) { invoke(); }",
    "const text = 'ns.fake()'; // invoke()",
    "void import('./lazy.ts');",
    "export { publicApi as exposed } from './public.ts';",
    "export type { Contract } from './contract.ts';",
    "export const own = 1;",
    "fetch('https://api.example.test/v1');",
  ].join("\n");
  const result = analyzeTypeScriptSource("src/main.ts", content);

  assert.equal(result.status, "complete");
  assert.equal(result.analyzer.family, "compiler-ast");
  assert.equal(result.analyzer.assurance, "ast");
  assert.deepEqual(
    result.references.map((item) => `${item.kind}|${item.specifier}|${item.symbol ?? ""}|${item.line}`).sort(),
    [
      "call|./dep.ts|default|4",
      "call|./dep.ts|remote|4",
      "call|./ns.ts|*|4",
      "export|./contract.ts||9",
      "export|./public.ts||8",
      "http|https://api.example.test/v1||11",
      "import|./dep.ts||1",
      "import|./lazy.ts||7",
      "import|./ns.ts||2",
      "import|./types.ts||3",
    ].sort(),
    "shadowed calls, comments, and strings must add no edges",
  );
  assert.deepEqual(
    result.exports.map((item) => `${item.name}|${item.sourceSpecifier ?? ""}|${item.isTypeOnly}|${item.line}`).sort(),
    ["Contract|./contract.ts|true|9", "exposed|./public.ts|false|8", "own||false|10"].sort(),
  );
});

const pythonGovernance: GovernanceFileLike = {
  modules: [{ id: "python", roots: ["python"], owners: ["team-python"], depends_on: [], allowed_dependencies: [], denied_dependencies: [], public_interfaces: [] }],
  interfaces: [],
  policies: { enforce_declared_dependencies: true, enforce_ownership: true, fail_on_unresolved: true },
};

function nativeDocument(file: string, content: string, references: unknown[] = [], exports: unknown[] = []): unknown {
  return {
    schema_version: 1,
    file,
    language: "python",
    content_sha256: semanticContentHash(content),
    generated_at: "2026-09-02T00:00:00.000Z",
    status: "complete",
    analyzer: {
      id: "python:external-tree-sitter-test@1",
      family: "language-native-ast",
      assurance: "ast",
      engine: "tree-sitter-python test provider",
      version: "1",
      capabilities: ["imports", "exports", "calls"],
    },
    references,
    exports,
    diagnostics: [],
  };
}

function runtimeDocument(file: string, content: string, references: unknown[] = [], language = "python"): unknown {
  return {
    schema_version: 1,
    file,
    language,
    content_sha256: semanticContentHash(content),
    generated_at: "2026-09-02T00:00:01.000Z",
    status: "complete",
    analyzer: {
      id: "python:runtime-trace-test@1",
      family: "runtime-trace",
      assurance: "runtime",
      engine: "instrumented Python test provider",
      version: "1",
      capabilities: ["calls"],
    },
    references,
    exports: [],
    diagnostics: [],
  };
}

test("built-in Python AST passes strict policy and hash-bound external AST can enhance it", () => {
  const app = "from .helper import run\nrun()\n";
  const helper = "def run():\n    return 1\n";
  const root = mkProj({ "python/app.py": app, "python/helper.py": helper });
  roots.push(root);

  const builtIn = buildSemanticGraph(root, pythonGovernance, { minimumSemanticAssurance: "ast", failOnSemanticFallback: true });
  assert.deepEqual(builtIn.analysis.rejectedFiles, []);
  assert.deepEqual(builtIn.analysis.fallbackFiles, []);
  assert.equal(builtIn.coverage.astFiles, 2);
  assert.equal(builtIn.coverage.semanticAssurancePct, 100);
  assert.ok(builtIn.files.every((file) => file.parser === "tree-sitter:python@0.0.6"));
  assert.equal(builtIn.violations.filter((issue) => issue.type.startsWith("semantic-evidence")).length, 0);

  const appAst = nativeDocument("python/app.py", app, [
    { kind: "import", specifier: ".helper", line: 1, confidence: 0.99, force_local: true, symbol: "run" },
    { kind: "call", specifier: ".helper", line: 2, confidence: 0.98, force_local: true, symbol: "run" },
  ]);
  const helperAst = nativeDocument("python/helper.py", helper, [], [
    { name: "run", line: 1, is_type_only: false, confidence: 0.99 },
  ]);
  const accepted = buildSemanticGraph(root, pythonGovernance, {
    minimumSemanticAssurance: "ast",
    failOnSemanticFallback: true,
    semanticEvidence: [appAst, helperAst],
  });
  assert.deepEqual(accepted.analysis.rejectedFiles, []);
  assert.deepEqual(accepted.analysis.fallbackFiles, []);
  assert.equal(accepted.coverage.semanticAssurancePct, 100);
  assert.equal(accepted.coverage.astFiles, 2);
  assert.equal(accepted.coverage.resolutionPct, 100);
  assert.deepEqual(
    accepted.fileEdges.map((edge) => `${edge.kind}|${edge.from}|${edge.to}|${edge.symbol ?? ""}`).sort(),
    [
      "call|python/app.py|python/helper.py|run",
      "import|python/app.py|python/helper.py|run",
    ],
  );
  assert.deepEqual(accepted.exports.map((item) => `${item.file}|${item.name}`), ["python/helper.py|run"]);
  assert.equal(accepted.violations.filter((issue) => issue.type.startsWith("semantic-evidence")).length, 0);
});

test("stale external evidence is reported without replacing built-in AST; runtime tier requires AST plus trace", () => {
  const app = "from .helper import run\nrun()\n";
  const helper = "def run():\n    return 1\n";
  const root = mkProj({ "python/app.py": app, "python/helper.py": helper });
  roots.push(root);
  const goodAppAst = nativeDocument("python/app.py", app, [
    { kind: "import", specifier: ".helper", line: 1, confidence: 0.99, force_local: true, symbol: "run" },
    { kind: "call", specifier: ".helper", line: 2, confidence: 0.98, force_local: true, symbol: "run" },
  ]);
  const helperAst = nativeDocument("python/helper.py", helper);
  const stale = { ...(goodAppAst as Record<string, unknown>), content_sha256: "0".repeat(64) };
  const invalid = verifySemanticEvidence(stale, "python/app.py", app);
  assert.equal(invalid.ok, false);
  assert.deepEqual(invalid.errors, ["content hash mismatch for python/app.py"]);
  const staleGraph = buildSemanticGraph(root, pythonGovernance, {
    minimumSemanticAssurance: "ast",
    failOnSemanticFallback: true,
    semanticEvidence: [stale, helperAst],
  });
  assert.ok(staleGraph.analysis.evidenceErrors.some((error) => error.includes("content hash mismatch")));
  assert.deepEqual(staleGraph.analysis.rejectedFiles, [], "valid built-in AST remains available after stale optional evidence is rejected");
  assert.equal(staleGraph.files.find((file) => file.path === "python/app.py")?.parser, "tree-sitter:python@0.0.6");
  assert.ok(staleGraph.fileEdges.some((edge) => edge.from === "python/app.py" && edge.kind === "import"));
  assert.ok(staleGraph.violations.some((issue) => issue.type === "semantic-evidence-invalid" && issue.from === "python/app.py"));

  const appRuntime = runtimeDocument("python/app.py", app, [
    { kind: "call", specifier: ".helper", line: 2, confidence: 1, force_local: true, symbol: "run" },
  ]);
  const helperRuntime = runtimeDocument("python/helper.py", helper);
  const runtime = buildSemanticGraph(root, pythonGovernance, {
    minimumSemanticAssurance: "runtime",
    failOnSemanticFallback: true,
    semanticEvidence: [appRuntime, helperRuntime],
  });
  assert.deepEqual(runtime.analysis.rejectedFiles, []);
  assert.equal(runtime.coverage.runtimeFiles, 2);
  assert.equal(runtime.coverage.semanticAssurancePct, 100);
  assert.equal(runtime.fileEdges.find((edge) => edge.kind === "call")?.parser, "python:runtime-trace-test@1");

  const ruby = "require_relative 'helper'\nrun\n";
  const rubyRoot = mkProj({ "ruby/app.rb": ruby });
  roots.push(rubyRoot);
  const runtimeOnly = buildSemanticGraph(rubyRoot, {
    modules: [{ id: "ruby", roots: ["ruby"], owners: ["team-ruby"], depends_on: [], allowed_dependencies: [], denied_dependencies: [], public_interfaces: [] }],
    interfaces: [],
  }, {
    minimumSemanticAssurance: "runtime",
    semanticEvidence: [runtimeDocument("ruby/app.rb", ruby, [], "ruby")],
  });
  assert.deepEqual(runtimeOnly.analysis.rejectedFiles, ["ruby/app.rb"], "runtime trace cannot replace a static AST baseline");
});

test("strict AST plus failOnFallback rejects a real regex-only contract parser", () => {
  const root = mkProj({
    "contracts/base.proto": "syntax = \"proto3\";\nmessage Base {}\n",
    "contracts/service.proto": "syntax = \"proto3\";\nimport \"base.proto\";\nmessage Service {}\n",
  });
  roots.push(root);
  const graph = buildSemanticGraph(root, {
    modules: [{ id: "contracts", roots: ["contracts"], owners: ["team-contracts"], depends_on: [], allowed_dependencies: [], denied_dependencies: [], public_interfaces: [] }],
    interfaces: [],
  }, { minimumSemanticAssurance: "ast", failOnSemanticFallback: true });
  assert.deepEqual(graph.analysis.rejectedFiles, ["contracts/base.proto", "contracts/service.proto"]);
  assert.deepEqual(graph.analysis.fallbackFiles, ["contracts/base.proto", "contracts/service.proto"]);
  assert.equal(graph.fileEdges.length, 0, "rejected regex evidence cannot create an apparently trusted contract edge");
  assert.equal(graph.violations.filter((issue) => issue.type === "semantic-evidence-below-policy").length, 2);
});
