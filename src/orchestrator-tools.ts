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
  completeGoal,
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
  const label = status === "ready" || status === "running" ? "可运行" : status === "disabled" ? "已关闭" : status === "completed" ? "已完成" : status;
  const lines = [`编排: ${label}（${reason}）`];
  if (file.goal) lines.push(`目标: ${file.goal.objective}｜验收: ${file.goal.acceptance}`);
  else lines.push("目标: 未设置（先 set_goal，否则不会自动开轮）");
  lines.push(`开关 ${file.settings.enabled ? "开" : "关"} · 并发 ${file.settings.max_concurrency} · 预算 ${budgetLabel(file)}`);
  lines.push(`当前轮: ${file.run.active_run_id}${file.run.active_run_kind ? `（${file.run.active_run_kind}）` : ""}`);
  if (file.settings.enabled && file.settings.max_rounds === null && file.settings.max_hours === null && file.settings.max_total_tokens === null) {
    lines.push("⚠️ 编排已开启但三项预算均为不限：没有成本防线，建议至少设置一项。");
  }
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

  toolI<{ enabled?: boolean; reason?: string; max_concurrency?: number; max_rounds?: number | null; max_hours?: number | null; max_total_tokens?: number | null }>(
    server, startupRoot,
    "set_orchestrator",
    "手动开关自动编排并调整并发与预算。enabled 变更必须给 reason（留痕）。并发与预算可随时单独调整，下一轮生效。",
    {
      enabled: z.boolean().optional().describe("true 开启自动编排，false 暂停"),
      reason: z.string().trim().min(1).optional().describe("开关理由，changed enabled 时必填，写入台账日志"),
      max_concurrency: z.number().int().min(1).max(MAX_CONCURRENCY).optional().describe(`同时执行的任务数上限，${MIN_CONCURRENCY}-${MAX_CONCURRENCY}`),
      max_rounds: z.number().int().min(1).nullable().optional().describe("本轮项目最多跑多少轮（1-500）；传 null = 不限"),
      max_hours: z.number().min(0.1).nullable().optional().describe("本轮项目最长多少小时（0.1-168）；传 null = 不限"),
      max_total_tokens: z.number().int().min(1).nullable().optional().describe("累计 token 上限；传 null = 不限。达到即 budget-exhausted"),
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

  toolI<{ note?: string }>(
    server, startupRoot,
    "complete_goal",
    "在按 acceptance 完成核验后，显式标记目标已完成。完成后编排进入终止态，调度不得再开新轮；设定新目标会清除完成标记。",
    { note: z.string().optional().describe("完成说明：按什么证据判定验收通过（写入台账日志）") },
    (args, ctx) => {
      const root = ctx.root;
      requireInitialized(root);
      const file = completeGoal(root, args.note ?? "");
      const { status, reason } = orchestratorStatus(file);
      refreshDerived(root);
      return [
        "✅ 目标已标记完成，自动编排进入终止态（不会再有新轮）。",
        reason,
        `状态: ${status}`,
      ].join("\n");
    },
  );

  toolI<{ action: "begin" | "end"; run_id: string; run_kind?: "workflow" | "cli" | "manual"; produced_evidence?: boolean; failure?: string; tokens_used?: number; tokens_unknown?: boolean }>(
    server, startupRoot,
    "record_round",
    "记录一轮自动执行的开始与结束，驱动停滞检测、连续失败退出与轮数预算。由外部定时任务/workflow 调用。每轮必须先 begin 再 end，且同一 run_id 只能结算一次。begin 会记录源码/质量报告基线；end 声称有证据时会核验源码是否真变、质量报告是否为结构有效的新文件——空转冒充产出会被降级为无证据。",
    {
      action: z.enum(["begin", "end"]).describe("begin 开轮，end 收尾"),
      run_id: z.string().trim().min(1).describe("本轮标识：workflow 运行 id / cli 会话 id 或时间戳（自愈时据此回查真实状态）"),
      run_kind: z.enum(["workflow", "cli", "manual"]).optional().describe("begin 时填：本轮由哪种执行器承载，缺省 manual"),
      produced_evidence: z.boolean().optional().describe("end 时填：本轮是否产出新的可核验证据（测试报告/源码变更）。连续无证据会判定停滞并自动停止。"),
      failure: z.string().optional().describe("end 时填：本轮失败的简短原因（如额度耗尽）。连续失败达到阈值会退出循环。"),
      tokens_used: z.number().int().min(0).optional().describe("end 时必填其一：本轮实际消耗 token，累计进台账用于 max_total_tokens 判定"),
      tokens_unknown: z.boolean().optional().describe("end 时必填其一：确实无法测量 token 时显式传 true。与 tokens_used 二选一，省略两者会被拒绝"),
    },
    (args, ctx) => {
      const root = ctx.root;
      requireInitialized(root);
      const file = args.action === "begin"
        ? beginRound(root, { runId: args.run_id, kind: args.run_kind })
        : endRound(root, { runId: args.run_id, producedEvidence: args.produced_evidence ?? true, failure: args.failure?.trim() || undefined, tokensUsed: args.tokens_used, tokensUnknown: args.tokens_unknown });
      const { status, reason } = orchestratorStatus(file);
      refreshDerived(root);
      const parts = [
        args.action === "begin" ? `▶️ 本轮已登记: ${args.run_id}（${file.run.round_count >= 0 ? "基线已记录" : ""}）` : `✅ 本轮已记账: ${args.run_id}`,
        `轮次 ${budgetLabel(file)} · 停滞 ${file.run.stall_rounds}/${STALL_THRESHOLD} · 连续失败 ${file.run.consecutive_failures}/${FAIL_EXIT_THRESHOLD}`,
        `状态: ${status}（${reason}）`,
      ];
      // 最近一条日志能显示是否发生了「声称有证据但被降级」——把核验结果如实回给调用方
      const last = file.log[file.log.length - 1];
      if (args.action === "end" && last) parts.push(`记账明细: ${last.note}`);
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
        `当前轮: ${file.run.active_run_id ?? "无"}${file.run.active_run_id && file.run.active_run_kind ? `（${file.run.active_run_kind}）` : ""}`,
        `停滞: ${file.run.stall_rounds}/${STALL_THRESHOLD} · 连续失败: ${file.run.consecutive_failures}/${FAIL_EXIT_THRESHOLD}`,
        `台账: ${health}${issue ? `（${issue}）` : ""}`,
      ];
      // 协议与合规状态必须印在这里：心跳每次 tick 第一步就读它，
      // 这样即使外部 prompt 还是旧文本，也会看到该补什么、以及上一轮偏没偏离。
      L.push("", "## 本轮协议（record_round 硬约束）");
      L.push("- begin：带 run_id 与 run_kind（workflow|cli|manual），会记录源码指纹与质量报告基线");
      L.push("- end：必须上报成本——tokens_used（实际消耗）或 tokens_unknown:true（无法测量），两者都省会被拒绝");
      L.push("- end：produced_evidence:true 会核验源码/质量报告是否真变化，没变则降级为无证据并计入停滞；真无产出请传 false");
      const p = file.run.protocol;
      if (p.tokens_unknown_rounds > 0 || p.evidence_downgrades > 0) {
        L.push(`- ⚠️ 合规偏离累计：未上报成本 ${p.tokens_unknown_rounds} 轮 · 证据被降级 ${p.evidence_downgrades} 轮`);
      } else {
        L.push("- ✅ 至今无协议偏离");
      }

      const recent = file.log.slice(-10).reverse();
      if (recent.length > 0) {
        L.push("", "## 最近记录");
        for (const e of recent) L.push(`- ${e.at.slice(0, 16)} [${e.kind}] ${e.note}`);
      }
      return foldLines(L, { maxLines: budgetLines(root) });
    },
  );
}
