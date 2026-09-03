import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const serverEntry = path.resolve("src/index.ts");

function responseText(result: { content?: Array<{ type: string; text?: string }> }): string {
  return (result.content ?? []).map((item) => item.text ?? "").join("\n");
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<string> {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(result.isError, undefined, `${name}: ${responseText(result as never)}`);
  return responseText(result as never);
}

test("治理 MCP 全链路：模型、语义、影响、质量执行、portfolio、资源与 prompt", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pm-governance-mcp-"));
  const home = `${root}-home`;
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "index.ts"), "export const api = 1;\n");
  fs.writeFileSync(path.join(root, "tsconfig.json"), "{}\n");
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({
    name: "governed",
    version: "1.2.3",
    scripts: { test: "node -e \"process.exit(0)\"" },
    devDependencies: { typescript: "1.0.0" },
  }));
  const client = new Client({ name: "governance-it", version: "1.0.0" });
  const transport = new StdioClientTransport({ command: process.execPath, args: [serverEntry, "--root", root], env: { PM_MCP_HOME: home } });
  await client.connect(transport);
  t.after(async () => { await client.close(); fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(home, { recursive: true, force: true }); });

  await call(client, "init_project", { name: "governed", modules: ["src"], license: "MIT" });
  await call(client, "upsert_module", {
    id: "app", name: "App", roots: ["src"], kind: "service", owners: ["team-app"], languages: ["typescript"],
    public_interfaces: [], depends_on: [], allowed_dependencies: [], denied_dependencies: [],
  });
  await call(client, "upsert_interface", {
    id: "public-api", kind: "typescript", provider: "app", consumers: [], contract_files: ["src/index.ts"], version: "1.2.3",
  });
  await call(client, "upsert_repository", { id: "app-repo", name: "App repo", root: ".", version: "1.2.3", dependencies: [] });
  await call(client, "set_governance_policies", {
    enforce_ownership: true, enforce_declared_dependencies: true, fail_on_unresolved: true, enforce_public_interfaces: true, minimum_coverage_pct: 100, required_quality_kinds: ["test"],
  });

  const governance = await call(client, "get_governance");
  assert.ok(governance.includes("app") && governance.includes("public-api"));
  const audit = await call(client, "audit_governance");
  assert.ok(audit.includes("✅") && audit.includes("source 100%"), audit);
  const discovered = await call(client, "discover_languages");
  assert.ok(discovered.includes("typescript") && discovered.includes("100%"));
  const impact = await call(client, "impact_analysis", { files: ["src/index.ts"] });
  assert.ok(impact.includes("app"));
  const plan = await call(client, "plan_quality_matrix", { kinds: ["test"] });
  assert.ok(plan.includes("plan-only") && plan.includes("test"));
  const run = await call(client, "run_quality_matrix", { confirm_execute: true, kinds: ["test"] });
  assert.ok(run.includes("质量矩阵") && run.includes("passed"), run);
  assert.ok(fs.existsSync(path.join(root, ".pm", "quality-runs")));
  const portfolio = await call(client, "get_portfolio", { current_only: true });
  assert.ok(portfolio.includes("projects 1/1"));

  const resources = await client.listResources();
  assert.ok(resources.resources.some((item) => item.uri === "pm://architecture"));
  assert.ok(resources.resources.some((item) => item.uri === "pm://portfolio"));
  const architecture = await client.readResource({ uri: "pm://architecture" });
  assert.ok((architecture.contents[0] as { text: string }).text.includes("跨文件/模块/语言"));
  const prompts = await client.listPrompts();
  assert.ok(prompts.prompts.some((item) => item.name === "architecture-review"));
  const prompt = await client.getPrompt({ name: "architecture-review" });
  assert.ok(((prompt.messages[0] as { content: { text: string } }).content.text).includes("impact_analysis"));
});
