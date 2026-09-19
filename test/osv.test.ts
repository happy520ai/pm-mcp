import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initProject } from "../src/init.ts";
import { auditOsv, collectOsvQueries, ecosystemFor, renderOsv, type FetchLike } from "../src/osv.ts";

const roots: string[] = [];
after(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });

function depFixture(extra: Record<string, string> = {}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pm-osv-"));
  process.env.PM_MCP_HOME = root + "-home";
  const write = (rel: string, content: string): void => {
    fs.mkdirSync(path.join(root, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content, "utf8");
  };
  write("package.json", JSON.stringify({ name: "x", version: "1.0.0", dependencies: { lodash: "^4.17.15", express: "4.18.2" }, devDependencies: { vitest: "1.2.0" } }));
  write("requirements.txt", "flask==2.0.1\nrequests>=2.25\n");
  write("go.mod", "module example.test/m\n\nrequire github.com/pkg/errors v0.9.1\n");
  write("Cargo.toml", "[package]\nname='x'\nversion='0.1.0'\n[dependencies]\nserde='1.0'\n");
  write("pom.xml", "<project><dependencies><dependency><groupId>org.slf4j</groupId><artifactId>slf4j-api</artifactId><version>2.0.13</version></dependency></dependencies></project>\n");
  write("app.csproj", "<Project Sdk=\"Microsoft.NET.Sdk\"><ItemGroup><PackageReference Include=\"Newtonsoft.Json\" Version=\"13.0.3\" /></ItemGroup></Project>\n");
  for (const [rel, content] of Object.entries(extra)) write(rel, content);
  initProject(root, { name: "osv", agentsMd: false });
  roots.push(root);
  return root;
}

test("生态映射覆盖全部受支持 manifest 解析器", () => {
  assert.equal(ecosystemFor("package-json"), "npm");
  assert.equal(ecosystemFor("requirements-regex"), "PyPI");
  assert.equal(ecosystemFor("pyproject-toml-regex"), "PyPI");
  assert.equal(ecosystemFor("go-mod-regex"), "Go");
  assert.equal(ecosystemFor("cargo-toml-regex"), "crates.io");
  assert.equal(ecosystemFor("maven-xml-regex"), "Maven");
  assert.equal(ecosystemFor("gradle-coordinate-regex"), "Maven");
  assert.equal(ecosystemFor("msbuild-xml-regex"), "NuGet");
  assert.equal(ecosystemFor("unknown-thing"), null);
});

test("collectOsvQueries 收齐六种生态并按名称排序", () => {
  const { queries, skippedUnknownEcosystem } = collectOsvQueries(depFixture());
  const ecosystems = [...new Set(queries.map((q) => q.ecosystem))].sort();
  assert.deepEqual(ecosystems, ["Go", "Maven", "NuGet", "PyPI", "crates.io", "npm"]);
  const lodash = queries.find((q) => q.name === "lodash");
  assert.equal(lodash?.version, "^4.17.15");
  assert.equal(lodash?.ecosystem, "npm");
  assert.equal(skippedUnknownEcosystem, 0);
  for (let i = 1; i < queries.length; i++) {
    const prev = queries[i - 1], cur = queries[i];
    assert.ok(prev.ecosystem.localeCompare(cur.ecosystem) <= 0, "必须按生态排序");
  }
});

test("auditOsv 解析命中与干净结果，报告如实声明边界", async () => {
  const root = depFixture();
  const requests: string[] = [];
  const fetcher: FetchLike = async (_url, init) => {
    requests.push(init.body);
    const body = JSON.parse(init.body) as { queries: Array<{ package: { name: string } }> };
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        results: body.queries.map((q) => q.package.name === "lodash"
          ? { vulns: [{ id: "GHSA-lodash-test", summary: "prototype pollution", aliases: ["CVE-2020-8203"] }] }
          : {}),
      }),
    };
  };
  const scan = await auditOsv(root, { fetcher });
  assert.equal(scan.queried >= 6, true);
  assert.equal(scan.batches, 1);
  assert.equal(scan.vulnerablePackages.length, 1);
  assert.equal(scan.vulnCount, 1);
  assert.equal(scan.vulnerablePackages[0]?.name, "lodash");
  assert.equal(scan.vulnerablePackages[0]?.vulns[0]?.id, "GHSA-lodash-test");
  assert.match(requests[0], /"ecosystem":"npm"/);
  const report = renderOsv(scan, 150);
  assert.ok(report.includes("🚩 npm/lodash@^4.17.15 GHSA-lodash-test"), report);
  assert.ok(report.includes("CVE-2020-8203"), report);
  assert.ok(report.includes("边界"), report);
});

test("auditOsv 超过 100 个依赖分批请求", async () => {
  const many: Record<string, string> = {};
  for (let i = 0; i < 150; i++) many[`pkg-${String(i).padStart(3, "0")}`] = "1.0.0";
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pm-osv-chunk-"));
  process.env.PM_MCP_HOME = root + "-home";
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "x", version: "1.0.0", dependencies: many }), "utf8");
  initProject(root, { name: "osv-chunk", agentsMd: false });
  roots.push(root);
  let calls = 0;
  const fetcher: FetchLike = async (_url, init) => {
    calls += 1;
    const body = JSON.parse(init.body) as { queries: unknown[] };
    return { ok: true, status: 200, text: async () => JSON.stringify({ results: body.queries.map(() => ({})) }) };
  };
  const scan = await auditOsv(root, { fetcher });
  assert.equal(calls, 2);
  assert.equal(scan.batches, 2);
  assert.equal(scan.queried, 150);
  assert.equal(scan.vulnCount, 0);
});

test("auditOsv 对 HTTP 错误 fail-closed 并带批次信息", async () => {
  const root = depFixture();
  const fetcher: FetchLike = async () => ({ ok: false, status: 503, text: async () => "unavailable" });
  await assert.rejects(auditOsv(root, { fetcher }), /OSV 查询失败：HTTP 503/);
});
