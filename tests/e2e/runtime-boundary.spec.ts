import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createServer as createViteServer } from "vite";
import react from "@vitejs/plugin-react";
import { createApp } from "../../server/app";
import { blankProject } from "../../server/core/project";
import { writeFiles } from "../../server/core/files";
import { accountFreeAI } from "../account-free-ai";

test("runtime factory proposals are diagnosed before publication while authored JSX and createElement remain editable", async ({ page }) => {
  const root = await fs.mkdtemp(path.join(process.cwd(), ".runtime-e2e-"));
  const runtime = path.join(root, "runtime");
  await fs.mkdir(runtime);
  await fs.symlink(path.resolve("node_modules"), path.join(runtime, "node_modules"), "dir");
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing port");
  const origin = `http://127.0.0.1:${address.port}`;
  const studio = await createApp({ root: path.join(root, "studio"), origin, ai: accountFreeAI });
  studio.previews.verify = async () => {};
  server.on("request", studio.app);
  const vite = await createViteServer({ root: runtime, configFile: false, plugins: [react()], server: { host: "127.0.0.1", port: 0, hmr: false } });
  try {
    const secret = (await (await fetch(origin + "/api/session")).json()).secret;
    const project = blankProject("Runtime boundary");
    project.manifest.scope = ["requirements"];
    project.files["requirements/notice.feature"] = "Feature: Notice\nScenario: Read\nGiven a notice exists\nThen the notice is visible\n";
    project.files["src/pages/Page.tsx"] = "export function Page(){return <main><h1>Supported</h1></main>}";
    const initial = await studio.store.create(project.manifest, project.files);
    const id = initial.state.id;
    const unsafe = "import {jsx as make} from 'react/jsx-runtime';export function Page(){return make('button',{children:'Confirm',onClick:()=>{document.body.dataset.confirmed='yes'}})}";
    await writeFiles(runtime, { ...initial.snapshot.files, "src/pages/Page.tsx": unsafe });
    await vite.listen();
    await page.goto(vite.resolvedUrls!.local[0]);
    await page.getByRole("button", { name: "Confirm" }).click();
    await expect(page.locator("body")).toHaveAttribute("data-confirmed", "yes");
    const apply = async (run: string, source: string, kind: "business" | "presentation", projectId = id) => {
      const current = await studio.store.get(projectId);
      current.state.runs.push({ id: run, base: current.snapshot.id, page: "page", adapter: "codex", prompt: "Update the notice", status: "review", events: [], proposal: { kind, summary: "Notice", files: { "src/pages/Page.tsx": source, ...(kind === "business" ? { "requirements/notice.feature": project.files["requirements/notice.feature"].replace("the notice is visible", "confirmation is available") } : {}) }, questions: [], affectedScenarios: [] } });
      await studio.store.saveState(current.state);
      return fetch(`${origin}/api/projects/${projectId}/runs/${run}/apply`, { method: "POST", headers: { "Content-Type": "application/json", "X-Studio-Session": secret }, body: "{}" });
    };
    const rejected = await apply("unsupported-runtime", unsafe, "business");
    expect(rejected.status).toBe(422);
    expect((await rejected.json()).error).toMatch(/automatic.*runtime/i);
    expect((await studio.store.get(id)).snapshot).toEqual(initial.snapshot);
    for (const [name, source] of [
      ["jsx", "export function Page(){return <main><h1>JSX caption</h1></main>}"],
      ["factory", "import {createElement as h} from 'react';export function Page(){return h('main',null,h('h1',null,'Factory caption'))}"],
    ]) {
      const base = await studio.store.create(project.manifest, { ...project.files, "src/pages/Page.tsx": source.replace("JSX caption", "Supported").replace("Factory caption", "Supported") });
      const accepted = await apply(name, source, "presentation", base.state.id);
      const data = await accepted.json();
      expect(accepted.status, JSON.stringify(data)).toBe(200);
      await writeFiles(runtime, data.snapshot.files);
      vite.moduleGraph.invalidateAll();
      await page.goto(vite.resolvedUrls!.local[0] + "?revision=" + data.snapshot.id);
      await expect(page.getByRole("heading")).toHaveText(name === "jsx" ? "JSX caption" : "Factory caption");
      await expect(page.getByRole("button")).toHaveCount(0);
    }
  } finally { await studio.close(); await vite.close(); await new Promise<void>((resolve) => server.close(() => resolve())); await fs.rm(root, { recursive: true, force: true }); }
});
