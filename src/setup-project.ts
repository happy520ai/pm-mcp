import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { atomicWrite } from "./store.ts";
import { PACKAGE_SPEC, SERVER_NAME } from "./version.ts";

export interface ProjectLaunch { command: string; args: string[]; }
export interface CodexProjectEntry extends ProjectLaunch { name: string; root: string; start: number; end: number; enabled: boolean; toolFilters: boolean; }

export function canonicalProjectRoot(root: string): string {
  const absolute = path.resolve(root);
  let real: string;
  try { real = fs.realpathSync.native(absolute); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; real = absolute; }
  return process.platform === "win32" ? real.toLowerCase() : real;
}

export function codexProjectServerKey(root: string): string {
  const canonical = canonicalProjectRoot(root);
  const slug = path.basename(canonical).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "project";
  return `${SERVER_NAME}-${slug}-${createHash("sha256").update(canonical).digest("hex").slice(0, 12)}`;
}

function stringValue(value: string): string {
  return value.startsWith("'") ? value.slice(1, -1) : JSON.parse(value);
}

/** 仅处理本安装器的单行参数形式；复杂 TOML 明确拒绝，不猜测或输出配置原文。 */
export function findCodexProjectEntry(text: string, root: string): CodexProjectEntry | undefined {
  if (text.includes('"""') || text.includes("'''")) throw new Error("配置包含多行字符串，自动升级无法安全确认段落边界；未修改配置。");
  const canonical = canonicalProjectRoot(root), expected = codexProjectServerKey(root);
  const matches: CodexProjectEntry[] = [];
  const headers = [...text.matchAll(/^(?:\uFEFF)?[ \t]*\[mcp_servers\.(?:([A-Za-z0-9_-]+)|"([^"\r\n]+)"|'([^'\r\n]+)')\][ \t]*(?:#.*)?\r?$/gm)];
  for (const header of headers) {
    const name = header[1] ?? header[2] ?? header[3];
    if (name !== SERVER_NAME && !name.startsWith(SERVER_NAME + "-")) continue;
    const start = header.index! + header[0].length;
    const next = text.slice(start).search(/^[ \t]*\[/m);
    const end = next < 0 ? text.length : start + next;
    const section = text.slice(start, end);
    const commands = [...section.matchAll(/^[ \t]*command[ \t]*=[ \t]*("[^\r\n]*"|'[^\r\n]*')[ \t]*(?:#.*)?\r?$/gm)];
    const arrays = [...section.matchAll(/^[ \t]*args[ \t]*=[ \t]*(\[[^\r\n]*\])[ \t]*(?:#.*)?\r?$/gm)];
    let entry: CodexProjectEntry | undefined;
    try {
      if (commands.length !== 1 || arrays.length !== 1) throw new Error();
      const command: unknown = stringValue(commands[0][1]), args: unknown = JSON.parse(arrays[0][1]);
      if (typeof command !== "string" || !Array.isArray(args) || !args.every((value) => typeof value === "string")) throw new Error();
      const positions = args.flatMap((value, index) => value === "--root" ? [index] : []);
      if (positions.length !== 1 || !path.isAbsolute(args[positions[0] + 1] ?? "")) throw new Error();
      const filters = [...section.matchAll(/^[ \t]*(enabled_tools|disabled_tools)[ \t]*=[ \t]*(\[[^\r\n]*\])/gm)];
      entry = { name, command, args, root: canonicalProjectRoot(args[positions[0] + 1]), start, end,
        enabled: !/^[ \t]*enabled[ \t]*=[ \t]*false\b/m.test(section),
        toolFilters: [...section.matchAll(/^[ \t]*(?:enabled_tools|disabled_tools)[ \t]*=/gm)].length !== filters.length || filters.some((filter) => filter[1] === "enabled_tools" || JSON.parse(filter[2]).length > 0) };
    } catch { /* 无法识别的条目不会被覆盖 */ }
    if (name === expected && entry?.root !== canonical) throw new Error(`已有 [mcp_servers.${name}] 指向不同项目或无法确认 --root；未修改配置。`);
    if (!entry && (name === SERVER_NAME || name === expected.slice(0, -13))) throw new Error("旧 pm-mcp 条目的项目根无法确认，拒绝创建可能重复的启动项。");
    if (entry?.root === canonical) matches.push(entry);
  }
  if (matches.length > 1) throw new Error("多个 pm-mcp 条目指向同一项目，需先明确保留哪个；未修改配置。");
  return matches[0];
}

export function readCodexConfig(file: string): string {
  if (!fs.existsSync(file)) return "";
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) throw new Error("Codex 配置必须为有界普通文件，禁止链接。");
  return fs.readFileSync(file, "utf8");
}

export function isPackageLaunch(entry: ProjectLaunch): boolean {
  return /^npx(?:\.(?:cmd|exe))?$/i.test(path.basename(entry.command)) && entry.args.length === 4 && entry.args[0] === "-y" &&
    /^@luckychen1993\/pm-mcp(?:@[^\s]+)?$/.test(entry.args[1]) && entry.args[2] === "--root";
}

/**
 * 校验启动项指向本包已构建的本地入口（`dist/index.js` 或 `src/index.ts`）。
 *
 * 与 `isLocalLaunch` 的区别：**不要求 `--root`**。WorkBuddy 等多项目宿主
 * 以会话工作区作为子进程 cwd，服务端按 cwd 解析项目根，此时参数里没有 `--root`。
 */
export function isLocalServerEntry(entry: ProjectLaunch): boolean {
  if (!/^node(?:\.exe)?$/i.test(path.basename(entry.command)) || entry.args.length < 1 || !path.isAbsolute(entry.args[0])) return false;
  const file = path.resolve(entry.args[0]);
  if (!/^(?:index|cli)\.(?:js|ts)$/.test(path.basename(file))) return false;
  try { const stat = fs.lstatSync(file); return stat.isFile() && !stat.isSymbolicLink() && JSON.parse(fs.readFileSync(path.join(path.dirname(file), "..", "package.json"), "utf8")).name === "@luckychen1993/pm-mcp"; }
  catch { return false; }
}

export function isLocalLaunch(entry: ProjectLaunch): boolean {
  return entry.args.length === 3 && entry.args[1] === "--root" && isLocalServerEntry(entry);
}

export function appendCodexProjectConfig(file: string, root: string, force: boolean, dryRun: boolean, log: (message: string) => void, local?: ProjectLaunch): void {
  const absolute = path.resolve(file), existing = readCodexConfig(absolute);
  const entry = findCodexProjectEntry(existing, root);
  const desired = local ?? { command: "npx", args: ["-y", PACKAGE_SPEC, "--root", path.resolve(root).replace(/\\/g, "/")] };
  let updated: string;
  if (entry) {
    if (!force) { log(`[skip] Codex already has [mcp_servers.${entry.name}] for this project; --force 可升级，现有配置保留。`); return; }
    if (!isPackageLaunch(entry) && !isLocalLaunch(entry)) throw new Error("当前启动项不是可识别的 pm-mcp npx/node 形式；未修改配置。");
    if (entry.command === desired.command && JSON.stringify(entry.args) === JSON.stringify(desired.args)) { log("[skip] 启动配置已是目标版本；仍需通过 doctor 核验连接。"); return; }
    const section = existing.slice(entry.start, entry.end);
    const replace = (name: string, value: string, input: string) => input.replace(new RegExp(`^([ \\t]*${name}[ \\t]*=[ \\t]*)(?:\\[[^\\r\\n]*\\]|"[^\\r\\n]*"|'[^\\r\\n]*')([ \\t]*(?:#.*)?)(\\r?)$`, "m"), (_all, prefix, suffix, cr) => prefix + value + suffix + cr);
    const patched = replace("args", JSON.stringify(desired.args), replace("command", JSON.stringify(desired.command), section));
    updated = existing.slice(0, entry.start) + patched + existing.slice(entry.end);
    const checked = findCodexProjectEntry(updated, root);
    if (!checked || checked.command !== desired.command || JSON.stringify(checked.args) !== JSON.stringify(desired.args)) throw new Error("启动配置替换验证失败，未写入。");
    log(`[${dryRun ? "plan" : "upgrade"}] Codex [mcp_servers.${entry.name}]；仅替换 command/args，保留其余设置。`);
  } else {
    const separator = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
    const name = codexProjectServerKey(root);
    updated = existing + `${separator}\n[mcp_servers.${name}]\ncommand = ${JSON.stringify(desired.command)}\nargs = ${JSON.stringify(desired.args)}\n`;
    log(`[${dryRun ? "plan" : "write"}] Codex: ${absolute}`);
    log(`[entry] [mcp_servers.${name}] → --root ${path.resolve(root)}`);
  }
  if (dryRun) return;
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  if (readCodexConfig(absolute) !== existing) throw new Error("配置在准备期间发生变化；未写入，请重新预览。");
  if (fs.existsSync(absolute)) fs.copyFileSync(absolute, `${absolute}.backup-${Date.now()}-${randomUUID()}`, fs.constants.COPYFILE_EXCL);
  atomicWrite(absolute, updated);
}
