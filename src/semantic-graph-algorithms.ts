import { relPath } from "./semantic-parsers.ts";

interface ModuleEdgeLike {
  from: string;
  to: string;
}

interface ImpactGraphLike {
  files: ReadonlyArray<{ path: string; module: string | null }>;
  fileEdges: ReadonlyArray<{ from: string; fromModule: string | null; to: string | null; toModule: string | null }>;
  moduleEdges: readonly ModuleEdgeLike[];
}

export interface ComputedImpact {
  changedFiles: string[];
  impactedFiles: string[];
  dependentFiles: string[];
  impactedModules: string[];
  unknownChangedFiles: string[];
}

/** Deterministic Tarjan strongly-connected-component detection. */
export function findModuleCycles(edges: readonly ModuleEdgeLike[]): string[][] {
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) adjacency.set(edge.from, [...new Set([...(adjacency.get(edge.from) ?? []), edge.to])].sort());
  let index = 0; const stack: string[] = []; const onStack = new Set<string>();
  const indices = new Map<string, number>(); const low = new Map<string, number>(); const cycles: string[][] = [];
  const visit = (node: string): void => {
    indices.set(node, index); low.set(node, index); index += 1; stack.push(node); onStack.add(node);
    for (const next of adjacency.get(node) ?? []) {
      if (!indices.has(next)) { visit(next); low.set(node, Math.min(low.get(node)!, low.get(next)!)); }
      else if (onStack.has(next)) low.set(node, Math.min(low.get(node)!, indices.get(next)!));
    }
    if (low.get(node) === indices.get(node)) {
      const component: string[] = []; let popped: string;
      do { popped = stack.pop()!; onStack.delete(popped); component.push(popped); } while (popped !== node);
      if (component.length > 1) cycles.push(component.sort());
    }
  };
  for (const node of [...new Set(edges.flatMap((edge) => [edge.from, edge.to]))].sort()) if (!indices.has(node)) visit(node);
  return cycles.sort((a, b) => a.join("/").localeCompare(b.join("/")));
}

/** Reverse closure over file targets and module-only contract/FFI edges. */
export function computeImpactAnalysis(graph: ImpactGraphLike, changedFiles: readonly string[]): ComputedImpact {
  const known = new Set(graph.files.map((file) => file.path));
  const changed = [...new Set(changedFiles.map(relPath))].sort();
  const affectedFiles = new Set(changed.filter((file) => known.has(file)));
  const affectedModules = new Set<string>();
  const moduleOf = new Map(graph.files.map((file) => [file.path, file.module]));
  for (const file of affectedFiles) { const module = moduleOf.get(file); if (module) affectedModules.add(module); }
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const edge of graph.fileEdges) {
      if ((edge.to && affectedFiles.has(edge.to)) || (edge.toModule && affectedModules.has(edge.toModule))) {
        if (!affectedFiles.has(edge.from)) { affectedFiles.add(edge.from); progressed = true; }
        if (edge.fromModule && !affectedModules.has(edge.fromModule)) { affectedModules.add(edge.fromModule); progressed = true; }
      }
    }
    for (const edge of graph.moduleEdges) if (affectedModules.has(edge.to) && !affectedModules.has(edge.from)) { affectedModules.add(edge.from); progressed = true; }
  }
  const impactedFiles = [...affectedFiles].sort();
  const changedSet = new Set(changed);
  return {
    changedFiles: changed,
    impactedFiles,
    dependentFiles: impactedFiles.filter((file) => !changedSet.has(file)),
    impactedModules: [...affectedModules].sort(),
    unknownChangedFiles: changed.filter((file) => !known.has(file)),
  };
}
