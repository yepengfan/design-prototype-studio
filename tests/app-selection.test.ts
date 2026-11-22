// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { App } from "../src/App.js";
import { api, type Project } from "../src/lib/api.js";

it.each(["A:template", "B:template"])("enables Generate only for an available template: %s", async (selectedTemplateId) => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  const project: Project = {
    id: "project", name: "Orders", createdAt: "2026-01-01", gherkin: "Feature: Orders", pages: [], annotations: [], batches: [],
    selectedSystemIds: ["B"], selectedTemplateId,
    systems: ["A", "B"].map((name) => ({
      id: name, name, spec: { kind: "registry", url: "fixture" }, origin: "fixture", importedAt: "2026-01-01", components: [], warnings: [],
      templates: [{ id: `${name}:template`, name: "console", title: `${name} console`, sourceId: name, sourceName: name, provenance: "fixture", regions: [] }],
    })),
  };
  vi.spyOn(api, "presets").mockResolvedValue({ presets: [], defaultGherkin: "Feature: Orders" });
  vi.spyOn(api, "listProjects").mockResolvedValue({ projects: [project] });
  vi.spyOn(api, "searchComponents").mockResolvedValue({ components: [] });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(App)));
    expect(container.querySelector<HTMLInputElement>('input[aria-label="B console"]')).not.toBeNull();
    expect(container.querySelector<HTMLButtonElement>('[data-testid="generate"]')!.disabled).toBe(selectedTemplateId !== "B:template");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
