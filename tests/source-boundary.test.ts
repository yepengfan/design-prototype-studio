import { expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createElement, createContext, useContext, type ReactNode } from "react";
import * as jsxRuntime from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { blankProject, synchronizeRuntime } from "../server/core/project";
import { prepareChange } from "../server/core/changes";
import { parseRequirements } from "../server/core/requirements";
import { anchors, editSource, validateCapabilities } from "../server/core/source";
import { componentSchema, type Component } from "../server/core/contracts";
import { digest } from "../server/core/files";
import { inspectLibrary } from "../server/core/libraries";

it("requires all affected requirements for effective global annotations and their transitive helpers", () => {
  for (const extension of ["tsx", "ts", "jsx", "js"]) {
    const project = blankProject("Global scope");
    for (const file of Object.keys(project.files)) if (file.startsWith(".storybook/preview.")) delete project.files[file];
    project.files[`.storybook/preview.${extension}`] = `import {label} from '../src/setup';export default {parameters:{label}}`;
    project.files["src/setup.ts"] = `export {label} from './setup-value';`;
    project.files["src/setup-value.ts"] = `export const label='Ready';`;
    project.manifest.pages.push({ id: "b", title: "B", file: "src/pages/B.tsx", export: "Page" });
    project.files["src/pages/B.tsx"] = `export function Page(){return <main>B</main>}`;
    for (const name of ["a", "b"]) project.files[`requirements/${name}.feature`] = `Feature: ${name}\nScenario: Read\nGiven the notice exists\nThen I see Ready\n`;
    const requirements = parseRequirements(project.files, ["requirements"]);
    project.manifest.scenarios = requirements.scenarios.map((scenario, index) => ({ scenario: scenario.id, page: index ? "b" : "page", story: `src/${index ? "b" : "a"}.stories.tsx#Default`, fixture: `src/${index ? "b" : "a"}.stories.tsx`, accepted: false, steps: [] }));
    project.files["src/a.stories.tsx"] = `import {Page} from './pages/Page';export default {component:Page};export const Default={};`;
    project.files["src/b.stories.tsx"] = `import {Page} from './pages/B';export default {component:Page};export const Default={};`;
    project.manifest.scope = ["requirements/a.feature"];
    project.manifest.sourceOrigin = "legacy";
    project.files = synchronizeRuntime(project.files, project.manifest);
    const base = { ...project, id: "base", at: "now", label: "Accepted" };
    const proposal = { kind: "business" as const, summary: "Global setup", files: { "src/setup-value.ts": `export const label='Changed';`, "requirements/a.feature": project.files["requirements/a.feature"].replace("Ready", "Changed") }, questions: [], affectedScenarios: [requirements.scenarios[0].id] };
    expect(() => prepareChange(base, proposal)).toThrow("outside the current selection");
    base.manifest.scope = ["requirements"];
    base.files = synchronizeRuntime(base.files, base.manifest);
    expect(() => prepareChange(base, proposal)).not.toThrow();
  }
});
it("tracks unknown value carriers and local slot consumption instead of blessing changed use", () => {
  for (const [before, after] of [
    ["const carrier={action};export function Page(){return <main>{carrier.action}</main>}", "const carrier={action};export function Page(){return <main>{carrier.action}{carrier.action}</main>}"],
    ["function Slot({header}){return <aside>{header}</aside>}export function Page(){return <Slot header={action}/>} ", "function Slot({header}){return <aside>{header}{header}</aside>}export function Page(){return <Slot header={action}/>} "],
    ["function consume(value){return <section>{value}</section>}export function Page(){return <main>{consume(action)}</main>}", "function consume(value){return <section>{value}{value}</section>}export function Page(){return <main>{consume(action)}</main>}"],
  ]) {
    const project = blankProject("Unknown consumption");
    project.files["src/pages/Page.tsx"] = `const action=<button>Confirm</button>;${before}`;
    expect(() => validateCapabilities({ ...project.files, "src/pages/Page.tsx": `const action=<button>Confirm</button>;${after}` }, project.manifest, project.files)).toThrow(/preserv|control/);
    expect(() => validateCapabilities(project.files, project.manifest, project.files)).not.toThrow();
  }
});
it("preserves documented presentation property edits around historical JSX values", () => {
  const component = componentSchema.parse({ name: "Card", export: "Card", package: "@fixture/card", version: "1.0.0", description: "Surface", provenance: "Published", children: true, props: { tone: { type: "string", description: "Surface color" } }, examples: [{ name: "Default", props: {} }] });
  const project = blankProject("Properties");
  project.manifest.libraries = [{ name: component.package, version: component.version, components: [component] }];
  project.files["src/pages/Page.tsx"] = `import {Card} from '@fixture/card';const action=<button>Confirm</button>;export function Page(){return <Card tone="quiet">{action}</Card>}`;
  const source = project.files["src/pages/Page.tsx"];
  const target = anchors(source, [component]).find((node) => node.tag === "Card")!;
  const result = editSource(source, { anchor: target.id, sourceHash: digest(source), operation: "prop", property: "tone", value: "bright" }, [component]);
  expect(() => validateCapabilities({ ...project.files, "src/pages/Page.tsx": result }, project.manifest, project.files)).not.toThrow();
});
it("carries unambiguous published decorators into body and named-slot insertion and diagnoses other setup", async () => {
  const root = await fs.mkdtemp(path.join(process.cwd(), ".published-setup-"));
  const name = "@fixture/published";
  const packageRoot = path.join(root, "node_modules", name);
  const write = async (name: string, source: string) => { await fs.mkdir(path.dirname(path.join(packageRoot, name)), { recursive: true }); await fs.writeFile(path.join(packageRoot, name), source); };
  const context = createContext(false);
  const library = {
    Provider: ({ children }: { children?: ReactNode }) => createElement(context.Provider, { value: true }, children),
    Notice: ({ tone }: { tone?: string }) => { if (!useContext(context)) throw new Error("Provider required"); return createElement("aside", null, tone ?? "Ready"); },
    Panel: ({ children, header }: { children?: ReactNode; header?: ReactNode }) => createElement("main", null, header, children),
  };
  const render = (source: string) => {
    const exports = {} as { Page: () => ReactNode };
    const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
    new Function("require", "exports", compiled)((name: string) => name === "react/jsx-runtime" ? jsxRuntime : library, exports);
    return renderToStaticMarkup(createElement(exports.Page));
  };
  try {
    await write("package.json", JSON.stringify({ name, version: "1.0.0", type: "module", types: "./index.d.ts", exports: { ".": { types: "./index.d.ts", default: "./index.js" } } }));
    await write("index.js", "export const unused=0;");
    await write("index.d.ts", `export interface NoticeProps {/** Surface tone. */tone?:'quiet'|'bright'}\n/** A contextual notice. */\nexport declare function Notice(props:NoticeProps):any;export declare function Provider(props:{children?:any}):any;`);
    await write("Notice.stories.tsx", `import {Notice} from '${name}';export default {component:Notice};export const Default={args:{tone:'quiet'}};`);
    await write(".storybook/preview.tsx", `import {Provider} from '${name}';export default {decorators:[(Story:any)=><Provider><Story/></Provider>]};`);
    const admitted = await inspectLibrary(root, name, "1.0.0");
    const notice = admitted.components.find((component) => component.export === "Notice")!;
    expect(notice).toMatchObject({ provider: name + "#Provider", requiresBehavior: false });
    const panel: Component = componentSchema.parse({ name: "Panel", export: "Panel", package: name, version: "1.0.0", description: "Panel", provenance: "Published", children: true, slots: ["header"], props: {}, examples: [{ name: "Default", props: {} }] });
    for (const slot of [undefined, "header"]) {
      const source = `import {Panel} from '${name}';export function Page(){return <Panel/>}`;
      const anchor = anchors(source, [notice, panel])[0];
      const updated = editSource(source, { anchor: anchor.id, sourceHash: digest(source), operation: "insert", component: notice, slot }, [notice, panel]);
      expect(render(updated)).toContain("quiet");
    }
    await write(".storybook/preview.tsx", `import {Provider} from '${name}';export default {decorators:[(Story:any)=><Provider mode="business"><Story/></Provider>]};`);
    const unsupported = (await inspectLibrary(root, name, "1.0.0")).components.find((component) => component.export === "Notice")!;
    expect(unsupported.requiresBehavior).toBe(false);
    const source = `export function Page(){return <main/>}`;
    expect(() => editSource(source, { anchor: anchors(source)[0].id, sourceHash: digest(source), operation: "insert", component: unsupported }, [unsupported])).toThrow("published decorators");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}, 30000);

it("normalizes factory layout presentation while retaining factory slot consumption", () => {
  const project = blankProject("Factory layout");
  const prefix = "import {createElement as h} from 'react';const action=h('button',null,'Confirm');";
  const source = prefix + "export function Page(){return h('main',null,h('section',{style:{padding:12}},action))}";
  project.files["src/pages/Page.tsx"] = source;
  const layout = prefix + "export function Page(){return h('main',null,h('div',{style:{padding:24}},h('section',{style:{padding:16}},action)))}";
  expect(() => validateCapabilities({ ...project.files, "src/pages/Page.tsx": layout }, project.manifest, project.files)).not.toThrow();
  const slot = prefix + "function Slot({header}){return h('aside',null,header)}export function Page(){return h(Slot,{header:action})}";
  const baseline = { ...project.files, "src/pages/Page.tsx": slot };
  expect(() => validateCapabilities({ ...baseline, "src/pages/Page.tsx": slot.replace("null,header)", "null,header,header)") }, project.manifest, baseline)).toThrow(/control|preserv/);
});
