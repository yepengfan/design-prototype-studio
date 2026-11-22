import { promises as fs } from "node:fs";
import path from "node:path";
import { createServer } from "vite";
import { expect, it } from "vitest";
import type { Project } from "../server/contracts.js";

it("accepts Studio writes through the development proxy while rejecting foreign origins", async () => {
  const dataDir = await fs.mkdtemp(path.resolve(".studio-dev-origin-"));
  const previousDataDir = process.env.STUDIO_DATA_DIR;
  const previousPort = process.env.PORT;
  process.env.STUDIO_DATA_DIR = dataDir;
  const { createApp } = await import("../server/app.js");
  const api = (await createApp()).listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => api.once("listening", resolve));
  const address = api.address();
  if (!address || typeof address === "string") throw new Error("No API port");
  process.env.PORT = String(address.port);
  let vite: Awaited<ReturnType<typeof createServer>> | undefined;
  try {
    // Load the real development configuration, including its API proxy.
    vite = await createServer({
      cacheDir: path.join(dataDir, "vite-cache"),
      server: { port: 0, host: "127.0.0.1" },
    });
    await vite.listen();
    const origin = vite.resolvedUrls!.local[0]!.replace(/\/$/, "");
    const write = (requestOrigin: string) => fetch(`${origin}/api/projects`, {
      method: "POST",
      headers: { origin: requestOrigin, "content-type": "application/json" },
      body: JSON.stringify({ name: "Development project" }),
    });

    const created = await write(origin);
    expect(created.status).toBe(201);
    const { project } = await created.json() as { project: Project };
    expect(project.name).toBe("Development project");
    const read = await fetch(`${origin}/api/projects/${project.id}`, { headers: { origin } });
    expect(read.status).toBe(200);
    const retrieved = await read.json() as { project: Project };
    expect(retrieved.project.id).toBe(project.id);

    for (const foreignOrigin of ["null", "https://foreign.example"]) {
      const denied = await write(foreignOrigin);
      expect(denied.status).toBe(403);
      const refusal = await denied.json() as { error: string };
      expect(refusal.error).toBe("The Studio API only answers its own pages.");
    }
  } finally {
    await vite?.close();
    await new Promise<void>((resolve, reject) => api.close((error) => error ? reject(error) : resolve()));
    if (previousDataDir === undefined) delete process.env.STUDIO_DATA_DIR;
    else process.env.STUDIO_DATA_DIR = previousDataDir;
    if (previousPort === undefined) delete process.env.PORT;
    else process.env.PORT = previousPort;
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}, 30_000);
