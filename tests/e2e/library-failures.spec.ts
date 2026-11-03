import { accountFreeAI } from "../account-free-ai";
import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../../server/app";
import { registryFixture } from "../registry";

test("library admission rejects missing runtime exports, styles, providers and required example properties without changing the project", async () => {
  test.setTimeout(240000);
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "studio-library-gap-e2e-"),
  );
  const registry = await registryFixture(root);
  const prior = process.env.npm_config_userconfig;
  process.env.npm_config_userconfig = registry.config;
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
    const name = "@studio-test/incomplete";
    const component = {
      name: "Card",
      export: "Card",
      description: "A real library grouping surface",
      props: {},
      children: true,
      examples: [{ name: "Default", props: {}, children: "Example" }],
    };
    for (const version of ["1.0.0", "2.0.0", "3.0.0", "4.0.0"]) {
      const manifest = {
        name,
        version,
        type: "module",
        exports: { ".": { types: "./index.d.ts", default: "./index.js" } },
        types: "./index.d.ts",
        peerDependencies: { react: "^19.3.1" },
        studio: "./studio.json",
      };
      const metadata = {
        schemaVersion: 1,
        components: [
          {
            ...component,
            ...(version === "2.0.0" ? { styles: [name + "/missing.css"] } : {}),
            ...(version === "3.0.0"
              ? { provider: name + "#MissingProvider" }
              : {}),
          },
        ],
      };
      await registry.publish(manifest, {
        "index.js":
          version === "1.0.0"
            ? `export const Other = 1;`
            : `import {createElement as h} from 'react';export function Card({children}){return h('article',null,children)}`,
        "index.d.ts": `import type {ReactNode} from 'react';export declare function Card(props:{children?:ReactNode;${version === "4.0.0" ? "id:string;" : ""}}):ReactNode;`,
        "studio.json": JSON.stringify(metadata),
      });
    }
    const created = (await request("/projects", { name: "Keep accepted page" }))
      .data;
    const id = created.state.id;
    for (const [version, diagnostic] of [
      ["1.0.0", /runtime errors/],
      ["2.0.0", /style|stylesheet/],
      ["3.0.0", /exported types|required setup/],
      ["4.0.0", /exported types|required setup/],
    ] as const) {
      const result = await request(
        `/projects/${id}/library`,
        {
          base: created.snapshot.id,
          name,
          version,
          registry: registry.base,
          trust: true,
          apply: true,
        },
        true,
      );
      expect(result.status).toBe(422);
      expect(result.data.error).toMatch(diagnostic);
      const current = (await request(`/projects/${id}`)).data;
      expect(current.state.head).toBe(created.state.head);
      expect(current.snapshot.manifest.libraries).toEqual([]);
    }
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
