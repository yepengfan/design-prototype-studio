import { z } from "zod";

export const filesSchema = z.record(z.string(), z.string());
export type Files = z.infer<typeof filesSchema>;
export type Property = {
  type: "string" | "number" | "boolean" | "enum" | "object";
  description: string;
  label?: string;
  options?: string[];
  required?: boolean;
  business: boolean;
  default?: unknown;
  fields?: Record<string, Property>;
};
const propertySchema: z.ZodType<Property> = z.lazy(() =>
  z.object({
    type: z.enum(["string", "number", "boolean", "enum", "object"]),
    description: z.string(),
    label: z.string().optional(),
    options: z.array(z.string()).optional(),
    required: z.boolean().optional(),
    business: z.boolean().default(false),
    default: z.unknown().optional(),
    fields: z.record(z.string(), propertySchema).optional(),
  }),
);
export const componentSchema = z.object({
  name: z.string(),
  export: z.string(),
  package: z.string(),
  version: z.string(),
  description: z.string().min(1),
  provenance: z.string(),
  api: z.string().optional(),
  documentation: z.string().optional(),
  props: z.record(z.string(), propertySchema),
  children: z.boolean().default(false),
  requiresBehavior: z.boolean().default(false),
  slots: z.array(z.string()).default([]),
  examples: z
    .array(
      z.object({
        name: z.string(),
        props: z.record(z.string(), z.unknown()),
        children: z.string().optional(),
        story: z
          .object({
            file: z.string(),
            export: z.string(),
            annotations: z.string().optional(),
          })
          .optional(),
        source: z.string().optional(),
      }),
    )
    .min(1),
  styles: z.array(z.string()).default([]),
  provider: z.string().optional(),
});
export type Component = z.infer<typeof componentSchema>;
export const scenarioBindingSchema = z.object({
  scenario: z.string(),
  page: z.string(),
  story: z.string(),
  fixture: z.string(),
  steps: z.array(
    z.object({
      step: z.string(),
      action: z.enum([
        "click",
        "fill",
        "visible",
        "text",
        "count",
        "value",
        "enabled",
        "disabled",
        "hidden",
      ]),
      role: z.string(),
      name: z.string(),
      value: z.string().optional(),
      count: z.number().optional(),
    }),
  ),
  accepted: z.boolean().default(false),
});
export const manifestSchema = z.object({
  schemaVersion: z.literal(1),
  sourceOrigin: z.enum(["native", "legacy"]).optional(),
  generationState: z.enum(["unstarted", "generated"]).default("generated"),
  name: z.string().min(1),
  pages: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      file: z.string(),
      export: z.string(),
      previewStory: z.string().optional(),
    }),
  ),
  scope: z.array(z.string()),
  libraries: z.array(
    z.object({
      name: z.string(),
      version: z.string(),
      registry: z
        .string()
        .refine((value) => {
          try {
            const url = new URL(value);
            return (
              !url.username &&
              !url.password &&
              !url.search &&
              !url.hash &&
              (url.protocol === "https:" ||
                (url.protocol === "http:" &&
                  ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))
            );
          } catch {
            return false;
          }
        }, "Registry addresses must not contain credentials or query parameters.")
        .optional(),
      components: z.array(componentSchema),
    }),
  ),
  scenarios: z.array(scenarioBindingSchema),
  styles: z.array(z.string()).default([]),
  provider: z.string().optional(),
});
export type Manifest = z.infer<typeof manifestSchema>;
export type Binding = z.infer<typeof scenarioBindingSchema>;
export type Snapshot = {
  id: string;
  parent?: string;
  label: string;
  at: string;
  files: Files;
  manifest: Manifest;
  activeAnnotationResults?: string[];
};
export type Annotation = {
  id: string;
  target: string;
  page: string;
  text: string;
  base: string;
  status:
    | "draft"
    | "approved"
    | "processing"
    | "pending"
    | "accepted"
    | "undone"
    | "failed";
  run?: string;
  before?: Files;
  after?: Files;
  message?: string;
};
export type ProjectState = {
  id: string;
  head: string;
  redo: string[];
  versions: { name: string; snapshot: string }[];
  annotations: Annotation[];
  runs: Run[];
  templateReconciliation?: { requirements: Files; scope: string[] };
};
export type Run = {
  id: string;
  page?: string;
  adapter: "codex" | "cursor";
  base: string;
  prompt: string;
  status:
    | "queued"
    | "running"
    | "review"
    | "applied"
    | "cancelled"
    | "interrupted"
    | "failed";
  events: string[];
  session?: string;
  turn?: string;
  proposal?: Proposal;
  error?: string;
  annotation?: string;
  annotationText?: string;
  repair?: boolean;
  appliedBase?: string;
  appliedRevision?: string;
};
export const proposalSchema = z.object({
  summary: z.string(),
  kind: z.enum(["presentation", "business", "clarification", "gap"]),
  questions: z.array(z.string()),
  files: filesSchema,
  deleted: z.array(z.string()).optional(),
  manifest: manifestSchema.optional(),
  manifestChanges: z
    .object({
      pages: manifestSchema.shape.pages.optional(),
      scenarios: manifestSchema.shape.scenarios.optional(),
      styles: z.array(z.string()).optional(),
      provider: z.string().optional(),
      scope: z.array(z.string()).optional(),
    })
    .optional(),
  affectedScenarios: z.array(z.string()),
});
export type Proposal = z.infer<typeof proposalSchema>;
export class StudioError extends Error {
  constructor(
    message: string,
    public status = 400,
    public detail?: unknown,
  ) {
    super(message);
  }
}
