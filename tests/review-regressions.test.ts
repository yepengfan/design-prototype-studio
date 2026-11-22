import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Project } from "../server/contracts.js";
import { config } from "../server/config.js";
import { createProject, loadProject, updateProject } from "../server/store.js";
import { fixtureRegistry, ordersGherkin } from "./fixtures.js";

vi.mock("../server/dependencies.js", () => ({ ensurePackages: vi.fn() }));
vi.mock("../server/preview.js", () => ({ buildPreview: vi.fn() }));

const { createApp } = await import("../server/app.js");
const { buildPreview } = await import("../server/preview.js");
const deliveryModule = await import("../server/delivery.js");
const previousDataDir = config.dataDir;
const previousDeliveryDir = config.deliveryDir;
const previousAgentCommand = config.agentCommand;
let server: Server;
let origin: string;

beforeAll(async () => {
  config.dataDir = await fs.mkdtemp(path.resolve(".studio-review-"));
  config.deliveryDir = undefined;
  config.agentCommand = `node ${fileURLToPath(new URL("./fixtures/review-agent.mjs", import.meta.url))}`;
  const app = await createApp();
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const address = server.address();
  origin = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(config.dataDir, { recursive: true, force: true });
  config.dataDir = previousDataDir;
  config.deliveryDir = previousDeliveryDir;
  config.agentCommand = previousAgentCommand;
});

async function call(route: string, method = "GET", body?: unknown): Promise<{ project: Project }> {
  const response = await fetch(`${origin}${route}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  expect(response.ok).toBe(true);
  return (await response.json()) as { project: Project };
}

describe("review regressions through project interfaces", () => {
  it("clears a deselected system's template while retaining a still-available selection", async () => {
    const { project: created } = await call("/api/projects", "POST", { name: "Selection" });
    const base = `/api/projects/${created.id}`;
    const { project: first } = await call(`${base}/systems`, "POST", { name: "A", spec: fixtureRegistry });
    const a = first.systems[0]!;
    const { project: both } = await call(`${base}/systems`, "POST", { name: "B", spec: fixtureRegistry });
    const b = both.systems.find((system) => system.name === "B")!;
    await call(`${base}/template`, "PUT", { templateId: a.templates[0]!.id });
    const { project: kept } = await call(`${base}/systems/selection`, "PUT", { systemIds: [a.id] });
    expect(kept.selectedTemplateId).toBe(a.templates[0]!.id);
    const { project: cleared } = await call(`${base}/systems/selection`, "PUT", { systemIds: [b.id] });
    expect(cleared.selectedSystemIds).toEqual([b.id]);
    expect(cleared.selectedTemplateId).toBeUndefined();
    expect((await call(base)).project.selectedTemplateId).toBeUndefined();
    await call(`${base}/template`, "PUT", { templateId: b.templates[0]!.id });
    const { project: generated } = await call(`${base}/generate`, "POST", {
      templateId: b.templates[0]!.id, gherkin: ordersGherkin,
    });
    expect(generated.pages[0]!.templateId).toBe(b.templates[0]!.id);
  });

  it.each([false, true])("merges registry closures with conflicting contents: %s", async (conflicting) => {
    const directories = ["A", "B"].map((name) => path.join(config.dataDir, `collision-${conflicting}-${name}`));
    for (const directory of directories) await fs.cp(path.resolve("tests/fixtures/registry"), directory, { recursive: true });
    const aDirectory = directories[0]!;
    const bDirectory = directories[1]!;
    const index = JSON.parse(await fs.readFile(path.join(aDirectory, "index.json"), "utf8")) as { name: string }[];
    await fs.writeFile(path.join(aDirectory, "index.json"), JSON.stringify(index.filter((entry) => entry.name !== "card")));
    await fs.writeFile(path.join(bDirectory, "index.json"), JSON.stringify(index.filter((entry) => entry.name === "card")));
    const card = JSON.parse(await fs.readFile(path.join(bDirectory, "card.json"), "utf8")) as Record<string, unknown>;
    await fs.writeFile(path.join(bDirectory, "card.json"), JSON.stringify({ ...card, registryDependencies: ["button"] }));
    if (conflicting) {
      const buttonFile = path.join(bDirectory, "button.json");
      const button = JSON.parse(await fs.readFile(buttonFile, "utf8")) as { files: { content: string }[] };
      button.files[0]!.content += '\nexport const registryVariant = "B";';
      await fs.writeFile(buttonFile, JSON.stringify(button));
    }
    const { project: created } = await call("/api/projects", "POST", { name: "Registry collision" });
    const base = `/api/projects/${created.id}`;
    await call(`${base}/systems`, "POST", { name: "A", spec: { ...fixtureRegistry,
      url: pathToFileURL(aDirectory).toString(), indexUrl: pathToFileURL(path.join(aDirectory, "index.json")).toString(),
    } });
    const { project: imported } = await call(`${base}/systems`, "POST", { name: "B", spec: { ...fixtureRegistry,
      url: pathToFileURL(bDirectory).toString(), indexUrl: pathToFileURL(path.join(bDirectory, "index.json")).toString(), blocks: [],
    } });
    const buildsBefore = vi.mocked(buildPreview).mock.calls.length;
    const response = await fetch(`${origin}${base}/generate`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ templateId: imported.systems[0]!.templates[0]!.id,
        gherkin: `${ordersGherkin}    Then I see a "Row count" summary\n`,
      }),
    });
    if (conflicting) {
      expect(response.status).toBe(422);
      const { error } = await response.json() as { error: string };
      expect(error).toContain("src/registry/fixture/ui/button.tsx");
      expect(error).toContain('"A"');
      expect(error).toContain('"B"');
      expect(vi.mocked(buildPreview).mock.calls.length).toBe(buildsBefore);
      expect((await call(base)).project.pages).toHaveLength(0);
    } else {
      expect(response.status).toBe(200);
      const { project } = await response.json() as { project: Project };
      expect(project.pages[0]!.plan.gaps).toEqual([]);
      const built = vi.mocked(buildPreview).mock.calls.at(-1)![1];
      expect(built.files.filter((file) => file.path === "src/registry/fixture/ui/button.tsx")).toHaveLength(1);
    }
  });

  it("reconciles selections atomically on re-import", async () => {
    const { project: created } = await call("/api/projects", "POST", { name: "Re-import" });
    const base = `/api/projects/${created.id}`;
    const source = { name: "Fixture", spec: fixtureRegistry };
    const { project: imported } = await call(`${base}/systems`, "POST", source);
    const oldSystem = imported.systems[0]!;
    await call(`${base}/template`, "PUT", { templateId: oldSystem.templates[0]!.id });
    await call(`${base}/systems`, "POST", source);
    const { project: reloaded } = await call(base);
    expect(reloaded.selectedSystemIds).toEqual([reloaded.systems[0]!.id]);
    expect(reloaded.selectedSystemIds).not.toContain(oldSystem.id);
    expect(reloaded.selectedTemplateId).toBeUndefined();
    await call(`${base}/systems/selection`, "PUT", { systemIds: [] });
    await call(`${base}/systems/selection`, "PUT", { systemIds: reloaded.selectedSystemIds });
    const templateId = reloaded.systems[0]!.templates[0]!.id;
    await call(`${base}/template`, "PUT", { templateId });
    const { project: generated } = await call(`${base}/generate`, "POST", { templateId, gherkin: ordersGherkin });
    expect(generated.pages).toHaveLength(1);
  });

  it("keeps queued notes while identifying their anchors as belonging to a prior generation", async () => {
    const { project: created } = await call("/api/projects", "POST", { name: "Changed interaction" });
    const base = `/api/projects/${created.id}`;
    const { project: imported } = await call(`${base}/systems`, "POST", { name: "Fixture", spec: fixtureRegistry });
    const templateId = imported.systems[0]!.templates[0]!.id;
    const { project: generated } = await call(`${base}/generate`, "POST", { templateId, gherkin: ordersGherkin });
    await call(`${base}/annotations`, "POST", {
      pageId: generated.pages[0]!.id, note: "Call this Overdue only",
      target: { label: "Show overdue", domPath: "button", anchor: "control-show-overdue" },
    });
    const gherkin = ordersGherkin.replace('I choose "Show overdue"', 'I type "A-101" into "Order"');
    await call(`${base}/generate`, "POST", { templateId, gherkin });
    const { project: reloaded } = await call(base);
    expect(reloaded.gherkin).toBe(gherkin);
    expect(reloaded.annotations).toHaveLength(1);
    expect(reloaded.annotations[0]!.batchId).toBeUndefined();
    const { project: sent } = await call(`${base}/annotations/send`, "POST");
    const briefing = await fs.readFile(path.join(config.dataDir, "deliveries", `${sent.batches[0]!.id}.md`), "utf8");
    expect(briefing).toContain(gherkin.trim());
    expect(briefing).toContain("Anchor (prior generation): control-show-overdue");
    expect(briefing).toContain("Anchor and selector belong to a prior generation, not the current use case or template.");
    expect(briefing).not.toContain("   - Anchor: control-show-overdue");
    expect(briefing).not.toContain("Page: Orders (src/app/page.tsx)");
    await call(`${base}/annotations`, "POST", {
      pageId: reloaded.pages[0]!.id, note: "Current search",
      target: { label: "Order", domPath: "input", anchor: "control-order" },
    });
    const { project: current } = await call(base);
    const currentBriefing = deliveryModule.renderBriefing(current, "current", [current.annotations.at(-1)!]);
    expect(currentBriefing).toContain("   - Anchor: control-order");
    expect(currentBriefing).not.toContain("prior generation");
  });

  it("serializes mutations and releases the queue after a failure", async () => {
    const project = await createProject("Concurrent updates");
    let release!: () => void;
    const pause = new Promise<void>((resolve) => { release = resolve; });
    const first = updateProject(project.id, async (current) => {
      await pause;
      return { ...current, name: "First update" };
    });
    const second = updateProject(project.id, (current) => ({ ...current, gherkin: "Second update" }));
    release();
    await Promise.all([first, second]);
    expect(await loadProject(project.id)).toMatchObject({ name: "First update", gherkin: "Second update" });
    await expect(updateProject(project.id, () => { throw new Error("Rejected update"); })).rejects.toThrow("Rejected update");
    await updateProject(project.id, (current) => ({ ...current, name: "Still writable" }));
    expect((await loadProject(project.id)).name).toBe("Still writable");
  });

  it("refuses a second scenario at generation instead of building from the first alone", async () => {
    const { project: created } = await call("/api/projects", "POST", { name: "Two scenarios" });
    const base = `/api/projects/${created.id}`;
    const { project: imported } = await call(`${base}/systems`, "POST", { name: "Fixture", spec: fixtureRegistry });
    const templateId = imported.systems[0]!.templates[0]!.id;

    const response = await fetch(`${origin}${base}/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        templateId,
        gherkin: `${ordersGherkin}
  Scenario: Delete an order
    When I click "Delete order"
    Then order "A-101" is gone
`,
      }),
    });

    expect(response.status).toBe(422);
    const refusal = (await response.json()) as { error?: string };
    expect(refusal.error).toContain("Delete an order");

    // No page was built, so the second scenario cannot have been dropped quietly.
    const { project: after } = await call(base);
    expect(after.pages).toHaveLength(0);
  });

  it("preserves selections during builds and notes across repeated generation and pickup", async () => {
    const { project: created } = await call("/api/projects", "POST", { name: "Orders" });
    const base = `/api/projects/${created.id}`;
    const { project: imported } = await call(`${base}/systems`, "POST", { name: "Fixture", spec: fixtureRegistry });
    const templateId = imported.systems[0]!.templates[0]!.id;
    const request = { gherkin: ordersGherkin, templateId };
    await call(`${base}/generate`, "POST", request);
    const { project: generated } = await call(base);
    const pageId = generated.pages[0]!.id;
    await call(`${base}/annotations`, "POST", {
      pageId, note: "Call this Overdue only", target: { label: "Show overdue", domPath: "button", anchor: "control-show-overdue" },
    });
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const pause = new Promise<void>((resolve) => { release = resolve; });
    vi.mocked(buildPreview).mockImplementationOnce(async () => { entered(); await pause; });
    const generating = call(`${base}/generate`, "POST", request);
    await started;
    const selecting = call(`${base}/systems/selection`, "PUT", { systemIds: [] });
    release();
    await Promise.all([generating, selecting]);
    expect((await call(base)).project.selectedSystemIds).toEqual([]);
    await call(`${base}/systems/selection`, "PUT", { systemIds: imported.selectedSystemIds });
    const { project: regenerated } = await call(`${base}/generate`, "POST", request);
    expect(regenerated.pages[0]!.id).toBe(pageId);
    expect(regenerated.annotations).toHaveLength(1);
    expect(regenerated.annotations[0]!.pageId).toBe(pageId);
    const deliver = deliveryModule.deliverBatch;
    let delivering!: () => void;
    let finish!: () => void;
    const deliveryStarted = new Promise<void>((resolve) => { delivering = resolve; });
    const deliveryPause = new Promise<void>((resolve) => { finish = resolve; });
    vi.spyOn(deliveryModule, "deliverBatch").mockImplementationOnce(async (...args) => {
      delivering();
      await deliveryPause;
      return deliver(...args);
    });
    const sending = call(`${base}/annotations/send`, "POST");
    await deliveryStarted;
    const removing = call(`${base}/annotations/${regenerated.annotations[0]!.id}`, "DELETE");
    finish();
    const { project: sent } = await sending;
    await removing;
    expect((await call(base)).project.annotations).toEqual([]);
    expect((await call(base)).project.batches).toHaveLength(1);
    const delivery = sent.batches[0]!.delivery;
    expect(delivery).toMatchObject({ transport: "command", receipt: "1 note received by the review agent." });
    expect(delivery.reply).toContain("note(s) understood");
    const briefing = path.join(config.dataDir, "deliveries", `${sent.batches[0]!.id}.md`);
    expect(await fs.readFile(briefing, "utf8")).toContain("Anchor (prior generation): control-show-overdue");
    expect(sent.annotations[0]!.batchId).toBe(sent.batches[0]!.id);
  });
});
