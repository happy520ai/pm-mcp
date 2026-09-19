import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initProject } from "../src/init.ts";
import { renderPublicSearch, resolveSnippet, searchPublicCode, type FetchLike } from "../src/public-search.ts";

const roots: string[] = [];
after(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });

function fixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pm-pubsearch-"));
  process.env.PM_MCP_HOME = root + "-home";
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "sample.ts"), "const tiny = 1;\n\nexport function veryDistinctiveCalculator(input: number): number {\n  return input * 42;\n}\n", "utf8");
  initProject(root, { name: "ps", agentsMd: false });
  roots.push(root);
  return root;
}

const noTokenResolver = (): string => { throw new Error("未找到 GitHub 凭据：设置 GH_TOKEN/GITHUB_TOKEN，或先 gh auth login。"); };

test("resolveSnippet：显式片段优先、空白折叠、过短拒绝、file+line 与缺省最长行", () => {
  const root = fixture();
  assert.equal(resolveSnippet(root, { snippet: "  export   function veryDistinctiveCalculator(input: number): number {  " }), "export function veryDistinctiveCalculator(input: number): number {");
  assert.throws(() => resolveSnippet(root, { snippet: "short" }), /太短/);
  assert.throws(() => resolveSnippet(root, { snippet: "enough length here 12345", file: "src/sample.ts" }), /二选一/);
  assert.equal(resolveSnippet(root, { file: "src/sample.ts" }), "export function veryDistinctiveCalculator(input: number): number {");
  assert.equal(resolveSnippet(root, { file: "src/sample.ts", line: 1 }), "const tiny = 1;");
  assert.throws(() => resolveSnippet(root, { file: "src/sample.ts", line: 99 }), /越界/);
  assert.throws(() => resolveSnippet(root, { file: "../outside.ts" }), /项目根内/);
});

function mockFetch(payload: unknown, capture: { headers?: Record<string, string>; url?: string } = {}): FetchLike {
  return async (url, init) => {
    capture.url = url;
    capture.headers = init.headers;
    return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
  };
}

test("searchPublicCode：精确短语查询、命中映射与截断标记", async () => {
  const root = fixture();
  const capture: { headers?: Record<string, string>; url?: string } = {};
  const payload = {
    total_count: 12,
    items: [
      { repository: { full_name: "someone/copied" }, path: "src/calc.ts", html_url: "https://github.com/someone/copied/blob/main/src/calc.ts" },
      { repository: { full_name: "other/origin" }, path: "lib/calc.js", html_url: "https://github.com/other/origin/blob/main/lib/calc.js" },
    ],
  };
  const result = await searchPublicCode(root, {
    snippet: "export function veryDistinctiveCalculator(input: number): number {",
    token: "test-token",
    maxResults: 2,
    fetcher: mockFetch(payload, capture),
  });
  assert.equal(result.totalCount, 12);
  assert.equal(result.hits.length, 2);
  assert.equal(result.hits[0]?.repo, "someone/copied");
  assert.equal(result.truncated, true, "total 12 > 列出 2 必须标记截断");
  assert.match(capture.url ?? "", /q=export%20function%20veryDistinctiveCalculator/);
  assert.doesNotMatch(capture.url ?? "", /%22/);
  assert.equal(capture.headers?.authorization, "Bearer test-token");
  const report = renderPublicSearch(result, 150);
  assert.ok(report.includes("外发片段"), report);
  assert.ok(report.includes("someone/copied"), report);
  assert.ok(report.includes("不是侵权结论"), report);
});

test("searchPublicCode：引号剔除并按词项 AND 提交（GitHub REST 语义）", async () => {
  const root = fixture();
  const capture: { url?: string } = {};
  await searchPublicCode(root, {
    snippet: 'const greeting = "hello world 12345";',
    token: "t",
    fetcher: mockFetch({ total_count: 0, items: [] }, capture),
  });
  const url = capture.url ?? "";
  assert.ok(!url.includes("%22"), "不得包裹引号短语");
  assert.match(url, /q=const%20greeting%20(%3D%20)?hello%20world/);
});

test("searchPublicCode：凭据缺失、401、403、422 各自给出可行动错误", async () => {
  const root = fixture();
  const offline = { tokenResolver: noTokenResolver };
  await assert.rejects(searchPublicCode(root, { snippet: "enough length here 12345", ...offline }), /未找到 GitHub 凭据/);
  const status = (code: number): FetchLike => async () => ({ ok: false, status: code, text: async () => "" });
  await assert.rejects(searchPublicCode(root, { snippet: "enough length here 12345", fetcher: status(401) }), /token 无效/);
  await assert.rejects(searchPublicCode(root, { snippet: "enough length here 12345", fetcher: status(403) }), /限流/);
  await assert.rejects(searchPublicCode(root, { snippet: "enough length here 12345", fetcher: status(422) }), /短语可能不合法/);
});
