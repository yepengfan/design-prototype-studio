import { it, expect } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createElement, createContext, useContext, type ReactNode } from "react";
import * as React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { blankProject } from "../server/core/project";
import { ProjectStore } from "../server/core/store";
import { anchors, editSource } from "../server/core/source";
import { digest } from "../server/core/files";
import { inspectLibrary } from "../server/core/libraries";
import { componentSchema } from "../server/core/contracts";

function render(source: string, library: Record<string, unknown> = {}) {
  const exports = {} as { Page: () => ReactNode };
  const compiled = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS } }).outputText;
  new Function("require", "exports", compiled)((name: string) => name === "react" ? React : name === "react/jsx-runtime" ? jsxRuntime : library, exports);
  return renderToStaticMarkup(createElement(exports.Page));
}
const consumers = [
  { name: "JSX children", slot: "children", body: "<aside>{children}</aside>", duplicate: "<aside>{children}{children}</aside>", use: "<Slot><button>Confirm</button></Slot>", layout: "<section style={{padding:24}}><aside>{children}</aside></section>" },
  { name: "JSX inline slot", slot: "header", body: "<aside>{header}</aside>", duplicate: "<aside>{header}{header}</aside>", use: "<Slot header={<button>Confirm</button>}/>", layout: "<section style={{padding:24}}><aside>{header}</aside></section>" },
  { name: "factory children", slot: "children", body: "h('aside',null,children)", duplicate: "h('aside',null,children,children)", use: "h(Slot,null,h('button',null,'Confirm'))", layout: "h('section',{style:{padding:24}},h('aside',null,children))" },
  { name: "factory inline slot", slot: "header", body: "h('aside',null,header)", duplicate: "h('aside',null,header,header)", use: "h(Slot,{header:h('button',null,'Confirm')})", layout: "h('section',{style:{padding:24}},h('aside',null,header))" },
];
it.each(consumers)("preserves $name consumption through publication", async (fixture) => {
  const root = await fs.mkdtemp(path.join(process.cwd(), ".direct-consumer-"));
  try {
    const store = new ProjectStore(root);
    const project = blankProject(fixture.name);
    const source = `import {createElement as h} from 'react';function Slot({${fixture.slot}}){return ${fixture.body}}export function Page(){return ${fixture.use}}`;
    project.files["src/pages/Page.tsx"] = source;
    project.files["requirements/notice.feature"] = "Feature: Notice\nScenario: Confirm\nThen confirmation is available\n";
    project.manifest.scope = ["requirements"];
    const initial = await store.create(project.manifest, project.files);
    expect((render(source).match(/<button>/g) ?? []).length).toBe(1);
    const styled = await store.commit(initial.state.id, initial.snapshot.id, { ...project.files, "src/pages/Page.tsx": source.replace(fixture.body, fixture.layout) }, project.manifest, "Consumer layout");
    expect((render(styled.snapshot.files["src/pages/Page.tsx"]).match(/<button>/g) ?? []).length).toBe(1);
    const changed = source.replace(fixture.body, fixture.duplicate);
    expect((render(changed).match(/<button>/g) ?? []).length).toBe(2);
    await expect(store.commit(initial.state.id, styled.snapshot.id, { ...styled.snapshot.files, "src/pages/Page.tsx": changed, "requirements/notice.feature": project.files["requirements/notice.feature"].replace("available", "repeated") }, project.manifest, "Duplicate consumer")).rejects.toThrow(/control|preserv/);
    expect((await store.get(initial.state.id)).snapshot).toEqual(styled.snapshot);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

it("retains reusable render-recipe providers and blocks unresolved render setup before insertion", async () => {
  const root = await fs.mkdtemp(path.join(process.cwd(), ".render-setup-"));
  const name = "@fixture/render-setup";
  const packageRoot = path.join(root, "node_modules", name);
  const write = async (name: string, source: string) => { await fs.mkdir(path.dirname(path.join(packageRoot, name)), { recursive: true }); await fs.writeFile(path.join(packageRoot, name), source); };
  const context = createContext(false);
  const library = {
    Provider: ({ children }: { children?: ReactNode }) => createElement(context.Provider, { value: true }, children),
    Notice: ({ tone, config }: { tone?: string; config?: { label: string } }) => { if (!useContext(context)) throw new Error("Render provider required"); return createElement("aside", null, config?.label ?? tone ?? "Ready"); },
    Panel: ({ children, header }: { children?: ReactNode; header?: ReactNode }) => createElement("main", null, header, children),
  };
  try {
    await write("package.json", JSON.stringify({ name, version: "1.0.0", type: "module", types: "./index.d.ts", exports: { ".": { types: "./index.d.ts", default: "./index.js" } } }));
    await write("index.js", "export const unused=0;");
    await write("index.d.ts", `export interface NoticeProps {\n/** Surface tone. */\ntone?:'quiet'|'bright'}\n/** A contextual notice. */\nexport declare function Notice(props:NoticeProps):any;export declare function Provider(props:{children?:any}):any;`);
    const panel = componentSchema.parse({ name: "Panel", export: "Panel", package: name, version: "1.0.0", description: "Panel", provenance: "Published", children: true, slots: ["header"], props: {}, examples: [{ name: "Default", props: {} }] });
    await write("Notice.stories.tsx", `import {Notice,Provider} from '${name}';export default {component:Notice};export const Default={render:()=> <Provider><Notice/></Provider>};`);
    const notice = (await inspectLibrary(root, name, "1.0.0")).components.find((component) => component.export === "Notice")!;
    expect(notice).toMatchObject({ provider: name + "#Provider", setup: [name + "#Provider"], requiresBehavior: false });
    for (const slot of [undefined, "header"]) {
      const source = `import {Panel} from '${name}';export function Page(){return <Panel/>}`;
      const anchor = anchors(source, [notice, panel])[0];
      const inserted = editSource(source, { anchor: anchor.id, sourceHash: digest(source), operation: "insert", component: notice, slot }, [notice, panel]);
      expect(render(inserted, library)).toContain("Ready");
    }
    for (const [recipe, expected] of [["args=> <Provider><Notice {...args}/></Provider>", "quiet"], ["()=> <Provider><Notice tone=\"bright\"/></Provider>", "bright"]]) {
      await write("Notice.stories.tsx", `import {Notice,Provider} from '${name}';export default {component:Notice,args:{tone:'quiet'}};export const Default={render:${recipe}};`);
      const configured = (await inspectLibrary(root, name, "1.0.0")).components.find((component) => component.export === "Notice")!;
      const source = "export function Page(){return <main/>}";
      const inserted = editSource(source, { anchor: anchors(source)[0].id, sourceHash: digest(source), operation: "insert", component: configured }, [configured]);
      expect(render(inserted, library)).toContain(expected);
    }
    await write("index.d.ts", `export interface NoticeProps {\n/** Surface tone. */\ntone?:string;config?:{label:string}}\n/** A contextual notice. */\nexport declare function Notice(props:NoticeProps):any;export declare function Provider(props:{children?:any}):any;`);
    await write("Notice.stories.tsx", `import {Notice,Provider} from '${name}';export default {component:Notice};export const Default={render:()=> <Provider><Notice config={{label:'Published configuration'}}/></Provider>};`);
    const configured = (await inspectLibrary(root, name, "1.0.0")).components.find((component) => component.export === "Notice")!;
    expect(configured.props.config).toBeUndefined();
    const blank = "export function Page(){return <main/>}";
    const configuredSource = editSource(blank, { anchor: anchors(blank)[0].id, sourceHash: digest(blank), operation: "insert", component: configured }, [configured]);
    expect(render(configuredSource, library)).toContain("Published configuration");
    await write("Notice.stories.tsx", `import {Notice,Provider} from '${name}';export default {component:Notice};export const Default={render:()=> <Provider mode={readMode()}><Notice/></Provider>};`);
    const unsupported = (await inspectLibrary(root, name, "1.0.0")).components.find((component) => component.export === "Notice")!;
    expect(unsupported.requiresBehavior).toBe(false);
    expect(unsupported.insertionGap).toMatch(/render.*setup/i);
    const source = "export function Page(){return <main/>}";
    expect(() => editSource(source, { anchor: anchors(source)[0].id, sourceHash: digest(source), operation: "insert", component: unsupported }, [unsupported])).toThrow(/render.*setup/i);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}, 30000);
