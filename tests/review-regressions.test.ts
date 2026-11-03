import { it, expect, vi } from "vitest";
import { createElement, createContext, useContext, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as jsxRuntime from "react/jsx-runtime";
import ts from "typescript";
import { promises as fs } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { anchors, editSource, validateCapabilities } from "../server/core/source";
import { componentSchema, type Component } from "../server/core/contracts";
import { blankProject, synchronizeRuntime, replaceLibraryStyles } from "../server/core/project";
import { digest } from "../server/core/files";
import { ProjectStore } from "../server/core/store";
import { chromium } from "@playwright/test";
import { checkQuality } from "../server/core/quality";
import { Previews } from "../server/core/preview";
import { parseRequirements } from "../server/core/requirements";
import { inspectLibrary } from "../server/core/libraries";
import { pathToFileURL } from "node:url";
import { prepareChange } from "../server/core/changes";

const card = componentSchema.parse({
  name: "Card", export: "Card", package: "@fixture/cards", version: "1.0.0",
  description: "A surface", provenance: "Published", children: true,
  slots: ["header"], props: { tone: { type: "string", description: "Surface tone" } },
  examples: [{ name: "Default", props: { tone: "neutral" }, children: "Notice" }],
});
function edit(source: string, tag: string, values: Partial<Parameters<typeof editSource>[1]>, components: Component[] = [card]) {
  const anchor = anchors(source, components).find((node) => node.tag === tag)!;
  return editSource(source, { anchor: anchor.id, sourceHash: digest(source), operation: "move", ...values }, components);
}
function render(source: string, library: Record<string, unknown>) {
  const module = { exports: {} as { Page: () => ReturnType<typeof createElement> } };
  const compiled = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS } }).outputText;
  new Function("require", "exports", compiled)((name: string) => name === "react/jsx-runtime" ? jsxRuntime : library, module.exports);
  return renderToStaticMarkup(createElement(module.exports.Page));
}
it("rejects conditional membership changes and form crossings for body and named slots", () => {
  for (const operator of ["&&", "||", "??"])
    for (const slot of [undefined, "header"]) {
      const source = `import {Card} from '@fixture/cards';export function Page(){return <main>{show ${operator} <Card/>}<Card header={null}></Card></main>}`;
      const target = anchors(source, [card]).filter((node) => node.tag === "Card")[1];
      expect(() => edit(source, "Card", { parent: target.id, slot })).toThrow("condition");
    }
  for (const slot of [undefined, "header"])
    for (const inward of [false, true]) {
      const source = inward
        ? `import {Card} from '@fixture/cards';export function Page(){return <main><Card/><form><Card header={null}></Card></form></main>}`
        : `import {Card} from '@fixture/cards';export function Page(){return <main><form><Card/></form><Card header={null}></Card></main>}`;
      const target = anchors(source, [card]).filter((node) => node.tag === "Card")[1];
      expect(() => edit(source, "Card", { parent: target.id, slot })).toThrow("form ownership");
    }
}, 30000);
it("exposes spread ownership and preserves effective literal property edits", () => {
  const source = `import {Card} from '@fixture/cards';export function Page(){const settings={tone:'accent'};return <main {...settings}><Card tone="neutral" {...settings}/></main>}`;
  expect(anchors(source, [card]).find((node) => node.tag === "Card")?.controlled).toContain("tone");
  expect(() => edit(source, "Card", { operation: "prop", property: "tone", value: "quiet" })).toThrow("page behavior");
  expect(() => edit(source, "main", { operation: "style", value: { padding: 20 } })).toThrow("behavior-owned");
  const explicit = source.replace('tone="neutral" {...settings}', '{...settings} tone="neutral"');
  const updated = edit(explicit, "Card", { operation: "prop", property: "tone", value: "quiet" });
  expect(render(updated, { Card: ({ tone }: { tone: string }) => createElement("article", null, tone) })).toBe('<main tone="accent"><article>quiet</article></main>');
});
it("manual insertion carries providers through both slots and repeated insertion", () => {
  const context = createContext(false);
  const components = [{ ...card, provider: "@fixture/cards#Provider" }];
  const library = {
    Provider: ({ children }: { children: ReactNode }) => createElement(context.Provider, { value: true }, children),
    Card: ({ children, header }: { children?: ReactNode; header?: ReactNode }) => {
      if (!useContext(context)) throw new Error("Missing provider");
      return createElement("article", null, header, children);
    },
  };
  for (const slot of [undefined, "header"]) {
    let source = slot
      ? `import {Card,Provider} from '@fixture/cards';export function Page(){return <Provider><Card header={null}></Card></Provider>}`
      : `export function Page(){return <main/>}`;
    for (let index = 0; index < 2; index++) source = edit(source, slot ? "Card" : "main", { operation: "insert", component: components[0], slot }, components);
    expect(render(source, library)).toContain("Notice");
  }
});
it("checks capability identities for direct, namespace, alias, re-export and React factory consumers", () => {
  const { files, manifest } = blankProject("Admission");
  manifest.libraries = [{ name: card.package, version: card.version, components: [card] }];
  files["src/reexports.ts"] = `export {Field} from '@fixture/cards';`;
  for (const source of [
    `import {Field} from '@fixture/cards';export function Page(){return <Field/>}`,
    `import * as DS from '@fixture/cards';const Field=DS.Field;export function Page(){return <Field/>}`,
    `import {Field} from '../reexports';export function Page(){return <Field/>}`,
    `import {createElement} from 'react';import {Field} from '@fixture/cards';export function Page(){return createElement(Field)}`,
  ]) expect(() => validateCapabilities({ ...files, "src/pages/Page.tsx": source }, manifest)).toThrow("not admitted");
  expect(() => validateCapabilities({ ...files, "src/pages/Page.tsx": `import {Card as Surface} from '@fixture/cards';export function Page(){return <Surface/>}` }, manifest)).not.toThrow();
});
it("keeps healthy projects accessible after creation stops before journal publication", async () => {
  const root = await fs.mkdtemp(path.join(process.cwd(), ".review-store-"));
  try {
    const store = new ProjectStore(root);
    const project = blankProject("Healthy");
    const healthy = await store.create(project.manifest, project.files);
    await store.persist("00000000-0000-0000-0000-000000000000", { ...project, label: "Unpublished" });
    await store.recoverRuns();
    expect((await store.list()).map((item) => item.id)).toEqual([healthy.state.id]);
    expect((await store.get(healthy.state.id)).snapshot.manifest.name).toBe("Healthy");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
it("accepts stack wrappers without Gherkin changes while retaining behavioral ownership", () => {
  const project = blankProject("Layout");
  project.manifest.generationState = "generated";
  project.files["src/pages/Page.tsx"] = `export function Page(){return <main><h1>Notice</h1><p>Content</p></main>}`;
  project.files = synchronizeRuntime(project.files, project.manifest);
  const base = { ...project, id: "base", at: "now", label: "Accepted" };
  const propose = (source: string) => prepareChange(base, { kind: "presentation", summary: "Layout", files: { "src/pages/Page.tsx": source }, questions: [], affectedScenarios: [] });
  expect(propose(`export function Page(){return <main><section style={{display:'flex',gap:16}}><h1>Notice</h1><p>Content</p></section></main>}`).requiresConfirmation).toBe(false);
  expect(() => propose(`export function Page(){return <main><section onClick={submit}><h1>Notice</h1><p>Content</p></section></main>}`)).toThrow("matching requirements");
});
it("generated lint executes successfully and rejects an unused controller value", async () => {
  const root = await fs.mkdtemp(path.join(process.cwd(), ".review-lint-"));
  try {
    const { files } = blankProject("Lint");
    for (const [file, source] of Object.entries(files)) {
      await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await fs.writeFile(path.join(root, file), source);
    }
    const run = () => spawnSync(process.execPath, [path.resolve("node_modules/eslint/bin/eslint.js"), "src", "--max-warnings", "0"], { cwd: root, encoding: "utf8" });
    const valid = run();
    expect(valid.status, valid.stdout + valid.stderr).toBe(0);
    await fs.writeFile(path.join(root, "src/pages/Page.tsx"), `export function Page(){const unused = 1;return <main/>}`);
    expect(run().status).toBe(1);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

it("delivery fails when the exported React entry crashes even though scenario preview works", async () => {
  const project = blankProject("Broken entry");
  project.files["requirements/notice.feature"] = "Feature: Notice\nScenario: Read\nGiven a notice exists\nThen it is visible\n";
  project.manifest.scope = ["requirements"];
  let runtimeFailure: ((error: Error) => void) | undefined;
  const smoke = {
    on: (event: string, callback: (error: Error) => void) => { if (event === "pageerror") runtimeFailure = callback; },
    goto: async (url: string) => { if (new URL(url).pathname === "/") runtimeFailure?.(new Error("Exported entry crashed")); },
    locator: () => ({ first: () => ({ waitFor: async () => {} }) }),
    close: async () => {},
  };
  const launch = vi.spyOn(chromium, "launch").mockResolvedValue({ newPage: async () => smoke, close: async () => {} } as unknown as Awaited<ReturnType<typeof chromium.launch>>);
  const previews = {
    verify: async () => {},
    startStorybook: async () => ({ id: "stories", url: "http://127.0.0.1:6006", stories: [] }),
    start: async () => ({ id: "react", url: "http://127.0.0.1:5173/studio-preview.html" }),
    stop: () => {},
  } as unknown as Previews;
  try {
    const report = await checkQuality({ ...project, id: "test", at: "now", label: "Broken entry" }, previews, "unused");
    expect(report.ready).toBe(false);
    expect(report.results[0].failures.join(" ")).toContain("Exported entry crashed");
  } finally { launch.mockRestore(); }
});

it("preserves fieldset ownership in both move directions and protects behavior-bearing native removal", () => {
  for (const inward of [false, true]) for (const slot of [undefined, "header"]) {
    const source = inward
      ? `import {Card} from '@fixture/cards';export function Page(){return <form><Card/><fieldset disabled><Card header={null}></Card></fieldset></form>}`
      : `import {Card} from '@fixture/cards';export function Page(){return <form><fieldset disabled><Card/></fieldset><Card header={null}></Card></form>}`;
    const target = anchors(source, [card]).filter((node) => node.tag === "Card")[1];
    expect(() => edit(source, "Card", { parent: target.id, slot })).toThrow("ownership");
  }
  const same = `import {Card} from '@fixture/cards';export function Page(){return <form><fieldset disabled><Card/><section></section></fieldset></form>}`;
  const target = anchors(same, [card]).find((node) => node.tag === "section")!;
  expect(render(edit(same, "Card", { parent: target.id }), { Card: () => createElement("input") })).toContain('<fieldset disabled=""><section><input/></section></fieldset>');
  for (const content of ['<p role="status">{status}</p>', '<p>{status}</p>', '<section><p role="status">Saved</p></section>']) {
    const source = `export function Page(){return <main>${content}</main>}`;
    expect(() => edit(source, content.startsWith("<section") ? "section" : "p", { operation: "remove" })).toThrow("required interaction");
  }
  const cosmetic = `export function Page(){return <main><p>Decoration</p></main>}`;
  expect(render(edit(cosmetic, "p", { operation: "remove" }), {})).toBe("<main></main>");
});
it("resolves destructured identities and default React factories and diagnoses ambiguous component references", () => {
  const { files, manifest } = blankProject("Boundaries");
  manifest.libraries = [{ name: card.package, version: card.version, components: [card] }];
  for (const source of [
    `import * as DS from '@fixture/cards';const {Field}=DS;export function Page(){return <Field/>}`,
    `import * as DS from '@fixture/cards';const {Field:Control}=DS;export function Page(){return <Control/>}`,
    `import React from 'react';import {Field} from '@fixture/cards';export function Page(){return React.createElement(Field)}`,
    `import React from 'react';import {Field as field} from '@fixture/cards';export function Page(){return React.createElement(field)}`,
    `import * as DS from '@fixture/cards';const Control=DS[which];export function Page(){return <Control/>}`,
    `import {Card,Field} from '@fixture/cards';const Control=condition?Card:Field;export function Page(){return <Control/>}`,
  ]) expect(() => validateCapabilities({ ...files, "src/pages/Page.tsx": source }, manifest), source).toThrow();
  const source = `import * as DS from '@fixture/cards';const {Card:Surface}=DS;export function Page(){return <Surface/>}`;
  expect(() => validateCapabilities({ ...files, "src/pages/Page.tsx": source }, manifest)).not.toThrow();
});
it("retains published decorator setup identity without admitting undocumented controls", async () => {
  const root = await fs.mkdtemp(path.join(process.cwd(), ".review-published-"));
  const name = "@fixture/provider";
  const library = path.join(root, "node_modules", name);
  try {
    await fs.mkdir(path.join(library, ".storybook"), { recursive: true });
    await fs.writeFile(path.join(library, "package.json"), JSON.stringify({ name, version: "1.0.0", types: "index.d.ts" }));
    await fs.writeFile(path.join(library, "index.d.ts"), `import type {ReactNode} from 'react';export declare function Field(props:{value:string}):ReactNode;export declare function Provider(props:{children?:ReactNode}):ReactNode;export declare function Undocumented(props:{}):ReactNode;`);
    await fs.writeFile(path.join(library, "Field.stories.tsx"), `import {Field} from '${name}';export default {component:Field,parameters:{docs:{description:{component:'A named field.'}}}};export const Empty={args:{value:''}};`);
    await fs.writeFile(path.join(library, ".storybook/preview.tsx"), `import {Provider} from '${name}';export default {decorators:[Story=><Provider><Story/></Provider>]};`);
    const admitted = await inspectLibrary(root, name, "1.0.0");
    expect(admitted.components.map((component) => component.export)).toEqual(["Field"]);
    const { files, manifest } = blankProject("Provider");
    manifest.libraries = [{ name, version: "1.0.0", components: admitted.components }];
    expect(() => validateCapabilities({ ...files, "src/pages/Page.tsx": `import {Provider,Field} from '${name}';export function Page(){return <Provider><Field value=""/></Provider>}` }, manifest)).not.toThrow();
    expect(() => validateCapabilities({ ...files, "src/pages/Page.tsx": `import {Undocumented} from '${name}';export function Page(){return <Undocumented/>}` }, manifest)).toThrow("not admitted");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
it("reconciles exact release stylesheet imports across preserved entry, Storybook and CSS while retaining unrelated styles", async () => {
  const root = await fs.mkdtemp(path.join(process.cwd(), ".review-styles-"));
  try {
    const before = {
      "entry.mjs": `import './tokens.mjs';import './project.mjs';export const entry='preserved';`,
      "preview.mjs": `import './tokens.mjs';export const decorators=['preserved'];`,
      "theme.mjs": `globalThis.__reviewStyles.push('theme');`,
      "project.mjs": `globalThis.__reviewStyles.push('project');`,
      "styles.css": `@import "./tokens.mjs" screen; @import "unrelated.css";`,
    };
    const after = replaceLibraryStyles(before, ["./tokens.mjs"], ["./theme.mjs"]);
    for (const [file, source] of Object.entries(after)) await fs.writeFile(path.join(root, file), source);
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", `globalThis.__reviewStyles=[];await import(${JSON.stringify(pathToFileURL(path.join(root, "entry.mjs")).href)});await import(${JSON.stringify(pathToFileURL(path.join(root, "preview.mjs")).href)});console.log(JSON.stringify(globalThis.__reviewStyles.sort()))`], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(["project", "theme"]);
    expect(after["styles.css"]).toBe('@import "./theme.mjs" screen; @import "unrelated.css";');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
it("project checks include reviewed scenarios outside the editing scope and smoke every existing page", async () => {
  const project = blankProject("Separate scopes");
  project.manifest.generationState = "generated";
  for (const name of ["a", "b"]) project.files[`requirements/${name}.feature`] = `Feature: ${name}\nScenario: Read ${name}\nGiven ${name} exists\nThen ${name} is visible\n`;
  project.manifest.scope = ["requirements/a.feature"];
  project.manifest.pages.push({ id: "b", title: "Second page", file: "src/pages/B.tsx", export: "B" });
  project.files["src/pages/B.tsx"] = "export function B(){return <main/>}";
  const requirements = parseRequirements(project.files, ["requirements"]);
  project.manifest.scenarios = requirements.scenarios.map((scenario, index) => ({
    scenario: scenario.id, page: index ? "b" : "page", accepted: true,
    story: `src/${index ? "b" : "a"}.stories.tsx#Read`, fixture: "src/fixture.ts",
    steps: scenario.steps.map((step) => ({ step: step.id, action: "visible" as const, role: "status", name: "" })),
  }));
  project.files["src/fixture.ts"] = "export default {}";
  const visited: string[] = [];
  const launch = vi.spyOn(chromium, "launch").mockResolvedValue({
    close: async () => {},
    newPage: async () => ({
      on: () => {}, close: async () => {}, screenshot: async () => {},
      goto: async (url: string) => { visited.push(url); if (url.includes("id=b")) throw new Error("Feature B interaction failed"); },
      locator: () => ({ first: () => ({ waitFor: async () => {} }) }),
      getByRole: () => ({ waitFor: async () => {} }),
    }),
  } as unknown as Awaited<ReturnType<typeof chromium.launch>>);
  const previews = {
    verify: async () => {}, stop: () => {},
    start: async (_snapshot: unknown, _scenario?: string, _component?: unknown, page?: string) => ({ id: page ?? "entry", url: `http://127.0.0.1:5173/${page ?? "studio-preview"}.html` }),
    startStorybook: async () => ({ id: "stories", url: "http://127.0.0.1:6006", stories: ["a", "b"].map((name) => ({ id: name, importPath: `src/${name}.stories.tsx`, exportName: "Read" })) }),
  } as unknown as Previews;
  try {
    const report = await checkQuality({ ...project, id: "test", at: "now", label: "Upgrade" }, previews, "unused", { project: true });
    expect(report.ready).toBe(false);
    expect(report.results.find((result) => result.scenario === requirements.scenarios[1].id)?.failures).toContain("Feature B interaction failed");
    expect(visited).toContain("http://127.0.0.1:5173/b.html");
    expect(project.manifest.scope).toEqual(["requirements/a.feature"]);
  } finally { launch.mockRestore(); }
});

it("legacy validation runs real lint without a supplied script or altering original configuration", async () => {
  const root = await fs.mkdtemp(path.join(process.cwd(), ".review-legacy-lint-"));
  const previews = new Previews(path.join(root, "previews"), "http://127.0.0.1:4311");
  try {
    const project = blankProject("Legacy lint");
    project.manifest.sourceOrigin = "legacy";
    const files = {
      "package.json": JSON.stringify({ name: "legacy", type: "module", scripts: { build: "node -e 'process.exit(0)'", "build-storybook": "node -e 'process.exit(0)' --" } }),
      "tsconfig.json": JSON.stringify({ compilerOptions: { jsx: "react-jsx", module: "ESNext", moduleResolution: "Bundler", skipLibCheck: true }, include: ["src"] }),
      "eslint.config.mjs": "throw new Error('Original optional configuration is preserved');",
      "src/pages/Page.tsx": "export function Page(){return <main/>}",
    };
    for (const [file, source] of Object.entries(files)) {
      await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await fs.writeFile(path.join(root, file), source);
    }
    await fs.symlink(path.resolve("node_modules"), path.join(root, "node_modules"), "dir");
    vi.spyOn(previews, "materialize").mockResolvedValue(root);
    const snapshot = { files, manifest: project.manifest, id: "test", at: "now", label: "Legacy" };
    await expect(previews.verify(snapshot, true)).resolves.toBeUndefined();
    await fs.writeFile(path.join(root, "src/pages/Page.tsx"), "export function Page(){const unused=1;return <main/>}");
    await expect(previews.verify(snapshot, true)).rejects.toThrow("lint failed");
    expect(await fs.readFile(path.join(root, "package.json"), "utf8")).toBe(files["package.json"]);
    expect(await fs.readFile(path.join(root, "eslint.config.mjs"), "utf8")).toBe(files["eslint.config.mjs"]);
  } finally { await previews.close(); await fs.rm(root, { recursive: true, force: true }); }
}, 30000);
it("preserves event, label and first-legend owners in both directions and both slot representations", () => {
  for (const owner of ["event", "label", "legend"]) for (const inward of [false, true]) for (const slot of [undefined, "header"]) {
    const moved = '<Card>Moved</Card>';
    const target = '<Card header={null}></Card>';
    const inside = inward ? target : moved;
    const outside = inward ? moved : target;
    const content = owner === "legend"
      ? `<fieldset disabled><legend>${inside}</legend>${outside}</fieldset>`
      : owner === "label" ? `<label>${inside}</label>${outside}` : `<div onClick={acknowledge}>${inside}</div>${outside}`;
    const source = `import {Card} from '@fixture/cards';export function Page(){return <main>${content}</main>}`;
    const nodes = anchors(source, [card]);
    const selected = nodes.find((node) => node.text === "Moved")!;
    const destination = nodes.find((node) => node.tag === "Card" && node.text !== "Moved")!;
    expect(() => editSource(source, { anchor: selected.id, sourceHash: digest(source), operation: "move", parent: destination.id, slot }, [card]), `${owner}:${inward}:${slot}`).toThrow("ownership");
  }
  const legends = `export function Page(){return <main><fieldset disabled><legend>First</legend><legend>Second</legend></fieldset></main>}`;
  const fieldset = anchors(legends).find((node) => node.tag === "fieldset")!;
  expect(() => edit(legends, "legend", { parent: fieldset.id, index: 1 })).toThrow("ownership");
  const source = `import {Card} from '@fixture/cards';export function Page(){return <main><div onClick={()=>{}}><Card>Moved</Card><section></section></div></main>}`;
  const target = anchors(source, [card]).find((node) => node.tag === "section")!;
  expect(render(edit(source, "Card", { parent: target.id }), { Card: () => createElement("article", null, "Moved") })).toContain("<section><article>Moved</article></section>");
}, 30000);
it("uses decorator parameter bindings and rejects unrelated or shadowed control bindings", () => {
  const { files, manifest } = blankProject("Decorators");
  for (const name of ["Story", "RenderStory", "View"]) {
    const source = `export const Example={decorators:[(${name})=><section><${name}/></section>]};`;
    expect(() => validateCapabilities({ ...files, "src/Example.stories.tsx": source }, manifest)).not.toThrow();
    const assigned = `const wrap=(${name})=><section><${name}/></section>;export const Example={decorators:[wrap]};`;
    expect(() => validateCapabilities({ ...files, "src/Example.stories.tsx": assigned }, manifest)).not.toThrow();
  }
  for (const source of [
    `export const Example={decorators:[(View,Context)=><Context/>]};`,
    `import {Field} from '@fixture/cards';export const Example={decorators:[View=>{const Story=Field;return <Story/>}]};`,
    `export function Other(Story){return <Story/>}`,
  ]) expect(() => validateCapabilities({ ...files, "src/Example.stories.tsx": source }, manifest)).toThrow();
});
it("applies one replacement-control policy to JSX and React factories across accepted source extensions", () => {
  for (const extension of ["js", "jsx", "ts", "tsx"]) {
    const project = blankProject("Strict controls");
    const base = { ...project, id: "base", at: "now", label: "Blank" };
    const propose = (source: string) => prepareChange(base, { kind: "presentation", summary: "Generate", files: { [`src/Control.${extension}`]: source }, questions: [], affectedScenarios: [] });
    for (const props of ["{onClick:acknowledge}", "{role:'button'}", "{role:unknown}", "{tabIndex:0}", "{contentEditable:true}", "{controls:true}"])
      expect(() => propose(`import {createElement as h} from 'react';export function Control(){return h('div',${props},'Confirm')}`), `${extension}:${props}`).toThrow("invents");
    expect(() => propose(`import React from 'react';export function Control(){return React.createElement('button',null,'Confirm')}`)).toThrow("invents");
    for (const props of ["settings", "{...settings}", "{[property]:true}"])
      expect(() => propose(`import {createElement as h} from 'react';export function Control(){return h('div',${props})}`)).toThrow("properties cannot be identified");
    expect(() => propose(`import {createElement as h} from 'react';export function Control(){return h(target,null)}`)).toThrow("cannot be identified");
    expect(() => propose(`import {createElement as h} from 'react';export function Control(){return h('main',{style:{padding:16}},h('p',{role:'status'},'Ready'))}`)).not.toThrow();
    if (extension.endsWith("x")) {
      expect(() => propose(`export function Control(){return <div onClick={acknowledge}>Confirm</div>}`)).toThrow("invents");
      expect(() => propose(`export function Control(){return <main><p role="status">Ready</p></main>}`)).not.toThrow();
    }
  }
}, 30000);
it("rejects wrap, remove and duplication that change disabled-fieldset legend context", () => {
  for (const operation of ["wrap", "remove", "duplicate"] as const) {
    const source = operation === "remove"
      ? `export function Page(){return <fieldset disabled><legend>Title</legend><legend><input/></legend></fieldset>}`
      : `export function Page(){return <fieldset disabled><legend><input/></legend></fieldset>}`;
    expect(() => edit(source, "legend", { operation })).toThrow("ownership");
  }
  const functions = `export function Page(){return <main><p>Notice</p></main>}export function Other(){return <section></section>}`;
  const destination = anchors(functions).find((node) => node.tag === "section")!;
  expect(() => edit(functions, "p", { operation: "move", parent: destination.id })).toThrow("ownership");
  const source = `export function Page(){return <main><fieldset disabled><legend><input/></legend></fieldset></main>}`;
  expect(render(edit(source, "fieldset", { operation: "wrap" }), {})).toContain('<section style="display:flex;flex-direction:column;gap:16px"><fieldset disabled=""><legend><input/></legend></fieldset></section>');
});
it("uses admitted provider binding identities for aliases, setup records and project providers", () => {
  for (const binding of [
    `import {Provider} from '@fixture/cards';const P=Provider;`,
    `import {Provider as Theme} from '@fixture/cards';const P=(Theme);`,
    `import * as DS from '@fixture/cards';const {Provider:P}=DS;`,
  ]) for (const fromSetup of [false, true]) for (const slot of [undefined, "header"]) for (const inward of [false, true]) {
    const source = `${binding}import {Card} from '@fixture/cards';export function Page(){return <main>${inward ? '<Card>Moved</Card><P><Card header={null}></Card></P>' : '<P><Card>Moved</Card></P><Card header={null}></Card>'}</main>}`;
    const component = { ...card, ...(fromSetup ? { setup: ["@fixture/cards#Provider"] } : { provider: "@fixture/cards#Provider" }) };
    const nodes = anchors(source, [component]);
    const selected = nodes.find((node) => node.text === "Moved")!;
    const destination = nodes.find((node) => node.tag === "Card" && node.text !== "Moved")!;
    expect(() => editSource(source, { anchor: selected.id, sourceHash: digest(source), operation: "move", parent: destination.id, slot }, [component])).toThrow("ownership");
  }
  const source = `import {Provider} from '../providers';import {Card} from '@fixture/cards';const P=Provider;export function Page(){return <main><P><Card>Moved</Card><section></section></P><aside></aside></main>}`;
  const context = { file: "src/pages/Page.tsx", files: { "src/providers.tsx": "export function Provider({children}){return <div>{children}</div>}" }, provider: "src/providers.tsx#Provider" };
  const selected = anchors(source, [card]).find((node) => node.tag === "Card")!;
  const destination = anchors(source).find((node) => node.tag === "aside")!;
  expect(() => editSource(source, { anchor: selected.id, sourceHash: digest(source), operation: "move", parent: destination.id }, [card], context)).toThrow("ownership");
  expect(() => editSource(source, { anchor: selected.id, sourceHash: digest(source), operation: "move", parent: destination.id }, [card], { ...context, provider: "src/providers#Provider" })).toThrow("ownership");
  const sameOwner = anchors(source).find((node) => node.tag === "section")!;
  expect(() => editSource(source, { anchor: selected.id, sourceHash: digest(source), operation: "move", parent: sameOwner.id }, [card], context)).not.toThrow();
}, 60000);
it("validates dependencies outside src and preserves only real controls with matching identity and multiplicity", () => {
  for (const extension of ["js", "jsx", "ts", "tsx"]) {
    const project = blankProject("Closure");
    const source = extension.endsWith("x") ? "export function Control(){return <button>Confirm</button>}" : "import {createElement as h} from 'react';export function Control(){return h('button',null,'Confirm')}";
    const files = { ...project.files,
      "src/pages/Page.tsx": `import {Control} from '../../components/Control';export function Page(){return <Control/>}`,
      [`components/Control.${extension}`]: source,
    };
    expect(() => validateCapabilities(files, project.manifest, project.files)).toThrow("invents");
    expect(() => validateCapabilities(files, project.manifest, files)).not.toThrow();
    const dependency = `import {Hidden} from 'unadmitted-controls';export function Control(){return <Hidden/>}`;
    expect(() => validateCapabilities({ ...files, [`components/Control.${extension}`]: dependency }, project.manifest)).toThrow("unadmitted package");
  }
  for (const factory of [false, true]) {
    const project = blankProject("Occurrences");
    const expression = factory ? `h('button',null,'Confirm')` : `<button>Confirm</button>`;
    const imports = factory ? `import {createElement as h} from 'react';` : "";
    for (const dormant of [`// ${expression}\n`, `const dormant=${JSON.stringify(expression)};`]) {
      const previous = { ...project.files, "src/pages/Page.tsx": `${imports}${dormant}export function Page(){return <main/>}` };
      const current = { ...previous, "src/pages/Page.tsx": `${imports}export function Page(){return ${expression}}` };
      expect(() => validateCapabilities(current, project.manifest, previous)).toThrow("invents");
    }
    const previous = { ...project.files, "src/pages/Page.tsx": `${imports}export function Page(){return ${expression}}` };
    const doubled = factory ? `h('main',null,${expression},${expression})` : `<main>${expression}${expression}</main>`;
    expect(() => validateCapabilities({ ...previous, "src/pages/Page.tsx": `${imports}export function Page(){return ${doubled}}` }, project.manifest, previous)).toThrow("invents");
    expect(() => validateCapabilities({ ...previous, "src/pages/Page.tsx": `${imports}export function Different(){return ${expression}}export function Page(){return <Different/>}` }, project.manifest, previous)).toThrow("invents");
  }
}, 30000);
