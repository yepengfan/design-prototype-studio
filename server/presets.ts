import type { RegistrySourceSpec } from "./contracts.js";

export type Preset = {
  name: string;
  description: string;
  spec: RegistrySourceSpec;
};

/**
 * Registries do not publish an index of their blocks, so a preset names the
 * blocks to probe. Each one is fetched and verified at import time; a name that
 * the registry does not serve is reported as a warning rather than listed.
 */
const shadcnBlocks = [
  "dashboard-01",
  "sidebar-01",
  "sidebar-03",
  "sidebar-07",
  "login-01",
  "login-03",
];

export const presets: Preset[] = [
  {
    name: "shadcn/ui",
    description: "The official shadcn/ui registry, New York style, built for Tailwind v4.",
    spec: {
      kind: "registry",
      url: process.env.STUDIO_SHADCN_REGISTRY ?? "https://ui.shadcn.com/r/styles/new-york-v4",
      indexUrl: process.env.STUDIO_SHADCN_INDEX ?? "https://ui.shadcn.com/r/index.json",
      colorsUrl: process.env.STUDIO_SHADCN_COLORS ?? "https://ui.shadcn.com/r/colors/neutral.json",
      themeItem: "index",
      blocks: shadcnBlocks,
      // shadcn publishes its class-name helper as an import alias rather than a
      // package; generated projects resolve it to their own `lib/utils`.
      aliases: { cn: "@/lib/utils" },
    },
  },
];

export const defaultGherkin = `Feature: Review overdue orders

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
