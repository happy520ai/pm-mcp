import test from "node:test";
import assert from "node:assert/strict";
import { capLine, foldLines, globToRegExp } from "../src/budget.ts";

test("foldLines 行数在预算内原样返回", () => {
  const lines = ["a", "b", "c"];
  assert.equal(foldLines(lines, { maxLines: 5 }), "a\nb\nc");
});

test("foldLines 超预算折叠并给出隐藏计数", () => {
  const lines = Array.from({ length: 20 }, (_, i) => `line-${i}`);
  const out = foldLines(lines, { maxLines: 5 });
  assert.ok(out.includes("另有"), "应包含折叠提示");
  assert.ok(!out.includes("line-19"), "尾部行应被折叠");
  const shown = out.split("\n");
  assert.ok(shown.length <= 5, `输出行数 ${shown.length} 应 <= 5`);
});

test("capLine 截断超长行", () => {
  assert.equal(capLine("x".repeat(500), 100).length <= 101, true);
  assert.ok(capLine("x".repeat(500), 100).endsWith("…"));
});

test("globToRegExp 支持 * 与 **", () => {
  const re = globToRegExp("src/**/*.ts");
  assert.ok(re.test("src/a.ts"));
  assert.ok(re.test("src/x/y.ts"));
  assert.ok(!re.test("src/a.js"));
  assert.ok(!re.test("dist/a.ts"));
  const re2 = globToRegExp("*.test.ts");
  assert.ok(re2.test("foo.test.ts"));
  assert.ok(!re2.test("sub/foo.test.ts"), "* 不跨目录");
});
