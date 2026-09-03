import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  AnalyzerProvenanceSchema,
  SemanticEvidenceDocumentSchema,
  assuranceRank,
  semanticContentHash,
  verifySemanticEvidence,
} from "../src/semantic-evidence.ts";
import { analyzeTypeScriptSource } from "../src/typescript-semantic.ts";
import { analyzeSource, candidates, contractKind, normalizedRoot, referencesFor, relPath } from "../src/semantic-parsers.ts";
import {
  DEPTH_LIMIT,
  countLoc,
  countSkipLines,
  extOf,
  isLockfile,
  isTestFile,
  listFiles,
  looksTrivialTest,
  needsSkipCount,
  readDirectDeps,
  scanProject,
  walkStatEntries,
} from "../src/scan.ts";
import { closeIndex } from "../src/index-store.ts";
import { fingerprintProject } from "../src/project-fingerprint.ts";
import { mkProj, writeRel } from "./helpers.ts";

const roots: string[] = [];
after(() => {
  for (const root of roots) {
    closeIndex(root);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function root(files: Record<string, string> = {}): string {
  const value = mkProj(files);
  roots.push(value);
  return value;
}

test("regex fallback extracts every supported relation without comments or string calls becoming code", () => {
  assert.equal(relPath("\\src\\a.ts"), "src/a.ts");
  assert.equal(normalizedRoot("./"), "");
  assert.equal(normalizedRoot("./src/"), "src");

  const ts = referencesFor("typescript", "fallback-ts", [
    "import Def, { run as invoke, type Shape, bad-name } from './dep';",
    "import * as ns from './space';",
    "const req = require('./required');",
    "void import('./lazy');",
    "invoke(); Def(); ns.work(); req.run();",
    "/* invoke(); ns.fake(); */",
    "const text = `Def()`; // req.fake()",
  ].join("\n"));
  assert.deepEqual(
    ts.filter((item) => item.kind === "import").map((item) => item.specifier).sort(),
    ["./dep", "./lazy", "./required", "./space"],
  );
  assert.deepEqual(ts.filter((item) => item.kind === "call").map((item) => item.specifier).sort(), ["./dep", "./dep", "./space"]);

  const python = referencesFor("python", "fallback-py", [
    "from . import helper as h",
    "from ..pkg import run as execute, *",
    "import alpha.beta as ab, gamma",
    "h(); execute(); ab.work(); gamma()",
    "triple = \"\"\"execute(); ab.fake()\"\"\"",
    "# gamma()",
  ].join("\n"));
  assert.deepEqual(python.filter((item) => item.kind === "import").map((item) => item.specifier).sort(), ["..pkg", ".helper", "alpha.beta", "gamma"]);
  assert.deepEqual(python.filter((item) => item.kind === "call").map((item) => item.specifier).sort(), ["..pkg", ".helper", "alpha.beta", "gamma"]);

  const languageCases: Array<[string, string, string[]]> = [
    ["go", "import alias `example/core`\nimport (\n `fmt`\n `example/other`\n)", ["example/core", "example/other", "fmt"]],
    ["rust", "use crate::core::Thing;\nmod local;", ["crate::core::Thing", "local"]],
    ["java", "import static com.acme.Run.go;\nimport com.acme.Core;", ["com.acme.Core", "com.acme.Run.go"]],
    ["kotlin", "import com.acme.Core as C", ["com.acme.Core"]],
    ["csharp", "global using IO = System.IO;\nusing App.Core;", ["App.Core", "System.IO"]],
  ];
  for (const [language, source, expected] of languageCases) {
    assert.deepEqual(referencesFor(language, `fallback-${language}`, source).filter((item) => item.kind === "import").map((item) => item.specifier).sort(), expected);
  }
  assert.deepEqual(referencesFor("protobuf", "fallback-proto", 'import public "base.proto";').map((item) => [item.kind, item.specifier]), [["contract", "base.proto"]]);
  assert.deepEqual(referencesFor("graphql", "fallback-graphql", '#import "base.graphql"').map((item) => [item.kind, item.specifier]), [["contract", "base.graphql"]]);

  const signals = referencesFor("ruby", "fallback-ruby", [
    "schema = 'contracts/service.proto#Greeter'",
    "api = 'schemas/openapi.yaml'",
    "$ref = './shared.json#/Thing'",
    "fetch('https://example.test')",
    "grpc.Dial('dns:///service')",
    "DllImport('../native.dll')",
    "extern \"C\"",
    "gql`query { ping }`",
  ].join("\n"));
  assert.deepEqual(new Set(signals.map((item) => item.kind)), new Set(["contract", "http", "grpc", "ffi"]));
  assert.ok(signals.some((item) => item.specifier === "C ABI"));
  assert.ok(signals.some((item) => item.specifier === "inline GraphQL"));

  const unknown = analyzeSource("src/tool.rb", "ruby", "regex:ruby-test", "puts 'hello'");
  assert.equal(unknown.analyzer.family, "regex-fallback");
  assert.deepEqual(unknown.analyzer.capabilities, ["imports"], "empty fallback still declares its supported structural capability");
  const invalidTsPath = analyzeSource(null as unknown as string, "typescript", "unused", "import x from './x'; x();");
  assert.equal(invalidTsPath.status, "partial");
  assert.equal(invalidTsPath.analyzer.id, "regex:ts-js-fallback-v2");
  assert.match(invalidTsPath.diagnostics[0], /TypeScript compiler analyzer failed/);
});

test("contract detection and path candidates cover relative, logical, rooted, extension, and escape cases", () => {
  assert.equal(contractKind("schema.proto", ""), "protobuf");
  assert.equal(contractKind("schema.txt", 'syntax = "proto3";'), "protobuf");
  assert.equal(contractKind("schema.gql", ""), "graphql");
  assert.equal(contractKind("schema.txt", "type Query { ping: String }"), "graphql");
  assert.equal(contractKind("openapi.yaml", "openapi: 3.1.0"), "openapi");
  assert.equal(contractKind("openapi.json", '{"openapi":"3.1.0"}'), "openapi");
  assert.equal(contractKind("plain.json", "{}"), null);

  const relative = candidates("src/nested/app.ts", "../core?raw", "typescript");
  assert.ok(relative.includes("src/core.ts") && relative.includes("src/core/index.ts"));
  assert.deepEqual(candidates("src/app.ts", "./ready.js", "javascript"), ["src/ready.js"]);
  assert.ok(candidates("python/pkg/app.py", "..shared.tool", "python").includes("python/shared/tool.py"));
  assert.ok(candidates("src/app.ts", "/contracts/api", "typescript").includes("contracts/api.proto"));
  assert.ok(candidates("src/app.rs", "crate::domain::model", "rust", ["src"]).includes("src/domain/model.rs"));
  assert.ok(candidates("jvm/App.java", "com.acme.Core.*", "java", ["jvm"]).includes("jvm/com/acme/Core.java"));
  assert.deepEqual(candidates("src/app.ts", "../../outside", "typescript"), []);
});

test("TypeScript compiler handles CommonJS, ImportEquals, export variants, call wrappers, protocols, and diagnostics", () => {
  const source = [
    "import './side';",
    "import Eq = require('./eq');",
    "import DefaultClient from './client';",
    "const ns = require('./ns');",
    "const { run: alias, plain, nested: { deep } } = require('./obj');",
    "const [ignored] = require('./array');",
    "Eq.run(); new DefaultClient(); ns['work'](); alias(); plain(); deep(); ignored();",
    "(alias as typeof alias)(); alias!(); (<typeof alias>alias)(); (() => 1)();",
    "void import(`./lazy`); void import(dynamicName); require(dynamicName);",
    "export * from './all';",
    "export * as API from './api';",
    "export { alias as publicAlias };",
    "export default class Named {}",
    "export function fn() {}",
    "export interface Face {}",
    "export type Kind = string;",
    "export enum Choice { One }",
    "export namespace Space {}",
    "export const [first, , third] = [1, 2, 3];",
    "export const { one, nested: { two } } = { one: 1, nested: { two: 2 } };",
    "const assigned = 1; export = assigned;",
    "axios.post('https://api/a'); http.get(`https://api/b`); fetch(dynamicUrl);",
    "grpc.Dial('dns:///one'); grpc.insecure_channel('dns:///two'); GrpcChannel.ForAddress('dns:///three');",
    "ffi.Library('./native.so'); dlopen('./plugin.so');",
    "new RemoteStub('dns:///stub');",
    "const proto = 'contracts/service.proto#Greeter'; const graph = 'schema.graphql';",
    "const openapi = 'specs/service-openapi.yaml'; const suffixOnly = '.proto';",
    "gql`query { ping }`;",
  ].join("\n");
  const result = analyzeTypeScriptSource("src/all.cts", source);
  assert.equal(result.status, "complete", result.diagnostics.join("; "));
  const refs = (kind: string) => result.references.filter((item) => item.kind === kind);
  assert.deepEqual(refs("import").map((item) => item.specifier).sort(), ["./array", "./client", "./eq", "./lazy", "./ns", "./obj", "./side"]);
  assert.deepEqual(refs("export").map((item) => item.specifier).sort(), ["./all", "./api"]);
  assert.equal(refs("call").filter((item) => item.specifier === "./obj").length, 6);
  assert.ok(!refs("call").some((item) => item.specifier === "./array"), "array require binding and its call are intentionally unsupported, not guessed");
  assert.deepEqual(refs("http").map((item) => item.specifier).sort(), ["https://api/a", "https://api/b"]);
  assert.deepEqual(refs("grpc").map((item) => item.specifier).sort(), ["dns:///one", "dns:///stub", "dns:///three", "dns:///two"]);
  assert.deepEqual(refs("ffi").map((item) => item.specifier).sort(), ["./native.so", "./plugin.so"]);
  assert.deepEqual(refs("contract").map((item) => item.specifier).sort(), ["contracts/service.proto#Greeter", "inline GraphQL", "schema.graphql", "specs/service-openapi.yaml"]);
  assert.ok(!refs("contract").some((item) => item.specifier === ".proto"));
  assert.deepEqual(
    result.exports.map((item) => item.name).sort(),
    ["*", "API", "Choice", "Face", "Kind", "Space", "default", "export=", "first", "fn", "one", "publicAlias", "third", "two"].sort(),
  );

  for (const [file, code] of [["x.tsx", "export const view = <div />;"], ["x.jsx", "export const view = <div />;"], ["x.mjs", "export default 1;"], ["x.cjs", "module.exports = 1;"], ["x.unknown", "export const x = 1;"]] as const) {
    assert.equal(analyzeTypeScriptSource(file, code).status, "complete", file);
  }
  const broken = analyzeTypeScriptSource("broken.ts", "export const = ;");
  assert.equal(broken.status, "partial");
  assert.ok(broken.diagnostics.length > 0 && /^1:\d+ /.test(broken.diagnostics[0]));
});

function evidenceDocument(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const content = "source\n";
  return {
    schema_version: 1,
    file: "src/a.ts",
    language: "typescript",
    content_sha256: semanticContentHash(content),
    generated_at: "2026-09-03T00:00:00.000Z",
    status: "complete",
    analyzer: {
      id: "test:ast@1",
      family: "compiler-ast",
      assurance: "ast",
      engine: "test analyzer",
      version: "1",
      capabilities: ["imports", "exports", "calls", "contracts", "http", "grpc", "ffi"],
    },
    references: [],
    exports: [],
    diagnostics: [],
    ...overrides,
  };
}

test("semantic evidence schema rejects assurance and capability inflation and verifies exact source identity", () => {
  for (const [family, assurance] of [["runtime-trace", "ast"], ["regex-fallback", "ast"], ["structured-parser", "heuristic"]] as const) {
    const parsed = AnalyzerProvenanceSchema.safeParse({ id: "bad", family, assurance, engine: "x", version: "1", capabilities: ["imports"] });
    assert.equal(parsed.success, false);
    if (!parsed.success) assert.match(parsed.error.issues[0].message, /requires assurance=/);
  }
  const references = ["import", "export", "call", "contract", "http", "grpc", "ffi"].map((kind, index) => ({ kind, specifier: `target-${kind}`, line: index + 1, confidence: 0.9 }));
  const valid = SemanticEvidenceDocumentSchema.parse(evidenceDocument({
    references,
    exports: [{ name: "API", line: 1, confidence: 0.99 }],
  }));
  assert.ok(valid.references.every((item) => item.force_local === false));
  assert.equal(valid.exports[0].is_type_only, false);

  const noCapabilities = evidenceDocument({
    analyzer: { id: "limited", family: "compiler-ast", assurance: "ast", engine: "x", version: "1", capabilities: ["imports"] },
    references: references.slice(1),
    exports: [{ name: "API", line: 1, confidence: 1 }],
  });
  const rejected = SemanticEvidenceDocumentSchema.safeParse(noCapabilities);
  assert.equal(rejected.success, false);
  if (!rejected.success) {
    assert.ok(rejected.error.issues.some((issue) => issue.message.includes("reference requires analyzer capability")));
    assert.ok(rejected.error.issues.some((issue) => issue.message.includes("exports require analyzer capability")));
  }

  const malformed = verifySemanticEvidence({}, "src/a.ts", "source\n");
  assert.equal(malformed.ok, false);
  assert.ok(malformed.errors.some((error) => error.startsWith("schema_version:")));
  const mismatch = verifySemanticEvidence(evidenceDocument({ file: "other.ts", content_sha256: "0".repeat(64) }), "src/a.ts", "source\n");
  assert.deepEqual(mismatch.errors, ["file mismatch: expected src/a.ts, received other.ts", "content hash mismatch for src/a.ts"]);
  const normalized = verifySemanticEvidence(evidenceDocument({ file: "src\\a.ts" }), "/src/a.ts", "source\n");
  assert.equal(normalized.ok, true);
  assert.deepEqual([assuranceRank("heuristic"), assuranceRank("ast"), assuranceRank("runtime")], [1, 2, 3]);
});

test("scan primitives classify files, tests, lockfiles, trivial assertions, and every skip family", () => {
  assert.deepEqual([extOf("a.TS"), extOf(".env"), extOf("README"), extOf("dir/a.test.ts")], ["ts", "", "", "ts"]);
  assert.equal(isTestFile("src/a.spec.ts"), true);
  assert.equal(isTestFile("tests/unit/a.py"), true);
  assert.equal(isTestFile("src/contest.ts"), false);
  assert.equal(isLockfile("nested/package-lock.json"), true);
  assert.equal(isLockfile("package.json"), false);
  assert.equal(countLoc(""), 1);
  assert.equal(countLoc("a\nb\n"), 3);
  assert.equal(looksTrivialTest("expect(true)\n"), true);
  assert.equal(looksTrivialTest("assert True # fake\n"), true);
  assert.equal(looksTrivialTest("test('x', () => {})\n"), true);
  assert.equal(looksTrivialTest("assert.equal(actual, expected)\n"), false);
  assert.equal(looksTrivialTest(`${"setup\n".repeat(31)}`), false);
  const skipLines = [
    `${"it"}.${"skip"}(() => {})`, `${"it"}.${"only"}(() => {})`, `${"f"}${"it"}(() => {})`,
    `${"x"}${"it"}(() => {})`, `${"x"}${"describe"}(() => {})`, `@unittest.${"skip"}`,
    `@pytest.mark.${"skip"}`, `pytest.mark.${"xfail"}`, `@${"Ignore"}`, `@${"Disabled"}`,
  ].join("\n");
  assert.equal(countSkipLines(skipLines), 10);
  assert.equal(countSkipLines(`${"it"}.${"skip"}(); ${"it"}.${"only"}();`), 1, "one source line counts once even with multiple markers");
  assert.equal(needsSkipCount("src/a.ts", false), true);
  assert.equal(needsSkipCount("src/a.rs", false), false);
  assert.equal(needsSkipCount("src/a.rs", true), true);
});

test("walk/list enforce ignore, include, stat/read failures, oversize, and depth reporting", () => {
  const project = root({
    "src/a.ts": "a\n",
    "src/skip.tmp": "skip\n",
    "docs/readme.md": "docs\n",
    "node_modules/pkg/index.js": "ignored\n",
    "blocked/secret.ts": "blocked\n",
    "src/vanish.ts": "vanish\n",
  });
  fs.writeFileSync(path.join(project, "src", "huge.ts"), Buffer.alloc(2 * 1024 * 1024 + 1, 65));
  const originalReadDir = fs.readdirSync;
  const originalStat = fs.statSync;
  (fs as unknown as { readdirSync: typeof fs.readdirSync }).readdirSync = ((target: fs.PathLike, options?: unknown) => {
    if (path.resolve(String(target)) === path.join(project, "blocked")) throw new Error("simulated unreadable directory");
    return (originalReadDir as (...args: any[]) => any)(target, options);
  }) as typeof fs.readdirSync;
  (fs as unknown as { statSync: typeof fs.statSync }).statSync = ((target: fs.PathLike, options?: unknown) => {
    if (path.resolve(String(target)) === path.join(project, "src", "vanish.ts")) throw new Error("simulated disappearing file");
    return (originalStat as (...args: any[]) => any)(target, options);
  }) as typeof fs.statSync;
  try {
    const walked = [...walkStatEntries(project)].map((item) => item.rel);
    assert.deepEqual(walked.sort(), ["docs/readme.md", "src/a.ts", "src/huge.ts", "src/skip.tmp"]);
  } finally {
    (fs as unknown as { readdirSync: typeof fs.readdirSync }).readdirSync = originalReadDir;
    (fs as unknown as { statSync: typeof fs.statSync }).statSync = originalStat;
  }
  assert.deepEqual([...walkStatEntries(project, { include: ["src/**"], extraIgnores: ["**/*.tmp"] })].map((item) => item.rel).sort(), ["src/a.ts", "src/huge.ts", "src/vanish.ts"]);
  const listed = listFiles(project);
  assert.equal(listed.find((file) => file.rel === "src/huge.ts")?.oversize, true);
  assert.equal(listed.find((file) => file.rel === "src/a.ts")?.oversize, false);

  let deepest = project;
  for (let i = 0; i <= DEPTH_LIMIT; i += 1) {
    deepest = path.join(deepest, "d");
    fs.mkdirSync(deepest);
  }
  fs.writeFileSync(path.join(deepest, "too-deep.ts"), "x\n");
  let skipped = 0;
  assert.ok(![...walkStatEntries(project, {}, () => { skipped += 1; })].some((item) => item.rel.endsWith("too-deep.ts")));
  assert.equal(skipped, 1);
});

test("dependency and scan entrypoints return exact data and expose malformed/deep input", () => {
  const project = root({
    "src/a.ts": "export const a = 1;\n",
    "test/a.test.ts": `${"test"}.${"skip"}('later', () => {});\n`,
    "package-lock.json": "{}\n",
    "package.json": JSON.stringify({ dependencies: { exact: "1.0.0", any: "*" }, devDependencies: { latest: "latest" }, optionalDependencies: { blank: "" } }),
    "requirements.txt": "# comment\n-r base.txt\nrequests==2.0\nuvicorn[standard]>=1\n",
  });
  const deps = readDirectDeps(project);
  assert.deepEqual(deps.deps, ["exact", "any", "latest", "blank", "requests", "uvicorn[standard]"]);
  assert.deepEqual(deps.depSpecs.filter((item) => item.risky).map((item) => item.name), ["any", "latest", "blank"]);

  const listing = scanProject(project, { content: false, include: ["src/**", "test/**", "package-lock.json"] });
  assert.equal(listing.totalFiles, 3);
  assert.equal(listing.totalLoc, 0);
  assert.equal(listing.testFiles, 1);
  assert.deepEqual(listing.lockfiles, ["package-lock.json"]);
  assert.deepEqual(listing.deps, []);

  writeRel(project, "package.json", "{broken");
  let deepest = project;
  for (let i = 0; i <= DEPTH_LIMIT; i += 1) {
    deepest = path.join(deepest, "z");
    fs.mkdirSync(deepest);
  }
  fs.writeFileSync(path.join(deepest, "lost.ts"), "lost\n");
  const scanned = scanProject(project, { forceContent: true });
  assert.ok(scanned.warnings.includes("package.json 不是合法 JSON"));
  assert.ok(scanned.warnings.some((warning) => warning.includes(`超过 ${DEPTH_LIMIT} 层`)));
  assert.ok(scanned.totalFiles >= 5 && scanned.files.length === scanned.totalFiles);
  assert.equal(scanned.skipMarkers, 1);
});

test("project fingerprint detects root/type/read/content-change boundaries and ignores generated directories", () => {
  const project = root({ "src/a.ts": "alpha\n", "dist/a.js": "ignored\n", ".pm/state.json": "ignored\n" });
  const first = fingerprintProject(project);
  assert.deepEqual({ files: first.files, bytes: first.bytes }, { files: 1, bytes: Buffer.byteLength("alpha\n") });
  writeRel(project, "dist/a.js", "changed generated\n");
  assert.deepEqual(fingerprintProject(project), first);
  writeRel(project, "src/a.ts", "omega\n");
  assert.notEqual(fingerprintProject(project).sha256, first.sha256);

  const fileRoot = path.join(project, "src", "a.ts");
  assert.throws(() => fingerprintProject(fileRoot), /项目根必须是普通目录/);
  assert.throws(() => fingerprintProject(path.join(project, "missing")), /ENOENT/);

  const originalFstat = fs.fstatSync;
  let fstatCalls = 0;
  (fs as unknown as { fstatSync: typeof fs.fstatSync }).fstatSync = ((fd: number) => {
    const actual = originalFstat(fd);
    fstatCalls += 1;
    if (fstatCalls === 1) return new Proxy(actual, { get: (target, property, receiver) => property === "isFile" ? () => false : Reflect.get(target, property, receiver) });
    return actual;
  }) as typeof fs.fstatSync;
  try {
    assert.throws(() => fingerprintProject(project), /只接受普通文件/);
  } finally {
    (fs as unknown as { fstatSync: typeof fs.fstatSync }).fstatSync = originalFstat;
  }

  fstatCalls = 0;
  (fs as unknown as { fstatSync: typeof fs.fstatSync }).fstatSync = ((fd: number) => {
    const actual = originalFstat(fd);
    fstatCalls += 1;
    return fstatCalls === 2
      ? new Proxy(actual, { get: (target, property, receiver) => property === "mtimeMs" ? Number(Reflect.get(target, property, receiver)) + 1 : Reflect.get(target, property, receiver) })
      : actual;
  }) as typeof fs.fstatSync;
  try {
    assert.throws(() => fingerprintProject(project), /文件发生变化/);
  } finally {
    (fs as unknown as { fstatSync: typeof fs.fstatSync }).fstatSync = originalFstat;
  }

  const originalRead = fs.readSync;
  (fs as unknown as { readSync: typeof fs.readSync }).readSync = (() => 0) as typeof fs.readSync;
  try {
    assert.throws(() => fingerprintProject(project), /文件发生变化/);
  } finally {
    (fs as unknown as { readSync: typeof fs.readSync }).readSync = originalRead;
  }

  writeRel(project, "odd.entry", "odd\n");
  const odd = path.join(project, "odd.entry");
  const originalLstat = fs.lstatSync;
  (fs as unknown as { lstatSync: typeof fs.lstatSync }).lstatSync = ((target: fs.PathLike) => {
    const actual = originalLstat(target);
    if (path.resolve(String(target)) !== odd) return actual;
    return new Proxy(actual, {
      get: (value, property, receiver) => ["isFile", "isDirectory", "isSymbolicLink"].includes(String(property)) ? () => false : Reflect.get(value, property, receiver),
    });
  }) as typeof fs.lstatSync;
  try {
    assert.throws(() => fingerprintProject(project), /拒绝非普通文件/);
  } finally {
    (fs as unknown as { lstatSync: typeof fs.lstatSync }).lstatSync = originalLstat;
  }
});
