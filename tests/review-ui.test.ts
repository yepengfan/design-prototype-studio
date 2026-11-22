import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import type { Project } from "../server/contracts.js";
import { NotesPanel } from "../src/components/NotesPanel.js";
import { TemplatePicker } from "../src/components/TemplatePicker.js";

const ignore = () => {};
const annotation = {
  id: "note", pageId: "page", pageTitle: "Orders", note: "Review this",
  createdAt: "2026-01-01", target: { label: "Orders", domPath: "h1" },
};
const project: Project = {
  id: "project", name: "Orders", createdAt: "2026-01-01", systems: [],
  selectedSystemIds: [], gherkin: "", pages: [], annotations: [annotation], batches: [],
};

describe("feedback and selection controls", () => {
  it.each(["file", "command"] as const)("labels %s receipts honestly and blocks removal while busy", (transport) => {
    const markup = renderToStaticMarkup(createElement(NotesPanel, {
      project: { ...project, batches: [{
        id: "batch", projectId: project.id, createdAt: "2026-01-01", annotations: [annotation],
        delivery: { transport, target: "review", receipt: "Review receipt", reply: transport === "command" ? "Reviewed" : undefined },
      }] },
      busy: true, note: "", onNoteChange: ignore, onQueue: ignore,
      onDiscard: ignore, onRemove: ignore, onSend: ignore,
    }));
    const document = new JSDOM(markup).window.document;
    expect(document.querySelector('[data-testid="delivery-receipt"]')?.textContent)
      .toContain(transport === "command" ? "Delivered" : "Written for agent pickup");
    expect(document.querySelector('button[aria-label="Remove note Review this"]')?.hasAttribute("disabled")).toBe(true);
  });

  it("disables template selection during an outstanding operation", () => {
    const markup = renderToStaticMarkup(createElement(TemplatePicker, {
      templates: [{ id: "template", name: "console", title: "Console", sourceId: "fixture", sourceName: "Fixture", provenance: "fixture", regions: [] }],
      busy: true, onSelect: ignore,
    }));
    expect(new JSDOM(markup).window.document.querySelector('input[type="radio"]')?.hasAttribute("disabled")).toBe(true);
  });
});
