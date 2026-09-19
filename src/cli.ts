#!/usr/bin/env node

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
    if (process.argv.includes("--help") || process.argv.includes("-h")) console.log("pm-mcp doctor --root <项目> [--client codex|workbuddy] [--config <配置文件> | --entry <本地入口>]");
    else {
      const result = await runDoctor(parseDoctorArgs(process.argv.slice(3)));
      console.log(JSON.stringify(result, null, 2));
      process.exitCode = result.ok ? 0 : 1;
    }
  } catch (error) {
    console.error(`[pm-mcp doctor] ERROR: ${(error as Error).message}`);
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
} else {
  await import("./index.ts");
}
