/**
 * The bridge the Studio installs inside a generated preview.
 *
 * In Interact mode the preview behaves like the real page. In Annotate mode a
 * capture-phase listener claims the click before the page sees it, so selecting
 * a control opens a note instead of running the control's action, and the page
 * keeps whatever state the designer had reached.
 *
 * This file is copied verbatim into every generated project, so it depends on
 * nothing but the DOM.
 */

export type BridgeMode = "interact" | "annotate";

export type BridgeTarget = {
  anchor?: string;
  domPath: string;
  label: string;
  role?: string;
};

export type BridgeMessage =
  | { type: "studio:ready" }
  | { type: "studio:select"; target: BridgeTarget }
  | { type: "studio:mode"; mode: BridgeMode };

const annotatingClass = "studio-annotating";

export function installAnnotationBridge(target: Window = window): () => void {
  let mode: BridgeMode = "interact";

  const onMessage = (event: MessageEvent) => {
    const data = event.data as BridgeMessage | undefined;
    if (!data || data.type !== "studio:mode") return;
    mode = data.mode;
    target.document.body.classList.toggle(annotatingClass, mode === "annotate");
  };

  const onPointerDown = (event: Event) => {
    if (mode !== "annotate") return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  const onClick = (event: MouseEvent) => {
    if (mode !== "annotate") return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const element = event.target as Element | null;
    if (!element) return;
    target.parent.postMessage({ type: "studio:select", target: describe(element) } satisfies BridgeMessage, "*");
  };

  target.addEventListener("message", onMessage);
  // Pointer and mouse events are claimed as well: a control that reacts before
  // click (a select, a drag handle) must not act while notes are being taken.
  for (const name of ["pointerdown", "mousedown", "keydown"] as const)
    target.document.addEventListener(name, onPointerDown, true);
  target.document.addEventListener("click", onClick, true);
  target.parent.postMessage({ type: "studio:ready" } satisfies BridgeMessage, "*");

  return () => {
    target.removeEventListener("message", onMessage);
    for (const name of ["pointerdown", "mousedown", "keydown"] as const)
      target.document.removeEventListener(name, onPointerDown, true);
    target.document.removeEventListener("click", onClick, true);
  };
}

/** Describes the clicked element so a note can be re-attached to it later. */
export function describe(element: Element): BridgeTarget {
  const anchored = element.closest("[data-studio-anchor]");
  return {
    anchor: anchored?.getAttribute("data-studio-anchor") ?? undefined,
    domPath: domPath(element),
    label: label(element),
    role: element.getAttribute("role") ?? roleOf(element),
  };
}

function roleOf(element: Element): string | undefined {
  const tag = element.tagName.toLowerCase();
  if (tag === "button" || tag === "a" || tag === "input" || tag === "td" || tag === "th") return tag;
  return undefined;
}

function label(element: Element): string {
  const aria = element.getAttribute("aria-label");
  if (aria) return aria.trim();
  if (element instanceof HTMLInputElement) return element.placeholder || element.name || "input";
  const text = (element.textContent ?? "").replace(/\s+/g, " ").trim();
  return text.slice(0, 80) || element.tagName.toLowerCase();
}

/**
 * A CSS path that survives re-rendering: it prefers the nearest generated
 * anchor, then stable row identity, then element position among siblings.
 */
export function domPath(element: Element): string {
  const segments: string[] = [];
  let current: Element | null = element;

  while (current && current.tagName.toLowerCase() !== "body") {
    const anchor = current.getAttribute("data-studio-anchor");
    if (anchor) {
      segments.unshift(`[data-studio-anchor="${anchor}"]`);
      break;
    }
    const row = current.getAttribute("data-studio-row");
    if (row) {
      segments.unshift(`[data-studio-row="${cssEscape(row)}"]`);
      current = current.parentElement;
      continue;
    }
    if (current.id) {
      segments.unshift(`#${cssEscape(current.id)}`);
      break;
    }
    const parent: Element | null = current.parentElement;
    const index = parent ? [...parent.children].indexOf(current) + 1 : 1;
    segments.unshift(`${current.tagName.toLowerCase()}:nth-child(${index})`);
    current = parent;
  }

  return segments.join(" > ") || "body";
}

function cssEscape(value: string): string {
  return value.replace(/["\\]/g, "\\$&");
}
