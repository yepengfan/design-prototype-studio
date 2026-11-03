import { it, expect } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createElement, type ReactNode } from "react";
import * as React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { blankProject, synchronizeRuntime } from "../server/core/project";
import { ProjectStore } from "../server/core/store";
import { anchors, editSource } from "../server/core/source";
import { componentSchema } from "../server/core/contracts";
import { digest } from "../server/core/files";
import { prepareChange } from "../server/core/changes";
import { inspectLibrary } from "../server/core/libraries";

function render(source: string) {
  const exports = {} as { Page: () => ReactNode };
  const once = ({ children, header }: { children?: ReactNode; header?: ReactNode }) => createElement("aside", null, header, children);
  const twice = ({ children, header }: { children?: ReactNode; header?: ReactNode }) => createElement("aside", null, header, header, children, children);
  const library = { Once: once, Twice: twice };
  const compiled = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS } }).outputText;
  new Function("require", "exports", compiled)((name: string) => name === "react" ? React : name === "react/jsx-runtime" ? jsxRuntime : library, exports);
  return renderToStaticMarkup(createElement(exports.Page));
}
it.each(["Caption", '{"Caption"}', "factory"])("preserves consumer presentation text %s without dropping consumption", async (text) => {
  const root = await fs.mkdtemp(path.join(process.cwd(), ".consumer-text-"));
  try {
    const project = blankProject("Text");
    project.manifest.scope = ["requirements"];
    project.files["requirements/notice.feature"] = "Feature: Notice\nScenario: Confirm\nGiven a notice exists\nThen confirmation is available\n";
    const source = text === "factory" ? `import {createElement as h} from 'react';function Slot({children}){return h('aside',null,h('h2',{id:'caption'},'Caption'),children)}export function Page(){return h(Slot,null,h('button',null,'Confirm'))}` : `function Slot({children}){return <aside><h2>${text}</h2>{children}</aside>}export function Page(){return <Slot><button>Confirm</button></Slot>}`;
    project.files["src/pages/Page.tsx"] = source;
    const store = new ProjectStore(root);
    const initial = await store.create(project.manifest, project.files);
    const updated = text === "factory" ? source.replace("'Caption'", "'Updated caption'") : editSource(source, { anchor: anchors(source).find((node) => node.tag === "h2")!.id, sourceHash: digest(source), operation: "text", value: "Updated caption" }, []);
    const prompt = prepareChange(initial.snapshot, { kind: "presentation", summary: "Caption", files: { "src/pages/Page.tsx": updated }, questions: [], affectedScenarios: [] });
    expect(prompt.requiresConfirmation).toBe(false);
    const saved = await store.commit(initial.state.id, initial.snapshot.id, { ...project.files, "src/pages/Page.tsx": updated }, project.manifest, "Caption");
    expect(render(saved.snapshot.files["src/pages/Page.tsx"])).toContain("Updated caption");
    expect((render(saved.snapshot.files["src/pages/Page.tsx"]).match(/<button>/g) ?? []).length).toBe(1);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
it.each([
  { name: "JSX child", use: "<Box><button>Confirm</button></Box>" },
  { name: "JSX slot", use: "<Box header={<button>Confirm</button>}/>" },
  { name: "factory child", use: "h(Box,null,h('button',null,'Confirm'))" },
  { name: "factory slot", use: "h(Box,{header:h('button',null,'Confirm')})" },
  { name: "value child", use: "<Box>{action}</Box>", value: true },
  { name: "value slot", use: "<Box header={action}/>", value: true },
])("rejects external consumer substitution through unchanged aliases: $name", async (fixture) => {
  const root = await fs.mkdtemp(path.join(process.cwd(), ".consumer-identity-"));
  try {
    const project = blankProject("Identity");
    const components = ["Once", "Twice"].map((name) => componentSchema.parse({ name, export: name, package: "@fixture/consumer", version: "1.0.0", description: "A documented container", provenance: "Published", children: true, slots: ["header"], props: {}, examples: [{ name: "Default", props: {} }] }));
    project.manifest.libraries = [{ name: "@fixture/consumer", version: "1.0.0", components }];
    project.files["src/pages/Page.tsx"] = `import {createElement as h} from 'react';import {Once as Box} from '@fixture/consumer';${fixture.value ? "const action=<button>Confirm</button>;" : ""}export function Page(){return ${fixture.use}}`;
    project.files = synchronizeRuntime(project.files, project.manifest);
    const source = project.files["src/pages/Page.tsx"];
    const changed = source.replace("Once as Box", "Twice as Box");
    expect((render(source).match(/<button>/g) ?? []).length).toBe(1);
    expect((render(changed).match(/<button>/g) ?? []).length).toBe(2);
    const store = new ProjectStore(root);
    const initial = await store.create(project.manifest, project.files);
    await expect(store.commit(initial.state.id, initial.snapshot.id, { ...project.files, "src/pages/Page.tsx": changed }, project.manifest, "Consumer replacement")).rejects.toThrow(/control|preserv/);
    expect((await store.get(initial.state.id)).snapshot).toEqual(initial.snapshot);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
it("retains public global stylesheet assets and diagnoses unexported setup", async () => {
  const root = await fs.mkdtemp(path.join(process.cwd(), ".published-css-"));
  const name = "@fixture/styled";
  const packageRoot = path.join(root, "node_modules", name);
  const write = async (file: string, value: string) => { await fs.mkdir(path.dirname(path.join(packageRoot, file)), { recursive: true }); await fs.writeFile(path.join(packageRoot, file), value); };
  const pkg = { name, version: "1.0.0", types: "./index.d.ts", exports: { ".": { types: "./index.d.ts", default: "./index.js" }, "./appearance.css": "./theme.css" } };
  try {
    await write("package.json", JSON.stringify(pkg));
    await write("index.js", "export const unused=0;");
    await write("index.d.ts", `export interface NoticeProps {\n/** Surface tone. */\ntone?:string;}\n/** A notice. */\nexport declare function Notice(props:NoticeProps):any;`);
    await write("Notice.stories.tsx", `import {Notice} from '${name}';export default {component:Notice};export const Default={};`);
    await write(".storybook/preview.tsx", "import '../theme.css';export default {};");
    await write("theme.css", ".notice{color:rgb(31,83,119)}");
    const admitted = await inspectLibrary(root, name, "1.0.0");
    expect(admitted.components[0].styles).toEqual([name + "/appearance.css"]);
    await write("package.json", JSON.stringify({ ...pkg, exports: { ".": pkg.exports["."] } }));
    const unsupported = (await inspectLibrary(root, name, "1.0.0")).components[0];
    expect(unsupported.insertionGap).toMatch(/stylesheet.*theme\.css/i);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}, 30000);
