// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { PreviewPane } from "../src/components/PreviewPane.js";
import type { GeneratedPage } from "../server/contracts.js";

it("accepts only valid selection payloads from the preview frame", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const onSelect = vi.fn();
  const page: GeneratedPage = {
    id: "page", title: "Orders", templateId: "template", path: "src/app/page.tsx", source: "", generatedAt: "2026-01-01",
    plan: { title: "Orders", scenario: "Orders", blocks: [], gaps: [] },
  };
  try {
    await act(() => Promise.resolve(root.render(createElement(PreviewPane, {
      projectId: "project", page, mode: "annotate", buildKey: "build", onModeChange: vi.fn(), onSelect,
    }))));
    const frame = container.querySelector("iframe")!;
    for (const target of [{ label: { invalid: true }, domPath: "button" }, null, { label: "Missing path" }]) {
      window.dispatchEvent(new MessageEvent("message", { source: frame.contentWindow, data: { type: "studio:select", target } }));
    }
    expect(onSelect).not.toHaveBeenCalled();
    const target = { label: "Orders", domPath: "button", anchor: "orders" };
    window.dispatchEvent(new MessageEvent("message", { source: window, data: { type: "studio:select", target } }));
    expect(onSelect).not.toHaveBeenCalled();
    window.dispatchEvent(new MessageEvent("message", { source: frame.contentWindow, data: { type: "studio:select", target } }));
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(target);
    expect(container.querySelector("iframe")).toBe(frame);
  } finally {
    await act(() => Promise.resolve(root.unmount()));
    container.remove();
    vi.unstubAllGlobals();
  }
});
