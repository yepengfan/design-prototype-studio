import { promises as fs } from "node:fs";
import path from "node:path";
import { expect, test, type FrameLocator, type Page } from "@playwright/test";
import { deliveryDir } from "../../playwright.config.js";

/**
 * The pilot use case, with one step the shadcn/ui registry cannot fill, so the
 * run also exercises the decision a designer makes about a missing block.
 */
const gherkin = `Feature: Review overdue orders

  Scenario: Filter the orders list
    Given the following mock orders exist:
      | Order | Status  |
      | A-101 | Overdue |
      | A-102 | Paid    |
    When I open the Orders page
    And I choose "Show overdue"
    Then I see order "A-101" with an "Overdue" badge
    And order "A-102" is hidden
    And I see a timeline of order events
`;

function preview(page: Page): FrameLocator {
  return page.frameLocator('[data-testid="preview-frame"]');
}

test.describe("the designer flow", () => {
  test("imports a design system, generates from Gherkin, reviews and sends feedback", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Design Prototype Studio" })).toBeVisible();

    await test.step("import the shadcn/ui registry", async () => {
      await page.getByTestId("import-preset-shadcn/ui").click();
      await expect(page.getByTestId("imported-systems")).toContainText("shadcn/ui", { timeout: 120_000 });
      await expect(page.getByTestId("imported-systems")).toContainText(/\d+ components/);
    });

    await test.step("search the catalog and see where each component comes from", async () => {
      await page.getByLabel("Find a component").fill("table");
      const results = page.getByTestId("component-results");
      await expect(results).toContainText("Table");
      await expect(results).toContainText("@/registry/new-york-v4/ui/table");
      await expect(results).toContainText("https://ui.shadcn.com/r/styles/new-york-v4/table.json");

      await page.getByLabel("Find a component").fill("timeline");
      await expect(page.getByTestId("no-components")).toContainText("Import another design system");
      await page.getByLabel("Find a component").fill("");
    });

    await test.step("choose the official dashboard-01 template", async () => {
      const template = page.getByTestId("template-picker");
      await expect(template).toContainText("Dashboard 01");
      const choice = template.getByRole("radio", { name: "Dashboard 01" });
      await choice.click();
      await expect(choice).toBeChecked();
      await expect(template).toContainText("SidebarProvider");
      await expect(template).toContainText("SiteHeader");
    });

    await test.step("generate the page from the use case", async () => {
      await page.getByLabel("Gherkin use case").fill(gherkin);
      await page.getByTestId("generate").click();
      await expect(page.getByTestId("preview-frame")).toBeVisible({ timeout: 150_000 });
    });

    await test.step("the page uses the selected system and the template's chrome", async () => {
      const frame = preview(page);
      await expect(frame.getByRole("heading", { name: "Orders" })).toBeVisible({ timeout: 60_000 });
      await expect(frame.locator('[data-studio-row="A-101"]')).toBeVisible();
      await expect(frame.locator('[data-studio-row="A-102"]')).toBeVisible();
      await expect(frame.getByText("Overdue", { exact: true })).toBeVisible();
      // Chrome preserved from the template block.
      await expect(frame.locator('[data-slot="sidebar"]')).toBeVisible();
      await expect(frame.getByRole("link", { name: "Acme Inc." })).toBeVisible();
    });

    await test.step("the filter the scenario described actually filters", async () => {
      const frame = preview(page);
      await frame.getByRole("button", { name: "Show overdue" }).click();
      await expect(frame.locator('[data-studio-row="A-102"]')).toBeHidden();
      await expect(frame.locator('[data-studio-row="A-101"]')).toBeVisible();
    });

    await test.step("the missing block is surfaced with the requirement it affects", async () => {
      const gaps = page.getByTestId("gaps-panel");
      await expect(gaps).toContainText("No selected design system publishes a timeline component.");
      await expect(gaps).toContainText("I see a timeline of order events");
      await page.getByTestId("widen-scope-timeline").click();
      await expect(page.getByTestId("import-prompt")).toContainText("timeline");
    });

    await test.step("annotating a control takes a note instead of running it", async () => {
      await page.getByTestId("mode-annotate").click();
      await preview(page).getByRole("button", { name: "Show all" }).click();

      await expect(page.getByTestId("note-editor")).toContainText("Show all");
      await expect(page.getByTestId("note-editor")).toContainText("control-show-overdue");
      // The annotating click must not toggle the filter back on.
      await expect(preview(page).locator('[data-studio-row="A-102"]')).toBeHidden();
    });

    await test.step("queue the note and keep reviewing", async () => {
      await page.getByLabel(/^Note on/).fill("Call this control Overdue only");
      await page.getByTestId("queue-note").click();
      await expect(page.getByTestId("queued-notes")).toContainText("Call this control Overdue only");
    });

    await test.step("interact mode restores the control, with its state intact", async () => {
      await page.getByTestId("mode-interact").click();
      const frame = preview(page);
      await expect(frame.locator('[data-studio-row="A-102"]')).toBeHidden();
      await frame.getByRole("button", { name: "Show all" }).click();
      await expect(frame.locator('[data-studio-row="A-102"]')).toBeVisible();
    });

    await test.step("send the batch to the review agent", async () => {
      await page.getByTestId("send-notes").click();
      const receipt = page.getByTestId("delivery-receipt");
      await expect(receipt).toContainText("Delivered");
      await expect(receipt).toContainText("1 note written for review.");
    });

    await test.step("the agent receives the page, the anchor and the note", async () => {
      const files = await fs.readdir(deliveryDir);
      const briefingName = files.find((name) => name.endsWith(".md") && !name.endsWith(".reply.md"));
      expect(briefingName).toBeDefined();
      const briefing = await fs.readFile(path.join(deliveryDir, briefingName!), "utf8");
      expect(briefing).toContain("Call this control Overdue only");
      expect(briefing).toContain("Anchor: control-show-overdue");
      expect(briefing).toContain("Page: Orders (src/app/page.tsx)");
      expect(briefing).toContain("Feature: Review overdue orders");
    });
  });
});
