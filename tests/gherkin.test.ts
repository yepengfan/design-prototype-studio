import { describe, expect, it } from "vitest";
import { parseGherkin, quotedValues } from "../server/gherkin.js";
import { ordersGherkin } from "./fixtures.js";

describe("parseGherkin", () => {
  it("reads the feature, its scenario and its steps", () => {
    const feature = parseGherkin(ordersGherkin);
    expect(feature.name).toBe("Review overdue orders");
    expect(feature.scenario.name).toBe("Filter the orders list");
    expect(feature.scenario.steps.map((step) => step.keyword)).toEqual([
      "Given",
      "When",
      "When",
      "Then",
      "Then",
    ]);
  });

  it("reads a data table as columns and rows", () => {
    const [given] = parseGherkin(ordersGherkin).scenario.steps;
    expect(given!.table).toEqual({
      columns: ["Order", "Status"],
      rows: [
        ["A-101", "Overdue"],
        ["A-102", "Paid"],
      ],
    });
  });

  it("drops the trailing colon a table step introduces", () => {
    const [given] = parseGherkin(ordersGherkin).scenario.steps;
    expect(given!.text).toBe("the following mock orders exist");
  });

  it("continues the previous keyword for And and But", () => {
    const feature = parseGherkin(`Feature: F
  Scenario: S
    When I open the Orders page
    And I choose "Show overdue"
    But I keep the filter
`);
    expect(feature.scenario.steps.map((step) => step.keyword)).toEqual(["When", "When", "When"]);
  });

  it("ignores comments and separator rows", () => {
    const feature = parseGherkin(`Feature: F
  # a comment
  Scenario: S
    Given rows exist:
      | Order |
      | ----- |
      | A-101 |
`);
    expect(feature.scenario.steps[0]!.table?.rows).toEqual([["A-101"]]);
  });

  it("explains what a use case without a feature is missing", () => {
    expect(() => parseGherkin("Scenario: S\n  Given a thing")).toThrow(/Feature:/);
  });

  it("rejects a feature with no scenario", () => {
    expect(() => parseGherkin("Feature: F")).toThrow(/at least one scenario/);
  });

  it("rejects a data table that follows no step", () => {
    expect(() => parseGherkin("Feature: F\n  Scenario: S\n    | a |")).toThrow(/must follow a step/);
  });

  describe("a second scenario", () => {
    const twoScenarios = `${ordersGherkin}
  Scenario: Delete an order
    When I click "Delete order"
    Then order "A-101" is gone
`;

    it("is refused rather than generated from the first alone", () => {
      expect(() => parseGherkin(twoScenarios)).toThrow(/only one scenario/);
    });

    it("is named in the refusal, so nothing is dropped without the designer seeing it", () => {
      expect(() => parseGherkin(twoScenarios)).toThrow(/"Delete an order"/);
    });

    it("leaves no way for a caller to read the first scenario and discard the rest", () => {
      let feature: ReturnType<typeof parseGherkin> | undefined;
      try {
        feature = parseGherkin(twoScenarios);
      } catch {
        feature = undefined;
      }
      expect(feature).toBeUndefined();
    });
  });
});

describe("quotedValues", () => {
  it("reads straight, curly and single quotes", () => {
    expect(quotedValues(`I choose "Show overdue" then “Show all” then 'Reset'`)).toEqual([
      "Show overdue",
      "Show all",
      "Reset",
    ]);
  });
});
