import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseAgentBenchmarkArgs, runAgentBenchmark, writeBenchmarkJson } from "../scripts/benchmark-agents.mts";
import { closePartialConnections, type ConnectedAgent } from "../scripts/agent-benchmark-support.mts";

test("Agent 基准参数支持 10/20 档位与轮数", () => {
  assert.deepEqual(parseAgentBenchmarkArgs(["--agents", "10,20", "--rounds", "30"]), {
    agents: [10, 20],
    rounds: 30,
    help: false,
  });
  assert.throws(() => parseAgentBenchmarkArgs(["--agents", "10,10"]), /重复档位/);
  assert.throws(() => parseAgentBenchmarkArgs(["--rounds", "0"]), /正整数/);
  assert.equal(parseAgentBenchmarkArgs(["--output", "evidence.json"]).output, "evidence.json");
  assert.throws(() => parseAgentBenchmarkArgs(["--output", "evidence.txt"]), /\.json/);
});

test("initialize 部分失败清理同时关闭 client 与 transport", async () => {
  let clientCloses = 0;
  let transportCloses = 0;
  const agents = [false, true].map((clientFails) => ({
    client: {
      close: async () => {
        clientCloses += 1;
        if (clientFails) throw new Error("synthetic client close failure");
      },
    },
    transport: {
      pid: null,
      close: async () => { transportCloses += 1; },
    },
    stderr: [],
  })) as unknown as ConnectedAgent[];
  const cleanup = await closePartialConnections(agents);
  assert.equal(clientCloses, 2);
  assert.equal(transportCloses, 2);
  assert.equal(cleanup.close_errors.length, 1);
  assert.deepEqual(cleanup.orphan_pids, []);
});

test("小轮独立 MCP Agent 压力场景通过且无残留", { timeout: 120_000 }, async (t) => {
  const result = await runAgentBenchmark({ agents: [2], rounds: 1 });
  assert.equal(result.ok, true, JSON.stringify(result, null, 2));
  const groups = result.groups as Array<Record<string, unknown>>;
  assert.equal(groups.length, 1);
  const group = groups[0];
  const initialization = group.initialization as Record<string, unknown>;
  assert.equal(initialization.initialized, 2);
  assert.equal(initialization.unique_pids, 2);
  assert.equal(initialization.barrier_released_after_all_initialized, true);

  const aggregate = group.aggregate as Record<string, number>;
  assert.equal(aggregate.sent, 10);
  assert.equal(aggregate.done, 10);
  assert.equal(aggregate.peak_inflight, 2);
  assert.ok(aggregate.duration_ms > 0);

  const rounds = group.round_results as Array<{ scenarios: Array<Record<string, unknown>> }>;
  assert.deepEqual(rounds[0].scenarios.map((scenario) => scenario.name), [
    "same_key_same_args",
    "same_key_conflict",
    "distinct_key_writes",
    "keyless_instantaneous",
    "coalesced_same_args_read",
  ]);
  for (const scenario of rounds[0].scenarios) {
    assert.equal(scenario.sent, 2);
    assert.equal(scenario.done, 2);
    assert.equal(scenario.peak_inflight, 2);
    assert.equal(scenario.all_dispatched_before_first_done, true);
    assert.equal(typeof scenario.dispatch_skew_ms, "number");
    const latency = scenario.call_latency_ms as Record<string, number>;
    assert.equal(latency.samples, 2);
    assert.ok(latency.p50 >= 0 && latency.p95 >= latency.p50 && latency.max >= latency.p95);
  }
  const readChecks = rounds[0].scenarios[4].checks as Record<string, unknown>;
  assert.equal(readChecks.fake_rg_marker_delta, 1);

  const artifacts = group.artifacts as Record<string, unknown>;
  assert.equal(artifacts.passed, true);
  const summaries = group.scenario_summaries as Record<string, Record<string, unknown>>;
  assert.equal(Object.keys(summaries).length, 5);
  for (const summary of Object.values(summaries)) {
    assert.deepEqual((summary.batch_duration_ms as Record<string, number>).samples, 1);
    assert.deepEqual((summary.dispatch_skew_ms as Record<string, number>).samples, 1);
  }
  assert.deepEqual((group.lifecycle as Record<string, unknown>).orphan_pids, []);
  assert.equal((group.cleanup as Record<string, unknown>).removed, true);

  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pm-agent-output-test-"));
  t.after(() => fs.rmSync(outputRoot, { recursive: true, force: true }));
  const output = path.join(outputRoot, "evidence.json");
  assert.equal(writeBenchmarkJson(output, result), path.resolve(output));
  assert.equal((JSON.parse(fs.readFileSync(output, "utf8")) as { ok: boolean }).ok, true);
  assert.equal(fs.readdirSync(outputRoot).some((name) => name.endsWith(".tmp")), false);
  assert.throws(() => writeBenchmarkJson(output, result), /拒绝覆盖/);
});
