import fs from "node:fs";

// src/ 与发布后的 dist/ 共用包根，避免服务端与安装器各自硬编码版本。
const metadata = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { name: string; version: string };
export const SERVER_NAME = "pm-mcp";
export const VERSION = metadata.version;
export const PACKAGE_SPEC = `${metadata.name}@${VERSION}`;
export const RUNTIME_CONTRACT = "pagination-evidence-v1";
