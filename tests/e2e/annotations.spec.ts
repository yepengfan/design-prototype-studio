import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer as createViteServer } from "vite";
import { createApp } from "../../server/app";
let cleanup: () => Promise<void>;
test.beforeAll(async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "studio-annotation-e2e-"),
  );
  const studio = await createApp({
    root,
    origin: "http://127.0.0.1:4311",
    ai: {
      // Deterministic boundary fixture. Production uses installed authenticated tools.
      async generate(run, snapshot, update) {
        await update("Preparing synthetic annotation proposal");
        const file = snapshot.manifest.pages[0].file;
        const current = snapshot.files[file];
        const padding = run.prompt.includes("Wider padding");
        return {
          kind: "presentation",
          summary: padding ? "Wider padding" : "More space between items",
          questions: [],
          affectedScenarios: [],
          files: {
            [file]: padding
              ? current.replace(/padding: \d+/, "padding: 48")
              : current.replace(/gap: \d+/, "gap: 32"),
          },
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
  const server = createServer(studio.app);
  await new Promise<void>((resolve) =>
    server.listen(4311, "127.0.0.1", resolve),
  );
  cleanup = async () => {
    await studio.close();
    await vite.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(root, { recursive: true, force: true });
  };
});
test.afterAll(async () => cleanup?.());
test("designer reviews a batch, preserves pending work, chooses accepted-result conflicts and restores decisions", async ({
  page,
}) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await page.getByLabel("Project name").fill("Reviewed annotations");
  await page.getByRole("button", { name: "Create blank project" }).click();
  await page.getByRole("button", { name: "Choose requirements ⌄" }).click();
  await page
    .getByLabel("Gherkin requirements")
    .fill(
      "Feature: Notice\nScenario: Read\nGiven the notice exists\nThen its content is visible\n",
    );
  await page.getByRole("button", { name: "Use selected requirements" }).click();
  await page.getByRole("button", { name: "Annotations", exact: true }).click();
  // The capture toggle is in the canvas toolbar, shared with normal selection.
  await page.getByRole("button", { name: /Annotate|Annotation mode/i }).click();
  const draft = async (text: string) => {
    await page.locator('textarea[name="annotation"]').fill(text);
    await page.getByRole("button", { name: "Add draft", exact: true }).click();
    await expect(page.locator(".progress")).toHaveCount(0);
  };
  await draft("Wider padding");
  await draft("More space between items");
  const a = page
    .locator(".annotation-card")
    .filter({ has: page.locator("p").filter({ hasText: /^Wider padding$/ }) });
  const b = page.locator(".annotation-card").nth(1);
  await expect(a.locator(".status")).toHaveText("draft");
  await expect(b.locator(".status")).toHaveText("draft");
  await page.getByRole("button", { name: "Approve draft batch" }).click();
  await page.getByRole("button", { name: "Submit approved batch" }).click();
  await expect(
    a.getByRole("button", { name: "Inspect result", exact: true }),
  ).toBeVisible({ timeout: 150000 });
  await expect(
    b.getByRole("button", { name: "Inspect result", exact: true }),
  ).toBeVisible({ timeout: 150000 });
  await a.getByRole("button", { name: "Inspect result", exact: true }).click();
  await page
    .getByRole("button", { name: "Accept presentation change" })
    .click();
  await expect(a.locator(".status")).toHaveText("accepted", {
    timeout: 150000,
  });
  const preview = page.frameLocator('iframe[title="Live React preview"]');
  await expect(preview.locator("main")).toHaveCSS("padding-left", "48px", {
    timeout: 150000,
  });
  await b.getByRole("button", { name: "Rework", exact: true }).click();
  await expect(page.locator(".progress")).toHaveCount(0);
  await expect(
    b.getByRole("button", { name: "Inspect result", exact: true }),
  ).toBeVisible({ timeout: 150000 });
  await b.getByRole("button", { name: "Inspect result", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Review proposed changes" });
  await expect(
    dialog.getByText("This rework affects accepted results", { exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Accept presentation change" }),
  ).toBeDisabled();
  await dialog
    .getByRole("button", { name: "Leave pending", exact: true })
    .click();
  await expect(a.locator(".status")).toHaveText("accepted");
  await expect(preview.locator("main")).toHaveCSS("gap", "24px");
  await b.getByRole("button", { name: "Inspect result", exact: true }).click();
  await dialog
    .getByRole("checkbox", {
      name: "I reviewed these affected results and choose to replace them",
    })
    .check();
  await dialog
    .getByRole("button", { name: "Accept presentation change" })
    .click();
  await expect(b.locator(".status")).toHaveText("accepted", {
    timeout: 150000,
  });
  await expect(a.locator(".status")).toHaveText("pending");
  await expect(preview.locator("main")).toHaveCSS("gap", "32px");
  await b.getByRole("button", { name: "Undo result", exact: true }).click();
  await expect(page.locator(".progress")).toHaveCount(0, { timeout: 150000 });
  await expect(b.locator(".status")).toHaveText("undone", { timeout: 150000 });
  await expect(a.locator(".status")).toHaveText("accepted");
  await expect(preview.locator("main")).toHaveCSS("gap", "24px");
  await expect(preview.locator("main")).toHaveCSS("padding-left", "48px");
  await page.reload();
  await page.getByRole("button", { name: "Annotations", exact: true }).click();
  await expect(a.locator(".status")).toHaveText("accepted");
  await expect(b.locator(".status")).toHaveText("undone");
  await b
    .getByLabel("Edit annotation")
    .fill("More space between items, revised");
  await b.getByRole("button", { name: "Save and review again" }).click();
  await expect(b.locator(".status")).toHaveText("draft");
  await page.screenshot({
    path: test.info().outputPath("reviewed-annotations.png"),
    fullPage: true,
    animations: "disabled",
  });
  expect(errors).toEqual([]);
});
