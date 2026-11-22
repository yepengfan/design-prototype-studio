/**
 * Capabilities are the vocabulary shared by the planner and the catalog.
 *
 * A page plan asks for a capability ("this scenario needs a table"); the catalog
 * answers with components from the selected design systems. Nothing is invented:
 * a component advertises a capability only when its published name or one of its
 * exported symbols matches a known alias, so a system that never published a
 * timeline never claims to have one.
 */
export const capabilities = [
  "table",
  "badge",
  "button",
  "input",
  "select",
  "card",
  "chart",
  "timeline",
  "kanban",
  "map",
  "gauge",
  "tree",
] as const;

export type Capability = (typeof capabilities)[number];

/**
 * Capabilities the generator can compose from a scenario on its own. A
 * capability outside this set still resolves against the catalog, but the plan
 * reports it as a gap, because knowing a component exists is not the same as
 * knowing how a scenario wants it filled in.
 */
export const composableCapabilities = ["table", "badge", "button", "input", "select", "card"] as const;

const aliases: Record<Capability, string[]> = {
  table: ["table", "datatable", "datagrid", "grid"],
  badge: ["badge", "tag", "chip", "pill", "status"],
  button: ["button", "iconbutton", "toggle", "togglegroup"],
  input: ["input", "textfield", "textinput", "searchfield", "search"],
  select: ["select", "dropdown", "combobox", "listbox", "picker"],
  card: ["card", "panel", "tile", "statcard", "metric"],
  chart: ["chart", "graph", "sparkline", "plot"],
  timeline: ["timeline", "activityfeed", "history"],
  kanban: ["kanban", "board", "swimlane"],
  map: ["map", "geomap", "mapview"],
  gauge: ["gauge", "dial", "speedometer"],
  tree: ["tree", "treeview", "treegrid"],
};

/** Wording used when the plan has to explain a capability to a designer. */
export const capabilityNouns: Record<Capability, string> = {
  table: "a table",
  badge: "a badge",
  button: "a button",
  input: "a text input",
  select: "a select",
  card: "a summary card",
  chart: "a chart",
  timeline: "a timeline",
  kanban: "a kanban board",
  map: "a map",
  gauge: "a gauge",
  tree: "a tree view",
};

function normalise(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Capabilities a catalog entry satisfies, derived from its name and exports. */
export function capabilitiesFor(name: string, exports: readonly string[] = []): Capability[] {
  const tokens = new Set([normalise(name), ...exports.map(normalise)]);
  return capabilities.filter((capability) => aliases[capability].some((alias) => tokens.has(alias)));
}

export function isComposable(capability: Capability): boolean {
  return (composableCapabilities as readonly string[]).includes(capability);
}
