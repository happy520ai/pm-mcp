import fs from "node:fs";
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
  const data = loadRegistry();
  const abs = path.resolve(root);
  const idx = data.projects.findIndex((p) => path.resolve(p.root) === abs);
  const entry: RegistryEntry = { name, root: abs, last_seen: now() };
  if (idx >= 0) data.projects[idx] = entry;
  else data.projects.push(entry);
  saveRegistry(data);
}

export function listRegistry(): RegistryEntry[] {
  return loadRegistry().projects.sort((a, b) => b.last_seen.localeCompare(a.last_seen));
}
