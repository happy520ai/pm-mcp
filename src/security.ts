import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { loadExtraRules, loadProject, loadSecurity, saveSecurity } from "./store.ts";
import { latestSnapshot } from "./audit.ts";
import { readDirectDeps } from "./scan.ts";
import { ensureFresh, getIndex, iterateFileRows, walkRefresh } from "./index-store.ts";
import { readText } from "./search.ts";
import { now, type Finding, type Severity } from "./types.ts";

/**
 * 安全体检：密钥泄露 / 危险模式 / 依赖风险 → 台账闭环。
 * 只读本地代码，不联网；台账绝不存命中明文（只存 file:line + 规则 + 指纹）。
 */

export interface Rule {
  id: string;
  severity: Severity;
  pattern: RegExp;
  message: string;
  /** 只扫匹配这些 glob 的文件（缺省全部文本文件） */
  glob?: RegExp;
}

const SECRET_PATTERNS: Rule[] = [
  { id: "secret.aws-access-key", severity: "high", pattern: /AKIA[0-9A-Z]{16}/, message: "疑似 AWS Access Key" },
  { id: "secret.github-token", severity: "high", pattern: /gh[pousr]_[A-Za-z0-9]{20,}/, message: "疑似 GitHub Token" },
  { id: "secret.openai-key", severity: "high", pattern: /sk-[A-Za-z0-9_-]{24,}/, message: "疑似 OpenAI/兼容平台 API Key" },
  { id: "secret.google-api", severity: "high", pattern: /AIza[0-9A-Za-z_-]{35}/, message: "疑似 Google API Key" },
  { id: "secret.slack-token", severity: "high", pattern: /xox[baprs]-[0-9A-Za-z-]{10,}/, message: "疑似 Slack Token" },
  {
    id: "secret.private-key",
    severity: "high",
    pattern: /-----BEGIN (RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/,
    message: "内联私钥",
  },
  {
    id: "secret.generic-assignment",
    severity: "medium",
    pattern: /\b(api[_-]?key|apikey|secret|token|password|passwd)\b\s*[:=]\s*["'][^"'\s]{10,}["']/i,
    message: "疑似硬编码凭据赋值",
  },
];

const DANGEROUS_PATTERNS: Rule[] = [
  { id: "danger.eval", severity: "medium", pattern: /\beval\s*\(/, message: "eval() 动态执行（注入风险）", glob: /\.(js|ts|mjs|cjs|jsx|tsx)$/ },
  { id: "danger.new-function", severity: "medium", pattern: /new\s+Function\s*\(/, message: "new Function() 动态执行", glob: /\.(js|ts|mjs|cjs|jsx|tsx)$/ },
  { id: "danger.exec-sync", severity: "medium", pattern: /exec(ution)?Sync\s*\(/, message: "execSync 同步执行命令", glob: /\.(js|ts|mjs|cjs|jsx|tsx)$/ },
  { id: "danger.tls-disabled", severity: "high", pattern: /rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*["']?0/, message: "禁用 TLS 证书校验", glob: /\.(js|ts|mjs|cjs|jsx|tsx)$/ },
  { id: "danger.cors-wildcard", severity: "medium", pattern: /cors\s*\(\s*\{\s*origin\s*:\s*["']\*["']/, message: "CORS 通配放开", glob: /\.(js|ts|mjs|cjs|jsx|tsx)$/ },
  { id: "danger.sql-concat", severity: "high", pattern: /(select|insert\s+into|update|delete\s+from)\b[^;"'`]*("\s*\+|'\s*\+|\$\{|%\s*\(|f")/i, message: "SQL 与字符串拼接/插值（注入风险）", glob: /\.(js|ts|mjs|cjs|jsx|tsx|py)$/ },
  { id: "danger.innerhtml", severity: "medium", pattern: /\.innerHTML\s*=|document\.write\s*\(/, message: "直接写 innerHTML（XSS 风险）", glob: /\.(js|ts|mjs|cjs|jsx|tsx)$/ },
  { id: "danger.python-exec", severity: "medium", pattern: /\beval\s*\(|\bexec\s*\(/, message: "Python eval/exec 动态执行", glob: /\.py$/ },
  { id: "danger.python-shell-true", severity: "high", pattern: /shell\s*=\s*True/, message: "subprocess shell=True（注入风险）", glob: /\.py$/ },
  { id: "danger.python-pickle", severity: "medium", pattern: /pickle\.loads?\s*\(|yaml\.load\s*\((?![^)]*Loader)/, message: "不安全反序列化（pickle/yaml.load）", glob: /\.py$/ },
  { id: "danger.python-tls-off", severity: "high", pattern: /verify\s*=\s*False|CERT_NONE/, message: "禁用 TLS 证书校验", glob: /\.py$/ },
  { id: "danger.flask-debug", severity: "low", pattern: /app\.run\s*\([^)]*debug\s*=\s*True/, message: "Flask 生产开启 debug", glob: /\.py$/ },
];

/** 占位符判定：避免把示例/模板值当泄露 */
function looksPlaceholder(value: string): boolean {
  return /process\.env|os\.environ|\$\{|<[^>]+>|^\$\{|xxx|your[_-]|example|sample|template|changeme|change_me|placeholder|\{\{/i.test(
    value,
  );
}

function shouldIgnoreSecretMatch(rule: Rule, matched: string): boolean {
  return rule.id === "secret.generic-assignment" && looksPlaceholder(matched);
}

function findRelevantMatch(rule: Rule, value: string): RegExpMatchArray | undefined {
  const flags = rule.pattern.flags.includes("g") ? rule.pattern.flags : `${rule.pattern.flags}g`;
  const pattern = new RegExp(rule.pattern.source, flags);
  for (const match of value.matchAll(pattern)) {
    if (shouldIgnoreSecretMatch(rule, match[0])) continue;
    return match;
  }
  return undefined;
}

/**
 * 处置理由与代码扫描共用同一套内置秘密规则，避免新增规则后 note 校验漏防。
 * 占位符沿用扫描口径，允许说明已脱敏的示例值。
 */
function findSecretRule(value: string): Rule | undefined {
  for (const rule of SECRET_PATTERNS) {
    if (findRelevantMatch(rule, value)) return rule;
  }
  return undefined;
}

function fingerprint(ruleId: string, rel: string, matched: string): string {
  return createHash("sha1").update(ruleId + "|" + rel + "|" + matched).digest("hex").slice(0, 16);
}

interface Detection {
  rule: string;
  severity: Severity;
  file: string;
  line: number;
  fingerprint: string;
  message: string;
}

function scanDetections(root: string, forceContent = false, indexPrepared = false): Detection[] {
  const out: Detection[] = [];
  const rules: Rule[] = [...SECRET_PATTERNS, ...DANGEROUS_PATTERNS];
  // 用户自定义规则
  for (const r of loadExtraRules(root).rules) {
    try {
      rules.push({
        id: r.id,
        severity: r.severity,
        pattern: new RegExp(r.pattern, "i"),
        message: r.message || `自定义规则 ${r.id}`,
        glob: r.glob ? new RegExp(r.glob) : undefined,
      });
    } catch {
      /* 非法自定义规则跳过 */
    }
  }

  if (!indexPrepared) ensureFresh(root);
  const db = getIndex(root);
  // .env 类文件存在性检查（是否被 git 提交需人工确认）
  for (const row of iterateFileRows(db, { excludeOversize: false })) {
    const base = row.rel.split("/").pop() ?? "";
    if (/^\.env(\.[^./]+)?$/.test(base) && !/example|sample|template/i.test(base)) {
      out.push({
        rule: "secret.env-file",
        severity: "medium",
        file: row.rel,
        line: 1,
        fingerprint: fingerprint("secret.env-file", row.rel, base),
        message: "存在 .env 类文件——确认未被提交且已在 .gitignore",
      });
    }
  }
  for (const row of iterateFileRows(db)) {
    const rel = row.rel;
    if (row.oversize === 1) continue;
    if (rel.startsWith(".pm/")) continue;
    const content = readText(root, rel, forceContent);
    if (content === null) continue;
    const lines = content.split("\n");
    for (const rule of rules) {
      if (rule.glob && !rule.glob.test(rel)) continue;
      for (let i = 0; i < lines.length; i++) {
        const m = findRelevantMatch(rule, lines[i]);
        if (!m) continue;
        const matched = m[0];
        out.push({
          rule: rule.id,
          severity: rule.severity,
          file: rel,
          line: i + 1,
          fingerprint: fingerprint(rule.id, rel, matched),
          message: rule.message,
        });
      }
    }
  }
  return out;
}

export interface SecurityReport {
  newFindings: number;
  openCount: number;
  highCount: number;
  autoFixed: number;
  newDeps: string[];
  riskyDeps: string[];
  text: string[];
}

export interface PreparedSecurityAudit {
  detections: Detection[];
}

/** 昂贵的全仓扫描阶段；调用方可在账本锁外完成，再把脱敏发现提交到账本。 */
export function prepareSecurityAudit(
  root: string,
  options: { forceIndex?: boolean; forceContent?: boolean; indexPrepared?: boolean } = {},
): PreparedSecurityAudit {
  const forceIndex = options.forceIndex ?? true;
  const forceContent = options.forceContent ?? true;
  if (forceIndex) walkRefresh(root, { forceContent: true });
  return { detections: scanDetections(root, forceContent, forceIndex || options.indexPrepared === true) };
}

/** 扫描并更新台账（幂等：重复扫描不产生重复条目） */
export function auditSecurity(root: string, prepared?: PreparedSecurityAudit): SecurityReport {
  const project = loadProject(root);
  const stamp = now();
  const detections = prepared?.detections ?? scanDetections(root);
  const security = loadSecurity(root);
  const existing = new Map(security.findings.map((f) => [f.fingerprint, f]));
  const acceptedRefound: Finding[] = [];
  const seen = new Set<string>();
  let seq = security.findings.reduce((m, f) => {
    const n = Number(f.id.replace("SEC-", ""));
    return Math.max(m, n);
  }, 0);

  for (const d of detections) {
    seen.add(d.fingerprint);
    const old = existing.get(d.fingerprint);
    if (old) {
      old.last_seen = stamp;
      // 钻空子防线：标了 fixed 却又检出 → 重开（fixed 不是免死金牌）
      if (old.status === "fixed") {
        old.status = "open";
        old.note += "（自动：曾标记 fixed 但再次检出，已重开）";
      } else if (old.status === "accepted") {
        acceptedRefound.push(old);
      }
    } else {
      seq += 1;
      security.findings.push({
        id: `SEC-${String(seq).padStart(3, "0")}`,
        rule: d.rule,
        severity: d.severity,
        file: d.file,
        line: d.line,
        fingerprint: d.fingerprint,
        status: "open",
        note: d.message,
        first_seen: stamp,
        last_seen: stamp,
      });
    }
  }

  // 不再检出且仍 open 的 → 自动转 fixed（附注说明）
  let autoFixed = 0;
  for (const f of security.findings) {
    if (f.status === "open" && !seen.has(f.fingerprint)) {
      f.status = "fixed";
      f.note += "（自动：最近一次扫描未再检出）";
      autoFixed += 1;
    }
  }
  security.last_scan = stamp;
  saveSecurity(root, security);

  // 依赖风险（新增依赖 + 幻觉易发版本号）
  const { depSpecs } = readDirectDeps(root);
  const prev = latestSnapshot(root);
  const prevDeps = prev?.deps ?? [];
  const newDeps = prev ? depSpecs.map((d) => d.name).filter((n) => !prevDeps.includes(n)) : [];
  const riskyDeps = depSpecs.filter((d) => d.risky).map((d) => `${d.name}@${d.version}`);

  const fresh = security.findings.filter((f) => f.first_seen === stamp && f.status === "open");
  const open = security.findings.filter((f) => f.status === "open");
  const high = open.filter((f) => f.severity === "high");

  const L: string[] = [];
  L.push(`## 安全体检报告（exposure=${project.exposure}）`);
  // exposure 兑现：不同暴露面使用不同处置口径
  if (project.exposure === "public") {
    const mustFix = open.filter((f) => f.severity === "high" || f.severity === "medium");
    L.push(
      `🚨 项目面向公网：中危及以上均须处置。需处置 ${mustFix.length} 个（高危 ${high.length}，中危 ${open.filter((f) => f.severity === "medium").length}；低危可带理由接受）。`,
    );
  } else if (project.exposure === "network") {
    L.push(
      `项目面向网络：高危须处置。未处理 ${open.length} 个（高危 ${high.length}，中危 ${open.filter((f) => f.severity === "medium").length}，低危 ${open.filter((f) => f.severity === "low").length}）。`,
    );
  } else {
    L.push(
      open.length === 0
        ? "✅ 当前无未处理安全发现（本地工具：低危可带理由接受）。"
        : `未处理发现 ${open.length} 个（高危 ${high.length}，中危 ${open.filter((f) => f.severity === "medium").length}，低危 ${open.filter((f) => f.severity === "low").length}）。`,
    );
  }
  if (fresh.length > 0) {
    L.push("");
    L.push(`本次扫描新发现 ${fresh.length} 个:`);
    for (const f of fresh.slice(0, 15)) {
      L.push(`- [${f.severity.toUpperCase()}] ${f.file}:${f.line} ${f.rule} — ${f.note}`);
    }
  }
  if (acceptedRefound.length > 0) {
    L.push("");
    L.push(`⚠️ 已接受的风险再次检出 ${acceptedRefound.length} 个（接受≠永久免疫，请复核）:`);
    for (const f of acceptedRefound.slice(0, 10)) {
      L.push(`- ${f.id} ${f.file}:${f.line} ${f.rule}`);
    }
  }
  if (autoFixed > 0) L.push(`自动关闭 ${autoFixed} 个（代码中已不再出现）。`);
  if (newDeps.length > 0) L.push(`⚠️ 上次快照后新增依赖: ${newDeps.join(", ")}（AI 引入的依赖请审查来源与必要性）`);
  if (riskyDeps.length > 0) L.push(`⚠️ 幻觉易发版本号（* / latest）: ${riskyDeps.join(", ")}`);
  L.push("");
  L.push("处理方式：修复后重扫自动关闭；`resolve_finding` 可带理由接受风险（accepted 必须留 note）。");

  return {
    newFindings: fresh.length,
    openCount: open.length,
    highCount: high.length,
    autoFixed,
    newDeps,
    riskyDeps,
    text: L,
  };
}

export function listFindings(root: string, status?: "open" | "fixed" | "accepted"): Finding[] {
  const all = loadSecurity(root).findings;
  return status ? all.filter((f) => f.status === status) : all;
}

export function resolveFinding(root: string, id: string, status: "fixed" | "accepted", note: string): Finding {
  const security = loadSecurity(root);
  const f = security.findings.find((x) => x.id === id);
  if (!f) throw new Error(`找不到安全发现 ${id}，用 list_findings 查看现有条目。`);
  const cleanNote = note.trim();
  if (status === "accepted" && !cleanNote) {
    throw new Error("接受风险必须填写理由（note）：接受是显式选择，要留痕。");
  }
  const secretRule = findSecretRule(cleanNote);
  if (secretRule) {
    throw new Error(
      `note 不得包含密钥形态明文（命中 ${secretRule.id}）——描述风险时引用位置与规则即可，绝不复述凭据本身。`,
    );
  }
  f.status = status;
  if (cleanNote) f.note = cleanNote;
  saveSecurity(root, security);
  return f;
}
