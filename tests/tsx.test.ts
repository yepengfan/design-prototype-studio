import { describe, expect, it } from "vitest";
import { exportedNames, extractLayout, importSpecifiers } from "../server/tsx.js";

const dashboardPage = `import { AppSidebar } from "@/registry/style/blocks/console/components/app-sidebar"
import { SiteHeader } from "@/registry/style/blocks/console/components/site-header"
import { SectionCards } from "@/registry/style/blocks/console/components/section-cards"
import { DataTable } from "@/registry/style/blocks/console/components/data-table"
import { SidebarInset, SidebarProvider } from "@/registry/style/ui/sidebar"

import data from "./data.json"

export default function Page() {
  return (
    <SidebarProvider>
      <AppSidebar variant="inset" />
      <SidebarInset>
        <SiteHeader />
        <div className="flex flex-1 flex-col">
          <div className="main flex flex-1 flex-col gap-2">
            <div className="flex flex-col gap-4 py-4">
              <SectionCards />
              <DataTable data={data} />
            </div>
          </div>
        </div>
      </SidebarInset>
    </SidebarProvider>
  )
}
`;

describe("extractLayout", () => {
  const layout = extractLayout(dashboardPage);

  it("keeps the chrome a designer chose the template for", () => {
    expect(layout.regions).toEqual(["SidebarProvider", "AppSidebar", "SidebarInset", "SiteHeader"]);
    expect(layout.source).toContain("<AppSidebar variant=\"inset\" />");
    expect(layout.source).toContain("<SiteHeader />");
  });

  it("replaces the template's sample content with the content slot", () => {
    expect(layout.source).toContain("{children}");
    expect(layout.source).not.toContain("SectionCards");
    expect(layout.source).not.toContain("DataTable");
  });

  it("preserves the layout wrappers around the slot", () => {
    expect(layout.source).toContain('<div className="main flex flex-1 flex-col gap-2">');
    expect(layout.source).toContain('<div className="flex flex-col gap-4 py-4">{children}</div>');
  });

  it("drops imports the shell no longer uses", () => {
    expect(layout.imports).not.toContain("./data.json");
    expect(layout.imports).toContain("@/registry/style/ui/sidebar");
    expect(layout.imports).toContain("@/registry/style/blocks/console/components/app-sidebar");
  });

  it("exports a shell component that accepts children", () => {
    expect(layout.source).toContain("export function TemplateShell({ children }: { children?: ReactNode })");
    expect(layout.source).toContain('import type { ReactNode } from "react"');
  });

  it("explains a template with no default page component", () => {
    expect(() => extractLayout("export const x = 1")).toThrow(/does not export a default page component/);
  });

  it("explains a template whose content region cannot hold children", () => {
    expect(() =>
      extractLayout(`export default function Page() {\n  return <Shell />\n}\n`),
    ).toThrow(/no content region/);
  });
});

describe("module reading", () => {
  it("lists import specifiers in source order", () => {
    expect(importSpecifiers(dashboardPage)).toEqual([
      "@/registry/style/blocks/console/components/app-sidebar",
      "@/registry/style/blocks/console/components/site-header",
      "@/registry/style/blocks/console/components/section-cards",
      "@/registry/style/blocks/console/components/data-table",
      "@/registry/style/ui/sidebar",
      "./data.json",
    ]);
  });

  it("lists the names a component module exports", () => {
    const source = `export function Table() { return null }
export const TableBody = () => null
function TableCell() { return null }
export { TableCell }
`;
    expect(exportedNames(source).sort()).toEqual(["Table", "TableBody", "TableCell"]);
  });
});
