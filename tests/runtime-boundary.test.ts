import { it, expect } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import ts from "typescript";
import * as React from "react";
import * as runtime from "react/jsx-runtime";
import * as development from "react/jsx-dev-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import { blankProject, synchronizeRuntime } from "../server/core/project";
import { validateCapabilities } from "../server/core/source";
import { prepareChange } from "../server/core/changes";
import { ProjectStore } from "../server/core/store";
import { Previews } from "../server/core/preview";
import type { Files } from "../server/core/contracts";

const forms = [
  { name: "jsx", definition: "import {jsx as make} from 'react/jsx-runtime';", call: "make(TARGET,{children:'Confirm'})" },
  { name: "jsxs alias", definition: "import {jsxs} from 'react/jsx-runtime';const make=jsxs;", call: "make(TARGET,{children:['Confirm']})" },
  { name: "jsxDEV", definition: "import {jsxDEV as make} from 'react/jsx-dev-runtime';", call: "make(TARGET,{children:'Confirm'},undefined,false,undefined,undefined)" },
  { name: "namespace", definition: "import * as automatic from 'react/jsx-runtime';", call: "automatic.jsx(TARGET,{children:'Confirm'})" },
  { name: "computed namespace", definition: "import * as automatic from 'react/jsx-runtime';const make=automatic['jsx'];", call: "make(TARGET,{children:'Confirm'})" },
  { name: "re-export", definition: "import {make} from '../../runtime';", call: "make(TARGET,{children:'Confirm'})", helper: "export {jsx as make} from 'react/jsx-runtime';" },
  { name: "star re-export", definition: "import {jsx as make} from '../../runtime';", call: "make(TARGET,{children:'Confirm'})", helper: "export * from 'react/jsx-runtime';" },
  { name: "require", definition: "const {jsx:make}=require('react/jsx-runtime');", call: "make(TARGET,{children:'Confirm'})" },
];
function render(files: Files) {
  const load = (name: string): unknown => {
    if (name === "react/jsx-runtime") return runtime;
    if (name === "react/jsx-dev-runtime") return development;
    if (name === "@fixture/runtime") return { Field: () => React.createElement("button", null, "Confirm") };
    const source = files[name === "../../runtime" ? "runtime.ts" : name];
    const exports = {};
    const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
    new Function("require", "exports", compiled)(load, exports);
    return exports;
  };
  return renderToStaticMarkup(React.createElement((load("src/pages/Page.tsx") as { Page: React.FC }).Page));
}
it.each(forms.flatMap((form) => ["native", "unadmitted export"].map((target) => ({ ...form, target }))))("diagnoses $name with $target before every acceptance caller", async (form) => {
  const root = await fs.mkdtemp(path.join(process.cwd(), ".runtime-boundary-"));
  const previews = new Previews(path.join(root, "previews"), "http://127.0.0.1:4311");
  try {
    const project = blankProject("Runtime");
    project.manifest.libraries = [{ name: "@fixture/runtime", version: "1.0.0", components: [] }];
    project.manifest.scope = ["requirements"];
    project.files["requirements/notice.feature"] = "Feature: Notice\nScenario: Read\nGiven a notice exists\nThen confirmation is available\n";
    project.files = synchronizeRuntime(project.files, project.manifest);
    const store = new ProjectStore(path.join(root, "store"));
    const initial = await store.create(project.manifest, project.files);
    const source = (form.target === "native" ? "" : "import {Field} from '@fixture/runtime';") + form.definition + "export function Page(){return " + form.call.replace("TARGET", form.target === "native" ? "'button'" : "Field") + "}";
    const changes: Files = { "src/pages/Page.tsx": source, ...(form.helper ? { "runtime.ts": form.helper } : {}) };
    const candidate = { ...initial.snapshot, id: "unsupported", files: { ...initial.snapshot.files, ...changes } };
    expect(render(candidate.files)).toContain("<button>Confirm</button>");
    expect(() => validateCapabilities(candidate.files, candidate.manifest, initial.snapshot.files)).toThrow(/automatic.*runtime/i);
    expect(() => prepareChange(initial.snapshot, { kind: "business", summary: "Confirm", files: changes, questions: [], affectedScenarios: [] })).toThrow(/automatic.*runtime/i);
    await expect(store.commit(initial.state.id, initial.snapshot.id, candidate.files, candidate.manifest, "Runtime")).rejects.toThrow(/automatic.*runtime/i);
    expect((await store.get(initial.state.id)).snapshot).toEqual(initial.snapshot);
    await expect(store.create(candidate.manifest, candidate.files)).rejects.toThrow(/automatic.*runtime/i);
    await expect(previews.verify(candidate)).rejects.toThrow(/automatic.*runtime/i);
    expect(await fs.readdir(path.join(root, "previews")).catch(() => [])).toEqual([]);
  } finally { await previews.close(); await fs.rm(root, { recursive: true, force: true }); }
});
it.each([
  "import {createElement as h} from 'react';import {Field} from '@fixture/runtime';export function Page(){return h(Field,{})}",
  "import {Fragment} from 'react/jsx-runtime';import {Field} from '@fixture/runtime';export function Page(){return <Fragment><Field/></Fragment>}",
])("retains supported authored JSX and createElement with admitted components (%#)", async (source) => {
  const { componentSchema } = await import("../server/core/contracts");
  const project = blankProject("Supported");
  project.manifest.libraries = [{ name: "@fixture/runtime", version: "1.0.0", components: [componentSchema.parse({ name: "Field", export: "Field", package: "@fixture/runtime", version: "1.0.0", description: "A field", provenance: "Published", props: {}, examples: [{ name: "Default", props: {} }] })] }];
  expect(() => validateCapabilities({ ...project.files, "src/pages/Page.tsx": source }, project.manifest, project.files)).not.toThrow();
});
