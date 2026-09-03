import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { semanticContentHash } from "../src/semantic-evidence.ts";
import {
  listSemanticEvidence,
  loadAllSemanticEvidence,
  loadSemanticEvidence,
  saveSemanticEvidence,
  semanticEvidenceDir,
  semanticEvidencePath,
  validateSemanticEvidenceId,
} from "../src/semantic-evidence-store.ts";
import { mkProj } from "./helpers.ts";

const roots: string[] = [];
after(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });

function document(file: string, content: string, analyzer = "python:tree-sitter@1"): unknown {
  return {
    schema_version: 1,
    file,
    language: "python",
    content_sha256: semanticContentHash(content),
    generated_at: "2026-09-02T00:00:00.000Z",
    status: "complete",
    analyzer: {
      id: analyzer,
      family: "language-native-ast",
      assurance: "ast",
      engine: "tree-sitter-python",
      version: "1",
      capabilities: ["imports", "exports", "calls"],
    },
    references: [],
    exports: [],
    diagnostics: [],
  };
}

test("save/load/list/loadAll preserve validated evidence with atomic files", () => {
  const sourceA = "print('a')\n";
  const sourceB = "print('b')\n";
  const root = mkProj({ "python/a.py": sourceA, "python/b.py": sourceB });
  roots.push(root);

  const savedB = saveSemanticEvidence(root, "b-evidence", document("python/b.py", sourceB, "python:tree-sitter@2"));
  const savedA = saveSemanticEvidence(root, "a_evidence.v1", document("python/a.py", sourceA));
  assert.equal(savedA.content_sha256, semanticContentHash(sourceA));
  assert.equal(savedB.analyzer.id, "python:tree-sitter@2");
  assert.equal(semanticEvidencePath(root, "a_evidence.v1"), path.join(root, ".pm", "semantic-evidence", "a_evidence.v1.json"));

  assert.deepEqual(loadSemanticEvidence(root, "a_evidence.v1"), savedA);
  assert.deepEqual(listSemanticEvidence(root).map((item) => item.id), ["a_evidence.v1", "b-evidence"]);
  assert.deepEqual(loadAllSemanticEvidence(root).map((item) => item.file), ["python/a.py", "python/b.py"]);
  assert.deepEqual(fs.readdirSync(semanticEvidenceDir(root)).filter((name) => name.endsWith(".tmp")), []);

  const replacement = document("python/a.py", sourceA, "python:tree-sitter@3");
  saveSemanticEvidence(root, "a_evidence.v1", replacement);
  assert.equal(loadSemanticEvidence(root, "a_evidence.v1").analyzer.id, "python:tree-sitter@3");
  assert.deepEqual(fs.readdirSync(semanticEvidenceDir(root)).filter((name) => name.endsWith(".tmp")), []);
});

test("unsafe IDs and invalid schema are rejected before a ledger file is written", () => {
  const root = mkProj();
  roots.push(root);
  for (const id of ["", "../escape", "a/b", "a\\b", ".hidden", "trailing.", " white", "CON", "nul.txt", "C:drive", "汉字"] as const) {
    assert.throws(() => validateSemanticEvidenceId(id), /非法语义证据 ID/);
  }
  assert.throws(() => saveSemanticEvidence(root, "../outside", document("a.py", "")), /非法语义证据 ID/);
  assert.ok(!fs.existsSync(path.join(root, "outside.json")));

  assert.throws(() => saveSemanticEvidence(root, "invalid", { schema_version: 1 }), /schema 校验失败/);
  assert.ok(!fs.existsSync(semanticEvidencePath(root, "invalid")));
  assert.throws(() => loadSemanticEvidence(root, "missing"), /语义证据不存在/);
});

test("list and loadAll fail closed on malformed or schema-invalid JSON", () => {
  const root = mkProj();
  roots.push(root);
  saveSemanticEvidence(root, "good", document("python/good.py", "good\n"));
  fs.writeFileSync(semanticEvidencePath(root, "broken"), "{not-json", "utf8");
  assert.throws(() => listSemanticEvidence(root), /JSON 解析失败/);
  assert.throws(() => loadAllSemanticEvidence(root), /JSON 解析失败/);

  fs.writeFileSync(semanticEvidencePath(root, "broken"), JSON.stringify({ schema_version: 1 }), "utf8");
  assert.throws(() => listSemanticEvidence(root), /schema 校验失败/);
  assert.throws(() => loadAllSemanticEvidence(root), /schema 校验失败/);
});

test("real-path guard rejects an evidence directory redirected outside the project", (t) => {
  const root = mkProj();
  const outside = mkProj();
  roots.push(root, outside);
  fs.mkdirSync(path.join(root, ".pm"), { recursive: true });
  try {
    fs.symlinkSync(outside, semanticEvidenceDir(root), process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    assert.ok(code === "EPERM" || code === "EACCES" || code === "ENOTSUP", `unexpected link setup failure: ${String(error)}`);
    return;
  }
  assert.throws(() => saveSemanticEvidence(root, "escape", document("x.py", "x\n")), /逃逸项目根目录/);
  assert.throws(() => loadAllSemanticEvidence(root), /逃逸项目根目录/);
});
