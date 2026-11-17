#!/usr/bin/env node
import path from "node:path";

if (process.argv[2] === "setup") {
  try {
    const { runSetup } = await import("./setup.ts");
    process.exitCode = runSetup(process.argv.slice(3));
  } catch (error) {
    console.error(`[pm-mcp setup] ERROR: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
} else if (process.argv[2] === "doctor") {
  try {
    const { parseDoctorArgs, runDoctor } = await import("./doctor.ts");
    if (process.argv.includes("--help") || process.argv.includes("-h")) console.log("pm-mcp doctor --root <项目> [--client codex|workbuddy|qoder] [--config <配置文件> | --entry <本地入口>]");
    else {
      const result = await runDoctor(parseDoctorArgs(process.argv.slice(3)));
      console.log(JSON.stringify(result, null, 2));
      process.exitCode = result.ok ? 0 : 1;
    }
  } catch (error) {
    console.error(`[pm-mcp doctor] ERROR: ${(error as Error).message}`);
    process.exitCode = 1;
  }
} else if (process.argv[2] === "ui") {
  try {
    const { startUiServer } = await import("./ui.ts");
    const args = process.argv.slice(3);
    const value = (flag: string): string | undefined => {
      const index = args.indexOf(flag);
      return index >= 0 ? args[index + 1] : undefined;
    };
    const root = value("--root") ?? process.cwd();
    const portArg = value("--port");
    const { url, close } = await startUiServer(root, { port: portArg ? Number(portArg) : 0 });
    console.log(`pm-mcp ui 已启动（只读、仅绑定 127.0.0.1）：${url}  按 Ctrl+C 退出`);
    const shutdown = (): void => { void close().finally(() => process.exit(0)); };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    await new Promise<never>(() => {});
  } catch (error) {
    console.error(`[pm-mcp ui] ERROR: ${(error as Error).message}`);
    process.exitCode = 1;
  }
} else if (process.argv[2] === "probe") {
  try {
    const { PROBE_USAGE, parseProbeArgs, runProbe } = await import("./probe.ts");
    if (process.argv.includes("--help") || process.argv.includes("-h")) console.log(PROBE_USAGE);
    else {
      const report = await runProbe(parseProbeArgs(process.argv.slice(3)));
      console.log(JSON.stringify(report, null, 2));
      process.exitCode = report.ok ? 0 : 1;
    }
  } catch (error) {
    console.error(`[pm-mcp probe] ERROR: ${(error as Error).message}`);
    process.exitCode = 1;
  }
} else if (process.argv[2] === "launch") {
  try {
    const { runQoderLaunch } = await import("./qoder-launch.ts");
    runQoderLaunch(process.argv.slice(3));
  } catch (error) {
    console.error(`[pm-mcp launch] ERROR: ${(error as Error).message}`);
    process.exitCode = 1;
  }
} else if (process.argv[2] === "sync") {
  try {
    const { runSyncCli } = await import("./sync.ts");
    if (process.argv.includes("--help") || process.argv.includes("-h")) console.log("pm-mcp sync [status|push]  带安全门的 git push（密钥扫描高危阻断 + 人工确认）");
    else process.exitCode = await runSyncCli(process.argv.slice(3), process.cwd());
  } catch (error) {
    console.error(`[pm-mcp sync] ERROR: ${(error as Error).message}`);
    process.exitCode = 1;
  }
} else if (process.argv[2] === "sync-agents") {
  try {
    const { syncAgentsMd } = await import("./agents-md.ts");
    const { isInitialized } = await import("./paths.ts");
    const args = process.argv.slice(3);
    if (args.includes("--help") || args.includes("-h")) {
      console.log("pm-mcp sync-agents [--root <项目>] [--dry-run]");
    } else {
      const value = (flag: string): string | undefined => {
        const index = args.indexOf(flag);
        return index >= 0 ? args[index + 1] : undefined;
      };
      const root = value("--root") ?? process.cwd();
      if (!isInitialized(root)) throw new Error(`项目未初始化（${root} 下没有 .pm/project.json）。请先 init_project。`);
      const dryRun = args.includes("--dry-run");
      const sync = syncAgentsMd(root, { dryRun });
      const added = sync.added.length > 0 ? sync.added.join(", ") : "无";
      const present = sync.present.length > 0 ? sync.present.join(", ") : "无";
      if (sync.result === "unchanged") console.log("✅ AGENTS.md 已是最新，无需变更");
      else if (sync.result === "created") console.log(`${dryRun ? "🔎 预览（未写盘）" : "✅ 已创建"} AGENTS.md：写入 [${added}]`);
      else console.log(`${dryRun ? "🔎 预览（未写盘）" : "✅ 已同步"} AGENTS.md：追加 [${added}]；已存在 [${present}]`);
      console.log(`文件: ${path.join(root, "AGENTS.md")}`);
    }
  } catch (error) {
    console.error(`[pm-mcp sync-agents] ERROR: ${(error as Error).message}`);
    process.exitCode = 1;
  }
} else {
  await import("./index.ts");
}
