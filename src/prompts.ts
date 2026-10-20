#!/usr/bin/env node
/** Prompts: 工作流提示注册（开工/收工仪式、入职简报、架构评审、标准化终验）。 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function registerPrompts(server: McpServer): void {
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
              "1. feature/fix 先执行适用测试，生成最新质量报告；update_task 置 done，给 result_note 与实际 files，record_session=true 可一并归档。",
              "2. 未完成的任务：checkpoint 保存「进展 + 下一步具体动作」。",
              "3. 本次落地的功能：register_feature 登记（入口文件 + 测试文件）。",
              "4. 修过的 bug：log_debug 记录症状/根因/修法/验证。",
              "5. 走过的捷径：add_task(type=debt) 登记债务，别让它在沉默中腐烂。",
              "6. update_task 已返回自动会话编号时，不重复 log_session；否则用 log_session 记录真实改动清单。纯问答不需要另建任务或反复写会话。",
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
}
