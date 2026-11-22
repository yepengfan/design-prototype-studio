import { z } from "zod";

/* ------------------------------------------------------------------ *
 * Design system sources
 * ------------------------------------------------------------------ */

export const registrySourceSchema = z.object({
  kind: z.literal("registry"),
  /** Base URL that serves `<base>/<name>.json` registry items. */
  url: z.string().min(1),
  /** Optional index URL listing available items; defaults to `<url>/index.json`. */
  indexUrl: z.string().min(1).optional(),
  /** Block names to probe, because registries do not publish a block index. */
  blocks: z.array(z.string()).optional(),
  /** Registry item name carrying the style's base CSS, usually `index`. */
  themeItem: z.string().optional(),
  /** URL of the base colour payload providing `cssVarsV4`. */
  colorsUrl: z.string().optional(),
  /**
   * Import specifiers a registry publishes as aliases rather than npm packages,
   * mapped to the path they take inside a generated project.
   */
  aliases: z.record(z.string(), z.string()).optional(),
});

export const npmSourceSchema = z.object({
  kind: z.literal("npm"),
  /** npm package name, for example `@acme/design-system`. */
  package: z.string().min(1),
  /** Exact published version. `latest` resolves through the npm registry. */
  version: z.string().min(1).default("latest"),
  /** npm registry URL, when the package is not on registry.npmjs.org. */
  registry: z.string().optional(),
});

export const sourceRequestSchema = z.object({
  name: z.string().min(1),
  spec: z.discriminatedUnion("kind", [registrySourceSchema, npmSourceSchema]),
});

export type RegistrySourceSpec = z.infer<typeof registrySourceSchema>;
export type NpmSourceSpec = z.infer<typeof npmSourceSchema>;
export type SourceSpec = z.infer<typeof sourceRequestSchema>["spec"];

/* ------------------------------------------------------------------ *
 * Catalog
 * ------------------------------------------------------------------ */

export const componentKinds = ["ui", "hook", "block", "page", "export"] as const;
export type ComponentKind = (typeof componentKinds)[number];

export const catalogComponentSchema = z.object({
  id: z.string(),
  sourceId: z.string(),
  sourceName: z.string(),
  name: z.string(),
  title: z.string(),
  kind: z.enum(componentKinds),
  description: z.string().optional(),
  /** Named exports the component publishes, used when generating imports. */
  exports: z.array(z.string()),
  /** Import specifier a generated page uses to reach this component. */
  importPath: z.string(),
  /** Normalised capabilities this component can satisfy in a page plan. */
  capabilities: z.array(z.string()),
  /** Where the entry came from, verbatim, so a designer can check it. */
  provenance: z.string(),
});

export const catalogTemplateSchema = z.object({
  id: z.string(),
  sourceId: z.string(),
  sourceName: z.string(),
  name: z.string(),
  title: z.string(),
  description: z.string().optional(),
  provenance: z.string(),
  /** Layout regions preserved from the template, outermost first. */
  regions: z.array(z.string()),
});

export type CatalogComponent = z.infer<typeof catalogComponentSchema>;
export type CatalogTemplate = z.infer<typeof catalogTemplateSchema>;

export const designSystemSchema = z.object({
  id: z.string(),
  name: z.string(),
  spec: z.discriminatedUnion("kind", [registrySourceSchema, npmSourceSchema]),
  origin: z.string(),
  importedAt: z.string(),
  components: z.array(catalogComponentSchema),
  templates: z.array(catalogTemplateSchema),
  warnings: z.array(z.string()),
});

export type DesignSystem = z.infer<typeof designSystemSchema>;

/* ------------------------------------------------------------------ *
 * Gherkin
 * ------------------------------------------------------------------ */

export const gherkinStepSchema = z.object({
  keyword: z.enum(["Given", "When", "Then"]),
  text: z.string(),
  line: z.number(),
  table: z
    .object({ columns: z.array(z.string()), rows: z.array(z.array(z.string())) })
    .optional(),
});

export const gherkinScenarioSchema = z.object({
  name: z.string(),
  steps: z.array(gherkinStepSchema),
});

export const gherkinFeatureSchema = z.object({
  name: z.string(),
  description: z.string(),
  // One scenario, not a list: a page is generated from a single scenario, and a
  // list would let a second one be read and then quietly left out.
  scenario: gherkinScenarioSchema,
});

export type GherkinStep = z.infer<typeof gherkinStepSchema>;
export type GherkinScenario = z.infer<typeof gherkinScenarioSchema>;
export type GherkinFeature = z.infer<typeof gherkinFeatureSchema>;

/* ------------------------------------------------------------------ *
 * Page plan
 * ------------------------------------------------------------------ */

export const datasetSchema = z.object({
  columns: z.array(z.string()),
  rows: z.array(z.record(z.string(), z.string())),
  statusColumn: z.string().optional(),
});

export const planBlockSchema = z.object({
  /** Stable anchor used by annotations and by generated markup. */
  anchor: z.string(),
  type: z.enum(["heading", "data-table", "filter-toggle", "text-filter", "select-filter", "summary"]),
  capability: z.string(),
  /** Gherkin step text that asked for this block. */
  requirement: z.string(),
  label: z.string().optional(),
  alternateLabel: z.string().optional(),
  column: z.string().optional(),
  value: z.string().optional(),
  options: z.array(z.string()).optional(),
  dataset: datasetSchema.optional(),
  /** Component ids resolved from the selected design systems. */
  componentIds: z.array(z.string()),
});

export const planGapSchema = z.object({
  capability: z.string(),
  requirement: z.string(),
  reason: z.string(),
  /** Phrasing the designer can act on when deciding to import another system. */
  suggestion: z.string(),
});

export const pagePlanSchema = z.object({
  title: z.string(),
  scenario: z.string(),
  blocks: z.array(planBlockSchema),
  gaps: z.array(planGapSchema),
});

export type Dataset = z.infer<typeof datasetSchema>;
export type PlanBlock = z.infer<typeof planBlockSchema>;
export type PlanGap = z.infer<typeof planGapSchema>;
export type PagePlan = z.infer<typeof pagePlanSchema>;

/* ------------------------------------------------------------------ *
 * Generated pages
 * ------------------------------------------------------------------ */

export const generatedPageSchema = z.object({
  id: z.string(),
  title: z.string(),
  plan: pagePlanSchema,
  templateId: z.string(),
  /** Project-relative path of the generated page source. */
  path: z.string(),
  source: z.string(),
  generatedAt: z.string(),
});

export type GeneratedPage = z.infer<typeof generatedPageSchema>;

/* ------------------------------------------------------------------ *
 * Annotations
 * ------------------------------------------------------------------ */

export const annotationTargetSchema = z.object({
  /** `data-studio-anchor` of the generated block, when the click hit one. */
  anchor: z.string().optional(),
  /** DOM path, always present, so template chrome can be annotated too. */
  domPath: z.string(),
  label: z.string(),
  role: z.string().optional(),
});

export const annotationSchema = z.object({
  id: z.string(),
  pageId: z.string(),
  pageTitle: z.string(),
  priorGeneration: z.boolean().optional(),
  target: annotationTargetSchema,
  note: z.string(),
  createdAt: z.string(),
  batchId: z.string().optional(),
});

export const annotationBatchSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  createdAt: z.string(),
  annotations: z.array(annotationSchema),
  /** Transport that carried the batch, and what it produced. */
  delivery: z.object({
    transport: z.string(),
    target: z.string(),
    receipt: z.string(),
    reply: z.string().optional(),
  }),
});

export type AnnotationTarget = z.infer<typeof annotationTargetSchema>;
export type Annotation = z.infer<typeof annotationSchema>;
export type AnnotationBatch = z.infer<typeof annotationBatchSchema>;

/* ------------------------------------------------------------------ *
 * Project
 * ------------------------------------------------------------------ */

export const projectSchema = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.string(),
  systems: z.array(designSystemSchema),
  selectedSystemIds: z.array(z.string()),
  selectedTemplateId: z.string().optional(),
  gherkin: z.string(),
  pages: z.array(generatedPageSchema),
  annotations: z.array(annotationSchema),
  batches: z.array(annotationBatchSchema),
});

export type Project = z.infer<typeof projectSchema>;

export const createProjectSchema = z.object({ name: z.string().min(1).default("Untitled prototype") });
export const selectTemplateSchema = z.object({ templateId: z.string().min(1) });
export const selectSystemsSchema = z.object({ systemIds: z.array(z.string()) });
export const generateSchema = z.object({ gherkin: z.string().min(1), templateId: z.string().min(1) });
export const annotationCreateSchema = z.object({
  pageId: z.string().min(1),
  generatedAt: z.iso.datetime(),
  target: annotationTargetSchema,
  note: z.string().min(1),
});
