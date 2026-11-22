import path from "node:path";
import { createRequire } from "node:module";
import { transformSync } from "esbuild";
import { createElement, type ComponentType, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { generatePage } from "../server/generator.js";
import { parseGherkin } from "../server/gherkin.js";
import { planPage } from "../server/planner.js";
import { readDeclarations } from "../server/sources/npm.js";
import { ordersGherkin } from "./fixtures.js";

const catalog = readDeclarations(path.resolve("tests/fixtures/npm/composable.d.ts"), {
  sourceId: "npm", sourceName: "Npm UI", package: "fixture-ui", version: "1.0.0",
}, []);
const require = createRequire(import.meta.url);

function render(gherkin: string, components = catalog) {
  const plan = planPage(parseGherkin(gherkin).scenario, components);
  const generated = generatePage({
    plan, components: new Map(components.map((component) => [component.id, component])),
    shellImportPath: "fixture-shell", shellExport: "TemplateShell",
  });
  const module: { exports: { default?: ComponentType } } = { exports: {} };
  const tags: Record<string, string> = {
    Table: "table", TableBody: "tbody", TableCell: "td", TableHead: "th", TableHeader: "thead", TableRow: "tr",
    CardTitle: "h3", Button: "button", Input: "input",
  };
  const runtime = Object.fromEntries(catalog.map((component) => [component.name,
    ({ children }: { children?: ReactNode }) => createElement(tags[component.name] ?? "div", {}, children),
  ]));
  type ModuleFactory = (
    require_: (name: string) => unknown,
    exports: typeof module.exports,
    module_: typeof module,
  ) => void;
  // The point of this test is that the generated page really runs, so its
  // compiled source is executed rather than inspected.
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const factory = new Function("require", "exports", "module", transformSync(generated.source, {
    loader: "tsx", format: "cjs", jsx: "automatic",
  }).code) as ModuleFactory;
  factory((name: string) => name === "fixture-ui" ? runtime : name === "fixture-shell"
    ? { TemplateShell: ({ children }: { children?: ReactNode }) => createElement("main", {}, children) }
    : require(name), module.exports, module);
  return { plan, document: new JSDOM(renderToStaticMarkup(createElement(module.exports.default!))).window.document };
}

describe("generation invariants", () => {
  it("generates Table, Select and Card children from their npm module exports", () => {
    const gherkin = ordersGherkin.replace('I choose "Show overdue"', 'I select "Overdue" from "Status"');
    const { plan, document } = render(`${gherkin}    Then I see a "Row count" summary\n`);
    expect(plan.gaps).toEqual([]);
    expect(document.querySelectorAll("tbody tr")).toHaveLength(2);
    expect(document.querySelector("h3")?.textContent).toBe("Row count");
    expect(document.querySelector("main")?.textContent).toContain("Paid");
  });

  it.each([
    ['I choose "Show overdue"', "Button"],
    ['I type "A-101" into "Order"', "Input"],
    ['I select "Overdue" from "Status"', "Select"],
  ])("reports lost table dependencies for %s", (action, control) => {
    const components = catalog.filter((component) => ["Table", control, "Card"].includes(component.name));
    const text = ordersGherkin.replace('I choose "Show overdue"', action) + '    Then I see a "Row count" summary\n';
    const { plan, document } = render(text, components);
    expect(plan.blocks.map((block) => block.type)).toEqual(["heading"]);
    for (const requirement of [action, 'I see a "Row count" summary', 'I see order "A-101" with an "Overdue" badge', 'order "A-102" is hidden'])
      expect(plan.gaps).toContainEqual(expect.objectContaining({ requirement }));
    expect(document.querySelector("table")).toBeNull();
  });

  it("rechecks hidden outcomes when their filter loses catalog resolution", () => {
    const { plan, document } = render(ordersGherkin, catalog.filter((component) => component.name !== "Button"));
    expect(plan.gaps).toContainEqual(expect.objectContaining({ requirement: 'order "A-102" is hidden' }));
    expect(document.querySelectorAll("tbody tr")).toHaveLength(2);
  });

  it.each([
    'I see a "Row count" summary counting only "Overdue" orders',
    'I see a "Row count" summary of 99',
    'I see a "Row count" summary for all orders',
  ])("reports unsupported summary semantics: %s", (step) => {
    const { plan, document } = render(`${ordersGherkin}    Then ${step}\n`);
    expect(plan.gaps).toContainEqual(expect.objectContaining({ requirement: step, capability: "card" }));
    expect(document.querySelector("h3")).toBeNull();
  });

  it.each([
    'When I type "A-101" into "Missing"',
    'When I select "Overdue" from "Missing"',
    'When I click "Delete order"',
    'When I type "A-101" into "Order" then delete it',
    'Given a privileged user exists',
  ])("reports unsupported steps: %s", (step) => {
    const { plan } = render(`${ordersGherkin}    ${step}\n`);
    expect(plan.gaps).toContainEqual(expect.objectContaining({ requirement: step.replace(/^\w+ /, "") }));
  });

  it("rejects scenario outlines before generation", () => {
    expect(() => render(ordersGherkin.replace("Scenario:", "Scenario Outline:"))).toThrow(/Scenario Outline is not supported/);
  });
});
