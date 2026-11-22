import ts from "typescript";
import { StudioError } from "./errors.js";

export function parseModule(source: string, fileName = "module.tsx"): ts.SourceFile {
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

/** Every module specifier the file imports, in source order. */
export function importSpecifiers(source: string): string[] {
  const file = parseModule(source);
  const found: string[] = [];
  for (const statement of file.statements)
    if (
      (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier)
    )
      found.push(statement.moduleSpecifier.text);
  return found;
}

/** Names the module exports, including the resolved name of a default export. */
export function exportedNames(source: string): string[] {
  const file = parseModule(source);
  const names = new Set<string>();
  const exported = (node: ts.Node) =>
    ts.canHaveModifiers(node) &&
    ts
      .getModifiers(node)
      ?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);

  for (const statement of file.statements) {
    if (ts.isVariableStatement(statement) && exported(statement))
      for (const declaration of statement.declarationList.declarations)
        if (ts.isIdentifier(declaration.name)) names.add(declaration.name.text);
    if (
      (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) &&
      exported(statement) &&
      statement.name
    )
      names.add(statement.name.text);
    if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause))
      for (const element of statement.exportClause.elements) names.add(element.name.text);
  }
  return [...names];
}

export type LayoutExtraction = {
  /** TSX source of a shell component that renders `children` in the content region. */
  source: string;
  /** Layout regions preserved from the template, outermost first. */
  regions: string[];
  /** Module specifiers the shell still imports after unused ones are pruned. */
  imports: string[];
};

/**
 * Rewrites a template page into a layout shell with a content slot.
 *
 * A template block ships chrome (sidebar, header) wrapped around sample content.
 * The chrome is what a designer picks the template for, so it is preserved, and
 * the sample content is replaced by `{children}`.
 *
 * The content region is found by descending the JSX spine: at each element the
 * walk follows the single child, or the one child holding a strict majority of
 * the component references below it. Siblings passed on the way are chrome. The
 * walk stops at the first element whose component references are spread across
 * several children, because that element is the one holding sample content
 * rather than more layout.
 */
export function extractLayout(source: string, componentName = "TemplateShell"): LayoutExtraction {
  const file = parseModule(source, "page.tsx");
  const root = defaultExportedJsx(file);
  const regions: string[] = [];

  let current = root;
  for (;;) {
    const tag = tagName(current);
    if (tag && /^[A-Z]/.test(tag)) regions.push(tag);
    const children = elementChildren(current);
    if (children.length === 0) break;
    if (children.length === 1) {
      current = children[0]!;
      continue;
    }
    const counts = children.map(componentReferenceCount);
    const total = counts.reduce((sum, value) => sum + value, 0);
    const dominant = counts.findIndex((count) => count * 2 > total);
    if (dominant === -1) break;
    for (const [index, child] of children.entries()) {
      if (index === dominant) continue;
      const name = tagName(child);
      if (name && /^[A-Z]/.test(name)) regions.push(name);
    }
    current = children[dominant]!;
  }

  const slotChildren = childrenRange(current, file);
  const header = componentHeader(file, componentName);
  const body =
    source.slice(header.bodyStart, slotChildren.start) +
    "{children}" +
    source.slice(slotChildren.end, header.bodyEnd);

  const declaration = `export function ${componentName}({ children }: { children?: ReactNode }) ${body}`;
  const kept = keepUsedImports(file, source, declaration);
  const needsReactTypes = !kept.some((line) => /from "react"/.test(line));
  const imports = [...(needsReactTypes ? ['import type { ReactNode } from "react"'] : []), ...kept];

  return {
    source: `${imports.join("\n")}\n\n${declaration}\n`,
    regions: [...new Set(regions)],
    imports: imports.flatMap((line) => importSpecifiers(line)),
  };
}

function defaultExportedJsx(file: ts.SourceFile): ts.JsxElement | ts.JsxSelfClosingElement | ts.JsxFragment {
  for (const statement of file.statements) {
    const isDefault =
      ts.canHaveModifiers(statement) &&
      ts.getModifiers(statement)?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword);
    if (ts.isFunctionDeclaration(statement) && isDefault && statement.body) {
      const jsx = findReturnedJsx(statement.body);
      if (jsx) return jsx;
    }
  }
  throw new StudioError(
    "This template does not export a default page component returning JSX, so its layout cannot be reused.",
  );
}

function findReturnedJsx(body: ts.Block): ts.JsxElement | ts.JsxSelfClosingElement | ts.JsxFragment | undefined {
  for (const statement of body.statements)
    if (ts.isReturnStatement(statement) && statement.expression) {
      const expression = unwrap(statement.expression);
      if (ts.isJsxElement(expression) || ts.isJsxSelfClosingElement(expression) || ts.isJsxFragment(expression))
        return expression;
    }
  return undefined;
}

function unwrap(node: ts.Expression): ts.Expression {
  return ts.isParenthesizedExpression(node) ? unwrap(node.expression) : node;
}

type JsxNode = ts.JsxElement | ts.JsxSelfClosingElement | ts.JsxFragment;

function tagName(node: JsxNode): string | undefined {
  if (ts.isJsxFragment(node)) return undefined;
  const opening = ts.isJsxElement(node) ? node.openingElement : node;
  return opening.tagName.getText();
}

function elementChildren(node: JsxNode): JsxNode[] {
  if (ts.isJsxSelfClosingElement(node)) return [];
  return node.children.filter(
    (child): child is JsxNode =>
      ts.isJsxElement(child) || ts.isJsxSelfClosingElement(child) || ts.isJsxFragment(child),
  );
}

/** Number of capitalised JSX tags in the subtree, the node included. */
function componentReferenceCount(node: JsxNode): number {
  const tag = tagName(node);
  const self = tag && /^[A-Z]/.test(tag) ? 1 : 0;
  return elementChildren(node).reduce((sum, child) => sum + componentReferenceCount(child), self);
}

function childrenRange(node: JsxNode, file: ts.SourceFile): { start: number; end: number } {
  if (ts.isJsxSelfClosingElement(node))
    throw new StudioError("This template has no content region to generate into.");
  const open = ts.isJsxElement(node) ? node.openingElement : node.openingFragment;
  const close = ts.isJsxElement(node) ? node.closingElement : node.closingFragment;
  return { start: open.getEnd(), end: close.getStart(file) };
}

function componentHeader(
  file: ts.SourceFile,
  componentName: string,
): { bodyStart: number; bodyEnd: number } {
  for (const statement of file.statements)
    if (
      ts.isFunctionDeclaration(statement) &&
      statement.body &&
      ts.canHaveModifiers(statement) &&
      ts.getModifiers(statement)?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)
    )
      return { bodyStart: statement.body.getStart(file), bodyEnd: statement.body.getEnd() };
  throw new StudioError(`This template has no default component to rename to ${componentName}.`);
}

/** Identifiers the snippet references, JSX tag names included. */
function referencedIdentifiers(snippet: string): Set<string> {
  const used = new Set<string>();
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node)) used.add(node.text);
    if (ts.isPropertyAccessExpression(node)) used.add(node.expression.getText());
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(parseModule(snippet, "snippet.tsx"), visit);
  return used;
}

/** Import lines whose bindings are still referenced by the rewritten component. */
function keepUsedImports(file: ts.SourceFile, source: string, declaration: string): string[] {
  const used = referencedIdentifiers(declaration);
  const kept: string[] = [];
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause) continue;
    const clause = statement.importClause;
    const names: string[] = [];
    if (clause.name) names.push(clause.name.text);
    if (clause.namedBindings) {
      if (ts.isNamespaceImport(clause.namedBindings)) names.push(clause.namedBindings.name.text);
      else for (const element of clause.namedBindings.elements) names.push(element.name.text);
    }
    if (names.some((name) => used.has(name)))
      kept.push(source.slice(statement.getStart(file), statement.getEnd()).trim());
  }
  return kept;
}
