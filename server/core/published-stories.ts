import { promises as fs } from "node:fs";
import path from "node:path";
import { Project, Node, type Expression } from "ts-morph";
import { literalValue } from "./source.js";
import type { Component } from "./contracts.js";

/** Bounded discovery of runnable, package-published CSF object examples. */
export async function publishedStories(root: string, packageName: string) {
  const files: string[] = [];
  let visited = 0;
  async function walk(directory: string, prefix = "") {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (++visited > 3000) return;
      if (
        entry.isSymbolicLink() ||
        ["node_modules", ".git"].includes(entry.name)
      )
        continue;
      const name = prefix + entry.name;
      if (entry.isDirectory())
        await walk(path.join(directory, entry.name), name + "/");
      else if (/\.stories\.[tj]sx$/.test(name)) files.push(name);
    }
  }
  await walk(root);
  let preview: string | undefined;
  for (const file of [
    ".storybook/preview.tsx",
    ".storybook/preview.ts",
    ".storybook/preview.jsx",
    ".storybook/preview.js",
  ]) {
    const resolved = await fs
      .realpath(path.join(root, file))
      .catch(() => undefined);
    if (resolved?.startsWith(root + path.sep)) {
      preview = file;
      break;
    }
  }
  const project = new Project({ useInMemoryFileSystem: true });
  const result = new Map<
    string,
    { description?: string; examples: Component["examples"]; setup: string[]; provider?: string; insertionGap?: string }
  >();
  const unwrap = (input: Expression | undefined): Expression | undefined => {
    while (
      input &&
      (Node.isSatisfiesExpression(input) ||
        Node.isAsExpression(input) ||
        Node.isParenthesizedExpression(input))
    )
      input = input.getExpression();
    return input;
  };
  const setupExports = (source: import("ts-morph").SourceFile) => {
    const identities = new Set<string>();
    const providers: string[] = [];
    let unsafe = false;
    for (const property of source.getDescendants().filter(Node.isPropertyAssignment)) {
      if (property.getName() !== "decorators") continue;
      const decorators = unwrap(property.getInitializer());
      if (!decorators || !Node.isArrayLiteralExpression(decorators)) { unsafe = true; continue; }
      for (const decorator of decorators.getElements()) {
        if (!Node.isArrowFunction(decorator) && !Node.isFunctionExpression(decorator)) { unsafe = true; continue; }
        const recipe: string[] = [];
        let body: Node | undefined = decorator.getBody();
        if (Node.isBlock(body)) {
          const statements = body.getStatements();
          body = statements.length === 1 && Node.isReturnStatement(statements[0]) ? statements[0].getExpression() : undefined;
        }
        const story = decorator.getParameters()[0]?.getNameNode().getSymbol()?.compilerSymbol;
        if (!story) { unsafe = true; continue; }
        for (const wrapper of decorator.getDescendants().filter(Node.isJsxElement)) {
          if (!wrapper.getDescendants().some((node) =>
            (Node.isJsxSelfClosingElement(node) || Node.isJsxOpeningElement(node)) && Node.isIdentifier(node.getTagNameNode()) && node.getTagNameNode().getSymbol()?.compilerSymbol === story)) continue;
          const tag = wrapper.getOpeningElement().getTagNameNode().getText();
          for (const declaration of source.getImportDeclarations()) {
            if (declaration.getModuleSpecifierValue() !== packageName) continue;
            const named = declaration.getNamedImports().find((binding) => (binding.getAliasNode()?.getText() ?? binding.getName()) === tag);
            const namespace = declaration.getNamespaceImport()?.getText();
            const identity = named ? packageName + "#" + named.getName() : declaration.getDefaultImport()?.getText() === tag ? packageName + "#default" : namespace && tag.startsWith(namespace + ".") ? packageName + "#" + tag.slice(namespace.length + 1) : undefined;
            if (identity) {
              identities.add(identity);
              const children = wrapper.getJsxChildren().filter((child) => !Node.isJsxText(child) || child.getText().trim());
              const child = children[0];
              const bound = named?.getAliasNode() ?? named?.getNameNode() ?? declaration.getDefaultImport() ?? declaration.getNamespaceImport();
              let root: Node = wrapper.getOpeningElement().getTagNameNode();
              while (Node.isPropertyAccessExpression(root)) root = root.getExpression();
              if (body === wrapper && wrapper.getOpeningElement().getAttributes().length === 0 && children.length === 1 && child && Node.isJsxSelfClosingElement(child) && child.getTagNameNode().getSymbol()?.compilerSymbol === story && child.getAttributes().length === 0 && root.getSymbol()?.compilerSymbol === bound?.getSymbol()?.compilerSymbol && !identity.split("#")[1].includes(".")) recipe.push(identity);
            }
          }
        }
        if (recipe.length === 1) providers.push(recipe[0]);
        else unsafe = true;
      }
    }
    return { identities: [...identities], provider: !unsafe && providers.length === 1 ? providers[0] : undefined, gap: unsafe || providers.length > 1 };
  };
  const globalSetup = preview ? setupExports(project.createSourceFile(preview, await fs.readFile(path.join(root, preview), "utf8"))) : { identities: [], provider: undefined, gap: false };
  for (const file of files) {
    const stat = await fs.stat(path.join(root, file));
    if (stat.size > 200000) continue;
    const content = await fs.readFile(path.join(root, file), "utf8");
    const source = project.createSourceFile(file, content);
    let meta = unwrap(source.getExportAssignments()[0]?.getExpression());
    if (meta && Node.isIdentifier(meta))
      meta = unwrap(
        source.getVariableDeclaration(meta.getText())?.getInitializer(),
      );
    if (!meta || !Node.isObjectLiteralExpression(meta)) continue;
    const component = meta.getProperty("component");
    const local =
      component && Node.isPropertyAssignment(component)
        ? component.getInitializer()?.getText()
        : undefined;
    // Self-import proves which public package export the example exercises.
    const declaration=source.getImportDeclarations().find(declaration=>declaration.getModuleSpecifierValue()===packageName && (declaration.getDefaultImport()?.getText()===local || declaration.getNamedImports().some(binding=>(binding.getAliasNode()?.getText()??binding.getName())===local)));
    const exported=declaration?.getDefaultImport()?.getText()===local ? "default" : declaration?.getNamedImports().find(binding=>(binding.getAliasNode()?.getText()??binding.getName())===local)?.getName();
    if (!exported) continue;
    let description: string | undefined;
    let current: Expression | undefined = meta;
    for (const key of ["parameters", "docs", "description", "component"]) {
      const property: Node | undefined =
        current && Node.isObjectLiteralExpression(current)
          ? current.getProperty(key)
          : undefined;
      current =
        property && Node.isPropertyAssignment(property)
          ? unwrap(property.getInitializer())
          : undefined;
    }
    if (current && Node.isStringLiteral(current))
      description = current.getLiteralValue();
    const localSetup = setupExports(source);
    const provider = globalSetup.provider ?? localSetup.provider;
    const group = result.get(exported) ?? { description, examples: [], setup: [], provider };
    if (globalSetup.gap || localSetup.gap || (globalSetup.provider && localSetup.provider) || group.provider !== provider)
      group.insertionGap = "The published decorators require setup that cannot be carried into insertion unambiguously. Ask the library maintainer for a documented reusable provider or use a prompt retaining the published setup.";
    group.setup = [...new Set([...group.setup, ...globalSetup.identities, ...localSetup.identities])];
    for (const variable of source.getVariableDeclarations()) {
      if (!variable.getVariableStatement()?.isExported()) continue;
      const story = unwrap(variable.getInitializer());
      if (!story || !Node.isObjectLiteralExpression(story)) continue;
      const args = story.getProperty("args");
      const props: Record<string, unknown> = {};
      const expression =
        args && Node.isPropertyAssignment(args)
          ? args.getInitializer()
          : undefined;
      if (expression && Node.isObjectLiteralExpression(expression))
        for (const property of expression.getProperties()) {
          if (!Node.isPropertyAssignment(property)) continue;
          const value = literalValue(property.getInitializer());
          if (value !== undefined) props[property.getName()] = value;
        }
      group.examples.push({
        name: variable.getName(),
        props,
        story: { file, export: variable.getName(), annotations: preview },
        source: content,
      });
    }
    if (group.examples.length) result.set(exported, group);
  }
  return result;
}
