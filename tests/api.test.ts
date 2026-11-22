import { promises as fs } from "node:fs";
import type { Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "studio-api-"));
process.env.STUDIO_DATA_DIR = dataDir;

const { createApp } = await import("../server/app.js");
const app = await createApp();

let server: Server;
let origin: string;

beforeAll(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const address = server.address();
  origin = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(dataDir, { recursive: true, force: true });
});

async function call<T>(path: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const response = await fetch(`${origin}${path}`, {
    ...init,
    headers: init?.body ? { "content-type": "application/json" } : undefined,
  });
  return { status: response.status, body: (await response.json()) as T };
}

describe("the Studio API", () => {
  it("offers the shadcn/ui pilot preset and a starting use case", async () => {
    const { body } = await call<{ presets: { name: string }[]; defaultGherkin: string }>("/api/presets");
    expect(body.presets.map((preset) => preset.name)).toContain("shadcn/ui");
    expect(body.defaultGherkin).toContain("Feature: Review overdue orders");
  });

  it("creates and reads back a project", async () => {
    const created = await call<{ project: { id: string; name: string } }>("/api/projects", {
      method: "POST",
      body: JSON.stringify({ name: "Orders" }),
    });
    expect(created.status).toBe(201);

    const read = await call<{ project: { name: string } }>(`/api/projects/${created.body.project.id}`);
    expect(read.body.project.name).toBe("Orders");
  });

  it("answers an unknown project with 404 and a readable message", async () => {
    const { status, body } = await call<{ error: string }>("/api/projects/does-not-exist");
    expect(status).toBe(404);
    expect(body.error).toContain("No project with id");
  });

  it("refuses a design system import that names no source", async () => {
    const { body: created } = await call<{ project: { id: string } }>("/api/projects", {
      method: "POST",
      body: JSON.stringify({ name: "Invalid source" }),
    });
    const { status, body } = await call<{ error: string }>(
      `/api/projects/${created.project.id}/systems`,
      { method: "POST", body: JSON.stringify({ name: "Nope", spec: { kind: "registry" } }) },
    );
    expect(status).toBe(400);
    expect(body.error).toContain("spec.url");
  });

  it("refuses a template no selected system publishes", async () => {
    const { body: created } = await call<{ project: { id: string } }>("/api/projects", {
      method: "POST",
      body: JSON.stringify({ name: "No templates" }),
    });
    const { status, body } = await call<{ error: string }>(
      `/api/projects/${created.project.id}/template`,
      { method: "PUT", body: JSON.stringify({ templateId: "nobody:anything" }) },
    );
    expect(status).toBe(400);
    expect(body.error).toContain("not published by a selected design system");
  });

  it("refuses a selection that names a system the project never imported", async () => {
    const { body: created } = await call<{ project: { id: string } }>("/api/projects", {
      method: "POST",
      body: JSON.stringify({ name: "Unknown selection" }),
    });
    const { status, body } = await call<{ error: string }>(
      `/api/projects/${created.project.id}/systems/selection`,
      { method: "PUT", body: JSON.stringify({ systemIds: ["ghost"] }) },
    );
    expect(status).toBe(400);
    expect(body.error).toContain("ghost");
  });

  it("refuses to send a feedback batch with nothing queued", async () => {
    const { body: created } = await call<{ project: { id: string } }>("/api/projects", {
      method: "POST",
      body: JSON.stringify({ name: "No notes" }),
    });
    const { status, body } = await call<{ error: string }>(
      `/api/projects/${created.project.id}/annotations/send`,
      { method: "POST" },
    );
    expect(status).toBe(400);
    expect(body.error).toContain("Queue at least one note");
  });

  it("answers an unknown preview with 404", async () => {
    const response = await fetch(`${origin}/preview/not-a-project/index.html`);
    expect(response.status).toBe(404);
  });
});
