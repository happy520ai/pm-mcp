import fs from "node:fs";
import path from "node:path";
import { loadFileNotes, loadProject } from "./store.ts";
import { isTestFile, readDirectDeps } from "./scan.ts";
import { ensureFresh, getIndex, iterateFileRows } from "./index-store.ts";
import { readText } from "./search.ts";
import { foldLines } from "./budget.ts";

/**
 * 法律/许可证账：依赖许可证清单（直接+传递，含 pnpm 布局）、copyleft 冲突、可疑许可证头、来源登记。
 * 离线能力边界：读本地依赖元数据与源码文本，不做外部相似度检索。
 */

const STRONG_COPYLEFT = ["GPL-2.0", "GPL-3.0", "AGPL-3.0", "SSPL-1.0", "GPL", "AGPL", "SSPL"];
const WEAK_COPYLEFT = ["LGPL", "MPL-2.0", "MPL", "EPL", "CDDL", "EUPL", "Sleepycat"];
const PERMISSIVE = ["MIT", "Apache-2.0", "Apache", "BSD-2-Clause", "BSD-3-Clause", "BSD", "ISC", "0BSD", "Unlicense", "Zlib", "Python-2.0", "BSL-1.0"];

/** 单个包最多登记数（巨型依赖树保护；超出部分计数上报） */
const MAX_DEPS = 800;

function classify(license: string): "strong-copyleft" | "weak-copyleft" | "permissive" | "unknown" {
  const l = license.trim();
  if (!l) return "unknown";
  const up = l.toUpperCase();
  if (STRONG_COPYLEFT.some((k) => up.includes(k.toUpperCase()))) {
    // LGPL 不算强 copyleft
    if (up.startsWith("LGPL")) return "weak-copyleft";
    return "strong-copyleft";
  }
  if (WEAK_COPYLEFT.some((k) => up.includes(k.toUpperCase()))) return "weak-copyleft";
  if (PERMISSIVE.some((k) => up === k.toUpperCase() || up.startsWith(k.toUpperCase()))) return "permissive";
  return "unknown";
}

interface DepLicense {
  name: string;
  version: string;
  license: string;
  kind: ReturnType<typeof classify>;
  direct: boolean;
}

function readPkgLicense(pkgFile: string): { version: string; license: string } | null {
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8"));
    const license =
      typeof pkg.license === "string"
        ? pkg.license
        : Array.isArray(pkg.license)
          ? pkg.license.join(" OR ")
          : "";
    return { version: String(pkg.version ?? ""), license };
  } catch {
    return null;
  }
}

/**
 * 盘点已安装依赖许可证：直接 + 传递。
 * 覆盖三种布局：npm/yarn 扁平与嵌套（node_modules/<a>/node_modules/<b>）、
 * pnpm（node_modules/.pnpm/<name>@<ver>/node_modules/<name>，直接依赖是符号链接）。
 */
function readNodeLicenses(root: string): { list: DepLicense[]; truncated: number } {
  const out = new Map<string, DepLicense>();
  const nm = path.join(root, "node_modules");
  let truncated = 0;
  if (!fs.existsSync(nm)) return { list: [], truncated: 0 };
  const direct = new Set(readDirectDeps(root).deps);
  const record = (name: string, pkgDir: string): void => {
    if (out.has(name) || out.size >= MAX_DEPS) {
      if (!out.has(name)) truncated += 1;
      return;
    }
    const meta = readPkgLicense(path.join(pkgDir, "package.json"));
    out.set(name, {
      name,
      version: meta?.version ?? "",
      license: meta?.license ?? "",
      kind: classify(meta?.license ?? ""),
      direct: direct.has(name),
    });
  };
  const isDirLike = (d: fs.Dirent): boolean => d.isDirectory() || d.isSymbolicLink();

  // ① 一层 node_modules（npm/yarn 扁平 + pnpm 的符号链接直接依赖）
  const level1: string[] = [];
  for (const entry of fs.readdirSync(nm, { withFileTypes: true })) {
    if (entry.name === ".pnpm" || entry.name.startsWith(".")) continue;
    if (entry.name.startsWith("@") && isDirLike(entry)) {
      for (const sub of fs.readdirSync(path.join(nm, entry.name), { withFileTypes: true })) {
        if (isDirLike(sub)) level1.push(`${entry.name}/${sub.name}`);
      }
    } else if (isDirLike(entry)) {
      level1.push(entry.name);
    }
  }
  for (const name of level1) record(name, path.join(nm, ...name.split("/")));

  // ② 嵌套依赖（npm2 老布局 / 部分包自带 node_modules）
  for (const name of level1) {
    const nested = path.join(nm, ...name.split("/"), "node_modules");
    if (!fs.existsSync(nested)) continue;
    for (const entry of fs.readdirSync(nested, { withFileTypes: true })) {
      if (entry.name.startsWith("@") && isDirLike(entry)) {
        for (const sub of fs.readdirSync(path.join(nested, entry.name), { withFileTypes: true })) {
          if (isDirLike(sub)) record(`${entry.name}/${sub.name}`, path.join(nested, entry.name, sub.name));
        }
      } else if (isDirLike(entry)) {
        record(entry.name, path.join(nested, entry.name));
      }
    }
  }

  // ③ pnpm 布局：.pnpm/<name>@<version>/node_modules/<name> 覆盖整个依赖树（直接+传递）
  const pnpmDir = path.join(nm, ".pnpm");
  if (fs.existsSync(pnpmDir)) {
    for (const entry of fs.readdirSync(pnpmDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      // 目录名 name@version；@scope/name@version → 包名取到最后一个 @ 前
      const dirName = entry.name;
      const at = dirName.lastIndexOf("@");
      if (at <= 0) continue;
      const pkgName = dirName.slice(0, at);
      if (!pkgName) continue;
      const realDir = path.join(pnpmDir, dirName, "node_modules", ...pkgName.split("/"));
      if (fs.existsSync(path.join(realDir, "package.json"))) record(pkgName, realDir);
    }
  }

  const list = [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
  return { list, truncated };
}

const GPL_HEADER = /GNU (LESSER |AFFERO )?GENERAL PUBLIC LICENSE/i;

export function auditLicense(root: string, maxLines = 150): string {
  const project = loadProject(root);
  const rootPkg = path.join(root, "package.json");
  let pkgLicense = "";
  if (fs.existsSync(rootPkg)) {
    try {
      pkgLicense = String(JSON.parse(fs.readFileSync(rootPkg, "utf8")).license ?? "");
    } catch {
      /* ignore */
    }
  }
  const declared = project.license || pkgLicense;
  const projectKind = classify(declared);

  const L: string[] = [];
  L.push("## 许可证审计");

  /* ① 项目声明 */
  L.push("");
  L.push("### ① 项目声明");
  const hasLicenseFile =
    fs.existsSync(root) &&
    fs.readdirSync(root).some((n) => /^licen[cs]e/i.test(n));
  L.push(
    declared
      ? `- 项目许可证: ${declared}（${label(projectKind)}）`
      : "- ⚠️ 项目未声明许可证（update_project 补充 license 字段）",
  );
  L.push(hasLicenseFile ? "- LICENSE 文件: 存在" : "- ⚠️ 根目录缺少 LICENSE 文件");

  /* ② 依赖清单（直接 + 传递，含 pnpm 布局） */
  L.push("");
  const { list: licenses, truncated } = readNodeLicenses(root);
  const directList = licenses.filter((d) => d.direct);
  const transitiveList = licenses.filter((d) => !d.direct);
  L.push(`### ② 依赖许可证清单（直接 ${directList.length} + 传递 ${transitiveList.length}）`);
  const conflicts: string[] = [];
  const unknowns: string[] = [];
  const emit = (d: DepLicense): void => {
    const tag = d.direct ? "" : "（传递）";
    if (d.kind === "strong-copyleft") {
      conflicts.push(`🔴 ${d.name}@${d.version} [${d.license || "?"}] 强 copyleft${tag}`);
    } else if (d.kind === "unknown") {
      unknowns.push(d.name + tag);
    } else if (d.kind === "weak-copyleft") {
      L.push(`🟡 ${d.name}@${d.version} [${d.license}] 弱 copyleft（注意按文件级义务使用）${tag}`);
    } else {
      L.push(`🟢 ${d.name}@${d.version} [${d.license}]${tag}`);
    }
  };
  if (licenses.length === 0) {
    L.push("- （未发现已安装的 JS 依赖）");
  }
  for (const d of directList) emit(d);
  for (const d of transitiveList.slice(0, 60)) emit(d);
  if (transitiveList.length > 60) L.push(`…另有 ${transitiveList.length - 60} 个传递依赖未逐条列出（详见 node_modules）`);
  if (truncated > 0) L.push(`⚪ 依赖树超过 ${MAX_DEPS} 个，${truncated} 个未逐条登记`);
  for (const c of conflicts) L.push(c);
  if (unknowns.length > 0) L.push(`⚪ 许可证未知（需人工审查）: ${unknowns.slice(0, 20).join(", ")}`);
  const declaredDeps = readDirectDeps(root).deps;
  const foundNames = new Set(licenses.map((l) => l.name));
  const missing = declaredDeps.filter((n) => !foundNames.has(n));
  if (missing.length > 0) {
    const hasPy = fs.existsSync(path.join(root, "requirements.txt"));
    L.push(
      `⚪ 已声明但未在 node_modules 找到 ${missing.length} 个（未安装或元数据缺失${hasPy ? "；Python 依赖离线无法取许可证，需人工审查" : ""}）: ${missing.slice(0, 10).join(", ")}`,
    );
  }
  if (conflicts.length > 0 && (projectKind === "permissive" || declared === "")) {
    L.push("");
    L.push(`- 🚩 项目按 ${declared || "专有"} 分发，但存在强 copyleft 依赖（含传递）。若闭源/专有分发，GPL/AGPL/SSPL 依赖会触发开源义务——请确认链接方式或替换依赖，必要时咨询法务。`);
  }

  /* ③ 可疑许可证头 */
  L.push("");
  L.push("### ③ 源码中的 GPL 家族许可证头（复制带许可证代码的常见痕迹）");
  ensureFresh(root);
  const hits: string[] = [];
  for (const row of iterateFileRows(getIndex(root))) {
    const rel = row.rel;
    if (rel.startsWith(".pm/")) continue;
    // 测试文件常内嵌许可证字符串作为 fixture，不参与该启发式（信号针对混入源码的复制代码）
    if (isTestFile(rel)) continue;
    const content = readText(root, rel);
    if (content === null) continue;
    if (GPL_HEADER.test(content.split("\n").slice(0, 40).join("\n"))) hits.push(rel);
    if (hits.length >= 10) break;
  }
  if (hits.length === 0) L.push("- ✅ 未在前 40 行发现 GPL 家族许可证头。");
  else {
    for (const h of hits) L.push(`- 🔴 ${h}：包含 GPL 家族许可证文本，疑似复制自 copyleft 项目——确认来源与义务，或用 annotate_file 登记来源。`);
  }

  /* ④ 来源登记 */
  L.push("");
  L.push("### ④ 来源登记（provenance）");
  const notes = loadFileNotes(root).notes;
  const sourced = Object.entries(notes).filter(([, n]) => n.source || n.license);
  if (sourced.length === 0) {
    L.push("- （暂无来源登记。引用外部代码时用 annotate_file 登记 source 与 license，纠纷时说得清代码从哪来。）");
  } else {
    for (const [file, n] of sourced.slice(0, 10)) {
      L.push(`- ${file}: ${n.source || "未填来源"}${n.license ? ` [${n.license}]` : ""}`);
    }
  }

  L.push("");
  L.push("> 边界说明：本审计是离线启发式（依赖元数据 + 文本头检测），不能检测「AI 复读受版权代码」本身，也不替代法务意见。");
  return foldLines(L, { maxLines, hint: "冲突项优先，可用 update_project 声明许可证后重扫" });
}

function label(kind: ReturnType<typeof classify>): string {
  switch (kind) {
    case "strong-copyleft":
      return "强 copyleft";
    case "weak-copyleft":
      return "弱 copyleft";
    case "permissive":
      return "宽松";
    default:
      return "未知";
  }
}
