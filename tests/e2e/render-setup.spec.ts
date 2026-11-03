import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createApp } from "../../server/app";
import { registryFixture } from "../registry";
import { accountFreeAI } from "../account-free-ai";

test("optional components retain render-recipe providers or report insertion setup gaps before publication", async ({ browser }) => {
  test.setTimeout(300000);
  const root = await fs.mkdtemp(path.join(process.cwd(), ".render-setup-e2e-"));
  const registry = await registryFixture(root);
  const previous = process.env.npm_config_userconfig;
  process.env.npm_config_userconfig = registry.config;
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing port");
  const origin = `http://127.0.0.1:${address.port}`;
  const studio = await createApp({ root: path.join(root, "studio"), origin, ai: accountFreeAI });
  server.on("request", studio.app);
  const secret = (await (await fetch(origin + "/api/session")).json()).secret;
  const request = async (url: string, body?: unknown) => {
    const response = await fetch(origin + "/api" + url, { method: body ? "POST" : "GET", headers: { "Content-Type": "application/json", "X-Studio-Session": secret }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, data: await response.json() };
  };
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    for (const reusable of [true, false]) {
      const name = reusable ? "@studio-test/render-notice" : "@studio-test/render-gap";
      await registry.publish({ name, version: "1.0.0", type: "module", types: "./index.d.ts", exports: { ".": { types: "./index.d.ts", default: "./index.js" } }, peerDependencies: { react: "^19.3.1" } }, {
        "index.js": `import {createElement as h,createContext,useContext} from 'react';const Context=createContext(false);export function Provider({children}){return h(Context.Provider,{value:true},children)}export function Notice({tone='Ready'}){if(!useContext(Context))throw new Error('Render setup required');return h('aside',{'aria-label':'Published notice'},tone)}`,
        "index.d.ts": `import type {ReactNode} from 'react';export interface NoticeProps {\n/** Surface tone. */\ntone?:string;}\n/** Explain a contextual notice. */\nexport declare function Notice(props:NoticeProps):ReactNode;export declare function Provider(props:{children?:ReactNode;enabled?:boolean}):ReactNode;`,
        "Notice.stories.tsx": `import {Notice,Provider} from '${name}';export default {component:Notice};export const Default={render:${reusable ? "()=> <Provider><Notice/></Provider>" : "()=>{const enabled=true;return <Provider enabled={enabled}><Notice/></Provider>}"}};`,
      });
      const created = await request("/projects", { name: "Render setup " + reusable });
      expect(created.status).toBe(200);
      const id = created.data.state.id;
      const requirements = await request(`/projects/${id}/requirements`, { base: created.data.snapshot.id, files: { "requirements/notice.feature": "Feature: Notice\nScenario: Read\nGiven a notice exists\nThen I see Ready\n" }, scope: ["requirements"] });
      expect(requirements.status).toBe(200);
      let data = (await request(`/projects/${id}`)).data;
      const impact = await request(`/projects/${id}/library`, { base: data.snapshot.id, name, version: "1.0.0", registry: registry.base, trust: true, apply: false });
      expect(impact.status, JSON.stringify(impact.data)).toBe(200);
      const notice = impact.data.components.find((component: { export: string }) => component.export === "Notice");
      expect(notice.requiresBehavior).toBe(false);
      if (reusable) expect(notice.provider).toBe(name + "#Provider");
      else expect(notice.insertionGap).toMatch(/render.*setup/i);
      await page.goto(impact.data.preview.url);
      await expect(page.getByRole("complementary", { name: "Published notice" })).toHaveText("Ready");
      studio.previews.stop(impact.data.preview.id);
      const admitted = await request(`/projects/${id}/library`, { base: data.snapshot.id, name, version: "1.0.0", registry: registry.base, trust: true, apply: true });
      expect(admitted.status, JSON.stringify(admitted.data)).toBe(200);
      data = (await request(`/projects/${id}`)).data;
      const main = data.outline[0].nodes.find((node: { tag: string }) => node.tag === "main");
      const insertion = await request(`/projects/${id}/edit`, { base: data.snapshot.id, page: "page", edit: { anchor: main.id, sourceHash: data.outline[0].hash, operation: "insert", component: notice } });
      if (reusable) {
        expect(insertion.status, JSON.stringify(insertion.data)).toBe(200);
        const preview = await request(`/projects/${id}/preview`, { page: "page" });
        expect(preview.status).toBe(200);
        await page.goto(preview.data.url);
        await expect(page.getByRole("complementary", { name: "Published notice" })).toHaveText("Ready");
        studio.previews.stop(preview.data.id);
      } else {
        expect(insertion.status).toBe(422);
        expect(insertion.data.error).toMatch(/render.*setup/i);
        expect((await request(`/projects/${id}`)).data.snapshot).toEqual(data.snapshot);
      }
    }
    expect(errors).toEqual([]);
  } finally {
    await page.close(); await studio.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await registry.close();
    if (previous === undefined) delete process.env.npm_config_userconfig; else process.env.npm_config_userconfig = previous;
    await fs.rm(root, { recursive: true, force: true });
  }
});
