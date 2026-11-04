import { it, expect } from "vitest";
import ts from "typescript";
import { anchors, editSource, type Edit } from "../server/core/source";
import { componentSchema } from "../server/core/contracts";
import { digest } from "../server/core/files";
const component = (name: string, exported = name) =>
  componentSchema.parse({
    name,
    export: exported,
    package: "@fixture/layout",
    version: "1.0.0",
    description: "Published synthetic layout contract",
    provenance: "Published fixture",
    props: {},
    children: true,
    slots: [],
    examples: [{ name: "Default", props: {}, children: name }],
  });
const panel = componentSchema.parse({
  ...component("Panel"),
  slots: ["header", "footer"],
  props: {
    spacing: {
      type: "object",
      description: "Insets",
      default: { x: 12, y: 12 },
      fields: {
        x: { type: "number", description: "Horizontal inset", required: true },
        y: { type: "number", description: "Vertical inset", required: true },
      },
    },
  },
});
const card = component("Card");
const title = component("Notice heading", "Notice.Title");
const components = [panel, card, title];
function valid(source: string) {
  const result = ts.transpileModule(source, {
    reportDiagnostics: true,
    compilerOptions: {
      jsx: ts.JsxEmit.ReactJSX,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
    },
  });
  expect(
    result.diagnostics?.filter(
      (d) => d.category === ts.DiagnosticCategory.Error,
    ),
  ).toEqual([]);
}
it("moves and duplicates genuine compound parts between documented slots without corrupting controlled source", () => {
  let source = `import {Panel,Card,Notice as N} from '@fixture/layout'; export function Page(){return <main><Panel header={<N.Title>Notice</N.Title>}><Card>Body</Card></Panel><aside>Help</aside></main>}`;
  const change = (tag: string, values: Partial<Edit>) => {
    const node = anchors(source, components).find((n) => n.tag === tag)!;
    source = editSource(
      source,
      {
        anchor: node.id,
        sourceHash: digest(source),
        operation: "move",
        ...values,
      },
      components,
    );
    valid(source);
  };
  const parent = anchors(source, components).find((n) => n.tag === "Panel")!;
  change("N.Title", { parent: parent.id, slot: "footer" });
  let list = anchors(source, components);
  expect(list.find((n) => n.tag === "N.Title")?.slot).toBe("footer");
  expect(list.find((n) => n.tag === "Panel")?.props.header).toBe(null);
  change("N.Title", { operation: "duplicate" });
  list = anchors(source, components);
  expect(
    list.filter(
      (n) => n.component?.export === "Notice.Title" && n.slot === "footer",
    ),
  ).toHaveLength(2);
  const cards = list.filter((n) => n.tag === "Card");
  expect(cards[0].slot).toBeUndefined();
  expect(cards[0].parent).toBe(list.find((n) => n.tag === "Panel")?.id);
});
it("uses typed nested fields, retains a stable structural selection and rejects controlled or undocumented settings", () => {
  const source = `import {Panel} from '@fixture/layout'; export const Page=()=> <main><Panel /></main>`;
  const initial = anchors(source, components).find((n) => n.tag === "Panel")!;
  const updated = editSource(
    source,
    {
      anchor: initial.id,
      sourceHash: digest(source),
      operation: "prop",
      property: "spacing",
      value: { x: 24, y: 12 },
    },
    components,
  );
  valid(updated);
  const next = anchors(updated, components).find((n) => n.tag === "Panel")!;
  expect(next.path).toBe(initial.path);
  expect(next.props.spacing).toEqual({ x: 24, y: 12 });
  expect(() =>
    editSource(
      source,
      {
        anchor: initial.id,
        sourceHash: digest(source),
        operation: "prop",
        property: "spacing",
        value: { x: "bad", y: 12 },
      },
      components,
    ),
  ).toThrow("documented");
  const controlled = source.replace(
    "<Panel />",
    "<Panel spacing={settings} />",
  );
  const target = anchors(controlled, components).find(
    (n) => n.tag === "Panel",
  )!;
  expect(() =>
    editSource(
      controlled,
      {
        anchor: target.id,
        sourceHash: digest(controlled),
        operation: "prop",
        property: "spacing",
        value: { x: 24, y: 12 },
      },
      components,
    ),
  ).toThrow("controlled");
});
it("inserts real members into empty containers and refuses dynamic-list membership changes", () => {
  let source = `import {Panel} from '@fixture/layout';export const Page=()=> <main><Panel /></main>`;
  const target = anchors(source, components).find((n) => n.tag === "Panel")!;
  source = editSource(
    source,
    {
      anchor: target.id,
      sourceHash: digest(source),
      operation: "insert",
      component: title,
    },
    components,
  );
  valid(source);
  expect(
    anchors(source, components).find(
      (n) => n.component?.export === "Notice.Title",
    )?.text,
  ).toBe("Notice heading");
  const repeated = `import {Card} from '@fixture/layout';export const Page=()=> <main>{[1,2].map(value=><Card key={value}>{value}</Card>)}</main>`;
  const card = anchors(repeated, components).find((n) => n.tag === "Card")!;
  expect(card.dynamic).toBe(true);
  expect(() =>
    editSource(
      repeated,
      { anchor: card.id, sourceHash: digest(repeated), operation: "duplicate" },
      components,
    ),
  ).toThrow("repeats");
});

it("does not confuse a local controller binding with a shadowed library import", () => {
  const source = `import {Card} from '@fixture/layout';export function Page(){function Content({Card}:{Card:any}){return <section><Card tone="accent">Local content</Card></section>}return <main><Content Card={Local}/></main>}const Local=({children}:any)=><aside>{children}</aside>`;
  const selected = anchors(source, components).find(
    (node) => node.tag === "Card",
  )!;
  expect(selected.component).toBeUndefined();
  expect(() =>
    editSource(
      source,
      {
        anchor: selected.id,
        sourceHash: digest(source),
        operation: "prop",
        property: "tone",
        value: "neutral",
      },
      components,
    ),
  ).toThrow("does not document");
  expect(() =>
    editSource(
      source,
      { anchor: selected.id, sourceHash: digest(source), operation: "remove" },
      components,
    ),
  ).toThrow("required interaction");
});

it("retains genuine package identity through namespace and compound references", () => {
  const source = `import * as Layout from '@fixture/layout';export const Page=()=> <main><Layout.Panel header={<Layout.Notice.Title>Notice</Layout.Notice.Title>}/></main>`;
  const nodes = anchors(source, components);
  expect(
    nodes.find((node) => node.tag === "Layout.Panel")?.component?.export,
  ).toBe("Panel");
  expect(
    nodes.find((node) => node.tag === "Layout.Notice.Title")?.component?.export,
  ).toBe("Notice.Title");
});
