import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assessQualityCoverage,
  createQualityPlan,
  discoverProjectUnits,
  runQualityPlan,
  type QualityCommand,
} from "../src/language-adapters.ts";

function repository(t: Parameters<typeof test>[1] extends (...args: infer A) => unknown ? A[0] : never): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pm-languages-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function write(root: string, relative: string, content = ""): void {
  const target = path.join(root, ...relative.split("/"));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf8");
}

function safeCommand(root: string, source: string, overrides: Partial<QualityCommand> = {}): QualityCommand {
  return {
    command: process.execPath,
    args: ["-e", source],
    cwd: root,
    kind: "test",
    requiredExecutable: process.execPath,
    timeoutMs: 2_000,
    maxOutputBytes: 256,
    ...overrides,
  };
}

test("递归发现多语言 monorepo 与 Node workspaces，忽略生成目录", (t) => {
  const root = repository(t);
  write(root, "package.json", JSON.stringify({
    private: true,
    workspaces: ["packages/*"],
    scripts: { test: "node test.js", build: "tsc", lint: "eslint .", typecheck: "tsc --noEmit", coverage: "node coverage.js", security: "node security.js", deploy: "never" },
    dependencies: { zod: "^3.25.0" },
    devDependencies: { typescript: "1.0.0" },
    optionalDependencies: { chokidar: "^4.0.0" },
    peerDependencies: { react: ">=18" },
  }));
  write(root, "tsconfig.json", "{}");
  write(root, "packages/web/package.json", JSON.stringify({ scripts: { test: "node test.js", postinstall: "never" } }));
  write(root, "packages/empty/package.json", JSON.stringify({ name: "no-quality-contract", dependencies: { broken: 7 } }));
  write(root, "services/python/pyproject.toml", "[project]\ndependencies=[\"requests>=2.31\", \"httpx\"]\n[project.optional-dependencies]\ntest=[\"pytest>=8\"]\n[build-system]\nrequires=[]\n[tool.ruff]\n[tool.mypy]\n");
  write(root, "services/python/requirements-dev.txt", "pytest==8.0\nnot a valid requirement ???\n");
  write(root, "services/go/go.mod", "module example.test/go\nrequire golang.org/x/sync v0.7.0\nrequire (\n github.com/stretchr/testify v1.9.0\n golang.org/x/text v0.16.0 // indirect\n)\n");
  write(root, "crates/core/Cargo.toml", "[package]\nname='core'\nversion='0.1.0'\n[dependencies]\nserde='1.0'\ntokio={ version='1.38' }\n[dev-dependencies]\npretty_assertions='1.4'\n[build-dependencies]\ncc='1.0'\n");
  write(root, "jvm/maven/pom.xml", "<project><dependencies><dependency><groupId>org.slf4j</groupId><artifactId>slf4j-api</artifactId><version>2.0.13</version><scope>test</scope></dependency></dependencies></project>\n");
  write(root, "jvm/gradle/build.gradle.kts", "plugins {}\ndependencies {\n implementation(\"org.slf4j:slf4j-api:2.0.13\")\n testImplementation(\"org.junit.jupiter:junit-jupiter:5.10.2\")\n implementation(project(\":core\"))\n}\n");
  write(root, "mvnw", "#!/bin/sh\n");
  write(root, "mvnw.cmd", "@echo off\r\n");
  write(root, "gradlew", "#!/bin/sh\n");
  write(root, "gradlew.bat", "@echo off\r\n");
  write(root, "dotnet/App.sln", "Microsoft Visual Studio Solution File\n");
  write(root, "dotnet/src/App/App.csproj", "<Project><ItemGroup><PackageReference Include=\"Serilog\" Version=\"3.1.1\" /><PackageReference Include=\"xunit\" Version=\"2.8.1\" PrivateAssets=\"all\" /></ItemGroup></Project>\n");
  write(root, "node_modules/hidden/package.json", JSON.stringify({ scripts: { test: "never" } }));
  write(root, "target/hidden/Cargo.toml", "[package]\nname='hidden'\n");

  const units = discoverProjectUnits(root);
  const byId = new Map(units.map((unit) => [unit.id, unit]));
  assert.deepEqual([...byId.keys()], [
    ".", "crates/core", "dotnet", "dotnet/src/App", "jvm/gradle", "jvm/maven", "packages/empty", "packages/web", "services/go", "services/python",
  ]);
  assert.deepEqual(byId.get(".")?.languages, ["javascript", "typescript"]);
  assert.deepEqual(byId.get("services/python")?.manifest.map((m) => path.basename(m.path)), ["pyproject.toml", "requirements-dev.txt"]);
  assert.deepEqual(byId.get("services/go")?.languages, ["go"]);
  assert.deepEqual(byId.get("crates/core")?.languages, ["rust"]);
  assert.deepEqual(byId.get("jvm/maven")?.languages, ["java"]);
  assert.deepEqual(byId.get("jvm/gradle")?.languages, ["java", "kotlin"]);
  assert.deepEqual(byId.get("dotnet")?.languages, ["csharp"]);

  const rootCommands = byId.get(".")!.qualityCommands;
  assert.deepEqual(rootCommands.map((item) => item.kind), ["test", "build", "lint", "typecheck", "coverage", "security"]);
  assert.ok(rootCommands.every((item) => item.requiredExecutable === "npm" && Array.isArray(item.args)));
  assert.ok(rootCommands.every((item) => !item.args.includes("deploy")), "非白名单 npm script 不进入计划");
  assert.deepEqual(byId.get("packages/web")!.qualityCommands.map((item) => item.kind), ["test"]);
  assert.equal(byId.get("services/go")!.qualityCommands[0].requiredExecutable, "go");
  assert.ok(byId.get("services/go")!.qualityCommands.some((item) => item.kind === "coverage"));
  assert.equal(byId.get("crates/core")!.qualityCommands[0].requiredExecutable, "cargo");
  const expectedMavenWrapper = path.join(root, process.platform === "win32" ? "mvnw.cmd" : "mvnw");
  const expectedGradleWrapper = path.join(root, process.platform === "win32" ? "gradlew.bat" : "gradlew");
  assert.equal(byId.get("jvm/maven")!.qualityCommands[0].command, expectedMavenWrapper);
  assert.equal(byId.get("jvm/maven")!.qualityCommands[0].requiredExecutable, expectedMavenWrapper);
  assert.equal(byId.get("jvm/gradle")!.qualityCommands[0].command, expectedGradleWrapper);
  assert.equal(byId.get("jvm/gradle")!.qualityCommands[0].requiredExecutable, expectedGradleWrapper);
  assert.equal(byId.get("dotnet")!.qualityCommands[0].requiredExecutable, "dotnet");
  assert.ok(createQualityPlan(units).every((item) => Array.isArray(item.args) && path.isAbsolute(item.cwd)));

  const rootDeps = byId.get(".")!.dependencies;
  assert.deepEqual(rootDeps.map((dep) => [dep.name, dep.scope]), [
    ["chokidar", "optional"], ["react", "peer"], ["typescript", "development"], ["zod", "runtime"],
  ]);
  assert.ok(rootDeps.every((dep) => dep.parser === "package-json" && dep.confidence === 1 && path.isAbsolute(dep.sourceManifest)));
  assert.deepEqual(byId.get("services/python")!.dependencies.map((dep) => [dep.name, dep.scope]), [
    ["httpx", "runtime"], ["pytest", "optional:test"], ["requests", "runtime"], ["pytest", "development"],
  ]);
  assert.equal(byId.get("services/python")!.dependencyErrors.length, 1, "坏 requirements 条目不得静默");
  assert.deepEqual(byId.get("services/go")!.dependencies.map((dep) => [dep.name, dep.scope]), [
    ["github.com/stretchr/testify", "runtime"], ["golang.org/x/sync", "runtime"], ["golang.org/x/text", "indirect"],
  ]);
  assert.deepEqual(byId.get("crates/core")!.dependencies.map((dep) => [dep.name, dep.scope]), [
    ["cc", "build"], ["pretty_assertions", "development"], ["serde", "runtime"], ["tokio", "runtime"],
  ]);
  assert.deepEqual(byId.get("jvm/maven")!.dependencies.map((dep) => [dep.name, dep.version, dep.scope]), [["org.slf4j:slf4j-api", "2.0.13", "test"]]);
  assert.deepEqual(byId.get("jvm/gradle")!.dependencies.map((dep) => [dep.name, dep.scope]), [
    ["org.junit.jupiter:junit-jupiter", "testImplementation"], ["org.slf4j:slf4j-api", "implementation"],
  ]);
  assert.equal(byId.get("jvm/gradle")!.dependencyErrors.length, 1, "project() 非外部坐标必须显式进入错误清单");
  assert.deepEqual(byId.get("dotnet/src/App")!.dependencies.map((dep) => [dep.name, dep.scope]), [
    ["Serilog", "runtime"], ["xunit", "development"],
  ]);
  assert.equal(byId.get("packages/empty")!.dependencyErrors.length, 1, "Node 非字符串版本不得静默");

  const coverage = assessQualityCoverage(units);
  assert.deepEqual(coverage, {
    totalUnits: 10,
    unitsWithCommands: 9,
    withoutCommands: ["packages/empty"],
    languages: ["javascript", "typescript", "python", "go", "rust", "java", "kotlin", "csharp"],
    commandKinds: ["test", "build", "lint", "typecheck", "coverage", "security"],
    coveragePct: 90,
  });
  assert.equal(assessQualityCoverage([]).coveragePct, 0, "空发现结果不得被当成 100% 覆盖");
});

test("runQualityPlan 默认只规划，execute:true 才执行且输出受预算限制", async (t) => {
  const root = repository(t);
  const marker = path.join(root, "executed.txt");
  const item = safeCommand(root, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'yes'); process.stdout.write('x'.repeat(2000));`, {
    maxOutputBytes: 80,
  });

  const planned = await runQualityPlan([item]);
  assert.equal(planned.execute, false);
  assert.equal(planned.ok, true);
  assert.equal(planned.results[0].status, "planned");
  assert.equal(fs.existsSync(marker), false, "plan-only 不得启动命令");

  const executed = await runQualityPlan([item], { execute: true });
  assert.equal(executed.ok, true);
  assert.equal(executed.results[0].status, "passed");
  assert.equal(executed.results[0].stdout.length, 80);
  assert.equal(executed.results[0].truncated, true);
  assert.equal(fs.readFileSync(marker, "utf8"), "yes");
});

test("缺工具、非零退出与超时均 fail-closed，后续命令不执行", async (t) => {
  const root = repository(t);
  const marker = path.join(root, "must-not-run.txt");
  const blocked = safeCommand(root, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'bad')`);

  const missing = safeCommand(root, "process.exit(0)", { requiredExecutable: `missing-tool-${process.pid}-${Date.now()}` });
  const missingResult = await runQualityPlan([missing, blocked], { execute: true });
  assert.equal(missingResult.ok, false);
  assert.deepEqual(missingResult.results.map((result) => result.status), ["missing", "blocked"]);
  assert.equal(fs.existsSync(marker), false);

  const failed = safeCommand(root, "process.stderr.write('failure'); process.exit(7)");
  const failedResult = await runQualityPlan([failed, blocked], { execute: true });
  assert.equal(failedResult.ok, false);
  assert.equal(failedResult.results[0].status, "failed");
  assert.equal(failedResult.results[0].exitCode, 7);
  assert.equal(failedResult.results[1].status, "blocked");
  assert.equal(fs.existsSync(marker), false);

  const timed = safeCommand(root, "setTimeout(() => {}, 10_000)", { timeoutMs: 50 });
  const timedResult = await runQualityPlan([timed], { execute: true });
  assert.equal(timedResult.ok, false);
  assert.equal(timedResult.results[0].status, "timed_out");
});
