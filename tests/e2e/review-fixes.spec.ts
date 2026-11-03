import { test, expect } from "@playwright/test";
import { createServer as createViteServer } from "vite";
import { blankProject } from "../../server/core/project";
import { parseRequirements } from "../../server/core/requirements";
import { anchors } from "../../server/core/source";
import { digest } from "../../server/core/files";

test("review shows actual operands and preview drops a removed scenario after refresh", async ({ page }) => {
  const vite = await createViteServer({ server: { port: 4311, host: "127.0.0.1", strictPort: true, hmr: false } });
  await vite.listen();
  const project = blankProject("Review fixture");
  project.files["requirements/notice.feature"] = "Feature: Notice\nScenario: Read\nGiven the notice exists\nThen I see no alerts\n";
  project.manifest.scope = ["requirements"];
  const scope = parseRequirements(project.files, project.manifest.scope);
  const scenario = scope.scenarios[0];
  const pageId = project.manifest.pages[0].id;
  project.manifest.scenarios = [{ scenario: scenario.id, page: pageId, story: "src/Page.stories.tsx#Default", fixture: "src/data/fixture.ts", accepted: false, steps: [
    { step: scenario.steps[0].id, action: "value", role: "textbox", name: "Notice", value: "" },
    { step: scenario.steps[1].id, action: "count", role: "alert", name: "Notice", count: 0 },
    { step: scenario.steps[1].id, action: "count", role: "status", name: "Notice", count: 2 },
  ] }];
  const originalBinding = project.manifest.scenarios[0];
  const data = { snapshot: { ...project, id: "old", at: "now", label: "Accepted" }, state: { id: "fixture", runs: [], annotations: [], versions: {}, redo: [] }, history: [], scope, outline: project.manifest.pages.map((p) => ({ ...p, hash: digest(project.files[p.file]), nodes: anchors(project.files[p.file]) })) };
  const previews: string[] = [];
  await page.addInitScript(() => localStorage.setItem("studio-project", "fixture"));
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    let response: unknown = {};
    if (url.pathname === "/api/session") response = { secret: "fixture" };
    else if (url.pathname === "/api/projects") response = [{ id: "fixture", name: "Review fixture" }];
    else if (url.pathname === "/api/projects/fixture") response = data;
    else if (url.pathname === "/api/projects/fixture/preview") {
      const body = route.request().postDataJSON();
      previews.push(body.scenario);
      response = { id: String(previews.length), url: "http://127.0.0.1:4311/fixture-preview", revision: data.snapshot.id };
    } else if (url.pathname.endsWith("/review")) {
      data.snapshot.id = "new";
      data.scope.scenarios = [];
      data.snapshot.manifest.scenarios = [];
    }
    await route.fulfill({ json: response });
  });
  await page.route("**/fixture-preview", (route) => route.fulfill({ contentType: "text/html", body: "<main>Preview fixture</main>" }));
  try {
    await page.goto("/");
    await page.getByLabel("Scenario preview").selectOption(scenario.id);
    await page.getByRole("button", { name: "Open preview" }).click();
    await expect.poll(() => previews).toEqual([scenario.id]);
    await page.getByRole("button", { name: "Check delivery", exact: true }).click();
    await page.locator(".scenario-plan summary").click();
    await expect(page.locator(".scenario-step").first()).toContainText('value textbox “Notice”: ""');
    await expect(page.locator(".scenario-step").last()).toContainText('count alert “Notice”: 0');
    await expect(page.locator(".scenario-step").last()).toContainText('count status “Notice”: 2');
    await page.screenshot({ path: test.info().outputPath("review-checks.png") });
    await page.getByRole("button", { name: "These checks match the scenario" }).click();
    await expect.poll(() => previews).toEqual([scenario.id, ""]);
    await expect(page.getByLabel("Scenario preview")).toHaveValue("");
    await page.getByRole("button", { name: "Close dialog", exact: true }).click();
    await page.getByRole("button", { name: "Reset preview" }).click();
    await expect.poll(() => previews).toEqual([scenario.id, "", ""]);
    data.scope.scenarios = [scenario];
    data.snapshot.manifest.scenarios = [originalBinding];
    await expect(page.getByLabel("Scenario preview").locator(`option[value="${scenario.id}"]`)).toHaveCount(1);
    await page.getByLabel("Scenario preview").selectOption(scenario.id);
    await expect.poll(() => previews.at(-1)).toBe(scenario.id);
    data.scope.scenarios = [{ ...scenario, id: "renamed", name: "Renamed" }];
    data.snapshot.manifest.scenarios = [{ ...originalBinding, scenario: "renamed" }];
    await expect(page.getByLabel("Scenario preview").locator('option[value="renamed"]')).toHaveCount(1);
    await expect(page.getByLabel("Scenario preview")).toHaveValue("");
    await page.getByRole("button", { name: "Reset preview" }).click();
    await expect.poll(() => previews.at(-1)).toBe("");
  } finally { await vite.close(); }
});
