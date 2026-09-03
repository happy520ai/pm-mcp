#!/usr/bin/env node
import path from "node:path";
import { acceptanceBaselineFingerprint } from "../src/acceptance-evaluator.ts";
import {
  AcceptanceBaselineSchema,
  ISO_25010_CHARACTERISTICS,
  ISO_25040_STAGES,
  saveAcceptanceBaseline,
  type AcceptanceBaselineInput,
} from "../src/acceptance-model.ts";

type Characteristic = typeof ISO_25010_CHARACTERISTICS[number];
type EvidenceKind = "test_result" | "benchmark" | "audit";
type Direction = "at_least" | "at_most" | "equal";

interface MetricSpec {
  id: string;
  characteristic: Characteristic;
  statement: string;
  name: string;
  unit: string;
  direction: Direction;
  threshold: number;
  pointer: string;
  risk: string;
  evidenceKind: EvidenceKind;
}

const METRICS: MetricSpec[] = [
  { id: "QR-FS-TOOLS", characteristic: "functional_suitability", statement: "MCP 工具清单必须与冻结发布基线完全一致。", name: "MCP tools", unit: "count", direction: "equal", threshold: 46, pointer: "/metrics/mcp_tools", risk: "R-FUNCTIONAL", evidenceKind: "test_result" },
  { id: "QR-FS-RESOURCES", characteristic: "functional_suitability", statement: "MCP 资源清单必须与冻结发布基线完全一致。", name: "MCP resources", unit: "count", direction: "equal", threshold: 7, pointer: "/metrics/mcp_resources", risk: "R-FUNCTIONAL", evidenceKind: "test_result" },
  { id: "QR-FS-PROMPTS", characteristic: "functional_suitability", statement: "MCP 提示词清单必须与冻结发布基线完全一致。", name: "MCP prompts", unit: "count", direction: "equal", threshold: 5, pointer: "/metrics/mcp_prompts", risk: "R-FUNCTIONAL", evidenceKind: "test_result" },
  { id: "QR-FS-TESTS", characteristic: "functional_suitability", statement: "冻结测试集不得少于 160 项且必须完整执行。", name: "executed tests", unit: "count", direction: "at_least", threshold: 160, pointer: "/metrics/tests_total", risk: "R-FUNCTIONAL", evidenceKind: "test_result" },

  { id: "QR-PE-CAPACITY", characteristic: "performance_efficiency", statement: "容量资格场景必须达到至少 20 GiB。", name: "qualified payload", unit: "GiB", direction: "at_least", threshold: 20, pointer: "/metrics/volume_payload_gib", risk: "R-PERFORMANCE", evidenceKind: "benchmark" },
  { id: "QR-PE-ORACLE", characteristic: "performance_efficiency", statement: "文件系统、SQLite、快照和内容读取 oracle 必须完全一致。", name: "volume oracle", unit: "boolean01", direction: "equal", threshold: 1, pointer: "/metrics/volume_oracle_consistent", risk: "R-PERFORMANCE", evidenceKind: "benchmark" },
  { id: "QR-PE-READ", characteristic: "performance_efficiency", statement: "安全与许可证扫描必须分别读取完整 20 GiB。", name: "full content reads", unit: "boolean01", direction: "equal", threshold: 1, pointer: "/metrics/volume_disk_read_complete", risk: "R-PERFORMANCE", evidenceKind: "benchmark" },
  { id: "QR-PE-RSS", characteristic: "performance_efficiency", statement: "20 GiB 资格场景峰值 RSS 不得超过 1024 MiB。", name: "peak RSS", unit: "MiB", direction: "at_most", threshold: 1024, pointer: "/metrics/volume_peak_rss_mib", risk: "R-PERFORMANCE", evidenceKind: "benchmark" },
  { id: "QR-PE-DURATION", characteristic: "performance_efficiency", statement: "20 GiB 完整资格场景墙钟时间不得超过 3600 秒。", name: "full qualification duration", unit: "seconds", direction: "at_most", threshold: 3600, pointer: "/metrics/volume_total_seconds", risk: "R-PERFORMANCE", evidenceKind: "benchmark" },
  { id: "QR-PE-WARM", characteristic: "performance_efficiency", statement: "20 GiB 暖结构走查不得超过 5 秒。", name: "warm structure walk", unit: "seconds", direction: "at_most", threshold: 5, pointer: "/metrics/volume_warm_walk_seconds", risk: "R-PERFORMANCE", evidenceKind: "benchmark" },
  { id: "QR-PE-STEADY", characteristic: "performance_efficiency", statement: "watcher 稳态结构审计不得超过 1 秒。", name: "steady audit", unit: "seconds", direction: "at_most", threshold: 1, pointer: "/metrics/volume_steady_audit_seconds", risk: "R-PERFORMANCE", evidenceKind: "benchmark" },
  { id: "QR-PE-SNAPSHOT", characteristic: "performance_efficiency", statement: "20 GiB 快照聚合不得超过 3 秒。", name: "snapshot", unit: "seconds", direction: "at_most", threshold: 3, pointer: "/metrics/volume_snapshot_seconds", risk: "R-PERFORMANCE", evidenceKind: "benchmark" },

  { id: "QR-CO-STDIO", characteristic: "compatibility", statement: "限定环境中的 stdio MCP inventory 必须成功且名称唯一。", name: "MCP interoperability", unit: "boolean01", direction: "equal", threshold: 1, pointer: "/metrics/mcp_inventory_ok", risk: "R-COMPATIBILITY", evidenceKind: "test_result" },
  { id: "QR-IN-DOCS", characteristic: "interaction_capability", statement: "用户文档中的工具数量必须与运行时 inventory 一致。", name: "documentation inventory match", unit: "boolean01", direction: "equal", threshold: 1, pointer: "/metrics/documentation_inventory_match", risk: "R-INTERACTION", evidenceKind: "audit" },

  { id: "QR-RE-QUALITY", characteristic: "reliability", statement: "全部质量命令必须执行成功且无 blocked/missing/timeout。", name: "failed quality commands", unit: "count", direction: "equal", threshold: 0, pointer: "/metrics/quality_failed_or_blocked", risk: "R-RELIABILITY", evidenceKind: "test_result" },
  { id: "QR-RE-FAILED", characteristic: "reliability", statement: "冻结测试集失败数必须为零。", name: "failed tests", unit: "count", direction: "equal", threshold: 0, pointer: "/metrics/tests_failed", risk: "R-RELIABILITY", evidenceKind: "test_result" },
  { id: "QR-RE-CANCELLED", characteristic: "reliability", statement: "冻结测试集取消数必须为零。", name: "cancelled tests", unit: "count", direction: "equal", threshold: 0, pointer: "/metrics/tests_cancelled", risk: "R-RELIABILITY", evidenceKind: "test_result" },
  { id: "QR-RE-SKIPPED", characteristic: "reliability", statement: "冻结测试集跳过数必须为零。", name: "skipped tests", unit: "count", direction: "equal", threshold: 0, pointer: "/metrics/tests_skipped", risk: "R-RELIABILITY", evidenceKind: "test_result" },
  { id: "QR-RE-TODO", characteristic: "reliability", statement: "冻结测试集 todo 数必须为零。", name: "todo tests", unit: "count", direction: "equal", threshold: 0, pointer: "/metrics/tests_todo", risk: "R-RELIABILITY", evidenceKind: "test_result" },
  { id: "QR-RE-STABLE", characteristic: "reliability", statement: "测试前后源码树摘要必须完全相同。", name: "source stable during quality run", unit: "boolean01", direction: "equal", threshold: 1, pointer: "/metrics/quality_source_stable", risk: "R-RELIABILITY", evidenceKind: "test_result" },
  { id: "QR-RE-CURRENT", characteristic: "reliability", statement: "质量结果绑定的源码摘要必须等于终验当前源码摘要。", name: "quality source is current", unit: "boolean01", direction: "equal", threshold: 1, pointer: "/metrics/quality_source_matches_current", risk: "R-RELIABILITY", evidenceKind: "test_result" },

  { id: "QR-SE-OPEN", characteristic: "security", statement: "安全台账不得存在 open finding。", name: "open security findings", unit: "count", direction: "equal", threshold: 0, pointer: "/metrics/security_open_total", risk: "R-SECURITY", evidenceKind: "audit" },
  { id: "QR-SE-NOTE", characteristic: "security", statement: "任何已接受安全发现都必须有明确处置理由。", name: "accepted findings without note", unit: "count", direction: "equal", threshold: 0, pointer: "/metrics/security_accepted_without_note", risk: "R-SECURITY", evidenceKind: "audit" },

  { id: "QR-MA-LOC", characteristic: "maintainability", statement: "src 与 scripts 中实现文件不得超过既定 500 行预算。", name: "implementation files over budget", unit: "count", direction: "equal", threshold: 0, pointer: "/metrics/implementation_files_over_500", risk: "R-MAINTAINABILITY", evidenceKind: "audit" },
  { id: "QR-MA-LINES", characteristic: "maintainability", statement: "源代码行覆盖率必须至少为 90%。", name: "line coverage", unit: "percent", direction: "at_least", threshold: 90, pointer: "/metrics/coverage_lines_pct", risk: "R-MAINTAINABILITY", evidenceKind: "test_result" },
  { id: "QR-MA-BRANCH", characteristic: "maintainability", statement: "源代码分支覆盖率必须至少为 85%。", name: "branch coverage", unit: "percent", direction: "at_least", threshold: 85, pointer: "/metrics/coverage_branches_pct", risk: "R-MAINTAINABILITY", evidenceKind: "test_result" },
  { id: "QR-MA-FUNCTION", characteristic: "maintainability", statement: "源代码函数覆盖率必须至少为 90%。", name: "function coverage", unit: "percent", direction: "at_least", threshold: 90, pointer: "/metrics/coverage_functions_pct", risk: "R-MAINTAINABILITY", evidenceKind: "test_result" },

  { id: "QR-FL-LANG", characteristic: "flexibility", statement: "内置 AST provider 必须覆盖 TS、JS、Python、Go、Rust、Java、Kotlin、C#。", name: "built-in AST languages", unit: "count", direction: "at_least", threshold: 8, pointer: "/metrics/built_in_ast_languages", risk: "R-FLEXIBILITY", evidenceKind: "audit" },
  { id: "QR-FL-ASSURANCE", characteristic: "flexibility", statement: "当前声明源码必须 100% 达到 AST 语义保证。", name: "semantic assurance coverage", unit: "percent", direction: "equal", threshold: 100, pointer: "/metrics/semantic_assurance_pct", risk: "R-FLEXIBILITY", evidenceKind: "audit" },
  { id: "QR-FL-RESOLUTION", characteristic: "flexibility", statement: "当前内部引用必须 100% 解析。", name: "internal reference resolution", unit: "percent", direction: "equal", threshold: 100, pointer: "/metrics/internal_resolution_pct", risk: "R-FLEXIBILITY", evidenceKind: "audit" },
  { id: "QR-FL-FALLBACK", characteristic: "flexibility", statement: "严格模式下正则 fallback 文件必须为零。", name: "regex fallback files", unit: "count", direction: "equal", threshold: 0, pointer: "/metrics/fallback_files", risk: "R-FLEXIBILITY", evidenceKind: "audit" },
  { id: "QR-FL-UNRESOLVED", characteristic: "flexibility", statement: "未解析内部引用必须为零。", name: "unresolved references", unit: "count", direction: "equal", threshold: 0, pointer: "/metrics/unresolved_references", risk: "R-FLEXIBILITY", evidenceKind: "audit" },
  { id: "QR-FL-VIOLATIONS", characteristic: "flexibility", statement: "模块边界、循环、owner 和语义证据违规必须为零。", name: "governance violations", unit: "count", direction: "equal", threshold: 0, pointer: "/metrics/governance_violations", risk: "R-FLEXIBILITY", evidenceKind: "audit" },
];

const RISK_DEFINITIONS = {
  "R-FUNCTIONAL": ["功能面遗漏或回归", "release-engineering", "possible", "major", "high", "以运行时 MCP inventory 与完整测试集核对冻结功能面。"],
  "R-PERFORMANCE": ["超大仓库容量或资源失控", "performance-owner", "possible", "major", "high", "以带容量 oracle、RSS 和分阶段时延的 20 GiB 资格证据控制。"],
  "R-COMPATIBILITY": ["stdio 协议面不可用", "protocol-owner", "unlikely", "moderate", "medium", "在限定 Windows/Node 环境真实拉起 server 并枚举协议面。"],
  "R-INTERACTION": ["文档与实际能力漂移", "documentation-owner", "possible", "moderate", "medium", "自动比较文档 inventory 与真实运行时 inventory。"],
  "R-RELIABILITY": ["失败、跳过或源码漂移制造假绿", "quality-owner", "possible", "major", "high", "测试计数、命令状态及测试前后源码树摘要全部机器绑定。"],
  "R-SECURITY": ["未处置发现或无理由接受", "security-owner", "unlikely", "severe", "high", "安全台账要求 open=0，接受项必须留理由并纳入复审。"],
  "R-MAINTAINABILITY": ["低覆盖或巨文件导致回归成本失控", "maintainability-owner", "possible", "moderate", "medium", "执行 90/85/90 覆盖率门槛并执行 500 行预算。"],
  "R-FLEXIBILITY": ["跨语言关系漏报导致错误影响分析", "architecture-owner", "possible", "major", "high", "八语言 AST、100% assurance/resolution、零 fallback/unresolved/violation。"],
} as const;

function evidenceId(kind: EvidenceKind): string {
  return kind === "benchmark" ? "EV-BENCH" : kind === "audit" ? "EV-AUDIT" : "EV-TEST";
}

function testId(requirementId: string): string {
  return `AT-${requirementId.slice(3)}`;
}

function expectedOperator(direction: Direction): "equal" | "at_least" | "at_most" {
  return direction === "equal" ? "equal" : direction;
}

function buildBaseline(createdAt: string): AcceptanceBaselineInput {
  const requirements = METRICS.map((item) => ({
    id: item.id,
    characteristic: item.characteristic,
    statement: item.statement,
    metric: { name: item.name, unit: item.unit, direction: item.direction, threshold: item.threshold, tolerance: 0 },
    measurement_source: { evidence_id: "EV-MEASURE", json_pointer: item.pointer },
    risk_ids: [item.risk],
    test_ids: [testId(item.id)],
  }));
  const tests = METRICS.map((item) => ({
    id: testId(item.id),
    title: `${item.name} machine verification`,
    procedure: `从已哈希 JSON 证据 ${evidenceId(item.evidenceKind)}${item.pointer} 读取值并按冻结阈值比较。`,
    expected_result: `${item.direction} ${item.threshold} ${item.unit}`,
    expected_evidence_kind: item.evidenceKind,
    verification_mode: "automated" as const,
    assertion: { evidence_id: evidenceId(item.evidenceKind), json_pointer: item.pointer, operator: expectedOperator(item.direction), expected: item.threshold },
    requirement_ids: [item.id],
    risk_ids: [item.risk],
  }));
  const risks = Object.entries(RISK_DEFINITIONS).map(([id, definition]) => {
    const linked = METRICS.filter((item) => item.risk === id);
    return {
      id,
      title: definition[0],
      description: `${definition[0]}会使本次限定用途的产品验收结论失真或不可依赖。`,
      owner: definition[1],
      likelihood: definition[2],
      impact: definition[3],
      inherent_level: definition[4],
      treatment: definition[5],
      compensating_controls: ["证据文件 SHA-256 复算", "批准基线不可覆盖", "失败与缺失均 fail-closed"],
      requirement_ids: linked.map((item) => item.id),
      test_ids: linked.map((item) => testId(item.id)),
    };
  });
  return AcceptanceBaselineSchema.parse({
    schema_version: 1,
    baseline_id: "pm-mcp-local-release",
    baseline_version: "1.0.0",
    title: "pm-mcp local product acceptance baseline",
    product: "pm-mcp 0.1.2",
    scope: "First-party product-quality acceptance for pm-mcp as a local stdio MCP service on Windows x64 with Node.js 25.8.1; distributable engine floor remains Node.js 22.13. Includes the implemented project brain, strict AST governance for the declared source tree, quality gates, and the recorded 20 GiB synthetic qualification workload. Excludes hosted CI, production HA/DR, independent certification, safety-critical use, and universal runtime execution claims.",
    created_at: createdAt,
    approval: { status: "draft", approved_by: null, approved_at: null, rationale: null },
    characteristics: ISO_25010_CHARACTERISTICS.map((id) => id === "safety"
      ? { id, applicable: false, tailoring_reason: "This local development-governance tool is not accepted for safety-critical decisions; such use requires a separate hazard analysis and evaluation." }
      : { id, applicable: true, tailoring_reason: null }),
    requirements,
    risks,
    tests,
    evaluation_plan: ISO_25040_STAGES.map((stage) => ({
      stage,
      owner: stage === "execute" ? "quality-owner" : "acceptance-owner",
      objective: `${stage} the bounded product-quality evaluation without changing approved thresholds after execution starts.`,
      entry_criteria: [stage === "define" ? "Product and intended use are identified." : "Previous evaluation stage is complete."],
      activities: [stage === "execute" ? "Run fresh quality gates and collect hash-bound machine evidence." : `Perform and record the ${stage} evaluation activities.`],
      planned_outputs: [stage === "conclude" ? "Immutable JSON, Markdown, and SHA-256 report manifest." : `${stage} stage record and evidence references.`],
      exit_criteria: [stage === "conclude" ? "All findings are computed and the verdict is machine generated." : `${stage} outputs are complete and traceable.`],
    })),
    acceptance_policy: {
      require_all_requirements: true,
      require_all_tests: true,
      require_all_stages: true,
      require_independent_evaluator: false,
      maximum_residual_risk_level: "low",
      authorized_risk_acceptors: ["project-owner", "risk-owner"],
    },
  });
}

const rootIndex = process.argv.indexOf("--root");
const root = rootIndex >= 0 && process.argv[rootIndex + 1] ? path.resolve(process.argv[rootIndex + 1]) : process.cwd();
const createdAt = new Date().toISOString();
const baseline = saveAcceptanceBaseline(root, buildBaseline(createdAt));
console.log(JSON.stringify({
  baseline: `${baseline.baseline_id}@${baseline.baseline_version}`,
  status: baseline.approval.status,
  created_at: baseline.created_at,
  fingerprint_sha256: acceptanceBaselineFingerprint(baseline),
  requirements: baseline.requirements.length,
  risks: baseline.risks.length,
  tests: baseline.tests.length,
}, null, 2));
