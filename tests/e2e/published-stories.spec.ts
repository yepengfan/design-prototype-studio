import { e2eFixture } from "../e2e-fixture";
import { accountFreeAI } from "../account-free-ai";
import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createApp } from "../../server/app";
import AdmZip from "adm-zip";
import { registryFixture } from "../registry";

test("published types and CSF recipes admit controlled components with their original global setup without custom Studio metadata", async ({
  browser,
}) => {
  test.setTimeout(300000);
  const root = await e2eFixture("studio-story-library-");
  const registry = await registryFixture(root);
  const prior = process.env.npm_config_userconfig;
  process.env.npm_config_userconfig = registry.config;
  const name = "@studio-test/documented-field";
  await registry.publish(
    {
      name,
      version: "1.0.0",
      type: "module",
      exports: { ".": { types: "./index.d.ts", default: "./index.js" } },
      types: "./index.d.ts",
      peerDependencies: { react: "^19.3.1" },
    },
    {
      "index.js": `import {createElement as h,createContext,useContext} from 'react';const Theme=createContext(false);export function Provider({children}){return h(Theme.Provider,{value:true},children)};export default function Field({value,onChange}){if(!useContext(Theme))throw new Error('Published provider required');return h('input',{'aria-label':'Example name',value,onChange:event=>onChange(event.target.value)})}`,
      "index.d.ts": `import type {ReactNode} from 'react';export interface FieldProps {/** Current text. */value:string;/** Receive the edited text. */onChange:(value:string)=>void;}export default function Field(props:FieldProps):ReactNode;export declare function Provider(props:{children?:ReactNode}):ReactNode;`,
      "stories/Field.stories.tsx": `import {useState} from 'react';import Field from '${name}';const meta={title:'Fields/Name',component:Field,parameters:{docs:{description:{component:'A controlled single-line text field.'}}}};export default meta;export const Empty={render:()=>{const[value,setValue]=useState('');return <Field value={value} onChange={setValue}/>}};`,
      ".storybook/preview.tsx": `import {Provider} from '${name}';export default {decorators:[(Story:any)=><Provider><Story/></Provider>]};`,
    },
  );
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No port");
  const origin = `http://127.0.0.1:${address.port}`;
  const studio = await createApp({
    ai: accountFreeAI,
    root: path.join(root, "studio"),
    origin,
  });
  server.on("request", studio.app);
  const secret = (await (await fetch(origin + "/api/session")).json()).secret;
  const request = async (url: string, body?: unknown, fail = false) => {
    const response = await fetch(origin + "/api" + url, {
      method: body ? "POST" : "GET",
      headers: {
        "Content-Type": "application/json",
        "X-Studio-Session": secret,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await response.json();
    if (!response.ok && !fail) throw new Error(JSON.stringify(data));
    return { status: response.status, data };
  };
  try {
    let data = (await request("/projects", { name: "Published story recipes" }))
      .data;
    const id = data.state.id;
    await request(`/projects/${id}/requirements`, {
      base: data.snapshot.id,
      files: {
        "requirements/name.feature":
          "Feature: Name\nScenario: Edit\nGiven the name field is empty\nWhen I enter Alex\nThen Alex is visible\n",
      },
      scope: ["requirements"],
    });
    data = (await request(`/projects/${id}`)).data;
    const impact = (
      await request(`/projects/${id}/library`, {
        base: data.snapshot.id,
        name,
        version: "1.0.0",
        registry: registry.base,
        trust: true,
        apply: false,
      })
    ).data;
    expect(impact.components).toHaveLength(1);
    expect(impact.components[0]).toMatchObject({
      name: "Field",
      export:"default",
      requiresBehavior: true,
      examples: [
        {
          name: "Empty",
          story: {
            file: "stories/Field.stories.tsx",
            export: "Empty",
            annotations: ".storybook/preview.tsx",
          },
        },
      ],
    });
    expect(impact.components[0].api).toContain("onChange");
    expect(impact.components[0].examples[0].source).toContain("useState");
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(impact.preview.url);
    await page.getByRole("textbox", { name: "Example name" }).fill("Alex");
    await expect(
      page.getByRole("textbox", { name: "Example name" }),
    ).toHaveValue("Alex");
    studio.previews.stop(impact.preview.id);
    await request(`/projects/${id}/library`, {
      base: data.snapshot.id,
      name,
      version: "1.0.0",
      registry: registry.base,
      trust: true,
      apply: true,
    });
    data = (await request(`/projects/${id}`)).data;
    const main = data.outline[0].nodes.find(
      (node: { tag: string }) => node.tag === "main",
    );
    const insertion = await request(
      `/projects/${id}/edit`,
      {
        base: data.snapshot.id,
        page: "page",
        edit: {
          anchor: main.id,
          sourceHash: data.outline[0].hash,
          operation: "insert",
          component: data.snapshot.manifest.libraries[0].components[0],
        },
      },
      true,
    );
    expect(insertion.status).toBe(422);
    expect(insertion.data.error).toContain("business configuration");
    expect((await request(`/projects/${id}`)).data.snapshot.id).toBe(
      data.snapshot.id,
    );
    const preview = (
      await request(`/projects/${id}/preview`, {
        component: { package: name, export: "default" },
        example: 0,
      })
    ).data;
    await page.goto(preview.url);
    await expect(
      page.getByRole("textbox", { name: "Example name" }),
    ).toHaveValue("");
    await page.getByRole("textbox", { name: "Example name" }).fill("Blair");
    await expect(
      page.getByRole("textbox", { name: "Example name" }),
    ).toHaveValue("Blair");
    const source = {
      ...data.snapshot.files,
      "src/pages/Page.tsx": `import {useState} from 'react';import Field,{Provider} from '${name}';const P=Provider;export function Page(){const[value,setValue]=useState('');return <main><P><Field value={value} onChange={setValue}/></P><section></section></main>}`,
      "src/Page.stories.tsx": `import {Page} from './pages/Page';export default {title:'Legacy/Name',component:Page};export const Empty={};`,
    };
    const zip = new AdmZip();
    for (const [file, content] of Object.entries(source)) if (file !== "studio.project.json") zip.addFile(file, Buffer.from(content as string));
    const imported = (await request("/import", { archive: zip.toBuffer().toString("base64"), confirm: true })).data;
    const current = (await request(`/projects/${imported.state.id}`)).data;
    const field = current.outline[0].nodes.find((node: { tag: string }) => node.tag === "Field");
    const destination = current.outline[0].nodes.find((node: { tag: string }) => node.tag === "section");
    const refused = await request(`/projects/${imported.state.id}/edit`, {
      base: current.snapshot.id, page: current.outline[0].id,
      edit: { anchor: field.id, parent: destination.id, sourceHash: current.outline[0].hash, operation: "move" },
    }, true);
    expect(refused.status).toBe(422);
    expect(refused.data.error).toContain("ownership");
    expect((await request(`/projects/${imported.state.id}`)).data.snapshot.id).toBe(current.snapshot.id);
    const original = (await request(`/projects/${imported.state.id}/preview`, { page: imported.snapshot.manifest.pages[0].id })).data;
    await page.goto(original.url);
    await page.getByRole("textbox", { name: "Example name" }).fill("Casey");
    await expect(page.getByRole("textbox", { name: "Example name" })).toHaveValue("Casey");
    studio.previews.stop(original.id);
    expect(errors).toEqual([]);
    await page.screenshot({
      path: test.info().outputPath("published-controlled-field.png"),
      fullPage: true,
    });
    await page.close();
  } finally {
    await studio.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await registry.close();
    if (prior === undefined) delete process.env.npm_config_userconfig;
    else process.env.npm_config_userconfig = prior;
    await fs.rm(root, { recursive: true, force: true });
  }
});
