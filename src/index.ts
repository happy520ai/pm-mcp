#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { resolveRoot, isInitialized } from "./paths.ts";
import { registerAllTools } from "./tools.ts";
import { loadFeatures, loadRoadmap, loadSessions, loadTasks } from "./store.ts";
import { renderRoadmap } from "./roadmap.ts";
import { buildChangelog } from "./dashboard.ts";
import { dashboardFile, pmPath } from "./paths.ts";
import { startWatcher } from "./index-store.ts";
import { auditGovernance } from "./governance-audit.ts";
import { buildPortfolioReport, loadPortfolioProject } from "./portfolio.ts";
import fs from "node:fs";
import path from "node:path";
import { listAcceptanceBaselines } from "./acceptance-tools.ts";
import { AcceptanceReportSchema } from "./acceptance-report.ts";

/* --root 参数 > PM_ROOT 环境变量 > 启动时工作目录 */
const argv = process.argv.slice(2);
let explicitRoot: string | undefined;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--root" && argv[i + 1]) explicitRoot = argv[i + 1];
}
const root = resolveRoot(explicitRoot);

const server = new McpServer(
  { name: "pm-mcp", version: "0.1.3" },
  {
    instructions: [
      "多 Agent 规则：相同业务的所有写工具调用必须携带相同 idempotency_key（建议 task-id:operation）；同键同参数只执行一次，同键不同参数会被拒绝。",
      "完全相同的并行读请求会由服务端合并并复用结果；不要让多个分支重复请求同一工具和参数。",
      "看到“幂等复用”时直接采用首次结果；看到“幂等占位/正在执行”时等待负责该业务的 Agent，不要换键重试。",
    ].join(" "),
  },
);
registerAllTools(server, root);

/* -------------------------------- Resources ------------------------------- */

function safeText(fn: () => string): string {
  try {
    return fn();
  } catch (e) {
    return `（不可用: ${(e as Error).message}）`;
  }
}

server.registerResource(
  "dashboard",
  "pm://dashboard",
  { description: "项目仪表盘（与仓库根 PROJECT.md 同源），路线图/健康摘要/任务/功能清单" },
  (uri) => ({
    contents: [
      {
        uri: uri.href,
        mimeType: "text/markdown",
        text: safeText(() => fs.readFileSync(dashboardFile(root), "utf8")),
      },
    ],
  }),
);

server.registerResource(
  "roadmap",
  "pm://roadmap",
  { description: "路线图（里程碑进度 + 活跃里程碑任务明细）" },
  (uri) => ({
    contents: [
      {
        uri: uri.href,
        mimeType: "text/markdown",
        text: safeText(() => renderRoadmap(loadRoadmap(root).milestones, loadTasks(root).tasks, 2).join("\n")),
      },
    ],
  }),
);

server.registerResource(
  "tasks",
  "pm://tasks",
  { description: "任务清单原始数据（tasks.json；超 100 条截断，完整数据用 list_tasks 过滤）" },
  (uri) => ({
    contents: [
      {
        uri: uri.href,
        mimeType: "application/json",
        text: safeText(() => {
          const tasks = loadTasks(root).tasks;
          // 资源也要守 token 预算：全量 dump 大账本会吃爆上下文（截断后仍是合法 JSON）
          if (tasks.length <= 100) return JSON.stringify(tasks, null, 2);
          const shown = tasks.slice(0, 100) as Array<Record<string, unknown>>;
          shown.push({
            id: `_TRUNCATED_${tasks.length - 100}`,
            title: `…另有 ${tasks.length - 100} 个任务已截断，用 list_tasks 按状态/里程碑过滤获取`,
          });
          return JSON.stringify(shown, null, 2);
        }),
      },
    ],
  }),
);

server.registerResource(
  "changelog",
  "pm://changelog",
  { description: "变更日志（由 sessions.json 生成的人类可读版本）" },
  (uri) => ({
    contents: [
      {
        uri: uri.href,
        mimeType: "text/markdown",
        text: safeText(() => buildChangelog(root)),
      },
    ],
  }),
);

server.registerResource(
  "architecture",
  "pm://architecture",
  { description: "跨文件/模块/语言治理审计：语义覆盖、依赖边界、接口、循环与质量矩阵" },
  (uri) => ({
    contents: [{ uri: uri.href, mimeType: "text/markdown", text: safeText(() => auditGovernance(root, 150).report) }],
  }),
);

server.registerResource(
  "portfolio",
  "pm://portfolio",
  { description: "当前项目的组合视图与跨仓依赖/版本风险" },
  (uri) => ({
    contents: [{
      uri: uri.href,
      mimeType: "application/json",
      text: safeText(() => JSON.stringify(buildPortfolioReport({ projects: [loadPortfolioProject(root)], projectsRequested: 1 }), null, 2)),
    }],
  }),
);

server.registerResource(
  "acceptance",
  "pm://acceptance",
  { description: "标准化产品验收概览：版本化预批准基线与最近一次机器判定报告" },
  (uri) => ({
    contents: [{
      uri: uri.href,
      mimeType: "application/json",
      text: safeText(() => {
        const reportDir = pmPath(root, "acceptance", "reports");
        let latestReport: unknown = null;
        if (fs.existsSync(reportDir)) {
          const candidates = fs.readdirSync(reportDir, { withFileTypes: true })
            .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
            .map((entry) => ({ name: entry.name, mtime: fs.statSync(path.join(reportDir, entry.name)).mtimeMs }))
            .sort((a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name));
          if (candidates[0]) latestReport = AcceptanceReportSchema.parse(JSON.parse(fs.readFileSync(path.join(reportDir, candidates[0].name), "utf8")));
        }
        return JSON.stringify({ baselines: listAcceptanceBaselines(root), latest_report: latestReport }, null, 2);
      }),
    }],
  }),
);

/* --------------------------------- Prompts -------------------------------- */

server.registerPrompt(
  "start-session",
  { description: "开工仪式：恢复项目上下文，从断点续做，不靠回忆。" },
  () => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: [
            "按以下顺序恢复项目上下文（本项目由 pm-mcp 管理，状态以 .pm/ 为准，不要凭记忆陈述）：",
            "1. 调用 get_status：了解阶段、里程碑进度、进行中任务及其 checkpoint 下一步。",
            "2. 若要动的模块不清楚，先 search_code 定位到具体文件与行，再读文件——三段式定位，不要全量读代码。",
            "3. 陈述本次计划：要做哪个任务、动哪些文件、验收标准是什么。",
            "4. 过程纪律：走捷径就 add_task(type=debt) 登记债务；修 bug 完成后 log_debug 记根因；长任务随手 checkpoint。",
          ].join("\n"),
        },
      },
    ],
  }),
);

server.registerPrompt(
  "end-session",
  { description: "收工仪式：更新任务与里程碑、留断点、记会话——把本次上下文写回仓库。" },
  () => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: [
            "收工前依次完成（顺序执行，缺一不可）：",
            "1. 完成的任务：update_task 置 done，必须写 result_note（做了什么），feature/fix 类补 verification（用什么测试/命令证明）。",
            "2. 未完成的任务：checkpoint 保存「进展 + 下一步具体动作」。",
            "3. 本次落地的功能：register_feature 登记（入口文件 + 测试文件）。",
            "4. 修过的 bug：log_debug 记录症状/根因/修法/验证。",
            "5. 走过的捷径：add_task(type=debt) 登记债务，别让它在沉默中腐烂。",
            "6. log_session 记录会话摘要与改动文件清单（如实列出，波及面统计靠它）。",
            "7. 若到达里程碑节点：update_milestone 流转状态；可 snapshot_codebase 拍快照 + audit_structure 对账。",
          ].join("\n"),
        },
      },
    ],
  }),
);

server.registerPrompt(
  "onboard",
  { description: "入职简报工作流：引导客户端为新成员（人或 AI）生成项目现状一页纸。" },
  () => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: [
            "为新加入的成员（人或 AI）生成入职简报，数据全部来自 .pm/ 状态，不要编造：",
            "1. 读 pm://dashboard（或 PROJECT.md）：项目是什么、路线图到哪、健康状态如何。",
            "2. list_decisions + 阅读最近 3 条 ADR：理解关键取舍的「为什么」。",
            "3. list_features：了解已有功能地图与各功能入口文件。",
            "4. get_status：当前焦点与断点。",
            "5. 读 pm://architecture 与 pm://portfolio：模块 owner、公开接口、跨语言质量矩阵和跨仓版本风险。",
            "输出一页纸简报：项目一句话 / 技术栈与模块 / 路线图现状 / 关键决策与红线 / 模块与接口边界 / 当前焦点与下一步 / 哪里有坑（债务、安全、语义与跨仓风险）。",
          ].join("\n"),
        },
      },
    ],
  }),
);

server.registerPrompt(
  "architecture-review",
  { description: "跨文件/模块/语言架构评审：先取证，再判断影响和门禁。" },
  () => ({
    messages: [{
      role: "user",
      content: {
        type: "text",
        text: [
          "按证据完成跨模块/跨语言架构评审：",
          "1. 读取 pm://architecture 或调用 audit_governance，先检查语义覆盖、unresolved、owner、私有接口、循环和边界违规。",
          "2. 对本次变更调用 impact_analysis，列出反向依赖文件与模块；未知文件不得忽略。",
          "3. 调用 plan_quality_matrix；这一步只是计划，不能声称测试通过。",
          "4. 只有用户明确要求执行时才调用 run_quality_matrix(confirm_execute=true)，并分别报告每种语言的真实结果。",
          "5. 跨仓变更读取 pm://portfolio，核对依赖目标、版本约束、加载失败与仓库循环。",
        ].join("\n"),
      },
    }],
  }),
);

server.registerPrompt(
  "acceptance-review",
  { description: "标准化终验：冻结质量基线后执行证据核验，不能把开发者自测冒充认证。" },
  () => ({
    messages: [{
      role: "user",
      content: {
        type: "text",
        text: [
          "按 pm-mcp 的标准化验收闭环执行，不得事后调低阈值：",
          "1. list_acceptance_baselines 并读取目标基线，确认 ISO/IEC 25010 九特性适用性、量化指标、风险和测试双向追踪。",
          "2. 只有产品负责人审阅 draft fingerprint 后，才能 approve_acceptance_baseline；批准后的同版本不可修改。",
          "3. 执行基线定义的质量、治理、性能与安全测试；失败、跳过、缺工具和过期证据都不得写成通过。",
          "4. evaluate_acceptance 会重算项目内证据 SHA-256，并由机器生成不可覆盖的 JSON/Markdown 报告。",
          "5. 分开陈述：第一方范围内验收、独立评价、托管 CI、生产证据和 ISO 认证；任何一层都不能冒充另一层。",
        ].join("\n"),
      },
    }],
  }),
);

/* ---------------------------------- 启动 ---------------------------------- */

await server.connect(new StdioServerTransport());
// 超大项目核心：server 常驻期间用递归 watcher 持续保鲜 SQLite 索引，
// audit/快照稳态下免全量走查（失败自动降级为纯走查模式）
if (isInitialized(root)) {
  const watcher = startWatcher(root);
  console.error(`[pm-mcp] watcher: ${watcher ? "active" : "unavailable（降级为按需全量走查）"}`);
}
// stdio 是协议通道，日志只能走 stderr
console.error(`[pm-mcp] ready. project root: ${root}`);
