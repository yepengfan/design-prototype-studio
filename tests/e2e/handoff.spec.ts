import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../../server/app";
import { registryFixture } from "../registry";
import { prototypeFixture } from "../prototype";
import { exportArchive, readArchive } from "../../server/core/archive";
import { digest } from "../../server/core/files";
import { installProject } from "../../server/core/libraries";
import { runCommand } from "../../server/core/process";
test("fresh source handoff preserves controllers, providers, styles and all scenario outcomes across import/edit/export", async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "studio-handoff-"));
  const registry = await registryFixture(root);
  const previous = process.env.npm_config_userconfig;
  process.env.npm_config_userconfig = registry.config;
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("HTTP fixture did not bind");
  const origin = `http://127.0.0.1:${address.port}`;
  const studio = await createApp({ root: path.join(root, "studio"), origin });
  server.on("request", studio.app);
  const session = await (await fetch(origin + "/api/session")).json();
  const request = async (url: string, body?: unknown) => {
    const response = await fetch(origin + "/api" + url, {
      method: body ? "POST" : "GET",
      headers: {
        "Content-Type": "application/json",
        "X-Studio-Session": session.secret,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await response.json();
    if (!response.ok) throw new Error(JSON.stringify(data));
    return data;
  };
  try {
    const prototype = await prototypeFixture(
      path.join(root, "original"),
      registry.base,
    );
    const archive = exportArchive(prototype.files, prototype.manifest);
    const inspection = await request("/import", {
      archive: archive.toString("base64"),
    });
    expect(inspection.diagnostics).toEqual([]);
    const imported = await request("/import", {
      archive: archive.toString("base64"),
      confirm: true,
    });
    const id = imported.state.id;
    for (const file of [
      "src/pages/Page.tsx",
      "src/providers.tsx",
      "src/data/notices.ts",
      "src/styles.css",
      "src/Notice.stories.tsx",
    ])
      expect(digest(imported.snapshot.files[file])).toBe(
        digest(prototype.files[file]),
      );
    const report = await request(`/projects/${id}/quality`, {});
    expect(
      report.results.map((r: any) => ({ name: r.name, failures: r.failures })),
    ).toEqual(report.results.map((r: any) => ({ name: r.name, failures: [] })));
    expect(report.ready).toBe(true);
    const snapshot = (await studio.store.get(id)).snapshot;
    const storybook = await studio.previews.startStorybook(snapshot);
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    for (const exportName of ["Success", "Replacement"]) {
      const story = storybook.stories.find((s) => s.exportName === exportName)!;
      await page.goto(
        storybook.url + "/iframe.html?id=" + story.id + "&viewMode=story",
      );
      await expect(
        page.getByRole("heading", { name: "Notice workspace" }),
      ).toBeVisible();
      await page.getByRole("button", { name: "Acknowledge" }).click();
      await expect(page.getByRole("alert")).toHaveText("Name is required");
      await page.getByRole("textbox", { name: "Your name" }).fill("Alex");
      await page.getByRole("button", { name: "Acknowledge" }).click();
      await expect(
        page.getByRole("status", { name: "Acknowledgement" }),
      ).toHaveText("Acknowledged Alex");
      await page.screenshot({
        path: test.info().outputPath(exportName + ".png"),
        fullPage: true,
        animations: "disabled",
      });
    }
    expect(errors).toEqual([]);
    await page.close();
    studio.previews.stop(storybook.id);
    const data = await request(`/projects/${id}`);
    const main = data.outline[0].nodes.find((n: any) => n.tag === "main");
    await request(`/projects/${id}/edit`, {
      base: data.snapshot.id,
      page: "page",
      edit: {
        anchor: main.id,
        sourceHash: data.outline[0].hash,
        operation: "style",
        value: { padding: 48 },
      },
    });
    const response = await fetch(origin + `/api/projects/${id}/export`, {
      headers: { "X-Studio-Session": session.secret },
    });
    expect(response.ok).toBe(true);
    const exported = readArchive(Buffer.from(await response.arrayBuffer()));
    expect(exported["src/data/notices.ts"]).toBe(
      prototype.files["src/data/notices.ts"],
    );
    expect(exported["src/Notice.stories.tsx"]).toBe(
      prototype.files["src/Notice.stories.tsx"],
    );
    expect(exported["src/providers.tsx"]).toBe(
      prototype.files["src/providers.tsx"],
    );
    const fresh = path.join(root, "fresh-install");
    await installProject(fresh, exported, prototype.manifest.libraries);
    const built = await runCommand("npm", ["run", "build"], fresh);
    expect(built.code, built.stdout + built.stderr).toBe(0);
    const again = await request("/import", {
      archive: exportArchive(
        exported,
        JSON.parse(exported["studio.project.json"]),
      ).toString("base64"),
      confirm: true,
    });
    expect(again.snapshot.files["src/pages/Page.tsx"]).toBe(
      exported["src/pages/Page.tsx"],
    );
  } finally {
    studio.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await registry.close();
    if (previous === undefined) delete process.env.npm_config_userconfig;
    else process.env.npm_config_userconfig = previous;
    await fs.rm(root, { recursive: true, force: true });
  }
});
