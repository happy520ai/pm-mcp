import { relative as pathRelative } from "node:path";

/**
 * token 经济：读类工具输出硬预算。
 * 超出预算自动折叠为 "Top N + 另有 M 项已折叠"，引导模型用过滤参数缩小范围。
 */

export interface FoldOptions {
  /** 最大输出行数 */
  maxLines: number;
  /** 折叠提示语 */
  hint?: string;
}

/** 限制字符串单行长度，超长截断（防止一行巨长文件吃 token） */
export function capLine(line: string, maxChars = 300): string {
  if (line.length <= maxChars) return line;
  return line.slice(0, maxChars) + "…";
}

/**
 * 把行数组折叠到预算内。
 * 保留前 keep + 后 tail 行，中间折叠；行数少时原样返回。
 */
export function foldLines(lines: string[], opts: FoldOptions): string {
  const { maxLines, hint } = opts;
  const capped = lines.map((l) => capLine(l));
  if (capped.length <= maxLines) return capped.join("\n");
  const keep = Math.max(1, Math.floor(maxLines * 0.8));
  const tail = Math.max(0, maxLines - keep - 1);
  const hidden = capped.length - keep - tail;
  const parts = capped.slice(0, keep);
  parts.push(
    `…（另有 ${hidden} 项已折叠${hint ? "，" + hint : ""}，请用过滤参数缩小范围）`,
  );
  if (tail > 0) parts.push(...capped.slice(-tail));
  return parts.join("\n");
}

/** 对整段文本按行折叠 */
export function foldText(text: string, maxLines: number, hint?: string): string {
  return foldLines(text.split("\n"), { maxLines, hint });
}

/** 简易 glob → RegExp：支持 * ** ?（路径分隔符统一为 / 后匹配） */
export function globToRegExp(pattern: string): RegExp {
  const normalized = pattern.replace(/\\/g, "/").replace(/^\.\//, "");
  let re = "";
  let i = 0;
  while (i < normalized.length) {
    const ch = normalized[i];
    if (ch === "*") {
      if (normalized[i + 1] === "*") {
        // ** 跨目录
        re += ".*";
        i += 2;
        if (normalized[i] === "/") i += 1;
      } else {
        re += "[^/]*";
        i += 1;
      }
    } else if (ch === "?") {
      re += "[^/]";
      i += 1;
    } else if ("/.$^+()[]{}|".includes(ch)) {
      re += "\\" + ch;
      i += 1;
    } else {
      re += ch;
      i += 1;
    }
  }
  return new RegExp("^" + re + "$");
}

/** 规范化相对路径分隔符（Windows 反斜杠 → /） */
export function normSep(p: string): string {
  return p.replace(/\\/g, "/");
}

export function toRel(root: string, abs: string): string {
  return normSep(pathRelative(root, abs));
}
