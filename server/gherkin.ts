import type { GherkinFeature, GherkinScenario, GherkinStep } from "./contracts.js";
import { StudioError } from "./errors.js";

const stepKeywords = ["Given", "When", "Then", "And", "But", "*"] as const;

/**
 * Parses the Gherkin subset the Studio generates from: one feature, its single
 * scenario, that scenario's steps and their data tables.
 *
 * `And`, `But` and `*` continue the previous keyword, which is how Gherkin
 * defines them, so a plan sees the real intent of every step.
 */
export function parseGherkin(text: string): GherkinFeature {
  const lines = text.split(/\r?\n/);
  let feature: { name: string; description: string[] } | undefined;
  const scenarios: GherkinScenario[] = [];
  let scenario: GherkinScenario | undefined;
  let lastKeyword: GherkinStep["keyword"] = "Given";

  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    const number = index + 1;
    if (!line || line.startsWith("#")) continue;

    const feature_ = /^Feature:\s*(.*)$/.exec(line);
    if (feature_) {
      if (feature) throw new StudioError("A use case may describe only one feature.");
      feature = { name: feature_[1]!.trim(), description: [] };
      continue;
    }

    if (/^Scenario Outline:/.test(line))
      throw new StudioError("Scenario Outline is not supported. Supply a concrete Scenario with mock rows.", 422);

    const scenario_ = /^(?:Scenario|Example):\s*(.*)$/.exec(line);
    if (scenario_) {
      scenario = { name: scenario_[1]!.trim(), steps: [] };
      scenarios.push(scenario);
      lastKeyword = "Given";
      continue;
    }

    if (line.startsWith("|")) {
      const step = scenario?.steps.at(-1);
      if (!step) throw new StudioError(`Line ${number}: a data table must follow a step.`);
      const cells = splitRow(line);
      if (!step.table) step.table = { columns: cells, rows: [] };
      else if (cells.every((cell) => /^-+$/.test(cell))) continue;
      else step.table.rows.push(cells);
      continue;
    }

    const keyword = stepKeywords.find((candidate) => line.startsWith(`${candidate} `));
    if (keyword) {
      if (!scenario) throw new StudioError(`Line ${number}: a step must belong to a scenario.`);
      const resolved: GherkinStep["keyword"] =
        keyword === "Given" || keyword === "When" || keyword === "Then" ? keyword : lastKeyword;
      lastKeyword = resolved;
      scenario.steps.push({
        keyword: resolved,
        text: line.slice(keyword.length + 1).trim().replace(/:$/, ""),
        line: number,
      });
      continue;
    }

    if (feature && !scenario) feature.description.push(line);
  }

  if (!feature) throw new StudioError('A use case must start with a line such as "Feature: Review overdue orders".');
  if (scenarios.length === 0) throw new StudioError("A use case needs at least one scenario.");
  for (const entry of scenarios)
    if (entry.steps.length === 0) throw new StudioError(`Scenario "${entry.name}" has no steps.`);

  // A page is generated from one scenario. Naming the ones that would be left
  // out is the point: accepting them and generating from the first alone would
  // silently discard everything they ask for.
  if (scenarios.length > 1)
    throw new StudioError(
      `A use case generates one page, so it may describe only one scenario. ` +
        `Keep "${scenarios[0]!.name}" and move ${scenarios
          .slice(1)
          .map((entry) => `"${entry.name}"`)
          .join(", ")} into their own use case.`,
      422,
    );

  return { name: feature.name, description: feature.description.join(" "), scenario: scenarios[0]! };
}

function splitRow(line: string): string[] {
  return line
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

/** Quoted fragments of a step, which Gherkin uses for concrete values. */
export function quotedValues(text: string): string[] {
  return [...text.matchAll(/"([^"]+)"|“([^”]+)”|'([^']+)'/g)].map(
    (match) => (match[1] ?? match[2] ?? match[3])!,
  );
}
