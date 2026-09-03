import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadProject, withLedgerLock } from "./store.ts";

type Fn<Args> = (args: Args) => string | Promise<string>;

export function tool<Args>(
  server: McpServer,
  name: string,
  description: string,
  schema: Record<string, unknown>,
  fn: Fn<Args>,
): void {
  server.registerTool(
    name,
    { description, inputSchema: schema as never },
    (async (args: Args) => {
      try {
        const text = await fn(args);
        return { content: [{ type: "text" as const, text }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: `错误: ${(error as Error).message}` }], isError: true };
      }
    }) as never,
  );
}

/** 写工具必须使用同步 handler，保证跨进程账本锁覆盖完整读-改-写。 */
export function toolW<Args>(
  server: McpServer,
  root: string,
  name: string,
  description: string,
  schema: Record<string, unknown>,
  fn: (args: Args) => string,
): void {
  server.registerTool(
    name,
    { description, inputSchema: schema as never },
    ((args: Args) => {
      try {
        const text = withLedgerLock(root, () => fn(args));
        return { content: [{ type: "text" as const, text }] };
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
