/**
 * 场景测试：对一个虚构但完全真实的项目（含中文目录、CRLF、伪造密钥、GPL 头、
 * 被删测试、skip 标记、断点中断）跑完整生命周期。
 * 三段会话分别用三种真实的根解析方式（cwd / PM_ROOT / --root）连接 dist 产物。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const distEntry = path.resolve("dist/index.js");
const AWS_KEY = "AKIA" + "IOSFODNN7EXAMPLE"; // AWS 官方文档示例值

function mkScenarioProject(): string {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "pm-sc-"));
  const root = path.join(base, "订单 系统 v1"); // 中文 + 空格路径
  const w = (rel: string, content: string): void => {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");
  };
  w("src/app.ts", "export function createOrder(userId: number) {\r\n  return { id: 1, userId };\r\n}\r\n"); // CRLF
  w("src/中文工具.ts", "export const 计算总价 = (a: number, b: number) => a + b;\n");
  w("src/big-module.ts", "export const x0 = 0;\n".repeat(620)); // 超预算 620 行
  w("src/leak.ts", `export const KEY = "${AWS_KEY}";\n`);
  w("src/copied.ts", "// Copied from somewhere\n// GNU GENERAL PUBLIC LICENSE Version 3\nexport const y = 1;\n");
  w("src/danger.py", "import requests\nrequests.get(url, verify=False)\n");
  w(".env", `API_KEY=${AWS_KEY}\n`);
  w("test/orders.test.ts", "test('创建订单', () => { assert.ok(createOrder(1)); });\n");
  w("test/legacy.test.ts", "test('旧逻辑', () => { assert.ok(true); });\n");
  w("package.json", JSON.stringify({ name: "order-sys", license: "MIT", dependencies: { "left-pad": "^1.0.0", "gpl-thing": "^1.0.0" } }, null, 2));
  w("node_modules/left-pad/package.json", JSON.stringify({ name: "left-pad", version: "1.0.0", license: "MIT" }));
  w("node_modules/gpl-thing/package.json", JSON.stringify({ name: "gpl-thing", version: "1.0.0", license: "GPL-3.0" }));
  return root;
}

function mkHome(root: string): string {
  const home = root + "-mcp-home";
  fs.mkdirSync(home, { recursive: true });
  return home;
}

interface Ctx {
  home: string;
  root: string;
}

async function connect(ctx: Ctx, mode: "cwd" | "env" | "arg"): Promise<Client> {
  const client = new Client({ name: `sc-${mode}`, version: "0" });
  const params: Record<string, unknown> = {
    command: process.execPath,
    // SDK 默认只继承白名单环境变量，PM_MCP_HOME/PM_ROOT 必须显式传递
    env: { PM_MCP_HOME: ctx.home, ...(mode === "env" ? { PM_ROOT: ctx.root } : {}) },
  };
  if (mode === "cwd") {
    params.cwd = ctx.root;
    params.args = [distEntry];
  } else if (mode === "env") {
    params.args = [distEntry];
  } else {
    params.args = [distEntry, "--root", ctx.root];
  }
  await client.connect(new StdioClientTransport(params as never));
  return client;
}

/** 断言失败时兜底关闭所有子进程，否则孤儿 server 握着管道导致测试进程永不退出（真实教训） */
function reaper(t: { after: (fn: () => Promise<void>) => void }): (client: Client) => Client {
  const clients: Client[] = [];
  t.after(async () => {
    await Promise.all(clients.map((c) => c.close().catch(() => undefined)));
  });
  return (client: Client): Client => {
    clients.push(client);
    return client;
  };
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<{ ok: boolean; text: string }> {
  const r = (await client.callTool({ name, arguments: args })) as { content?: Array<{ text?: string }>; isError?: boolean };
  return { ok: !r.isError, text: (r.content ?? []).map((c) => c.text ?? "").join("\n") };
}

test("场景：三段会话走完订单系统生命周期（dist 产物 + 三种根解析）", async (t) => {
  const root = mkScenarioProject();
  const home = mkHome(root);
  const ctx: Ctx = { home, root };
  const track = reaper(t);

  /* ---- 会话一（cwd 模式）：立项、拆任务、中断 ---- */
  const a = track(await connect(ctx, "cwd"));
  const a1 = await call(a, "init_project", { name: "订单系统", description: "书店订单管理", stack: ["TypeScript", "Python"], modules: ["src", "test"], license: "MIT" });
  assert.ok(a1.ok && a1.text.includes("已初始化"), a1.text);
  await call(a, "add_milestone", { title: "MVP", goal: "下单流程跑通" });
  await call(a, "add_milestone", { title: "增强", goal: "支付与对账" });
  await call(a, "update_milestone", { id: "M1", status: "active" });
  await call(a, "add_task", {
    title: "创建订单接口",
    milestone: "M1",
    type: "feature",
    files: ["src/app.ts"],
    steps: [{ text: "写领域模型" }, { text: "写接口" }, { text: "补测试" }],
    acceptance: "POST /orders 返回订单号",
  });
  await call(a, "add_task", { title: "临时用内存表存价格（后续换数据库）", milestone: "M1", type: "debt" });
  for (let i = 0; i < 5; i++) {
    await call(a, "add_task", { title: `增强项 ${i + 1}`, milestone: "M1", type: "feature" }); // 5+ 纯 feature → 配额告警
  }
  const cp = await call(a, "checkpoint", { task_id: "T-001", note: "领域模型写了一半", next_step: "补齐 OrderItem 结构" });
  assert.ok(cp.ok && cp.text.includes("断点已存档"));
  await a.close(); // 模拟会话中断 / 上下文丢失

  /* ---- 会话二（PM_ROOT 模式）：从断点恢复并推进 ---- */
  const b = track(await connect(ctx, "env"));
  const st = await call(b, "get_status");
  assert.ok(st.text.includes("下一步: 补齐 OrderItem 结构"), "新进程能看到断点恢复点");
  const s1 = await call(b, "update_task", { id: "T-001", step_done: 1 });
  assert.ok(s1.ok && s1.text.includes("1/3"), s1.text);
  const badStep = await call(b, "update_task", { id: "T-001", step_done: 9 });
  assert.ok(!badStep.ok && badStep.text.includes("不存在"));
  await call(b, "log_debug", {
    symptom: "创建订单时总价算错（CRLF 文件里宏替换）",
    root_cause: "价格表硬编码在 CRLF 文件中，解析时 \\r 残留导致 Number() 为 NaN",
    fix: "解析前 trim 每行",
    verified_how: "npm test orders.test.ts 通过",
    files: ["src/中文工具.ts"],
  });
  const feat = await call(b, "register_feature", { name: "创建订单", entry_files: ["src/app.ts"], test_files: ["test/orders.test.ts"], module: "src" });
  assert.ok(feat.ok);
  const ann = await call(b, "annotate_file", { path: "src\\中文工具.ts", purpose: "价格计算工具（含中文标识符）" }); // 反斜杠路径
  assert.ok(ann.ok, ann.text);
  await call(b, "log_session", { summary: "修复总价计算并登记功能", files: ["src/中文工具.ts", "src/app.ts"], author: "codex", next_steps: ["补接口测试"] });
  await b.close();

  /* ---- 会话三（--root 模式）：恶化注入 + 全面对账 ---- */
  const c = track(await connect(ctx, "arg"));
  const snap0 = await call(c, "snapshot_codebase"); // 基线
  assert.ok(snap0.ok && snap0.text.includes("快照已保存"));

  // 恶化：删测试（蒸发）、加 skip、删功能入口（漂移）、新增依赖、三次会话波及同文件（churn）
  fs.rmSync(path.join(root, "test/legacy.test.ts"));
  fs.writeFileSync(path.join(root, "test/orders.test.ts"), "it.skip('创建订单', () => {});\ntest('ok', () => { assert.ok(true); });\n");
  fs.rmSync(path.join(root, "src/app.ts"));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "order-sys", license: "MIT", dependencies: { "left-pad": "^1.0.0", "gpl-thing": "^1.0.0", "ai-hallucinated": "^9.9.9" } }, null, 2));
  await call(c, "log_session", { summary: "第二会话", files: ["src/中文工具.ts", "src/big-module.ts"], author: "codex" });
  await call(c, "log_session", { summary: "第三会话", files: ["src/中文工具.ts", "src/big-module.ts"], author: "zcode" });
  await call(c, "log_session", { summary: "第四会话（波及面超大）", files: Array.from({ length: 16 }, (_, i) => `src/f${i}.ts`), author: "zcode" });

  const audit = await call(c, "audit_structure");
  const A = audit.text;
  assert.ok(A.includes("漂移") && A.includes("src/app.ts"), "删掉的入口文件被对账点名");
  assert.ok(A.includes("测试蒸发"), A);
  assert.ok(A.includes("禁用/独占测试标记"), A);
  assert.ok(A.includes("big-module.ts") && A.includes("预算 500"), "超预算文件被点名");
  assert.ok(A.includes("ai-hallucinated"), "AI 新增依赖被点名");
  assert.ok(A.includes("中文工具.ts"), "churn 热点（3 次波及）被点名");
  assert.ok(A.includes("波及 16 个文件") || A.includes("波及面"), "单会话波及面告警");
  assert.ok(A.includes("重构被挤出") || A.includes("重构类占比"), "重构配额出现");

  const sec = await call(c, "audit_security");
  assert.ok(sec.text.includes("高危") || sec.text.includes("SEC-"), "安全发现出现");
  const ledger = fs.readFileSync(path.join(root, ".pm/security.json"), "utf8");
  assert.ok(!ledger.includes(AWS_KEY), "台账不含密钥明文（红线）");
  const openFindings = JSON.parse(ledger).findings.filter((f: { status: string }) => f.status === "open");
  assert.ok(openFindings.length >= 3, `至少检出密钥/verify=False/.env，实际 ${openFindings.length}`);
  // 接受风险必须留理由
  const badAccept = await call(c, "resolve_finding", { id: openFindings[0].id, status: "accepted" });
  assert.ok(!badAccept.ok);
  const okAccept = await call(c, "resolve_finding", { id: openFindings[0].id, status: "accepted", note: "示例值，非真实凭据" });
  assert.ok(okAccept.ok);
  // 移除泄露后自动关闭
  fs.rmSync(path.join(root, "src/leak.ts"));
  fs.rmSync(path.join(root, ".env"));
  fs.rmSync(path.join(root, "src/danger.py"));
  const sec2 = await call(c, "audit_security");
  assert.ok(sec2.text.includes("自动关闭"), "修复后重扫自动关闭");

  const lic = await call(c, "audit_license");
  assert.ok(lic.text.includes("🔴 gpl-thing"), "copyleft 依赖标红");
  assert.ok(lic.text.includes("src/copied.ts"), "GPL 头文件被点名");
  // 补 LICENSE 后复查
  fs.writeFileSync(path.join(root, "LICENSE"), "MIT License\n", "utf8");
  const lic2 = await call(c, "audit_license");
  assert.ok(lic2.text.includes("LICENSE 文件: 存在"));

  // 求证检索（中文内容 + 正则特殊字符）
  const sc = await call(c, "search_code", { query: "计算总价" });
  assert.ok(sc.text.includes("src/中文工具.ts:1"), sc.text);
  const sc2 = await call(c, "search_code", { query: "(a+" });
  assert.ok(sc2.ok, "非法正则按字面量处理不崩");
  const kn = await call(c, "search_knowledge", { query: "总价算错" });
  assert.ok(kn.text.includes("根因") || kn.text.includes("NaN"), "调试记录可检索");

  // 收尾：done 必须带 result_note；带齐后通过
  const badDone = await call(c, "update_task", { id: "T-001", status: "done" });
  assert.ok(!badDone.ok && badDone.text.includes("result_note"));
  const okDone = await call(c, "update_task", { id: "T-001", status: "done", result_note: "接口完成", verification: "npm test 通过" });
  assert.ok(okDone.ok);
  const rm = await call(c, "get_roadmap", { depth: 1 });
  assert.ok(rm.text.includes("M1") && rm.text.includes("1/7"), `路线图进度 1/7：${rm.text.split("\n").slice(0, 4).join(" / ")}`);

  // 资源与提示词
  const dash = await c.readResource({ uri: "pm://dashboard" });
  const dashText = (dash.contents as Array<{ text?: string }>).map((x) => x.text ?? "").join("");
  assert.ok(dashText.includes("订单系统") && dashText.includes("路线图"));
  const prompt = await c.getPrompt({ name: "end-session" });
  assert.ok(((prompt.messages[0] as { content: { text: string } }).content).text.includes("log_session"));
  const reg = await call(c, "list_projects");
  assert.ok(reg.text.includes("订单系统"));

  // 未初始化项目的友好报错（真实新目录）
  const freshHome = mkHome(root);
  const freshRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pm-fresh-"));
  const d = await (async () => {
    const cl = track(new Client({ name: "sc-fresh", version: "0" }));
    await cl.connect(new StdioClientTransport({ command: process.execPath, args: [distEntry, "--root", freshRoot], env: { PM_MCP_HOME: freshHome } }));
    return await call(cl, "get_status");
  })();
  assert.ok(!d.ok && d.text.includes("init_project"), `友好报错: ${d.text}`);

  await c.close();
}, { timeout: 120_000 });
