import { e2eFixture } from "../e2e-fixture";
import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createApp } from "../../server/app";
import { registryFixture } from "../registry";
import { prototypeFixture } from "../prototype";
import { exportArchive } from "../../server/core/archive";

test("business changes require matching Gherkin confirmation and restore source, requirements and releases together", async ({
  browser,
}) => {
  test.setTimeout(300000);
  const root = await e2eFixture("studio-business-e2e-");
  const registry = await registryFixture(root);
  const prior = process.env.npm_config_userconfig;
  process.env.npm_config_userconfig = registry.config;
  const prototype = await prototypeFixture(
    path.join(root, "prototype"),
    registry.base,
  );
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No port");
  const origin = `http://127.0.0.1:${address.port}`;
  const studio = await createApp({
    root: path.join(root, "studio"),
    origin,
    ai: {
      async generate(_run, snapshot) {
        return {
          kind: "business",
          summary: "Change required-name feedback to Enter your name",
          files: {
            "src/pages/Page.tsx": snapshot.files["src/pages/Page.tsx"].replace(
              "Name is required",
              "Enter your name",
            ),
            "requirements/notices.feature": snapshot.files[
              "requirements/notices.feature"
            ].replace("Name is required", "Enter your name"),
          },
          manifestChanges: {
            scenarios: snapshot.manifest.scenarios.map((binding) => ({
              ...binding,
              steps: binding.steps.map((step) => ({
                ...step,
                value:
                  step.value === "Name is required"
                    ? "Enter your name"
                    : step.value,
              })),
            })),
          },
          questions: [],
          affectedScenarios: snapshot.manifest.scenarios
            .filter((binding) => binding.story.endsWith("#Validation"))
            .map((binding) => binding.scenario),
        };
      },
      async cancel() {},
      close() {},
    },
  });
  server.on("request", studio.app);
  const secret = (await (await fetch(origin + "/api/session")).json()).secret;
  const request = async (
    url: string,
    body?: unknown,
    allowedFailure = false,
  ) => {
    const response = await fetch(origin + "/api" + url, {
      method: body ? "POST" : "GET",
      headers: {
        "Content-Type": "application/json",
        "X-Studio-Session": secret,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await response.json();
    if (!response.ok && !allowedFailure) throw new Error(JSON.stringify(data));
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
    await request(`/projects/${id}/history`, {
      action: "save",
      name: "Before feedback change",
    });
    const run = await request(`/projects/${id}/generate`, {
      adapter: "codex",
      prompt:
        "Change the missing-name validation message to Enter your name and propose its Gherkin difference",
    });
    await expect
      .poll(
        async () =>
          (await request(`/projects/${id}`)).state.runs.find(
            (item: { id: string }) => item.id === run.id,
          ).status,
        { timeout: 150000 },
      )
      .toBe("review");
    const diff = await request(`/projects/${id}/runs/${run.id}/diff`);
    expect(diff.requirementsDiff).toHaveLength(1);
    expect(diff.requirementsDiff[0].before).toContain("Name is required");
    expect(diff.requirementsDiff[0].after).toContain("Enter your name");
    expect(diff.requiresConfirmation).toBe(true);
    expect(
      (await request(`/projects/${id}/runs/${run.id}/apply`, {}, true)).error,
    ).toContain("confirm");
    expect((await request(`/projects/${id}`)).state.head).toBe(
      imported.state.head,
    );
    expect(
      (
        await request(
          `/projects/${id}/runs/${run.id}/apply`,
          { confirmRequirements: "stale approval" },
          true,
        )
      ).error,
    ).toContain("confirm");
    await request(`/projects/${id}/runs/${run.id}/apply`, {
      confirmRequirements: diff.hash,
    });
    let current = await request(`/projects/${id}`);
    expect(current.snapshot.files["requirements/notices.feature"]).toContain(
      "Enter your name",
    );
    expect(current.snapshot.manifest.libraries).toEqual(
      imported.snapshot.manifest.libraries,
    );
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const validation = prototype.manifest.scenarios.find((binding) =>
      binding.story.endsWith("#Validation"),
    )!.scenario;
    const verify = async (message: string) => {
      const preview = await request(`/projects/${id}/preview`, {
        scenario: validation,
      });
      await page.goto(preview.url);
      await page.getByRole("button", { name: "Acknowledge" }).click();
      await expect(page.getByRole("alert")).toHaveText(message);
      studio.previews.stop(preview.id);
    };
    await verify("Enter your name");
    await request(`/projects/${id}/history`, { action: "undo" });
    current = await request(`/projects/${id}`);
    expect(current.snapshot.files["requirements/notices.feature"]).toBe(
      prototype.files["requirements/notices.feature"],
    );
    expect(current.snapshot.files["src/pages/Page.tsx"]).toBe(
      prototype.files["src/pages/Page.tsx"],
    );
    await verify("Name is required");
    await request(`/projects/${id}/history`, { action: "redo" });
    await verify("Enter your name");
    await request(`/projects/${id}/history`, {
      action: "restore",
      revision: imported.snapshot.id,
    });
    current = await request(`/projects/${id}`);
    expect(current.snapshot.manifest.libraries).toEqual(
      imported.snapshot.manifest.libraries,
    );
    expect(current.snapshot.files["requirements/notices.feature"]).toBe(
      prototype.files["requirements/notices.feature"],
    );
    await verify("Name is required");
    expect(errors).toEqual([]);
    await page.screenshot({
      path: test.info().outputPath("restored-validation.png"),
      fullPage: true,
    });
    await page.close();
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
