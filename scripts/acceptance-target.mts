import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

const TargetSchema = z.object({ id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/), version: z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/) });

/** 显式 CLI > 当前项目 package.json > 旧项目默认值；不猜测“最新”或改写批准记录。 */
export function acceptanceTarget(root: string, argv: string[] = process.argv.slice(2)) {
  const option = (name: string) => {
    const positions = argv.flatMap((arg, index) => arg === name ? [index] : []);
    if (positions.length > 1) throw new Error(`${name} 重复`);
    if (!positions.length) return undefined;
    const value = argv[positions[0] + 1];
    if (!value || value.startsWith("--")) throw new Error(`${name} 缺少值`);
    return value;
  };
  const file = path.join(root, "package.json");
  const configured = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")).pm_mcp?.acceptance_baseline : undefined;
  if (configured !== undefined) TargetSchema.parse(configured);
  return TargetSchema.parse({ id: option("--baseline-id") ?? configured?.id ?? "pm-mcp-local-release", version: option("--baseline-version") ?? configured?.version ?? "1.0.0" });
}
