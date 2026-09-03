import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverEntry = path.join(repoRoot, "src", "index.ts");

const AWS_KEY = "AKIA" + "IOSFODNN7EXAMPLE"; // 官方文档示例值

function mkTmpProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pm-it-"));
  process.env.PM_MCP_HOME = root + "-home";
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "app.ts"), "export const app = 1;\n", "utf8");
  fs.writeFileSync(path.join(root, "src", "leak.ts"), `export const k = "${AWS_KEY}";\n`, "utf8");
  return root;
}

async function connect(root: string): Promise<Client> {
  const client = new Client({ name: "pm-it", version: "0.0.1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry, "--root", root],
    // SDK 默认只继承白名单环境变量，PM_MCP_HOME 必须显式传给子进程，
    // 否则会污染真实 ~/.pm-mcp/registry.json（教训来自真实运行）
    env: { PM_MCP_HOME: process.env.PM_MCP_HOME! },
  });
  await client.connect(transport);
  return client;
}

function text(result: { content: Array<{ type: string; text?: string }> }): string {
  return (result.content ?? []).map((c) => c.text ?? "").join("\n");
}

test("全链路：工具清单、初始化、任务闭环、断点、审计、资源与提示词", async (t) => {
  const root = mkTmpProject();
  const client = await connect(root);
  t.after(() => client.close());

  // 工具清单：基础工具 + AST/运行时语义证据 + 标准化验收工具
  const tools = await client.listTools();
  assert.equal(tools.tools.length, 46, `实际 ${tools.tools.length}: ${tools.tools.map((x) => x.name).join(",")}`);
  assert.ok(tools.tools.some((x) => x.name === "evaluate_acceptance"));
  assert.ok(tools.tools.some((x) => x.name === "save_semantic_evidence"));
  const writeTools = tools.tools.filter((item) => item.annotations?.readOnlyHint === false);
  assert.ok(writeTools.length >= 20, `应识别主要写工具，实际 ${writeTools.length}`);
  for (const item of writeTools) {
    const properties = (item.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
    assert.ok(properties.idempotency_key, `${item.name} 写工具必须公开 idempotency_key`);
  }

  // 初始化
  const init = await client.callTool({ name: "init_project", arguments: { name: "集成项目", modules: ["src"], license: "MIT" } });
  assert.ok(text(init as never).includes("已初始化"));

  // 里程碑 + 任务
  await client.callTool({ name: "add_milestone", arguments: { title: "MVP", goal: "跑通核心流程" } });
  await client.callTool({
    name: "add_task",
    arguments: { title: "登录功能", milestone: "M1", type: "feature", steps: [{ text: "写表单" }, { text: "接接口" }] },
  });
  await client.callTool({ name: "add_task", arguments: { title: "偿还技术债", milestone: "M1", type: "debt" } });

  // 断点存档
  const cp = await client.callTool({ name: "checkpoint", arguments: { task_id: "T-001", note: "表单写完", next_step: "接后端接口" } });
  assert.ok(text(cp as never).includes("断点已存档"));

  // 转 done 不带 result_note 必须被拒
  const badDone = await client.callTool({ name: "update_task", arguments: { id: "T-001", status: "done" } });
  assert.equal((badDone as { isError?: boolean }).isError, true);
  assert.ok(text(badDone as never).includes("result_note"), "报错要说明缺 result_note");

  // 带笔记通过，且 feature 类无 verification 有提示
  const okDone = await client.callTool({
    name: "update_task",
    arguments: { id: "T-001", status: "done", result_note: "登录页完成", verification: "npm test 通过" },
  });
  assert.ok(!((okDone as { isError?: boolean }).isError));

  // 功能登记（真实入口 + 测试文件）
  await client.callTool({
    name: "register_feature",
    arguments: { name: "登录页", entry_files: ["src/app.ts"], test_files: [], module: "src" },
  });

  // 会话记录
  await client.callTool({ name: "log_session", arguments: { summary: "完成登录", files: ["src/app.ts"], author: "zcode", next_steps: ["做注册"] } });

  // get_status 显示里程碑与下一步
  const status = await client.callTool({ name: "get_status", arguments: {} });
  const statusText = text(status as never);
  assert.ok(statusText.includes("集成项目"));
  assert.ok(statusText.includes("M1"));

  // 路线图 depth=2 展开活跃任务
  const roadmap = await client.callTool({ name: "get_roadmap", arguments: { depth: 2 } });
  assert.ok(text(roadmap as never).includes("M1"));

  // 安全扫描发现 AWS key（台账不含明文）
  const sec = await client.callTool({ name: "audit_security", arguments: {} });
  const secText = text(sec as never);
  assert.ok(secText.includes("SEC-") || secText.includes("高危"), "应发现泄露");
  const ledger = fs.readFileSync(path.join(root, ".pm", "security.json"), "utf8");
  assert.ok(!ledger.includes(AWS_KEY), "台账不得含明文");

  // 接受风险必须留理由
  const badAccept = await client.callTool({ name: "resolve_finding", arguments: { id: "SEC-001", status: "accepted" } });
  assert.equal((badAccept as { isError?: boolean }).isError, true);

  // 快照 + 对账 + 许可证
  await client.callTool({ name: "snapshot_codebase", arguments: {} });
  const audit = await client.callTool({ name: "audit_structure", arguments: {} });
  assert.ok(text(audit as never).includes("对账") || text(audit as never).includes("增长"));
  const lic = await client.callTool({ name: "audit_license", arguments: {} });
  assert.ok(text(lic as never).includes("许可证"));

  // 求证：search_code 命中真实文件
  const search = await client.callTool({ name: "search_code", arguments: { query: "app = 1" } });
  assert.ok(text(search as never).includes("src/app.ts:1"));

  // 知识检索：能查到调试记录
  await client.callTool({ name: "log_debug", arguments: { symptom: "构建失败", root_cause: "循环依赖", fix: "拆接口" } });
  const know = await client.callTool({ name: "search_knowledge", arguments: { query: "构建失败" } });
  assert.ok(text(know as never).includes("调试记录"));

  // 文件索引
  await client.callTool({ name: "annotate_file", arguments: { path: "src/app.ts", purpose: "应用入口" } });
  const search2 = await client.callTool({ name: "search_code", arguments: { query: "应用入口" } });
  assert.ok(text(search2 as never).includes("文件索引命中"));

  // 资源
  const resources = await client.listResources();
  assert.equal(resources.resources.length, 7);
  assert.ok(resources.resources.some((r) => r.uri.includes("dashboard")));
  assert.ok(resources.resources.some((r) => r.uri === "pm://acceptance"));
  const dash = await client.readResource({ uri: "pm://dashboard" });
  const dashText = (dash.contents as Array<{ text?: string }>).map((c) => c.text ?? "").join("");
  assert.ok(dashText.includes("集成项目"));

  // 提示词
  const prompts = await client.listPrompts();
  assert.equal(prompts.prompts.length, 5);
  assert.ok(prompts.prompts.some((p) => p.name === "start-session"));
  assert.ok(prompts.prompts.some((p) => p.name === "acceptance-review"));
  const p = await client.getPrompt({ name: "start-session" });
  assert.ok((p.messages[0].content as { text: string }).text.includes("get_status"));

  // 全局注册表（沙箱内）
  const reg = await client.callTool({ name: "list_projects", arguments: {} });
  assert.ok(text(reg as never).includes("集成项目"));

  // 仪表盘文件真实存在
  assert.ok(fs.existsSync(path.join(root, "PROJECT.md")));
});
