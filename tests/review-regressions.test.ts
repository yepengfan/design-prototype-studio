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
import { blankProject, synchronizeRuntime } from "../server/core/project";
import { digest } from "../server/core/files";
import { ProjectStore } from "../server/core/store";
import { chromium } from "@playwright/test";
import { checkQuality } from "../server/core/quality";
import { Previews } from "../server/core/preview";
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
});
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
