import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  GovernanceSchema,
  ensureGovernance,
  governancePath,
  initGovernance,
  loadGovernance,
  saveGovernance,
} from "../src/governance-model.ts";
import { mkProj } from "./helpers.ts";

function validGovernance(): unknown {
  return {
    schema_version: 1,
    modules: [
      {
        id: "api",
        name: "API",
        roots: [".\\apps\\api\\"],
        kind: "service",
        owners: ["team-api"],
        languages: ["TypeScript"],
        public_interfaces: ["orders-v1"],
        depends_on: ["domain"],
        allowed_dependencies: ["domain"],
        denied_dependencies: [],
      },
      {
        id: "domain",
        name: "Domain",
        roots: ["packages/domain"],
        kind: "library",
        owners: ["team-domain"],
        languages: ["TypeScript", "Python"],
        public_interfaces: [],
        depends_on: [],
        allowed_dependencies: [],
        denied_dependencies: ["api"],
      },
    ],
    interfaces: [
      {
        id: "orders-v1",
        kind: "http",
        provider: "api",
        consumers: ["domain"],
        contract_files: [".\\contracts\\orders.yaml"],
        version: "1.0.0",
      },
    ],
    repositories: [
      { id: "main", name: "Main", root: ".\\", version: "1.0.0", dependencies: [{ repository: "shared", constraint: "^2.0.0" }] },
      { id: "shared", name: "Shared", root: "..\\shared\\", version: "2.1.0", dependencies: [] },
    ],
    policies: {
      enforce_ownership: true,
      enforce_declared_dependencies: true,
      enforce_public_interfaces: true,
      fail_on_unresolved: true,
      minimum_coverage_pct: 80,
    },
  };
}

test("v1 schema 规范化路径并保留结构化治理关系", () => {
  const parsed = GovernanceSchema.parse(validGovernance());
  assert.equal(parsed.schema_version, 1);
  assert.equal(parsed.policies.enforce_public_interfaces, true);
  assert.equal(parsed.policies.minimum_coverage_pct, 80);
  assert.equal(parsed.policies.minimum_semantic_assurance, "heuristic");
  assert.equal(parsed.policies.fail_on_semantic_fallback, false);
  assert.deepEqual(parsed.modules[0].roots, ["apps/api"]);
  assert.deepEqual(parsed.interfaces[0].contract_files, ["contracts/orders.yaml"]);
  assert.equal(parsed.repositories[0].root, ".");
  assert.equal(parsed.repositories[1].root, "../shared");
});

test("load/ensure 对缺失治理文件 fail-closed，init/save 使用原子 JSON 路径", () => {
  const root = mkProj();
  assert.equal(governancePath(root), path.join(root, ".pm", "governance.json"));
  assert.throws(() => loadGovernance(root), /治理模型未初始化.*governance\.json/);
  assert.throws(() => ensureGovernance(root), /治理模型未初始化.*governance\.json/);

  const initialized = initGovernance(root, validGovernance());
  assert.equal(initialized.modules[0].roots[0], "apps/api");
  assert.deepEqual(loadGovernance(root), initialized);
  assert.deepEqual(ensureGovernance(root), initialized);
  assert.throws(() => initGovernance(root, validGovernance()), /治理模型已初始化/);

  const saved = saveGovernance(root, { ...initialized, policies: { ...initialized.policies, fail_on_unresolved: false } });
  assert.equal(loadGovernance(root).policies.fail_on_unresolved, false);
  assert.deepEqual(saved, loadGovernance(root));
  assert.equal(
    fs.readdirSync(path.dirname(governancePath(root))).some((name) => name.endsWith(".tmp")),
    false,
  );
});

test("拒绝各实体重复 ID、规范化后同 root 多归属", () => {
  const input = validGovernance() as any;
  input.modules.push({ ...input.modules[1], id: "api", roots: ["apps/other"] });
  input.modules.push({ ...input.modules[1], id: "worker", roots: ["apps\\api"] });
  input.interfaces.push({ ...input.interfaces[0] });
  input.repositories.push({ ...input.repositories[1], id: "shared-copy", root: "../shared/" });
  const result = GovernanceSchema.safeParse(input);
  assert.equal(result.success, false);
  const messages = result.success ? [] : result.error.issues.map((issue) => issue.message);
  assert.ok(messages.some((message) => message.includes("重复 ID \"api\"")));
  assert.ok(messages.some((message) => message.includes("重复 ID \"orders-v1\"")));
  assert.ok(messages.some((message) => message.includes("已归属模块")));
  assert.ok(messages.some((message) => message.includes("repository root") && message.includes("已归属仓库")));
});

test("拒绝未知 module/interface 引用和依赖策略冲突，允许组合层解析外部仓库", () => {
  const input = validGovernance() as any;
  input.modules[0].depends_on.push("ghost");
  input.modules[0].allowed_dependencies.push("ghost-allowed");
  input.modules[0].denied_dependencies.push("domain");
  input.modules[0].public_interfaces.push("missing-interface");
  input.interfaces[0].provider = "missing-provider";
  input.interfaces[0].consumers.push("missing-consumer");
  input.repositories[0].dependencies.push({ repository: "external-repository", constraint: ">=1.0.0" });
  const result = GovernanceSchema.safeParse(input);
  assert.equal(result.success, false);
  const messages = result.success ? [] : result.error.issues.map((issue) => issue.message);
  assert.ok(messages.filter((message) => message.includes("未知 module 引用")).length >= 4);
  assert.ok(messages.some((message) => message.includes("未知 interface 引用")));
  assert.ok(messages.some((message) => message.includes("denied_dependencies")));

  input.modules[0].depends_on.pop();
  input.modules[0].allowed_dependencies.pop();
  input.modules[0].denied_dependencies.pop();
  input.modules[0].public_interfaces.pop();
  input.interfaces[0].provider = "api";
  input.interfaces[0].consumers.pop();
  const external = GovernanceSchema.parse(input);
  assert.equal(external.repositories[0].dependencies.at(-1)?.repository, "external-repository");
});

test("ownership policy 开启时拒绝无 owner；关闭时允许", () => {
  const input = validGovernance() as any;
  input.modules[0].owners = [];
  assert.equal(GovernanceSchema.safeParse(input).success, false);
  input.policies.enforce_ownership = false;
  assert.equal(GovernanceSchema.safeParse(input).success, true);
});

test("模块 roots 非空且仓库不能依赖自身", () => {
  const noRoot = validGovernance() as any;
  noRoot.modules[0].roots = [];
  assert.equal(GovernanceSchema.safeParse(noRoot).success, false);

  const selfDependency = validGovernance() as any;
  selfDependency.repositories[0].dependencies = [{ repository: "main", constraint: "*" }];
  const result = GovernanceSchema.safeParse(selfDependency);
  assert.equal(result.success, false);
  assert.ok(!result.success && result.error.issues.some((issue) => issue.message.includes("不能依赖自身")));
});

test("治理策略默认值、coverage 范围与 public interface 一致性", () => {
  const defaults = GovernanceSchema.parse({ modules: [], interfaces: [], repositories: [] });
  assert.equal(defaults.policies.enforce_public_interfaces, true);
  assert.equal(defaults.policies.minimum_coverage_pct, 80);
  assert.equal(defaults.policies.minimum_semantic_assurance, "heuristic");
  assert.equal(defaults.policies.fail_on_semantic_fallback, false);

  const invalidCoverage = validGovernance() as any;
  invalidCoverage.policies.minimum_coverage_pct = 101;
  assert.equal(GovernanceSchema.safeParse(invalidCoverage).success, false);

  const invalidAssurance = validGovernance() as any;
  invalidAssurance.policies.minimum_semantic_assurance = "regex";
  assert.equal(GovernanceSchema.safeParse(invalidAssurance).success, false);

  const missingDeclaration = validGovernance() as any;
  missingDeclaration.modules[0].public_interfaces = [];
  assert.equal(GovernanceSchema.safeParse(missingDeclaration).success, false);
  missingDeclaration.policies.enforce_public_interfaces = false;
  assert.equal(GovernanceSchema.safeParse(missingDeclaration).success, true);
});
