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
  it("shows the agent's own answer on a receipt and blocks removal while busy", () => {
    const markup = renderToStaticMarkup(createElement(NotesPanel, {
      project: { ...project, batches: [{
        id: "batch", projectId: project.id, createdAt: "2026-01-01", annotations: [annotation],
        delivery: { transport: "command", target: "review", receipt: "Review receipt", reply: "Reviewed" },
      }] },
      busy: true, note: "", onNoteChange: ignore, onQueue: ignore,
      onDiscard: ignore, onRemove: ignore, onSend: ignore,
    }));
    const document = new JSDOM(markup).window.document;
    const receipt = document.querySelector('[data-testid="delivery-receipt"]')?.textContent;
    expect(receipt).toContain("Delivered");
    expect(receipt).toContain("Reviewed");
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
