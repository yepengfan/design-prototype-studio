import { promises as fs } from "node:fs";
import path from "node:path";
import { Project, Node, type Expression, type SourceFile } from "ts-morph";
import { resolveLocal } from "./archive.js";
import { literalValue } from "./source.js";
import type { Component } from "./contracts.js";

/** Bounded discovery of runnable, package-published CSF object examples. */
export async function publishedStories(root: string, packageName: string) {
  const files: string[] = [];
  const inventory: Record<string, string> = {};
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
      else {
        inventory[name] = "";
        if (/\.stories\.[tj]sx$/.test(name)) files.push(name);
      }
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
  type StoryGroup = { description?: string; examples: Component["examples"]; setup: string[]; styles: string[]; styleGap?: string; provider?: string; insertionGap?: string };
  const result = new Map<string, StoryGroup>();
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
  const setupExports = (source: SourceFile, render?: { expression: Node; component: import("typescript").Symbol | undefined; props: Record<string, unknown>; argsKnown: boolean }) => {
    const identities = new Set<string>();
    const providers: string[] = [];
    let unsafe = false;
    let reason: string | undefined;
    let children: string | undefined;
    const recipes: Node[] = [];
    if (render) recipes.push(render.expression);
    else for (const property of source.getDescendants().filter(Node.isPropertyAssignment)) {
      if (property.getName() !== "decorators") continue;
      const decorators = unwrap(property.getInitializer());
      if (!decorators || !Node.isArrayLiteralExpression(decorators)) { unsafe = true; continue; }
      recipes.push(...decorators.getElements());
    }
    for (const recipe of recipes) {
      if (!Node.isArrowFunction(recipe) && !Node.isFunctionExpression(recipe)) { unsafe = true; reason = "The setup is not a direct inline function."; continue; }
      let body: Node | undefined = recipe.getBody();
      if (Node.isBlock(body)) {
        const statements = body.getStatements();
        body = statements.length === 1 && Node.isReturnStatement(statements[0]) ? statements[0].getExpression() : undefined;
        if (!body) reason = "The setup requires local initialization statements.";
      }
      if (body && (Node.isParenthesizedExpression(body) || Node.isAsExpression(body) || Node.isSatisfiesExpression(body))) body = unwrap(body);
      const parameter = recipe.getParameters()[0]?.getNameNode().getSymbol()?.compilerSymbol;
      const childBinding = render ? render.component : parameter;
      const leaf = (node: Node | undefined) => {
        if (!node || (!Node.isJsxElement(node) && !Node.isJsxSelfClosingElement(node))) return false;
        const op = Node.isJsxElement(node) ? node.getOpeningElement() : node;
        if (!childBinding || op.getTagNameNode().getSymbol()?.compilerSymbol !== childBinding) return false;
        if (!render) return Node.isJsxSelfClosingElement(node) && op.getAttributes().length === 0;
        const props: Record<string, unknown> = {};
        for (const attribute of op.getAttributes()) {
          if (Node.isJsxSpreadAttribute(attribute)) {
            if (!parameter || attribute.getExpression().getSymbol()?.compilerSymbol !== parameter || !render.argsKnown) { reason = "The component spreads runtime properties that cannot be serialized for insertion."; return false; }
            Object.assign(props, render.props);
          } else {
            const initializer = attribute.getInitializer();
            const expression = initializer && Node.isJsxExpression(initializer) ? initializer.getExpression() : initializer;
            const value = initializer ? literalValue(expression) : true;
            if (value === undefined) { reason = "The component uses runtime property values that cannot be serialized for insertion."; return false; }
            props[attribute.getNameNode().getText()] = value;
          }
        }
        if (props.children !== undefined) {
          if (typeof props.children !== "string") return false;
          children = props.children;
          delete props.children;
        }
        if (Node.isJsxElement(node)) {
          let text = "";
          let hasContent = false;
          for (const child of node.getJsxChildren()) {
            if (Node.isJsxText(child)) { text += child.getText(); hasContent ||= !!child.getText().trim(); }
            else if (Node.isJsxExpression(child) && typeof literalValue(child.getExpression()) === "string") { text += literalValue(child.getExpression()); hasContent = true; }
            else return false;
          }
          if (hasContent) children = text.trim();
        }
        for (const key of Object.keys(render.props)) delete render.props[key];
        Object.assign(render.props, props);
        return true;
      };
      if (render && leaf(body)) continue;
      if (!childBinding) { unsafe = true; continue; }
      let provider: string | undefined;
      for (const wrapper of recipe.getDescendants().filter(Node.isJsxElement)) {
        if (!wrapper.getDescendants().some((node) =>
          (Node.isJsxSelfClosingElement(node) || Node.isJsxOpeningElement(node)) && node.getTagNameNode().getSymbol()?.compilerSymbol === childBinding)) continue;
        const tag = wrapper.getOpeningElement().getTagNameNode();
        for (const declaration of source.getImportDeclarations()) {
          if (declaration.getModuleSpecifierValue() !== packageName) continue;
          const named = declaration.getNamedImports().find((binding) => (binding.getAliasNode()?.getText() ?? binding.getName()) === tag.getText());
          const namespace = declaration.getNamespaceImport()?.getText();
          const identity = named ? packageName + "#" + named.getName() : declaration.getDefaultImport()?.getText() === tag.getText() ? packageName + "#default" : namespace && tag.getText().startsWith(namespace + ".") ? packageName + "#" + tag.getText().slice(namespace.length + 1) : undefined;
          if (!identity) continue;
          identities.add(identity);
          if (wrapper.getOpeningElement().getAttributes().length) reason = `Provider ${identity} requires attributes that the reusable default-provider setup does not carry.`;
          const content = wrapper.getJsxChildren().filter((child) => !Node.isJsxText(child) || child.getText().trim());
          const bound = named?.getAliasNode() ?? named?.getNameNode() ?? declaration.getDefaultImport() ?? declaration.getNamespaceImport();
          let root: Node = tag;
          while (Node.isPropertyAccessExpression(root)) root = root.getExpression();
          if (body === wrapper && wrapper.getOpeningElement().getAttributes().length === 0 && content.length === 1 && leaf(content[0]) && root.getSymbol()?.compilerSymbol === bound?.getSymbol()?.compilerSymbol && !identity.split("#")[1].includes(".")) provider = identity;
        }
      }
      if (provider) providers.push(provider);
      else { unsafe = true; reason ??= "The setup is not a direct component inside one reusable default provider."; }
    }
    if (providers.length > 1) reason = "The setup requires more than one provider wrapper.";
    return { identities: [...identities], provider: !unsafe && providers.length === 1 ? providers[0] : undefined, gap: unsafe || providers.length > 1, children, reason };
  };
  const pkg = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
  const targets = (value: unknown): string[] => typeof value === "string" ? [value] : value && typeof value === "object" ? Object.entries(value).filter(([key]) => key !== "types").flatMap(([, target]) => targets(target)) : [];
  const stylesFor = async (entry: string) => {
    const styles = new Set<string>();
    const gaps = new Set<string>();
    const seen = new Set<string>();
    const visit = async (file: string): Promise<void> => {
      if (seen.has(file)) return;
      seen.add(file);
      const content = await fs.readFile(path.join(root, file), "utf8");
      if (Buffer.byteLength(content) > 200000) { gaps.add(`Stylesheet setup in ${file} exceeds the supported published source size.`); return; }
      const source = project.getSourceFile(file) ?? project.createSourceFile(file, content);
      const specs = [...source.getImportDeclarations().filter((node) => !node.isTypeOnly() && (node.getDefaultImport() || node.getNamespaceImport() || !node.getNamedImports().length || node.getNamedImports().some((binding) => !binding.isTypeOnly()))).map((node) => node.getModuleSpecifierValue()), ...source.getExportDeclarations().filter((node) => !node.isTypeOnly()).flatMap((node) => node.getModuleSpecifierValue() ?? [])];
      for (const call of source.getDescendants().filter(Node.isCallExpression)) {
        if (["require", "import"].includes(call.getExpression().getText()) && Node.isStringLiteral(call.getArguments()[0])) specs.push((call.getArguments()[0] as import("ts-morph").StringLiteral).getLiteralValue());
      }
      for (const spec of specs) {
        if (!spec.startsWith(".")) {
          if (/\.css(?:$|[?#])/.test(spec)) {
            const key = "." + spec.slice(packageName.length);
            const candidates = spec.startsWith(packageName + "/") ? targets(pkg.exports?.[key]) : [];
            if (candidates.length && candidates.every((target) => inventory[target.replace(/^\.\//, "")] !== undefined)) styles.add(spec);
            else gaps.add(`Stylesheet ${spec} from ${file} cannot be carried through a verified public package asset.`);
          }
          continue;
        }
        const resolved = resolveLocal(inventory, file, spec);
        if (!resolved) { gaps.add(`Published setup dependency ${spec} from ${file} cannot be resolved for stylesheet preservation.`); continue; }
        if (/\.css$/.test(resolved)) {
          const exports = pkg.exports && typeof pkg.exports === "object" ? Object.entries(pkg.exports) : [];
          const exported = exports.find(([key, value]) => key.startsWith("./") && !key.includes("*") && targets(value).length > 0 && targets(value).every((target) => target === "./" + resolved));
          if (!pkg.exports) styles.add(packageName + "/" + resolved);
          else if (exported) styles.add(packageName + exported[0].slice(1));
          else gaps.add(`Stylesheet ${resolved} from ${file} has no unambiguous public package asset for insertion.`);
        } else if (/\.[cm]?[jt]sx?$/.test(resolved)) await visit(resolved);
      }
    };
    await visit(entry);
    return { styles: [...styles], gap: [...gaps].join(" ") || undefined };
  };
  const globalStyles = preview ? await stylesFor(preview) : { styles: [], gap: undefined };
  const globalSetup = preview ? setupExports(project.getSourceFile(preview)!) : { identities: [], provider: undefined, gap: false, reason: undefined };
  for (const file of files) {
    const stat = await fs.stat(path.join(root, file));
    if (stat.size > 200000) continue;
    const content = await fs.readFile(path.join(root, file), "utf8");
    const source = project.getSourceFile(file) ?? project.createSourceFile(file, content);
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
    const group: StoryGroup = result.get(exported) ?? { description, examples: [], setup: [], styles: [] };
    const localStyles = await stylesFor(file);
    group.styles = [...new Set([...group.styles, ...globalStyles.styles, ...localStyles.styles])];
    group.styleGap = [...new Set([group.styleGap, globalStyles.gap, localStyles.gap].filter(Boolean))].join(" ") || undefined;
    for (const variable of source.getVariableDeclarations()) {
      if (!variable.getVariableStatement()?.isExported()) continue;
      const story = unwrap(variable.getInitializer());
      if (!story || !Node.isObjectLiteralExpression(story)) continue;
      const props: Record<string, unknown> = {};
      let argsKnown = true;
      for (const owner of [meta, story]) {
        const args = owner.getProperty("args");
        if (!args) continue;
        const value = Node.isPropertyAssignment(args) ? literalValue(unwrap(args.getInitializer())) : undefined;
        if (!value || typeof value !== "object" || Array.isArray(value)) argsKnown = false;
        else Object.assign(props, value);
      }
      const render = story.getProperty("render") ?? meta.getProperty("render");
      const expression = render && Node.isPropertyAssignment(render) ? unwrap(render.getInitializer()) : render;
      const binding = component && Node.isPropertyAssignment(component) ? component.getInitializer()?.getSymbol()?.compilerSymbol : undefined;
      const renderSetup = expression ? setupExports(source, { expression, component: binding, props, argsKnown }) : { identities: [], provider: undefined, gap: false, children: typeof props.children === "string" ? props.children : undefined, reason: undefined };
      const providers = [globalSetup.provider, localSetup.provider, renderSetup.provider].filter((provider): provider is string => !!provider);
      const provider = providers.length === 1 ? providers[0] : undefined;
      if (globalSetup.gap || localSetup.gap || renderSetup.gap || (!render && !argsKnown) || providers.length > 1 || (group.examples.length && group.provider !== provider))
        group.insertionGap = render ? `The published render recipe ${file}#${variable.getName()} requires setup that cannot be carried into insertion unambiguously. ${renderSetup.reason ?? localSetup.reason ?? globalSetup.reason ?? "Its examples require inconsistent or multiple setup wrappers."} Keep its original render setup through a prompt, or ask the library maintainer for a reusable documented provider and example.` : "The published decorators require setup that cannot be carried into insertion unambiguously. Ask the library maintainer for a documented reusable provider or use a prompt retaining the published setup.";
      if (!group.examples.length) group.provider = provider;
      group.setup = [...new Set([...group.setup, ...globalSetup.identities, ...localSetup.identities, ...renderSetup.identities])];
      group.examples.push({
        name: variable.getName(),
        props,
        children: renderSetup.children,
        story: { file, export: variable.getName(), annotations: preview },
        source: content,
      });
    }
    if (group.examples.length) result.set(exported, group);
  }
  return result;
}
