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
    { description?: string; examples: Component["examples"] }
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
    const group = result.get(exported) ?? { description, examples: [] };
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
