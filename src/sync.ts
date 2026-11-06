import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { spawnSync } from "node:child_process";
import { z } from "zod";
import { changedGitFiles, resolveGitCommand } from "./git-state.ts";
import { scanSecretsInFiles } from "./security.ts";
import type { SyncPushPrompt } from "./sync-types.ts";

/**
 * 同步 = 带安全门的 git push（ADR-013）。
 * 默认关闭（fail closed）；推送前三步：变更列表 → 密钥扫描（高危阻断）→ 人工 y/N 确认；
 * 确认只能由人注入（交互终端），任何调用方都绕不过 confirm。
 */

export const SyncConfigSchema = z.object({
  enabled: z.boolean().default(false),
  remote: z.string().trim().min(1).max(512).default("origin"),
  branch: z.string().trim().min(1).max(128).default("main"),
});

export type SyncConfig = z.infer<typeof SyncConfigSchema>;

const DEFAULT_CONFIG: SyncConfig = { enabled: false, remote: "origin", branch: "main" };

export interface LoadedSyncConfig {
  config: SyncConfig;
  source: "file" | "default";
  problems: string[];
}

/** .pm/sync.json：仅三字段，缺省/非法/读取失败一律按关闭处理（fail closed）。 */
export function loadSyncConfig(root: string): LoadedSyncConfig {
  const file = path.join(root, ".pm", "sync.json");
  const failClosed = (problems: string[]): LoadedSyncConfig => ({ config: { ...DEFAULT_CONFIG }, source: "default", problems });
  try {
    const parsed = SyncConfigSchema.safeParse(JSON.parse(fs.readFileSync(file, "utf8")));
    if (!parsed.success) {
      return failClosed([
        `.pm/sync.json 非法，已按关闭处理（fail closed）: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"} ${i.message}`).join("; ")}`,
      ]);
    }
    return { config: parsed.data, source: "file", problems: [] };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { config: { ...DEFAULT_CONFIG }, source: "default", problems: [] };
    return failClosed([`.pm/sync.json 读取失败，已按关闭处理（fail closed）: ${error instanceof Error ? error.message : String(error)}`]);
  }
}

export function resolveRemoteUrl(root: string, remoteName: string): string | null {
  const git = resolveGitCommand();
  if (!git) return null;
  const result = spawnSync(git, ["remote", "get-url", remoteName], { cwd: root, encoding: "utf8", timeout: 5000, windowsHide: true });
  return result.status === 0 ? result.stdout.trim() : null;
}

function gitOutput(root: string, args: string[], timeout: number): string | null {
  const git = resolveGitCommand();
  if (!git) return null;
  const result = spawnSync(git, args, { cwd: root, encoding: "utf8", timeout, windowsHide: true });
  return result.status === 0 ? result.stdout : null;
}

/** 未推送提交的差异文件（远端分支不存在时为首次推送：所有已跟踪文件都会出去，全部纳入门禁）。 */
function unpushedFiles(root: string, remote: string, branch: string): string[] {
  const verify = gitOutput(root, ["rev-parse", "--verify", "--quiet", `${remote}/${branch}`], 10000);
  if (verify === null) {
    const ls = gitOutput(root, ["ls-files"], 30000);
    return ls ? ls.split("\n").filter(Boolean) : [];
  }
  const diff = gitOutput(root, ["diff", "--name-only", `${remote}/${branch}...HEAD`], 10000);
  return diff ? diff.split("\n").filter(Boolean) : [];
}

function unpushedCommitCount(root: string, remote: string, branch: string): number | null {
  const count = gitOutput(root, ["rev-list", "--count", `${remote}/${branch}..HEAD`], 10000);
  return count === null ? null : Number(count.trim()) || 0;
}

export interface SyncStatus {
  enabled: boolean;
  source: "file" | "default";
  problems: string[];
  remote: string;
  remoteUrl: string | null;
  branch: string;
  changedFiles: string[];
  envFiles: string[];
}

export function syncStatus(root: string): SyncStatus {
  const { config, source, problems } = loadSyncConfig(root);
  const remoteUrl = resolveRemoteUrl(root, config.remote);
  let changedFiles: string[] = [];
  try {
    changedFiles = changedGitFiles(root);
  } catch {
    /* 非 git 仓库或 git 不可用时保持空列表 */
  }
  return {
    enabled: config.enabled,
    source,
    problems,
    remote: config.remote,
    remoteUrl,
    branch: config.branch,
    changedFiles,
    envFiles: changedFiles.filter((rel) => isEnvLike(rel)),
  };
}

function isEnvLike(rel: string): boolean {
  const base = rel.split("/").pop() ?? "";
  return /^\.env(\.[^./]+)?$/.test(base) && !/example|sample|template/i.test(base);
}

export type SyncPushBlock = "disabled" | "no-remote" | "no-confirmation" | "declined" | "secret-scan" | "env-file" | "push-failed";

export interface SyncPushResult {
  ok: boolean;
  blocked?: SyncPushBlock;
  message: string;
  files?: string[];
  remoteUrl?: string | null;
  branch?: string;
}

export interface SyncPushOptions {
  /** 唯一推送通道：人工确认回调。缺省即拒绝——push 永远需要人工确认（ADR-013）。 */
  confirm?: (prompt: SyncPushPrompt) => boolean | Promise<boolean>;
}

export function runSyncPush(root: string, options: SyncPushOptions = {}): Promise<SyncPushResult> {
  return (async (): Promise<SyncPushResult> => {
    const { config, problems } = loadSyncConfig(root);
    if (!config.enabled) {
      return { ok: false, blocked: "disabled", message: "同步未开启：在 .pm/sync.json 设置 enabled: true（默认关闭，防止盲目推送）。" };
    }
    const remoteUrl = resolveRemoteUrl(root, config.remote);
    if (!remoteUrl) {
      return { ok: false, blocked: "no-remote", message: `找不到 git remote "${config.remote}"，请先 git remote add。` };
    }
    let working: string[];
    try {
      working = changedGitFiles(root);
    } catch (error) {
      return { ok: false, blocked: "push-failed", message: `无法获取变更列表: ${error instanceof Error ? error.message : String(error)}` };
    }
    // 门禁覆盖实际出门的全部内容：未提交的工作区变更 + 未推送提交的差异文件
    const committed = unpushedFiles(root, config.remote, config.branch).filter(
      (rel) => !rel.startsWith(".pm/") && rel !== "PROJECT.md" && rel !== ".gitignore",
    );
    const files = [...new Set([...working, ...committed])];
    if (files.length === 0) {
      return { ok: true, message: "没有待推送的变更或提交，无需推送。", files, remoteUrl, branch: config.branch };
    }
    const warnings: string[] = problems;
    if (files.length > 100) warnings.push(`变更文件超过 100 个（${files.length} 个），请确认没有夹带生成产物`);

    // 门禁一：密钥扫描（高危阻断，不可被确认覆盖）
    const detections = scanSecretsInFiles(root, files);
    const high = detections.filter((d) => d.severity === "high");
    if (high.length > 0) {
      const lines = high.slice(0, 20).map((d) => `- [HIGH] ${d.file}:${d.line} ${d.rule} — ${d.message}`);
      return {
        ok: false,
        blocked: "secret-scan",
        message: `🚨 推送被阻断：检出 ${high.length} 个高危密钥发现（批准也不能放行）。请先移除凭据或加入 .gitignore：\n${lines.join("\n")}`,
        files,
        remoteUrl,
        branch: config.branch,
      };
    }
    // 门禁二：.env 类文件按文件名阻断（内容扫描兜不住的空 .env / 二进制）
    const envFiles = files.filter((rel) => isEnvLike(rel));
    if (envFiles.length > 0) {
      return {
        ok: false,
        blocked: "env-file",
        message: `🚨 推送被阻断：变更中包含 .env 类文件（${envFiles.join(", ")}）。请确认已在 .gitignore 并改用示例文件。`,
        files,
        remoteUrl,
        branch: config.branch,
      };
    }
    // 门禁三：人工确认——唯一推送通道，缺省即拒绝
    if (!options.confirm) {
      return { ok: false, blocked: "no-confirmation", message: "非交互环境拒绝推送：请在前台终端运行 pm-mcp sync push，确认后才会推送。" };
    }
    const prompt: SyncPushPrompt = { remoteUrl, remote: config.remote, branch: config.branch, files, warnings };
    if (!(await options.confirm(prompt))) {
      return { ok: false, blocked: "declined", message: "已取消推送（用户拒绝）。", files, remoteUrl, branch: config.branch };
    }

    const git = resolveGitCommand();
    if (!git) return { ok: false, blocked: "push-failed", message: "找不到 git 可执行文件，无法推送。" };
    const commits = unpushedCommitCount(root, config.remote, config.branch);
    const pushedText = commits === null ? "全部提交（首次推送）" : `${commits} 个提交`;
    const result = spawnSync(git, ["push", config.remote, `HEAD:refs/heads/${config.branch}`], {
      cwd: root,
      encoding: "utf8",
      timeout: 120000,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    });
    if (result.error || result.status !== 0) {
      const stderr = (result.stderr ?? result.error?.message ?? "").trim();
      const cause = /authentication|permission denied \(publickey\)|403/i.test(stderr)
        ? "认证失败（检查 git credential helper 或 SSH key）"
        : /could not resolve|connection timed out|connection refused/i.test(stderr)
          ? "网络不可达（检查远端地址与网络）"
          : /rejected/i.test(stderr)
            ? "被远端拒绝（远端可能有新提交，先 git pull --rebase）"
            : "推送失败";
      return { ok: false, blocked: "push-failed", message: `${cause}\n${stderr.slice(0, 2000)}`, files, remoteUrl, branch: config.branch };
    }
    return { ok: true, message: `✅ 已推送 ${pushedText}到 ${config.remote} (${remoteUrl}) 分支 ${config.branch}；安全门通过文件 ${files.length} 个${working.length > 0 ? `（其中 ${working.length} 个为未提交的工作区变更，未包含在本次推送）` : ""}。`, files, remoteUrl, branch: config.branch };
  })();
}

export function printSyncHelp(): void {
  console.log("pm-mcp sync [status|push]");
  console.log("  status  查看同步配置、远端与待推送变更（只读，不联网）");
  console.log("  push    推送变更：变更列表 → 密钥扫描（高危阻断）→ 人工确认 y/N → git push");
  console.log("");
  console.log("配置 .pm/sync.json（默认关闭）:");
  console.log('  { "enabled": true, "remote": "origin", "branch": "main" }');
}

/** CLI 交互确认：非 TTY 返回 false（结构上保证非交互必拒）。 */
export function cliConfirm(): (prompt: SyncPushPrompt) => Promise<boolean> {
  return async (prompt) => {
    if (!process.stdin.isTTY) return false;
    console.log(`将推送 ${prompt.files.length} 个文件到 ${prompt.remote} (${prompt.remoteUrl}) 分支 ${prompt.branch}`);
    for (const warning of prompt.warnings) console.log(`⚠️ ${warning}`);
    for (const file of prompt.files.slice(0, 50)) console.log(`  ${file}`);
    if (prompt.files.length > 50) console.log(`  …共 ${prompt.files.length} 个文件`);
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = (await rl.question("确认推送? (y/N): ")).trim().toLowerCase();
      return answer === "y" || answer === "yes";
    } finally {
      rl.close();
    }
  };
}

export async function runSyncCli(args: string[], root: string): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    printSyncHelp();
    return 0;
  }
  const command = args.find((a) => !a.startsWith("--")) ?? "status";
  if (command === "status") {
    const status = syncStatus(root);
    console.log(`同步: ${status.enabled ? "已开启" : "已关闭（默认）"}（来源: ${status.source === "file" ? ".pm/sync.json" : "默认配置"}）`);
    for (const problem of status.problems) console.log(`⚠️ ${problem}`);
    console.log(`远端: ${status.remote}${status.remoteUrl ? ` (${status.remoteUrl})` : "（未配置）"}  分支: ${status.branch}`);
    console.log(`待推送变更: ${status.changedFiles.length} 个文件`);
    for (const file of status.changedFiles.slice(0, 20)) console.log(`  ${file}`);
    if (status.changedFiles.length > 20) console.log(`  …共 ${status.changedFiles.length} 个文件`);
    if (status.envFiles.length > 0) console.log(`⚠️ 含 .env 类文件（push 会被阻断）: ${status.envFiles.join(", ")}`);
    return 0;
  }
  if (command === "push") {
    const result = await runSyncPush(root, { confirm: cliConfirm() });
    console.log(result.message);
    return result.ok ? 0 : 1;
  }
  console.error(`未知子命令: ${command}`);
  printSyncHelp();
  return 1;
}
