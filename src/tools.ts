import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAcceptanceTools } from "./acceptance-tools.ts";
import { registerAuditTools, registerRegistryTools } from "./audit-tools.ts";
import { registerGovernanceTools } from "./governance-tools.ts";
import {
  registerDecisionTools,
  registerFeatureTools,
  registerSearchTools,
  registerSessionTools,
} from "./knowledge-tools.ts";
import { registerProjectTools, registerRoadmapTools } from "./project-tools.ts";
import { registerTaskTools } from "./task-tools.ts";

export {
  registerProjectTools,
  registerRoadmapTools,
  registerTaskTools,
  registerFeatureTools,
  registerDecisionTools,
  registerSessionTools,
  registerSearchTools,
  registerAuditTools,
  registerRegistryTools,
};

/** Stable aggregate entrypoint used by the MCP server. */
export function registerAllTools(server: McpServer, root: string): void {
  registerProjectTools(server, root);
  registerRoadmapTools(server, root);
  registerTaskTools(server, root);
  registerFeatureTools(server, root);
  registerDecisionTools(server, root);
  registerSessionTools(server, root);
  registerSearchTools(server, root);
  registerAuditTools(server, root);
  registerRegistryTools(server);
  registerGovernanceTools(server, root);
  registerAcceptanceTools(server, root);
}
