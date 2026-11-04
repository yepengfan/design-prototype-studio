import { e2eFixture } from "../e2e-fixture";
import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import AdmZip from "adm-zip";
import { createApp } from "../../server/app";
import { blankProject } from "../../server/core/project";
import { installProject } from "../../server/core/libraries";
import { registryFixture } from "../registry";
import { accountFreeAI } from "../account-free-ai";

test("legacy import admits documented resolved components through factories, aliases, destructuring and barrels", async ({ page }) => {
  test.setTimeout(240000);
  const root = await e2eFixture("import-discovery-");
  const registry = await registryFixture(root);
  const prior = process.env.npm_config_userconfig;
  process.env.npm_config_userconfig = registry.config;
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing port");
  const origin = `http://127.0.0.1:${address.port}`;
  const studio = await createApp({ root: path.join(root, "studio"), origin, ai: accountFreeAI });
  server.on("request", studio.app);
  const name = "@studio-test/discovered";
  try {
    await registry.publish({ name, version: "1.0.0", type: "module", types: "./index.d.ts", exports: { ".": { types: "./index.d.ts", default: "./index.js" } }, peerDependencies: { react: "^19.3.1" } }, {
      "index.js": "import {createElement as h} from 'react';export function Field({label='Published field'}){return h('input',{'aria-label':label})}",
      "index.d.ts": "import type {ReactNode} from 'react';export interface FieldProps {\n/** Accessible field label. */\nlabel?:string;}\n/** Enter a short notice value. */\nexport declare function Field(props:FieldProps):ReactNode;",
      "README.md": "# Notice fields\nField accepts an optional label and permits entering a short notice value.\n```tsx\n<Field label=\"Published field\"/>\n```",
    });
    const project = blankProject("Imported forms");
    const files = project.files;
    for (const file of Object.keys(files)) if (file.startsWith("studio/") || file === "studio.project.json" || file.endsWith(".stories.tsx")) delete files[file];
    const pkg = JSON.parse(files["package.json"]);
    pkg.dependencies[name] = "1.0.0";
    files["package.json"] = JSON.stringify(pkg);
    files["components/Factory.ts"] = `import {Field} from '${name}';import {createElement as h} from 'react';export function Factory(){return h(Field,{label:'Factory'})}`;
    files["components/FactoryAlias.ts"] = `import {Field} from '${name}';import * as React from 'react';const h=React.createElement;export function FactoryAlias(){return h(Field,{label:'Factory alias'})}`;
    files["components/Alias.tsx"] = `import {Field} from '${name}';const F=Field;export function Alias(){return <F label="Variable alias"/>}`;
    files["components/Namespace.tsx"] = `import * as Controls from '${name}';const {Field:F}=Controls;export function Namespace(){return <F label="Namespace"/>}`;
    files["components/barrel.ts"] = `export {Field as F} from '${name}';`;
    files["components/BarrelView.tsx"] = "import {F} from './barrel';export function Barrel(){return <F label=\"Barrel\"/>}";
    files["src/pages/Page.tsx"] = "import {Factory} from '../../components/Factory';import {FactoryAlias} from '../../components/FactoryAlias';import {Alias} from '../../components/Alias';import {Namespace} from '../../components/Namespace';import {Barrel} from '../../components/BarrelView';export function Page(){return <main><h1>Imported forms</h1><Factory/><FactoryAlias/><Alias/><Namespace/><Barrel/></main>}";
    files["src/Page.stories.tsx"] = "import {Page} from './pages/Page';export default {component:Page};export const Default={};";
    files["package-lock.json"] = await installProject(path.join(root, "original"), files, [{ name, registry: registry.base }], true);
    const zip = new AdmZip();
    for (const [file, source] of Object.entries(files)) zip.addFile(file, Buffer.from(source));
    const secret = (await (await fetch(origin + "/api/session")).json()).secret;
    const request = async (url: string, body: unknown) => {
      const response = await fetch(origin + "/api" + url, { method: "POST", headers: { "Content-Type": "application/json", "X-Studio-Session": secret }, body: JSON.stringify(body) });
      const data = await response.json();
      expect(response.status, JSON.stringify(data)).toBe(200);
      return data;
    };
    const archive = zip.toBuffer().toString("base64");
    const requirements = { "requirements/notice.feature": "Feature: Notice\nScenario: Enter\nGiven the notice fields are available\nWhen I enter Alex\nThen the fields retain Alex\n" };
    const inspection = await request("/import", { archive, requirements });
    expect(inspection.diagnostics).toEqual([]);
    const imported = await request("/import", { archive, requirements, confirm: true, previewStories: { "page-1": "src/Page.stories.tsx#Default" } });
    expect(imported.snapshot.manifest.libraries.map((library: { name: string }) => library.name)).toEqual([name]);
    const experience = async (stage: string) => {
      const preview = await request(`/projects/${imported.state.id}/preview`, { page: "page-1" });
      await page.goto(preview.url);
      await expect(page.getByRole("heading", { name: "Imported forms" })).toBeVisible();
      await expect(page.getByRole("textbox")).toHaveCount(5);
      for (const label of ["Factory", "Factory alias", "Variable alias", "Namespace", "Barrel"]) {
        const field = page.getByRole("textbox", { name: label, exact: true });
        await field.fill("Alex");
        await expect(field).toHaveValue("Alex");
      }
      if (stage === "edited") await expect(page.getByRole("main")).toHaveCSS("padding", "32px");
      await page.screenshot({ path: test.info().outputPath(`import-${stage}.png`), fullPage: true, animations: "disabled" });
      studio.previews.stop(preview.id);
    };
    await experience("original");
    const current = await fetch(origin + `/api/projects/${imported.state.id}`, { headers: { "X-Studio-Session": secret } });
    expect(current.status).toBe(200);
    const outline = await current.json();
    const main = outline.outline[0].nodes.find((node: { tag: string }) => node.tag === "main");
    await request(`/projects/${imported.state.id}/edit`, { base: outline.snapshot.id, page: "page-1", edit: { anchor: main.id, sourceHash: outline.outline[0].hash, operation: "style", value: { padding: 32 } } });
    await experience("edited");
  } finally { await studio.close(); await new Promise<void>((resolve) => server.close(() => resolve())); await registry.close(); if (prior === undefined) delete process.env.npm_config_userconfig; else process.env.npm_config_userconfig = prior; await fs.rm(root, { recursive: true, force: true }); }
});
