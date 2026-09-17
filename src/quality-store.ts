import fs from "node:fs";
import path from "node:path";
import { atomicWrite, withLedgerLock } from "./store.ts";
import type { QualityPlanResult } from "./language-adapters.ts";
import type { ProjectFingerprint } from "./project-fingerprint.ts";
import { refreshDerived } from "./dashboard.ts";
import { qualityResultSummary, weakestEvidence } from "./quality-evidence.ts";

export interface QualityRunProvenance {
  source_before: ProjectFingerprint;
  source_after: ProjectFingerprint;
}

/** Persist a secret-minimised quality summary; raw stdout/stderr never enter the ledger. */
export function saveQualityRun(root: string, result: QualityPlanResult, provenance?: QualityRunProvenance): string {
  const runAt = new Date();
  const stamp = runAt.toISOString().replace(/[-:]/g, "").replace("T", "-").replace(".", "-").replace(/Z$/, "");
  const effectiveOk = result.ok && result.execute && result.results.length > 0 && result.results.every((item) =>
    item.status === "passed" && item.exitCode === 0 && item.signal === null);
  const summaries = result.results.map(qualityResultSummary);
  const payload = JSON.stringify({
    schema_version: 2,
    run_at: runAt.toISOString(),
    ok: effectiveOk,
    reported_ok: result.ok,
    execute: result.execute,
    evidence_level: result.execute && result.results.some((item) => item.exitCode !== null) ? weakestEvidence(summaries.filter((_item, i) => ["test", "coverage"].includes(result.results[i].command.kind)).map((item) => item.evidence_level)) : "unverified",
    environment: { platform: process.platform, arch: process.arch, node: process.version },
    source: provenance ? {
      before: provenance.source_before,
      after: provenance.source_after,
      stable: provenance.source_before.sha256 === provenance.source_after.sha256,
    } : null,
    results: result.results.map((item, index) => ({
      unit_root: item.command.cwd,
      kind: item.command.kind,
      command: item.command.command,
      args: item.command.args,
      status: item.status,
      exit_code: item.exitCode,
      signal: item.signal,
      duration_ms: item.durationMs,
      output_truncated: item.truncated,
      output_summary: summaries[index],
      error: item.error ?? "",
    })),
  }, null, 2) + "\n";
  const absoluteRoot = path.resolve(root);
  const relative = withLedgerLock(absoluteRoot, () => {
    const directory = path.join(absoluteRoot, ".pm", "quality-runs");
    fs.mkdirSync(directory, { recursive: true });
    for (let sequence = 0; sequence < 10_000; sequence += 1) {
      const name = `quality-${stamp}-${String(sequence).padStart(4, "0")}.json`;
      const file = path.join(directory, name);
      if (fs.existsSync(file)) continue;
      atomicWrite(file, payload);
      return `.pm/quality-runs/${name}`;
    }
    throw new Error(`同一毫秒内质量证据数量超过上限，拒绝覆盖: ${stamp}`);
  });
  // Quality evidence is user-visible project state. Keep PROJECT.md in sync so
  // a failed run cannot remain hidden behind the previous green dashboard.
  refreshDerived(absoluteRoot);
  return relative;
}
