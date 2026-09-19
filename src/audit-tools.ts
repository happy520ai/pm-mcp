import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { auditStructure, snapshotCodebase } from "./audit.ts";
import { foldLines } from "./budget.ts";
import { refreshDerived } from "./dashboard.ts";
import { auditLicense } from "./license.ts";
import { isInitialized, requireInitialized } from "./paths.ts";
import { listRegistry } from "./registry.ts";
import { auditSecurity, listFindings, prepareSecurityAudit, resolveFinding, type PreparedSecurityAudit } from "./security.ts";
import { budgetLines, toolR, toolW } from "./tool-base.ts";
import { walkRefresh } from "./index-store.ts";
import { renderDuplicates } from "./duplicates.ts";
import { renderOsv, auditOsv } from "./osv.ts";

export function registerAuditTools(server: McpServer, root: string): void {
  toolW(server, root, "snapshot_codebase", "给代码结构拍快照（文件数/行数/目录分布/测试数/skip 标记/依赖清单）。之后 audit_structure 会与上次快照 diff。建议每个会话或每个里程碑结束时拍一次。", {}, () => {
    requireInitialized(root);
    const { snapshot, summary } = snapshotCodebase(root);
    refreshDerived(root);
    return [...summary, `下次 audit_structure 将以此为基线（${snapshot.file}）。`].join("\n");
  }, () => { requireInitialized(root); walkRefresh(root, { forceContent: true }); });

  toolR(server, root, "audit_structure", "八项结构对账（定期做）：①增长与新增依赖 ②漂移对账（功能↔文件，防幻觉）③债务与重构配额 ④churn 热点 ⑤复杂度预算 ⑥索引覆盖率 ⑦足迹/产出 ⑧测试健康（禁用/蒸发/空测试/背书占比）。", {}, () => {
    requireInitialized(root);
    return auditStructure(root, budgetLines(root), true);
  });

  toolR<{ min_lines?: number; limit?: number }>(server, root, "find_duplicates", "重复代码检测：注释剥离/字符串占位/空白归一化的行指纹滑动窗口聚类，跨文件重复块按长度降序列出。", {
    min_lines: z.number().int().min(4).max(20).optional().describe("最小重复行数（有效代码行），默认 6"),
    limit: z.number().int().min(1).max(100).optional().describe("最多列出的重复组数，默认 20"),
  }, (args) => {
    requireInitialized(root);
    return renderDuplicates(root, args ?? {}, budgetLines(root));
  });

  toolR<{ confirm: true; timeout_ms?: number }>(server, root, "audit_osv", "OSV.dev 已知漏洞查询（联网！默认关）：把 manifest 声明的依赖（仅包名/版本/生态）批量发给 api.osv.dev 比对；必须显式 confirm=true 才发起网络请求。", {
    confirm: z.literal(true).describe("显式确认联网：本工具会把依赖名与版本发送到 api.osv.dev"),
    timeout_ms: z.number().int().min(5000).max(120000).optional().describe("每批请求超时毫秒数，默认 30000"),
  }, async (args) => {
    requireInitialized(root);
    const scan = await auditOsv(root, { timeoutMs: args.timeout_ms });
    return renderOsv(scan, budgetLines(root));
  });

  toolW<Record<string, never>, PreparedSecurityAudit>(server, root, "audit_security", "安全体检（只扫描本地、不联网，结果写入安全台账）：密钥泄露 / 危险模式（eval、SQL 拼接、禁用证书校验等）/ 依赖风险。修复后重扫自动关闭；接受风险必须留理由。", {}, (_args, prepared) => {
    requireInitialized(root);
    const report = auditSecurity(root, prepared);
    refreshDerived(root);
    return report.text.join("\n");
  }, () => { requireInitialized(root); return prepareSecurityAudit(root); });

  toolR<{ status?: "open" | "fixed" | "accepted" }>(
    server, root,
    "list_findings",
    "查看安全台账（可按状态过滤）。",
    { status: z.enum(["open", "fixed", "accepted"]).optional() },
    (args) => {
      requireInitialized(root);
      const list = listFindings(root, args.status);
      if (list.length === 0) return `（无${args.status ?? ""}安全发现。）`;
      const L = list.map((f) => `[${f.status}/${f.severity}] ${f.id} ${f.file}:${f.line} ${f.rule} — ${f.note.slice(0, 60)}`);
      return foldLines([`共 ${list.length} 条:`, ...L], { maxLines: budgetLines(root) });
    },
  );

  toolW<{ id: string; status: "fixed" | "accepted"; note?: string }>(
    server, root,
    "resolve_finding",
    "处置安全发现：修复后标 fixed；带理由接受风险标 accepted（必须填 note——接受是显式选择，要留痕）。",
    {
      id: z.string().describe("如 SEC-001"),
      status: z.enum(["fixed", "accepted"]),
      note: z.string().optional().describe("accepted 时必填：接受理由"),
    },
    (args) => {
      requireInitialized(root);
      const f = resolveFinding(root, args.id, args.status, args.note ?? "");
      refreshDerived(root);
      return `✅ ${f.id} 已置为 ${f.status}${f.note ? `（${f.note}）` : ""}。`;
    },
  );

  toolR(server, root, "audit_license", "许可证审计（法律账）：依赖许可证清单与 copyleft 冲突、源码中的 GPL 家族许可证头、LICENSE 文件检查、来源登记清单。离线启发式，不替代法务。", {}, () => {
    requireInitialized(root);
    return auditLicense(root, budgetLines(root), true);
  });
}

export function registerRegistryTools(server: McpServer, root: string): void {
  toolR(server, root, "list_projects", "列出本机所有被 pm-mcp 管理的项目（全局注册表）。", {}, () => {
    const list = listRegistry();
    if (list.length === 0) return "（注册表为空。在任何项目里 init_project 后会自动登记。）";
    const L = list.map((p) => {
      const alive = isInitialized(p.root) ? "" : "（⚠️ .pm 不存在，可能已移动）";
      return `- ${p.name} → ${p.root}${alive}`;
    });
    return foldLines([`共 ${list.length} 个项目:`, ...L], { maxLines: 60 });
  });
}
