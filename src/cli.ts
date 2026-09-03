#!/usr/bin/env node

if (process.argv[2] === "setup") {
  try {
    const { runSetup } = await import("./setup.ts");
    process.exitCode = runSetup(process.argv.slice(3));
  } catch (error) {
    console.error(`[pm-mcp setup] ERROR: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
} else {
  await import("./index.ts");
}
