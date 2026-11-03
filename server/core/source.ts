import {
  Project,
  SyntaxKind,
  Node,
  type JsxElement,
  type JsxSelfClosingElement,
  type SourceFile,
} from "ts-morph";
import { providerSetup } from "./providers.js";
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
    compilerOptions: { jsx: 4 },
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
export function editSource(
  source: string,
  edit: Edit,
  components: Component[],
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
  const file = parse(source);
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
  const business =
    (edit.operation === "remove" &&
      (!!anchor.component ||
        /^[A-Z]/.test(anchor.tag) ||
        found.some(
          (child) =>
            child.start > anchor.start &&
            child.end < anchor.end &&
            (child.component || /^[A-Z]/.test(child.tag)),
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
      .filter(([p]) => c.props[p])
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
    const protectedTags = new Set(["form"]);
    for (const component of components) {
      if (!component.provider) continue;
      const [module, exported = "default"] = component.provider.split("#");
      for (const declaration of file.getImportDeclarations().filter((item) => item.getModuleSpecifierValue() === module)) {
        const named = declaration.getNamedImports().find((item) => item.getName() === exported);
        const local = named?.getAliasNode()?.getText() ?? named?.getName() ?? (exported === "default" ? declaration.getDefaultImport()?.getText() : undefined);
        if (local) protectedTags.add(local);
        const namespace = declaration.getNamespaceImport();
        if (namespace) protectedTags.add(namespace.getText() + "." + exported);
      }
    }
    const protectedNode = (element: Node) => jsx(element) && protectedTags.has(opening(element).getTagNameNode().getText());
    const owners = (element: Element) => element.getAncestors().filter(protectedNode);
    const beforeOwners = owners(node);
    const afterOwners = [...(protectedNode(parent) ? [parent] : []), ...owners(parent)];
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

export function validateCapabilities(files: Files, manifest: Manifest) {
  const project = new Project({ useInMemoryFileSystem: true, compilerOptions: { jsx: 4, moduleResolution: 100 } });
  for (const [name, source] of Object.entries(files))
    if (/\.[cm]?[jt]sx?$/.test(name)) project.createSourceFile("/" + name, source);
  type Reference = { module: string; exported: string };
  const reference = (node: Node, seen = new Set<Node>()): Reference | undefined => {
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
          if (found) return found;
        }
      }
      const declarations = target?.getExportedDeclarations().get(exported) ?? [];
      for (const value of declarations) {
        const found = reference(value, seen);
        if (found) return found;
      }
      return undefined;
    }
    if (Node.isIdentifier(node))
      for (const declaration of node.getSymbol()?.getDeclarations() ?? []) {
        const found = reference(declaration, seen);
        if (found) return found;
      }
    return undefined;
  };
  const allowed = new Set(manifest.libraries.flatMap((library) => library.components.flatMap((component) => [
    component.package + "#" + component.export,
    ...(component.provider ? [component.provider.includes("#") ? component.provider : component.provider + "#default"] : []),
  ])));
  if (manifest.provider) allowed.add(manifest.provider.includes("#") ? manifest.provider : manifest.provider + "#default");
  const check = (node: Node) => {
    const origin = reference(node);
    if (!origin || ["react", "react-dom"].some((module) => origin.module === module || origin.module.startsWith(module + "/"))) return;
    if (!allowed.has(origin.module + "#" + origin.exported))
      throw new StudioError(`Library capability ${origin.module}#${origin.exported} is not admitted. Ask the library maintainer for documented setup and examples in an updated release.`, 422);
  };
  for (const file of project.getSourceFiles()) {
    if (!file.getFilePath().startsWith("/src/")) continue;
    for (const node of file.getDescendants()) {
      if (Node.isJsxOpeningElement(node) || Node.isJsxSelfClosingElement(node)) check(node.getTagNameNode());
      if (Node.isCallExpression(node)) {
        const callee = reference(node.getExpression());
        if (callee?.module === "react" && callee.exported === "createElement" && node.getArguments()[0]) check(node.getArguments()[0]);
      }
    }
  }
}
