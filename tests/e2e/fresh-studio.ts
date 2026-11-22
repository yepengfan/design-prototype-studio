import { expect, type Page } from "@playwright/test";

/**
 * Opens the Studio on a prototype of this spec's own.
 *
 * The Studio deliberately reopens the most recent prototype, so specs sharing a
 * server would otherwise inherit whichever one ran before them.
 */
export async function openFreshStudio(page: Page, name: string): Promise<void> {
  const created = await page.request.post("/api/projects", { data: { name } });
  expect(created.ok()).toBe(true);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Design Prototype Studio" })).toBeVisible();
}
