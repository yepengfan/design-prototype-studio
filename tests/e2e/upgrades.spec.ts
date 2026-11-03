import { accountFreeAI } from "../account-free-ai";
import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../../server/app";
import { registryFixture } from "../registry";

test("upgrade review preserves the pinned page until confirmation and exact restoration fails honestly when an old release is unavailable", async ({
  browser,
}) => {
  test.setTimeout(240000);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "studio-upgrade-"));
  const registry = await registryFixture(root);
  const prior = process.env.npm_config_userconfig,
    cache = process.env.npm_config_cache;
  process.env.npm_config_userconfig = registry.config;
  process.env.npm_config_cache = path.join(root, "cache");
  const name = "@studio-test/surfaces";
  for (const [version, color] of [
    ["1.0.0", "#e9f5ef"],
    ["2.0.0", "#edf0fc"],
  ])
    await registry.publish(
      {
        name,
        version,
        type: "module",
        exports: { ".": { types: "./index.d.ts", default: "./index.js" } },
        types: "./index.d.ts",
        peerDependencies: { react: "^19.3.1" },
        studio: "./studio.json",
      },
      {
        "index.js": `import {createElement as h} from 'react';export function Card({children}){return h('article',{style:{backgroundColor:'${color}',padding:24}},children)}`,
        "index.d.ts": `import type {ReactNode} from 'react';export declare function Card(props:{children?:ReactNode}):ReactNode;`,
        "studio.json": JSON.stringify({
          schemaVersion: 1,
          components: [
            {
              name: "Card",
              export: "Card",
              description: "A grouping surface.",
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
          "Feature: Notice\nScenario: Read\nGiven a notice exists\nThen it is visible\n",
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
    studio.previews.stop(impact.preview.id);
    await request(`/projects/${id}/library`, {
      base: data.snapshot.id,
      name,
      version: "2.0.0",
      registry: registry.base,
      trust: true,
      apply: true,
    });
    data = (await request(`/projects/${id}`)).data;
    const upgraded = data.snapshot;
    expect(upgraded.files["src/pages/Page.tsx"]).toBe(
      old.files["src/pages/Page.tsx"],
    );
    await show("rgb(237, 240, 252)");
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
