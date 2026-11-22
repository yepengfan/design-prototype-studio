import { describe, expect, it } from "vitest";
import type { Annotation, Project } from "../server/contracts.js";
import { renderBriefing } from "../server/delivery.js";
import { ordersGherkin } from "./fixtures.js";

const annotation: Annotation = {
  id: "note-1",
  pageId: "page-1",
  pageTitle: "Orders",
  target: {
    anchor: "control-show-overdue",
    domPath: '[data-studio-anchor="control-show-overdue"] > button:nth-child(1)',
    label: "Show overdue",
    role: "button",
  },
  note: "Call this Overdue only",
  createdAt: "2026-01-01T00:00:00.000Z",
};

const project: Project = {
  id: "project-1",
  name: "Orders prototype",
  createdAt: "2026-01-01T00:00:00.000Z",
  systems: [
    {
      id: "shadcn-1",
      name: "shadcn/ui",
      spec: { kind: "registry", url: "https://ui.shadcn.com/r/styles/new-york-v4" },
      origin: "https://ui.shadcn.com/r/styles/new-york-v4",
      importedAt: "2026-01-01T00:00:00.000Z",
      components: [],
      templates: [],
      warnings: [],
    },
  ],
  selectedSystemIds: ["shadcn-1"],
  selectedTemplateId: "shadcn-1:dashboard-01",
  gherkin: ordersGherkin,
  pages: [
    {
      id: "page-1",
      title: "Orders",
      templateId: "shadcn-1:dashboard-01",
      path: "src/app/page.tsx",
      source: "",
      generatedAt: "2026-01-01T00:00:00.000Z",
      plan: { title: "Orders", scenario: "Filter the orders list", blocks: [], gaps: [] },
    },
  ],
  annotations: [annotation],
  batches: [],
};

describe("renderBriefing", () => {
  const briefing = renderBriefing(project, "batch-1", [annotation]);

  it("tells the agent which prototype it is reviewing", () => {
    expect(briefing).toContain("Project: Orders prototype");
    expect(briefing).toContain("shadcn/ui (https://ui.shadcn.com/r/styles/new-york-v4)");
    expect(briefing).toContain("Template: shadcn-1:dashboard-01");
  });

  it.each(["another-template", undefined])("uses the rendered template when pending selection is %s", (selectedTemplateId) => {
    const briefing = renderBriefing({ ...project, selectedTemplateId }, "batch-selection", [annotation]);
    expect(briefing).toContain("Template: shadcn-1:dashboard-01");
    expect(briefing).not.toContain("Template: another-template");
    expect(briefing).not.toContain("Template: none");
    expect(briefing).toContain("Anchor: control-show-overdue");
  });

  it("includes the use case the page was generated from", () => {
    expect(briefing).toContain("Feature: Review overdue orders");
  });

  it("anchors each note to its page and element", () => {
    expect(briefing).toContain("**Show overdue** - Call this Overdue only");
    expect(briefing).toContain("Page: Orders (src/app/page.tsx)");
    expect(briefing).toContain("Anchor: control-show-overdue");
    expect(briefing).toContain('[data-studio-anchor="control-show-overdue"] > button:nth-child(1)');
  });
});
