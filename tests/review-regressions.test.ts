import { promises as fs } from "node:fs";
import path from "node:path";
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
  config.agentCommand = undefined;
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
  return response.json();
}

describe("review regressions through project interfaces", () => {
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
    expect(delivery).toMatchObject({ transport: "file", receipt: "1 note written for an agent to pick up." });
    expect(await fs.readFile(delivery.target, "utf8")).toContain("Page: Orders (src/app/page.tsx)");
    expect(sent.annotations[0]!.batchId).toBe(sent.batches[0]!.id);
  });
});
