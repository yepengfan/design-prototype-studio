import { e2eFixture } from "../e2e-fixture";
import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createApp } from "../../server/app";
import { registryFixture } from "../registry";
import { prototypeFixture } from "../prototype";
import { exportArchive } from "../../server/core/archive";

test("failed reviewed scenarios trigger a bounded staged repair without changing requirements, plans or accepted source", async () => {
  test.setTimeout(300000);
  const root = await e2eFixture("studio-repair-e2e-");
  const registry = await registryFixture(root);
  const prior = process.env.npm_config_userconfig;
  process.env.npm_config_userconfig = registry.config;
  const prototype = await prototypeFixture(
    path.join(root, "prototype"),
    registry.base,
  );
  const original = prototype.files["src/pages/Page.tsx"];
  prototype.files["src/pages/Page.tsx"] = original.replace(
    "Name is required",
    "Wrong validation message",
  );
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No port");
  const origin = `http://127.0.0.1:${address.port}`;
  let proposals = 0;
  const studio = await createApp({
    root: path.join(root, "studio"),
    origin,
    ai: {
      async generate(run) {
        expect(run.repair).toBe(true);
        expect(run.adapter).toBe("cursor");
        proposals++;
        return {
          kind: "business",
          summary:
            "Restore required-name validation to its reviewed requirement",
          files: { "src/pages/Page.tsx": original },
          questions: [],
          affectedScenarios: [],
        };
      },
      async cancel() {},
      close() {},
    },
  });
  server.on("request", studio.app);
  const secret = (await (await fetch(origin + "/api/session")).json()).secret;
  const request = async (url: string, body?: unknown) => {
    const response = await fetch(origin + "/api" + url, {
      method: body ? "POST" : "GET",
      headers: {
        "Content-Type": "application/json",
        "X-Studio-Session": secret,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await response.json();
    if (!response.ok) throw new Error(JSON.stringify(data));
    return data;
  };
  try {
    const imported = await request("/import", {
      archive: exportArchive(prototype.files, prototype.manifest).toString(
        "base64",
      ),
      confirm: true,
    });
    const id = imported.state.id;
    const head = imported.state.head;
    const report = await request(`/projects/${id}/quality`, {
      adapter: "cursor",
    });
    expect(report.ready).toBe(false);
    expect(
      report.results
        .filter((result: { passed: boolean }) => !result.passed)
        .map((result: { name: string }) => result.name),
    ).toEqual(["Required name"]);
    expect(report.repairRun).toBeTruthy();
    await expect
      .poll(
        async () =>
          (await request(`/projects/${id}`)).state.runs.find(
            (run: { id: string }) => run.id === report.repairRun,
          ).status,
        { timeout: 150000 },
      )
      .toBe("review");
    const staged = await request(`/projects/${id}`);
    expect(staged.state.head).toBe(head);
    expect(staged.snapshot.files["src/pages/Page.tsx"]).toContain(
      "Wrong validation message",
    );
    expect(proposals).toBe(1);
    const diff = await request(`/projects/${id}/runs/${report.repairRun}/diff`);
    expect(diff.repair).toBe(true);
    expect(diff.requirementsDiff).toEqual([]);
    expect(diff.manifest.scenarios).toEqual(
      imported.snapshot.manifest.scenarios,
    );
    await request(`/projects/${id}/runs/${report.repairRun}/apply`, {});
    const applied = await request(`/projects/${id}`);
    expect(applied.snapshot.files["src/pages/Page.tsx"]).toBe(original);
    expect(applied.snapshot.files["requirements/notices.feature"]).toBe(
      imported.snapshot.files["requirements/notices.feature"],
    );
    expect(applied.snapshot.manifest.scenarios).toEqual(
      imported.snapshot.manifest.scenarios,
    );
    const verified = await request(`/projects/${id}/quality`, {
      adapter: "cursor",
    });
    expect(verified.ready).toBe(true);
    expect(verified.repairRun).toBeUndefined();
    expect(proposals).toBe(1);
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
