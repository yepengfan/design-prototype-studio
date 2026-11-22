// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { App } from "../src/App.js";
import { api, type Project } from "../src/lib/api.js";

it("sends the displayed generation with notes after receiving newer project state", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  const generatedAt = "2026-01-01T00:00:00.000Z";
  const project: Project = {
    id: "project", name: "Orders", createdAt: generatedAt, gherkin: "Feature: Orders",
    systems: [], selectedSystemIds: [], annotations: [], batches: [],
    pages: [{
      id: "page", title: "Orders", generatedAt, templateId: "template", path: "src/app/page.tsx", source: "",
      plan: { title: "Orders", scenario: "Orders", blocks: [], gaps: [] },
    }],
  };
  const updated = structuredClone(project);
  updated.pages[0]!.generatedAt = "2026-01-02T00:00:00.000Z";
  vi.spyOn(api, "presets").mockResolvedValue({ presets: [], defaultGherkin: project.gherkin });
  vi.spyOn(api, "listProjects").mockResolvedValue({ projects: [project] });
  vi.spyOn(api, "searchComponents").mockResolvedValue({ components: [] });
  const requests: unknown[] = [];
  vi.stubGlobal("fetch", vi.fn((_url: string, init: RequestInit) => {
    requests.push(JSON.parse(init.body as string));
    return Promise.resolve(new Response(JSON.stringify({ project: updated })));
  }));
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(() => Promise.resolve(root.render(createElement(App))));
    const frame = container.querySelector("iframe")!;
    for (const note of ["First stale note", "Second stale note"]) {
      await act(() => {
        window.dispatchEvent(new MessageEvent("message", {
          source: frame.contentWindow,
          data: { type: "studio:select", target: { label: "Show overdue", domPath: "button", anchor: "control-show-overdue" } },
        }));
        return Promise.resolve();
      });
      const input = container.querySelector<HTMLInputElement>("#note")!;
      await act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, note);
        input.dispatchEvent(new Event("input", { bubbles: true }));
        return Promise.resolve();
      });
      await act(() => Promise.resolve(container.querySelector<HTMLButtonElement>('[data-testid="queue-note"]')!.click()));
      expect(requests.at(-1)).toMatchObject({ pageId: "page", generatedAt, note });
    }
    expect(requests).toHaveLength(2);
    expect(container.querySelector("iframe")).toBe(frame);
  } finally {
    await act(() => Promise.resolve(root.unmount()));
    container.remove();
    vi.unstubAllGlobals();
  }
});
