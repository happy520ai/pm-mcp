import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { after } from "node:test";
import { buildSemanticGraph, impactAnalysis, moduleForFile, type GovernanceFileLike } from "../src/semantic-graph.ts";
import { mkProj } from "./helpers.ts";

const roots: string[] = [];
after(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });

function fixture(): string {
  const root = mkProj({
    "apps/web/src/main.ts": [
      "import { b } from '../../../packages/b/index.ts';",
      "const lazy = import('../../../python/worker.py');",
      "fetch('https://api.example.test/v1');",
      "const contract = '../../../contracts/service.proto';",
    ].join("\n"),
    "packages/b/index.ts": "export { a } from '../../apps/web/src/main.ts';\n",
    "packages/b/deep/tool.ts": "export const deep = true;\n",
    "apps/web/src/calls.ts": [
      "import Worker, { b as invokeB } from '../../../packages/b/index.ts';",
      "import * as bns from '../../../packages/b/index.ts';",
      "invokeB(); Worker(); bns.b();",
      "const text = 'invokeB('; // string/comment must not create calls",
    ].join("\n"),
    "python/worker.py": "from . import helper\nimport json\n",
    "python/helper.py": "value = 1\n",
    "python/calls.py": [
      "from .helper import value as invoke",
      "import worker as worker_alias",
      "invoke()",
      "worker_alias.run()",
      "text = 'invoke('",
    ].join("\n"),
    "go/main.go": "package main\nimport \"fmt\"\nimport \"example.test/packages/b\"\n",
    "rust/lib.rs": "mod util;\nuse std::fmt;\n",
    "rust/util.rs": "pub struct Thing;\n",
    "jvm/Main.java": "import java.util.List;\nclass Main {}\n",
    "dotnet/Native.cs": "using System.Text;\n[DllImport(\"../native/lib.rs\")] static extern int run();\n",
    "native/lib.rs": "#[no_mangle] pub extern \"C\" fn run() -> i32 { 1 }\n",
    "contracts/service.proto": "syntax = \"proto3\";\nservice Greeter {}\n",
    "contracts/openapi.yaml": "openapi: 3.1.0\ninfo:\n  title: Demo\n  version: 1.0.0\n",
    "contracts/schema.graphql": "type Query { hello: String }\n",
    "docs/unknown.xyz": "not parsed\n",
  });
  roots.push(root);
  return root;
}

const governance: GovernanceFileLike = {
  modules: [
    { id: "web", roots: ["apps", "apps/web"], depends_on: [], allowed_dependencies: ["contracts"], denied_dependencies: ["b"] },
    { id: "b", roots: ["packages/b"], depends_on: [], allowed_dependencies: ["contracts"], denied_dependencies: [] },
    { id: "python", roots: ["python"], depends_on: [], allowed_dependencies: [], denied_dependencies: [] },
    { id: "go", roots: ["go"], depends_on: ["b"], allowed_dependencies: ["b"], denied_dependencies: [] },
    { id: "rust", roots: ["rust"], depends_on: [], allowed_dependencies: [], denied_dependencies: [] },
    { id: "jvm", roots: ["jvm"], depends_on: [], allowed_dependencies: [], denied_dependencies: [] },
    { id: "dotnet", roots: ["dotnet"], depends_on: ["native"], allowed_dependencies: ["native"], denied_dependencies: [] },
    { id: "native", roots: ["native"], depends_on: [], allowed_dependencies: [], denied_dependencies: [] },
    { id: "contracts", roots: ["contracts"], public_interfaces: ["contracts-api"], depends_on: [], allowed_dependencies: [], denied_dependencies: [] },
  ],
  interfaces: [{ id: "contracts-api", provider: "contracts", consumers: ["web"], contract_files: ["contracts/service.proto"] }],
  policies: { enforce_declared_dependencies: true },
};

test("longest module root wins and built-in compiler/Tree-sitter provenance is auditable", () => {
  const root = fixture();
  assert.equal(moduleForFile("apps/web/src/main.ts", governance.modules), "web");
  const graph = buildSemanticGraph(root, governance);
  const parsers = new Set(graph.fileEdges.map((e) => e.parser));
  assert.ok([...parsers].some((parser) => parser.startsWith("typescript:compiler-api-ast@")), "TypeScript/JavaScript must use compiler AST");
  for (const expected of ["tree-sitter:python@0.0.6", "tree-sitter:go@0.0.6", "tree-sitter:rust@0.0.7", "tree-sitter:java@0.0.7", "tree-sitter:csharp@0.0.6"]) {
    assert.ok(parsers.has(expected), `missing ${expected}`);
  }
  assert.equal(graph.analysis.parser, "hybrid-semantic-v2");
  assert.equal(graph.analysis.confidence, "mixed");
  assert.ok(graph.analysis.analyzers.some((analyzer) => analyzer.family === "compiler-ast" && analyzer.assurance === "ast"));
  assert.ok(graph.analysis.analyzers.some((analyzer) => analyzer.id === "tree-sitter:python@0.0.6" && analyzer.assurance === "ast"));
  assert.ok(!graph.analysis.fallbackFiles.some((file) => /\.(?:py|go|rs|java|kt|kts|cs)$/.test(file)), "bundled languages must not downgrade to regex");
  assert.ok(graph.analysis.fallbackFiles.every((file) => /\.(?:proto|graphql|gql|ya?ml|json)$/.test(file)), "only contract parsers are heuristic in this fixture");
  assert.equal(graph.files.find((file) => file.path === "apps/web/src/main.ts")?.analyzers[0]?.engine, "TypeScript Compiler API");
  assert.equal(graph.files.find((file) => file.path === "python/worker.py")?.analyzers[0]?.engine, "ast-grep Tree-sitter");
  assert.ok(graph.fileEdges.every((e) => e.confidence > 0 && e.confidence < 1));
  assert.ok(graph.coverage.unknownFiles.includes("docs/unknown.xyz"));
});

test("builds file/module edges, contracts, cycles and governance violations", () => {
  const graph = buildSemanticGraph(fixture(), governance);
  assert.ok(graph.fileEdges.some((e) => e.from === "apps/web/src/main.ts" && e.to === "packages/b/index.ts"));
  assert.ok(graph.fileEdges.some((e) => e.from === "python/worker.py" && e.to === "python/helper.py"));
  assert.ok(graph.fileEdges.some((e) => e.from === "dotnet/Native.cs" && e.to === "native/lib.rs" && e.kind === "ffi"));
  assert.ok(graph.fileEdges.some((e) => e.from === "apps/web/src/main.ts" && e.to === "contracts/service.proto" && e.kind === "contract"));
  assert.deepEqual(new Set(graph.contracts.map((c) => c.kind)), new Set(["protobuf", "openapi", "graphql"]));
  assert.ok(graph.cycles.some((cycle) => cycle.includes("web") && cycle.includes("b")));
  assert.ok(graph.violations.some((v) => v.type === "denied-dependency" && v.from === "web" && v.to === "b"));
  assert.ok(graph.violations.some((v) => v.type === "not-allowed-dependency" && v.from === "b" && v.to === "web"));
  assert.ok(graph.violations.some((v) => v.type === "undeclared-dependency" && v.from === "b" && v.to === "web"));
  assert.ok(!graph.violations.some((v) => v.from === "web" && v.to === "contracts" && v.type === "undeclared-dependency"), "declared interface is sufficient evidence");
});

test("reports unresolved local edges and computes reverse impact closure", () => {
  const root = fixture();
  fs.appendFileSync(`${root}/apps/web/src/main.ts`, "\nimport './missing.ts';\n", "utf8");
  const graph = buildSemanticGraph(root, governance);
  assert.ok(graph.unresolved.some((e) => e.specifier === "./missing.ts"));
  assert.ok(graph.coverage.resolutionPct < 100);

  const contractImpact = impactAnalysis(graph, ["contracts/service.proto"]);
  assert.ok(contractImpact.dependentFiles.includes("apps/web/src/main.ts"));
  assert.ok(contractImpact.impactedModules.includes("web"));
  const nativeImpact = impactAnalysis(graph, ["native/lib.rs", "ghost.ts"]);
  assert.ok(nativeImpact.dependentFiles.includes("dotnet/Native.cs"));
  assert.deepEqual(nativeImpact.unknownChangedFiles, ["ghost.ts"]);
});

test("emits conservative TypeScript and Python call edges only for invoked import bindings", () => {
  const graph = buildSemanticGraph(fixture(), governance);
  const tsCalls = graph.fileEdges.filter((e) => e.from === "apps/web/src/calls.ts" && e.kind === "call");
  assert.equal(tsCalls.length, 3, "named alias, default, and namespace member calls are captured once");
  assert.ok(tsCalls.every((e) => e.to === "packages/b/index.ts" && e.parser.startsWith("typescript:compiler-api-ast@")));
  assert.deepEqual(tsCalls.map((edge) => edge.symbol).sort(), ["*", "b", "default"]);
  const pyCalls = graph.fileEdges.filter((e) => e.from === "python/calls.py" && e.kind === "call");
  assert.deepEqual(
    pyCalls.map((edge) => `${edge.to}|${edge.line}`).sort(),
    ["python/helper.py|3", "python/worker.py|4"],
    "Tree-sitter captures from-import and module aliases exactly; string text is ignored",
  );
  assert.ok(pyCalls.every((edge) => edge.parser === "tree-sitter:python@0.0.6"));
  assert.ok([...tsCalls, ...pyCalls].every((e) => e.confidence < graph.fileEdges.find((i) => i.from === e.from && i.kind === "import" && i.specifier === e.specifier)!.confidence));
  assert.ok(graph.moduleEdges.some((e) => e.kinds.includes("call")), "module aggregation includes call evidence");
});

test("enforces public interfaces, ownership, unresolved and source-only coverage policies", () => {
  const root = fixture();
  const additions: Record<string, string> = {
    "packages/b/public.proto": "syntax = \"proto3\";\nservice PublicApi {}\n",
    "apps/web/src/public.mts": "export const contract = '../../../packages/b/public.proto';\n",
    "apps/web/src/private.cts": "const privateApi = require('../../../packages/b/index.ts');\n",
    "apps/web/src/broken.ts": "import './does-not-exist.ts';\n",
    "orphan.ts": "export const orphan = true;\n",
    "legacy/old.rb": "puts 'unknown source parser'\n",
    "README.md": "documentation must not lower source coverage\n",
    "LICENSE": "MIT\n",
    "package-lock.json": "{}\n",
  };
  for (const [rel, content] of Object.entries(additions)) {
    const abs = `${root}/${rel}`;
    fs.mkdirSync(abs.slice(0, abs.lastIndexOf("/")), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");
  }
  const strict: GovernanceFileLike = {
    modules: governance.modules.map((module) => ({
      ...module,
      owners: [`team-${module.id}`],
      public_interfaces: module.id === "b" ? ["b-api"] : [],
      depends_on: module.id === "web" ? ["b", "contracts"] : module.depends_on,
    })),
    interfaces: [
      { id: "b-api", provider: "b", consumers: ["web"], contract_files: ["packages/b/public.proto"] },
      ...(governance.interfaces ?? []),
    ],
    policies: {
      enforce_declared_dependencies: true,
      enforce_public_interfaces: true,
      enforce_ownership: true,
      fail_on_unresolved: true,
      minimum_coverage_pct: 100,
    },
  };
  const graph = buildSemanticGraph(root, strict);
  const publicEdge = graph.fileEdges.find((e) => e.from === "apps/web/src/public.mts" && e.to === "packages/b/public.proto");
  assert.equal(publicEdge?.interfaceId, "b-api");
  assert.ok(!graph.violations.some((v) => v.type === "private-interface" && v.evidence.some((e) => e.includes("public.mts"))));
  assert.ok(graph.violations.some((v) => v.type === "private-interface" && v.evidence.some((e) => e.includes("private.cts"))), "depends_on must not expose private implementation files");
  assert.ok(graph.violations.some((v) => v.type === "unowned-file" && v.from === "orphan.ts"));
  assert.ok(graph.violations.some((v) => v.type === "unresolved-reference" && v.evidence.some((e) => e.includes("does-not-exist.ts"))));
  assert.ok(graph.violations.some((v) => v.type === "coverage-below-policy"));
  assert.ok(graph.coverage.sourceCoveragePct < 100);
  assert.ok(graph.coverage.sourceCandidateFiles < graph.coverage.totalFiles, "README/LICENSE/lockfile are outside the policy denominator");
  assert.ok(graph.fileEdges.some((e) => e.from.endsWith(".mts") && e.parser.startsWith("typescript:compiler-api-ast@")));
  assert.ok(graph.fileEdges.some((e) => e.from.endsWith(".cts") && e.parser.startsWith("typescript:compiler-api-ast@")));
  assert.ok(graph.violations.every((v) => v.evidence.length > 0));
});

test("默认排除测试 fixture，普通 JSON 文件名不冒充跨语言契约", () => {
  const root = mkProj({
    "src/app.ts": "const ledger = 'project.json';\nexport const app = ledger;\n",
    "test/fixture.test.ts": "const sample = \"import x from './missing.ts'\";\n",
  });
  roots.push(root);
  const graph = buildSemanticGraph(root, {
    modules: [{ id: "app", roots: ["src"], owners: ["team"], public_interfaces: [], depends_on: [], allowed_dependencies: [], denied_dependencies: [] }],
    interfaces: [],
    policies: { enforce_declared_dependencies: true, enforce_ownership: true, fail_on_unresolved: true, enforce_public_interfaces: true, minimum_coverage_pct: 100 },
  });
  assert.equal(graph.unresolved.length, 0);
  assert.ok(!graph.files.some((file) => file.path.includes("fixture.test.ts")));
});
