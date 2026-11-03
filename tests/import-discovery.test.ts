import { it, expect } from "vitest";
import { blankProject } from "../server/core/project";
import { referencedComponentPackages } from "../server/core/libraries";
import { validateCapabilities } from "../server/core/source";
import { componentSchema } from "../server/core/contracts";

const forms = [
  { name: "factory in ts", file: "src/pages/Page.ts", source: "import {Field} from '@fixture/controls';import {createElement as h} from 'react';export function Page(){return h(Field,{})}" },
  { name: "factory alias in js", file: "src/pages/Page.js", source: "import {Field} from '@fixture/controls';import * as React from 'react';const h=React.createElement;export function Page(){return h(Field,{})}" },
  { name: "variable alias", file: "src/pages/Page.tsx", source: "import {Field} from '@fixture/controls';const F=Field;export function Page(){return <F/>}" },
  { name: "namespace destructuring", file: "src/pages/Page.tsx", source: "import * as Controls from '@fixture/controls';const {Field:F}=Controls;export function Page(){return <F/>}" },
  { name: "local barrel outside src", file: "src/pages/Page.tsx", source: "import {F} from '../../components';export function Page(){return <F/>}", helper: "export {Field as F} from '@fixture/controls';" },
];
it.each(forms)("discovers the supported resolved render identity for $name", (form) => {
  const project = blankProject(form.name);
  delete project.files["src/pages/Page.tsx"];
  project.manifest.pages[0].file = form.file;
  project.files[form.file] = form.source;
  if (form.helper) project.files["components.ts"] = form.helper;
  project.manifest.libraries = [{ name: "@fixture/controls", version: "1.0.0", components: [componentSchema.parse({ package: "@fixture/controls", version: "1.0.0", name: "Field", export: "Field", description: "A field", provenance: "Published", props: {}, examples: [{ name: "Default", props: {} }] })] }];
  expect(() => validateCapabilities(project.files, project.manifest)).not.toThrow();
  expect(referencedComponentPackages(project.files, project.manifest)).toEqual(["@fixture/controls"]);
});
it("does not admit utilities or unused files as component packages", () => {
  const project = blankProject("Utility");
  project.files["src/pages/Page.tsx"] = "import {format} from '@fixture/utilities';export function Page(){return <main>{format('Ready')}</main>}";
  project.files["unused.tsx"] = "import {Field} from '@fixture/unused';export const unused=<Field/>";
  expect(referencedComponentPackages(project.files, project.manifest)).toEqual([]);
});
