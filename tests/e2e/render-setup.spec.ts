import { e2eFixture } from "../e2e-fixture";
import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createServer as createViteServer } from "vite";
import react from "@vitejs/plugin-react";
import { readArchive } from "../../server/core/archive";
import { installProject } from "../../server/core/libraries";
import { createApp } from "../../server/app";
import { registryFixture } from "../registry";
import { accountFreeAI } from "../account-free-ai";

test("optional components retain render-recipe providers or report insertion setup gaps before publication", async ({ browser }) => {
  test.setTimeout(300000);
  const root = await e2eFixture(".render-setup-e2e-");
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
      await registry.publish({ name, version: "1.0.0", type: "module", types: "./index.d.ts", exports: { ".": { types: "./index.d.ts", default: "./index.js" }, "./appearance.css": "./theme.css" }, peerDependencies: { react: "^19.3.1" } }, {
        "index.js": `import {jsx} from 'react/jsx-runtime';import {createElement as h,createContext,useContext} from 'react';const Context=createContext(false);export function Provider({children}){return h(Context.Provider,{value:true},children)}export function Notice({tone='Ready'}){if(!useContext(Context))throw new Error('Render setup required');return jsx('aside',{'aria-label':'Published notice',className:'published-notice',children:tone})}`,
        "index.d.ts": `import type {ReactNode} from 'react';export interface NoticeProps {\n/** Surface tone. */\ntone?:string;}\n/** Explain a contextual notice. */\nexport declare function Notice(props:NoticeProps):ReactNode;export declare function Provider(props:{children?:ReactNode;enabled?:boolean}):ReactNode;`,
        ".storybook/preview.tsx": "export {type Theme} from './types-only';export {type Tokens, themeName} from './theme';export default {};",
        ".storybook/types-only.d.ts": "export interface Theme {tone:string}",
        ".storybook/theme.ts": "import '../theme.css';export interface Tokens {color:string};export const themeName='Published';",
        "theme.css": ".published-notice{color:rgb(31,83,119);padding:17px;background-image:url('./assets/tile.svg')}",
        "assets/tile.svg": '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2" fill="white"/></svg>',
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
      expect(notice.styles).toEqual([name + "/appearance.css"]);
      expect(notice.requiresBehavior).toBe(false);
      if (reusable) expect(notice.provider).toBe(name + "#Provider");
      else expect(notice.insertionGap).toMatch(/render.*setup/i);
      await page.goto(impact.data.preview.url);
      await expect(page.getByRole("complementary", { name: "Published notice" })).toHaveText("Ready");
      await expect(page.getByRole("complementary", { name: "Published notice" })).toHaveCSS("color", "rgb(31, 83, 119)");
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
        await expect(page.getByRole("complementary", { name: "Published notice" })).toHaveCSS("color", "rgb(31, 83, 119)");
        await expect(page.getByRole("complementary", { name: "Published notice" })).toHaveCSS("padding", "17px");
        studio.previews.stop(preview.data.id);
        const response = await fetch(origin + `/api/projects/${id}/export`, { headers: { "X-Studio-Session": secret } });
        expect(response.status).toBe(200);
        const exported = readArchive(Buffer.from(await response.arrayBuffer()));
        const manifest = JSON.parse(exported["studio.project.json"]);
        expect(manifest.styles).toContain(name + "/appearance.css");
        const fresh = path.join(root, "exported");
        await installProject(fresh, exported, manifest.libraries);
        const vite = await createViteServer({ root: fresh, configFile: false, plugins: [react()], server: { host: "127.0.0.1", port: 0, hmr: false, watch: null } });
        try {
          await vite.listen();
          await page.goto(vite.resolvedUrls!.local[0]);
          const notice = page.getByRole("complementary", { name: "Published notice" });
          await expect(notice).toHaveCSS("color", "rgb(31, 83, 119)");
          await expect(notice).toHaveCSS("padding", "17px");
          const image = await notice.evaluate((node) => getComputedStyle(node).backgroundImage);
          const asset = image.match(/url\("?([^")]+)/)?.[1];
          expect(asset).toBeTruthy();
          expect(await page.evaluate((url) => new Promise<number>((resolve) => {
            const image = new Image();
            image.onload = () => resolve(image.naturalWidth);
            image.onerror = () => resolve(0);
            image.src = url;
          }), asset!)).toBe(2);
        } finally { await vite.close(); }
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
