import path from "node:path";
import { expect, test } from "@playwright/test";

/**
 * Captures the Studio at the points of the flow a designer looks at, so the
 * rendered result can be reviewed rather than only asserted on.
 */
const outputDir = process.env.STUDIO_SCREENSHOT_DIR;

test.skip(!outputDir, "Set STUDIO_SCREENSHOT_DIR to capture review screenshots.");

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

test.use({ viewport: { width: 1600, height: 1000 } });

test("capture the studio at each step", async ({ page }) => {
  const shot = (name: string) =>
    page.screenshot({ path: path.join(outputDir!, `${name}.png`), animations: "disabled" });

  await page.goto("/");
  await expect(page.getByTestId("import-preset-shadcn/ui")).toBeVisible();
  await shot("01-empty");

  await page.getByTestId("import-preset-shadcn/ui").click();
  await expect(page.getByTestId("imported-systems")).toContainText("shadcn/ui", { timeout: 120_000 });
  await page.getByLabel("Find a component").fill("table");
  await shot("02-imported");

  await page.getByTestId("template-picker").getByRole("radio", { name: "Dashboard 01" }).click();
  await page.getByLabel("Gherkin use case").fill(gherkin);
  await shot("03-ready-to-generate");

  await page.getByTestId("generate").click();
  await expect(page.getByTestId("preview-frame")).toBeVisible({ timeout: 150_000 });
  await expect(
    page.frameLocator('[data-testid="preview-frame"]').getByRole("heading", { name: "Orders" }),
  ).toBeVisible({ timeout: 60_000 });
  await shot("04-generated");

  await page.getByTestId("mode-annotate").click();
  await page.frameLocator('[data-testid="preview-frame"]').getByRole("button", { name: "Show overdue" }).click();
  await page.getByLabel(/^Note on/).fill("Call this control Overdue only");
  await expect(page.getByTestId("queue-note")).toBeEnabled();
  await shot("05-annotating");

  await page.getByTestId("queue-note").click();
  await page.getByTestId("send-notes").click();
  await expect(page.getByTestId("delivery-receipt")).toContainText("Delivered");
  await shot("06-delivered");
});
