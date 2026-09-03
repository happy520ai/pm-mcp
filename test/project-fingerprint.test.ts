import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fingerprintProject } from "../src/project-fingerprint.ts";
import { mkProj, writeRel } from "./helpers.ts";

test("project fingerprint is content-bound, deterministic, and ignores generated state", (t) => {
  const root = mkProj({ "src/b.ts": "export const b = 2;\n", "src/a.ts": "export const a = 1;\n" });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const first = fingerprintProject(root);
  const second = fingerprintProject(root);
  assert.deepEqual(first, second);
  writeRel(root, ".pm/ignored.json", "changed\n");
  writeRel(root, "PROJECT.md", "generated dashboard\n");
  assert.deepEqual(fingerprintProject(root), first, ".pm and PROJECT.md are derived state, not product source");
  writeRel(root, "src/a.ts", "export const a = 3;\n");
  assert.notEqual(fingerprintProject(root).sha256, first.sha256);
});

test("project fingerprint rejects symlink ambiguity or the host forbids its creation", (t) => {
  const root = mkProj({ "src/a.ts": "export const a = 1;\n" });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const link = path.join(root, "src", "alias.ts");
  try {
    fs.symlinkSync(path.join(root, "src", "a.ts"), link, "file");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    assert.ok(code === "EPERM" || code === "EACCES" || code === "ENOTSUP", `unexpected symlink setup failure: ${String(error)}`);
    return;
  }
  assert.throws(() => fingerprintProject(root), /拒绝符号链接/);
});
