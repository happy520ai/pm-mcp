import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { pmPath } from "./paths.ts";
import { loadJson, saveJson, withLedgerLock } from "./store.ts";

export const GOVERNANCE_SCHEMA_VERSION = 1 as const;
export const GOVERNANCE_FILE = "governance.json";

const IdSchema = z.string().trim().min(1);
const TextSchema = z.string().trim().min(1);

/**
 * Governance paths are persisted with POSIX separators so the ledger has the
 * same identity on Windows and Unix. Resolution against a checkout is left to
 * callers because repository roots may intentionally be absolute or external.
 */
export function normalizeGovernancePath(value: string): string {
  const slashed = value.trim().replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  const normalized = path.posix.normalize(slashed);
  return normalized.length > 1 ? normalized.replace(/\/+$/, "") : normalized;
}

const GovernancePathSchema = z
  .string()
  .trim()
  .min(1)
  .transform(normalizeGovernancePath)
  .pipe(z.string().min(1));

const IdListSchema = z.array(IdSchema).default([]);
const TextListSchema = z.array(TextSchema).default([]);
const PathListSchema = z.array(GovernancePathSchema).default([]);
const ModuleRootsSchema = z.array(GovernancePathSchema).min(1, "模块至少需要一个 root");

export const ModuleSpecSchema = z.object({
  id: IdSchema,
  name: TextSchema,
  roots: ModuleRootsSchema,
  kind: TextSchema,
  owners: TextListSchema,
  languages: TextListSchema,
  public_interfaces: IdListSchema,
  depends_on: IdListSchema,
  allowed_dependencies: IdListSchema,
  denied_dependencies: IdListSchema,
});

export const InterfaceSpecSchema = z.object({
  id: IdSchema,
  kind: TextSchema,
  provider: IdSchema,
  consumers: IdListSchema,
  contract_files: PathListSchema,
  version: TextSchema,
});

export const RepositoryDependencySchema = z.object({
  repository: IdSchema,
  /** 支持 *、精确 semver、^、~、>=、<=、>、<；其他形式由组合审计标为未知。 */
  constraint: TextSchema.default("*"),
});

export const RepositorySpecSchema = z.object({
  id: IdSchema,
  name: TextSchema,
  root: GovernancePathSchema,
  version: TextSchema,
  dependencies: z.array(RepositoryDependencySchema).default([]),
});

export const GovernancePoliciesSchema = z.object({
  enforce_ownership: z.boolean().default(true),
  enforce_declared_dependencies: z.boolean().default(true),
  enforce_public_interfaces: z.boolean().default(true),
  fail_on_unresolved: z.boolean().default(true),
  minimum_coverage_pct: z.number().min(0).max(100).default(80),
  minimum_semantic_assurance: z.enum(["heuristic", "ast", "runtime"]).default("heuristic"),
  fail_on_semantic_fallback: z.boolean().default(false),
  required_quality_kinds: z.array(z.enum(["test", "build", "lint", "typecheck", "coverage", "security"])).default(["test", "build"]),
});

function addDuplicateIssues(
  values: readonly string[],
  collection: "modules" | "interfaces" | "repositories",
  ctx: z.RefinementCtx,
): void {
  const first = new Map<string, number>();
  values.forEach((value, index) => {
    const previous = first.get(value);
    if (previous === undefined) {
      first.set(value, index);
      return;
    }
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [collection, index, "id"],
      message: `重复 ID "${value}"（首次出现在 ${collection}.${previous}.id）`,
    });
  });
}

function addDuplicateListIssues(
  values: readonly string[],
  pathPrefix: (string | number)[],
  label: string,
  ctx: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  values.forEach((value, index) => {
    if (!seen.has(value)) {
      seen.add(value);
      return;
    }
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [...pathPrefix, index],
      message: `${label}包含重复引用 "${value}"`,
    });
  });
}

export const GovernanceSchema = z
  .object({
    schema_version: z.literal(GOVERNANCE_SCHEMA_VERSION).default(GOVERNANCE_SCHEMA_VERSION),
    modules: z.array(ModuleSpecSchema).default([]),
    interfaces: z.array(InterfaceSpecSchema).default([]),
    repositories: z.array(RepositorySpecSchema).default([]),
    policies: GovernancePoliciesSchema.default({
      enforce_ownership: true,
      enforce_declared_dependencies: true,
      enforce_public_interfaces: true,
      fail_on_unresolved: true,
      minimum_coverage_pct: 80,
      minimum_semantic_assurance: "heuristic",
      fail_on_semantic_fallback: false,
      required_quality_kinds: ["test", "build"],
    }),
  })
  .superRefine((governance, ctx) => {
    addDuplicateIssues(governance.modules.map((module) => module.id), "modules", ctx);
    addDuplicateIssues(governance.interfaces.map((item) => item.id), "interfaces", ctx);
    addDuplicateIssues(governance.repositories.map((repository) => repository.id), "repositories", ctx);

    const moduleIds = new Set(governance.modules.map((module) => module.id));
    const interfaceById = new Map(governance.interfaces.map((item) => [item.id, item]));
    const rootOwner = new Map<string, { moduleId: string; index: number }>();
    const repositoryRootOwner = new Map<string, { repositoryId: string; index: number }>();

    governance.modules.forEach((module, moduleIndex) => {
      addDuplicateListIssues(module.roots, ["modules", moduleIndex, "roots"], "roots", ctx);
      addDuplicateListIssues(module.owners, ["modules", moduleIndex, "owners"], "owners", ctx);
      addDuplicateListIssues(module.languages, ["modules", moduleIndex, "languages"], "languages", ctx);
      addDuplicateListIssues(module.public_interfaces, ["modules", moduleIndex, "public_interfaces"], "public_interfaces", ctx);
      addDuplicateListIssues(module.depends_on, ["modules", moduleIndex, "depends_on"], "depends_on", ctx);
      addDuplicateListIssues(module.allowed_dependencies, ["modules", moduleIndex, "allowed_dependencies"], "allowed_dependencies", ctx);
      addDuplicateListIssues(module.denied_dependencies, ["modules", moduleIndex, "denied_dependencies"], "denied_dependencies", ctx);

      if (governance.policies.enforce_ownership && module.owners.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["modules", moduleIndex, "owners"],
          message: `模块 "${module.id}" 在 enforce_ownership=true 时必须声明 owner`,
        });
      }

      module.roots.forEach((root, rootIndex) => {
        const key = root.toLocaleLowerCase("en-US");
        const owner = rootOwner.get(key);
        if (owner && owner.moduleId !== module.id) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["modules", moduleIndex, "roots", rootIndex],
            message: `root "${root}" 已归属模块 "${owner.moduleId}"（modules.${owner.index}.roots）`,
          });
        } else if (!owner) {
          rootOwner.set(key, { moduleId: module.id, index: moduleIndex });
        }
      });

      const dependencyFields = [
        ["depends_on", module.depends_on],
        ["allowed_dependencies", module.allowed_dependencies],
        ["denied_dependencies", module.denied_dependencies],
      ] as const;
      for (const [field, references] of dependencyFields) {
        references.forEach((reference, referenceIndex) => {
          if (!moduleIds.has(reference)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["modules", moduleIndex, field, referenceIndex],
              message: `未知 module 引用 "${reference}"`,
            });
          } else if (reference === module.id) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["modules", moduleIndex, field, referenceIndex],
              message: `模块 "${module.id}" 不能在 ${field} 中引用自身`,
            });
          }
        });
      }

      const denied = new Set(module.denied_dependencies);
      module.allowed_dependencies.forEach((dependency, dependencyIndex) => {
        if (denied.has(dependency)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["modules", moduleIndex, "allowed_dependencies", dependencyIndex],
            message: `依赖 "${dependency}" 不能同时允许和禁止`,
          });
        }
      });
      module.depends_on.forEach((dependency, dependencyIndex) => {
        if (denied.has(dependency)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["modules", moduleIndex, "depends_on", dependencyIndex],
            message: `已声明依赖 "${dependency}" 同时出现在 denied_dependencies`,
          });
        }
      });

      module.public_interfaces.forEach((interfaceId, interfaceIndex) => {
        const item = interfaceById.get(interfaceId);
        if (!item) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["modules", moduleIndex, "public_interfaces", interfaceIndex],
            message: `未知 interface 引用 "${interfaceId}"`,
          });
        } else if (item.provider !== module.id) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["modules", moduleIndex, "public_interfaces", interfaceIndex],
            message: `interface "${interfaceId}" 的 provider 是 "${item.provider}"，不是 "${module.id}"`,
          });
        }
      });
    });

    governance.interfaces.forEach((item, interfaceIndex) => {
      if (!moduleIds.has(item.provider)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["interfaces", interfaceIndex, "provider"],
          message: `未知 module 引用 "${item.provider}"`,
        });
      }
      addDuplicateListIssues(item.consumers, ["interfaces", interfaceIndex, "consumers"], "consumers", ctx);
      addDuplicateListIssues(item.contract_files, ["interfaces", interfaceIndex, "contract_files"], "contract_files", ctx);
      item.consumers.forEach((consumer, consumerIndex) => {
        if (!moduleIds.has(consumer)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["interfaces", interfaceIndex, "consumers", consumerIndex],
            message: `未知 module 引用 "${consumer}"`,
          });
        }
      });
      if (governance.policies.enforce_public_interfaces) {
        const provider = governance.modules.find((module) => module.id === item.provider);
        if (provider && !provider.public_interfaces.includes(item.id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["interfaces", interfaceIndex, "provider"],
            message: `interface "${item.id}" 未登记在 provider "${item.provider}" 的 public_interfaces`,
          });
        }
      }
    });

    governance.repositories.forEach((repository, repositoryIndex) => {
      const rootKey = repository.root.toLocaleLowerCase("en-US");
      const owner = repositoryRootOwner.get(rootKey);
      if (owner && owner.repositoryId !== repository.id) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["repositories", repositoryIndex, "root"],
          message: `repository root "${repository.root}" 已归属仓库 "${owner.repositoryId}"（repositories.${owner.index}.root）`,
        });
      } else if (!owner) {
        repositoryRootOwner.set(rootKey, { repositoryId: repository.id, index: repositoryIndex });
      }

      addDuplicateListIssues(repository.dependencies.map((dependency) => dependency.repository), ["repositories", repositoryIndex, "dependencies"], "dependencies", ctx);
      repository.dependencies.forEach((dependency, dependencyIndex) => {
        // Repository dependencies are portfolio-wide references: the target may
        // live in another governance file, so missing-target checks belong to
        // the composition layer rather than this single-file schema.
        if (dependency.repository === repository.id) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["repositories", repositoryIndex, "dependencies", dependencyIndex, "repository"],
            message: `仓库 "${repository.id}" 不能依赖自身`,
          });
        }
      });
    });
  });

export type ModuleSpec = z.infer<typeof ModuleSpecSchema>;
export type InterfaceSpec = z.infer<typeof InterfaceSpecSchema>;
export type RepositoryDependency = z.infer<typeof RepositoryDependencySchema>;
export type RepositorySpec = z.infer<typeof RepositorySpecSchema>;
export type GovernancePolicies = z.infer<typeof GovernancePoliciesSchema>;
export type GovernanceFile = z.infer<typeof GovernanceSchema>;
export type GovernanceInput = z.input<typeof GovernanceSchema>;

export function governancePath(root: string): string {
  return pmPath(path.resolve(root), GOVERNANCE_FILE);
}

export function loadGovernance(root: string): GovernanceFile {
  const file = governancePath(root);
  if (!fs.existsSync(file)) {
    throw new Error(`治理模型未初始化（缺少 ${file}），请先调用 init_governance。`);
  }
  const governance = loadJson(file, GovernanceSchema);
  if (governance === undefined) {
    throw new Error(`治理模型未初始化（缺少 ${file}），请先调用 init_governance。`);
  }
  return governance;
}

export function saveGovernance(root: string, governance: GovernanceInput): GovernanceFile {
  const parsed = GovernanceSchema.parse(governance);
  const file = governancePath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  saveJson(file, parsed);
  return parsed;
}

export function initGovernance(root: string, governance: GovernanceInput = {}): GovernanceFile {
  return withLedgerLock(root, () => {
    const file = governancePath(root);
    if (fs.existsSync(file)) {
      throw new Error(`治理模型已初始化（${file} 已存在）。`);
    }
    return saveGovernance(root, governance);
  });
}

/** Fail-closed existence and schema check for callers that require governance. */
export function ensureGovernance(root: string): GovernanceFile {
  return loadGovernance(root);
}
