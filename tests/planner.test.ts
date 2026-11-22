import { describe, expect, it } from "vitest";
import { capabilitiesFor } from "../server/capabilities.js";
import type { CatalogComponent } from "../server/contracts.js";
import { parseGherkin } from "../server/gherkin.js";
import { planPage } from "../server/planner.js";
import { ordersGherkin } from "./fixtures.js";

function component(name: string, exports: string[] = []): CatalogComponent {
  return {
    id: `fixture:${name}`,
    sourceId: "fixture",
    sourceName: "Fixture UI",
    name,
    title: name,
    kind: "ui",
    exports,
    importPath: `@/ui/${name}`,
    capabilities: capabilitiesFor(name, exports),
    provenance: `fixture://${name}`,
  };
}

const catalog = [component("table"), component("badge"), component("button"), component("card")];

function plan(gherkin: string, components = catalog) {
  return planPage(parseGherkin(gherkin).scenarios[0]!, components);
}

describe("planPage", () => {
  it("names the page after the screen the scenario opens", () => {
    expect(plan(ordersGherkin).title).toBe("Orders");
  });

  it("turns the data table into mock rows and marks the status column", () => {
    const table = plan(ordersGherkin).blocks.find((block) => block.type === "data-table");
    expect(table?.dataset?.rows).toEqual([
      { Order: "A-101", Status: "Overdue" },
      { Order: "A-102", Status: "Paid" },
    ]);
    expect(table?.dataset?.statusColumn).toBe("Status");
  });

  it("resolves the badge for the status column from the catalog", () => {
    const table = plan(ordersGherkin).blocks.find((block) => block.type === "data-table");
    expect(table?.componentIds).toEqual(["fixture:table", "fixture:badge"]);
  });

  it("reads a control the scenario presses as a filter when a row is hidden", () => {
    const toggle = plan(ordersGherkin).blocks.find((block) => block.type === "filter-toggle");
    expect(toggle).toMatchObject({ label: "Show overdue", alternateLabel: "Show all", value: "Overdue" });
  });

  it("lays controls out above the rows they filter", () => {
    const types = plan(ordersGherkin).blocks.map((block) => block.type);
    expect(types.indexOf("filter-toggle")).toBeLessThan(types.indexOf("data-table"));
  });

  it("reports a capability no selected system publishes as a gap", () => {
    const result = plan(`${ordersGherkin}    And I see a timeline of order events\n`);
    const gap = result.gaps.find((entry) => entry.capability === "timeline");
    expect(gap?.reason).toContain("No selected design system publishes a timeline");
    expect(gap?.requirement).toBe("I see a timeline of order events");
  });

  it("still generates the rest of the page when a block is missing", () => {
    const result = plan(`${ordersGherkin}    And I see a timeline of order events\n`);
    expect(result.blocks.some((block) => block.type === "data-table")).toBe(true);
  });

  it("separates a published block the scenario does not describe from a missing one", () => {
    const result = plan(
      `${ordersGherkin}    And I see a chart of orders by status\n`,
      [...catalog, component("chart")],
    );
    const gap = result.gaps.find((entry) => entry.capability === "chart");
    expect(gap?.reason).toContain("Fixture UI chart publishes a chart");
    expect(gap?.reason).not.toContain("No selected design system");
  });

  it("reports the table as missing when no system publishes one", () => {
    const result = plan(ordersGherkin, [component("badge"), component("button")]);
    expect(result.gaps.map((gap) => gap.capability)).toContain("table");
    expect(result.blocks.some((block) => block.type === "data-table")).toBe(false);
  });

  it("reads a typed filter as a text input over the matching column", () => {
    const result = plan(`Feature: F
  Scenario: S
    Given the following mock orders exist:
      | Order | Status  |
      | A-101 | Overdue |
      | A-102 | Paid    |
    When I open the Orders page
    And I type "A-101" into "Order"
    Then I see order "A-101"
`, [...catalog, component("input")]);
    const filter = result.blocks.find((block) => block.type === "text-filter");
    expect(filter).toMatchObject({ column: "Order", value: "A-101" });
  });

  it("reads a select filter and offers the values the rows contain", () => {
    const result = plan(`Feature: F
  Scenario: S
    Given the following mock orders exist:
      | Order | Status  |
      | A-101 | Overdue |
      | A-102 | Paid    |
    When I open the Orders page
    And I select "Overdue" from "Status"
    Then order "A-102" is hidden
`, [...catalog, component("select")]);
    const filter = result.blocks.find((block) => block.type === "select-filter");
    expect(filter?.options).toEqual(["Overdue", "Paid"]);
  });

  it("refuses a scenario that describes no page content", () => {
    expect(() => plan("Feature: F\n  Scenario: S\n    Given a user exists\n")).toThrow(
      /does not describe any page content/,
    );
  });
});
