import type {
  AnnotationTarget,
  CatalogComponent,
  CatalogTemplate,
  GeneratedPage,
  Project,
  SourceSpec,
} from "../../server/contracts.js";
import type { Preset } from "../../server/presets.js";

export type { AnnotationTarget, CatalogComponent, CatalogTemplate, GeneratedPage, Preset, Project, SourceSpec };

export class ApiError extends Error {
  constructor(
    message: string,
    readonly details: string[] = [],
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: init?.body ? { "content-type": "application/json" } : undefined,
  });
  const body = (await response.json().catch(() => ({}))) as {
    error?: string;
    details?: string[];
  } & T;
  if (!response.ok) throw new ApiError(body.error ?? response.statusText, body.details ?? []);
  return body;
}

export const api = {
  presets: () => request<{ presets: Preset[]; defaultGherkin: string }>("/api/presets"),

  listProjects: () => request<{ projects: Project[] }>("/api/projects"),

  createProject: (name: string) =>
    request<{ project: Project }>("/api/projects", {
      method: "POST",
      body: JSON.stringify({ name }),
    }),

  getProject: (id: string) => request<{ project: Project }>(`/api/projects/${id}`),

  importSystem: (id: string, name: string, spec: SourceSpec) =>
    request<{ project: Project }>(`/api/projects/${id}/systems`, {
      method: "POST",
      body: JSON.stringify({ name, spec }),
    }),

  selectSystems: (id: string, systemIds: string[]) =>
    request<{ project: Project }>(`/api/projects/${id}/systems/selection`, {
      method: "PUT",
      body: JSON.stringify({ systemIds }),
    }),

  searchComponents: (id: string, query: string) =>
    request<{ components: CatalogComponent[] }>(
      `/api/projects/${id}/components?q=${encodeURIComponent(query)}`,
    ),

  selectTemplate: (id: string, templateId: string) =>
    request<{ project: Project }>(`/api/projects/${id}/template`, {
      method: "PUT",
      body: JSON.stringify({ templateId }),
    }),

  generate: (id: string, gherkin: string, templateId: string) =>
    request<{ project: Project; page: GeneratedPage }>(`/api/projects/${id}/generate`, {
      method: "POST",
      body: JSON.stringify({ gherkin, templateId }),
    }),

  addAnnotation: (id: string, pageId: string, target: AnnotationTarget, note: string, generatedAt: string) =>
    request<{ project: Project }>(`/api/projects/${id}/annotations`, {
      method: "POST",
      body: JSON.stringify({ pageId, target, note, generatedAt }),
    }),

  removeAnnotation: (id: string, annotationId: string) =>
    request<{ project: Project }>(`/api/projects/${id}/annotations/${annotationId}`, {
      method: "DELETE",
    }),

  sendAnnotations: (id: string) =>
    request<{ project: Project }>(`/api/projects/${id}/annotations/send`, { method: "POST" }),
};
