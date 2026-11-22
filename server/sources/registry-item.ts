import { z } from "zod";
import type { RegistrySourceSpec } from "../contracts.js";
import { StudioError } from "../errors.js";
import { fetchJson } from "./fetcher.js";

/** A registry item, as published by shadcn-compatible registries. */
export const registryItemSchema = z.object({
  name: z.string(),
  type: z.string().optional(),
  description: z.string().optional(),
  dependencies: z.array(z.string()).optional(),
  devDependencies: z.array(z.string()).optional(),
  registryDependencies: z.array(z.string()).optional(),
  files: z
    .array(
      z.object({
        path: z.string(),
        content: z.string().optional(),
        type: z.string().optional(),
        target: z.string().optional(),
      }),
    )
    .optional(),
  cssVars: z.record(z.string(), z.unknown()).optional(),
  css: z.record(z.string(), z.unknown()).optional(),
});

export const registryIndexEntrySchema = z.object({
  name: z.string(),
  type: z.string().optional(),
  description: z.string().optional(),
  files: z.array(z.object({ path: z.string(), type: z.string().optional() })).optional(),
});

export type RegistryItem = z.infer<typeof registryItemSchema>;
export type RegistryIndexEntry = z.infer<typeof registryIndexEntrySchema>;

export function itemUrl(spec: RegistrySourceSpec, name: string): string {
  return `${spec.url.replace(/\/$/, "")}/${name}.json`;
}

export function indexUrl(spec: RegistrySourceSpec): string {
  return spec.indexUrl ?? `${spec.url.replace(/\/$/, "")}/index.json`;
}

export async function fetchItem(spec: RegistrySourceSpec, name: string): Promise<RegistryItem> {
  const url = itemUrl(spec, name);
  const parsed = registryItemSchema.safeParse(await fetchJson(url));
  if (!parsed.success)
    throw new StudioError(`${url} is not a valid registry item: ${parsed.error.issues[0]?.message}`);
  return parsed.data;
}

export async function fetchIndex(spec: RegistrySourceSpec): Promise<RegistryIndexEntry[]> {
  const url = indexUrl(spec);
  const body = await fetchJson<unknown>(url);
  const list = Array.isArray(body) ? body : (body as { items?: unknown }).items;
  const parsed = z.array(registryIndexEntrySchema).safeParse(list);
  if (!parsed.success)
    throw new StudioError(
      `${url} did not list registry items. A registry index must be an array of items, or an object with an "items" array.`,
    );
  return parsed.data;
}
