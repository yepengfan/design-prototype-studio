import { e2eFixture } from "../e2e-fixture";
import { accountFreeAI } from "../account-free-ai";
import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createServer as createViteServer } from "vite";
import { createApp } from "../../server/app";
import { registryFixture } from "../registry";
let cleanup: () => Promise<void>;
let registry: Awaited<ReturnType<typeof registryFixture>>;
test.beforeAll(async () => {
  const root = await e2eFixture("studio-e2e-");
  registry = await registryFixture(root);
  const prior = process.env.npm_config_userconfig;
  process.env.npm_config_userconfig = registry.config;
  const studio = await createApp({
    ai: accountFreeAI,
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
    await studio.close();
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
  await page.getByPlaceholder("Search name or purpose…").fill("related content");
  await expect(page.getByRole("heading", { name: "Card", exact: true })).toBeVisible();
  await page.getByPlaceholder("Search name or purpose…").fill("unavailable capability");
  await expect(page.getByRole("heading", { name: "Card", exact: true })).toHaveCount(0);
  await page.getByPlaceholder("Search name or purpose…").fill("");
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

test("designer composes genuine compound components in named slots and edits structured properties", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByLabel("Project name").fill("Named regions");
  await page.getByRole("button", { name: "Create blank project" }).click();
  await page.getByRole("button", { name: "Choose requirements ⌄" }).click();
  await page
    .getByLabel("Gherkin requirements")
    .fill(
      "Feature: Notice composition\nScenario: Read a notice\nGiven a notice is available\nThen its heading is visible\n",
    );
  await page.getByRole("button", { name: "Use selected requirements" }).click();
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
  ).toBeVisible({ timeout: 150000 });
  await page
    .getByRole("button", { name: "Confirm and import release" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Panel", exact: true }),
  ).toBeVisible({ timeout: 150000 });
  const add = async (name: string) => {
    await page.getByRole("button", { name: "Components", exact: true }).click();
    await page
      .getByRole("article")
      .filter({ has: page.getByRole("heading", { name, exact: true }) })
      .getByRole("button", { name: "+ Add", exact: true })
      .click();
    await expect(page.locator(".progress")).toHaveCount(0, { timeout: 150000 });
  };
  const select = async (name: string) => {
    await page.getByRole("button", { name: "Outline", exact: true }).click();
    await page.locator(".outline button").filter({ hasText: name }).click();
  };
  await select("main");
  await add("Panel");
  await select("Panel");
  await page.getByLabel("Insertion slot").selectOption("header");
  await add("Notice frame");
  await select("Notice frame");
  await add("Notice heading");
  await page.getByRole("button", { name: "Open preview" }).click();
  const frame = page.frameLocator('iframe[title="Live React preview"]');
  const panel = frame.getByRole("region", { name: "Panel", exact: true });
  await expect(
    panel.getByRole("heading", { name: "Notice heading" }),
  ).toBeVisible({ timeout: 150000 });
  await select("Panel");
  await page
    .getByLabel("spacing · Horizontal inset", { exact: true })
    .fill("24");
  await page
    .getByLabel("spacing · Horizontal inset", { exact: true })
    .press("Tab");
  await expect(page.locator(".progress")).toHaveCount(0, { timeout: 150000 });
  await expect(panel).toHaveCSS("padding-left", "24px");
  await select("Notice heading");
  const destination = await page
    .getByLabel("Move component into")
    .getByRole("option", { name: /Panel .*footer/i })
    .getAttribute("value");
  await page.getByLabel("Move component into").selectOption(destination!);
  await expect(page.locator(".progress")).toHaveCount(0, { timeout: 150000 });
  await expect(
    panel.getByRole("heading", { name: "Notice heading" }),
  ).toBeVisible();
  const text = await panel.innerText();
  expect(text.indexOf("Panel body")).toBeLessThan(
    text.indexOf("Notice heading"),
  );
  await page.getByRole("button", { name: "Duplicate", exact: true }).click();
  await expect(page.locator(".progress")).toHaveCount(0, { timeout: 150000 });
  await expect(
    panel.getByRole("heading", { name: "Notice heading" }),
  ).toHaveCount(2);
  await page.screenshot({
    path: test.info().outputPath("named-slots.png"),
    fullPage: true,
    animations: "disabled",
  });
});

test("returning to Your projects clears the editor before another project opens", async ({ page }) => {
  test.setTimeout(180000);
  await page.goto("/");
  await page.getByLabel("Project name").fill("First switch project");
  await page.getByRole("button", { name: "Create blank project" }).click();
  await expect(page.getByLabel("Current project")).not.toHaveValue("", {timeout:150000});
  await page.getByLabel("Current project").selectOption("");
  await expect(page.getByLabel("Project name")).toBeVisible();
  await page.getByLabel("Project name").fill("Second switch project");
  await page.getByRole("button", { name: "Create blank project" }).click();
  await expect(page.getByLabel("Current project").locator("option:checked")).toHaveText("Second switch project", {timeout:150000});
  await expect(page.getByLabel("Scenario preview")).toHaveValue("");
});
