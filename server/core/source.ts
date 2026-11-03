import {
  Project,
  SyntaxKind,
  Node,
  type JsxElement,
  type JsxSelfClosingElement,
  type SourceFile,
} from "ts-morph";
import { componentReference } from "./component-reference.js";
import { digest } from "./files.js";
import { StudioError, type Component, type Property } from "./contracts.js";

type Element = JsxElement | JsxSelfClosingElement;
export type Anchor = {
  id: string;
  tag: string;
  start: number;
  end: number;
  parent?: string;
  slot?: string;
  props: Record<string, unknown>;
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
function literal(node: Node | undefined): unknown {
  if (!node) return undefined;
  if (Node.isParenthesizedExpression(node))
    return literal(node.getExpression());
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
    const values = node.getElements().map(literal);
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
      const v = literal(property.getInitializer());
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
  return literal(
    parse(`const value = (${expression});`)
      .getVariableDeclaration("value")
      ?.getInitializer(),
  );
}
function nodes(file: SourceFile) {
  return file.getDescendants().filter(jsx);
}
export function anchors(
  source: string,
  components: Component[] = [],
): Anchor[] {
  const file = parse(source);
  const imports = new Map<string, Component>();
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
      if (local) imports.set(local + reference.suffix, component);
    }
  }
  const elements = nodes(file);
  const ids = new Map<Element, string>();
  // IDs are revision-scoped anchors. Every operation also checks the full source hash.
  for (const n of elements)
    ids.set(n, digest([n.getStart(), n.getText()]).slice(0, 16));
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
    const ancestor = n.getAncestors().find(jsx);
    const tag = op.getTagNameNode().getText();
    return {
      id: ids.get(n)!,
      tag,
      start: n.getStart(),
      end: n.getEnd(),
      parent: ancestor ? ids.get(ancestor) : undefined,
      slot: n.getAncestors().find(Node.isJsxAttribute)?.getNameNode().getText(),
      props,
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
          (a) => Node.isCallExpression(a) || Node.isConditionalExpression(a),
        ),
      component: imports.get(tag),
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
  if (
    anchor.dynamic &&
    ["move", "remove", "duplicate"].includes(edit.operation)
  )
    throw new StudioError(
      "This item repeats or depends on a condition. Use a prompt to preserve the matching scenario behavior.",
    );
  const business =
    (edit.operation === "remove" && !!anchor.component) ||
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
    if (!propertyValueValid(spec, edit.value))
      throw new StudioError(
        "This value does not match the documented component property.",
      );
    const existing = op.getAttribute(edit.property!);
    if (!existing && op.getAttributes().some(Node.isJsxSpreadAttribute))
      throw new StudioError(
        "This setting may be supplied by page behavior. Use a prompt to preserve it.",
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
    if (
      ![
        "div",
        "section",
        "main",
        "article",
        "aside",
        "header",
        "footer",
      ].includes(anchor.tag)
    )
      throw new StudioError(
        "Layout edits apply to layout containers. Use documented library properties for components.",
      );
    const allowed = [
      "display",
      "flexDirection",
      "alignItems",
      "justifyContent",
      "gap",
      "padding",
      "width",
      "minHeight",
      "maxWidth",
      "gridTemplateColumns",
    ];
    const settings = edit.value as Record<string, unknown>;
    if (!settings || Object.keys(settings).some((k) => !allowed.includes(k)))
      throw new StudioError("Unsupported layout property.");
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
  } else if (edit.operation === "remove")
    file.replaceText([node.getStart(), node.getEnd()], "");
  else if (edit.operation === "duplicate")
    file.insertText(node.getEnd(), "\n" + node.getText());
  else if (edit.operation === "wrap") {
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
    if (!edit.slot && !Node.isJsxElement(node))
      throw new StudioError(
        "Choose a container with a supported children slot.",
      );
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
      Object.entries(c.props).some(
        ([name, p]) =>
          p.required &&
          (p.business ||
            (p.default === undefined && !(name in c.examples[0].props))),
      )
    )
      throw new StudioError(
        "This component needs required business configuration. Use a prompt with complete requirements.",
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
    const text = c.children
      ? `<${local} ${attributes}>{${JSON.stringify(example.children ?? c.name)}}</${local}>`
      : `<${local} ${attributes} />`;
    if (edit.slot) {
      const patch = slotPatch(node, edit.slot, text, edit.index);
      file.replaceText([patch.start, patch.end], patch.text);
      return file.getFullText();
    }
    if (!Node.isJsxElement(node))
      throw new StudioError("Choose a supported container.");
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
        patches.push({ start: node.getStart(), end: node.getEnd(), text: "" });
      let result = source;
      for (const p of patches.sort((a, b) => b.start - a.start))
        result = result.slice(0, p.start) + p.text + result.slice(p.end);
      return result;
    }
    if (!Node.isJsxElement(parent))
      throw new StudioError("Choose a supported container.");
    if (target?.component && !target.component.children)
      throw new StudioError("This parent has no documented children slot.");
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
      { start, end, text: "" },
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
