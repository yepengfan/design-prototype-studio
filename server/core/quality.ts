import { chromium, expect } from "@playwright/test";
import type { Snapshot } from "./contracts.js";
import { parseRequirements } from "./requirements.js";
import { Previews } from "./preview.js";
export type QualityResult = {
  scenario: string;
  name: string;
  passed: boolean;
  failures: string[];
  screenshot?: string;
};
export async function checkQuality(
  snapshot: Snapshot,
  previews: Previews,
  screenshots: string,
  options: { requireReviewed?: boolean } = {},
) {
  const scope = parseRequirements(snapshot.files, snapshot.manifest.scope);
  const results: QualityResult[] = [];
  try {
    await previews.verify(snapshot, true);
  } catch (e) {
    return {
      ready: false,
      designerAcceptanceRequired: true,
      results: scope.scenarios.map((s) => ({
        scenario: s.id,
        name: s.name,
        passed: false,
        failures: [String(e)],
      })),
    };
  }
  if (!scope.scenarios.length)
    return {
      ready: false,
      designerAcceptanceRequired: true,
      results: [
        {
          scenario: "",
          name: "Working scope",
          passed: false,
          failures: [
            "Select Gherkin scenarios before checking deliverability.",
          ],
        },
      ],
    };
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let storybook: Awaited<ReturnType<Previews["startStorybook"]>> | undefined;
  try {
    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.STUDIO_CHROME,
    });
    storybook = await previews.startStorybook(snapshot);
    const react = await previews.start(snapshot);
    const smoke = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
    });
    const smokeErrors: string[] = [];
    smoke.on("pageerror", (error) => smokeErrors.push(error.message));
    smoke.on("console", (message) => {
      if (message.type() === "error") smokeErrors.push(message.text());
    });
    try {
      await smoke.goto(new URL("/", react.url).href);
      await smoke.locator("#root > *").first().waitFor();
      if (smokeErrors.length) throw new Error(smokeErrors.join("; "));
    } finally {
      await smoke.close();
      previews.stop(react.id);
    }
    for (const scenario of scope.scenarios) {
      const result: QualityResult = {
        scenario: scenario.id,
        name: scenario.name,
        passed: false,
        failures: [],
      };
      results.push(result);
      const binding = snapshot.manifest.scenarios.find(
        (b) => b.scenario === scenario.id,
      );
      if (!binding) {
        result.failures.push(
          "This scenario has no page, fixture, story or executable step mapping.",
        );
        continue;
      }
      if (options.requireReviewed !== false && !binding.accepted)
        result.failures.push(
          "Review the scenario-to-test interpretation before marking this scenario complete.",
        );
      if (!snapshot.files[binding.fixture])
        result.failures.push("Scenario fixture is missing.");
      for (const step of scenario.steps)
        if (!binding.steps.some((s) => s.step === step.id))
          result.failures.push(`Untested requirement: ${step.text}`);
      if (result.failures.length) continue;
      const page = await browser.newPage({
        viewport: { width: 1440, height: 1000 },
      });
      page.on("pageerror", (e) => result.failures.push(e.message));
      page.on("console", (m) => {
        if (m.type() === "error") result.failures.push(m.text());
      });
      try {
        const [file, exportName] = binding.story.split("#");
        const story = storybook.stories.find(
          (s) =>
            s.importPath.replace(/^\.\//, "") === file &&
            s.exportName === exportName,
        );
        if (!story)
          throw new Error(
            "The mapped Storybook story was not built. Check its source export and scenario mapping.",
          );
        await page.goto(
          `${storybook.url}/iframe.html?id=${encodeURIComponent(story.id)}&viewMode=story`,
        );
        await page.locator("#storybook-root > *").first().waitFor();
        for (const step of binding.steps) {
          const target = page.getByRole(
            step.role as Parameters<typeof page.getByRole>[0],
            { name: step.name, exact: true },
          );
          if (step.action === "click") await target.click();
          if (step.action === "fill") await target.fill(step.value ?? "");
          if (step.action === "visible")
            await target.waitFor({ state: "visible" });
          if (step.action === "enabled") await expect(target).toBeEnabled();
          if (step.action === "disabled") await expect(target).toBeDisabled();
          if (step.action === "hidden") await expect(target).toBeHidden();
          if (step.action === "text")
            await expect(target).toContainText(step.value ?? "");
          if (step.action === "count")
            await expect(target).toHaveCount(step.count ?? 0);
          if (step.action === "value")
            await expect(target).toHaveValue(step.value ?? "");
        }
        result.screenshot = `${scenario.id}.png`;
        await page.screenshot({
          path: `${screenshots}/${result.screenshot}`,
          fullPage: true,
          animations: "disabled",
        });
      } catch (e) {
        result.failures.push(e instanceof Error ? e.message : String(e));
      } finally {
        await page.close();
      }
      result.passed = !result.failures.length;
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    for (const scenario of scope.scenarios) {
      let result = results.find((result) => result.scenario === scenario.id);
      if (!result) {
        result = {
          scenario: scenario.id,
          name: scenario.name,
          passed: false,
          failures: [],
        };
        results.push(result);
      }
      result.passed = false;
      result.failures.push(
        "Preview startup or browser check failed: " + reason,
      );
    }
  } finally {
    if (storybook) previews.stop(storybook.id);
    await browser?.close();
  }
  return {
    ready: results.every((r) => r.passed),
    designerAcceptanceRequired: true,
    results,
  };
}
