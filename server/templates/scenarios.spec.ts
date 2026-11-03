import { test, expect } from "@playwright/test";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { generateMessages } from "@cucumber/gherkin";
import { IdGenerator, SourceMediaType } from "@cucumber/messages";
import { orderedScenarioSteps } from "./scenario-order";
const root = path.resolve(import.meta.dirname, "..");
type Step = {
  step: string;
  action: string;
  role: string;
  name: string;
  value?: string;
  count?: number;
};
const manifest = JSON.parse(
  await fs.readFile(path.join(root, "studio.project.json"), "utf8"),
) as {
  scope: string[];
  scenarios: {
    scenario: string;
    story: string;
    fixture: string;
    accepted: boolean;
    steps: Step[];
  }[];
};
async function features(dir: string, prefix = ""): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (["node_modules", ".git", "storybook-static"].includes(entry.name))
      continue;
    const name = prefix + entry.name;
    if (entry.isDirectory())
      result.push(...(await features(path.join(dir, entry.name), name + "/")));
    else if (name.endsWith(".feature")) result.push(name);
  }
  return result;
}
const files = (await features(root))
  .filter((file) =>
    manifest.scope.some(
      (scope) =>
        file === scope || file.startsWith(scope.replace(/\/$/, "") + "/"),
    ),
  )
  .sort();
const scenarios: { id: string; name: string; steps: string[] }[] = [];
for (const file of files) {
  const source = await fs.readFile(path.join(root, file), "utf8");
  const envelopes = generateMessages(
    source,
    file,
    SourceMediaType.TEXT_X_CUCUMBER_GHERKIN_PLAIN,
    {
      newId: IdGenerator.incrementing(),
      includePickles: true,
      includeGherkinDocument: true,
      includeSource: false,
    },
  );
  const errors = envelopes.flatMap((e) =>
    e.parseError ? [e.parseError.message] : [],
  );
  if (errors.length) throw new Error(errors.join("\n"));
  for (const e of envelopes)
    if (e.pickle) {
      const p = e.pickle;
      const id = createHash("sha256")
        .update(JSON.stringify([file, p.astNodeIds, p.name]))
        .digest("hex")
        .slice(0, 20);
      scenarios.push({
        id,
        name: p.name,
        steps: p.steps.map((_, i) => String(i + 1)),
      });
    }
}
test("selected Gherkin contains scenarios", () =>
  expect(scenarios.length).toBeGreaterThan(0));
for (const scenario of scenarios)
  test(scenario.name + " [" + scenario.id + "]", async ({ page, request }) => {
    const binding = manifest.scenarios.find((s) => s.scenario === scenario.id);
    expect(
      binding,
      "Scenario needs an implementation/story/test mapping",
    ).toBeDefined();
    expect(
      binding!.accepted,
      "Designer must review the scenario test interpretation in Studio",
    ).toBe(true);
    for (const step of scenario.steps)
      expect(
        binding!.steps.some((test) => test.step === step),
        "Untested requirement step " + step,
      ).toBe(true);
    const checks = orderedScenarioSteps(scenario.steps, binding!.steps);
    await fs.access(path.join(root, binding!.fixture));
    const response = await request.get("/index.json");
    expect(response.ok()).toBe(true);
    const index = await response.json();
    const [file, exportName] = binding!.story.split("#");
    const story = Object.values(
      index.entries as Record<
        string,
        { id: string; importPath: string; exportName: string }
      >,
    ).find(
      (s) =>
        s.importPath.replace(/^\.\//, "") === file &&
        s.exportName === exportName,
    );
    expect(story, "Mapped story is missing").toBeDefined();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });
    await page.goto(
      "/iframe.html?id=" + encodeURIComponent(story!.id) + "&viewMode=story",
    );
    await page.locator("#storybook-root > *").first().waitFor();
    for (const step of checks) {
      const target = page.getByRole(
        step.role as Parameters<typeof page.getByRole>[0],
        { name: step.name, exact: true },
      );
      if (step.action === "click") await target.click();
      if (step.action === "fill") await target.fill(step.value!);
      if (step.action === "visible") await expect(target).toBeVisible();
      if (step.action === "enabled") await expect(target).toBeEnabled();
      if (step.action === "disabled") await expect(target).toBeDisabled();
      if (step.action === "hidden") await expect(target).toBeHidden();
      if (step.action === "text")
        await expect(target).toContainText(step.value!);
      if (step.action === "value")
        await expect(target).toHaveValue(step.value!);
      if (step.action === "count")
        await expect(target).toHaveCount(step.count!);
    }
    expect(errors).toEqual([]);
    await page.screenshot({
      path: test.info().outputPath(scenario.id + ".png"),
      fullPage: true,
      animations: "disabled",
    });
  });
