import test from "node:test";
import assert from "node:assert/strict";
import { auditLicense } from "../src/license.ts";
import { loadFileNotes, saveFileNotes } from "../src/store.ts";
import { now } from "../src/types.ts";
import { initTestProject, mkProj } from "./helpers.ts";

function nodeMod(name: string, license: string): string {
  return JSON.stringify({ name, version: "1.0.0", license });
}

test("copyleft 依赖与 GPL 头被点名，宽松依赖通过", () => {
  const root = mkProj({
    "package.json": JSON.stringify({
      name: "app",
      license: "MIT",
      dependencies: { "left-pad": "^1.0.0", "gpl-thing": "^1.0.0", "lgpl-thing": "^1.0.0" },
    }),
    "node_modules/left-pad/package.json": nodeMod("left-pad", "MIT"),
    "node_modules/gpl-thing/package.json": nodeMod("gpl-thing", "GPL-3.0"),
    "node_modules/lgpl-thing/package.json": nodeMod("lgpl-thing", "LGPL-3.0"),
    "src/copied.ts": "// Copied from somewhere\n// GNU GENERAL PUBLIC LICENSE Version 3\nexport const x = 1;\n",
    "src/fine.ts": "export const y = 2;\n",
  });
  initTestProject(root);
  const out = auditLicense(root);
  assert.ok(out.includes("🔴 gpl-thing"), "强 copyleft 标红");
  assert.ok(out.includes("强 copyleft"), "包含冲突说明");
  assert.ok(out.includes("🟡 lgpl-thing"), "弱 copyleft 标黄");
  assert.ok(out.includes("🟢 left-pad"), "宽松依赖通过");
  assert.ok(out.includes("src/copied.ts"), "GPL 头文件被点名");
  assert.ok(out.includes("缺少 LICENSE"), "根目录无 LICENSE 文件提示");
});

test("项目声明许可证后，MIT 项目 + GPL 依赖触发分发义务提醒", () => {
  const root = mkProj({
    "package.json": JSON.stringify({ name: "app", dependencies: { "gpl-thing": "^1.0.0" } }),
    "node_modules/gpl-thing/package.json": nodeMod("gpl-thing", "AGPL-3.0"),
  });
  initTestProject(root); // license: MIT（helper 默认）
  const out = auditLicense(root);
  assert.ok(out.includes("🔴 gpl-thing"));
  assert.ok(out.includes("开源义务"), "提示分发义务");
});

test("来源登记（provenance）出现在报告中", () => {
  const root = mkProj({ "src/vendored.ts": "export const z = 3;\n" });
  initTestProject(root);
  const data = loadFileNotes(root);
  data.notes["src/vendored.ts"] = { purpose: "第三方分页逻辑", source: "https://example.com/snippet", license: "MIT", updated: now() };
  saveFileNotes(root, data);
  const out = auditLicense(root);
  assert.ok(out.includes("src/vendored.ts"));
  assert.ok(out.includes("example.com"));
});
