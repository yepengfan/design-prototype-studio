import { e2eFixture } from "../e2e-fixture";
import { accountFreeAI } from "../account-free-ai";
import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createApp } from "../../server/app";
import { registryFixture } from "../registry";
import { parseRequirements } from "../../server/core/requirements";
import { synchronizeRuntime } from "../../server/core/project";

test("upgrade review preserves the pinned page until confirmation and exact restoration fails honestly when an old release is unavailable", async ({
  browser,
}) => {
  test.setTimeout(600000);
  const root = await e2eFixture("studio-upgrade-");
  const registry = await registryFixture(root);
  const prior = process.env.npm_config_userconfig,
    cache = process.env.npm_config_cache;
  process.env.npm_config_userconfig = registry.config;
  process.env.npm_config_cache = path.join(root, "cache");
  const name = "@studio-test/surfaces";
  for (const [version, color] of [
    ["1.0.0", "#e9f5ef"],
    ["2.0.0", "#edf0fc"],
    ["3.0.0", "#edf0fc"],
  ])
    await registry.publish(
      {
        name,
        version,
        type: "module",
        exports: { ".": { types: "./index.d.ts", default: "./index.js" }, [version === "1.0.0" ? "./tokens.css" : "./theme.css"]: version === "1.0.0" ? "./tokens.css" : "./theme.css" },
        types: "./index.d.ts",
        peerDependencies: { react: "^19.3.1" },
        studio: "./studio.json",
      },
      {
        [version === "1.0.0" ? "tokens.css" : "theme.css"]: ":root { --fixture-gap: 24px; }",
        "index.js": `import {createElement as h,useState} from 'react';export function Card({children}){const [done,setDone]=useState(false);return h('article',{onClick:${version === '3.0.0' ? 'undefined' : '()=>setDone(true)'},style:{backgroundColor:'${color}',padding:24}},children,done?h('span',{role:'status'},'Acknowledged'):null)}`,
        "index.d.ts": `import type {ReactNode} from 'react';export declare function Card(props:{children?:ReactNode}):ReactNode;`,
        "studio.json": JSON.stringify({
          schemaVersion: 1,
          components: [
            {
              name: "Card",
              export: "Card",
              description: "A grouping surface.",
              styles: [name + (version === "1.0.0" ? "/tokens.css" : "/theme.css")],
              props: {},
              children: true,
              examples: [
                { name: "Default", props: {}, children: "Stable notice" },
              ],
            },
          ],
        }),
      },
    );
  let server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  let address = server.address();
  if (!address || typeof address === "string") throw new Error("No port");
  let origin = `http://127.0.0.1:${address.port}`;
  let studio = await createApp({
    ai: accountFreeAI,
    root: path.join(root, "studio"),
    origin,
  });
  server.on("request", studio.app);
  let secret = (await (await fetch(origin + "/api/session")).json()).secret;
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
    let data = (await request("/projects", { name: "Pinned surfaces" })).data;
    const id = data.state.id;
    await request(`/projects/${id}/requirements`, {
      base: data.snapshot.id,
      files: {
        "requirements/notice.feature":
          "Feature: Notice\nScenario: Read\nGiven a notice exists\nWhen I acknowledge the notice\nThen it is acknowledged\n",
      },
      scope: ["requirements"],
    });
    data = (await request(`/projects/${id}`)).data;
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
    await request(`/projects/${id}/edit`, {
      base: data.snapshot.id,
      page: "page",
      edit: {
        anchor: main.id,
        sourceHash: data.outline[0].hash,
        operation: "insert",
        component: data.snapshot.manifest.libraries[0].components[0],
      },
    });
    data = (await request(`/projects/${id}`)).data;
    const scenario = parseRequirements(data.snapshot.files, data.snapshot.manifest.scope).scenarios[0];
    const fixture = "src/scenarios/notice.ts";
    const story = "src/pages/Notice.stories.tsx";
    const otherFeature = "requirements/independent.feature";
    const otherSource = "Feature: Independent\nScenario: Read independent\nGiven an independent notice exists\nThen it remains visible\n";
    const other = parseRequirements({ [otherFeature]: otherSource }, [otherFeature]).scenarios[0];
    const manifest = { ...data.snapshot.manifest,
      scope: [otherFeature],
      pages: [...data.snapshot.manifest.pages, { id: "other", title: "Independent", file: "src/pages/Other.tsx", export: "Other" }],
      scenarios: [{
      scenario: scenario.id, page: "page", story: story + "#Read", fixture, accepted: true,
      steps: [
        { step: scenario.steps[0].id, action: "text" as const, role: "article", name: "", value: "Stable notice" },
        { step: scenario.steps[1].id, action: "click" as const, role: "article", name: "" },
        { step: scenario.steps[2].id, action: "text" as const, role: "status", name: "", value: "Acknowledged" },
      ],
    }, {
      scenario: other.id, page: "other", story: "src/pages/Other.stories.tsx#Read", fixture, accepted: true,
      steps: other.steps.map((step) => ({ step: step.id, action: "visible" as const, role: "heading", name: "Independent notice" })),
    }] };
    const files = synchronizeRuntime({ ...data.snapshot.files,
      [otherFeature]: otherSource,
      "src/pages/Other.tsx": "export function Other(){return <main><h1>Independent notice</h1></main>}",
      "src/pages/Other.stories.tsx": "import {Other} from './Other';export default {title:'Independent',component:Other};export const Read={};",
      "src/main.tsx": data.snapshot.files["src/main.tsx"].replace("// Studio launcher", "// Original launcher") + `\nimport './project.css';`,
      ".storybook/preview.tsx": data.snapshot.files[".storybook/preview.tsx"].replace("// Studio preview", "// Original preview"),
      "src/project.css": `@import '${name}/tokens.css';body { font-family: sans-serif; }`,
      [fixture]: "export default {};",
      [story]: `import {Page} from './Page';export default {title:'Notice',component:Page};export const Read={};`,
    }, manifest);
    await studio.store.exclusive(id, () => studio.store.commit(id, data.snapshot.id, files, manifest, "Reviewed notice scenario"));
    data = (await request(`/projects/${id}`)).data;
    const old = data.snapshot;
    await request(`/projects/${id}/history`, {
      action: "save",
      name: "Green release",
    });
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const show = async (color: string) => {
      const preview = (await request(`/projects/${id}/preview`, {})).data;
      await page.goto(preview.url);
      await expect(page.getByRole("article")).toHaveText("Stable notice");
      await expect(page.getByRole("article")).toHaveCSS(
        "background-color",
        color,
      );
      studio.previews.stop(preview.id);
    };
    await show("rgb(233, 245, 239)");
    const impact = (
      await request(`/projects/${id}/library`, {
        base: data.snapshot.id,
        name,
        version: "2.0.0",
        registry: registry.base,
        trust: true,
        apply: false,
      })
    ).data;
    expect(impact.previous).toBe("1.0.0");
    expect(impact.next).toBe("2.0.0");
    expect((await request(`/projects/${id}`)).data.state.head).toBe(old.id);
    await page.goto(impact.preview.url);
    await expect(page.getByRole("article")).toHaveCSS(
      "background-color",
      "rgb(237, 240, 252)",
    );
    expect(impact.quality.ready, JSON.stringify(impact.quality.results)).toBe(true);
    expect(impact.pages).toHaveLength(2);
    studio.previews.stop(impact.preview.id);
    for (const page of impact.pages) studio.previews.stop(page.id);
    await request(`/projects/${id}/library`, {
      base: data.snapshot.id,
      name,
      version: "2.0.0",
      registry: registry.base,
      trust: true,
      confirmation: impact.confirmation,
      apply: true,
    });
    data = (await request(`/projects/${id}`)).data;
    const upgraded = data.snapshot;
    expect(upgraded.files["src/pages/Page.tsx"]).toBe(
      old.files["src/pages/Page.tsx"],
    );
    await show("rgb(237, 240, 252)");
    const broken = (await request(`/projects/${id}/library`, {
      base: upgraded.id, name, version: "3.0.0", registry: registry.base, trust: true, apply: false,
    })).data;
    expect(broken.quality.ready).toBe(false);
    const rejected = await request(`/projects/${id}/library`, {
      base: upgraded.id, name, version: "3.0.0", registry: registry.base, trust: true,
      apply: true, confirmation: broken.confirmation,
    }, true);
    expect(rejected.status).toBe(422);
    expect((await request(`/projects/${id}`)).data.state.head).toBe(upgraded.id);
    const restoration = await request(`/projects/${id}/history`, { action: "restore", revision: broken.preview.revision }, true);
    expect(restoration.status).toBe(422);
    expect((await request(`/projects/${id}`)).data.state.head).toBe(upgraded.id);
    expect((await request(`/projects/${id}`)).data.snapshot.manifest.scope).toEqual([otherFeature]);
    studio.previews.stop(broken.preview.id);
    for (const page of broken.pages) studio.previews.stop(page.id);
    await request(`/projects/${id}/history`, {
      action: "restore",
      revision: old.id,
    });
    data = (await request(`/projects/${id}`)).data;
    expect(data.snapshot.manifest.libraries[0].version).toBe("1.0.0");
    expect(data.snapshot.files["package-lock.json"]).toBe(
      old.files["package-lock.json"],
    );
    await show("rgb(233, 245, 239)");
    await request(`/projects/${id}/history`, {
      action: "restore",
      revision: upgraded.id,
    });
    await page.screenshot({
      path: test.info().outputPath("restored-release.png"),
      fullPage: true,
    });
    await page.close();
    expect(errors).toEqual([]);
    // Simulate reopening on a clean machine cache. This is test-owned state only.
    await studio.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(path.join(root, "studio", "previews"), {
      recursive: true,
      force: true,
    });
    process.env.npm_config_cache = path.join(root, "empty-cache");
    registry.withdraw(name, "1.0.0");
    server = createServer();
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    address = server.address();
    if (!address || typeof address === "string")
      throw new Error("No restart port");
    origin = `http://127.0.0.1:${address.port}`;
    studio = await createApp({
      ai: accountFreeAI,
      root: path.join(root, "studio"),
      origin,
    });
    server.on("request", studio.app);
    secret = (await (await fetch(origin + "/api/session")).json()).secret;
    const failure = await request(
      `/projects/${id}/history`,
      { action: "restore", revision: old.id },
      true,
    );
    expect(failure.status).toBe(422);
    expect(failure.data.error).toContain("unavailable");
    data = (await request(`/projects/${id}`)).data;
    expect(data.state.head).toBe(upgraded.id);
    expect(data.snapshot.manifest.libraries[0].version).toBe("2.0.0");
    expect(data.snapshot.files["requirements/notice.feature"]).toBe(
      old.files["requirements/notice.feature"],
    );
  } finally {
    await studio.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await registry.close();
    if (prior === undefined) delete process.env.npm_config_userconfig;
    else process.env.npm_config_userconfig = prior;
    if (cache === undefined) delete process.env.npm_config_cache;
    else process.env.npm_config_cache = cache;
    await fs.rm(root, { recursive: true, force: true });
  }
});
