import { promises as fs } from "node:fs";
import path from "node:path";
import express, { type ErrorRequestHandler, type Request, type RequestHandler } from "express";
import { paths } from "./config.js";
import {
  annotationCreateSchema,
  createProjectSchema,
  generateSchema,
  selectSystemsSchema,
  selectTemplateSchema,
  sourceRequestSchema,
} from "./contracts.js";
import { StudioError } from "./errors.js";
import { defaultGherkin, presets } from "./presets.js";
import { createProject, listProjects, loadProject, updateProject } from "./store.js";
import {
  addAnnotation,
  generate,
  importDesignSystem,
  removeAnnotation,
  searchComponents,
  selectedTemplates,
  sendQueuedAnnotations,
} from "./studio.js";

function param(request: Request, name: string): string {
  const value = request.params[name];
  if (typeof value !== "string" || !value) throw new StudioError(`The request path has no ${name}.`, 404);
  return value;
}

/**
 * The preview runs imported design-system code on an opaque origin, which the
 * browser labels `null`. Refusing any browser-supplied origin that is not this
 * server's own keeps that code off the project API even if it tries to fetch.
 * Non-browser callers send no Origin and are unaffected.
 */
const rejectForeignOrigin: RequestHandler = (request, _response, next) => {
  const origin = request.get("origin");
  if (!origin) return next();

  const host = request.get("host");
  if (host && (origin === `http://${host}` || origin === `https://${host}`)) return next();

  next(new StudioError("The Studio API only answers its own pages.", 403));
};

/** Wraps an async handler so rejections reach the error middleware. */
const route =
  (handler: RequestHandler): RequestHandler =>
  (request, response, next) => {
    void Promise.resolve(handler(request, response, next)).catch(next);
  };

export type AppOptions = {
  /** Directory holding the built Studio client, when one has been built. */
  clientDist?: string;
};

export async function createApp(options: AppOptions = {}) {
  const app = express();
  app.use(express.json({ limit: "2mb" }));
  app.use("/api", rejectForeignOrigin);

  app.get("/api/presets", (_request, response) => {
    response.json({ presets, defaultGherkin });
  });

  app.get(
    "/api/projects",
    route(async (_request, response) => {
      response.json({ projects: await listProjects() });
    }),
  );

  app.post(
    "/api/projects",
    route(async (request, response) => {
      const { name } = createProjectSchema.parse(request.body);
      response.status(201).json({ project: await createProject(name) });
    }),
  );

  app.get(
    "/api/projects/:id",
    route(async (request, response) => {
      response.json({ project: await loadProject(param(request, "id")) });
    }),
  );

  app.post(
    "/api/projects/:id/systems",
    route(async (request, response) => {
      const { name, spec } = sourceRequestSchema.parse(request.body);
      const { project, system } = await importDesignSystem(param(request, "id"), name, spec);
      response.status(201).json({ project, system });
    }),
  );

  app.put(
    "/api/projects/:id/systems/selection",
    route(async (request, response) => {
      const { systemIds } = selectSystemsSchema.parse(request.body);
      const project = await updateProject(param(request, "id"), (current) => {
        const known = new Set(current.systems.map((system) => system.id));
        const unknown = systemIds.filter((id) => !known.has(id));
        if (unknown.length) throw new StudioError(`This project has not imported ${unknown.join(", ")}.`);
        return { ...current, selectedSystemIds: systemIds };
      });
      response.json({ project });
    }),
  );

  app.get(
    "/api/projects/:id/components",
    route(async (request, response) => {
      const project = await loadProject(param(request, "id"));
      const query = typeof request.query.q === "string" ? request.query.q : "";
      response.json({ components: searchComponents(project, query) });
    }),
  );

  app.get(
    "/api/projects/:id/templates",
    route(async (request, response) => {
      response.json({ templates: selectedTemplates(await loadProject(param(request, "id"))) });
    }),
  );

  app.put(
    "/api/projects/:id/template",
    route(async (request, response) => {
      const { templateId } = selectTemplateSchema.parse(request.body);
      const project = await updateProject(param(request, "id"), (current) => {
        if (!selectedTemplates(current).some((template) => template.id === templateId))
          throw new StudioError("That template is not published by a selected design system.");
        return { ...current, selectedTemplateId: templateId };
      });
      response.json({ project });
    }),
  );

  app.post(
    "/api/projects/:id/generate",
    route(async (request, response) => {
      const { gherkin, templateId } = generateSchema.parse(request.body);
      const { project, page } = await generate(param(request, "id"), gherkin, templateId);
      response.json({ project, page });
    }),
  );

  app.post(
    "/api/projects/:id/annotations",
    route(async (request, response) => {
      const { pageId, target, note } = annotationCreateSchema.parse(request.body);
      const { project, annotation } = await addAnnotation(param(request, "id"), pageId, target, note);
      response.status(201).json({ project, annotation });
    }),
  );

  app.delete(
    "/api/projects/:id/annotations/:annotationId",
    route(async (request, response) => {
      response.json({ project: await removeAnnotation(param(request, "id"), param(request, "annotationId")) });
    }),
  );

  app.post(
    "/api/projects/:id/annotations/send",
    route(async (request, response) => {
      response.json({ project: await sendQueuedAnnotations(param(request, "id")) });
    }),
  );

  app.use("/preview/:id", (request, response, next) => {
    const id = param(request, "id");
    if (!/^[A-Za-z0-9-]+$/.test(id)) return next(new StudioError("Unknown preview.", 404));
    express.static(paths.projectDist(id), { index: "index.html", fallthrough: true })(request, response, next);
  });

  const shell = options.clientDist ? await readShell(options.clientDist) : undefined;
  if (options.clientDist && shell) {
    app.use(express.static(options.clientDist));
    // Only a route falls back to the Studio shell. A request for a file that is
    // not there stays a 404, because answering an asset with HTML hides the
    // real failure behind a page that cannot run.
    app.get(/^(?!\/api|\/preview).*/, (request, response, next) => {
      if (path.extname(request.path)) return next(new StudioError("Not found.", 404));
      response.type("html").send(shell);
    });
  }

  app.use((_request, _response, next) => next(new StudioError("Not found.", 404)));

  const onError: ErrorRequestHandler = (error, _request, response, _next) => {
    if (error instanceof StudioError)
      return response.status(error.status).json({ error: error.message, details: error.details });
    if (isZodError(error))
      return response.status(400).json({ error: error.issues.map(describeIssue).join("; ") });
    const message = error instanceof Error ? error.message : String(error);
    response.status(500).json({ error: message });
  };
  app.use(onError);

  return app;
}

type ZodLike = { issues: { path: PropertyKey[]; message: string }[] };

function isZodError(error: unknown): error is ZodLike {
  return Boolean(error) && Array.isArray((error as ZodLike).issues);
}

function describeIssue(issue: { path: PropertyKey[]; message: string }): string {
  const where = issue.path.length ? `${issue.path.join(".")}: ` : "";
  return `${where}${issue.message}`;
}

async function readShell(clientDist: string): Promise<string | undefined> {
  try {
    return await fs.readFile(path.join(clientDist, "index.html"), "utf8");
  } catch {
    return undefined;
  }
}
