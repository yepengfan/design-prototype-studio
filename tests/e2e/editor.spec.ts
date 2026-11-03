import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer as createViteServer } from "vite";
import { createApp } from "../../server/app";
import { registryFixture } from "../registry";
let cleanup: () => Promise<void>;
let registry: Awaited<ReturnType<typeof registryFixture>>;
test.beforeAll(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "studio-e2e-"));
  registry = await registryFixture(root);
  const prior = process.env.npm_config_userconfig;
  process.env.npm_config_userconfig = registry.config;
  const studio = await createApp({
    root: path.join(root, "data"),
    origin: "http://127.0.0.1:4311",
  });
  const vite = await createViteServer({
    root: path.resolve(import.meta.dirname, "../.."),
    server: { middlewareMode: true, hmr: false },
    appType: "spa",
  });
  studio.app.use(vite.middlewares);
  const server = createServer(studio.app);
  await new Promise<void>((resolve) =>
    server.listen(4311, "127.0.0.1", resolve),
  );
  cleanup = async () => {
    studio.close();
    await vite.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await registry.close();
    if (prior === undefined) delete process.env.npm_config_userconfig;
    else process.env.npm_config_userconfig = prior;
    await fs.rm(root, { recursive: true, force: true });
  };
});
test.afterAll(async () => {
  await cleanup?.();
});
test("designer chooses scope, admits a real private library, composes and edits the live page, then reopens saved work", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await page.getByLabel("Project name").fill("Notice workspace");
  await page.getByRole("button", { name: "Create blank project" }).click();
  await page.getByRole("button", { name: "Choose requirements ⌄" }).click();
  await page
    .getByLabel("Gherkin requirements")
    .fill(
      "Feature: Read a notice\nScenario: Notice content\nGiven a notice exists\nWhen I read it\nThen I see the notice content\n",
    );
  await page.getByRole("button", { name: "Use selected requirements" }).click();
  await expect(
    page.getByRole("button", { name: "1 file · 1 scenario ⌄" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Import a library", exact: true })
    .click();
  await page.getByLabel("Package name").fill("@studio-test/layout");
  await page.getByLabel("Exact version").fill("1.0.0");
  await page.getByLabel("Registry URL").fill(registry.base);
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Preview import impact" }).click();
  await expect(
    page.getByRole("button", { name: "Confirm and import release" }),
  ).toBeVisible({ timeout: 150_000 });
  await page
    .getByRole("button", { name: "Confirm and import release" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Card", exact: true }),
  ).toBeVisible({ timeout: 150_000 });
  await page.getByRole("button", { name: "Outline", exact: true }).click();
  await page.locator(".outline button").filter({ hasText: "main" }).click();
  await page.getByRole("button", { name: "Components", exact: true }).click();
  await page
    .getByRole("article")
    .filter({ has: page.getByRole("heading", { name: "Card", exact: true }) })
    .getByRole("button", { name: "+ Add", exact: true })
    .click();
  await expect(page.locator(".progress")).toHaveCount(0, { timeout: 150_000 });
  await page.getByRole("button", { name: "Open preview" }).click();
  const preview = page.frameLocator('iframe[title="Live React preview"]');
  await expect(preview.getByRole("article")).toHaveText("Section content", {
    timeout: 150_000,
  });
  await page.getByRole("button", { name: "Outline", exact: true }).click();
  await page.locator(".outline button").filter({ hasText: "Card" }).click();
  await page
    .getByLabel("Text", { exact: true })
    .fill("A carefully edited notice");
  await page.getByLabel("Text", { exact: true }).press("Tab");
  await expect(page.locator(".progress")).toHaveCount(0, { timeout: 150_000 });
  await page.getByRole("button", { name: "Reset preview" }).click();
  await expect(preview.getByRole("article")).toHaveText(
    "A carefully edited notice",
    { timeout: 150_000 },
  );
  await page.screenshot({
    path: `${test.info().outputDir}/composed-editor.png`,
    fullPage: true,
    animations: "disabled",
  });
  await page.reload();
  await expect(
    page.getByRole("button", { name: "1 file · 1 scenario ⌄" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Outline", exact: true }).click();
  await expect(
    page.locator(".outline button").filter({ hasText: "Card" }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});
