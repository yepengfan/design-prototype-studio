import { e2eFixture } from "../e2e-fixture";
import { test, expect } from "@playwright/test";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createServer } from "node:http";
import { createServer as createViteServer } from "vite";
import react from "@vitejs/plugin-react";
import { createApp } from "../../server/app";
import { accountFreeAI } from "../account-free-ai";
import { componentSchema } from "../../server/core/contracts";
import { blankProject } from "../../server/core/project";
import { anchors, editSource } from "../../server/core/source";
import { digest, writeFiles } from "../../server/core/files";

test("publication preserves native render uses through values, aliases, wrappers and factories", async ({ page }) => {
  test.setTimeout(240000);
  const root = await e2eFixture(".source-boundary-");
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
  const consumerFile = path.join(root, "consumer.tsx");
  await fs.writeFile(consumerFile, `import {createElement as h} from "react";export function Once({children}){return h("aside",null,children)}export function Twice({children}){return h("aside",null,children,children)}`);
  const vite = await createViteServer({ resolve: { alias: { "@fixture/consumer": consumerFile } }, root: runtime, configFile: false, plugins: [react()], server: { host: "127.0.0.1", port: 0, hmr: false, watch: null } });
  const secret = (await (await fetch(origin + "/api/session")).json()).secret;
  const request = async (id: string, snapshot: { id: string; files: Record<string, string> }, operation: string, tag: string, extra = {}) => {
    const node = anchors(snapshot.files["src/pages/Page.tsx"]).find((node) => node.tag === tag && (tag !== "section" || !!node.parent))!;
    const response = await fetch(`${origin}/api/projects/${id}/edit`, { method: "POST", headers: { "Content-Type": "application/json", "X-Studio-Session": secret }, body: JSON.stringify({ base: snapshot.id, page: "page", edit: { anchor: node.id, sourceHash: digest(snapshot.files["src/pages/Page.tsx"]), operation, ...extra } }) });
    return { status: response.status, body: await response.json() };
  };
  const handler = `()=>{document.getElementById('result')!.textContent='Confirmed'}`;
  const button = `<button onClick={${handler}}>Confirm</button>`;
  const factory = `h('button',{onClick:${handler}},'Confirm')`;
  const cases = [
    { name: "external alias", definitions: `import {Once as Box} from "@fixture/consumer";`, use: `<Box>${button}</Box>` },
    { name: "direct", definitions: "", use: button },
    { name: "direct JSX child", definitions: `function Slot({children}){return <aside><h2>Caption</h2>{children}</aside>}`, use: `<Slot>${button}</Slot>`, consumer: "children", factoryConsumer: false },
    { name: "inline JSX slot", definitions: `function Slot({header}){return <aside><h2>Caption</h2>{header}</aside>}`, use: `<Slot header={${button}}/>`, consumer: "header", factoryConsumer: false },
    { name: "direct factory child", definitions: `function Slot({children}){return h('aside',null,h('h2',null,'Caption'),children)}`, use: `{h(Slot,null,${factory})}`, consumer: "children", factoryConsumer: true },
    { name: "inline factory slot", definitions: `function Slot({header}){return h('aside',null,h('h2',null,'Caption'),header)}`, use: `{h(Slot,{header:${factory}})}`, consumer: "header", factoryConsumer: true },
    { name: "wrapper", definitions: `function Legacy(){return ${button}}`, use: "<Legacy/>" },
    { name: "wrapper alias", definitions: `function Legacy(){return ${button}}const Alias=Legacy;`, use: "<Alias/>" },
    { name: "value", definitions: `const action=${button};`, use: "{action}" },
    { name: "value slot", definitions: `const action=${button};function Slot({header}){return <aside><h2>Caption</h2>{header}</aside>}`, use: "<Slot header={action}/>" },
    { name: "value alias", definitions: `const action=${button};const alias=action;`, use: "{alias}" },
    { name: "factory value", definitions: `const action=${factory};const alias=action;`, use: "{alias}" },
    { name: "factory wrapper", definitions: `function Legacy(){return ${factory}}const Alias=Legacy;`, use: "{h(Alias)}" },
  ].sort((a,b) => Number(b.name === "value") - Number(a.name === "value"));
  try {
    let listening = false;
    for (const fixture of cases) {
      const project = blankProject(fixture.name);
      project.files["requirements/notice.feature"] = "Feature: Notice\nScenario: Confirm\nGiven a notice exists\nThen confirmation is available\n";
      project.manifest.scope = ["requirements"];
      project.files["src/pages/Page.tsx"] = `import {createElement as h} from 'react';${fixture.definitions}export function Page(){return <main><p id="result">Ready</p><section>${fixture.use}</section><section>${fixture.use}</section></main>}`;
      if (fixture.name === "external alias") project.manifest.libraries = [{ name: "@fixture/consumer", version: "1.0.0", components: ["Once", "Twice"].map((name) => componentSchema.parse({ name, export: name, package: "@fixture/consumer", version: "1.0.0", description: "Container", provenance: "Published", children: true, props: {}, examples: [{ name: "Default", props: {} }] })) }];
      const initial = await studio.store.create(project.manifest, project.files);
      const id = initial.state.id;
      let snapshot = initial.snapshot;
      const render = async (count: number) => {
        await writeFiles(runtime, snapshot.files);
        if (!listening) { await vite.listen(); listening = true; }
        vite.moduleGraph.invalidateAll();
        await page.goto(vite.resolvedUrls!.local[0] + "?revision=" + snapshot.id);
        await expect(page.getByRole("button", { name: "Confirm" }), fixture.name + " " + snapshot.label).toHaveCount(count);
        if (count) { await page.getByRole("button", { name: "Confirm" }).first().click(); await expect(page.locator("#result")).toHaveText("Confirmed"); }
      };
      await render(2);
      const styled = await request(id, snapshot, "style", "section", { value: { padding: 24 } });
      expect(styled.status, fixture.name).toBe(200);
      snapshot = styled.body.snapshot;
      await render(2);
      const wrapped = await request(id, snapshot, "wrap", "section", { layout: "grid" });
      expect(wrapped.status, fixture.name).toBe(200);
      snapshot = wrapped.body.snapshot;
      await render(2);
      for (const annotation of [undefined, "layout-note"]) {
        const current = snapshot.files["src/pages/Page.tsx"];
        const main = anchors(current).find((node) => node.tag === "main")!;
        const updated = editSource(current, { anchor: main.id, sourceHash: digest(current), operation: "style", value: { padding: annotation ? 48 : 32 } }, []);
        const runId = annotation ?? "prompt-layout";
        const pending = await studio.store.get(id);
        pending.state.runs.push({ id: runId, base: snapshot.id, page: "page", adapter: "codex", prompt: "More space", status: "review", events: [], annotation,
          proposal: { kind: "presentation", summary: "More space", files: { "src/pages/Page.tsx": updated }, questions: [], affectedScenarios: [] } });
        await studio.store.saveState(pending.state);
        const response = await fetch(`${origin}/api/projects/${id}/runs/${runId}/apply`, { method: "POST", headers: { "Content-Type": "application/json", "X-Studio-Session": secret }, body: "{}" });
        expect(response.status, fixture.name + " prompt/annotation").toBe(200);
        snapshot = (await response.json()).snapshot;
        await render(2);
        if (annotation) {
          const response = await fetch(`${origin}/api/projects/${id}/annotations/undo`, { method: "POST", headers: { "Content-Type": "application/json", "X-Studio-Session": secret }, body: JSON.stringify({ id: runId, base: snapshot.id }) });
          expect(response.status).toBe(200);
          snapshot = (await response.json()).snapshot;
          await render(2);
        }
      }
      if (fixture.consumer && !fixture.factoryConsumer) {
        const text = await request(id, snapshot, "text", "h2", { value: "Inspector caption" });
        expect(text.status, fixture.name + " inspector caption").toBe(200);
        snapshot = text.body.snapshot;
        await render(2);
        await expect(page.getByRole("heading").first()).toHaveText("Inspector caption");
        const pending = await studio.store.get(id);
        pending.state.runs.push({ id: "prompt-caption", base: snapshot.id, page: "page", adapter: "codex", prompt: "Update the caption", status: "review", events: [], proposal: { kind: "presentation", summary: "Caption", files: { "src/pages/Page.tsx": snapshot.files["src/pages/Page.tsx"].replace("Inspector caption", "Prompt caption") }, questions: [], affectedScenarios: [] } });
        await studio.store.saveState(pending.state);
        const response = await fetch(`${origin}/api/projects/${id}/runs/prompt-caption/apply`, { method: "POST", headers: { "Content-Type": "application/json", "X-Studio-Session": secret }, body: "{}" });
        expect(response.status, fixture.name + " prompt caption " + await response.clone().text()).toBe(200);
        snapshot = (await response.json()).snapshot;
        await render(2);
        await expect(page.getByRole("heading").first()).toHaveText("Prompt caption");
      }
      if (fixture.name === "external alias") {
        const accepted = snapshot;
        const changed = snapshot.files["src/pages/Page.tsx"].replace("Once as Box", "Twice as Box");
        snapshot = { ...snapshot, id: "unchecked-identity", files: { ...snapshot.files, "src/pages/Page.tsx": changed } };
        await render(4);
        snapshot = accepted;
        await render(2);
        const pending = await studio.store.get(id);
        pending.state.runs.push({ id: "replace-consumer", base: snapshot.id, page: "page", adapter: "codex", prompt: "Repeat", status: "review", events: [], proposal: { kind: "business", summary: "Repeat", files: { "src/pages/Page.tsx": changed, "requirements/notice.feature": snapshot.files["requirements/notice.feature"].replace("available", "repeated") }, questions: [], affectedScenarios: [] } });
        await studio.store.saveState(pending.state);
        const response = await fetch(`${origin}/api/projects/${id}/runs/replace-consumer/apply`, { method: "POST", headers: { "Content-Type": "application/json", "X-Studio-Session": secret }, body: "{}" });
        expect(response.status).toBe(422);
        expect((await response.json()).error).toMatch(/control|preserv/);
        expect((await studio.store.get(id)).snapshot).toEqual(snapshot);
      }
      if (fixture.consumer) {
        if (fixture.factoryConsumer) {
          const current = snapshot.files["src/pages/Page.tsx"];
          snapshot = (await studio.store.commit(id, snapshot.id, { ...snapshot.files, "src/pages/Page.tsx": current.replace("h('aside',null,", "h('aside',{style:{padding:24}},") }, snapshot.manifest, "Consumer spacing")).snapshot;
        } else {
          const styled = await request(id, snapshot, "style", "aside", { value: { padding: 24 } });
          expect(styled.status, fixture.name + " consumer style").toBe(200);
          snapshot = styled.body.snapshot;
          const wrapped = await request(id, snapshot, "wrap", "aside", { layout: "grid" });
          expect(wrapped.status, fixture.name + " consumer layout").toBe(200);
          snapshot = wrapped.body.snapshot;
        }
        await render(2);
        const current = snapshot.files["src/pages/Page.tsx"];
        const duplicated = fixture.factoryConsumer ? current.replace(`,${fixture.consumer})`, `,${fixture.consumer},${fixture.consumer})`) : current.replace(`{${fixture.consumer}}</aside>`, `{${fixture.consumer}}{${fixture.consumer}}</aside>`);
        const accepted = snapshot;
        snapshot = { ...snapshot, id: "unchecked-consumption", files: { ...snapshot.files, "src/pages/Page.tsx": duplicated } };
        await render(4);
        snapshot = accepted;
        await render(2);
        const pending = await studio.store.get(id);
        pending.state.runs.push({ id: "consumer-change", base: snapshot.id, page: "page", adapter: "codex", prompt: "Repeat the consumer", status: "review", events: [],
          proposal: { kind: "business", summary: "Repeat the consumer", files: { "src/pages/Page.tsx": duplicated, "requirements/notice.feature": snapshot.files["requirements/notice.feature"].replace("available", "repeated") }, questions: [], affectedScenarios: [] } });
        await studio.store.saveState(pending.state);
        const response = await fetch(`${origin}/api/projects/${id}/runs/consumer-change/apply`, { method: "POST", headers: { "Content-Type": "application/json", "X-Studio-Session": secret }, body: "{}" });
        expect(response.status, fixture.name + " consumer publication").toBe(422);
        expect((await response.json()).error).toMatch(/control|preserv|compatibility/);
        expect((await studio.store.get(id)).snapshot).toEqual(snapshot);
      }
      const rejected = await request(id, snapshot, "duplicate", "section");
      expect(rejected.status, fixture.name).toBe(422);
      expect(rejected.body.error).toMatch(/control|preserv|compatibility/);
      expect((await studio.store.get(id)).snapshot).toEqual(snapshot);
      const source = snapshot.files["src/pages/Page.tsx"];
      const region = anchors(source).find((node) => node.tag === "section" && !!node.parent)!;
      const removal = editSource(source, { anchor: region.id, sourceHash: digest(source), operation: "remove", confirmedBusiness: true }, [], { files: snapshot.files, file: "src/pages/Page.tsx" });
      const removed = await studio.store.persist(id, { parent: snapshot.id, files: { ...snapshot.files, "src/pages/Page.tsx": removal, "requirements/notice.feature": snapshot.files["requirements/notice.feature"].replace("confirmation is available", "one confirmation is available") }, manifest: snapshot.manifest, label: "Reviewed removal", activeAnnotationResults: ["remove-result"] });
      const accepted = await studio.store.get(id);
      accepted.state.runs.push({ id: "remove-result", base: snapshot.id, appliedBase: snapshot.id, appliedRevision: removed.id, adapter: "codex", prompt: "Reviewed removal", status: "applied", annotation: "remove-note", events: [] });
      accepted.state.head = removed.id;
      await studio.store.saveState(accepted.state);
      snapshot = removed;
      await render(1);
      const undo = await fetch(`${origin}/api/projects/${id}/annotations/undo`, { method: "POST", headers: { "Content-Type": "application/json", "X-Studio-Session": secret }, body: JSON.stringify({ id: "remove-result", base: snapshot.id }) });
      expect(undo.status, fixture.name + " trusted undo").toBe(200);
      snapshot = (await undo.json()).snapshot;
      await render(2);
      const inactiveSource = `import {createElement as h} from 'react';${fixture.definitions}export function Page(){return <main><p id="result">Ready</p>{false && <section>${fixture.use}</section>}</main>}`;
      const inactive = await studio.store.create(project.manifest, { ...project.files, "src/pages/Page.tsx": inactiveSource });
      snapshot = inactive.snapshot;
      await render(0);
      await expect(studio.store.commit(inactive.state.id, snapshot.id, { ...snapshot.files, "src/pages/Page.tsx": inactiveSource.replace("false &&", "true &&"), "requirements/notice.feature": snapshot.files["requirements/notice.feature"].replace("available", "active") }, snapshot.manifest, "Activate")).rejects.toThrow(/control|preserv/);
      expect((await studio.store.get(inactive.state.id)).snapshot).toEqual(snapshot);
    }
  } finally { await studio.close(); await vite.close(); await new Promise<void>((resolve) => server.close(() => resolve())); await fs.rm(root, { recursive: true, force: true }); }
});
