import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { loadProject } from "./store.ts";
import { IdempotencyKeySchema, runCoalescedRead, runIdempotentWrite, runIdempotentWriteSync } from "./idempotency.ts";

type Fn<Args> = (args: Args) => string | Promise<string>;

/** 只读工具：跨 Agent/进程合并完全相同的并行请求，短窗复用结果。 */
export function toolR<Args>(
  server: McpServer,
  root: string,
  name: string,
  description: string,
  schema: Record<string, unknown>,
  fn: Fn<Args>,
): void {
  server.registerTool(
    name,
    { description, inputSchema: schema as never, annotations: { readOnlyHint: true } },
    (async (args: Args) => {
      try {
        const result = await runCoalescedRead(root, name, args, fn);
        return { content: [{ type: "text" as const, text: result.text }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: `错误: ${(error as Error).message}` }], isError: true };
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
      try {
        const result = runIdempotentWriteSync(root, name, args, fn, prepare);
        const prefix = result.replayed ? `↩️ 幂等复用 ${result.key}\n` : result.pending ? `⏳ 幂等占位 ${result.key}\n` : "";
        return { content: [{ type: "text" as const, text: prefix + result.text }], ...(result.pending ? { isError: true } : {}) };
      } catch (error) {
        return { content: [{ type: "text" as const, text: `错误: ${(error as Error).message}` }], isError: true };
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
      try {
        const result = await runIdempotentWrite(root, name, args, fn);
        const prefix = result.replayed ? `↩️ 幂等复用 ${result.key}\n` : result.pending ? `⏳ 幂等占位 ${result.key}\n` : "";
        return { content: [{ type: "text" as const, text: prefix + result.text }], ...(result.pending ? { isError: true } : {}) };
      } catch (error) {
        return { content: [{ type: "text" as const, text: `错误: ${(error as Error).message}` }], isError: true };
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
