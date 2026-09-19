import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initProject } from "../src/init.ts";
import { closeIndex } from "../src/index-store.ts";
import { findDuplicateBlocks, renderDuplicates } from "../src/duplicates.ts";

const roots: string[] = [];
after(() => {
  for (const root of roots) {
    closeIndex(root);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function fixture(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pm-dup-"));
  process.env.PM_MCP_HOME = root + "-home";
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.join(root, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content, "utf8");
  }
  initProject(root, { name: "dup", agentsMd: false });
  roots.push(root);
  return root;
}

const CLONE = [
  "export function shared(input: number): number {",
  "  const doubled = input * 2;",
  "  if (doubled > 10) {",
  "    return doubled - 1;",
  "  }",
  "  return doubled + 3;",
  "}",
].join("\n");

test("跨文件相同代码聚为一组，注释与空白差异不影响检出", () => {
  const root = fixture({
    "src/a.ts": "// a 前置说明\n" + CLONE + "\nexport const onlyA = 1;\n",
    "src/b.ts": "/* b 说明 */\n" + CLONE + "\nexport const   onlyB = 2;\n",
  });
  const scan = findDuplicateBlocks(root, { minLines: 6 });
  assert.equal(scan.groups.length, 1, JSON.stringify(scan.groups));
  assert.equal(scan.groups[0].lines, 7);
  assert.deepEqual(scan.groups[0].members.map((m) => m.file), ["src/a.ts", "src/b.ts"]);
  assert.equal(scan.truncated, false);
});

test("字符串字面量占位：字面量文本不同不阻止结构重复检出", () => {
  const root = fixture({
    "src/a.ts": 'const greeting = "hello world";\nconst farewell = "再见";\n' + CLONE,
    "src/b.ts": 'const greeting = "bonjour";\nconst farewell = "ciao";\n' + CLONE,
  });
  const scan = findDuplicateBlocks(root, { minLines: 6 });
  assert.ok(scan.groups.some((group) => group.members.length === 2), JSON.stringify(scan.groups));
});

test("不同逻辑代码不误报", () => {
  const root = fixture({
    "src/a.ts": "export function one(a: number): number {\n  return a + 1;\n}\nexport const metaA = 'a';\n",
    "src/b.ts": "export function two(b: number): number {\n  return b * 2;\n}\nexport const metaB = 'b';\n",
  });
  const scan = findDuplicateBlocks(root, { minLines: 6 });
  assert.equal(scan.groups.length, 0, JSON.stringify(scan.groups));
});

test("忽略目录不参与扫描", () => {
  const root = fixture({
    "src/a.ts": CLONE,
    "node_modules/pkg/index.js": CLONE,
  });
  const scan = findDuplicateBlocks(root, { minLines: 6 });
  assert.equal(scan.scannedFiles, 1, "node_modules 必须被排除");
  assert.equal(scan.groups.length, 0);
});

test("超限大文件跳过", () => {
  const padding = Array.from({ length: 30000 }, (_, i) => `const pad${i} = ${i};`).join("\n");
  const root = fixture({
    "src/a.ts": CLONE,
    "src/big.ts": padding + "\n" + CLONE,
  });
  const scan = findDuplicateBlocks(root, { minLines: 6 });
  assert.equal(scan.groups.length, 0, "big.ts 超过单文件上限必须被跳过");
  assert.ok(scan.skippedOversize >= 1);
});

test("renderDuplicates 确定性输出并尊重 limit", () => {
  const root = fixture({
    "src/a.ts": CLONE,
    "src/b.ts": CLONE,
    "src/c.ts": CLONE,
  });
  const report = renderDuplicates(root, { minLines: 6, limit: 1 }, 150);
  assert.ok(report.includes("重复代码"), report);
  assert.ok(report.includes("组1（"), report);
  assert.ok(!report.includes("组2（"), "limit=1 时不得列出第二组");
});
