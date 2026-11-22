import { capabilitiesFor } from "../capabilities.js";
import type { CatalogComponent, CatalogTemplate, RegistrySourceSpec } from "../contracts.js";
import { StudioError } from "../errors.js";
import { exportedNames, extractLayout, importSpecifiers } from "../tsx.js";
import { documentExists } from "./fetcher.js";
import { fetchIndex, fetchItem, itemUrl, type RegistryItem } from "./registry-item.js";

export type ResolvedFile = {
  /** Project-relative path, kept as the registry publishes it. */
  path: string;
  content: string;
};

export type RegistryImport = {
  components: CatalogComponent[];
  templates: CatalogTemplate[];
  warnings: string[];
};

/** Kind labels shadcn-compatible registries use for their items. */
const componentTypes = new Set(["registry:ui", "registry:component", "registry:hook", "registry:lib"]);
const blockTypes = new Set(["registry:block"]);

/**
 * Reads a shadcn-compatible registry into a catalog.
 *
 * Every listed component is fetched, not just indexed, so the catalog records
 * the exports the registry actually publishes and the import path is verified
 * against the real item rather than assumed from the index.
 */
export async function importRegistry(
  sourceId: string,
  sourceName: string,
  spec: RegistrySourceSpec,
): Promise<RegistryImport> {
  const warnings: string[] = [];
  const index = await fetchIndex(spec);
  const entries = index.filter((entry) =>
    componentTypes.has(entry.type ?? "registry:ui"),
  );

  const components: CatalogComponent[] = [];
  await inBatches(entries, 8, async (entry) => {
    try {
      const item = await fetchItem(spec, entry.name);
      const file = item.files?.find((candidate) => candidate.content !== undefined);
      if (!file?.content) {
        warnings.push(`${entry.name}: the registry publishes no file content for this item.`);
        return;
      }
      const exports = exportedNames(file.content);
      components.push({
        id: `${sourceId}:${entry.name}`,
        sourceId,
        sourceName,
        name: entry.name,
        title: titleCase(entry.name),
        kind: item.type === "registry:hook" ? "hook" : "ui",
        description: item.description ?? entry.description,
        exports,
        importPath: projectImportPath(file.path),
        capabilities: capabilitiesFor(entry.name, exports),
        provenance: itemUrl(spec, entry.name),
      });
    } catch (error) {
      warnings.push(`${entry.name}: ${error instanceof StudioError ? error.message : String(error)}`);
    }
  });
  components.sort((left, right) => left.name.localeCompare(right.name));

  if (components.length === 0)
    throw new StudioError(
      "This registry published no usable components. Check that the source URL serves a shadcn-compatible registry index.",
      422,
      warnings,
    );

  const templates: CatalogTemplate[] = [];
  for (const name of new Set([...index.filter((entry) => blockTypes.has(entry.type ?? "")).map((entry) => entry.name), ...(spec.blocks ?? [])])) {
    const url = itemUrl(spec, name);
    try {
      if (!(await documentExists(url))) {
        warnings.push(`${name}: this registry does not publish a block by that name.`);
        continue;
      }
      const item = await fetchItem(spec, name);
      if (!blockTypes.has(item.type ?? "")) {
        warnings.push(`${name}: published as ${item.type ?? "an untyped item"}, not a block.`);
        continue;
      }
      const layout = extractLayout(pageFile(item).content!);
      templates.push({
        id: `${sourceId}:${name}`,
        sourceId,
        sourceName,
        name,
        title: titleCase(name),
        description: item.description,
        provenance: url,
        regions: layout.regions,
      });
    } catch (error) {
      warnings.push(`${name}: ${error instanceof StudioError ? error.message : String(error)}`);
    }
  }

  return { components, templates, warnings };
}

/**
 * Resolves the file closure of registry items: their own files, the files of
 * every registry dependency, and everything those import from the same
 * registry. npm packages the closure needs are collected alongside.
 */
export async function resolveClosure(
  spec: RegistrySourceSpec,
  names: string[],
): Promise<{ files: ResolvedFile[]; packages: string[] }> {
  const files = new Map<string, ResolvedFile>();
  const packages = new Set<string>();
  const visited = new Set<string>();
  const aliases = spec.aliases ?? {};
  const queue = [...names];

  while (queue.length) {
    const name = queue.shift()!;
    if (visited.has(name)) continue;
    visited.add(name);

    const item = await fetchItem(spec, name);
    for (const dependency of item.dependencies ?? [])
      if (!(dependency in aliases)) packages.add(stripVersionRange(dependency));
    for (const dependency of item.registryDependencies ?? []) queue.push(dependency);

    for (const file of item.files ?? []) {
      if (file.content === undefined) continue;
      const projectPath = projectFilePath(file.path);
      files.set(projectPath, { path: projectPath, content: file.content });
      for (const specifier of importSpecifiers(file.content)) {
        if (specifier in aliases) continue;
        const internal = registryNameFor(specifier);
        if (internal) queue.push(internal);
        else if (isPackageSpecifier(specifier)) packages.add(packageNameOf(specifier));
      }
    }
  }

  return { files: [...files.values()], packages: [...packages] };
}

/** The layout shell derived from a template block, with its own file closure. */
export async function resolveTemplate(
  spec: RegistrySourceSpec,
  name: string,
): Promise<{ shell: ResolvedFile; files: ResolvedFile[]; packages: string[]; regions: string[] }> {
  const item = await fetchItem(spec, name);
  const page = pageFile(item);
  const layout = extractLayout(page.content!);

  const files = new Map<string, ResolvedFile>();
  const packages = new Set<string>();
  const blockFiles = new Map(
    (item.files ?? [])
      .filter((file) => file.content !== undefined && file.path !== page.path)
      .map((file) => [
        projectImportPath(file.path),
        { path: projectFilePath(file.path), content: file.content! },
      ]),
  );

  const registryNames: string[] = [];
  const pending = [...layout.imports];
  const seen = new Set<string>();
  while (pending.length) {
    const specifier = pending.shift()!;
    if (seen.has(specifier) || specifier in (spec.aliases ?? {})) continue;
    seen.add(specifier);
    const block = blockFiles.get(specifier);
    if (block) {
      files.set(block.path, block);
      pending.push(...importSpecifiers(block.content));
      continue;
    }
    const internal = registryNameFor(specifier);
    if (internal) registryNames.push(internal);
    else if (isPackageSpecifier(specifier)) packages.add(packageNameOf(specifier));
  }

  const closure = await resolveClosure(spec, registryNames);
  for (const file of closure.files) files.set(file.path, file);
  for (const packageName of closure.packages) packages.add(packageName);

  return {
    shell: {
      path: projectFilePath(page.path).replace(/[^/]+$/, "template-shell.tsx"),
      content: layout.source,
    },
    files: [...files.values()],
    packages: [...packages],
    regions: layout.regions,
  };
}

/** Import path of the shell module a template resolves to. */
export function templateShellImportPath(pagePath: string): string {
  return projectImportPath(pagePath).replace(/[^/]+$/, "template-shell");
}

export async function templatePagePath(spec: RegistrySourceSpec, name: string): Promise<string> {
  return pageFile(await fetchItem(spec, name)).path;
}

function pageFile(item: RegistryItem) {
  const page =
    item.files?.find((file) => file.type === "registry:page" && file.content !== undefined) ??
    item.files?.find((file) => /(^|\/)page\.tsx$/.test(file.path) && file.content !== undefined);
  if (!page?.content)
    throw new StudioError(`Block "${item.name}" publishes no page file, so there is no layout to start from.`);
  return page;
}

/**
 * Registries publish file paths rooted at their own source tree. Generated
 * projects keep that layout verbatim under `src/`, so the published
 * `@/registry/...` import paths resolve without rewriting component source.
 */
export function projectFilePath(registryPath: string): string {
  return `src/${registryPath.replace(/^\.?\//, "")}`;
}

export function projectImportPath(registryPath: string): string {
  return `@/${registryPath.replace(/^\.?\//, "").replace(/\.tsx?$/, "")}`;
}

function registryNameFor(specifier: string): string | undefined {
  const match = /^@\/registry\/[^/]+\/(?:ui|hooks|lib)\/(.+)$/.exec(specifier);
  return match?.[1];
}

function isPackageSpecifier(specifier: string): boolean {
  return !specifier.startsWith(".") && !specifier.startsWith("@/");
}

function packageNameOf(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
}

function stripVersionRange(dependency: string): string {
  const at = dependency.lastIndexOf("@");
  return at > 0 ? dependency.slice(0, at) : dependency;
}

export function titleCase(name: string): string {
  return name
    .split(/[-_]/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

async function inBatches<T>(items: T[], size: number, run: (item: T) => Promise<void>): Promise<void> {
  for (let index = 0; index < items.length; index += size)
    await Promise.all(items.slice(index, index + size).map(run));
}
