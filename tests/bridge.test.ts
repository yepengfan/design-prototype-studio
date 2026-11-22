// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { describe as describeTarget, domPath, installAnnotationBridge } from "../preview-runtime/bridge.js";

function render(html: string) {
  document.body.innerHTML = html;
  document.body.className = "";
}

const page = `
<div data-studio-anchor="control-show-overdue">
  <button id="filter" aria-pressed="false">Show overdue</button>
</div>
<div data-studio-anchor="orders-table">
  <table>
    <tbody>
      <tr data-studio-row="A-101"><td>A-101</td><td><span>Overdue</span></td></tr>
    </tbody>
  </table>
</div>
<p>Untagged copy</p>
`;

describe("describe", () => {
  beforeEach(() => render(page));

  it("reports the generated anchor the element belongs to", () => {
    const target = describeTarget(document.getElementById("filter")!);
    expect(target.anchor).toBe("control-show-overdue");
    expect(target.label).toBe("Show overdue");
    expect(target.role).toBe("button");
  });

  it("falls back to a DOM path for template chrome with no anchor", () => {
    const target = describeTarget(document.querySelector("p")!);
    expect(target.anchor).toBeUndefined();
    expect(target.domPath).toContain("p:nth-child");
  });

  it("anchors a row by its identity rather than its position", () => {
    const cell = document.querySelector("[data-studio-row] td")!;
    expect(domPath(cell)).toContain('[data-studio-row="A-101"]');
    expect(document.querySelector(domPath(cell))).toBe(cell);
  });

  it("produces a path that still selects the element", () => {
    const target = describeTarget(document.getElementById("filter")!);
    expect(document.querySelector(target.domPath)).not.toBeNull();
  });
});

describe("installAnnotationBridge", () => {
  beforeEach(() => render(page));

  it("lets a control act normally in interact mode", () => {
    const teardown = installAnnotationBridge(window);
    const onClick = vi.fn();
    document.getElementById("filter")!.addEventListener("click", onClick);
    document.getElementById("filter")!.click();
    expect(onClick).toHaveBeenCalledOnce();
    teardown();
  });

  it("claims the click in annotate mode so the control does not act", () => {
    const teardown = installAnnotationBridge(window);
    const onClick = vi.fn();
    document.getElementById("filter")!.addEventListener("click", onClick);

    window.dispatchEvent(new MessageEvent("message", { data: { type: "studio:mode", mode: "annotate" } }));
    document.getElementById("filter")!.click();

    expect(onClick).not.toHaveBeenCalled();
    expect(document.body.classList.contains("studio-annotating")).toBe(true);
    teardown();
  });

  it("reports the selected target to the Studio", () => {
    const posted: unknown[] = [];
    vi.spyOn(window.parent, "postMessage").mockImplementation((message) => posted.push(message));
    const teardown = installAnnotationBridge(window);

    window.dispatchEvent(new MessageEvent("message", { data: { type: "studio:mode", mode: "annotate" } }));
    document.getElementById("filter")!.click();

    const select = posted.find(
      (message): message is { type: string; target: Record<string, unknown> } =>
        (message as { type?: string }).type === "studio:select",
    );

    expect(select?.target).toMatchObject({ anchor: "control-show-overdue", label: "Show overdue" });
    teardown();
  });

  it("returns to normal behaviour when interact mode comes back", () => {
    const teardown = installAnnotationBridge(window);
    const onClick = vi.fn();
    document.getElementById("filter")!.addEventListener("click", onClick);

    window.dispatchEvent(new MessageEvent("message", { data: { type: "studio:mode", mode: "annotate" } }));
    window.dispatchEvent(new MessageEvent("message", { data: { type: "studio:mode", mode: "interact" } }));
    document.getElementById("filter")!.click();

    expect(onClick).toHaveBeenCalledOnce();
    expect(document.body.classList.contains("studio-annotating")).toBe(false);
    teardown();
  });
});
