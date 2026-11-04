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

test("delivery results belong to the tested revision across review, remapping and pending responses", async ({ page }) => {
  const vite = await createViteServer({ server: { port: 4311, host: "127.0.0.1", strictPort: true, hmr: false } });
  await vite.listen();
  const project = blankProject("Quality revision");
  project.files["requirements/notice.feature"] = "Feature: Notice\nScenario: Read\nGiven a notice exists\nThen the notice is visible\n";
  project.manifest.scope = ["requirements"];
  const scope = parseRequirements(project.files, project.manifest.scope);
  const scenario = scope.scenarios[0];
  project.manifest.scenarios = [{ scenario: scenario.id, page: "page", story: "src/Page.stories.tsx#Default", fixture: "src/Page.stories.tsx", accepted: true, steps: scenario.steps.map((step) => ({ step: step.id, action: "visible", role: "heading", name: "Notice" })) }];
  const data = { snapshot: { ...project, id: "revision-1", at: "now", label: "Accepted" }, state: { id: "fixture", runs: [], annotations: [], versions: {}, redo: [] }, history: [], scope, outline: project.manifest.pages.map((p) => ({ ...p, hash: digest(project.files[p.file]), nodes: anchors(project.files[p.file]) })) };
  let revision = 1;
  let checks = 0;
  let held: (() => void) | undefined;
  let hold = false;
  const green = "Automatic checks passed. Designer review remains.";
  await page.addInitScript(() => localStorage.setItem("studio-project", "fixture"));
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    let response: unknown = {};
    if (url.pathname === "/api/session") response = { secret: "fixture" };
    else if (url.pathname === "/api/projects") response = [{ id: "fixture", name: "Quality revision" }];
    else if (url.pathname === "/api/projects/fixture") response = data;
    else if (url.pathname.endsWith("/quality")) {
      checks++;
      response = { ready: true, revision: data.snapshot.id, results: [{ scenario: scenario.id, name: "Read", passed: true, failures: [] }] };
      if (hold) await new Promise<void>((resolve) => { held = resolve; });
    } else if (url.pathname.endsWith("/review")) {
      data.snapshot.id = "revision-" + ++revision;
      data.snapshot.manifest.scenarios[0].accepted = route.request().postDataJSON().accept;
    } else if (url.pathname.endsWith("/stories")) response = [{ story: "src/Page.stories.tsx#Default", name: "Default" }, { story: "src/Page.stories.tsx#Alternate", name: "Alternate" }];
    else if (url.pathname.endsWith("/map")) {
      data.snapshot.id = "revision-" + ++revision;
      data.snapshot.manifest.scenarios[0].story = route.request().postDataJSON().story;
      data.snapshot.manifest.scenarios[0].accepted = false;
    }
    await route.fulfill({ json: response });
  });
  try {
    await page.goto("/");
    await page.getByRole("button", { name: "Check delivery", exact: true }).click();
    await page.getByRole("button", { name: "Run deliverability checks" }).click();
    await expect(page.getByRole("heading", { name: green })).toBeVisible();
    await page.getByRole("button", { name: "Choose existing scenario stories" }).click();
    await expect(page.getByRole("heading", { name: green })).toBeVisible();
    await page.locator(".scenario-plan summary").click();
    await page.getByRole("button", { name: "Reopen test plan review" }).click();
    await expect(page.getByRole("heading", { name: green })).toHaveCount(0);
    await expect(page.locator(".scenario-plan summary")).toContainText("Review needed");
    await page.locator(".scenario-plan summary").click();
    await page.getByRole("button", { name: "These checks match the scenario" }).click();
    await expect(page.locator(".scenario-plan summary")).toContainText("Test plan reviewed");
    await page.getByRole("button", { name: "Run deliverability checks" }).click();
    await expect(page.getByRole("heading", { name: green })).toBeVisible();
    await page.getByRole("button", { name: "Choose existing scenario stories" }).click();
    if (!(await page.getByLabel("Original story").isVisible())) await page.locator(".scenario-plan summary").click();
    await page.getByLabel("Original story").selectOption("src/Page.stories.tsx#Alternate");
    await page.getByRole("button", { name: "Map this scenario to this story" }).click();
    await expect(page.getByRole("heading", { name: green })).toHaveCount(0);
    await page.locator(".scenario-plan summary").click();
    await page.getByRole("button", { name: "These checks match the scenario" }).click();
    await expect(page.locator(".scenario-plan summary")).toContainText("Test plan reviewed");
    hold = true;
    await page.getByRole("button", { name: "Run deliverability checks" }).click();
    await expect.poll(() => checks).toBe(3);
    data.snapshot.id = "revision-" + ++revision;
    data.scope.scenarios[0].name = "Changed while checking";
    await expect(page.locator(".scenario-plan summary")).toContainText("Changed while checking");
    held!();
    await expect(page.getByRole("button", { name: "Run deliverability checks" })).toBeEnabled();
    await expect(page.getByRole("heading", { name: green })).toHaveCount(0);
    hold = false;
    await page.getByRole("button", { name: "Run deliverability checks" }).click();
    await expect(page.getByRole("heading", { name: green })).toBeVisible();
    expect(checks).toBe(4);
  } finally { held?.(); await vite.close(); }
});
