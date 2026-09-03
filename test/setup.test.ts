import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  PACKAGE_SPEC,
  detectClients,
  mergeJsonServer,
  parseSetupArgs,
  runSetup,
  writeJsonClientConfig,
} from "../src/setup.ts";

test("setup 参数默认自动检测，并支持显式客户端、force 与 dry-run", () => {
  assert.deepEqual(parseSetupArgs([]), { client: "auto", force: false, dryRun: false, help: false });
  assert.deepEqual(parseSetupArgs(["--client", "codex", "--force", "--dry-run"]), {
    client: "codex", force: true, dryRun: true, help: false,
  });
  assert.throws(() => parseSetupArgs(["--client", "unknown"]), /--client must be/);
  assert.throws(() => parseSetupArgs(["--unknown"]), /unknown setup argument/);
});

test("自动检测覆盖 CLI、环境变量和现有配置目录", () => {
  const home = path.join(os.tmpdir(), "pm-setup-detect");
  const commands = new Set(["claude", "code"]);
  const existing = new Set([path.join(home, ".cursor")]);
  const clients = detectClients({
    env: { CODEX_HOME: path.join(home, "codex"), ZCODE_HOME: path.join(home, "zcode") },
    home,
    commandExists: (command) => commands.has(command),
    exists: (target) => existing.has(target),
  });
  assert.deepEqual(clients, ["codex", "claude", "zcode", "cursor", "vscode"]);
});

test("JSON 配置合并保留未知字段并写入固定版本 MCP 定义", () => {
  const standard = mergeJsonServer({ existing: { keep: true }, mcpServers: { other: { command: "x" } } }, "standard");
  assert.deepEqual((standard.existing as { keep: boolean }).keep, true);
  const servers = standard.mcpServers as Record<string, { command: string; args?: string[] }>;
  assert.equal(servers.other.command, "x");
  assert.deepEqual(servers["pm-mcp"], { command: "npx", args: ["-y", PACKAGE_SPEC], env: {} });

  const zcode = mergeJsonServer({}, "zcode");
  const zcodeServers = ((zcode.mcp as { servers: Record<string, unknown> }).servers);
  assert.ok(zcodeServers["pm-mcp"]);
});

test("写配置前备份，重复执行可更新且不破坏已有字段", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pm-setup-json-"));
  const file = path.join(root, "config.json");
  fs.writeFileSync(file, JSON.stringify({ existing: { keep: true } }), "utf8");
  const backup = writeJsonClientConfig(file, "zcode");
  assert.ok(backup && fs.existsSync(backup));
  const saved = JSON.parse(fs.readFileSync(file, "utf8")) as { existing: { keep: boolean }; mcp: { servers: Record<string, { args: string[] }> } };
  assert.equal(saved.existing.keep, true);
  assert.equal(saved.mcp.servers["pm-mcp"].args[1], PACKAGE_SPEC);
});

test("坏 JSON fail-closed，不覆盖原文件或制造备份", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pm-setup-bad-"));
  const file = path.join(root, "config.json");
  fs.writeFileSync(file, "{broken", "utf8");
  assert.throws(() => writeJsonClientConfig(file, "standard"), /invalid JSON/);
  assert.equal(fs.readFileSync(file, "utf8"), "{broken");
  assert.equal(fs.readdirSync(root).length, 1);
});

test("统一 CLI setup dry-run 不写配置并输出计划", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pm-setup-dry-"));
  const logs: string[] = [];
  const code = runSetup(["--client", "zcode", "--dry-run"], {
    env: { ZCODE_HOME: root },
    home: root,
    commandExists: () => false,
    exists: () => false,
    log: (message) => logs.push(message),
  });
  assert.equal(code, 0);
  assert.ok(logs.some((line) => line.includes(PACKAGE_SPEC)));
  assert.ok(!fs.existsSync(path.join(root, "cli", "config.json")));
});

test("dist CLI 的 setup 路径与 MCP server 路径严格分流", () => {
  const result = spawnSync(process.execPath, [path.resolve("dist/cli.js"), "setup", "--client", "print"], {
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /mcpServers/);
  assert.match(result.stdout, /pm-mcp/);
});
