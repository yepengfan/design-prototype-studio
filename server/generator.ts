import type { CatalogComponent, Dataset, PagePlan, PlanBlock } from "./contracts.js";
import { StudioError } from "./errors.js";

export type GenerationInput = {
  plan: PagePlan;
  /** Components the plan resolved, keyed by catalog id. */
  components: Map<string, CatalogComponent>;
  /** Import path of the layout shell extracted from the selected template. */
  shellImportPath: string;
  shellExport: string;
};

export type GeneratedSource = {
  source: string;
  /** Import specifiers the page needs, for the preview build's file closure. */
  imports: string[];
};

/**
 * Emits the React source of a generated page.
 *
 * Every visual element comes from a component the plan resolved in a selected
 * design system; the generator contributes layout, state and mock data only. If
 * a block's component does not publish the exports its markup needs, generation
 * fails instead of falling back to raw HTML that would misrepresent the system.
 */
export function generatePage(input: GenerationInput): GeneratedSource {
  const { plan, components, shellImportPath, shellExport } = input;
  const imports = new Map<string, Set<string>>();
  const use = (componentId: string, ...exports: string[]) => {
    const component = components.get(componentId);
    if (!component)
      throw new StudioError(`The plan references component "${componentId}", which is not in the catalog.`);
    for (const name of exports)
      if (component.exports.length > 0 && !component.exports.includes(name))
        throw new StudioError(
          `${component.sourceName} ${component.title} does not export ${name}, so this page cannot be generated from it.`,
          422,
        );
    const set = imports.get(component.importPath) ?? new Set<string>();
    for (const name of exports) set.add(name);
    imports.set(component.importPath, set);
    return component;
  };

  const dataset = plan.blocks.find((block) => block.dataset)?.dataset;
  const filters = plan.blocks.filter(
    (block) => block.type === "filter-toggle" || block.type === "text-filter" || block.type === "select-filter",
  );

  for (const filter of filters) {
    if (!dataset || !filter.column || !dataset.columns.includes(filter.column) ||
      (filter.type !== "text-filter" && (!filter.value || !dataset.rows.some((row) => row[filter.column!] === filter.value))) ||
      (filter.type === "select-filter" && (!filter.options?.length ||
        !filter.options.includes(filter.value!) ||
        filter.options.some((option) => !option || !dataset.rows.some((row) => row[filter.column!] === option)))))
      throw new StudioError(`The filter for "${filter.requirement}" cannot be resolved against the page's rows.`, 422);
  }

  const body: string[] = [];
  const state: string[] = [];

  for (const block of plan.blocks) {
    switch (block.type) {
      case "heading":
        body.push(renderHeading(block));
        break;
      case "filter-toggle": {
        use(block.componentIds[0]!, "Button");
        state.push(`  const [${stateName(block)}, ${setterName(block)}] = useState(false)`);
        body.push(renderToggle(block));
        break;
      }
      case "text-filter": {
        use(block.componentIds[0]!, "Input");
        state.push(`  const [${stateName(block)}, ${setterName(block)}] = useState("")`);
        body.push(renderTextFilter(block));
        break;
      }
      case "select-filter": {
        use(block.componentIds[0]!, "Select", "SelectContent", "SelectItem", "SelectTrigger", "SelectValue");
        state.push(`  const [${stateName(block)}, ${setterName(block)}] = useState("all")`);
        body.push(renderSelectFilter(block));
        break;
      }
      case "summary": {
        use(block.componentIds[0]!, "Card", "CardHeader", "CardTitle", "CardContent");
        body.push(renderSummary(block, dataset));
        break;
      }
      case "data-table": {
        use(block.componentIds[0]!, "Table", "TableBody", "TableCell", "TableHead", "TableHeader", "TableRow");
        if (block.componentIds[1]) use(block.componentIds[1], "Badge");
        body.push(renderTable(block, filters, Boolean(block.componentIds[1])));
        break;
      }
    }
  }

  const filtersRows = filters.length > 0;
  const hooks = [...(filtersRows ? ["useMemo"] : []), ...(state.length ? ["useState"] : [])];

  const header = [
    ...(hooks.length ? [`import { ${hooks.join(", ")} } from "react"`] : []),
    ...[...imports.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([path, names]) => `import { ${[...names].sort().join(", ")} } from "${path}"`),
    `import { ${shellExport} } from "${shellImportPath}"`,
  ];

  const source = [
    ...header,
    "",
    dataset ? renderRows(dataset) : "",
    `export default function GeneratedPage() {`,
    ...state,
    dataset ? renderVisibleRows(filters) : "",
    `  return (`,
    `    <${shellExport}>`,
    `      <div className="flex flex-col gap-6 px-4 py-6 lg:px-6" data-studio-page="${escapeAttribute(plan.title)}">`,
    ...body.map((line) => indent(line, 8)),
    `      </div>`,
    `    </${shellExport}>`,
    `  )`,
    `}`,
    "",
  ]
    .filter((line) => line !== "")
    .join("\n");

  return { source, imports: [...imports.keys(), shellImportPath] };
}

function renderRows(dataset: Dataset): string {
  return `const rows = ${JSON.stringify(dataset.rows, null, 2)} as const\n`;
}

function renderVisibleRows(filters: PlanBlock[]): string {
  const conditions = filters.flatMap((filter) => {
    const column = filter.column!;
    if (filter.type === "filter-toggle" && filter.value)
      return [`(!${stateName(filter)} || row[${JSON.stringify(column)}] === ${JSON.stringify(filter.value)})`];
    if (filter.type === "text-filter")
      return [
        `row[${JSON.stringify(column)}].toLowerCase().includes(${stateName(filter)}.toLowerCase())`,
      ];
    if (filter.type === "select-filter")
      return [`(${stateName(filter)} === "all" || row[${JSON.stringify(column)}] === ${JSON.stringify(filter.options)}[Number(${stateName(filter)})])`];
    return [];
  });
  const dependencies = filters.map(stateName);
  if (conditions.length === 0) return `  const visibleRows = rows`;
  return [
    `  const visibleRows = useMemo(`,
    `    () => rows.filter((row) => ${conditions.join(" && ")}),`,
    `    [${dependencies.join(", ")}],`,
    `  )`,
  ].join("\n");
}

function renderHeading(block: PlanBlock): string {
  return [
    `<div data-studio-anchor="${block.anchor}">`,
    `  <h1 className="text-2xl font-semibold tracking-tight">${escapeText(block.label ?? "Page")}</h1>`,
    `  <p className="text-muted-foreground text-sm">${escapeText(block.requirement)}</p>`,
    `</div>`,
  ].join("\n");
}

function renderToggle(block: PlanBlock): string {
  return [
    `<div className="flex flex-wrap items-center gap-2" data-studio-anchor="${block.anchor}">`,
    `  <Button`,
    `    variant={${stateName(block)} ? "default" : "outline"}`,
    `    aria-pressed={${stateName(block)}}`,
    `    onClick={() => ${setterName(block)}((previous) => !previous)}`,
    `  >`,
    `    {${stateName(block)} ? ${JSON.stringify(block.alternateLabel ?? "Show all")} : ${JSON.stringify(block.label ?? "Filter")}}`,
    `  </Button>`,
    `</div>`,
  ].join("\n");
}

function renderTextFilter(block: PlanBlock): string {
  return [
    `<div className="grid max-w-sm gap-2" data-studio-anchor="${block.anchor}">`,
    `  <label className="text-sm font-medium" htmlFor="${block.anchor}">${escapeText(block.label ?? "Search")}</label>`,
    `  <Input`,
    `    id="${block.anchor}"`,
    `    placeholder={${JSON.stringify(block.value ?? "")}}`,
    `    value={${stateName(block)}}`,
    `    onChange={(event) => ${setterName(block)}(event.target.value)}`,
    `  />`,
    `</div>`,
  ].join("\n");
}

function renderSelectFilter(block: PlanBlock): string {
  const options = block.options ?? [];
  return [
    `<div className="grid max-w-xs gap-2" data-studio-anchor="${block.anchor}">`,
    `  <label className="text-sm font-medium" htmlFor="${block.anchor}">${escapeText(block.label ?? "Filter")}</label>`,
    `  <Select value={${stateName(block)}} onValueChange={${setterName(block)}}>`,
    `    <SelectTrigger id="${block.anchor}">`,
    `      <SelectValue placeholder=${JSON.stringify(block.label ?? "Filter")} />`,
    `    </SelectTrigger>`,
    `    <SelectContent>`,
    `      <SelectItem value="all">All</SelectItem>`,
    ...options.map((option, index) => `      <SelectItem value=${JSON.stringify(String(index))}>${escapeText(option)}</SelectItem>`),
    `    </SelectContent>`,
    `  </Select>`,
    `</div>`,
  ].join("\n");
}

function renderSummary(block: PlanBlock, dataset: Dataset | undefined): string {
  if (!dataset) throw new StudioError("A row count summary needs the rows its scenario listed.");
  const value = `{visibleRows.length}`;
  return [
    `<Card data-studio-anchor="${block.anchor}" className="max-w-xs">`,
    `  <CardHeader>`,
    `    <CardTitle className="text-sm font-medium">${escapeText(block.label ?? "Summary")}</CardTitle>`,
    `  </CardHeader>`,
    `  <CardContent className="text-3xl font-semibold tabular-nums">${value}</CardContent>`,
    `</Card>`,
  ].join("\n");
}

function renderTable(block: PlanBlock, filters: PlanBlock[], withBadge: boolean): string {
  const dataset = block.dataset;
  if (!dataset) throw new StudioError("A table block needs the rows its scenario listed.");
  const statusColumn = dataset.statusColumn;
  const source = filters.length > 0 ? "visibleRows" : "rows";

  // A status the scenario filters on is the one it cares about, so it is the
  // value the badge emphasises. Without such a filter every status reads alike.
  const emphasised = filters.find(
    (filter) => filter.column === statusColumn && filter.value,
  )?.value;

  const cell = (column: string) => {
    if (!withBadge || column !== statusColumn) return `{row[${JSON.stringify(column)}]}`;
    const variant = emphasised
      ? `{row[${JSON.stringify(column)}] === ${JSON.stringify(emphasised)} ? "default" : "secondary"}`
      : `"secondary"`;
    return `<Badge variant=${variant}>{row[${JSON.stringify(column)}]}</Badge>`;
  };

  return [
    `<div className="rounded-lg border" data-studio-anchor="${block.anchor}">`,
    `  <Table>`,
    `    <TableHeader>`,
    `      <TableRow>`,
    ...dataset.columns.map((column) => `        <TableHead>${escapeText(column)}</TableHead>`),
    `      </TableRow>`,
    `    </TableHeader>`,
    `    <TableBody>`,
    `      {${source}.map((row) => (`,
    `        <TableRow key={row[${JSON.stringify(dataset.columns[0]!)}]} data-studio-row={row[${JSON.stringify(dataset.columns[0]!)}]}>`,
    ...dataset.columns.map((column) => `          <TableCell>${cell(column)}</TableCell>`),
    `        </TableRow>`,
    `      ))}`,
    `      {${source}.length === 0 && (`,
    `        <TableRow>`,
    `          <TableCell colSpan={${dataset.columns.length}} className="text-muted-foreground text-center">`,
    `            No rows match the current filters.`,
    `          </TableCell>`,
    `        </TableRow>`,
    `      )}`,
    `    </TableBody>`,
    `  </Table>`,
    `</div>`,
  ].join("\n");
}

function stateName(block: PlanBlock): string {
  return camel(block.anchor);
}

function setterName(block: PlanBlock): string {
  const name = camel(block.anchor);
  return `set${name.charAt(0).toUpperCase()}${name.slice(1)}`;
}

function camel(value: string): string {
  return value.replace(/-([a-z0-9])/g, (_, character: string) => character.toUpperCase());
}

function indent(block: string, spaces: number): string {
  const pad = " ".repeat(spaces);
  return block
    .split("\n")
    .map((line) => (line ? pad + line : line))
    .join("\n");
}

function escapeText(value: string): string {
  return value.replace(/[{}<>]/g, (character) => `{${JSON.stringify(character)}}`);
}

function escapeAttribute(value: string): string {
  return value.replace(/"/g, "&quot;");
}
