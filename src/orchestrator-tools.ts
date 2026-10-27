import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { foldLines } from "./budget.ts";
import { refreshDerived } from "./dashboard.ts";
import { requireInitialized } from "./paths.ts";
import { budgetLines, toolI, toolR } from "./tool-base.ts";
import {
  FAIL_EXIT_THRESHOLD,
  MAX_CONCURRENCY,
  MIN_CONCURRENCY,
  STALL_THRESHOLD,
  beginRound,
  budgetLabel,
  endRound,
  loadOrchestrator,
  orchestratorStatus,
  readOrchestrator,
  setGoal,
  setSettings,
  shouldExitLoop,
} from "./orchestrator.ts";

/** get_status 与仪表盘共用的编排状态摘要 */
export function orchestratorStatusLines(root: string): string[] {
  const { value: file, health, issue } = readOrchestrator(root);
  const { status, reason } = orchestratorStatus(file);
  const lines = [`编排: ${status === "ready" || status === "running" ? "可运行" : status === "disabled" ? "已关闭" : status}（${reason}）`];
  if (file.goal) lines.push(`目标: ${file.goal.objective}｜验收: ${file.goal.acceptance}`);
  else lines.push("目标: 未设置（先 set_goal，否则不会自动开轮）");
  lines.push(`开关 ${file.settings.enabled ? "开" : "关"} · 并发 ${file.settings.max_concurrency} · 预算 ${budgetLabel(file)}`);
  if (file.run.active_run_id) lines.push(`当前轮: ${file.run.active_run_id}`);
  if (file.run.stall_rounds > 0 || file.run.consecutive_failures > 0) {
    lines.push(`停滞 ${file.run.stall_rounds}/${STALL_THRESHOLD} · 连续失败 ${file.run.consecutive_failures}/${FAIL_EXIT_THRESHOLD}`);
  }
  if (health === "invalid") lines.push(`⚠️ 编排台账已损坏（视为禁用，写入已阻止）: ${issue}`);
  else if (health === "missing") lines.push("编排台账: 未初始化（视为禁用）");
  return lines;
}

export function registerOrchestratorTools(server: McpServer, startupRoot: string): void {
  toolI<{ objective: string; acceptance: string; note?: string }>(
    server, startupRoot,
    "set_goal",
    "设定项目的最终目标与机器可判定的验收标准——这是「自动迭代直到完成」的终点判据。不会覆盖 update_project 的 goals 列表。",
    {
      objective: z.string().trim().min(1).describe("最终目标：一句话说明项目要达成什么"),
      acceptance: z.string().trim().min(1).describe("机器可判定的验收标准，具体到能执行或能核验，如「npm run quality 全绿 + 验收基线 xxx@1.1.0 通过」。为空会被拒绝：没有判据就没有终点。"),
      note: z.string().optional().describe("补充说明（范围、不做的事）"),
    },
    (args, ctx) => {
      const root = ctx.root;
      requireInitialized(root);
      const file = setGoal(root, args);
      refreshDerived(root);
      return [
        `✅ 最终目标已记录: ${file.goal?.objective}`,
        `验收标准: ${file.goal?.acceptance}`,
        file.goal?.note ? `说明: ${file.goal.note}` : "",
        "下一步: set_orchestrator(enabled:true, reason:...) 开启自动编排；开关后由外部定时任务/workflow 按 orchestrator 状态开轮。",
      ].filter(Boolean).join("\n");
    },
  );

  toolI<{ enabled?: boolean; reason?: string; max_concurrency?: number; max_rounds?: number | null; max_hours?: number | null }>(
    server, startupRoot,
    "set_orchestrator",
    "手动开关自动编排并调整并发与预算。enabled 变更必须给 reason（留痕）。并发与预算可随时单独调整，下一轮生效。",
    {
      enabled: z.boolean().optional().describe("true 开启自动编排，false 暂停"),
      reason: z.string().trim().min(1).optional().describe("开关理由，changed enabled 时必填，写入台账日志"),
      max_concurrency: z.number().int().min(1).max(MAX_CONCURRENCY).optional().describe(`同时执行的任务数上限，${MIN_CONCURRENCY}-${MAX_CONCURRENCY}`),
      max_rounds: z.number().int().min(1).nullable().optional().describe("本轮项目最多跑多少轮（1-500）；传 null = 不限"),
      max_hours: z.number().min(0.1).nullable().optional().describe("本轮项目最长多少小时（0.1-168）；传 null = 不限"),
    },
    (args, ctx) => {
      const root = ctx.root;
      requireInitialized(root);
      const file = setSettings(root, args);
      const { status, reason } = orchestratorStatus(file);
      refreshDerived(root);
      return [
        `✅ 编排已更新: ${file.settings.enabled ? "开启" : "关闭"} · 并发 ${file.settings.max_concurrency} · 预算 ${budgetLabel(file)}`,
        `状态: ${status}（${reason}）`,
        status === "ready" ? "下一轮可以开跑：先 record_round(action:begin)，跑完 record_round(action:end) 记账。" : "现在不会自动开新轮。",
        shouldExitLoop(file) ? "⚠️ 已连续停滞或连续失败达到阈值，需人工检查后再开启。" : "",
      ].filter(Boolean).join("\n");
    },
  );

  toolI<{ action: "begin" | "end"; run_id: string; produced_evidence?: boolean; failure?: string }>(
    server, startupRoot,
    "record_round",
    "记录一轮自动执行的开始与结束，驱动停滞检测、连续失败退出与轮数预算。由外部定时任务/workflow 调用。",
    {
      action: z.enum(["begin", "end"]).describe("begin 开轮，end 收尾"),
      run_id: z.string().trim().min(1).describe("本轮的标识，如 workflow 运行 id 或时间戳"),
      produced_evidence: z.boolean().optional().describe("end 时填：本轮是否产出新的可核验证据（测试报告/源码变更）。连续无证据会判定停滞并自动停止。"),
      failure: z.string().optional().describe("end 时填：本轮失败的简短原因（如额度耗尽）。连续失败达到阈值会退出循环。"),
    },
    (args, ctx) => {
      const root = ctx.root;
      requireInitialized(root);
      const file = args.action === "begin"
        ? beginRound(root, args.run_id)
        : endRound(root, { runId: args.run_id, producedEvidence: args.produced_evidence ?? true, failure: args.failure?.trim() || undefined });
      const { status, reason } = orchestratorStatus(file);
      refreshDerived(root);
      const parts = [
        args.action === "begin" ? `▶️ 本轮已登记: ${args.run_id}` : `✅ 本轮已记账: ${args.run_id}`,
        `轮次 ${budgetLabel(file)} · 停滞 ${file.run.stall_rounds}/${STALL_THRESHOLD} · 连续失败 ${file.run.consecutive_failures}/${FAIL_EXIT_THRESHOLD}`,
        `状态: ${status}（${reason}）`,
      ];
      if (shouldExitLoop(file)) parts.push("⛔ 已达停滞或连续失败阈值，循环应停止，不要继续开新轮。");
      return parts.join("\n");
    },
  );

  toolR<Record<string, never>>(
    server, startupRoot,
    "get_orchestrator",
    "查看自动编排状态：最终目标、开关、并发、预算余量、当前轮次、停滞与失败计数、最近台账日志。定时任务开轮前第一件事。",
    {},
    (_args, ctx) => {
      const root = ctx.root;
      requireInitialized(root);
      const { value: file, health, issue } = readOrchestrator(root);
      const { status, reason } = orchestratorStatus(file);
      const L: string[] = [
        `# 编排状态: ${status}`,
        reason,
        "",
        `目标: ${file.goal?.objective ?? "（未设置）"}`,
        `验收: ${file.goal?.acceptance ?? "（未设置）"}`,
        ...(file.goal?.note ? [`说明: ${file.goal.note}`] : []),
        "",
        `开关: ${file.settings.enabled ? "开启" : "关闭"} · 并发: ${file.settings.max_concurrency}`,
        `预算: ${budgetLabel(file)}`,
        `当前轮: ${file.run.active_run_id ?? "无"}`,
        `停滞: ${file.run.stall_rounds}/${STALL_THRESHOLD} · 连续失败: ${file.run.consecutive_failures}/${FAIL_EXIT_THRESHOLD}`,
        `台账: ${health}${issue ? `（${issue}）` : ""}`,
      ];
      const recent = file.log.slice(-10).reverse();
      if (recent.length > 0) {
        L.push("", "## 最近记录");
        for (const e of recent) L.push(`- ${e.at.slice(0, 16)} [${e.kind}] ${e.note}`);
      }
      return foldLines(L, { maxLines: budgetLines(root) });
    },
  );
}
