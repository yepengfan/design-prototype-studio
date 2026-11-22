import { describe, expect, it } from "vitest";
import { importRegistry, resolveClosure, resolveTemplate } from "../server/sources/registry.js";
import { fixtureRegistry } from "./fixtures.js";

describe("importRegistry", () => {
  it("builds a catalog from the registry's own items", async () => {
    const imported = await importRegistry("fixture", "Fixture UI", fixtureRegistry);
    expect(imported.components.map((component) => component.name)).toEqual([
      "badge",
      "button",
      "card",
      "shell",
      "skeleton",
      "table",
    ]);
  });

  it("records the exports each item publishes", async () => {
    const imported = await importRegistry("fixture", "Fixture UI", fixtureRegistry);
    const table = imported.components.find((component) => component.name === "table");
    expect(table?.exports).toContain("TableHeader");
    expect(table?.exports).toContain("TableCell");
  });

  it("derives capabilities only from what an item publishes", async () => {
    const imported = await importRegistry("fixture", "Fixture UI", fixtureRegistry);
    const byName = new Map(imported.components.map((component) => [component.name, component]));
    expect(byName.get("table")?.capabilities).toContain("table");
    expect(byName.get("badge")?.capabilities).toContain("badge");
    expect(byName.get("shell")?.capabilities).toEqual([]);
  });

  it("records the item URL each entry came from", async () => {
    const imported = await importRegistry("fixture", "Fixture UI", fixtureRegistry);
    expect(imported.components[0]?.provenance).toMatch(/fixtures\/registry\/badge\.json$/);
  });

  it("reports a block the registry does not publish instead of listing it", async () => {
    const imported = await importRegistry("fixture", "Fixture UI", fixtureRegistry);
    expect(imported.templates.map((template) => template.name)).toEqual(["console-01"]);
    expect(imported.warnings.join(" ")).toContain("missing-block");
  });

  it("describes a template by the layout regions it preserves", async () => {
    const imported = await importRegistry("fixture", "Fixture UI", fixtureRegistry);
    expect(imported.templates[0]?.regions).toEqual(["Shell", "AppSidebar", "SiteHeader"]);
  });
});

describe("resolveClosure", () => {
  it("follows registry dependencies and the imports inside item files", async () => {
    const closure = await resolveClosure(fixtureRegistry, ["table"]);
    expect(closure.files.map((file) => file.path).sort()).toEqual([
      "src/registry/fixture/ui/skeleton.tsx",
      "src/registry/fixture/ui/table.tsx",
    ]);
  });

  it("leaves import aliases out of the npm package list", async () => {
    const closure = await resolveClosure(fixtureRegistry, ["table"]);
    expect(closure.packages).not.toContain("cn");
  });
});

describe("resolveTemplate", () => {
  it("keeps only the block files the layout shell still imports", async () => {
    const resolved = await resolveTemplate(fixtureRegistry, "console-01");
    const paths = resolved.files.map((file) => file.path).sort();
    expect(paths).toEqual([
      "src/registry/fixture/blocks/console/components/app-sidebar.tsx",
      "src/registry/fixture/blocks/console/components/site-header.tsx",
      "src/registry/fixture/ui/shell.tsx",
    ]);
  });

  it("drops the packages only the sample content needed", async () => {
    const resolved = await resolveTemplate(fixtureRegistry, "console-01");
    expect(resolved.packages).not.toContain("chart-lib");
  });

  it("writes the shell beside the page it came from", async () => {
    const resolved = await resolveTemplate(fixtureRegistry, "console-01");
    expect(resolved.shell.path).toBe("src/registry/fixture/blocks/console/template-shell.tsx");
  });
});
