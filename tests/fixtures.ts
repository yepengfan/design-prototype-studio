import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { RegistrySourceSpec } from "../server/contracts.js";

const here = path.dirname(fileURLToPath(import.meta.url));

/** A small registry served from disk, so catalog tests need no network. */
export const fixtureRegistry: RegistrySourceSpec = {
  kind: "registry",
  url: pathToFileURL(path.join(here, "fixtures", "registry")).toString(),
  indexUrl: pathToFileURL(path.join(here, "fixtures", "registry", "index.json")).toString(),
  blocks: ["console-01", "missing-block"],
  aliases: { cn: "@/lib/utils" },
};

export const ordersGherkin = `Feature: Review overdue orders

  Scenario: Filter the orders list
    Given the following mock orders exist:
      | Order | Status  |
      | A-101 | Overdue |
      | A-102 | Paid    |
    When I open the Orders page
    And I choose "Show overdue"
    Then I see order "A-101" with an "Overdue" badge
    And order "A-102" is hidden
`;
