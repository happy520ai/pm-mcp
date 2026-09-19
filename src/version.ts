import fs from "node:fs";

// src/ 与发布后的 dist/ 共用包根，避免服务端与安装器各自硬编码版本。
const metadata = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { name: string; version: string };
export const SERVER_NAME = "pm-mcp";
export const VERSION = metadata.version;
export const PACKAGE_SPEC = `${metadata.name}@${VERSION}`;
export const RUNTIME_CONTRACT = "pagination-evidence-v1";
// 服务器工具目录契约（doctor 与独立巡检 health-check 都以此核对）。
// 新增/移除 MCP 工具时必须同步更新这里，并用 `pm-mcp probe` 实测复核。
export const TOOL_CATALOG_SIZE = 52;
