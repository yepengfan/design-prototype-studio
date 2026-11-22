import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { paths } from "./config.js";
import { projectSchema, type Project } from "./contracts.js";
import { StudioError } from "./errors.js";

/** Project state is a single JSON document beside the project's generated source. */
export async function createProject(name: string): Promise<Project> {
  const project: Project = {
    id: randomUUID(),
    name,
    createdAt: new Date().toISOString(),
    systems: [],
    selectedSystemIds: [],
    gherkin: "",
    pages: [],
    annotations: [],
    batches: [],
  };
  await saveProject(project);
  return project;
}

export async function listProjects(): Promise<Project[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(paths.projects());
  } catch {
    return [];
  }
  const projects: Project[] = [];
  for (const id of entries) {
    const project = await findProject(id);
    if (project) projects.push(project);
  }
  return projects.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export async function findProject(id: string): Promise<Project | undefined> {
  try {
    const parsed = projectSchema.safeParse(JSON.parse(await fs.readFile(paths.projectFile(id), "utf8")));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export async function loadProject(id: string): Promise<Project> {
  const project = await findProject(id);
  if (!project) throw new StudioError(`No project with id ${id}.`, 404);
  return project;
}

export async function saveProject(project: Project): Promise<Project> {
  await fs.mkdir(paths.project(project.id), { recursive: true });
  await fs.writeFile(paths.projectFile(project.id), JSON.stringify(project, null, 2));
  return project;
}

/** Applies a change to a stored project and persists the result. */
export async function updateProject(
  id: string,
  change: (project: Project) => Project | Promise<Project>,
): Promise<Project> {
  return saveProject(await change(await loadProject(id)));
}
