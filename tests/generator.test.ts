import { describe, expect, it } from "vitest";
import type { CatalogComponent } from "../server/contracts.js";
import { capabilitiesFor } from "../server/capabilities.js";
import { generatePage } from "../server/generator.js";
import { parseGherkin } from "../server/gherkin.js";
import { planPage } from "../server/planner.js";
import { ordersGherkin } from "./fixtures.js";

function component(name: string, exports: string[]): CatalogComponent {
  return {
    id: `fixture:${name}`,
    sourceId: "fixture",
    sourceName: "Fixture UI",
    name,
    title: name,
    kind: "ui",
    exports,
    importPath: `@/registry/fixture/ui/${name}`,
    capabilities: capabilitiesFor(name, exports),
    provenance: `fixture://${name}`,
  };
}

const catalog = [
  component("table", ["Table", "TableBody", "TableCell", "TableHead", "TableHeader", "TableRow"]),
  component("badge", ["Badge"]),
  component("button", ["Button"]),
];

function generate(components = catalog, gherkin = ordersGherkin) {
  const plan = planPage(parseGherkin(gherkin).scenario, components);
  return generatePage({
    plan,
    components: new Map(components.map((entry) => [entry.id, entry])),
    shellImportPath: "@/registry/fixture/blocks/console/template-shell",
    shellExport: "TemplateShell",
  });
}

describe("generatePage", () => {
  const generated = generate();

  it("imports every visual element from the selected design system", () => {
    expect(generated.source).toContain('from "@/registry/fixture/ui/table"');
    expect(generated.source).toContain('from "@/registry/fixture/ui/badge"');
    expect(generated.source).toContain('from "@/registry/fixture/ui/button"');
  });

  it("renders the page inside the template's shell", () => {
    expect(generated.source).toContain('import { TemplateShell } from "@/registry/fixture/blocks/console/template-shell"');
    expect(generated.source).toContain("<TemplateShell>");
  });

  it("carries the scenario's rows as mock data", () => {
    expect(generated.source).toContain('"Order": "A-101"');
    expect(generated.source).toContain('"Status": "Paid"');
  });

  it("wires the filter the scenario describes to the rows it hides", () => {
    expect(generated.source).toContain("const [controlShowOverdue, setControlShowOverdue] = useState(false)");
    expect(generated.source).toContain('row["Status"] === "Overdue"');
  });

  it("emphasises the status the scenario filters on", () => {
    expect(generated.source).toContain('<Badge variant={row["Status"] === "Overdue" ? "default" : "secondary"}>');
  });

  it("anchors each block so a note can be attached to it", () => {
    expect(generated.source).toContain('data-studio-anchor="orders-table"');
    expect(generated.source).toContain('data-studio-anchor="control-show-overdue"');
  });

  it("marks each row with its identity so notes survive filtering", () => {
    expect(generated.source).toContain('data-studio-row={row["Order"]}');
  });

  it("uses no markup the design system did not publish", () => {
    const tags = [...generated.source.matchAll(/<([A-Z][A-Za-z]*)/g)].map((match) => match[1]!);
    const published = new Set([
      ...catalog.flatMap((entry) => entry.exports),
      "TemplateShell",
    ]);
    expect(tags.filter((tag) => !published.has(tag))).toEqual([]);
  });

  it("refuses to generate from a component that lacks the exports it needs", () => {
    expect(() => generate([component("table", ["Table"]), component("badge", ["Badge"]), component("button", ["Button"])])).toThrow(
      /does not export TableBody/,
    );
  });

  it("imports no React hooks when the page needs no state", () => {
    const source = generate(catalog, `Feature: F
  Scenario: S
    Given the following mock orders exist:
      | Order | Status  |
      | A-101 | Overdue |
    When I open the Orders page
    Then I see order "A-101"
`).source;
    expect(source).not.toContain('from "react"');
  });
});
