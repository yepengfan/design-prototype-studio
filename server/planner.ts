import { capabilityNouns, isComposable, type Capability } from "./capabilities.js";
import type { CatalogComponent, Dataset, GherkinScenario, GherkinStep, PagePlan, PlanBlock, PlanGap } from "./contracts.js";
import { quotedValues } from "./gherkin.js";
import { StudioError } from "./errors.js";

/** A block the scenario asks for, before the catalog has been consulted. */
type Requirement = {
  block: Omit<PlanBlock, "componentIds">;
  /** Capabilities that must all resolve for the block to be generated. */
  needs: Capability[];
  unsupported?: string;
};

/** Capabilities a Then step can name without the generator being able to build them. */
const visualPhrases: [Capability, RegExp][] = [
  ["chart", /\b(chart|graph|trend line)\b/i],
  ["timeline", /\btimeline\b/i],
  ["kanban", /\b(kanban|swimlane)\b/i],
  ["map", /\bmap\b/i],
  ["gauge", /\bgauge\b/i],
  ["tree", /\btree(?: view)?\b/i],
];

const statusHeadings = /^(status|state|stage|phase)$/i;

/**
 * Turns one scenario into a page plan, resolving every block it needs against
 * the components the selected design systems published.
 *
 * Requirements that cannot be satisfied become gaps rather than invented
 * markup: the plan names the step that asked for the block and what is missing,
 * which is what the designer needs in order to decide whether to import
 * another design system.
 */
export function planPage(scenario: GherkinScenario, components: CatalogComponent[]): PagePlan {
  const requirements = readRequirements(scenario);
  const blocks: PlanBlock[] = [];
  const gaps: PlanGap[] = [];

  for (const requirement of requirements) {
    const resolved = requirement.needs.map((capability) => ({
      capability,
      matches: components.filter((component) => component.capabilities.includes(capability)),
    }));
    const missing = resolved.filter((entry) => entry.matches.length === 0);
    const unsupported = resolved.filter((entry) => !isComposable(entry.capability));

    if (missing.length || unsupported.length || requirement.unsupported) {
      for (const entry of missing) gaps.push(missingComponentGap(entry.capability, requirement.block.requirement));
      for (const entry of unsupported)
        if (!missing.some((candidate) => candidate.capability === entry.capability))
          gaps.push(unsupportedGap(entry.capability, requirement.block.requirement, entry.matches));
      if (requirement.unsupported)
        gaps.push({
          capability: requirement.block.capability,
          requirement: requirement.block.requirement,
          reason: requirement.unsupported,
          suggestion: "Reword the step to describe a supported filter or row count, or review this gap before proceeding.",
        });
      continue;
    }

    blocks.push({
      ...requirement.block,
      componentIds: resolved.flatMap((entry) => entry.matches.slice(0, 1).map((match) => match.id)),
    });
  }

  if (!blocks.some((block) => block.type !== "heading") && gaps.length === 0)
    throw new StudioError(
      "This scenario does not describe any page content yet. Add a data table, a control to use, or an outcome to see.",
      422,
    );

  return {
    title: pageTitle(scenario),
    scenario: scenario.name,
    blocks: blocks.sort((left, right) => layoutOrder(left) - layoutOrder(right)),
    gaps: dedupeGaps(gaps),
  };
}

/**
 * Reading order of a generated page. A scenario lists its data before the
 * control that filters it, but a page reads better with the controls above the
 * rows they act on, so blocks are laid out by role rather than by step order.
 */
function layoutOrder(block: PlanBlock): number {
  const order: Record<PlanBlock["type"], number> = {
    heading: 0,
    "text-filter": 1,
    "select-filter": 2,
    "filter-toggle": 3,
    summary: 5,
    "data-table": 6,
  };
  return order[block.type];
}

function readRequirements(scenario: GherkinScenario): Requirement[] {
  const requirements: Requirement[] = [];
  const title = pageTitle(scenario);
  const dataset = readDataset(scenario.steps);
  const outcomes = scenario.steps.filter((step) => step.keyword === "Then");

  requirements.push({
    block: { anchor: "page-heading", type: "heading", capability: "heading", requirement: `Scenario: ${scenario.name}`, label: title },
    needs: [],
  });

  if (dataset) {
    const needs: Capability[] = ["table"];
    if (dataset.dataset.statusColumn) needs.push("badge");
    requirements.push({
      block: {
        anchor: "orders-table",
        type: "data-table",
        capability: "table",
        requirement: dataset.step.text,
        dataset: dataset.dataset,
        column: dataset.dataset.statusColumn,
      },
      needs,
    });
  }

  for (const step of scenario.steps) {
    if (step.keyword !== "When") continue;
    const values = quotedValues(step.text);

    const typed = /\b(?:type|enter|search for)\b/i.test(step.text);
    const selected = /\bselect\b.+\bfrom\b/i.test(step.text);
    const pressed = /\b(?:choose|click|press|toggle|tap)\b/i.test(step.text);

    if (typed && values[0]) {
      requirements.push({
        block: {
          anchor: anchorFor("filter-text", values[0]),
          type: "text-filter",
          capability: "input",
          requirement: step.text,
          label: values[1] ?? `Search ${dataset?.dataset.columns[0] ?? "rows"}`,
          column: matchColumn(values[1], dataset?.dataset) ?? dataset?.dataset.columns[0],
          value: values[0],
        },
        needs: ["input"],
      });
      continue;
    }

    if (selected && values[0]) {
      const column = matchColumn(values[1], dataset?.dataset) ?? dataset?.dataset.statusColumn;
      requirements.push({
        block: {
          anchor: anchorFor("filter-select", values[1] ?? values[0]),
          type: "select-filter",
          capability: "select",
          requirement: step.text,
          label: values[1] ?? "Filter",
          column,
          value: values[0],
          options: column && dataset ? distinct(dataset.dataset, column) : undefined,
        },
        needs: ["select"],
      });
      continue;
    }

    if (pressed) {
      const label = values[0] ?? step.text;
      const column = dataset?.dataset.statusColumn;
      const value = column && dataset ? matchValue(label, dataset.dataset, column) : undefined;
      const hides = outcomes.some((outcome) => /\b(hidden|not (?:shown|visible)|disappears)\b/i.test(outcome.text));
      requirements.push({
        block: {
          anchor: anchorFor("control", label),
          type: "filter-toggle",
          capability: "button",
          requirement: step.text,
          label,
          alternateLabel: alternateLabel(label),
          column,
          value,
        },
        needs: ["button"],
        unsupported: hides && value && label.toLowerCase() === `show ${value}`.toLowerCase() ? undefined : `The action "${label}" has unsupported interaction semantics.`,
      });
    }
  }

  for (const step of outcomes) {
    if (/\b(summary|total|totals|metric|count)\b/i.test(step.text))
      requirements.push({
        block: {
          anchor: anchorFor("summary", step.text),
          type: "summary",
          capability: "card",
          requirement: step.text,
          label: summaryLabel(step.text),
          dataset: dataset?.dataset,
          column: dataset?.dataset.statusColumn ?? dataset?.dataset.columns[0],
        },
        needs: ["card"],
        unsupported: dataset && /^row count$/i.test(summaryLabel(step.text))
          ? undefined
          : "This metric has unsupported aggregation semantics. Only an explicit Row count summary is supported.",
      });

    for (const [capability, phrase] of visualPhrases)
      if (phrase.test(step.text))
        requirements.push({
          block: {
            anchor: anchorFor(capability, step.text),
            type: "summary",
            capability,
            requirement: step.text,
            label: step.text,
          },
          needs: [capability],
        });
  }

  return requirements;
}

function readDataset(steps: GherkinStep[]): { step: GherkinStep; dataset: Dataset } | undefined {
  const step = steps.find((candidate) => candidate.table && candidate.table.rows.length > 0);
  if (!step?.table) return undefined;
  const { columns, rows } = step.table;
  const records = rows.map((row) =>
    Object.fromEntries(columns.map((column, index) => [column, row[index] ?? ""])),
  );
  return {
    step,
    dataset: { columns: [...columns], rows: records, statusColumn: findStatusColumn(columns, records) },
  };
}

/**
 * The status column is the one a badge belongs on: named like a status, or
 * holding a small set of repeated single-word values across the rows.
 */
function findStatusColumn(columns: string[], rows: Record<string, string>[]): string | undefined {
  const named = columns.find((column) => statusHeadings.test(column));
  if (named) return named;
  return columns.find((column) => {
    const values = rows.map((row) => row[column] ?? "");
    if (values.some((value) => !value || /\s/.test(value) || /\d/.test(value))) return false;
    return new Set(values).size < values.length || values.length === 1;
  });
}

function matchColumn(label: string | undefined, dataset: Dataset | undefined): string | undefined {
  if (!label || !dataset) return undefined;
  return dataset.columns.find((column) => column.toLowerCase() === label.toLowerCase());
}

function matchValue(label: string, dataset: Dataset, column: string): string | undefined {
  const words = label.toLowerCase().split(/\W+/).filter(Boolean);
  return dataset.rows.map((row) => row[column] ?? "").find((value) => words.includes(value.toLowerCase()));
}

function distinct(dataset: Dataset, column: string): string[] {
  return [...new Set(dataset.rows.map((row) => row[column] ?? "").filter(Boolean))];
}

function alternateLabel(label: string): string {
  const match = /^show\s+(.+)$/i.exec(label);
  return match ? "Show all" : `Clear ${label.toLowerCase()}`;
}

function summaryLabel(text: string): string {
  const quoted = quotedValues(text)[0];
  if (quoted) return quoted;
  const match = /\b(?:see|shows?)\s+(?:a|the)\s+(.+?)(?:\s+of\b|$)/i.exec(text);
  return capitalise(match?.[1] ?? "Summary");
}

function pageTitle(scenario: GherkinScenario): string {
  for (const step of scenario.steps) {
    const opened = /\bopens?\s+the\s+(.+?)\s+(?:page|screen|view)\b/i.exec(step.text);
    if (opened?.[1]) return capitalise(opened[1]);
  }
  return capitalise(scenario.name);
}

function missingComponentGap(capability: Capability, requirement: string): PlanGap {
  return {
    capability,
    requirement,
    reason: `No selected design system publishes ${capabilityNouns[capability]} component.`,
    suggestion: `Import a design system that publishes ${capabilityNouns[capability]}, or reword the step so it uses blocks the selected systems provide.`,
  };
}

function unsupportedGap(capability: Capability, requirement: string, matches: CatalogComponent[]): PlanGap {
  const names = matches.map((match) => `${match.sourceName} ${match.title}`).join(", ");
  return {
    capability,
    requirement,
    reason: `${names} publishes ${capabilityNouns[capability]}, but this step does not say what it should contain.`,
    suggestion: `Describe the values the step expects, or review the rest of the page first and add this block later.`,
  };
}

function dedupeGaps(gaps: PlanGap[]): PlanGap[] {
  const seen = new Map<string, PlanGap>();
  for (const gap of gaps) seen.set(`${gap.capability}:${gap.requirement}`, gap);
  return [...seen.values()];
}

function anchorFor(prefix: string, value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  return slug ? `${prefix}-${slug}` : prefix;
}

function capitalise(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
