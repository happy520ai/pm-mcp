import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { loadProject } from "./store.ts";
import { IdempotencyKeySchema, runCoalescedRead, runIdempotentWrite, runIdempotentWriteSync } from "./idempotency.ts";
import { drainFoldSavings } from "./budget.ts";
import { estimateTokens, logRuntime, logUsage, type UsageKind } from "./usage-log.ts";

type Fn<Args> = (args: Args) => string | Promise<string>;
interface ReadPresentation {
  cacheVersion?: string;
  outputSchema: Record<string, unknown>;
  decode: (value: string) => { text: string; data: Record<string, unknown> };
}

interface UsageOutcome {
  ok: boolean;
  text?: string;
  replayed?: boolean;
  pending?: boolean;
  uncertain?: boolean;
  error?: string;
}

/** 工具/资源调用结束后写使用日志（含本次折叠省下的 token 估算）；绝不抛错。 */
export function recordUsage(root: string, tool: string, kind: UsageKind, started: number, outcome: UsageOutcome): void {
  try {
    const folded = drainFoldSavings();
    logUsage(root, {
      ts: new Date().toISOString(),
      tool,
      kind,
      ok: outcome.ok,
      ms: Date.now() - started,
      ...(outcome.text !== undefined ? { out_chars: outcome.text.length, est_tokens: estimateTokens(outcome.text) } : {}),
      ...(folded ? { folded_chars: folded.chars, folded_tokens: folded.tokens } : {}),
      ...(outcome.replayed ? { replayed: true } : {}),
      ...(outcome.pending ? { pending: true } : {}),
      ...(outcome.uncertain ? { uncertain: true } : {}),
      ...(outcome.error ? { error: outcome.error.slice(0, 300) } : {}),
    });
  } catch {
    /* 使用日志绝不影响工具调用 */
  }
}

/** 只读工具：跨 Agent/进程合并完全相同的并行请求，短窗复用结果。 */
export function toolR<Args>(
  server: McpServer,
  root: string,
  name: string,
  description: string,
  schema: Record<string, unknown>,
  fn: Fn<Args>,
  presentation?: ReadPresentation,
): void {
  server.registerTool(
    name,
    { description, inputSchema: schema as never, ...(presentation ? { outputSchema: presentation.outputSchema as never } : {}), annotations: { readOnlyHint: true } },
    (async (args: Args) => {
      const started = Date.now();
      try {
        const result = await runCoalescedRead(root, presentation ? `${name}:${presentation.cacheVersion ?? "structured-v1"}` : name, args, fn);
        const decoded = presentation?.decode(result.text);
        const text = decoded?.text ?? result.text;
        recordUsage(root, name, "read", started, {
          ok: !result.pending,
          text: decoded ? text + JSON.stringify(decoded.data) : text,
          replayed: result.replayed,
          pending: result.pending,
          uncertain: result.uncertain,
        });
        return { content: [{ type: "text" as const, text }], ...(decoded ? { structuredContent: decoded.data } : {}) };
      } catch (error) {
        const message = (error as Error).message;
        recordUsage(root, name, "read", started, { ok: false, error: message });
        logRuntime(root, "error", "tool.error", `${name}: ${message.slice(0, 200)}`);
        return { content: [{ type: "text" as const, text: `错误: ${message}` }], isError: true };
      }
    }) as never,
  );
}

const idempotencyDescription = "多 Agent 执行同一业务时传相同 idempotency_key；同键同参数只执行一次，同键不同参数拒绝。";

function writeSchema(schema: Record<string, unknown>): Record<string, unknown> {
  return {
    ...schema,
    idempotency_key: IdempotencyKeySchema.optional().describe("跨 Agent 业务幂等键，建议格式 task-id:operation，如 T-123:add-task"),
  };
}

/** 同步写工具：业务幂等占位 + 跨进程账本锁覆盖完整读-改-写。 */
export function toolW<Args, Prepared = void>(
  server: McpServer,
  root: string,
  name: string,
  description: string,
  schema: Record<string, unknown>,
  fn: (args: Args, prepared: Prepared) => string,
  prepare?: (args: Args) => Prepared,
): void {
  server.registerTool(
    name,
    { description: `${description} ${idempotencyDescription}`, inputSchema: writeSchema(schema) as never, annotations: { readOnlyHint: false } },
    ((args: Args) => {
      const started = Date.now();
      try {
        const result = runIdempotentWriteSync(root, name, args, fn, prepare);
        const prefix = result.replayed ? `↩️ 幂等复用 ${result.key}\n` : result.pending ? `⏳ 幂等占位 ${result.key}\n` : "";
        const text = prefix + result.text;
        recordUsage(root, name, "write", started, {
          ok: !result.pending,
          text,
          replayed: result.replayed,
          pending: result.pending,
          uncertain: result.uncertain,
        });
        return { content: [{ type: "text" as const, text }], ...(result.pending ? { isError: true } : {}) };
      } catch (error) {
        const message = (error as Error).message;
        recordUsage(root, name, "write", started, { ok: false, error: message });
        logRuntime(root, "error", "tool.error", `${name}: ${message.slice(0, 200)}`);
        return { content: [{ type: "text" as const, text: `错误: ${message}` }], isError: true };
      }
    }) as never,
  );
}

/** 已自带内部锁或异步执行的写工具：先跨进程占位，完成后缓存结果。 */
export function toolI<Args>(
  server: McpServer,
  root: string,
  name: string,
  description: string,
  schema: Record<string, unknown>,
  fn: Fn<Args>,
): void {
  server.registerTool(
    name,
    { description: `${description} ${idempotencyDescription}`, inputSchema: writeSchema(schema) as never, annotations: { readOnlyHint: false } },
    (async (args: Args) => {
      const started = Date.now();
      try {
        const result = await runIdempotentWrite(root, name, args, fn);
        const prefix = result.replayed ? `↩️ 幂等复用 ${result.key}\n` : result.pending ? `⏳ 幂等占位 ${result.key}\n` : "";
        const text = prefix + result.text;
        recordUsage(root, name, "write-async", started, {
          ok: !result.pending,
          text,
          replayed: result.replayed,
          pending: result.pending,
          uncertain: result.uncertain,
        });
        return { content: [{ type: "text" as const, text }], ...(result.pending ? { isError: true } : {}) };
      } catch (error) {
        const message = (error as Error).message;
        recordUsage(root, name, "write-async", started, { ok: false, error: message });
        logRuntime(root, "error", "tool.error", `${name}: ${message.slice(0, 200)}`);
        return { content: [{ type: "text" as const, text: `错误: ${message}` }], isError: true };
      }
    }) as never,
  );
}

export function budgetLines(root: string): number {
  try {
    return loadProject(root).budgets.outputBudgetLines;
  } catch {
    return 150;
  }
}
