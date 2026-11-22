import { randomUUID } from "node:crypto";
import { paths } from "./config.js";
import type {
  Annotation,
  AnnotationTarget,
  CatalogComponent,
  CatalogTemplate,
  DesignSystem,
  GeneratedPage,
  Project,
  SourceSpec,
} from "./contracts.js";
import { ensurePackages } from "./dependencies.js";
import { deliverBatch } from "./delivery.js";
import { StudioError } from "./errors.js";
import { generatePage } from "./generator.js";
import { parseGherkin } from "./gherkin.js";
import { planPage } from "./planner.js";
import { buildPreview } from "./preview.js";
import { importNpmPackage } from "./sources/npm.js";
import {
  importRegistry,
  projectImportPath,
  resolveClosure,
  resolveTemplate,
  type ResolvedFile,
} from "./sources/registry.js";
import { resolveTheme } from "./sources/theme.js";
import { updateProject } from "./store.js";

/** Imports a design system into a project and selects it for generation. */
export async function importDesignSystem(
  projectId: string,
  name: string,
  spec: SourceSpec,
): Promise<{ project: Project; system: DesignSystem }> {
  const id = `${slug(name)}-${randomUUID().slice(0, 8)}`;
  let system!: DesignSystem;

  const project = await updateProject(projectId, async (current) => {
    if (spec.kind === "registry") {
      const imported = await importRegistry(id, name, spec);
      system = {
        id,
        name,
        spec,
        origin: spec.url,
        importedAt: new Date().toISOString(),
        components: imported.components,
        templates: imported.templates,
        warnings: imported.warnings,
      };
    } else {
      const imported = await importNpmPackage(id, name, spec, paths.project(projectId));
      system = {
        id,
        name,
        spec: { ...spec, version: imported.version },
        origin: `${spec.package}@${imported.version}`,
        importedAt: new Date().toISOString(),
        components: imported.components,
        templates: [],
        warnings: imported.warnings,
      };
    }

    return {
      ...current,
      systems: [...current.systems.filter((entry) => entry.name !== name), system],
      selectedSystemIds: [...new Set([...current.selectedSystemIds, system.id])],
    };
  });

  return { project, system };
}

export function selectedComponents(project: Project): CatalogComponent[] {
  return project.systems
    .filter((system) => project.selectedSystemIds.includes(system.id))
    .flatMap((system) => system.components);
}

export function selectedTemplates(project: Project): CatalogTemplate[] {
  return project.systems
    .filter((system) => project.selectedSystemIds.includes(system.id))
    .flatMap((system) => system.templates);
}

/** Catalog search across the selected systems, by name, export or capability. */
export function searchComponents(project: Project, query: string): CatalogComponent[] {
  const needle = query.trim().toLowerCase();
  const components = selectedComponents(project);
  if (!needle) return components;
  return components.filter((component) =>
    [component.name, component.title, component.description ?? "", ...component.exports, ...component.capabilities]
      .join(" ")
      .toLowerCase()
      .includes(needle),
  );
}

/**
 * Generates a page from the scenario and the selected template, then builds the
 * interactive preview. Gaps are reported with the page rather than hidden: a
 * scenario can produce a usable page and still name blocks nobody published.
 */
export async function generate(
  projectId: string,
  gherkin: string,
  templateId: string,
): Promise<{ project: Project; page: GeneratedPage }> {
  let page!: GeneratedPage;
  const saved = await updateProject(projectId, async (project) => {
    const feature = parseGherkin(gherkin);
    const scenario = feature.scenario;

    const template = selectedTemplates(project).find((candidate) => candidate.id === templateId);
    if (!template)
      throw new StudioError(
        "Select a template from one of the imported design systems before generating.",
        422,
      );
    const templateSystem = project.systems.find((system) => system.id === template.sourceId);
    if (!templateSystem || templateSystem.spec.kind !== "registry")
      throw new StudioError("Templates come from registry sources; this template's source is unavailable.", 422);

    const components = selectedComponents(project);
    const plan = planPage(scenario, components);
    const byId = new Map(components.map((component) => [component.id, component]));

    const resolved = await resolveTemplate(templateSystem.spec, template.name);
    const shellImportPath = projectImportPath(resolved.shell.path.replace(/^src\//, ""));
    const generated = generatePage({
      plan,
      components: byId,
      shellImportPath,
      shellExport: "TemplateShell",
    });

    const files: ResolvedFile[] = [resolved.shell, ...resolved.files];
    const themeItems = [...resolved.items];
    const packages = new Set([...resolved.packages, "react", "react-dom", "clsx", "tailwind-merge"]);
    const needed = plan.blocks.flatMap((block) => block.componentIds);
    for (const system of project.systems) {
      if (system.spec.kind !== "registry") continue;
      const names = system.components
        .filter((component) => needed.includes(component.id))
        .map((component) => component.name);
      if (names.length === 0) continue;
      const closure = await resolveClosure(system.spec, names);
      files.push(...closure.files);
      themeItems.push(...closure.items);
      for (const packageName of closure.packages) packages.add(packageName);
    }

    const theme = await resolveTheme(templateSystem.spec, themeItems);
    for (const packageName of theme.packages) packages.add(packageName);
    const pagePath = "src/app/page.tsx";
    files.push({ path: pagePath, content: generated.source });

    await ensurePackages(paths.project(projectId), [...packages]);
    await buildPreview(projectId, {
      files: dedupeFiles(files),
      styles: theme.css,
      entryModule: "@/app/page",
    });

    page = {
      id: project.pages[0]?.id ?? randomUUID(),
      title: plan.title,
      plan,
      templateId,
      path: pagePath,
      source: generated.source,
      generatedAt: new Date().toISOString(),
    };

    return {
      ...project,
      gherkin,
      selectedTemplateId: templateId,
      pages: [page],
    };
  });

  return { project: saved, page };
}

export async function addAnnotation(
  projectId: string,
  pageId: string,
  target: AnnotationTarget,
  note: string,
): Promise<{ project: Project; annotation: Annotation }> {
  let annotation!: Annotation;
  const saved = await updateProject(projectId, (project) => {
    const page = project.pages.find((candidate) => candidate.id === pageId);
    if (!page) throw new StudioError("Generate a page before annotating it.", 404);

    annotation = {
      id: randomUUID(),
      pageId,
      pageTitle: page.title,
      target,
      note,
      createdAt: new Date().toISOString(),
    };
    return { ...project, annotations: [...project.annotations, annotation] };
  });
  return { project: saved, annotation };
}

export async function removeAnnotation(projectId: string, annotationId: string): Promise<Project> {
  return updateProject(projectId, (project) => ({
    ...project,
    annotations: project.annotations.filter((annotation) => annotation.id !== annotationId),
  }));
}

/** Sends every queued note to the review agent as one batch. */
export async function sendQueuedAnnotations(projectId: string): Promise<Project> {
  return updateProject(projectId, async (project) => {
    const queued = project.annotations.filter((annotation) => !annotation.batchId);
    const batchId = `batch-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    const delivery = await deliverBatch(project, batchId, queued);

    return {
      ...project,
      annotations: project.annotations.map((annotation) =>
        annotation.batchId ? annotation : { ...annotation, batchId },
      ),
      batches: [
        ...project.batches,
        {
          id: batchId,
          projectId,
          createdAt: new Date().toISOString(),
          annotations: queued.map((annotation) => ({ ...annotation, batchId })),
          delivery,
        },
      ],
    };
  });
}

function dedupeFiles(files: ResolvedFile[]): ResolvedFile[] {
  const unique = new Map(files.map((file) => [file.path, file]));
  return [...unique.values()];
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "system";
}
