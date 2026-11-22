import { promises as fs } from "node:fs";
import type { Server } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config } from "../server/config.js";
import type { Project } from "../server/contracts.js";
import { createProject, updateProject } from "../server/store.js";

const { createApp } = await import("../server/app.js");

const failingAgent = fileURLToPath(new URL("./fixtures/failing-agent.mjs", import.meta.url));
const previousDataDir = config.dataDir;
const previousDeliveryDir = config.deliveryDir;
const previousAgentCommand = config.agentCommand;
let server: Server;
let origin: string;

beforeAll(async () => {
  config.dataDir = await fs.mkdtemp(path.resolve(".studio-send-"));
  config.deliveryDir = undefined;
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

async function queueNote(name: string): Promise<Project> {
  const project = await createProject(name);
  return updateProject(project.id, (current) => ({
    ...current,
    annotations: [
      {
        id: "note-1",
        pageId: "page-1",
        pageTitle: "Orders",
        target: { label: "Show overdue", domPath: "button" },
        note: "Call this Overdue only",
        createdAt: new Date().toISOString(),
      },
    ],
  }));
}

async function send(projectId: string) {
  const response = await fetch(`${origin}/api/projects/${projectId}/annotations/send`, {
    method: "POST",
  });
  return { status: response.status, body: (await response.json()) as { error?: string } };
}

async function read(projectId: string): Promise<Project> {
  const response = await fetch(`${origin}/api/projects/${projectId}`);
  return ((await response.json()) as { project: Project }).project;
}

describe("a send that does not reach an agent", () => {
  it("keeps notes queued and the server alive when the agent exits before reading", async () => {
    config.agentCommand = `node ${fileURLToPath(new URL("./fixtures/early-exit-agent.mjs", import.meta.url))}`;
    const project = await queueNote("Early exit");
    await updateProject(project.id, (current) => ({
      ...current, annotations: current.annotations.map((annotation) => ({ ...annotation, note: "x".repeat(8 * 1024 * 1024) })),
    }));
    expect((await send(project.id)).status).toBe(502);
    const after = await read(project.id);
    expect(after.batches).toHaveLength(0);
    expect(after.annotations[0]!.batchId).toBeUndefined();
    expect(after.annotations[0]!.note.length).toBe(8 * 1024 * 1024);
  });

  it("keeps the notes queued when no agent is configured", async () => {
    config.agentCommand = undefined;
    const project = await queueNote("No agent");

    const { status } = await send(project.id);
    expect(status).toBe(503);

    const after = await read(project.id);
    expect(after.batches).toHaveLength(0);
    expect(after.annotations).toHaveLength(1);
    expect(after.annotations[0]!.batchId).toBeUndefined();
  });

  it("keeps the notes queued when the agent rejects the batch", async () => {
    config.agentCommand = `node ${failingAgent}`;
    const project = await queueNote("Failing agent");

    const { status } = await send(project.id);
    expect(status).toBe(502);

    const after = await read(project.id);
    expect(after.batches).toHaveLength(0);
    expect(after.annotations[0]!.batchId).toBeUndefined();
  });
});
