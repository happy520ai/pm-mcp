import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RegistrySchema, now, type RegistryEntry } from "./types.ts";
import { registryFile } from "./paths.ts";
import { atomicWrite } from "./store.ts";

export function loadRegistry(): { projects: RegistryEntry[] } {
  const file = registryFile();
  if (!fs.existsSync(file)) return { projects: [] };
  try {
    return RegistrySchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch (e) {
    // 注册表损坏不应拖垮任何工具，告警后按空表处理
    console.error(`[pm-mcp] 全局注册表读取失败，按空表处理: ${(e as Error).message}`);
    return { projects: [] };
  }
}

export function saveRegistry(data: { projects: RegistryEntry[] }): void {
  const file = registryFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  atomicWrite(file, JSON.stringify(data, null, 2) + "\n");
}

/** 登记/刷新一个项目（init 与每次写操作都会 touch） */
export function touchRegistry(root: string, name: string): void {
  const abs = path.resolve(root);
  // 防污染（T-034 根因）：临时目录里的"项目"从不进入真实注册表——
  // 测试若未设 PM_MCP_HOME 沙箱，写入会被这里拦下而不是污染 ~/.pm-mcp。
  // 沙箱化测试（显式设了 PM_MCP_HOME）不受影响，仍写沙箱注册表。
  if (!process.env.PM_MCP_HOME?.trim() && isUnderTemp(abs)) {
    console.error(`[pm-mcp] 跳过注册临时目录项目（如需管理请移出临时目录）: ${abs}`);
    return;
  }
  const data = loadRegistry();
  // Windows 路径大小写不敏感：按小写比较去重（e:/E: 重复注册缺陷）
  const key = abs.toLowerCase();
  const idx = data.projects.findIndex((p) => path.resolve(p.root).toLowerCase() === key);
  const entry: RegistryEntry = { name, root: abs, last_seen: now() };
  if (idx >= 0) data.projects[idx] = entry;
  else data.projects.push(entry);
  saveRegistry(data);
}

function isUnderTemp(abs: string): boolean {
  const normalized = abs.toLowerCase();
  // tmpdir 可能以 8.3 短名返回（ADMINI~1），与注册表里的长名不一致——两种形态都比对
  let tmpLong = os.tmpdir().toLowerCase();
  try {
    tmpLong = fs.realpathSync.native(os.tmpdir()).toLowerCase();
  } catch {
    /* keep default */
  }
  for (const tmp of new Set([tmpLong, os.tmpdir().toLowerCase()])) {
    if (normalized === tmp || normalized.startsWith(tmp.replace(/\$/, "") + path.sep)) return true;
  }
  return false;
}

export function listRegistry(): RegistryEntry[] {
  return loadRegistry().projects.sort((a, b) => b.last_seen.localeCompare(a.last_seen));
}
