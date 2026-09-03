import fs from "node:fs";
import {
  saveDebugLog,
  saveFeatures,
  saveFileNotes,
  saveProject,
  saveRoadmap,
  saveSessions,
  saveTasks,
} from "./store.ts";
import { ensurePmDirs, isInitialized, pmPath } from "./paths.ts";
import { now, type Project } from "./types.ts";
import { governancePath, saveGovernance } from "./governance-model.ts";

export interface InitInput {
  name: string;
  description?: string;
  stack?: string[];
  goals?: string[];
  license?: string;
  exposure?: "local" | "network" | "public";
  modules?: string[];
}

/** 初始化 .pm/ 状态目录（幂等防护：已初始化则报错） */
export function initProject(root: string, input: InitInput): Project {
  if (isInitialized(root)) {
    throw new Error(`项目已初始化（${pmPath(root, "project.json")} 已存在）。修改信息请用 update_project。`);
  }
  ensurePmDirs(root);
  const t = now();
  const project: Project = {
    name: input.name,
    description: input.description ?? "",
    stack: input.stack ?? [],
    goals: input.goals ?? [],
    phase: "",
    modules: input.modules ?? [],
    exposure: input.exposure ?? "local",
    license: input.license ?? "",
    budgets: { maxFileLoc: 500, refactorQuotaPct: 20, sessionBlastRadius: 15, outputBudgetLines: 150 },
    created: t,
    updated: t,
  };
  saveProject(root, project);
  saveRoadmap(root, { seq: 0, milestones: [] });
  saveTasks(root, { seq: 0, tasks: [] });
  saveFeatures(root, { seq: 0, features: [] });
  saveSessions(root, { seq: 0, sessions: [] });
  saveDebugLog(root, { seq: 0, entries: [] });
  saveFileNotes(root, { notes: {} });
  if (!fs.existsSync(governancePath(root))) saveGovernance(root, {});
  const secFile = pmPath(root, "security.json");
  if (!fs.existsSync(secFile)) {
    fs.writeFileSync(secFile, JSON.stringify({ findings: [], last_scan: null }, null, 2) + "\n", "utf8");
  }
  return project;
}
