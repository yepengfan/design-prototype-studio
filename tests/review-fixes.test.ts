import { it, expect, vi } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import * as React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { anchors, editSource, validateCapabilities } from "../server/core/source";
import { blankProject, synchronizeRuntime } from "../server/core/project";
import { digest } from "../server/core/files";
import { prepareChange } from "../server/core/changes";
import { parseRequirements } from "../server/core/requirements";
import { ProjectStore } from "../server/core/store";
import { Annotations } from "../server/core/annotations";
import { chromium } from "@playwright/test";
import { checkQuality } from "../server/core/quality";
import type { Previews } from "../server/core/preview";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { orderedScenarioSteps } from "../server/templates/scenario-order";

function render(source: string) {
  const exports = {} as { Page: () => React.ReactNode };
  const compiled = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS } }).outputText;
  new Function("require", "exports", compiled)((name: string) => name === "react" ? React : jsxRuntime, exports);
  return renderToStaticMarkup(createElement(exports.Page));
}
it.each([false, true].flatMap((factory) => [
  { factory, before: "false && <Wrapper/>", after: "true && <Wrapper/>" },
  { factory, before: "<Wrapper/>", after: "<><Wrapper/><Wrapper/></>" },
]))("rejects changed wrapper use $before (factory: $factory)", async ({ factory, before, after }) => {
  const root = await fs.mkdtemp(path.join(process.cwd(), ".review-fixes-"));
  try {
    const store = new ProjectStore(root);
      const legacy = factory ? `return React.createElement('button',null,'Confirm')` : `return <button>Confirm</button>`;
      const invocation = factory ? "React.createElement(Alias)" : "<Alias/>";
      const prefix = `import * as React from 'react';function Legacy(){${legacy}}const Alias=Legacy;function Wrapper(){return ${invocation}}`;
        const project = blankProject("Legacy wrapper");
        const source = prefix + `export function Page(){return <main>{${before}}</main>}`;
        const candidate = prefix + `export function Page(){return <main>{${after}}</main>}`;
        expect(render(source)).not.toBe(render(candidate));
        project.files["src/pages/Page.tsx"] = source;
        const accepted = await store.create(project.manifest, project.files);
        await expect(store.commit(accepted.state.id, accepted.snapshot.id, { ...project.files, "src/pages/Page.tsx": candidate }, project.manifest, "Unsafe invocation")).rejects.toThrow(/control|invocation/i);
        expect((await store.get(accepted.state.id)).state.head).toBe(accepted.snapshot.id);
        expect(() => validateCapabilities({ ...project.files, "src/pages/Page.tsx": source.replace('<main>', '<main style={{padding:24}}>') }, project.manifest, project.files)).not.toThrow();
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
it("preserves local React provider ownership in both directions and through aliases", () => {
  for (const provider of ["C.Provider", "C", "P"]) {
    const prefix = `import {createContext,useContext} from 'react';const C=createContext('Guest');const P=C.Provider;function Reader(){return <p>{useContext(C)}</p>}`;
    for (const inward of [false, true]) {
      const source = prefix + `export function Page(){return <main><${provider} value="Alex">${inward ? "" : "<Reader/>"}</${provider}><section>${inward ? "<Reader/>" : ""}</section></main>}`;
      const list = anchors(source);
      const target = list.find((node) => node.tag === (inward ? provider : "section"))!;
      const reader = list.find((node) => node.tag === "Reader")!;
      expect(render(source)).toContain(inward ? "Guest" : "Alex");
      expect(() => editSource(source, { anchor: reader.id, sourceHash: digest(source), operation: "move", parent: target.id }, [])).toThrow(/ownership/);
    }
  }
});
it("rejects shared dependency behavior edits outside the selected requirement scope", () => {
  const project = blankProject("Shared behavior");
  project.manifest.scope = ["requirements/a.feature"];
  project.manifest.pages = [{ id: "a", title: "A", file: "src/pages/Page.tsx", export: "Page" }, { id: "b", title: "B", file: "src/pages/B.tsx", export: "Page" }];
  for (const name of ["a", "b"]) project.files[`requirements/${name}.feature`] = `Feature: ${name}\nScenario: Read\nGiven a notice\nThen the notice says Ready\n`;
  const scenarios = parseRequirements(project.files, ["requirements"]).scenarios;
  project.manifest.scenarios = scenarios.map((scenario, i) => ({ scenario: scenario.id, page: i ? "b" : "a", story: "src/Page.stories.tsx#Default", fixture: "src/data/fixture.ts", steps: [], accepted: false }));
  project.files["src/data/fixture.ts"] = "export default {}";
  project.files["src/shared/value.ts"] = `export const label='Ready';`;
  project.files["src/shared/index.ts"] = `export {label} from './value';`;
  for (const file of ["src/pages/Page.tsx", "src/pages/B.tsx"]) project.files[file] = `import {label} from '../shared';export function Page(){return <main>{label}</main>}`;
  project.files = synchronizeRuntime(project.files, project.manifest);
  const base = { ...project, id: "base", at: "now", label: "Accepted" };
  const proposal = { kind: "business" as const, summary: "Change label", files: { "src/shared/value.ts": `export const label='Changed';`, "requirements/a.feature": project.files["requirements/a.feature"].replace("Ready", "Changed") }, questions: [], affectedScenarios: [scenarios[0].id] };
  expect(() => prepareChange(base, proposal)).toThrow(/outside|related requirement/);
  const retarget = { ...proposal, files: { "requirements/a.feature": proposal.files["requirements/a.feature"] }, manifestChanges: { pages: base.manifest.pages.map((page) => ({ ...page, file: "src/pages/Page.tsx" })) } };
  expect(() => prepareChange(base, retarget)).toThrow(/outside|related requirement/);
  base.manifest.scope = ["requirements"];
  base.files = synchronizeRuntime(base.files, base.manifest);
  expect(() => prepareChange(base, proposal)).not.toThrow();
});
it("restores trusted native controls through selective annotation undo", async () => {
  const root = await fs.mkdtemp(path.join(process.cwd(), ".review-undo-"));
  try {
    const store = new ProjectStore(root);
    const project = blankProject("Legacy undo");
    project.files["src/pages/Page.tsx"] = `export function Page(){return <main><button>Confirm</button></main>}`;
    const initial = await store.create(project.manifest, project.files);
    const removed = await store.persist(initial.state.id, { parent: initial.snapshot.id, label: "Remove legacy", manifest: project.manifest, files: { ...project.files, "src/pages/Page.tsx": `export function Page(){return <main/>}` }, activeAnnotationResults: ["remove"] });
    const state = initial.state;
    state.head = removed.id;
    state.runs = [{ id: "remove", base: initial.snapshot.id, adapter: "codex", prompt: "Remove", status: "applied", events: [], annotation: "note", appliedBase: initial.snapshot.id, appliedRevision: removed.id }];
    await store.saveState(state);
    const restored = await new Annotations(store, async () => {}).undo(state.id, "remove");
    expect(render(restored.snapshot.files["src/pages/Page.tsx"])).toContain('<button>Confirm</button>');
    await expect(store.commit(state.id, restored.snapshot.id, { ...restored.snapshot.files, "src/pages/Page.tsx": `export function Page(){return <main><button>Confirm</button><button>Confirm</button></main>}` }, project.manifest, "Invented")).rejects.toThrow("invents");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
it("rejects missing action operands and accepts explicit empty values and zero counts", () => {
  for (const action of ["text", "value", "fill", "count"]) {
    const check = { step: "1", action, role: "status", name: "Notice" };
    expect(() => orderedScenarioSteps(["1"], [check])).toThrow(/operand|value|count/);
    const explicit = { ...check, ...(action === "count" ? { count: 0 } : { value: "" }) };
    expect(orderedScenarioSteps(["1"], [explicit])).toEqual([explicit]);
  }
  for (const count of [-1, 0.5, NaN, Infinity])
    expect(() => orderedScenarioSteps(["1"], [{ step: "1", action: "count", count }])).toThrow(/count/);
});

it("rejects activation through imported aliases and callback references", () => {
  for (const definition of ["export function Legacy(){return <button>Confirm</button>}", "export const Legacy=()=> <button>Confirm</button>"])
    for (const before of ["false && <Alias/>", "[].map(Alias)"]) {
      const project = blankProject("Imported legacy");
      project.files["src/legacy.tsx"] = definition;
      project.files["src/reexport.ts"] = "export {Legacy as Control} from './legacy';";
      const page = `import {Control as Alias} from '../reexport';export function Page(){return <main>{${before}}</main>}`;
      project.files["src/pages/Page.tsx"] = page;
      const next = page.replace(before, before.startsWith("false") ? "true && <Alias/>" : "[1].map(Alias)");
      expect(() => validateCapabilities({ ...project.files, "src/pages/Page.tsx": next }, project.manifest, project.files)).toThrow(/control|invocation/);
      expect(() => validateCapabilities({ ...project.files, "src/pages/Page.tsx": page.replace("<main>", '<main style={{padding:24}}>') }, project.manifest, project.files)).not.toThrow();
    }
});
it("keeps incomplete operands visibly failing in Studio quality results", async () => {
  const project = blankProject("Incomplete check");
  project.files["requirements/notice.feature"] = "Feature: Notice\nScenario: Read\nThen I see the notice\n";
  project.manifest.scope = ["requirements"];
  const scenario = parseRequirements(project.files, project.manifest.scope).scenarios[0];
  const page = { on: () => {}, goto: async () => {}, locator: () => ({ first: () => ({ waitFor: async () => {} }) }), close: async () => {} };
  const launch = vi.spyOn(chromium, "launch").mockResolvedValue({ newPage: async () => page, close: async () => {} } as unknown as Awaited<ReturnType<typeof chromium.launch>>);
  const previews = { verify: async () => {}, start: async () => ({ id: "react", url: "http://fixture" }), startStorybook: async () => ({ id: "stories", url: "http://fixture", stories: [] }), stop: () => {} } as unknown as Previews;
  try {
    for (const action of ["text", "value", "fill", "count"] as const) {
      project.manifest.scenarios = [{ scenario: scenario.id, page: "page", fixture: "src/fixture.ts", story: "src/Page.stories.tsx#Default", accepted: true, steps: [{ step: scenario.steps[0].id, action, role: "status", name: "Notice" }] }];
      project.files["src/fixture.ts"] = "export default {}";
      const report = await checkQuality({ ...project, id: "test", at: "now", label: "Check" }, previews, "unused");
      expect(report.ready).toBe(false);
      expect(report.results[0].failures.join(" ")).toMatch(/explicit.*operand/);
    }
  } finally { launch.mockRestore(); }
});
it("exported scenario runner rejects missing operands and executes explicit empty and zero operands", async () => {
  const root = await fs.mkdtemp(path.join(process.cwd(), ".review-export-"));
  const server = createServer((req, res) => {
    if (req.url === "/index.json") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ entries: { notice: { id: "notice", importPath: "./src/Page.stories.tsx", exportName: "Default" } } }));
    } else {
      res.setHeader("Content-Type", "text/html");
      res.end('<div id="storybook-root"><main><input aria-label="Notice" value=""></main></div>');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture port");
  const project = blankProject("Exported checks");
  project.files["requirements/notice.feature"] = "Feature: Notice\nScenario: Read\nThen I see the notice\n";
  project.manifest.scope = ["requirements"];
  const scenario = parseRequirements(project.files, project.manifest.scope).scenarios[0];
  try {
    for (const file of ["tests/scenarios.spec.ts", "tests/scenario-order.ts", "requirements/notice.feature"]) {
      await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await fs.writeFile(path.join(root, file), project.files[file]);
    }
    await fs.writeFile(path.join(root, "fixture.ts"), "export default {}");
    await fs.writeFile(path.join(root, "package.json"), '{"type":"module"}');
    await fs.symlink(path.resolve("node_modules"), path.join(root, "node_modules"), "dir");
    await fs.writeFile(path.join(root, "playwright.config.ts"), `export default {testDir:'./tests',workers:1,reporter:'line',use:{baseURL:'http://127.0.0.1:${address.port}',launchOptions:{executablePath:process.env.STUDIO_CHROME}}};`);
    const execute = async () => promisify(execFile)(process.execPath, [path.resolve("node_modules/@playwright/test/cli.js"), "test"], { cwd: root });
    for (const action of ["text", "value", "fill", "count"] as const) {
      project.manifest.scenarios = [{ scenario: scenario.id, page: "page", fixture: "fixture.ts", story: "src/Page.stories.tsx#Default", accepted: true, steps: [{ step: scenario.steps[0].id, action, role: "textbox", name: "Notice" }] }];
      await fs.writeFile(path.join(root, "studio.project.json"), JSON.stringify(project.manifest));
      await expect(execute()).rejects.toMatchObject({ stdout: expect.stringMatching(/explicit.*operand/) });
    }
    project.manifest.scenarios[0].steps = [
      { step: scenario.steps[0].id, action: "fill", role: "textbox", name: "Notice", value: "" },
      { step: scenario.steps[0].id, action: "value", role: "textbox", name: "Notice", value: "" },
      { step: scenario.steps[0].id, action: "count", role: "alert", name: "Notice", count: 0 },
    ];
    await fs.writeFile(path.join(root, "studio.project.json"), JSON.stringify(project.manifest));
    expect((await execute()).stdout).toContain("2 passed");
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); await fs.rm(root, { recursive: true, force: true }); }
}, 60000);

it("allows removing existing wrapper invocations without allowing additional occurrences", () => {
  for (const factory of [false, true]) {
    const project = blankProject("Legacy removal");
    const wrapper = factory ? "React.createElement(Legacy,{style:{padding:12}})" : '<Legacy style={{padding:12}}/>';
    const prefix = `import * as React from 'react';function Legacy(){return <button>Confirm</button>}`;
    const source = prefix + `export function Page(){return <main>{${wrapper}}{${wrapper}}</main>}`;
    project.files["src/pages/Page.tsx"] = source;
    const candidate = prefix + `export function Page(){return <main>{${wrapper.replace("padding:12", "padding:24")}}</main>}`;
    expect(() => validateCapabilities({ ...project.files, "src/pages/Page.tsx": candidate }, project.manifest, project.files)).not.toThrow();
    expect(() => validateCapabilities({ ...project.files, "src/pages/Page.tsx": source.replace('</main>', `{${wrapper}}</main>`) }, project.manifest, project.files)).toThrow("invents");
  }
});

it("diagnoses changed callback and ancestor execution contexts without evaluating them", () => {
  for (const [before, after] of [
    ["[1].map(()=> <Legacy/>)", "[1,2].map(()=> <Legacy/>)"],
    ['<section hidden={true}><Legacy/></section>', '<section hidden={false}><Legacy/></section>'],
    ['<Renderer active={false} render={()=> <Legacy/>}/>', '<Renderer active={true} render={()=> <Legacy/>}/>'],
  ]) {
    const project = blankProject("Callback multiplicity");
    const prefix = "function Legacy(){return <button>Confirm</button>}function Renderer({render}){return render()}";
    const source = prefix + `export function Page(){return <main>{${before}}</main>}`;
    project.files["src/pages/Page.tsx"] = source;
    expect(() => validateCapabilities({ ...project.files, "src/pages/Page.tsx": source.replace(before, after) }, project.manifest, project.files), before).toThrow(/control|invocation/);
  }
});
