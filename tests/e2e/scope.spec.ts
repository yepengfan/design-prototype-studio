import type {Proposal} from "../../server/core/contracts";
import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer as createViteServer } from "vite";
import { createApp } from "../../server/app";
import { registryFixture } from "../registry";
import { prototypeFixture } from "../prototype";
import { exportArchive } from "../../server/core/archive";
import { synchronizeRuntime } from "../../server/core/project";
import { parseRequirements } from "../../server/core/requirements";
import { anchors, editSource } from "../../server/core/source";
import { digest } from "../../server/core/files";

test("a new selected scope can generate its current page while preserving independent pages and rejecting outside requirements", async ({
  page,
}) => {
  test.setTimeout(240000);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "studio-scope-"));
  const registry = await registryFixture(root);
  const prior = process.env.npm_config_userconfig;
  process.env.npm_config_userconfig = registry.config;
  const prototype = await prototypeFixture(
    path.join(root, "prototype"),
    registry.base,
  );
  prototype.manifest.pages.push({
    id: "second",
    title: "Second page",
    file: "src/pages/Second.tsx",
    export: "Second",
  });
  prototype.files["src/pages/Second.tsx"] =
    "export function Second(){return <main style={{padding:40}}></main>}";
  prototype.files["src/Second.stories.tsx"] =
    `import {Second} from './pages/Second';export default {title:'Notices/Second',component:Second};export const Default={};`;
  prototype.files["requirements/second.feature"] =
    "Feature: Read a second notice\nScenario: Read the second notice\nGiven the second notice is available\nThen I see Second notice\n";
  prototype.files = synchronizeRuntime(prototype.files, prototype.manifest);
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No port");
  const origin = `http://127.0.0.1:${address.port}`;
  const studio = await createApp({
    root: path.join(root, "studio"),
    origin,
    ai: {
      async generate(run, snapshot):Promise<Proposal> {
        expect(run.page).toBe("second");
        expect(run.prompt).toContain(
          "Current designer page: Second page (src/pages/Second.tsx)",
        );
        if (run.prompt.includes("outside requirements"))
          return {
            kind: "business",
            summary: "Attempt outside scope",
            files: {
              "requirements/notices.feature": snapshot.files[
                "requirements/notices.feature"
              ].replace("Name is required", "Unexpected"),
            },
            questions: [],
            affectedScenarios: [],
          };
        const file = "src/pages/Second.tsx";
        if (run.prompt.includes("padding only")) {
          const source = snapshot.files[file];
          return {
            kind: "presentation",
            summary: "Second-page padding",
            files: {
              [file]: editSource(
                source,
                {
                  anchor: anchors(source).find((node) => node.tag === "main")!
                    .id,
                  sourceHash: digest(source),
                  operation: "style",
                  value: { padding: 56 },
                },
                [],
              ),
            },
            questions: [],
            affectedScenarios: [],
          };
        }
        const scenario = parseRequirements(
          snapshot.files,
          snapshot.manifest.scope,
        ).scenarios[0];
        return {
          kind: "business",
          summary: "Implement the selected second notice",
          files: {
            [file]: `import {Card} from '@studio-test/layout';export function Second(){return <main style={{padding:40}}><Card><h1>Second notice</h1></Card></main>}`,
          },
          manifestChanges: {
            scenarios: [
              ...snapshot.manifest.scenarios,
              {
                scenario: scenario.id,
                page: "second",
                story: "src/Second.stories.tsx#Default",
                fixture: "src/Second.stories.tsx",
                accepted: false,
                steps: scenario.steps.map((step) => ({
                  step: step.id,
                  action: "visible" as const,
                  role: "heading",
                  name: "Second notice",
                })),
              },
            ],
          },
          questions: [],
          affectedScenarios: [scenario.id],
        };
      },
      async cancel() {},
      close() {},
    },
  });
  const vite = await createViteServer({
    root: path.resolve(import.meta.dirname, "../.."),
    server: { middlewareMode: true, hmr: false },
    appType: "spa",
  });
  studio.app.use(vite.middlewares);
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
    await request(`/projects/${id}/requirements`, {
      base: imported.snapshot.id,
      files: {},
      scope: ["requirements/second.feature"],
    });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(origin);
    await page.getByLabel("Current project").selectOption(id);
    await page.getByRole("button", { name: "Outline", exact: true }).click();
    await page.getByLabel("Page", { exact: true }).selectOption("second");
    await page
      .getByLabel("Describe your change")
      .fill("Implement the complete selected second notice");
    await page.getByRole("button", { name: "Generate →" }).click();
    await expect(
      page.getByRole("button", { name: "Review changes", exact: true }),
    ).toBeVisible({ timeout: 150000 });
    await page
      .getByRole("button", { name: "Review changes", exact: true })
      .click();
    await page.getByRole("button", { name: "Preview this result" }).click();
    await expect(
      page
        .frameLocator('iframe[title="Proposed result preview"]')
        .getByRole("heading", { name: "Second notice", exact: true }),
    ).toBeVisible({ timeout: 150000 });
    await page
      .getByRole("button", { name: "Accept generated implementation" })
      .click();
    await expect(page.locator(".progress")).toHaveCount(0, { timeout: 150000 });
    const preview = page.frameLocator('iframe[title="Live React preview"]');
    await expect(
      preview.getByRole("heading", { name: "Second notice" }),
    ).toBeVisible();
    await expect(
      preview.getByRole("heading", { name: "Notice workspace" }),
    ).toHaveCount(0);
    await page.getByLabel("Page", { exact: true }).selectOption("page");
    await expect(page.locator(".progress")).toHaveCount(0, { timeout: 150000 });
    await expect(
      preview.getByRole("heading", { name: "Notice workspace" }),
    ).toBeVisible();
    await page.getByLabel("Page", { exact: true }).selectOption("second");
    await expect(page.locator(".progress")).toHaveCount(0, { timeout: 150000 });
    await expect(
      preview.getByRole("heading", { name: "Second notice" }),
    ).toBeVisible();
    let data = await request(`/projects/${id}`);
    expect(data.snapshot.files["src/pages/Page.tsx"]).toBe(
      prototype.files["src/pages/Page.tsx"],
    );
    expect(data.snapshot.files["requirements/notices.feature"]).toBe(
      prototype.files["requirements/notices.feature"],
    );
    expect(
      data.snapshot.manifest.scenarios.filter(
        (binding: { page: string }) => binding.page === "page",
      ),
    ).toEqual(prototype.manifest.scenarios);
    await page.getByLabel("Describe your change").fill("Change padding only");
    await page.getByRole("button", { name: "Generate →" }).click();
    await expect(
      page.getByRole("button", { name: "Review changes", exact: true }),
    ).toBeVisible({ timeout: 150000 });
    await page
      .getByRole("button", { name: "Review changes", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Accept presentation change" })
      .click();
    await expect(page.locator(".progress")).toHaveCount(0, { timeout: 150000 });
    await expect(preview.locator("main")).toHaveCSS("padding-left", "56px");
    data = await request(`/projects/${id}`);
    const accepted = data.state.head;
    const forbidden = await request(`/projects/${id}/generate`, {
      page: "second",
      adapter: "codex",
      prompt: "Change outside requirements",
    });
    await expect
      .poll(
        async () =>
          (await request(`/projects/${id}`)).state.runs.find(
            (run: { id: string }) => run.id === forbidden.id,
          ).status,
        { timeout: 30000 },
      )
      .toBe("failed");
    data = await request(`/projects/${id}`);
    expect(data.state.head).toBe(accepted);
    expect(
      data.state.runs.find((run: { id: string }) => run.id === forbidden.id)
        .error,
    ).toContain("outside the selected working scope");
    const markdown =
      "```gherkin\nFeature: North\nScenario: North notice\nGiven north exists\n```\n\n```gherkin\nFeature: South\nScenario: South notice\nGiven south exists\n```";
    await request(`/projects/${id}/requirements`, {
      base: data.snapshot.id,
      files: { "requirements/directions.md": markdown },
      scope: ["requirements/directions.md"],
      confirmMarkdown: true,
    });
    data = await request(`/projects/${id}`);
    expect(data.scope.files.map((file: { file: string }) => file.file)).toEqual(
      [
        "requirements/directions-1.feature",
        "requirements/directions-2.feature",
      ],
    );
    expect(
      data.scope.scenarios.map((scenario: { name: string }) => scenario.name),
    ).toEqual(["North notice", "South notice"]);
    expect(errors).toEqual([]);
    await page.screenshot({
      path: test.info().outputPath("selected-second-page.png"),
      fullPage: true,
    });
  } finally {
    await studio.close();
    await vite.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await registry.close();
    if (prior === undefined) delete process.env.npm_config_userconfig;
    else process.env.npm_config_userconfig = prior;
    await fs.rm(root, { recursive: true, force: true });
  }
});
