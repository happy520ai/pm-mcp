import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { auditSecurity, listFindings, prepareSecurityAudit, resolveFinding } from "../src/security.ts";
import { initTestProject, mkProj, readRel, rmRel, writeRel } from "./helpers.ts";

const AWS_KEY = "AKIA" + "IOSFODNN7EXAMPLE"; // AWS 官方文档示例值，非真实密钥
const FAKE_OPENAI = "sk-" + "abcdef1234567890abcdef1234567890";
const FAKE_GITHUB = "ghp_" + "a".repeat(24);
const FAKE_GOOGLE = "AIza" + "A".repeat(35);
const FAKE_SLACK = "xoxb-" + "1234567890-abcdefghijklmnop";
const FAKE_PRIVATE_KEY_HEADER = "-----BEGIN " + "PRIVATE KEY-----";
const FAKE_PASSWORD = "not-a-real-password-value";

test("安全扫描检出密钥/危险模式/.env，且台账绝不落明文", () => {
  const root = mkProj({
    "src/leak.ts": [
      `export const aws = "${AWS_KEY}";`,
      `const openai = "${FAKE_OPENAI}";`,
      `const github = "${FAKE_GITHUB}";`,
      `const google = "${FAKE_GOOGLE}";`,
      `const slack = "${FAKE_SLACK}";`,
      `const pem = "${FAKE_PRIVATE_KEY_HEADER}";`,
      `const password = "${FAKE_PASSWORD}";`,
      "",
    ].join("\n"),
    "src/bad.ts": `const r = eval(userInput);\nawait fetch(u, { rejectUnauthorized: false });\n`,
    "src/py.py": `import requests\nrequests.get(url, verify=False)\n`,
    ".env": `API_KEY=${AWS_KEY}\n`,
    ".env.example": `API_KEY=your_key_here\n`,
  });
  initTestProject(root);
  const report = auditSecurity(root);
  assert.ok(report.openCount >= 4, `应有多个发现，实际 ${report.openCount}`);
  assert.ok(report.highCount >= 2, "AWS key / verify=False 至少两个高危");
  const rules = new Set(listFindings(root, "open").map((f) => f.rule));
  for (const expected of [
    "secret.aws-access-key",
    "secret.github-token",
    "secret.openai-key",
    "secret.google-api",
    "secret.slack-token",
    "secret.private-key",
    "secret.generic-assignment",
  ]) {
    assert.ok(rules.has(expected), `扫描应检出内置秘密规则 ${expected}`);
  }

  // 红线：台账文件里绝不能出现命中明文
  const ledger = readRel(root, ".pm/security.json");
  for (const secret of [AWS_KEY, FAKE_OPENAI, FAKE_GITHUB, FAKE_GOOGLE, FAKE_SLACK, FAKE_PRIVATE_KEY_HEADER, FAKE_PASSWORD]) {
    assert.ok(!ledger.includes(secret), `台账不得含秘密明文: ${secret.slice(0, 8)}...`);
  }
  assert.ok(!ledger.includes("verify=False"), "台账只存规则与位置，不存代码行");
});

test("重复扫描幂等（指纹去重），新增不重复计数", () => {
  const root = mkProj({ "src/leak.ts": `const k = "${AWS_KEY}";\n` });
  initTestProject(root);
  const r1 = auditSecurity(root);
  const r2 = auditSecurity(root);
  assert.equal(r2.newFindings, 0, "第二次不应有新发现");
  assert.equal(listFindings(root, "open").length, listFindings(root).filter((f) => f.status === "open").length);
  assert.equal(r1.openCount, r2.openCount);
});

test("泄露移除后重扫自动关闭", () => {
  const root = mkProj({ "src/leak.ts": `const k = "${AWS_KEY}";\n` });
  initTestProject(root);
  auditSecurity(root);
  rmRel(root, "src/leak.ts");
  const r2 = auditSecurity(root);
  assert.equal(r2.openCount, 0);
  assert.ok(r2.autoFixed >= 1, "应自动关闭");
  assert.ok(listFindings(root, "fixed").length >= 1);
});

test("接受风险必须留理由", () => {
  const root = mkProj({ "src/leak.ts": `const k = "${AWS_KEY}";\n` });
  initTestProject(root);
  auditSecurity(root);
  const first = listFindings(root, "open")[0];
  assert.throws(() => resolveFinding(root, first.id, "accepted", ""), /必须填写理由/);
  const f = resolveFinding(root, first.id, "accepted", "本地示例文件，不进入构建");
  assert.equal(f.status, "accepted");
});

test("处置理由复用全部内置秘密规则，拒绝后不写台账", () => {
  const root = mkProj({ "src/leak.ts": `const k = "${AWS_KEY}";\n` });
  initTestProject(root);
  auditSecurity(root);
  const first = listFindings(root, "open")[0];
  const secretNotes = [
    AWS_KEY,
    FAKE_GITHUB,
    FAKE_OPENAI,
    FAKE_GOOGLE,
    FAKE_SLACK,
    FAKE_PRIVATE_KEY_HEADER,
    `password = "${FAKE_PASSWORD}"`,
    `token = "<redacted-value>", password = "${FAKE_PASSWORD}"`,
  ];

  for (const secretNote of secretNotes) {
    assert.throws(
      () => resolveFinding(root, first.id, "accepted", `接受理由：${secretNote}`),
      /不得包含密钥形态明文/,
    );
  }

  const ledger = readRel(root, ".pm/security.json");
  for (const secretNote of secretNotes) {
    assert.ok(!ledger.includes(secretNote), "被拒绝的处置理由不得写入台账");
  }
  assert.equal(listFindings(root, "open")[0].status, "open", "拒绝秘密 note 后不得改变发现状态");

  const accepted = resolveFinding(
    root,
    first.id,
    "accepted",
    '测试夹具仅使用 token = "<redacted-value>"，真实凭据未写入台账',
  );
  assert.equal(accepted.status, "accepted", "明确脱敏的占位符理由不应误拒");
});

test("占位符值不误报", () => {
  const root = mkProj({
    "src/config.ts": `const apiKey = process.env.API_KEY;\nconst token = "<your-token-here>";\nconst secret2 = "example_secret_value";\n`,
  });
  initTestProject(root);
  const r = auditSecurity(root);
  const openRules = listFindings(root, "open").map((f) => f.rule);
  assert.deepEqual(openRules, [], `占位符不应报密钥，实际: ${openRules.join(",")}`);
  assert.equal(r.openCount, 0);
});

test("新增依赖与幻觉版本号进入报告", () => {
  const root = mkProj({
    "package.json": JSON.stringify({
      name: "x",
      dependencies: { leftpad: "*", fresh: "^1.0.0" },
    }),
  });
  initTestProject(root);
  const r = auditSecurity(root);
  assert.ok(r.riskyDeps.some((d) => d.includes("leftpad")), "* 版本被点名");
});

test("强制安全审计不被相同 mtime/size 的内容替换与进程缓存欺骗", () => {
  const malicious = `export const x = "${AWS_KEY}";\n`;
  const benign = `export const x = "${"x".repeat(AWS_KEY.length)}";\n`;
  const root = mkProj({ "src/swap.ts": benign });
  initTestProject(root);
  assert.equal(auditSecurity(root).openCount, 0);
  const file = path.join(root, "src", "swap.ts");
  const original = fs.statSync(file).mtime;
  fs.writeFileSync(file, malicious, "utf8");
  fs.utimesSync(file, original, original);
  assert.equal(fs.statSync(file).size, Buffer.byteLength(benign));

  const forced = auditSecurity(root, prepareSecurityAudit(root));
  assert.ok(forced.openCount >= 1);
  assert.ok(listFindings(root, "open").some((finding) => finding.rule === "secret.aws-access-key"));
});
