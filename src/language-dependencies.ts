import fs from "node:fs";
import path from "node:path";

export interface DependencyRef {
  name: string;
  version: string;
  scope: string;
  sourceManifest: string;
  parser: string;
  confidence: number;
}

export interface DependencyParseError {
  sourceManifest: string;
  parser: string;
  message: string;
  line?: number;
}

export interface DependencyManifest {
  kind: "node" | "python" | "go" | "rust" | "maven" | "gradle" | "dotnet";
  path: string;
}

export interface DependencyParseResult {
  dependencies: DependencyRef[];
  dependencyErrors: DependencyParseError[];
}

function result(): DependencyParseResult {
  return { dependencies: [], dependencyErrors: [] };
}

function ref(
  manifest: DependencyManifest, parser: string, confidence: number,
  name: string, version: string, scope: string,
): DependencyRef {
  return { name: name.trim(), version: version.trim() || "*", scope, sourceManifest: manifest.path, parser, confidence };
}

function error(
  manifest: DependencyManifest, parser: string, message: string, line?: number,
): DependencyParseError {
  return { sourceManifest: manifest.path, parser, message, ...(line === undefined ? {} : { line }) };
}

function readJson(file: string): Record<string, unknown> {
  const value: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("JSON root is not an object");
  return value as Record<string, unknown>;
}

function nodeDependencies(manifest: DependencyManifest): DependencyParseResult {
  const parser = "package-json", out = result();
  let pkg: Record<string, unknown>;
  try { pkg = readJson(manifest.path); }
  catch (cause) {
    out.dependencyErrors.push(error(manifest, parser, `invalid package.json: ${cause instanceof Error ? cause.message : String(cause)}`));
    return out;
  }
  const sections: Array<[string, string]> = [
    ["dependencies", "runtime"], ["devDependencies", "development"],
    ["optionalDependencies", "optional"], ["peerDependencies", "peer"],
  ];
  for (const [section, scope] of sections) {
    const value = pkg[section];
    if (value === undefined) continue;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      out.dependencyErrors.push(error(manifest, parser, `${section} must be an object`));
      continue;
    }
    for (const [name, version] of Object.entries(value as Record<string, unknown>)) {
      if (!name.trim() || typeof version !== "string" || !version.trim()) {
        out.dependencyErrors.push(error(manifest, parser, `cannot parse ${section} entry ${name || "<empty>"}`));
      } else out.dependencies.push(ref(manifest, parser, 1, name, version, scope));
    }
  }
  return out;
}

function pep508(value: string): { name: string; version: string } | null {
  const base = value.split(/\s*;\s*/, 1)[0].trim();
  const direct = base.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]]+\])?\s*@\s*(\S.+)$/);
  if (direct) return { name: direct[1], version: `@ ${direct[2].trim()}` };
  const match = base.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]]+\])?\s*((?:(?:===|==|~=|!=|<=|>=|<|>)\s*[^,\s]+(?:\s*,\s*)?)*)$/);
  return match ? { name: match[1], version: match[2].replace(/\s+/g, "") || "*" } : null;
}

function requirementsDependencies(manifest: DependencyManifest): DependencyParseResult {
  const parser = "requirements-regex", out = result();
  const scope = /(?:dev|test)/i.test(path.basename(manifest.path)) ? "development" : "runtime";
  fs.readFileSync(manifest.path, "utf8").split(/\r?\n/).forEach((raw, index) => {
    const line = raw.replace(/\s+#.*$/, "").trim();
    if (!line || line.startsWith("#") || line.startsWith("-")) return;
    const parsed = pep508(line);
    if (parsed) out.dependencies.push(ref(manifest, parser, 0.9, parsed.name, parsed.version, scope));
    else out.dependencyErrors.push(error(manifest, parser, "unparsed requirement entry", index + 1));
  });
  return out;
}

interface TomlSection { name: string; body: string; startLine: number }
function tomlSections(text: string): TomlSection[] {
  const sections: TomlSection[] = [];
  let current: TomlSection = { name: "", body: "", startLine: 1 };
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const header = line.match(/^\s*\[([^\]]+)\]\s*(?:#.*)?$/);
    if (header) { sections.push(current); current = { name: header[1].trim(), body: "", startLine: index + 2 }; }
    else current.body += line + "\n";
  }
  sections.push(current);
  return sections;
}

function stringArray(body: string, key: string): { values: string[]; malformed: boolean } | null {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const start = new RegExp(`^\\s*${escapedKey}\\s*=\\s*\\[`, "m").exec(body);
  if (!start) return null;
  const open = start.index + start[0].lastIndexOf("[");
  let quote = "", escaped = false, close = -1;
  for (let i = open + 1; i < body.length; i++) {
    const char = body[i];
    if (escaped) { escaped = false; continue; }
    if (quote === '"' && char === "\\") { escaped = true; continue; }
    if (char === '"' || char === "'") { if (!quote) quote = char; else if (quote === char) quote = ""; continue; }
    if (!quote && char === "]") { close = i; break; }
  }
  if (close < 0) return { values: [], malformed: true };
  const inner = body.slice(open + 1, close), values: string[] = [];
  const token = /"((?:\\.|[^"\\])*)"|'([^']*)'/g;
  let match: RegExpExecArray | null;
  while ((match = token.exec(inner))) {
    if (match[1] !== undefined) {
      try { values.push(JSON.parse(`"${match[1]}"`) as string); }
      catch { return { values, malformed: true }; }
    } else values.push(match[2]);
  }
  const remainder = inner.replace(token, "").replace(/#.*$/gm, "").replace(/[\s,]/g, "");
  return { values, malformed: Boolean(remainder) };
}

function pyprojectDependencies(manifest: DependencyManifest): DependencyParseResult {
  const parser = "pyproject-toml-regex", out = result();
  for (const section of tomlSections(fs.readFileSync(manifest.path, "utf8"))) {
    if (section.name === "project") {
      const array = stringArray(section.body, "dependencies");
      if (!array) continue;
      if (array.malformed) out.dependencyErrors.push(error(manifest, parser, "malformed project.dependencies array", section.startLine));
      for (const item of array.values) {
        const parsed = pep508(item);
        if (parsed) out.dependencies.push(ref(manifest, parser, 0.9, parsed.name, parsed.version, "runtime"));
        else out.dependencyErrors.push(error(manifest, parser, "unparsed project dependency", section.startLine));
      }
    } else if (section.name === "project.optional-dependencies") {
      const keys = [...section.body.matchAll(/^\s*([A-Za-z0-9_.-]+)\s*=\s*\[/gm)].map((match) => match[1]);
      for (const key of keys) {
        const array = stringArray(section.body, key)!;
        if (array.malformed) out.dependencyErrors.push(error(manifest, parser, `malformed optional dependency group ${key}`, section.startLine));
        for (const item of array.values) {
          const parsed = pep508(item);
          if (parsed) out.dependencies.push(ref(manifest, parser, 0.85, parsed.name, parsed.version, `optional:${key}`));
          else out.dependencyErrors.push(error(manifest, parser, `unparsed optional dependency in ${key}`, section.startLine));
        }
      }
    } else if (section.name === "tool.poetry.dependencies" || /^tool\.poetry\.group\.[^.]+\.dependencies$/.test(section.name)) {
      const scope = section.name === "tool.poetry.dependencies" ? "runtime" : "development";
      section.body.split(/\r?\n/).forEach((raw, offset) => {
        const line = raw.replace(/\s+#.*$/, "").trim();
        if (!line) return;
        const entry = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
        if (!entry) { out.dependencyErrors.push(error(manifest, parser, "unparsed poetry dependency entry", section.startLine + offset)); return; }
        if (entry[1].toLowerCase() === "python") return;
        const scalar = entry[2].match(/^["']([^"']+)["']$/)?.[1];
        const inline = entry[2].match(/\bversion\s*=\s*["']([^"']+)["']/)?.[1];
        const name = entry[2].match(/\bpackage\s*=\s*["']([^"']+)["']/)?.[1] ?? entry[1];
        if (scalar ?? inline) out.dependencies.push(ref(manifest, parser, 0.8, name, scalar ?? inline!, scope));
        else out.dependencyErrors.push(error(manifest, parser, `unparsed poetry dependency ${entry[1]}`, section.startLine + offset));
      });
    }
  }
  return out;
}

function goDependencies(manifest: DependencyManifest): DependencyParseResult {
  const parser = "go-mod-regex", out = result();
  let block = false;
  fs.readFileSync(manifest.path, "utf8").split(/\r?\n/).forEach((raw, index) => {
    const trimmed = raw.trim();
    if (/^require\s*\($/.test(trimmed)) { block = true; return; }
    if (block && trimmed === ")") { block = false; return; }
    if (!trimmed || trimmed.startsWith("//")) return;
    const candidate = block ? trimmed : trimmed.startsWith("require ") ? trimmed.slice(8).trim() : "";
    if (!candidate) return;
    const indirect = /\/\/\s*indirect\s*$/.test(candidate);
    const match = candidate.replace(/\s*\/\/.*$/, "").trim().match(/^(\S+)\s+(\S+)$/);
    if (match) out.dependencies.push(ref(manifest, parser, 0.95, match[1], match[2], indirect ? "indirect" : "runtime"));
    else out.dependencyErrors.push(error(manifest, parser, "unparsed require entry", index + 1));
  });
  if (block) out.dependencyErrors.push(error(manifest, parser, "unterminated require block"));
  return out;
}

function cargoDependencies(manifest: DependencyManifest): DependencyParseResult {
  const parser = "cargo-toml-regex", out = result();
  for (const section of tomlSections(fs.readFileSync(manifest.path, "utf8"))) {
    const suffix = section.name.match(/(?:^|\.)(dev-dependencies|build-dependencies|dependencies)$/)?.[1];
    if (!suffix) continue;
    const scope = suffix === "dev-dependencies" ? "development" : suffix === "build-dependencies" ? "build" : "runtime";
    section.body.split(/\r?\n/).forEach((raw, offset) => {
      const line = raw.replace(/\s+#.*$/, "").trim();
      if (!line) return;
      const entry = line.match(/^["']?([^"'=\s]+)["']?\s*=\s*(.+)$/);
      if (!entry) { out.dependencyErrors.push(error(manifest, parser, "unparsed dependency entry", section.startLine + offset)); return; }
      const scalar = entry[2].match(/^["']([^"']+)["']$/)?.[1];
      const version = scalar ?? entry[2].match(/\bversion\s*=\s*["']([^"']+)["']/)?.[1]
        ?? (entry[2].match(/\bworkspace\s*=\s*true\b/) ? "workspace" : undefined)
        ?? entry[2].match(/\bgit\s*=\s*["']([^"']+)["']/)?.[1]
        ?? entry[2].match(/\bpath\s*=\s*["']([^"']+)["']/)?.[1];
      const name = entry[2].match(/\bpackage\s*=\s*["']([^"']+)["']/)?.[1] ?? entry[1];
      if (version) out.dependencies.push(ref(manifest, parser, 0.9, name, version, scope));
      else out.dependencyErrors.push(error(manifest, parser, `unparsed dependency ${entry[1]}`, section.startLine + offset));
    });
  }
  return out;
}

function xmlValue(block: string, tag: string): string | undefined {
  return block.match(new RegExp(`<${tag}\\b[^>]*>\\s*([^<]+?)\\s*</${tag}>`, "i"))?.[1].trim();
}

function mavenDependencies(manifest: DependencyManifest): DependencyParseResult {
  const parser = "maven-xml-regex", out = result(), text = fs.readFileSync(manifest.path, "utf8");
  const blocks = [...text.matchAll(/<dependency\b[^>]*>([\s\S]*?)<\/dependency>/gi)];
  for (const match of blocks) {
    const group = xmlValue(match[1], "groupId"), artifact = xmlValue(match[1], "artifactId");
    if (!group || !artifact) out.dependencyErrors.push(error(manifest, parser, "dependency missing groupId or artifactId"));
    else out.dependencies.push(ref(manifest, parser, 0.8, `${group}:${artifact}`, xmlValue(match[1], "version") ?? "managed", xmlValue(match[1], "scope") ?? "compile"));
  }
  const starts = [...text.matchAll(/<dependency\b/gi)].length;
  for (let i = blocks.length; i < starts; i++) out.dependencyErrors.push(error(manifest, parser, "unclosed or self-closing dependency element"));
  return out;
}

function gradleDependencies(manifest: DependencyManifest): DependencyParseResult {
  const parser = "gradle-coordinate-regex", out = result();
  let depth = 0;
  fs.readFileSync(manifest.path, "utf8").split(/\r?\n/).forEach((raw, index) => {
    const line = raw.replace(/\/\/.*$/, "").trim(), opening = /\bdependencies\s*\{/.test(line);
    if (opening) depth += 1;
    else if (depth > 0 && line && !/^[{}]+$/.test(line)) {
      const entry = line.match(/^([A-Za-z][A-Za-z0-9_]*)\s*(?:\(\s*)?["']([^"']+)["']/);
      if (entry) {
        const parts = entry[2].split(":");
        if (parts.length >= 3 && parts[0] && parts[1] && parts[2]) out.dependencies.push(ref(manifest, parser, 0.75, `${parts[0]}:${parts[1]}`, parts[2], entry[1]));
        else out.dependencyErrors.push(error(manifest, parser, `unparsed ${entry[1]} coordinate`, index + 1));
      } else if (/^[A-Za-z][A-Za-z0-9_]*\s*\(/.test(line)) out.dependencyErrors.push(error(manifest, parser, "unparsed dependency declaration", index + 1));
    }
    if (depth > 0) depth += (line.match(/\{/g)?.length ?? 0) - (line.match(/\}/g)?.length ?? 0) - (opening ? 1 : 0);
    if (depth < 0) depth = 0;
  });
  return out;
}

function xmlAttribute(attrs: string, name: string): string | undefined {
  return attrs.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, "i"))?.[1];
}

function csprojDependencies(manifest: DependencyManifest): DependencyParseResult {
  const parser = "msbuild-xml-regex", out = result(), text = fs.readFileSync(manifest.path, "utf8");
  const blocks = [...text.matchAll(/<PackageReference\b([^>]*?)(?:\/>|>([\s\S]*?)<\/PackageReference>)/gi)];
  for (const match of blocks) {
    const name = xmlAttribute(match[1], "Include") ?? xmlAttribute(match[1], "Update");
    if (!name) { out.dependencyErrors.push(error(manifest, parser, "PackageReference missing Include or Update")); continue; }
    const body = match[2] ?? "";
    const version = xmlAttribute(match[1], "Version") ?? xmlValue(body, "Version") ?? "managed";
    const privateAssets = xmlAttribute(match[1], "PrivateAssets") ?? xmlValue(body, "PrivateAssets") ?? "";
    out.dependencies.push(ref(manifest, parser, 0.9, name, version, /\ball\b/i.test(privateAssets) ? "development" : "runtime"));
  }
  const starts = [...text.matchAll(/<PackageReference\b/gi)].length;
  for (let i = blocks.length; i < starts; i++) out.dependencyErrors.push(error(manifest, parser, "unclosed PackageReference element"));
  return out;
}

export function parseManifestDependencies(manifests: readonly DependencyManifest[]): DependencyParseResult {
  const out = result();
  for (const manifest of manifests) {
    const base = path.basename(manifest.path).toLowerCase();
    let parsed: DependencyParseResult | null = null;
    try {
      if (manifest.kind === "node") parsed = nodeDependencies(manifest);
      else if (manifest.kind === "python") parsed = base === "pyproject.toml" ? pyprojectDependencies(manifest) : requirementsDependencies(manifest);
      else if (manifest.kind === "go") parsed = goDependencies(manifest);
      else if (manifest.kind === "rust") parsed = cargoDependencies(manifest);
      else if (manifest.kind === "maven") parsed = mavenDependencies(manifest);
      else if (manifest.kind === "gradle" && /^build\.gradle(?:\.kts)?$/i.test(base)) parsed = gradleDependencies(manifest);
      else if (manifest.kind === "dotnet" && base.endsWith(".csproj")) parsed = csprojDependencies(manifest);
    } catch (cause) {
      out.dependencyErrors.push(error(manifest, `${manifest.kind}-manifest`, `manifest parse failed: ${cause instanceof Error ? cause.message : String(cause)}`));
    }
    if (parsed) { out.dependencies.push(...parsed.dependencies); out.dependencyErrors.push(...parsed.dependencyErrors); }
  }
  out.dependencies.sort((a, b) => `${a.sourceManifest}\0${a.name}\0${a.scope}`.localeCompare(`${b.sourceManifest}\0${b.name}\0${b.scope}`));
  out.dependencyErrors.sort((a, b) => `${a.sourceManifest}\0${a.line ?? 0}\0${a.message}`.localeCompare(`${b.sourceManifest}\0${b.line ?? 0}\0${b.message}`));
  return out;
}
