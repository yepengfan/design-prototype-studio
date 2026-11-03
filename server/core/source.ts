import {
  Project,
  ts,
  SyntaxKind,
  Node,
  type JsxElement,
  type JsxSelfClosingElement,
  type SourceFile,
} from "ts-morph";
import { resolveLocal } from "./archive.js";
import { providerSetup, effectiveStorybookPreview } from "./providers.js";
import { componentReference } from "./component-reference.js";
import { digest } from "./files.js";
import { StudioError, type Component, type Property, type Files, type Manifest } from "./contracts.js";

type Element = JsxElement | JsxSelfClosingElement;
export type Anchor = {
  id: string;
  path: string;
  tag: string;
  start: number;
  end: number;
  parent?: string;
  slot?: string;
  props: Record<string, unknown>;
  controlled: string[];
  text?: string;
  dynamic: boolean;
  component?: Component;
};
const opening = (node: Element) =>
  Node.isJsxElement(node) ? node.getOpeningElement() : node;
const jsx = (node: Node): node is Element =>
  Node.isJsxElement(node) || Node.isJsxSelfClosingElement(node);
function parse(source: string) {
  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: { jsx: 4, noLib: true },
  });
  return project.createSourceFile("page.tsx", source);
}
export function literalValue(node: Node | undefined): unknown {
  if (!node) return undefined;
  if (Node.isParenthesizedExpression(node))
    return literalValue(node.getExpression());
  if (Node.isStringLiteral(node) || Node.isNumericLiteral(node))
    return node.getLiteralValue();
  if (node.getKind() === SyntaxKind.TrueKeyword) return true;
  if (node.getKind() === SyntaxKind.FalseKeyword) return false;
  if (node.getKind() === SyntaxKind.NullKeyword) return null;
  if (
    Node.isPrefixUnaryExpression(node) &&
    /^-\d+(?:\.\d+)?$/.test(node.getText())
  )
    return Number(node.getText());
  if (Node.isArrayLiteralExpression(node)) {
    const values = node.getElements().map(literalValue);
    return values.includes(undefined) ? undefined : values;
  }
  if (Node.isObjectLiteralExpression(node)) {
    const result: Record<string, unknown> = {};
    for (const property of node.getProperties()) {
      if (
        !Node.isPropertyAssignment(property) ||
        Node.isComputedPropertyName(property.getNameNode())
      )
        return undefined;
      const v = literalValue(property.getInitializer());
      if (v === undefined) return undefined;
      result[property.getName().replace(/^['"]|['"]$/g, "")] = v;
    }
    return result;
  }
  return undefined;
}
function value(text: string, attribute = false): unknown {
  const expression =
    attribute && text.startsWith("{") ? text.slice(1, -1) : text;
  return literalValue(
    parse(`const value = (${expression});`)
      .getVariableDeclaration("value")
      ?.getInitializer(),
  );
}
function nodes(file: SourceFile) {
  return file.getDescendants().filter(jsx);
}
function owningSlot(node: Element, parent: Element | undefined) {
  for (const ancestor of node.getAncestors()) {
    if (ancestor === parent) break;
    if (Node.isJsxAttribute(ancestor)) return ancestor.getNameNode().getText();
  }
  return undefined;
}
export function anchors(
  source: string,
  components: Component[] = [],
): Anchor[] {
  const file = parse(source);
  const imports = new Map<string, Component>();
  const bindings = new Map<string, import("typescript").Symbol | undefined>();
  for (const declaration of file.getImportDeclarations()) {
    for (const component of components.filter(
      (c) => c.package === declaration.getModuleSpecifierValue(),
    )) {
      const reference = componentReference(component.export);
      const named = declaration
        .getNamedImports()
        .find((n) => n.getName() === reference.root);
      const local =
        named?.getAliasNode()?.getText() ??
        named?.getName() ??
        (reference.root === "default"
          ? declaration.getDefaultImport()?.getText()
          : undefined);
      const namespace = declaration.getNamespaceImport();
      if (namespace) {
        imports.set(
          `${namespace.getText()}.${reference.root}${reference.suffix}`,
          component,
        );
        bindings.set(
          namespace.getText(),
          namespace.getSymbol()?.compilerSymbol,
        );
      }
      if (local) {
        imports.set(local + reference.suffix, component);
        const identifier =
          named?.getAliasNode() ??
          named?.getNameNode() ??
          declaration.getDefaultImport();
        bindings.set(local, identifier?.getSymbol()?.compilerSymbol);
      }
    }
  }
  const elements = nodes(file);
  const ids = new Map<Element, string>();
  // IDs are revision-scoped anchors. Every operation also checks the full source hash.
  for (const n of elements)
    ids.set(n, digest([n.getStart(), n.getText()]).slice(0, 16));
  const paths = new Map<Element, string>();
  const counters = new Map<string, number>();
  for (const node of elements) {
    const parent = node.getAncestors().find(jsx);
    const group =
      (parent ? paths.get(parent)! : "root") +
      "/" +
      (owningSlot(node, parent) ?? "children");
    const index = counters.get(group) ?? 0;
    counters.set(group, index + 1);
    paths.set(node, group + "/" + index);
  }
  return elements.map((n) => {
    const op = opening(n);
    const props: Record<string, unknown> = {};
    for (const a of op.getAttributes())
      if (Node.isJsxAttribute(a)) {
        const init = a.getInitializer();
        props[a.getNameNode().getText()] = init
          ? value(init.getText(), true)
          : true;
      }
    const controlled = new Set<string>();
    for (const attribute of op.getAttributes()) {
      if (Node.isJsxSpreadAttribute(attribute)) {
        for (const name of [...Object.keys(props), ...Object.keys(imports.get(op.getTagNameNode().getText())?.props ?? {}), ...(imports.get(op.getTagNameNode().getText())?.slots ?? []), "style"])
          controlled.add(name);
      } else if (Node.isJsxAttribute(attribute)) {
        const name = attribute.getNameNode().getText();
        if (props[name] === undefined) controlled.add(name);
        else controlled.delete(name);
      }
    }
    for (const name of controlled) props[name] = undefined;
    const ancestor = n.getAncestors().find(jsx);
    const tagNode = op.getTagNameNode();
    const tag = tagNode.getText();
    let root: Node = tagNode;
    while (Node.isPropertyAccessExpression(root)) root = root.getExpression();
    const component = imports.get(tag);
    const genuine =
      component &&
      Node.isIdentifier(root) &&
      root.getSymbol()?.compilerSymbol === bindings.get(root.getText());
    return {
      id: ids.get(n)!,
      path: paths.get(n)!,
      tag,
      start: n.getStart(),
      end: n.getEnd(),
      parent: ancestor ? ids.get(ancestor) : undefined,
      slot: owningSlot(n, ancestor),
      props,
      controlled: [...controlled],
      text:
        Node.isJsxElement(n) &&
        n
          .getJsxChildren()
          .every(
            (c) =>
              Node.isJsxText(c) ||
              (Node.isJsxExpression(c) &&
                c.getExpression() &&
                Node.isStringLiteral(c.getExpression()!)),
          )
          ? n
              .getJsxChildren()
              .map((c) =>
                Node.isJsxExpression(c)
                  ? (
                      c.getExpression() as import("ts-morph").StringLiteral
                    ).getLiteralValue()
                  : c.getText(),
              )
              .join("")
              .trim()
          : undefined,
      dynamic: n
        .getAncestors()
        .some(
          (a) => Node.isCallExpression(a) || Node.isConditionalExpression(a) ||
            (Node.isBinaryExpression(a) && [SyntaxKind.AmpersandAmpersandToken, SyntaxKind.BarBarToken, SyntaxKind.QuestionQuestionToken].includes(a.getOperatorToken().getKind())),
        ),
      component: genuine ? component : undefined,
    };
  });
}
export type Edit = {
  anchor: string;
  sourceHash: string;
  operation:
    | "prop"
    | "text"
    | "style"
    | "remove"
    | "duplicate"
    | "insert"
    | "move"
    | "wrap";
  property?: string;
  value?: unknown;
  component?: Component;
  parent?: string;
  slot?: string;
  index?: number;
  layout?: "flow" | "stack" | "grid";
  confirmedBusiness?: boolean;
};
type SourceContext = { files?: Files; file?: string; provider?: string };
function sourceProject(files: Files) {
  const project = new Project({ useInMemoryFileSystem: true, compilerOptions: { jsx: 4, moduleResolution: 100, allowJs: true, noLib: true } });
  for (const [name, source] of Object.entries(files))
    if (/\.[cm]?[jt]sx?$/.test(name)) project.createSourceFile("/" + name, source);
  return project;
}
function syntax(node: Node) {
  return ts.createPrinter({ removeComments: true }).printNode(ts.EmitHint.Unspecified, node.compilerNode, node.getSourceFile().compilerNode);
}
function behaviorProperty(name: string) {
  return /^on[A-Z]/.test(name) || ["role", "aria-live", "hidden", "inert", "disabled", "ref", "form", "required", "name"].includes(name);
}
function behaviorAttributes(element: Element) {
  return opening(element).getAttributes().some((attribute) =>
    Node.isJsxSpreadAttribute(attribute) || (Node.isJsxAttribute(attribute) &&
      behaviorProperty(attribute.getNameNode().getText())));
}
function setupIdentities(components: Component[], provider?: string, files: Files = {}) {
  return new Set([provider, ...components.flatMap((component) => [component.provider, ...(component.setup ?? [])])]
    .filter((value): value is string => !!value).map((value) => {
      const [module, exported = "default"] = value.split("#");
      return (module.startsWith("src/") ? resolveLocal(files, "entry.ts", "./" + module) ?? module : module) + "#" + exported;
    }));
}
function behaviorOwner(element: Element, setups: Set<string>) {
  const tag = opening(element).getTagNameNode();
  const origin = reference(tag);
  if (origin && (setups.has(origin.local ?? origin.module + "#" + origin.exported) ||
      (origin.module === "react" && ["Context", "Context.Provider"].includes(origin.exported)))) return true;
  if (["form", "fieldset", "label"].includes(tag.getText()) || behaviorAttributes(element)) return true;
  if (tag.getText() !== "legend") return false;
  const fieldset = element.getAncestors().find(jsx);
  return !!fieldset && opening(fieldset).getTagNameNode().getText() === "fieldset" &&
    nodes(fieldset.getSourceFile()).find((candidate) => opening(candidate).getTagNameNode().getText() === "legend" && candidate.getAncestors().find(jsx) === fieldset) === element;
}
function ownership(element: Element, setups: Set<string>) {
  return element.getAncestors().filter(jsx).filter((ancestor) => behaviorOwner(ancestor, setups));
}
function ownershipStates(file: SourceFile, setups: Set<string>) {
  const states = new Map<string, Map<string, number>>();
  for (const node of nodes(file)) {
    const key = syntax(node);
    const owners = ownership(node, setups).map((owner) => {
      const op = opening(owner);
      const origin = reference(op.getTagNameNode());
      return [origin?.local ?? (origin?.module ? origin.module + "#" + origin.exported : op.getTagNameNode().getText()),
        op.getAttributes().filter((attribute) => !Node.isJsxAttribute(attribute) || !["style", "className"].includes(attribute.getNameNode().getText())).map(syntax)];
    });
    const context = JSON.stringify([lexicalIdentity(node), owners, opening(node).getTagNameNode().getText() === "legend" ? behaviorOwner(node, setups) : null]);
    const counts = states.get(key) ?? new Map<string, number>();
    counts.set(context, (counts.get(context) ?? 0) + 1);
    states.set(key, counts);
  }
  return states;
}
export function editSource(source: string, edit: Edit, components: Component[], context: SourceContext = {}) {
  const result = editSourceUnchecked(source, edit, components, context);
  if (["move", "wrap", "remove", "duplicate", "insert"].includes(edit.operation)) {
    const name = context.file ?? "page.tsx";
    const setups = setupIdentities(components, context.provider, { ...context.files, [name]: source });
    const before = ownershipStates(sourceProject({ ...context.files, [name]: source }).getSourceFileOrThrow("/" + name), setups);
    const after = ownershipStates(sourceProject({ ...context.files, [name]: result }).getSourceFileOrThrow("/" + name), setups);
    for (const [key, next] of after) {
      const prior = before.get(key);
      if (!prior) continue;
      const delta = [...next.values()].reduce((a, b) => a + b, 0) - [...prior.values()].reduce((a, b) => a + b, 0);
      if ([...next].some(([owner, count]) => !prior.has(owner) || (delta <= 0 && count > prior.get(owner)!)) ||
          (delta >= 0 && [...prior].some(([owner, count]) => (next.get(owner) ?? 0) < count)))
        throw new StudioError("This edit changes behavioral, provider or fieldset ownership. Use a prompt to review the matching requirements.", 422);
    }
  }
  return result;
}
function editSourceUnchecked(
  source: string,
  edit: Edit,
  components: Component[],
  context: SourceContext,
) {
  if (edit.sourceHash !== digest(source))
    throw new StudioError(
      "Selection is stale. Select the component again.",
      409,
    );
  const found = anchors(source, components);
  const anchor = found.find((a) => a.id === edit.anchor);
  if (!anchor)
    throw new StudioError(
      "This selection is ambiguous or no longer exists. Select it again.",
      409,
    );
  const name = context.file ?? "page.tsx";
  const file = sourceProject({ ...context.files, [name]: source }).getSourceFileOrThrow("/" + name);
  const all = nodes(file);
  const node = all.find((n) => n.getStart() === anchor.start)!;
  const op = opening(node);
  if (edit.operation === "remove" && !anchor.parent)
    throw new StudioError(
      "Keep a page container. Select its contents to remove or rearrange them.",
    );
  if (
    anchor.dynamic &&
    ["move", "remove", "duplicate"].includes(edit.operation)
  )
    throw new StudioError(
      "This item repeats or depends on a condition. Use a prompt to preserve the matching scenario behavior.",
    );
  const behaviorBearing = (element: Element) =>
    ["form", "fieldset", "label"].includes(opening(element).getTagNameNode().getText()) || behaviorAttributes(element) ||
    element.getDescendants().some((child) => Node.isJsxExpression(child) &&
      !!child.getExpression() && literalValue(child.getExpression()) === undefined);
  const business =
    (edit.operation === "remove" &&
      (behaviorBearing(node) || !!anchor.component ||
        /^[A-Z]/.test(anchor.tag) ||
        found.some(
          (child) =>
            child.start > anchor.start &&
            child.end < anchor.end &&
            (child.component || /^[A-Z]/.test(child.tag) || behaviorBearing(all.find((node) => node.getStart() === child.start)!)),
        ))) ||
    (edit.operation === "prop" &&
      !!anchor.component?.props[edit.property ?? ""] &&
      businessPropertyChanged(
        anchor.component.props[edit.property!],
        anchor.props[edit.property!] ??
          anchor.component.props[edit.property!].default,
        edit.value,
      ));
  if (business && !edit.confirmedBusiness)
    throw new StudioError(
      "This edit can change a required interaction. Use a prompt to propose and confirm the matching requirements change.",
      422,
    );
  if (edit.operation === "prop") {
    const spec = anchor.component?.props[edit.property ?? ""];
    if (!spec)
      throw new StudioError(
        "The library does not document this editable property.",
      );
    if (edit.value !== undefined && !propertyValueValid(spec, edit.value))
      throw new StudioError(
        "This value does not match the documented component property.",
      );
    const existing = op.getAttribute(edit.property!);
    if (anchor.controlled.includes(edit.property!))
      throw new StudioError(
        "This setting is controlled by page behavior or a spread. Use a prompt to preserve it.",
      );
    if (
      existing &&
      Node.isJsxAttribute(existing) &&
      existing.getInitializer() &&
      value(existing.getInitializer()!.getText(), true) === undefined
    )
      throw new StudioError(
        "This property is controlled by page behavior. Change it through a prompt to preserve its controller.",
      );
    if (edit.value === undefined) {
      if (spec.required || op.getAttributes().some(Node.isJsxSpreadAttribute))
        throw new StudioError(
          "This setting cannot be cleared safely. Use a prompt.",
        );
      existing?.remove();
      return file.getFullText();
    }
    if (existing)
      existing.replaceWithText(
        `${edit.property}={${JSON.stringify(edit.value)}}`,
      );
    else
      op.addAttribute({
        name: edit.property!,
        initializer: `{${JSON.stringify(edit.value)}}`,
      });
  } else if (edit.operation === "text") {
    if (!Node.isJsxElement(node) || anchor.text === undefined)
      throw new StudioError(
        "This text contains behavior or nested content. Use a prompt.",
      );
    const children = node.getJsxChildren();
    const from = children[0]?.getStart() ?? node.getOpeningElement().getEnd();
    const to = children.at(-1)?.getEnd() ?? from;
    file.replaceText([from, to], `{${JSON.stringify(String(edit.value))}}`);
  } else if (edit.operation === "style") {
    const containers = [
      "div",
      "section",
      "main",
      "article",
      "aside",
      "header",
      "footer",
      "form",
    ];
    const textElements = [
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "p",
      "span",
      "strong",
      "em",
      "small",
      "label",
      "li",
    ];
    if (![...containers, ...textElements].includes(anchor.tag))
      throw new StudioError(
        "Use documented library properties for component styling.",
      );
    const typography = [
      "color",
      "backgroundColor",
      "fontFamily",
      "fontSize",
      "fontWeight",
      "lineHeight",
      "letterSpacing",
      "textAlign",
      "borderRadius",
    ];
    const layout = [
      "display",
      "flexDirection",
      "flexWrap",
      "alignItems",
      "justifyContent",
      "gap",
      "rowGap",
      "columnGap",
      "padding",
      "paddingTop",
      "paddingRight",
      "paddingBottom",
      "paddingLeft",
      "width",
      "height",
      "minWidth",
      "maxWidth",
      "minHeight",
      "maxHeight",
      "gridTemplateColumns",
      "gridTemplateRows",
      "alignContent",
    ];
    const allowed = containers.includes(anchor.tag)
      ? [...layout, ...typography]
      : typography;
    const settings = edit.value as Record<string, unknown>;
    if (
      !settings ||
      Array.isArray(settings) ||
      Object.entries(settings).some(
        ([key, value]) =>
          !allowed.includes(key) ||
          !["string", "number"].includes(typeof value),
      )
    )
      throw new StudioError("Unsupported literal style setting.");
    if (
      settings.display !== undefined &&
      !["block", "flex", "grid", "inline-flex", "inline-grid"].includes(
        String(settings.display),
      )
    )
      throw new StudioError("Choose flow, stack or grid for the container.");
    if (anchor.controlled.includes("style"))
      throw new StudioError("This style is behavior-owned. Use a prompt.");
    const existing = op.getAttribute("style");
    let current: Record<string, unknown> = {};
    if (existing && Node.isJsxAttribute(existing)) {
      const expression = existing
        .getFirstDescendantByKind(SyntaxKind.JsxExpression)
        ?.getExpression();
      if (!expression || !Node.isObjectLiteralExpression(expression))
        throw new StudioError("This style is behavior-owned. Use a prompt.");
      for (const p of expression.getProperties()) {
        if (!Node.isPropertyAssignment(p))
          throw new StudioError(
            "This style contains dynamic properties. Use a prompt.",
          );
        const v = value(p.getInitializerOrThrow().getText());
        if (v === undefined)
          throw new StudioError(
            "This style uses computed values. Use a prompt.",
          );
        current[p.getName().replace(/^['"]|['"]$/g, "")] = v;
      }
    }
    current = { ...current, ...settings };
    const initializer = `{${JSON.stringify(current)}}`;
    if (existing) existing.replaceWithText(`style=${initializer}`);
    else op.addAttribute({ name: "style", initializer });
  } else if (edit.operation === "remove") {
    const patch = removalPatch(node);
    file.replaceText([patch.start, patch.end], patch.text);
  } else if (edit.operation === "duplicate") {
    if (!anchor.parent)
      throw new StudioError(
        "Choose an item inside the page before duplicating it.",
      );
    if (anchor.slot) {
      const parentAnchor = found.find((a) => a.id === anchor.parent)!;
      const parent = all.find((n) => n.getStart() === parentAnchor.start)!;
      const siblings = found.filter(
        (a) => a.parent === anchor.parent && a.slot === anchor.slot,
      );
      const patch = slotPatch(
        parent,
        anchor.slot,
        node.getText(),
        siblings.findIndex((a) => a.id === anchor.id) + 1,
      );
      file.replaceText([patch.start, patch.end], patch.text);
    } else file.insertText(node.getEnd(), "\n" + node.getText());
  } else if (edit.operation === "wrap") {
    const style =
      edit.layout === "grid"
        ? { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }
        : edit.layout === "flow"
          ? { display: "block" }
          : { display: "flex", flexDirection: "column", gap: 16 };
    node.replaceWithText(
      `<section style={${JSON.stringify(style)}}>${node.getText()}</section>`,
    );
  } else if (edit.operation === "insert") {
    if (!edit.slot) assertChildrenSlot(anchor);
    if (
      edit.slot
        ? !anchor.component?.slots.includes(edit.slot)
        : anchor.component && !anchor.component.children
    )
      throw new StudioError(
        "This library component does not document a children slot.",
      );
    const c = components.find(
      (c) =>
        c.package === edit.component?.package &&
        c.export === edit.component?.export,
    );
    if (!c)
      throw new StudioError("Import and inspect this component library first.");
    if (
      c.requiresBehavior ||
      Object.entries(c.props).some(
        ([name, p]) =>
          p.required &&
          (p.business ||
            (p.default === undefined && !(name in c.examples[0].props))),
      )
    )
      throw new StudioError(
        "This component needs required business configuration. Use a prompt with complete requirements.",
        422,
      );
    if (c.insertionGap) throw new StudioError(c.insertionGap, 422);
    const reference = componentReference(c.export);
    let local: string;
    const declaration = file
      .getImportDeclarations()
      .find(
        (d) =>
          d.getModuleSpecifierValue() === c.package &&
          d.getNamedImports().some((n) => n.getName() === reference.root),
      );
    if (declaration) {
      const named = declaration
        .getNamedImports()
        .find((n) => n.getName() === reference.root)!;
      local = named.getAliasNode()?.getText() ?? named.getName();
    } else {
      local = `Library${digest([c.package, c.export]).slice(0, 8)}`;
      file.addImportDeclaration({
        moduleSpecifier: c.package,
        namedImports: [{ name: reference.root, alias: local }],
      });
    }
    local += reference.suffix;
    const example = c.examples[0];
    const attributes = Object.entries(example.props)
      .map(([p, v]) => `${p}={${JSON.stringify(v)}}`)
      .join(" ");
    let text = c.children
      ? `<${local} ${attributes}>{${JSON.stringify(example.children ?? c.name)}}</${local}>`
      : `<${local} ${attributes} />`;
    if (c.provider) {
      const setup = providerSetup(c.provider, "./", `Provider${digest([c.provider, source]).slice(0, 8)}`);
      const providerImport = parse(setup.imports).getImportDeclarations()[0];
      file.addImportDeclaration(providerImport.getStructure());
      text = setup.wrap(text);
    }
    if (edit.slot) {
      const patch = slotPatch(node, edit.slot, text, edit.index);
      file.replaceText([patch.start, patch.end], patch.text);
      return file.getFullText();
    }
    if (!Node.isJsxElement(node)) {
      const current = node.getText();
      file.replaceText(
        [node.getStart(), node.getEnd()],
        current.slice(0, -2) +
          ">" +
          text +
          `</${op.getTagNameNode().getText()}>`,
      );
      return file.getFullText();
    }
    const children = node.getJsxChildren();
    const pos =
      children[edit.index ?? children.length]?.getStart() ??
      node.getClosingElement().getStart();
    file.insertText(pos, "\n" + text + "\n");
  } else if (edit.operation === "move") {
    const target = found.find((a) => a.id === edit.parent);
    const parent = all.find((n) => n.getStart() === target?.start);
    if (
      !parent ||
      (!edit.slot && !Node.isJsxElement(parent)) ||
      parent === node ||
      node.getDescendants().includes(parent)
    )
      throw new StudioError("Choose a different supported parent container.");
    const setups = setupIdentities(components, context.provider, { ...context.files, [name]: source });
    const beforeOwners = ownership(node, setups);
    const afterOwners = ownership(parent, setups);
    if (behaviorOwner(parent, setups)) afterOwners.unshift(parent);
    if (target?.dynamic || beforeOwners.length !== afterOwners.length || beforeOwners.some((owner, index) => owner !== afterOwners[index]))
      throw new StudioError("This move changes conditional, provider or form ownership. Use a prompt to review the matching requirements.", 422);
    if (edit.slot) {
      if (!target?.component?.slots.includes(edit.slot))
        throw new StudioError("This parent does not document that slot.");
      const patch = slotPatch(
        parent,
        edit.slot,
        node.getText(),
        edit.index,
        node,
      );
      const patches = [patch];
      if (!(patch.start <= node.getStart() && patch.end >= node.getEnd()))
        patches.push(removalPatch(node));
      let result = source;
      for (const p of patches.sort((a, b) => b.start - a.start))
        result = result.slice(0, p.start) + p.text + result.slice(p.end);
      return result;
    }
    if (!Node.isJsxElement(parent))
      throw new StudioError("Choose a supported container.");
    if (target) assertChildrenSlot(target);
    const children = parent
      .getJsxChildren()
      .filter(jsx)
      .filter((c) => c !== node);
    const pos =
      children[edit.index ?? children.length]?.getStart() ??
      parent.getClosingElement().getStart();
    const text = node.getText();
    const start = node.getStart(),
      end = node.getEnd();
    if (pos >= start && pos <= end)
      throw new StudioError("Cannot move a node inside itself.");
    // Apply offsets in descending order to avoid stale AST references.
    const patches = [
      { start, end, text: removalPatch(node).text },
      { start: pos, end: pos, text: "\n" + text + "\n" },
    ].sort((a, b) => b.start - a.start);
    let result = source;
    for (const p of patches)
      result = result.slice(0, p.start) + p.text + result.slice(p.end);
    return result;
  }
  return file.getFullText();
}

function slotPatch(
  parent: Element,
  slot: string,
  inserted: string,
  index?: number,
  moved?: Element,
) {
  const op = opening(parent);
  const existing = op.getAttribute(slot);
  const attributes = op.getAttributes();
  if (attributes.some((attribute, index) => Node.isJsxSpreadAttribute(attribute) && (!existing || index > attributes.indexOf(existing))))
    throw new StudioError("This slot may be supplied by page behavior. Use a prompt to preserve it.");
  if (!existing)
    return {
      start: op.getTagNameNode().getEnd(),
      end: op.getTagNameNode().getEnd(),
      text: ` ${slot}={${inserted}}`,
    };
  if (!Node.isJsxAttribute(existing))
    throw new StudioError(
      "This slot is defined by page behavior. Use a prompt.",
    );
  const initializer = existing.getInitializer();
  const expression =
    initializer && Node.isJsxExpression(initializer)
      ? initializer.getExpression()
      : initializer;
  if (
    !expression ||
    !(
      jsx(expression) ||
      Node.isJsxFragment(expression) ||
      Node.isStringLiteral(expression) ||
      expression.getKind() === SyntaxKind.NullKeyword
    )
  )
    throw new StudioError(
      "This slot is controlled by page behavior. Use a prompt to preserve it.",
    );
  let content = expression.getText();
  if (Node.isJsxFragment(expression)) {
    const children = expression
      .getJsxChildren()
      .filter(jsx)
      .filter((child) => child !== moved);
    const position =
      children[index ?? children.length]?.getStart() ??
      expression.getClosingFragment().getStart();
    const patches = [
      {
        start: position - expression.getStart(),
        end: position - expression.getStart(),
        text: inserted,
      },
    ];
    if (
      moved &&
      moved.getStart() >= expression.getStart() &&
      moved.getEnd() <= expression.getEnd()
    )
      patches.push({
        start: moved.getStart() - expression.getStart(),
        end: moved.getEnd() - expression.getStart(),
        text: "",
      });
    for (const patch of patches.sort((a, b) => b.start - a.start))
      content =
        content.slice(0, patch.start) + patch.text + content.slice(patch.end);
  } else {
    if (
      moved &&
      moved.getStart() >= expression.getStart() &&
      moved.getEnd() <= expression.getEnd()
    )
      content =
        content.slice(0, moved.getStart() - expression.getStart()) +
        content.slice(moved.getEnd() - expression.getStart());
    if (Node.isStringLiteral(expression)) content = `{${content}}`;
    if (expression.getKind() === SyntaxKind.NullKeyword) content = "";
    content =
      index === 0 ? `<>${inserted}${content}</>` : `<>${content}${inserted}</>`;
  }
  return {
    start: existing.getStart(),
    end: existing.getEnd(),
    text: `${slot}={${content}}`,
  };
}

function propertyValueValid(spec: Property, value: unknown): boolean {
  if (spec.type === "enum")
    return typeof value === "string" && !!spec.options?.includes(value);
  if (spec.type === "object") {
    if (
      !spec.fields ||
      !value ||
      typeof value !== "object" ||
      Array.isArray(value)
    )
      return false;
    const fields = value as Record<string, unknown>;
    return (
      Object.keys(fields).every(
        (key) =>
          !!spec.fields![key] &&
          propertyValueValid(spec.fields![key], fields[key]),
      ) &&
      Object.entries(spec.fields).every(
        ([key, field]) => !field.required || key in fields,
      )
    );
  }
  return (
    typeof value === spec.type &&
    (spec.type !== "number" || Number.isFinite(value))
  );
}
function businessPropertyChanged(
  spec: Property,
  before: unknown,
  after: unknown,
): boolean {
  if (JSON.stringify(before) === JSON.stringify(after)) return false;
  if (spec.business) return true;
  if (spec.type === "object" && spec.fields)
    return Object.entries(spec.fields).some(([key, field]) =>
      businessPropertyChanged(
        field,
        (before as Record<string, unknown> | undefined)?.[key],
        (after as Record<string, unknown> | undefined)?.[key],
      ),
    );
  return false;
}

function assertChildrenSlot(anchor: Anchor) {
  if (
    anchor.component
      ? !anchor.component.children
      : ![
          "main",
          "div",
          "section",
          "article",
          "aside",
          "header",
          "footer",
          "form",
          "nav",
          "ul",
          "ol",
          "li",
          "fieldset",
        ].includes(anchor.tag)
  )
    throw new StudioError(
      "This group's editable regions are not established. Use a prompt to preserve its layout.",
    );
}

function removalPatch(node: Element) {
  const parent = node.getParent();
  return {
    start: node.getStart(),
    end: node.getEnd(),
    text: Node.isJsxElement(parent) || Node.isJsxFragment(parent) ? "" : "null",
  };
}

type Reference = { module: string; exported: string; local?: string };
function reference(node: Node, seen = new Set<Node>()): Reference | undefined {
    if (seen.has(node)) return undefined;
    seen.add(node);
    if (Node.isParenthesizedExpression(node) || Node.isAsExpression(node) || Node.isNonNullExpression(node))
      return reference(node.getExpression(), seen);
    if (Node.isPropertyAccessExpression(node)) {
      const base = reference(node.getExpression(), seen);
      return base && { ...base, exported: base.exported ? base.exported + "." + node.getName() : node.getName() };
    }
    if (Node.isExportSpecifier(node)) {
      const declaration = node.getFirstAncestorByKindOrThrow(SyntaxKind.ExportDeclaration);
      const module = declaration.getModuleSpecifierValue();
      if (module && !module.startsWith(".")) return { module, exported: node.getName() };
      for (const value of node.getLocalTargetSymbol()?.getDeclarations() ?? []) {
        const found = reference(value, seen);
        if (found) return found;
      }
      return undefined;
    }
    if (Node.isFunctionDeclaration(node) || Node.isClassDeclaration(node) || Node.isArrowFunction(node) || Node.isFunctionExpression(node))
      return { module: "", exported: "", local: node.getSourceFile().getFilePath().slice(1) + "#" + ((Node.isFunctionDeclaration(node) || Node.isClassDeclaration(node)) ? node.getName() ?? "default" : "default") };
    if (Node.isBindingElement(node)) {
      const pattern = node.getParent();
      const declaration = pattern.getParent();
      if (!Node.isObjectBindingPattern(pattern) || !Node.isVariableDeclaration(declaration) || node.getDotDotDotToken() || node.getInitializer()) return undefined;
      const initializer = declaration.getInitializer();
      const base = initializer && reference(initializer, seen);
      const property = node.getPropertyNameNode() ?? node.getNameNode();
      if (!Node.isIdentifier(property) && !Node.isStringLiteral(property)) return undefined;
      const name = Node.isStringLiteral(property) ? property.getLiteralValue() : property.getText();
      return base && { ...base, exported: base.exported ? base.exported + "." + name : name };
    }
    if (Node.isCallExpression(node)) {
      const callee = reference(node.getExpression(), seen);
      if (callee?.module === "react") {
        const name = callee.exported.replace(/^default\./, "");
        if (name === "createContext") return { module: "react", exported: "Context" };
        if (["memo", "forwardRef"].includes(name) && node.getArguments()[0]) return reference(node.getArguments()[0], seen);
      }
    }
    if (Node.isParameterDeclaration(node)) {
      const decorator = node.getParent();
      if ((Node.isArrowFunction(decorator) || Node.isFunctionExpression(decorator)) && decorator.getParameters()[0] === node) {
        const inDecorators = (input: Node) => {
          let container: Node = input.getParentOrThrow();
          while (Node.isParenthesizedExpression(container) || Node.isAsExpression(container) || Node.isSatisfiesExpression(container)) container = container.getParentOrThrow();
          const property = container.getParent();
          return Node.isArrayLiteralExpression(container) && Node.isPropertyAssignment(property) && property.getName() === "decorators";
        };
        if (inDecorators(decorator)) return { module: "", exported: "" };
        const declaration = decorator.getParent();
        if (Node.isVariableDeclaration(declaration)) {
          const binding = declaration.getNameNode().getSymbol()?.compilerSymbol;
          if (binding && node.getSourceFile().getDescendants().filter(Node.isIdentifier).some((identifier) => identifier.getSymbol()?.compilerSymbol === binding && inDecorators(identifier)))
            return { module: "", exported: "" };
        }
      }
    }
    if (Node.isVariableDeclaration(node)) {
      const initializer = node.getInitializer();
      return initializer && reference(initializer, seen);
    }
    if (Node.isImportSpecifier(node) || Node.isImportClause(node) || Node.isNamespaceImport(node)) {
      const declaration = node.getFirstAncestorByKindOrThrow(SyntaxKind.ImportDeclaration);
      const module = declaration.getModuleSpecifierValue();
      const exported = Node.isImportSpecifier(node) ? node.getName() : Node.isNamespaceImport(node) ? "" : "default";
      if (!module.startsWith(".")) return { module, exported };
      const target = declaration.getModuleSpecifierSourceFile();
      for (const declaration of target?.getExportDeclarations() ?? []) {
        const named = declaration.getNamedExports().find((item) => (item.getAliasNode()?.getText() ?? item.getName()) === exported);
        if (named) {
          const found = reference(named, seen);
          if (found) return found.module ? found : { ...found, local: target!.getFilePath().slice(1) + "#" + exported };
        }
      }
      const declarations = target?.getExportedDeclarations().get(exported) ?? [];
      for (const value of declarations) {
        const found = reference(value, seen);
        if (found) return found.module ? found : { ...found, local: target!.getFilePath().slice(1) + "#" + exported };
      }
      return undefined;
    }
    if (Node.isIdentifier(node))
      for (const declaration of node.getSymbol()?.getDeclarations() ?? []) {
        const found = reference(declaration, seen);
        if (found) return found;
      }
    return undefined;
  }

function replacementControl(tag: string, properties: { name?: string; value?: unknown }[]) {
  const roles = new Set(["button", "checkbox", "combobox", "link", "listbox", "menuitem", "option", "radio", "scrollbar", "searchbox", "slider", "spinbutton", "switch", "tab", "textbox", "treeitem"]);
  return ["button", "input", "select", "textarea", "dialog", "a", "summary", "details"].includes(tag) ||
    properties.some(({ name, value }) => {
      if (!name) return true;
      if (name === "role") return typeof value !== "string" || roles.has(value);
      if (tag === "form" && name === "onSubmit") return false;
      return /^on[A-Z]/.test(name) || ["tabIndex", "contentEditable", "controls"].includes(name);
    });
}

function localSpecifiers(file: SourceFile) {
  return [
      ...file.getImportDeclarations().map((declaration) => declaration.getModuleSpecifierValue()),
      ...file.getExportDeclarations().map((declaration) => declaration.getModuleSpecifierValue()),
      ...file.getDescendants().filter(Node.isCallExpression).filter((call) => ["import", "require"].includes(call.getExpression().getText())).map((call) => {
        const argument = call.getArguments()[0];
        return argument && Node.isStringLiteral(argument) ? argument.getLiteralValue() : undefined;
      }),
  ];
}
function sourceClosure(project: Project, files: Files, manifest: Manifest) {
  const roots = [
    ...Object.keys(files).filter((name) => name.startsWith("src/") || /\.stories\.[cm]?[jt]sx?$/.test(name)),
    ...(effectiveStorybookPreview(files) ? [effectiveStorybookPreview(files)!] : []),
    ...manifest.pages.flatMap((page) => [page.file, ...(page.previewStory ? [page.previewStory.split("#")[0]] : [])]),
    ...manifest.scenarios.flatMap((scenario) => [scenario.fixture, scenario.story.split("#")[0]]),
    ...(manifest.provider ? [manifest.provider.split("#")[0]] : []),
    ...[...(files["index.html"] ?? "").matchAll(/<script\b[^>]*\bsrc=["']\/?([^"']+)["']/g)].map((match) => match[1]),
  ];
  const accepted = new Set<SourceFile>();
  const pending = roots.map((name) => project.getSourceFile("/" + name)).filter((file): file is SourceFile => !!file);
  while (pending.length) {
    const file = pending.pop()!;
    if (accepted.has(file)) continue;
    accepted.add(file);
    for (const specifier of localSpecifiers(file)) {
      if (!specifier?.startsWith(".")) continue;
      const name = resolveLocal(files, file.getFilePath().slice(1), specifier);
      const dependency = name && project.getSourceFile("/" + name);
      if (dependency) pending.push(dependency);
    }
  }
  return accepted;
}
export function localSourceClosure(files: Files, roots: string[]) {
  const project = sourceProject(files);
  const accepted = new Set<string>();
  const pending = [...roots];
  while (pending.length) {
    const name = pending.pop()!;
    if (accepted.has(name)) continue;
    accepted.add(name);
    const file = project.getSourceFile("/" + name);
    if (!file) continue;
    for (const specifier of localSpecifiers(file)) {
      if (!specifier?.startsWith(".")) continue;
      const dependency = resolveLocal(files, name, specifier);
      if (dependency) pending.push(dependency);
    }
  }
  return accepted;
}
type ControlProperty = { name?: string; value?: unknown; expression?: string };
function lexicalIdentity(node: Node) {
  return node.getAncestors().filter((ancestor) => Node.isFunctionDeclaration(ancestor) || Node.isArrowFunction(ancestor) || Node.isFunctionExpression(ancestor) || Node.isMethodDeclaration(ancestor))
    .map((fn) => {
      if (Node.isFunctionDeclaration(fn) || Node.isFunctionExpression(fn) || Node.isMethodDeclaration(fn)) return fn.getName() ?? "default";
      const parent = fn.getParentOrThrow();
      if (Node.isVariableDeclaration(parent) || Node.isPropertyAssignment(parent)) return parent.getName();
      return syntax(parent).split("=>")[0];
    });
}
// Preserve a legacy control only while its statically visible execution context
// remains unchanged. Changed or ambiguous runtime context requires a library-backed
// implementation; this deliberately does not evaluate arbitrary JavaScript.
function presentationAttribute(op: ReturnType<typeof opening>, attribute: Node, components: Component[]) {
  if (!Node.isJsxAttribute(attribute)) return false;
  const initializer = attribute.getInitializer();
  const expression = initializer && Node.isJsxExpression(initializer) ? initializer.getExpression() : initializer;
  if (initializer && literalValue(expression) === undefined) return false;
  const name = attribute.getNameNode().getText();
  if (["style", "className"].includes(name)) return true;
  const origin = reference(op.getTagNameNode());
  const property = components.find((component) => component.package === origin?.module && component.export === origin.exported)?.props[name];
  const visual = (property: Property): boolean => !property.business && Object.values(property.fields ?? {}).every(visual);
  return !!property && visual(property);
}
function factoryContext(call: import("ts-morph").CallExpression, components: Component[]) {
  const [target, props] = call.getArguments();
  const origin = target && reference(target);
  const component = components.find((component) => component.package === origin?.module && component.export === origin.exported);
  const visual = (property: Property): boolean => !property.business && Object.values(property.fields ?? {}).every(visual);
  if (!props || props.getKind() === SyntaxKind.NullKeyword || props.getText() === "undefined") return [];
  if (!Node.isObjectLiteralExpression(props)) return [syntax(props)];
  return props.getProperties().filter((property) => {
    if (!Node.isPropertyAssignment(property)) return true;
    const name = property.getName().replace(/^["']|["']$/g, "");
    return literalValue(property.getInitializer()) === undefined ||
      (!["style", "className"].includes(name) && (!component?.props[name] || !visual(component.props[name])));
  }).map(syntax);
}
function controlExecutionContext(node: Node, components: Component[] = []) {
  const file = node.getSourceFile();
  const factories = new Set(file.getDescendants().filter(Node.isCallExpression).filter((call) => {
    const target = reference(call.getExpression());
    return target?.module === "react" && ["createElement", "default.createElement"].includes(target.exported);
  }).map((call) => call.getStart()));
  const runtimeSyntax = (input: Node) => {
    const transformed = ts.transform(input.compilerNode, [(context) => {
      const visit: ts.Visitor = (value) => {
        if (ts.isJsxElement(value) || ts.isJsxSelfClosingElement(value) || ts.isJsxFragment(value) ||
            (ts.isCallExpression(value) && factories.has(value.getStart(file.compilerNode))))
          return ts.factory.createNull();
        return ts.visitEachChild(value, visit, context);
      };
      return (root) => ts.visitNode(root, visit) as typeof root;
    }]);
    try { return ts.createPrinter({removeComments:true}).printNode(ts.EmitHint.Unspecified, transformed.transformed[0], file.compilerNode); }
    finally { transformed.dispose(); }
  };
  const functions = node.getAncestors().filter((parent) => Node.isFunctionDeclaration(parent) || Node.isArrowFunction(parent) || Node.isFunctionExpression(parent) || Node.isMethodDeclaration(parent) || Node.isClassDeclaration(parent));
  const guards = node.getAncestors().flatMap((parent) => {
    if (Node.isCallExpression(parent)) {
      const callee = reference(parent.getExpression());
      if (callee?.module === "react" && ["createElement", "default.createElement"].includes(callee.exported)) {
        const props = factoryContext(parent, components);
        const target = parent.getArguments()[0];
        return props.length || (target && Node.isStringLiteral(target) && ["form", "fieldset", "label"].includes(target.getLiteralValue())) ? [target ? syntax(target) : "missing target", props] : [];
      }
      return [runtimeSyntax(parent)];
    }
    if (Node.isJsxElement(parent) || Node.isJsxAttribute(parent)) {
      const owner = Node.isJsxElement(parent) ? parent.getOpeningElement() : parent.getAncestors().find((ancestor) => Node.isJsxOpeningElement(ancestor) || Node.isJsxSelfClosingElement(ancestor));
      if (Node.isJsxOpeningElement(owner) || Node.isJsxSelfClosingElement(owner)) {
        const attributes = owner.getAttributes().filter((attribute) => !presentationAttribute(owner, attribute, components));
        if (attributes.length || ["form", "fieldset", "label"].includes(owner.getTagNameNode().getText())) return [owner.getTagNameNode().getText(), ...attributes.map(runtimeSyntax)];
      }
    }
    if (Node.isConditionalExpression(parent)) return [syntax(parent.getCondition()), node.getStart() < parent.getWhenFalse().getStart() ? "true-branch" : "false-branch"];
    if (Node.isBinaryExpression(parent) && [SyntaxKind.AmpersandAmpersandToken, SyntaxKind.BarBarToken, SyntaxKind.QuestionQuestionToken].includes(parent.getOperatorToken().getKind()))
      return [syntax(parent.getLeft()), parent.getOperatorToken().getText()];
    if (Node.isIfStatement(parent)) return [syntax(parent.getExpression()), node.getStart() < (parent.getElseStatement()?.getStart() ?? Infinity) ? "then" : "else"];
    return [];
  });
  return [guards, functions.map(runtimeSyntax), file.getVariableStatements().map(runtimeSyntax)];
}
function renderOrigin(node: Node, seen = new Set<Node>()): Node | undefined {
  if (seen.has(node)) return undefined;
  seen.add(node);
  if (Node.isFunctionDeclaration(node) || Node.isArrowFunction(node) || Node.isFunctionExpression(node) || Node.isMethodDeclaration(node) || Node.isClassDeclaration(node)) return node;
  if (Node.isParenthesizedExpression(node) || Node.isAsExpression(node) || Node.isSatisfiesExpression(node)) return renderOrigin(node.getExpression(), seen);
  if (Node.isVariableDeclaration(node) || Node.isExportAssignment(node)) {
    const input = Node.isVariableDeclaration(node) ? node.getInitializer() : node.getExpression();
    if (!input) return undefined;
    if (Node.isVariableDeclaration(node) && !Node.isIdentifier(input) && !Node.isPropertyAccessExpression(input) && !Node.isArrowFunction(input) && !Node.isFunctionExpression(input)) return node;
    return renderOrigin(input, seen);
  }
  if (Node.isCallExpression(node)) {
    const callee = reference(node.getExpression());
    if (callee?.module === "react" && ["memo", "forwardRef", "default.memo", "default.forwardRef"].includes(callee.exported)) {
      const input = node.getArguments()[0];
      return input && renderOrigin(input, seen);
    }
  }
  if (Node.isBindingElement(node)) return node.getFirstAncestorByKind(SyntaxKind.VariableDeclaration);
  const parent = node.getParent();
  const symbol = Node.isShorthandPropertyAssignment(parent) ? parent.getValueSymbol() : node.getSymbol();
  for (const declaration of (symbol?.getAliasedSymbol() ?? symbol)?.getDeclarations() ?? []) {
    const found = renderOrigin(declaration, seen);
    if (found) return found;
  }
  return undefined;
}
export function presentationText(node: Node) {
  if (Node.isJsxText(node) || (Node.isJsxExpression(node) && ["string", "number"].includes(typeof literalValue(node.getExpression())))) {
    const owner = node.getParent();
    return Node.isJsxElement(owner) && /^(?:h[1-6]|p|span|small|strong|em|div|section|article|aside|main|header|footer)$/.test(opening(owner).getTagNameNode().getText()) && !behaviorAttributes(owner);
  }
  const parent = node.getParent();
  if ((Node.isStringLiteral(node) || Node.isNumericLiteral(node)) && Node.isCallExpression(parent) && parent.getArguments().indexOf(node) >= 2) {
    const callee = reference(parent.getExpression());
    const [target, props] = parent.getArguments();
    const behavior = props && props.getKind() !== SyntaxKind.NullKeyword && props.getText() !== "undefined" &&
      (!Node.isObjectLiteralExpression(props) || props.getProperties().some((property) =>
        Node.isSpreadAssignment(property) || Node.isComputedPropertyName(property.getNameNode()) || behaviorProperty(property.getName().replace(/^["']|["']$/g, ""))));
    return callee?.module === "react" && ["createElement", "default.createElement"].includes(callee.exported) && !!target && Node.isStringLiteral(target) && /^(?:h[1-6]|p|span|small|strong|em|div|section|article|aside|main|header|footer)$/.test(target.getLiteralValue()) && !behavior;
  }
  return false;
}
function nativeRenderUses(input: Iterable<SourceFile>, components: Component[], libraries: Manifest["libraries"]) {
  const files = [...input];
  const calls = new Map<Node, Node[]>();
  const origins = new Map<Node, Node | undefined>();
  const resolve = (node: Node) => {
    if (!origins.has(node)) origins.set(node, renderOrigin(node));
    return origins.get(node);
  };
  const externalIdentity = (target: Node | undefined): unknown[] => {
    const origin = target && reference(target);
    if (!origin?.module) return [];
    const library = libraries.find((library) => origin.module === library.name || origin.module.startsWith(library.name + "/"));
    const component = components.find((component) => origin.module === component.package || origin.module.startsWith(component.package + "/"));
    return [["external consumer", origin.module, library?.version ?? component?.version ?? null, origin.exported]];
  };
  const shapes = new Map<Node, unknown[]>();
  const renderShape = (node: Node): unknown[] => {
    if (presentationText(node)) return [];
    if (Node.isCallExpression(node)) {
      const callee = reference(node.getExpression());
      if (callee?.module === "react" && ["createElement", "default.createElement"].includes(callee.exported)) {
        const [target, , ...values] = node.getArguments();
        const props = factoryContext(node, components);
        const children = values.flatMap(renderShape);
        if (target && Node.isStringLiteral(target) && ["main", "div", "section", "article", "aside", "span"].includes(target.getLiteralValue()) && !props.length) return children;
        return ["element", externalIdentity(target).length ? externalIdentity(target) : target ? syntax(target) : "missing target", props, children];
      }
    }
    if (Node.isJsxFragment(node)) return node.getJsxChildren().flatMap(renderShape);
    if (Node.isJsxExpression(node)) return node.getExpression() ? renderShape(node.getExpression()!) : [];
    if (Node.isJsxText(node)) return node.getText().trim() ? [node.getText().trim()] : [];
    if (jsx(node)) {
      const op = opening(node);
      const props = op.getAttributes().filter((attribute) => !presentationAttribute(op, attribute, components));
      const children = Node.isJsxElement(node) ? node.getJsxChildren().flatMap(renderShape) : [];
      if (["main", "div", "section", "article", "aside", "span"].includes(op.getTagNameNode().getText()) && !props.length) return children;
      return ["element", externalIdentity(op.getTagNameNode()).length ? externalIdentity(op.getTagNameNode()) : op.getTagNameNode().getText(), props.flatMap(renderShape), children];
    }
    const children = node.getChildren();
    return children.length ? children.flatMap(renderShape) : [node.getKindName(), node.getText()];
  };
  const dependencies = (target: Node | undefined) => {
    const pending = target ? [resolve(target)] : [];
    const seen = new Set<Node>();
    const result: unknown[] = externalIdentity(target);
    const external = new Set<string>(result.map((identity) => JSON.stringify(identity)));
    while (pending.length) {
      const origin = pending.pop();
      if (!origin || seen.has(origin)) continue;
      seen.add(origin);
      if (!shapes.has(origin)) shapes.set(origin, renderShape(origin));
      result.push([origin.getSourceFile().getFilePath(), shapes.get(origin)]);
      for (const identifier of origin.getDescendants().filter(Node.isIdentifier)) {
        for (const identity of externalIdentity(identifier)) {
          const key = JSON.stringify(identity);
          if (!external.has(key)) { external.add(key); result.push(identity); }
        }
        pending.push(resolve(identifier));
      }
    }
    return result;
  };
  for (const file of files) for (const node of file.getDescendants()) {
    let target: Node | undefined;
    if (Node.isJsxOpeningElement(node) || Node.isJsxSelfClosingElement(node)) target = node.getTagNameNode();
    if (Node.isCallExpression(node)) {
      const callee = reference(node.getExpression());
      target = callee?.module === "react" && ["createElement", "default.createElement"].includes(callee.exported) ? node.getArguments()[0] : node.getExpression();
    }
    if (!target && Node.isIdentifier(node)) {
      const parent = node.getParent();
      if (node.getAncestors().some((ancestor) => Node.isImportDeclaration(ancestor) || Node.isExportDeclaration(ancestor)) ||
          ((Node.isFunctionDeclaration(parent) || Node.isFunctionExpression(parent) || Node.isClassDeclaration(parent) || Node.isVariableDeclaration(parent) || Node.isParameterDeclaration(parent)) && parent.getNameNode() === node) ||
          (Node.isVariableDeclaration(parent) && parent.getInitializer() === node) ||
          Node.isJsxOpeningElement(parent) || Node.isJsxClosingElement(parent) || Node.isJsxSelfClosingElement(parent) ||
          (Node.isCallExpression(parent) && (parent.getExpression() === node ||
            (parent.getArguments()[0] === node && reference(parent.getExpression())?.module === "react" &&
              ["createElement", "default.createElement"].includes(reference(parent.getExpression())!.exported))))) continue;
      target = node;
    }
    const fn = target && resolve(target);
    if (fn) calls.set(fn, [...(calls.get(fn) ?? []), node]);
  }
  const signature = (call: Node) => {
    if (Node.isJsxOpeningElement(call) || Node.isJsxSelfClosingElement(call))
      return call.getAttributes().filter((attribute) => !presentationAttribute(call, attribute, components)).map(syntax);
    if (Node.isCallExpression(call)) {
      const callee = reference(call.getExpression());
      if (callee?.module === "react" && ["createElement", "default.createElement"].includes(callee.exported)) {
        const [target, , ...children] = call.getArguments();
        return [factoryContext(call, components), target ? dependencies(target) : [], children.map(syntax)];
      }
    }
    if (Node.isIdentifier(call)) {
      const parent = call.getParentOrThrow();
      if (Node.isCallExpression(parent) && parent.getArguments().indexOf(call) >= 2) {
        const callee = reference(parent.getExpression());
        if (callee?.module === "react" && ["createElement", "default.createElement"].includes(callee.exported))
          return ["child", dependencies(parent.getArguments()[0])];
      }
      if (Node.isJsxExpression(parent) && parent.getExpression() === call) {
        const attribute = parent.getParent();
        if (Node.isJsxAttribute(attribute)) {
          const owner = attribute.getAncestors().find((ancestor) => Node.isJsxOpeningElement(ancestor) || Node.isJsxSelfClosingElement(ancestor));
          return ["slot", attribute.getNameNode().getText(), owner ? dependencies(owner.getTagNameNode()) : []];
        }
        const owner = parent.getParent();
        return ["child", Node.isJsxElement(owner) ? dependencies(owner.getOpeningElement().getTagNameNode()) : []];
      }
      const consumer = call.getAncestors().find((ancestor) => Node.isCallExpression(ancestor) || Node.isJsxAttribute(ancestor));
      let target: Node | undefined;
      if (consumer && Node.isCallExpression(consumer)) {
        const callee = reference(consumer.getExpression());
        target = callee?.module === "react" && ["createElement", "default.createElement"].includes(callee.exported) ? consumer.getArguments()[0] : consumer.getExpression();
      } else if (consumer && Node.isJsxAttribute(consumer)) {
        const owner = consumer.getAncestors().find((ancestor) => Node.isJsxOpeningElement(ancestor) || Node.isJsxSelfClosingElement(ancestor));
        target = owner?.getTagNameNode();
      }
      return ["unknown consumption", syntax(parent), dependencies(target)];
    }
    return syntax(call);
  };
  const execution = new Map<Node, unknown[]>();
  const executionDependencies = (node: Node) => {
    if (execution.has(node)) return execution.get(node)!;
    const result = node.getAncestors().flatMap((ancestor) => {
    let inputs: Node[] = [];
    let consumer: Node | undefined;
    if (jsx(ancestor)) consumer = opening(ancestor).getTagNameNode();
    if (Node.isConditionalExpression(ancestor)) inputs = [ancestor.getCondition()];
    else if (Node.isIfStatement(ancestor)) inputs = [ancestor.getExpression()];
    else if (Node.isBinaryExpression(ancestor) && [SyntaxKind.AmpersandAmpersandToken, SyntaxKind.BarBarToken, SyntaxKind.QuestionQuestionToken].includes(ancestor.getOperatorToken().getKind())) inputs = [ancestor.getLeft()];
    else if (Node.isCallExpression(ancestor)) {
      const callee = reference(ancestor.getExpression());
      const factory = callee?.module === "react" && ["createElement", "default.createElement"].includes(callee.exported);
      inputs = factory ? ancestor.getArguments().slice(1, 2) : [ancestor];
      if (factory) consumer = ancestor.getArguments()[0];
    }
    return [...dependencies(consumer), ...inputs.flatMap((input) => [input, ...input.getDescendants()].filter(Node.isIdentifier)
      .filter((identifier) => !identifier.getAncestors().some((parent) => jsx(parent) && input.getStart() <= parent.getStart() && parent.getEnd() <= input.getEnd()))
      .flatMap((identifier) => dependencies(identifier)))];
    });
    execution.set(node, result);
    return result;
  };
  const frames = new Map<Node, unknown[]>();
  const context = (node: Node, seen = new Set<Node>()): unknown[][] => {
    let fn: Node | undefined = node.getAncestors().find((parent) => Node.isVariableDeclaration(parent) || Node.isFunctionDeclaration(parent) || Node.isArrowFunction(parent) || Node.isFunctionExpression(parent) || Node.isMethodDeclaration(parent));
    if (fn && Node.isMethodDeclaration(fn) && Node.isClassDeclaration(fn.getParent())) fn = fn.getParent();
    if (!fn) return [[]];
    if (!calls.has(fn)) {
      const parent = fn.getParent();
      if (Node.isCallExpression(parent))
        return context(fn, seen).map((parents) => [["callback consumption", dependencies(parent.getExpression())], ...parents]);
      return context(fn, seen);
    }
    if (seen.has(fn)) throw new StudioError("Recursive native render-use consumption cannot be preserved safely. Resolve this compatibility gap before acceptance.", 422);
    const next = new Set([...seen, fn]);
    return calls.get(fn)!.flatMap((call) => {
      if (!frames.has(call)) frames.set(call, [call.getSourceFile().getFilePath(), lexicalIdentity(call), controlExecutionContext(call, components), signature(call)]);
      return context(call, next).map((parents) => [[frames.get(call)!, executionDependencies(call)], ...parents]);
    });
  };
  return (node: Node) => context(node).map((parents) => {
    const dependencies = executionDependencies(node);
    return parents.length || dependencies.length ? [["execution dependencies", dependencies], ...parents] : [];
  });
}
export function validateCapabilities(files: Files, manifest: Manifest, previous: Files | Files[] = files) {
  const project = sourceProject(files);
  const allowed = new Set([
    ...setupIdentities(manifest.libraries.flatMap((library) => library.components), manifest.provider, files),
    ...manifest.libraries.flatMap((library) => library.components.map((component) => component.package + "#" + component.export)),
  ]);
  const known = ["react", "react-dom", ...manifest.libraries.map((library) => library.name)];
  const check = (node: Node, intrinsic = false) => {
    const origin = reference(node);
    if (intrinsic && Node.isIdentifier(node) && /^[a-z]/.test(node.getText())) return;
    if (Node.isStringLiteral(node)) return;
    if (!origin) throw new StudioError(`The component reference ${node.getText()} cannot be identified safely. Use a direct documented import or resolve this source compatibility gap before acceptance.`, 422);
    if (!origin.module || ["react", "react-dom"].some((module) => origin.module === module || origin.module.startsWith(module + "/"))) return;
    if (!allowed.has(origin.module + "#" + origin.exported))
      throw new StudioError(`Library capability ${origin.module}#${origin.exported} is not admitted. Ask the library maintainer for documented setup and examples in an updated release.`, 422);
  };
  const controls = new Map<string, number>();
  let invocations: ReturnType<typeof nativeRenderUses>;
  const nativeControl = (file: SourceFile, expression: Node, tag: string, properties: ControlProperty[], collecting: boolean) => {
    if (!replacementControl(tag, properties)) return;
    const key = JSON.stringify([file.getFilePath(), lexicalIdentity(expression), expression.getAncestors().filter(Node.isVariableDeclaration).map((declaration) => declaration.getName()), controlExecutionContext(expression, manifest.libraries.flatMap((library) => library.components)), tag,
      properties.filter((property) => !["style", "className"].includes(property.name ?? "") || property.value === undefined).map((property) => [property.name, property.value === undefined ? property.expression : property.value])]);
    for (const occurrence of [key, ...invocations(expression).filter((context) => context.length).map((context) => JSON.stringify([key, context]))]) {
      const remaining = controls.get(occurrence) ?? 0;
      if (!collecting && !remaining)
        throw new StudioError(`The proposal invents or repeats a historical ${tag} control, or changes its preserved execution/use context in ${file.getFilePath().slice(1)} through ${expression.getAncestors().find(Node.isVariableDeclaration)?.getName() ?? lexicalIdentity(expression)[0] ?? "the page"}. Studio cannot establish preservation safely; keep this region unchanged or use an admitted library capability.`, 422);
      controls.set(occurrence, remaining + (collecting ? 1 : -1));
    }
  };
  const inspect = (file: SourceFile, collecting: boolean) => {
    if (!collecting)
      for (const declaration of file.getImportDeclarations()) {
        const specifier = declaration.getModuleSpecifierValue();
        if (!specifier.startsWith(".") && !specifier.startsWith("@storybook/") && !known.some((name) => specifier === name || specifier.startsWith(name + "/")))
          throw new StudioError(`The proposal uses an unadmitted package: ${specifier}. Import and inspect that library first.`, 422);
      }
    for (const node of file.getDescendants()) {
      if (Node.isJsxOpeningElement(node) || Node.isJsxSelfClosingElement(node)) {
        const tag = node.getTagNameNode();
        if (!collecting) check(tag, true);
        if (Node.isIdentifier(tag) && /^[a-z]/.test(tag.getText())) {
          const expression = Node.isJsxOpeningElement(node) ? node.getParent() : node;
          nativeControl(file, expression, tag.getText(), node.getAttributes().map((attribute) => {
            if (!Node.isJsxAttribute(attribute)) return { expression: syntax(attribute) };
            const initializer = attribute.getInitializer();
            const input = initializer && Node.isJsxExpression(initializer) ? initializer.getExpression() : initializer;
            return { name: attribute.getNameNode().getText(), value: initializer ? literalValue(input) : true, expression: input ? syntax(input) : undefined };
          }), collecting);
        }
      }
      if (Node.isCallExpression(node)) {
        const callee = reference(node.getExpression());
        if (callee?.module !== "react" || !["createElement", "default.createElement"].includes(callee.exported)) continue;
        const [target, props] = node.getArguments();
        if (!target) throw new StudioError("The React factory target is missing.", 422);
        if (!collecting) check(target);
        if (!Node.isStringLiteral(target)) continue;
        const properties: ControlProperty[] = [];
        if (props && props.getKind() !== SyntaxKind.NullKeyword && !(Node.isIdentifier(props) && props.getText() === "undefined")) {
          if (!Node.isObjectLiteralExpression(props)) throw new StudioError("React factory properties cannot be identified safely. Use explicit properties before acceptance.", 422);
          for (const property of props.getProperties()) {
            if ((!Node.isPropertyAssignment(property) && !Node.isShorthandPropertyAssignment(property) && !Node.isMethodDeclaration(property)) || Node.isComputedPropertyName(property.getNameNode()))
              throw new StudioError("React factory properties cannot be identified safely. Use explicit properties before acceptance.", 422);
            const input = Node.isPropertyAssignment(property) ? property.getInitializer() : Node.isShorthandPropertyAssignment(property) ? property.getNameNode() : property;
            properties.push({ name: property.getName().replace(/^['"]|['"]$/g, ""), value: literalValue(input), expression: input ? syntax(input) : undefined });
          }
        }
        nativeControl(file, node, target.getLiteralValue(), properties, collecting);
      }
    }
  };
  const preserved = new Map<string, number>();
  for (const prior of Array.isArray(previous) ? previous : [previous]) {
    controls.clear();
    const closure = sourceClosure(prior === files ? project : sourceProject(prior), prior, manifest);
    invocations = nativeRenderUses(closure, manifest.libraries.flatMap((library) => library.components), prior["studio.project.json"] ? JSON.parse(prior["studio.project.json"]).libraries ?? manifest.libraries : manifest.libraries);
    for (const file of closure) inspect(file, true);
    for (const [key, count] of controls) preserved.set(key, Math.max(preserved.get(key) ?? 0, count));
  }
  controls.clear();
  for (const [key, count] of preserved) controls.set(key, count);
  const closure = sourceClosure(project, files, manifest);
  invocations = nativeRenderUses(closure, manifest.libraries.flatMap((library) => library.components), manifest.libraries);
  for (const file of closure) inspect(file, false);
}
