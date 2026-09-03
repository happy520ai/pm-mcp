import ts from "typescript";
import type { AnalyzerProvenance, SemanticExportRecord } from "./semantic-evidence.ts";
import type { RawReference, SemanticKind } from "./semantic-parsers.ts";

export interface TypeScriptSemanticResult {
  references: RawReference[];
  exports: SemanticExportRecord[];
  analyzer: AnalyzerProvenance;
  status: "complete" | "partial";
  diagnostics: string[];
  limitations: string[];
}

interface ImportBinding {
  specifier: string;
  namespace: boolean;
  typeOnly: boolean;
  imported: string;
}

const ANALYZER_ID = `typescript:compiler-api-ast@${ts.version}`;

function scriptKind(rel: string): ts.ScriptKind {
  const ext = rel.toLowerCase().split(".").pop();
  if (ext === "tsx") return ts.ScriptKind.TSX;
  if (ext === "jsx") return ts.ScriptKind.JSX;
  if (ext === "js" || ext === "mjs" || ext === "cjs") return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function stringValue(node: ts.Node | undefined): string | null {
  return node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : null;
}

function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap((element) => ts.isOmittedExpression(element) ? [] : bindingNames(element.name));
}

function bindingIdentifiers(name: ts.BindingName): ts.Identifier[] {
  if (ts.isIdentifier(name)) return [name];
  return name.elements.flatMap((element) => ts.isOmittedExpression(element) ? [] : bindingIdentifiers(element.name));
}

function inMemoryChecker(rel: string, source: ts.SourceFile): ts.TypeChecker {
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.Latest,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    allowJs: true,
    checkJs: false,
    noLib: true,
    noResolve: true,
  };
  const normalize = (value: string): string => value.replace(/\\/g, "/").replace(/^\.\//, "");
  const expected = normalize(rel);
  const host: ts.CompilerHost = {
    fileExists: (fileName) => normalize(fileName) === expected,
    readFile: (fileName) => normalize(fileName) === expected ? source.text : undefined,
    getSourceFile: (fileName) => normalize(fileName) === expected ? source : undefined,
    getDefaultLibFileName: () => "lib.d.ts",
    writeFile: () => undefined,
    getCurrentDirectory: () => "",
    getDirectories: () => [],
    getCanonicalFileName: normalize,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
  };
  return ts.createProgram({ rootNames: [expected], options, host }).getTypeChecker();
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return Boolean(ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((modifier) => modifier.kind === kind));
}

function expressionRoot(expression: ts.Expression): ts.Identifier | null {
  if (ts.isIdentifier(expression)) return expression;
  if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) return expressionRoot(expression.expression);
  if (ts.isParenthesizedExpression(expression) || ts.isNonNullExpression(expression) || ts.isAsExpression(expression) || ts.isTypeAssertionExpression(expression)) {
    return expressionRoot(expression.expression);
  }
  return null;
}

function expressionPath(expression: ts.Expression): string {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) {
    const parent = expressionPath(expression.expression);
    return parent ? `${parent}.${expression.name.text}` : expression.name.text;
  }
  return "";
}

function exportedDeclarationNames(node: ts.Node): string[] {
  if (ts.isVariableStatement(node)) return node.declarationList.declarations.flatMap((declaration) => bindingNames(declaration.name));
  if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node) || ts.isModuleDeclaration(node)) && node.name) {
    return ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) ? [node.name.text] : [];
  }
  return [];
}

function diagnosticText(source: ts.SourceFile, diagnostic: ts.DiagnosticWithLocation): string {
  const position = source.getLineAndCharacterOfPosition(diagnostic.start);
  return `${position.line + 1}:${position.character + 1} ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`;
}

/**
 * Syntax-semantic extraction backed by the same parser TypeScript uses to compile TS/JS.
 * Calls are conservative syntactic uses of imported bindings; execution and dynamic
 * dispatch still require runtime evidence.
 */
export function analyzeTypeScriptSource(rel: string, content: string): TypeScriptSemanticResult {
  const source = ts.createSourceFile(rel, content, ts.ScriptTarget.Latest, true, scriptKind(rel));
  const checker = inMemoryChecker(rel, source);
  const parseDiagnostics = (source as ts.SourceFile & { parseDiagnostics?: readonly ts.DiagnosticWithLocation[] }).parseDiagnostics ?? [];
  const diagnostics = parseDiagnostics.map((diagnostic) => diagnosticText(source, diagnostic));
  const references: RawReference[] = [];
  const exports: SemanticExportRecord[] = [];
  const symbolBindings = new Map<ts.Symbol, ImportBinding>();
  const lineOf = (node: ts.Node): number => source.getLineAndCharacterOfPosition(node.getStart(source, false)).line + 1;
  const addReference = (node: ts.Node, kind: SemanticKind, specifier: string, confidence: number, forceLocal = false, symbol?: string): void => {
    if (!specifier.trim()) return;
    references.push({ kind, specifier: specifier.trim(), line: lineOf(node), parser: ANALYZER_ID, confidence, forceLocal, offset: node.getStart(source, false), symbol });
  };
  const addExport = (node: ts.Node, name: string, typeOnly: boolean, sourceSpecifier?: string): void => {
    exports.push({ name, line: lineOf(node), isTypeOnly: typeOnly, sourceSpecifier, parser: ANALYZER_ID, confidence: 0.99 });
  };
  const storeBinding = (identifier: ts.Identifier, binding: ImportBinding): void => {
    const symbol = checker.getSymbolAtLocation(identifier);
    if (symbol) symbolBindings.set(symbol, binding);
  };

  const registerImportClause = (clause: ts.ImportClause | undefined, specifier: string): void => {
    if (!clause) return;
    if (clause.name) storeBinding(clause.name, { specifier, namespace: false, typeOnly: clause.isTypeOnly, imported: "default" });
    if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
      storeBinding(clause.namedBindings.name, { specifier, namespace: true, typeOnly: clause.isTypeOnly, imported: "*" });
    } else if (clause.namedBindings) {
      for (const element of clause.namedBindings.elements) {
        storeBinding(element.name, {
          specifier,
          namespace: false,
          typeOnly: clause.isTypeOnly || element.isTypeOnly,
          imported: element.propertyName?.text ?? element.name.text,
        });
      }
    }
  };
  const registerRequireBinding = (name: ts.BindingName, specifier: string): void => {
    if (ts.isIdentifier(name)) {
      storeBinding(name, { specifier, namespace: true, typeOnly: false, imported: "*" });
      return;
    }
    if (!ts.isObjectBindingPattern(name)) return;
    for (const element of name.elements) {
      for (const identifier of bindingIdentifiers(element.name)) {
        const local = identifier.text;
        const imported = element.propertyName && (ts.isIdentifier(element.propertyName) || ts.isStringLiteral(element.propertyName))
          ? element.propertyName.text
          : local;
        storeBinding(identifier, { specifier, namespace: false, typeOnly: false, imported });
      }
    }
  };
  const requireSpecifier = (expression: ts.Expression | undefined): string | null => {
    if (!expression || !ts.isCallExpression(expression) || !ts.isIdentifier(expression.expression) || expression.expression.text !== "require") return null;
    return stringValue(expression.arguments[0]);
  };

  const collectDeclarations = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const specifier = stringValue(node.moduleSpecifier);
      if (specifier) {
        addReference(node, "import", specifier, 0.99, specifier.startsWith("."));
        registerImportClause(node.importClause, specifier);
      }
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const specifier = stringValue(node.moduleReference.expression);
      if (specifier) {
        addReference(node, "import", specifier, 0.98, specifier.startsWith("."));
        storeBinding(node.name, { specifier, namespace: true, typeOnly: node.isTypeOnly, imported: "*" });
      }
    } else if (ts.isVariableDeclaration(node)) {
      const specifier = requireSpecifier(node.initializer);
      if (specifier) {
        addReference(node, "import", specifier, 0.98, specifier.startsWith("."));
        registerRequireBinding(node.name, specifier);
      }
    } else if (ts.isExportDeclaration(node)) {
      const specifier = stringValue(node.moduleSpecifier);
      if (specifier) addReference(node, "export", specifier, 0.99, specifier.startsWith("."));
      if (!node.exportClause) {
        addExport(node, "*", node.isTypeOnly, specifier ?? undefined);
      } else if (ts.isNamespaceExport(node.exportClause)) {
        addExport(node.exportClause, node.exportClause.name.text, node.isTypeOnly, specifier ?? undefined);
      } else {
        for (const element of node.exportClause.elements) addExport(element, element.name.text, node.isTypeOnly || element.isTypeOnly, specifier ?? undefined);
      }
    } else if (hasModifier(node, ts.SyntaxKind.ExportKeyword)) {
      const names = exportedDeclarationNames(node);
      const isDefault = hasModifier(node, ts.SyntaxKind.DefaultKeyword);
      if (isDefault) addExport(node, "default", false);
      else for (const name of names) addExport(node, name, ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node));
    } else if (ts.isExportAssignment(node)) {
      addExport(node, node.isExportEquals ? "export=" : "default", false);
    }
    ts.forEachChild(node, collectDeclarations);
  };
  collectDeclarations(source);

  const collectUses = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const specifier = stringValue(node.arguments[0]);
        if (specifier) addReference(node, "import", specifier, 0.98, specifier.startsWith("."));
      } else if (!(ts.isIdentifier(node.expression) && node.expression.text === "require")) {
        const root = expressionRoot(node.expression);
        const rootSymbol = root ? checker.getSymbolAtLocation(root) : undefined;
        const binding = rootSymbol ? symbolBindings.get(rootSymbol) : undefined;
        if (binding && !binding.typeOnly) addReference(node, "call", binding.specifier, 0.94, binding.specifier.startsWith("."), binding.imported);

        const callee = expressionPath(node.expression);
        const firstArgument = stringValue(node.arguments[0]);
        if (firstArgument && (/^(?:fetch|axios\.(?:get|post|put|patch|delete)|http\.(?:get|post))$/i.test(callee))) {
          addReference(node, "http", firstArgument, 0.96);
        }
        if (firstArgument && /^(?:grpc\.(?:dial|insecure_channel|secure_channel)|grpcchannel\.foraddress)$/i.test(callee)) {
          addReference(node, "grpc", firstArgument, 0.94);
        }
        if (firstArgument && /^(?:ffi\.library|dlopen)$/i.test(callee)) addReference(node, "ffi", firstArgument, 0.94);
      }
    } else if (ts.isNewExpression(node)) {
      const root = expressionRoot(node.expression);
      const rootSymbol = root ? checker.getSymbolAtLocation(root) : undefined;
      const binding = rootSymbol ? symbolBindings.get(rootSymbol) : undefined;
      if (binding && !binding.typeOnly) addReference(node, "call", binding.specifier, 0.94, binding.specifier.startsWith("."), binding.imported);
      const firstArgument = stringValue(node.arguments?.[0]);
      if (firstArgument && /(?:Client|Stub)$/.test(expressionPath(node.expression))) addReference(node, "grpc", firstArgument, 0.86);
    } else if (ts.isStringLiteralLike(node)) {
      const value = node.text;
      const pathPart = value.split("#", 1)[0].replace(/\\/g, "/");
      const basename = pathPart.split("/").at(-1) ?? "";
      // Extension constants such as ".proto" are metadata, not contract links.
      // Requiring a real basename keeps AST evidence precise while still
      // accepting both nearby files (service.proto) and relative paths.
      if (/^[^.\s][^/\s]*\.(?:proto|graphql|gql)$/i.test(basename)) addReference(node, "contract", value, 0.98, true);
      else if (/^[^.\s][^/\s]*(?:openapi|swagger|asyncapi|contracts?|schemas?)[^/\s]*\.(?:ya?ml|json)$/i.test(basename)) addReference(node, "contract", value, 0.95, true);
    } else if (ts.isTaggedTemplateExpression(node) && /^(?:gql|graphql)$/.test(expressionPath(node.tag))) {
      addReference(node, "contract", "inline GraphQL", 0.96);
    }
    ts.forEachChild(node, collectUses);
  };
  collectUses(source);

  const uniqueReferences = [...new Map(references.map((reference) => [
    `${reference.kind}|${reference.line}|${reference.specifier}|${reference.offset ?? ""}`,
    reference,
  ])).values()];
  const uniqueExports = [...new Map(exports.map((item) => [`${item.name}|${item.line}|${item.sourceSpecifier ?? ""}`, item])).values()];
  return {
    references: uniqueReferences,
    exports: uniqueExports,
    analyzer: {
      id: ANALYZER_ID,
      family: "compiler-ast",
      assurance: "ast",
      engine: "TypeScript Compiler API",
      version: ts.version,
      capabilities: ["imports", "exports", "calls", "contracts", "http", "grpc", "ffi"],
    },
    status: diagnostics.length === 0 ? "complete" : "partial",
    diagnostics,
    limitations: [
      "AST call edges prove syntactic use of an imported binding, not runtime execution.",
      "Generated code, reflection, dependency-injection containers, and data-driven dispatch require imported native or runtime evidence.",
    ],
  };
}
