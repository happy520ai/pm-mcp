import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  PACKAGE_SPEC,
  appendCodexProjectConfig,
  codexProjectServerKey,
  detectClients,
  localProjectLaunch,
  localServerLaunch,
  mergeJsonServer,
  parseSetupArgs,
  runSetup,
  workbuddyConfigPath,
  writeJsonClientConfig,
} from "../src/setup.ts";

test("setup 参数默认自动检测，并支持显式客户端、force 与 dry-run", () => {
  assert.deepEqual(parseSetupArgs([]), { client: "auto", force: false, dryRun: false, help: false, project: false });
  assert.deepEqual(parseSetupArgs(["--client", "codex", "--force", "--dry-run"]), {
    client: "codex", force: true, dryRun: true, help: false, project: false,
  });
  assert.throws(() => parseSetupArgs(["--client", "unknown"]), /--client must be/);
  assert.throws(() => parseSetupArgs(["--unknown"]), /unknown setup argument/);
});

test("不同中文项目和同名目录独立注册，路径别名重复执行保持幂等", () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "pm-setup-identities-"));
  const file = path.join(sandbox, "config.toml");
  const roots = ["项目甲", "项目乙", "a/demo", "b/demo"].map((rel) => path.join(sandbox, rel));
  for (const root of roots) {
    fs.mkdirSync(root, { recursive: true });
    appendCodexProjectConfig(file, root, false, false, () => {});
  }
  const config = fs.readFileSync(file, "utf8");
  assert.equal(new Set(roots.map(codexProjectServerKey)).size, 4);
  for (const root of roots) assert.ok(config.includes(root.replace(/\\/g, "/")));
  appendCodexProjectConfig(file, roots[0] + path.sep + ".", false, false, () => {});
  assert.equal(fs.readFileSync(file, "utf8"), config);
  const alias = path.join(sandbox, "alias");
  fs.symlinkSync(roots[0], alias, "junction");
  assert.equal(codexProjectServerKey(alias), codexProjectServerKey(roots[0]));
  appendCodexProjectConfig(file, alias, false, false, () => {});
  assert.equal(fs.readFileSync(file, "utf8"), config, "目录联接不应重复注册");
});

test("已有服务键指向其他项目时拒绝假成功，旧版同项目条目可复用", () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "pm-setup-existing-"));
  const file = path.join(sandbox, "config.toml");
  const root = path.join(sandbox, "demo");
  fs.mkdirSync(root);
  const wrong = `[mcp_servers.${codexProjectServerKey(root)}]\ncommand = "npx"\nargs = ["-y", "${PACKAGE_SPEC}", "--root", "E:/different-project"]\n`;
  fs.writeFileSync(file, wrong);
  assert.throws(() => appendCodexProjectConfig(file, root, false, false, () => {}), /无法确认|不同项目/);
  assert.equal(fs.readFileSync(file, "utf8"), wrong);
  const legacy = `[mcp_servers.pm-mcp-demo]\ncommand = "npx"\nargs = ["-y", "${PACKAGE_SPEC}", "--root", ${JSON.stringify(root.replace(/\\/g, "/"))}]\n`;
  fs.writeFileSync(file, legacy);
  appendCodexProjectConfig(file, root, false, false, () => {});
  assert.equal(fs.readFileSync(file, "utf8"), legacy, "旧版正确条目不应重复注册");
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

test("同一毫秒连续写配置仍保留每一次独立备份", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1700000000000 });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pm-setup-backup-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "config.json");
  fs.writeFileSync(file, JSON.stringify({ retained: true }));
  const backups = new Set<string>();
  for (let i = 0; i < 3; i++) {
    const before = fs.readFileSync(file, "utf8");
    const backup = writeJsonClientConfig(file, "standard");
    assert.ok(backup);
    assert.equal(fs.readFileSync(backup, "utf8"), before);
    backups.add(backup);
  }
  assert.equal(backups.size, 3);
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

test("发行版本一致，构建后的 CLI 实际支持 --project 预览且不写配置", (t) => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "pm-setup-built-"));
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
  const metadata = JSON.parse(fs.readFileSync(path.resolve("package.json"), "utf8"));
  assert.equal(PACKAGE_SPEC, `${metadata.name}@${metadata.version}`);
  const result = spawnSync(process.execPath, [path.resolve("dist/cli.js"), "setup", "--client", "codex", "--project", sandbox, "--dry-run"], {
    encoding: "utf8", timeout: 10_000,
    env: { ...process.env, CODEX_HOME: path.join(sandbox, "client"), PM_MCP_HOME: path.join(sandbox, "registry") },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes(PACKAGE_SPEC));
  assert.match(result.stdout, /\[plan\] init_project/);
  assert.equal(fs.existsSync(path.join(sandbox, "client/config.toml")), false);
  assert.equal(fs.existsSync(path.join(sandbox, ".pm")), false);
});

test("--project 参数解析：开关 + 可选目录", () => {
  assert.equal(parseSetupArgs(["--project"]).project, true);
  assert.equal(parseSetupArgs(["--project"]).projectDir, undefined);
  assert.deepEqual(
    { p: parseSetupArgs(["--project", "D:/x/y"]).projectDir, c: parseSetupArgs(["--project", "--force"]).projectDir },
    { p: "D:/x/y", c: undefined },
  );
  assert.equal(parseSetupArgs(["--client", "codex"]).project, false);
});

test("--project 一条命令：Codex 钉定条目 + 初始化项目 + AGENTS.md 规矩，重复执行幂等", (t) => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "pm-setup-proj-"));
  const oldHome = process.env.PM_MCP_HOME;
  process.env.PM_MCP_HOME = path.join(sandbox, "mcp-home");
  const codexHome = path.join(sandbox, "codex-home");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(path.join(codexHome, "config.toml"), "[features]\nmemories = true\n", "utf8");
  const proj = path.join(sandbox, "demo-app");
  fs.mkdirSync(proj, { recursive: true });
  t.after(() => {
    if (oldHome === undefined) delete process.env.PM_MCP_HOME; else process.env.PM_MCP_HOME = oldHome;
    fs.rmSync(sandbox, { recursive: true, force: true });
  });
  const run = (logs: string[]) => runSetup(["--client", "codex", "--project"], {
    env: { CODEX_HOME: codexHome, PM_MCP_HOME: process.env.PM_MCP_HOME },
    home: codexHome,
    cwd: proj,
    commandExists: () => false,
    exists: () => false,
    log: (message) => logs.push(message),
  });

  const logs: string[] = [];
  assert.equal(run(logs), 0);

  const config = fs.readFileSync(path.join(codexHome, "config.toml"), "utf8");
  assert.ok(config.includes(`[mcp_servers.${codexProjectServerKey(proj)}]`), "应写入带完整路径身份的钉定条目");
  assert.match(config, /"--root"/);
  assert.ok(config.includes(proj.replace(/\\/g, "/")), "root 应指向项目目录（正斜杠）");
  assert.match(config, /\[features\]\nmemories = true/, "既有内容保留");
  const backups = fs.readdirSync(codexHome).filter((f) => f.startsWith("config.toml.backup-"));
  assert.equal(backups.length, 1, "写前应有且仅有一次备份");

  assert.equal(fs.existsSync(path.join(proj, ".pm", "project.json")), true, "项目应已初始化");
  assert.equal(fs.existsSync(path.join(proj, "AGENTS.md")), true, "AGENTS.md 工作规矩应自动写入");
  assert.equal(fs.existsSync(path.join(proj, "PROJECT.md")), true, "仪表盘应生成");
  assert.ok(logs.some((l) => l.includes("[init]")));

  const logs2: string[] = [];
  assert.equal(run(logs2), 0, "重复执行应幂等");
  assert.ok(logs2.some((l) => l.includes("[skip] Codex already has")), "条目应跳过");
  assert.ok(logs2.some((l) => l.includes("[skip] 项目已初始化")), "init 应跳过");
  assert.equal(fs.readdirSync(codexHome).filter((f) => f.startsWith("config.toml.backup-")).length, 1, "不产生新备份");
});

test("本地启动定义：钉根版带 --root，通用版不带（项目根由宿主 cwd 决定）", () => {
  const root = path.join(os.tmpdir(), "pm-setup-launch");
  const entry = path.resolve("dist/index.js");
  assert.deepEqual(localProjectLaunch(root), { command: process.execPath, args: [entry, "--root", path.resolve(root)] });
  assert.deepEqual(localServerLaunch(), { command: process.execPath, args: [entry] });
});

test("WorkBuddy 路径解析：WORKBUDDY_CONFIG_DIR → .workbuddy-ai → .workbuddy → 默认当前目录", () => {
  const home = path.join(os.tmpdir(), "pm-setup-wb-path");
  const legacyOnly = new Set([path.join(home, ".workbuddy")]);
  assert.equal(workbuddyConfigPath({}, home, (target) => legacyOnly.has(target)), path.join(home, ".workbuddy", "mcp.json"));
  const both = new Set([path.join(home, ".workbuddy"), path.join(home, ".workbuddy-ai")]);
  assert.equal(workbuddyConfigPath({}, home, (target) => both.has(target)), path.join(home, ".workbuddy-ai", "mcp.json"));
  assert.equal(workbuddyConfigPath({}, home, () => false), path.join(home, ".workbuddy-ai", "mcp.json"));
  assert.equal(workbuddyConfigPath({ WORKBUDDY_CONFIG_DIR: path.join(home, "custom") }, home, () => true), path.join(home, "custom", "mcp.json"));
});

test("WorkBuddy 由既有数据目录被自动检测到，且 --client workbuddy 接受 --local", () => {
  const home = path.join(os.tmpdir(), "pm-setup-wb-detect");
  const existing = new Set([path.join(home, ".workbuddy-ai")]);
  assert.deepEqual(
    detectClients({ env: {}, home, commandExists: () => false, exists: (target) => existing.has(target) }),
    ["workbuddy"],
  );
  assert.equal(parseSetupArgs(["--client", "workbuddy"]).client, "workbuddy");
  assert.equal(parseSetupArgs(["--client", "workbuddy", "--local"]).local, true);
  assert.throws(() => parseSetupArgs(["--client", "cursor", "--local"]), /--local 目前只支持/);
});

test("WorkBuddy 检测覆盖命令、环境变量与旧版目录三种入口", () => {
  const home = path.join(os.tmpdir(), "pm-setup-wb-detect2");
  const detect = (commands: string[], env: Record<string, string>, existing: string[]) => detectClients({
    env, home, commandExists: (command) => commands.includes(command), exists: (target) => existing.includes(target),
  });
  assert.deepEqual(detect(["workbuddy"], {}, []), ["workbuddy"]);
  assert.deepEqual(detect(["codebuddy"], {}, []), ["workbuddy"]);
  assert.deepEqual(detect([], { WORKBUDDY_CONFIG_DIR: path.join(home, "custom") }, []), ["workbuddy"]);
  assert.deepEqual(detect([], {}, [path.join(home, ".workbuddy")]), ["workbuddy"]);
  assert.deepEqual(detect([], {}, []), []);
});

test("多客户端同时配置时，结尾逐条给出各自的重连/授权要求", (t) => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "pm-setup-multi-"));
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
  // 用既有配置目录触发 codex 与 workbuddy 的检测，commandExists 全 false 以免真的拉起外部命令。
  const existing = new Set([path.join(sandbox, ".codex"), path.join(sandbox, ".workbuddy-ai")]);
  const logs: string[] = [];
  assert.equal(runSetup(["--dry-run"], {
    env: {}, home: sandbox,
    commandExists: () => false,
    exists: (target) => existing.has(target),
    log: (message) => logs.push(message),
  }), 0);
  const closing = logs.filter((line) => line.startsWith("完成")).join(" ");
  assert.ok(closing.includes("WorkBuddy 需在"), closing);
  assert.ok(closing.includes("Codex 需完全退出并重启"), closing);
  assert.equal(fs.existsSync(path.join(sandbox, ".workbuddy-ai", "mcp.json")), false, "dry-run 不落盘");
});

test("WorkBuddy 写入标准 mcp.json：保留未知字段与既有 server，本地入口不钉根", (t) => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "pm-setup-wb-"));
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
  const configDir = path.join(sandbox, ".workbuddy-ai");
  fs.mkdirSync(configDir, { recursive: true });
  const file = path.join(configDir, "mcp.json");
  fs.writeFileSync(file, JSON.stringify({ keep: true, mcpServers: { other: { command: "x" } } }), "utf8");

  const logs: string[] = [];
  assert.equal(runSetup(["--client", "workbuddy", "--local"], {
    env: { WORKBUDDY_CONFIG_DIR: configDir },
    home: sandbox,
    commandExists: () => false,
    exists: (target) => fs.existsSync(target),
    log: (message) => logs.push(message),
  }), 0);

  const saved = JSON.parse(fs.readFileSync(file, "utf8")) as {
    keep: boolean;
    mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
  };
  assert.equal(saved.keep, true, "未知顶层字段应保留");
  assert.equal(saved.mcpServers.other.command, "x", "既有 server 应保留");
  const pm = saved.mcpServers["pm-mcp"];
  assert.equal(pm.command, process.execPath);
  assert.ok(pm.args[0].replace(/\\/g, "/").endsWith("dist/index.js"));
  assert.ok(!pm.args.includes("--root"), "WorkBuddy 条目不钉根，项目根由会话工作区决定");
  assert.deepEqual(pm.env, {});
  assert.equal(fs.readdirSync(configDir).filter((name) => name.startsWith("mcp.json.backup-")).length, 1, "写前应有一次备份");
  assert.ok(logs.some((line) => line.includes("连接器管理")), "应提示在 WorkBuddy 内确认信任");
});

test("WorkBuddy 默认写入发布版 npx 启动项，dry-run 不落盘", (t) => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "pm-setup-wb2-"));
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
  const configDir = path.join(sandbox, ".workbuddy-ai");
  fs.mkdirSync(configDir, { recursive: true });
  const file = path.join(configDir, "mcp.json");
  const logs: string[] = [];
  assert.equal(runSetup(["--client", "workbuddy", "--dry-run"], {
    env: { WORKBUDDY_CONFIG_DIR: configDir }, home: sandbox,
    commandExists: () => false, exists: (target) => fs.existsSync(target), log: (message) => logs.push(message),
  }), 0);
  assert.equal(fs.existsSync(file), false, "dry-run 不应创建配置");
  assert.ok(logs.some((line) => line.includes("[plan]")));

  assert.equal(runSetup(["--client", "workbuddy"], {
    env: { WORKBUDDY_CONFIG_DIR: configDir }, home: sandbox,
    commandExists: () => false, exists: (target) => fs.existsSync(target), log: (message) => logs.push(message),
  }), 0);
  const saved = JSON.parse(fs.readFileSync(file, "utf8")) as { mcpServers: Record<string, unknown> };
  assert.deepEqual(saved.mcpServers["pm-mcp"], { command: "npx", args: ["-y", PACKAGE_SPEC], env: {} });
});

test("坏 JSON 的 WorkBuddy 配置 fail-closed，不覆盖也不留备份", (t) => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "pm-setup-wb3-"));
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
  const configDir = path.join(sandbox, ".workbuddy-ai");
  fs.mkdirSync(configDir, { recursive: true });
  const file = path.join(configDir, "mcp.json");
  fs.writeFileSync(file, "{broken", "utf8");
  assert.throws(() => writeJsonClientConfig(file, "standard"), /invalid JSON/);
  assert.equal(fs.readFileSync(file, "utf8"), "{broken");
  assert.deepEqual(fs.readdirSync(configDir), ["mcp.json"]);
});

test("--project 非 ASCII 目录名支持稳定服务键；dry-run 不写任何东西", (t) => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "pm-setup-proj2-"));
  const oldHome = process.env.PM_MCP_HOME;
  process.env.PM_MCP_HOME = path.join(sandbox, "mcp-home");
  const codexHome = path.join(sandbox, "codex-home");
  fs.mkdirSync(codexHome, { recursive: true });
  const proj = path.join(sandbox, "猫头鹰项目");
  fs.mkdirSync(proj, { recursive: true });
  t.after(() => {
    if (oldHome === undefined) delete process.env.PM_MCP_HOME; else process.env.PM_MCP_HOME = oldHome;
    fs.rmSync(sandbox, { recursive: true, force: true });
  });
  const logs: string[] = [];
  const code = runSetup(["--client", "codex", "--project", "--dry-run"], {
    env: { CODEX_HOME: codexHome, PM_MCP_HOME: process.env.PM_MCP_HOME },
    home: codexHome,
    cwd: proj,
    commandExists: () => false,
    exists: () => false,
    log: (message) => logs.push(message),
  });
  assert.equal(code, 0);
  assert.equal(fs.existsSync(path.join(codexHome, "config.toml")), false, "dry-run 不写 config");
  assert.equal(fs.existsSync(path.join(proj, ".pm")), false, "dry-run 不初始化");
  assert.ok(logs.some((l) => l.includes("[plan]")));
});
