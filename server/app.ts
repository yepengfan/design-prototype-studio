import express from "express";
import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import { promises as fs } from "node:fs";
import { z } from "zod";
import { ProjectStore } from "./core/store.js";
import { Previews } from "./core/preview.js";
import { blankProject, synchronizeRuntime, replaceLibraryStyles } from "./core/project.js";
import { StudioError, filesSchema, type Run } from "./core/contracts.js";
import {
  parseRequirements,
  markdownRequirements,
} from "./core/requirements.js";
import { anchors, editSource, type Edit } from "./core/source.js";
import { digest, safeRelative, atomicJSON } from "./core/files.js";
import {
  installProject,
  inspectLibrary,
  readLibraryTemplates,
  packageIdentity,
  referencedComponentPackages,
} from "./core/libraries.js";
import { exportArchive, inspectImport, readArchive } from "./core/archive.js";
import { LocalAI } from "./core/ai.js";
import {
  prepareChange,
  rebaseProposal,
  differences,
  materializeProposal,
} from "./core/changes.js";
import { Annotations } from "./core/annotations.js";
import { templateInput } from "./core/templates.js";
import { checkQuality } from "./core/quality.js";
import { orderedScenarioSteps } from "./templates/scenario-order.js";

export async function createApp(options: {
  root: string;
  origin: string;
  ai?: Pick<LocalAI, "generate" | "cancel" | "close">;
}) {
  const app = express();
  const installationAbort = new AbortController();
  const installations = new Set<Promise<string>>();
  const install = async (...args: Parameters<typeof installProject>) => {
    if (installationAbort.signal.aborted) throw new StudioError("Studio is closing.", 409);
    const job = installProject(args[0], args[1], args[2], args[3], installationAbort.signal);
    installations.add(job);
    try { return await job; }
    finally { installations.delete(job); }
  };
  const secret = randomBytes(32).toString("hex");
  const store = new ProjectStore(path.join(options.root, "projects"));
  const previews = new Previews(
    path.join(options.root, "previews"),
    options.origin,
  );
  const ai = options.ai ?? new LocalAI(path.join(options.root, "ai"));
  const annotations = new Annotations(store, (s) => previews.verify(s));
  await store.recoverRuns();
  app.disable("x-powered-by");
  app.use("/api", (req, res, next) => {
    if (req.headers.host !== new URL(options.origin).host)
      return res.status(403).json({ error: "Unrecognized local host." });
    if (req.headers.origin && req.headers.origin !== options.origin)
      return res
        .status(403)
        .json({ error: "Open Studio from its local address." });
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (req.path !== "/session" && req.headers["x-studio-session"] !== secret)
      return res
        .status(403)
        .json({ error: "Reload Studio to renew this local session." });
    next();
  });
  app.use(express.json({ limit: "45mb" }));
  app.get("/api/session", (_req, res) => res.json({ secret }));
  app.get("/api/projects", async (_req, res) => res.json(await store.list()));
  app.post("/api/projects", async (req, res) => {
    const { name } = z
      .object({ name: z.string().trim().min(1).max(120) })
      .parse(req.body);
    const p = blankProject(name);
    p.files["package-lock.json"] = await install(
      path.join(options.root, "admissions", randomUUID()),
      p.files,
    );
    res.json(await store.create(p.manifest, p.files));
  });
  app.get("/api/projects/:id", async (req, res) => {
    const data = await store.get(req.params.id);
    const history = await store.history(req.params.id);
    const selected = templateInput(
      data.snapshot,
      data.state.templateReconciliation,
    );
    const scope = parseRequirements(selected.files, selected.manifest.scope);
    const outline = data.snapshot.manifest.pages.map((p) => ({
      ...p,
      hash: digest(data.snapshot.files[p.file]),
      nodes: anchors(
        data.snapshot.files[p.file],
        data.snapshot.manifest.libraries.flatMap((l) => l.components),
      ),
    }));
    res.json({ ...data, history, scope, outline });
  });
  app.post("/api/projects/:id/requirements", async (req, res) => {
    const body = z
      .object({
        base: z.string(),
        files: filesSchema,
        scope: z.array(z.string()),
        confirmMarkdown: z.boolean().optional(),
      })
      .parse(req.body);
    res.json(
      await store.exclusive(req.params.id, async () => {
        const { snapshot, state } = await store.get(req.params.id);
        if (snapshot.id !== body.base)
          throw new StudioError(
            "The project changed. Review its current requirements before saving.",
            409,
          );
        const added: Record<string, string> = {};
        const convertedScope: Record<string, string[]> = {};
        for (const [file, content] of Object.entries(body.files)) {
          safeRelative(file);
          if (file.endsWith(".md")) {
            const converted = markdownRequirements(content);
            if (!body.confirmMarkdown)
              throw new StudioError(
                converted.warning,
                422,
                converted.proposals,
              );
            convertedScope[file] = converted.proposals.map((_, index) =>
              file.replace(/\.md$/, `-${index + 1}.feature`),
            );
            converted.proposals.forEach((text, i) => {
              added[file.replace(/\.md$/, `-${i + 1}.feature`)] = text;
            });
          } else if (file.endsWith(".feature")) added[file] = content;
          else
            throw new StudioError(
              "Choose .feature requirements or Markdown containing Gherkin.",
            );
        }
        const scope = body.scope.flatMap(
          (selected) => convertedScope[selected] ?? [selected],
        );
        if (state.templateReconciliation) {
          const requirements = {
            ...state.templateReconciliation.requirements,
            ...added,
          };
          if (!parseRequirements(requirements, scope).scenarios.length)
            throw new StudioError("Select at least one scenario.");
          state.templateReconciliation = { requirements, scope: scope };
          await store.saveState(state);
          return store.get(req.params.id);
        }
        if (
          snapshot.manifest.generationState === "generated" &&
          Object.entries(added).some(
            ([file, content]) =>
              file in snapshot.files && content !== snapshot.files[file],
          )
        )
          throw new StudioError(
            "These requirements already have an implementation. Describe the business change in a prompt so the requirements and page can be reviewed and updated together.",
          );
        const files = { ...snapshot.files, ...added };
        const manifest = { ...snapshot.manifest, scope: scope };
        const parsedScope = parseRequirements(files, manifest.scope);
        if (!parsedScope.scenarios.length)
          throw new StudioError(
            "Select at least one scenario in the working scope.",
          );
        return store.commit(
          req.params.id,
          body.base,
          synchronizeRuntime(files, manifest),
          manifest,
          "Choose requirements scope",
        );
      }),
    );
  });
  app.post("/api/projects/:id/edit", async (req, res) => {
    const body = req.body as { base: string; page: string; edit: Edit };
    res.json(
      await store.exclusive(req.params.id, async () => {
        const { snapshot, state } = await store.get(req.params.id);
        if (snapshot.id !== body.base)
          throw new StudioError(
            "The page changed. Select its current component before editing.",
            409,
          );
        if (state.templateReconciliation)
          throw new StudioError(
            "Adapt and review this template against the selected requirements before visual editing.",
          );
        if (
          !parseRequirements(snapshot.files, snapshot.manifest.scope).scenarios
            .length
        )
          throw new StudioError("Choose Gherkin requirements before editing.");
        const page = snapshot.manifest.pages.find((p) => p.id === body.page);
        if (!page) throw new StudioError("Page not found.");
        const edit = { ...body.edit, confirmedBusiness: false };
        if (edit.operation === "text") {
          const target = anchors(
            snapshot.files[page.file],
            snapshot.manifest.libraries.flatMap(
              (library) => library.components,
            ),
          ).find((node) => node.id === edit.anchor);
          const previous = target?.text?.trim();
          const steps = parseRequirements(
            snapshot.files,
            snapshot.manifest.scope,
          ).scenarios.flatMap((scenario) => scenario.steps);
          if (
            previous &&
            String(edit.value) !== target?.text &&
            (["alert", "status"].includes(String(target?.props.role)) ||
              steps.some((step) =>
                step.text.toLowerCase().includes(previous.toLowerCase()),
              ))
          )
            throw new StudioError(
              "This text describes a selected business requirement or operation result. Use a prompt to review the matching Gherkin difference before changing it.",
              422,
            );
        }
        const source = editSource(
          snapshot.files[page.file],
          edit,
          snapshot.manifest.libraries.flatMap((l) => l.components),
          { files: snapshot.files, file: page.file, provider: snapshot.manifest.provider },
        );
        const files = { ...snapshot.files, [page.file]: source };
        const candidate = await store.persist(req.params.id, {
          files,
          manifest: snapshot.manifest,
          label: "Visual edit",
          parent: body.base,
        });
        await previews.verify(candidate);
        const before = anchors(
          snapshot.files[page.file],
          snapshot.manifest.libraries.flatMap((l) => l.components),
        ).find((node) => node.id === edit.anchor);
        const result = await store.commit(
          req.params.id,
          body.base,
          files,
          snapshot.manifest,
          "Visual edit",
        );
        const after = anchors(
          source,
          snapshot.manifest.libraries.flatMap((l) => l.components),
        );
        let selection =
          before &&
          after.find(
            (node) =>
              node.path === before.path &&
              (edit.operation === "wrap" || node.tag === before.tag),
          )?.id;
        if (edit.operation === "move" && before) {
          const text = snapshot.files[page.file].slice(
            before.start,
            before.end,
          );
          const matches = after.filter(
            (node) => source.slice(node.start, node.end) === text,
          );
          selection = matches.length === 1 ? matches[0].id : undefined;
        }
        return { ...result, selection };
      }),
    );
  });
  app.post("/api/projects/:id/library", async (req, res) => {
    const body = z
      .object({
        base: z.string(),
        name: z.string(),
        version: z.string(),
        registry: z.string().optional(),
        trust: z.literal(true),
        apply: z.boolean().default(false),
        confirmation: z.string().optional(),
      })
      .parse(req.body);
    packageIdentity(body.name, body.version);
    const { snapshot } = await store.get(req.params.id);
    if (snapshot.id !== body.base)
      throw new StudioError(
        "Project changed. Preview the library impact again.",
        409,
      );
    const files = { ...snapshot.files };
    const pkg = JSON.parse(files["package.json"]);
    pkg.dependencies = { ...pkg.dependencies, [body.name]: body.version };
    files["package.json"] = JSON.stringify(pkg, null, 2);
    const root = path.join(options.root, "admissions", randomUUID());
    const libraries = snapshot.manifest.libraries.filter(
      (l) => l.name !== body.name,
    );
    const registries = [
      ...libraries,
      { name: body.name, registry: body.registry },
    ];
    files["package-lock.json"] = await install(
      root,
      files,
      registries,
      true,
    );
    const admitted = await inspectLibrary(root, body.name, body.version);
    const publishedTemplates = await readLibraryTemplates(
      root,
      body.name,
      body.version,
      admitted.templates,
    );
    const previousLibrary = snapshot.manifest.libraries.find((library) => library.name === body.name);
    const retainedStyles = new Set(libraries.flatMap((library) => library.components.flatMap((component) => component.styles)));
    const previousStyles = new Set(previousLibrary?.components.flatMap((component) => component.styles) ?? []);
    const manifest = {
      ...snapshot.manifest,
      libraries: [
        ...libraries,
        {
          name: body.name,
          version: body.version,
          registry: body.registry,
          components: admitted.components,
        },
      ],
      styles: [
        ...new Set([
          ...snapshot.manifest.styles.filter((style) => !previousStyles.has(style) || retainedStyles.has(style)),
          ...admitted.components.flatMap((c) => c.styles),
        ]),
      ],
    };
    const candidate = await store.persist(req.params.id, {
      files: synchronizeRuntime(replaceLibraryStyles(files,
        [...previousStyles].filter((style) => !manifest.styles.includes(style)),
        [...new Set(admitted.components.flatMap((component) => component.styles))],
      ), manifest),
      manifest,
      label: `Library ${body.name}@${body.version}`,
      parent: body.base,
    });
    await previews.verify(candidate);
    const libraryPreview = await previews.verifyComponents(
      candidate,
      admitted.components,
    );
    const upgrading = !!previousLibrary && previousLibrary.version !== body.version;
    const confirmation = digest({ files: candidate.files, manifest });
    const quality = upgrading
      ? await checkQuality(candidate, previews, path.join(root, "screenshots"), { project: true })
      : undefined;
    if (!body.apply) {
      const pages = upgrading ? await Promise.all(manifest.pages.map(async (page) => ({
        ...await previews.start(candidate, undefined, undefined, page.id), title: page.title,
      }))) : [];
      return res.json({
        preview: libraryPreview,
        pages,
        quality,
        confirmation,
        components: admitted.components,
        warnings: [...admitted.warnings, ...publishedTemplates.warnings],
        templates: publishedTemplates.templates.map((t) => ({
          id: t.id,
          name: t.name,
        })),
        previous: snapshot.manifest.libraries.find((l) => l.name === body.name)
          ?.version,
        next: body.version,
        message:
          "Review these components, current pages and scenario results, then import this exact release.",
      });
    }
    previews.stop(libraryPreview.id);
    if (upgrading && body.confirmation !== confirmation)
      throw new StudioError("Preview and confirm this exact upgrade against the current project first.", 409);
    if (quality && !quality.ready)
      throw new StudioError("The upgrade failed reviewed project scenarios. The current release was kept.", 422, quality.results);
    for (const template of publishedTemplates.templates)
      await atomicJSON(
        path.join(options.root, "templates", template.id + ".json"),
        template,
      );
    res.json(
      await store.exclusive(req.params.id, () =>
        store.commit(
          req.params.id,
          body.base,
          candidate.files,
          manifest,
          `Import ${body.name}@${body.version}`,
        ),
      ),
    );
  });
  app.post("/api/projects/:id/preview", async (req, res) => {
    const { snapshot } = await store.get(req.params.id);
    let component;
    if (req.body.component) {
      const c = snapshot.manifest.libraries
        .flatMap((l) => l.components)
        .find(
          (c) =>
            c.package === req.body.component.package &&
            c.export === req.body.component.export,
        );
      if (!c) throw new StudioError("Component is not admitted.");
      const example = c.examples[Number(req.body.example) || 0];
      if (!example) throw new StudioError("Example not found.");
      component = {
        package: c.package,
        export: c.export,
        ...example,
        styles: c.styles,
        provider: c.provider,
      };
    }
    res.json(
      await previews.start(
        snapshot,
        req.body.scenario,
        component,
        req.body.page,
      ),
    );
  });
  app.delete("/api/previews/:id", (req, res) => {
    previews.stop(req.params.id);
    res.json({ stopped: true });
  });
  app.post("/api/projects/:id/history", async (req, res) => {
    const body = z
      .object({
        action: z.enum(["undo", "redo", "restore", "save"]),
        name: z.string().optional(),
        revision: z.string().optional(),
      })
      .parse(req.body);
    if (body.action === "save")
      return res.json(
        await store.exclusive(req.params.id, async () => {
          const { state } = await store.get(req.params.id);
          if (!body.name?.trim())
            throw new StudioError("Name this saved version.");
          state.versions.push({ name: body.name, snapshot: state.head });
          await store.saveState(state);
          return state;
        }),
      );
    res.json(
      await store.navigate(
        req.params.id,
        body.action,
        async (saved) => {
          const { snapshot: current } = await store.get(req.params.id);
          if (body.action !== "restore" && JSON.stringify(saved.manifest.libraries) === JSON.stringify(current.manifest.libraries)) {
            await previews.verify(saved);
            return;
          }
          const report = await checkQuality(saved, previews, path.join(options.root, "quality", saved.id), { project: true });
          if (!report.ready) throw new StudioError("The saved revision failed project checks. The current revision was kept. " + report.results.flatMap((result) => result.failures).join("; "), 422, report.results);
        },
        body.revision,
      ),
    );
  });
  app.post("/api/projects/:id/annotations", async (req, res) =>
    res.json(
      await annotations.draft(
        req.params.id,
        z
          .object({
            page: z.string(),
            target: z.string(),
            text: z.string().max(10000),
          })
          .parse(req.body),
      ),
    ),
  );
  app.post(
    "/api/projects/:id/annotations/:annotation/revise",
    async (req, res) =>
      res.json(
        await annotations.revise(
          req.params.id,
          req.params.annotation,
          z
            .object({
              base: z.string(),
              text: z.string().max(10000),
              page: z.string(),
              target: z.string(),
            })
            .parse(req.body),
        ),
      ),
  );
  app.post("/api/projects/:id/annotations/approve", async (req, res) =>
    res.json(
      await annotations.approve(
        req.params.id,
        z.array(z.string()).parse(req.body.ids),
      ),
    ),
  );
  app.post("/api/projects/:id/annotations/undo", async (req, res) =>
    res.json(
      await annotations.undo(
        req.params.id,
        req.body.id,
        req.body.includeDependents === true,
        req.body.base,
      ),
    ),
  );
  app.post("/api/projects/:id/annotations/submit", async (req, res) => {
    const adapter = z.enum(["codex", "cursor"]).parse(req.body.adapter);
    const jobs = await store.exclusive(req.params.id, async () => {
      const { state, snapshot } = await store.get(req.params.id);
      if (state.runs.some((r) => ["queued", "running"].includes(r.status)))
        throw new StudioError(
          "Wait for the current batch or cancel it before submitting another.",
          409,
        );
      const approved = state.annotations.filter((a) => a.status === "approved");
      if (!approved.length)
        throw new StudioError(
          "Review and approve your draft annotations first.",
        );
      const jobs: Run[] = [];
      for (const annotation of approved) {
        const { page, node: target } = await annotations.target(
          req.params.id,
          snapshot,
          annotation,
        );
        const job: Run = {
          id: randomUUID(),
          adapter,
          base: snapshot.id,
          status: "queued",
          events: [],
          annotation: annotation.id,
          page: annotation.page,
          annotationText: annotation.text,
          prompt: `Apply only this approved annotation on ${target ? `${page!.title}: ${target.component?.name ?? target.tag}, source ${snapshot.files[page.file].slice(target.start, target.end)}` : "the current page"}: ${annotation.text}. Preserve all accepted independent edits. Diagnose shared behavior or requirement dependencies instead of overwriting them.`,
        };
        jobs.push(job);
        state.runs.push(job);
        annotation.run = job.id;
        annotation.status = "processing";
      }
      await store.saveState(state);
      return jobs;
    });
    res.status(202).json({ jobs });
    void (async () => {
      for (const job of jobs) await execute(req.params.id, job);
    })().catch(() => {});
  });
  app.post("/api/projects/:id/generate", async (req, res) => {
    const body = z
      .object({
        adapter: z.enum(["codex", "cursor"]),
        prompt: z.string().trim().min(1).max(20000),
        annotation: z.string().optional(),
        page: z.string().optional(),
      })
      .parse(req.body);
    const run = await store.exclusive(req.params.id, async () => {
      const { state, snapshot } = await store.get(req.params.id);
      if (
        !parseRequirements(snapshot.files, snapshot.manifest.scope).scenarios
          .length
      )
        throw new StudioError("Choose the working requirements scope first.");
      if (state.runs.some((r) => ["queued", "running"].includes(r.status)))
        throw new StudioError(
          "A request is already running. Wait or cancel it first.",
          409,
        );
      const annotation =
        body.annotation &&
        state.annotations.find((a) => a.id === body.annotation);
      if (body.annotation && (!annotation || annotation.status !== "approved"))
        throw new StudioError(
          "Review and approve the annotation batch before submitting.",
        );
      const location = annotation
        ? await annotations.target(req.params.id, snapshot, annotation)
        : undefined;
      const targetPage =
        location?.page ??
        (body.page
          ? snapshot.manifest.pages.find((page) => page.id === body.page)
          : snapshot.manifest.pages[0]);
      if (!targetPage)
        throw new StudioError(
          "Select a current page before requesting an edit.",
          422,
        );
      const run: Run = {
        id: randomUUID(),
        page: targetPage.id,
        adapter: body.adapter,
        prompt:
          location && annotation
            ? `Apply only this approved annotation on ${location.page.title}: ${location.node ? `${location.node.component?.name ?? location.node.tag}, source ${snapshot.files[location.page.file].slice(location.node.start, location.node.end)}` : "whole page"}: ${annotation.text}. Preserve accepted independent work.`
            : body.prompt,
        base: snapshot.id,
        events: [],
        status: "queued",
        annotation: body.annotation,
        annotationText: annotation ? annotation.text : undefined,
      };
      state.runs.push(run);
      if (annotation) {
        annotation.status = "processing";
        annotation.run = run.id;
      }
      await store.saveState(state);
      return run;
    });
    res.status(202).json(run);
    void execute(req.params.id, run).catch(() => {});
  });
  async function execute(project: string, run: Run) {
    const update = async (event: string, session?: string, turn?: string) =>
      store.exclusive(project, async () => {
        const { state } = await store.get(project);
        const current = state.runs.find((r) => r.id === run.id)!;
        if (current.status === "cancelled") return;
        current.status = "running";
        if (current.events.join("").length < 1_000_000)
          current.events.push(event);
        if (session) current.session = session;
        if (turn) current.turn = turn;
        await store.saveState(state);
      });
    try {
      if (
        (await store.get(project)).state.runs.find((r) => r.id === run.id)
          ?.status === "cancelled"
      )
        return;
      await update("Starting local tool");
      const snapshot = await store.snapshot(project, run.base);
      const pending = (await store.get(project)).state.templateReconciliation;
      const selected = templateInput(snapshot, pending);
      const currentPage = snapshot.manifest.pages.find(
        (page) => page.id === run.page,
      );
      const currentPrompt = currentPage
        ? `Current designer page: ${currentPage.title} (${currentPage.file}). Apply current-page edits here. Generate additional pages only when the selected requirements require them; preserve unrelated pages and do not invent connections. ${run.prompt}`
        : run.prompt;
      const request = pending
        ? {
            ...run,
            prompt: `Adapt the template to ONLY these newly selected requirements. Its prior requirements are context for conflicts, not additional scope: ${JSON.stringify(parseRequirements(snapshot.files, snapshot.manifest.scope))}. Propose source and requirements together and ask about unclear business adjustments. ${currentPrompt}`,
          }
        : { ...run, prompt: currentPrompt };
      let proposal = await ai.generate(request, selected, update);
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          if (!["gap", "clarification"].includes(proposal.kind)) {
            const change = prepareChange(snapshot, proposal, pending?.scope, {
              repair: run.repair,
              page: run.page,
            });
            const candidate = await store.persist(project, {
              parent: run.base,
              label: proposal.summary,
              files: change.files,
              manifest: change.manifest,
            });
            await previews.verify(candidate);
            if (change.behavior || run.repair)
              await verifyScenarioCandidate(project, candidate, run.repair);
          }
          break;
        } catch (error) {
          if (
            attempt ||
            (await store.get(project)).state.runs.find((r) => r.id === run.id)
              ?.status === "cancelled"
          )
            throw error;
          await update(
            "Checking a corrected proposal; accepted work remains saved",
          );
          const diagnostic =
            error instanceof StudioError
              ? { message: error.message, detail: error.detail }
              : { message: "The proposed source failed validation." };
          proposal = await ai.generate(
            {
              ...request,
              prompt: `${request.prompt}\nYour staged proposal failed validation. Make one bounded correction without changing unrelated accepted work, inventing controls, or guessing business facts. Return a gap or clarification if a library capability or business fact is missing. Validation: ${JSON.stringify(diagnostic)}. Previous proposed changes: ${JSON.stringify(differences(snapshot.files, materializeProposal(snapshot, proposal)))}`,
            },
            selected,
            update,
          );
        }
      }
      await store.exclusive(project, async () => {
        const { state } = await store.get(project);
        const r = state.runs.find((r) => r.id === run.id)!;
        if (r.status !== "cancelled") {
          r.status = "review";
          r.proposal = proposal;
        }
        const a = state.annotations.find((a) => a.id === run.annotation);
        if (a) a.status = "pending";
        await store.saveState(state);
      });
    } catch (e) {
      await store.exclusive(project, async () => {
        const { state } = await store.get(project);
        const r = state.runs.find((r) => r.id === run.id)!;
        if (r.status !== "cancelled") {
          r.status = "failed";
          r.error =
            e instanceof Error
              ? e.message
              : "The request failed. Accepted work is unchanged.";
        }
        const a = state.annotations.find((a) => a.id === run.annotation);
        if (a) {
          a.status = r.status === "cancelled" ? "pending" : "failed";
          a.message =
            r.status === "cancelled"
              ? "Processing cancelled. The annotation is preserved for another attempt."
              : r.error;
        }
        await store.saveState(state);
      });
    }
  }
  app.post("/api/projects/:id/runs/:run/cancel", async (req, res) => {
    await store.exclusive(req.params.id, async () => {
      const { state } = await store.get(req.params.id);
      const run = state.runs.find((r) => r.id === req.params.run);
      if (!run) throw new StudioError("Request not found.");
      run.status = "cancelled";
      const annotation = state.annotations.find(
        (annotation) => annotation.id === run.annotation,
      );
      if (annotation) {
        annotation.status = "pending";
        annotation.message =
          "Processing cancelled. The annotation is preserved for another attempt.";
      }
      await store.saveState(state);
    });
    await ai.cancel(req.params.run);
    res.json({ cancelled: true });
  });
  app.get("/api/projects/:id/runs/:run/diff", async (req, res) => {
    const { state, snapshot } = await store.get(req.params.id);
    const run = state.runs.find((r) => r.id === req.params.run);
    if (!run?.proposal) throw new StudioError("The proposal is not ready.");
    if (run.appliedBase && run.appliedRevision) {
      const before = await store.snapshot(req.params.id, run.appliedBase);
      const after = await store.snapshot(req.params.id, run.appliedRevision);
      const diff = differences(before.files, after.files);
      return res.json({
        id: run.id,
        base: before.id,
        files: after.files,
        manifest: after.manifest,
        diff,
        requirementsDiff: diff.filter((d) => d.file.endsWith(".feature")),
        requiresConfirmation: false,
        summary: run.proposal.summary,
        hash: digest(after.files),
      });
    }
    const change = prepareChange(
      snapshot,
      rebaseProposal(
        await store.snapshot(req.params.id, run.base),
        snapshot,
        run.proposal,
      ),
      state.templateReconciliation?.scope,
      { repair: run.repair, page: run.page },
    );
    res.json({
      ...change,
      ...(await annotations.impact(
        req.params.id,
        snapshot,
        state,
        change.files,
        run.proposal,
      )),
    });
  });
  app.post("/api/projects/:id/runs/:run/preview", async (req, res) => {
    const { state, snapshot } = await store.get(req.params.id);
    const run = state.runs.find((r) => r.id === req.params.run);
    if (run?.appliedRevision) {
      const applied = await store.snapshot(req.params.id, run.appliedRevision);
      const scenario =
        !run.page ||
        applied.manifest.scenarios.find(
          (binding) => binding.scenario === req.body.scenario,
        )?.page === run.page
          ? req.body.scenario
          : undefined;
      return res.json(
        await previews.start(applied, scenario, undefined, run.page),
      );
    }
    if (!run?.proposal || run.status !== "review")
      throw new StudioError("Choose a pending result before previewing.");
    const change = prepareChange(
      snapshot,
      rebaseProposal(
        await store.snapshot(req.params.id, run.base),
        snapshot,
        run.proposal,
      ),
      state.templateReconciliation?.scope,
      { repair: run.repair, page: run.page },
    );
    const candidate = await store.persist(req.params.id, {
      files: change.files,
      manifest: change.manifest,
      label: change.summary,
      parent: snapshot.id,
    });
    await previews.verify(candidate);
    const scenario =
      !run.page ||
      candidate.manifest.scenarios.find(
        (binding) => binding.scenario === req.body.scenario,
      )?.page === run.page
        ? req.body.scenario
        : undefined;
    res.json(await previews.start(candidate, scenario, undefined, run.page));
  });
  app.post("/api/projects/:id/runs/:run/apply", async (req, res) => {
    res.json(
      await store.exclusive(req.params.id, async () => {
        const { state, snapshot } = await store.get(req.params.id);
        const run = state.runs.find((r) => r.id === req.params.run);
        if (!run?.proposal || run.status !== "review")
          throw new StudioError("Choose a validated pending proposal.");
        if (run.repair && run.base !== snapshot.id)
          throw new StudioError(
            "Accepted work changed after these repair checks. Check delivery again from the current page.",
            409,
          );
        const original = await store.snapshot(req.params.id, run.base);
        const change = prepareChange(
          snapshot,
          rebaseProposal(original, snapshot, run.proposal),
          state.templateReconciliation?.scope,
          { repair: run.repair, page: run.page },
        );
        if (
          change.requiresConfirmation &&
          req.body.confirmRequirements !== change.hash
        )
          throw new StudioError(
            "Review and confirm the corresponding Gherkin difference before applying.",
            422,
          );
        const impact = await annotations.impact(
          req.params.id,
          snapshot,
          state,
          change.files,
          run.proposal,
        );
        if (
          impact.affectedAcceptedResults.length &&
          req.body.confirmAcceptedResults !== impact.acceptedResultsConfirmation
        )
          throw new StudioError(
            "This rework affects accepted annotation results. Review the listed results and explicitly choose whether to replace them or leave this proposal pending.",
            409,
            impact.affectedAcceptedResults,
          );
        const replaced = new Set(
          impact.affectedAcceptedResults.map((result) => result.id),
        );
        const activeResults = (snapshot.activeAnnotationResults ?? []).filter(
          (id) => !replaced.has(id),
        );
        const candidate = await store.persist(req.params.id, {
          files: change.files,
          manifest: change.manifest,
          label: change.summary,
          parent: snapshot.id,
          activeAnnotationResults: run.annotation
            ? [...activeResults, run.id]
            : activeResults,
        });
        await previews.verify(candidate);
        if (change.behavior || run.repair)
          await verifyScenarioCandidate(req.params.id, candidate, run.repair);
        for (const note of state.annotations)
          if (
            note.status === "accepted" &&
            !candidate.activeAnnotationResults?.some(
              (id) =>
                state.runs.find((result) => result.id === id)?.annotation ===
                note.id,
            )
          ) {
            note.status = "pending";
            note.message =
              "A reviewed rework replaced this result. Its annotation is preserved for further adjustment.";
          }
        run.appliedBase = snapshot.id;
        run.appliedRevision = candidate.id;
        state.head = candidate.id;
        state.redo = [];
        delete state.templateReconciliation;
        run.status = "applied";
        const annotation = state.annotations.find(
          (a) => a.id === run.annotation,
        );
        if (annotation) {
          annotation.before = snapshot.files;
          annotation.after = candidate.files;
          annotation.status = "accepted";
        }
        await store.saveState(state);
        return store.get(req.params.id);
      }),
    );
  });
  app.get("/api/projects/:id/stories", async (req, res) => {
    const { snapshot } = await store.get(req.params.id);
    await previews.verify(snapshot, true);
    const book = await previews.startStorybook(snapshot);
    try {
      res.json(
        book.stories.map((story) => ({
          story: story.importPath.replace(/^\.\//, "") + "#" + story.exportName,
          name: story.exportName,
        })),
      );
    } finally {
      previews.stop(book.id);
    }
  });
  app.post("/api/projects/:id/scenarios/:scenario/map", async (req, res) => {
    const body = z
      .object({ base: z.string(), story: z.string(), page: z.string() })
      .parse(req.body);
    res.json(
      await store.exclusive(req.params.id, async () => {
        const { snapshot } = await store.get(req.params.id);
        if (snapshot.id !== body.base)
          throw new StudioError(
            "The page changed. Review the current scenario mapping again.",
            409,
          );
        if (
          !parseRequirements(
            snapshot.files,
            snapshot.manifest.scope,
          ).scenarios.some((scenario) => scenario.id === req.params.scenario) ||
          !snapshot.manifest.pages.some((page) => page.id === body.page)
        )
          throw new StudioError("Choose a current requirement and page.");
        await previews.verify(snapshot, true);
        const book = await previews.startStorybook(snapshot);
        try {
          if (
            !book.stories.some(
              (story) =>
                story.importPath.replace(/^\.\//, "") +
                  "#" +
                  story.exportName ===
                body.story,
            )
          )
            throw new StudioError(
              "Choose an existing original Storybook story.",
            );
        } finally {
          previews.stop(book.id);
        }
        const manifest = structuredClone(snapshot.manifest);
        manifest.scenarios = manifest.scenarios.filter(
          (binding) => binding.scenario !== req.params.scenario,
        );
        manifest.scenarios.push({
          scenario: req.params.scenario,
          page: body.page,
          story: body.story,
          fixture: body.story.split("#")[0],
          accepted: false,
          steps: [],
        });
        return store.commit(
          req.params.id,
          snapshot.id,
          synchronizeRuntime(snapshot.files, manifest),
          manifest,
          "Map requirement to original scenario story",
        );
      }),
    );
  });
  app.post("/api/projects/:id/scenarios/:scenario/review", async (req, res) => {
    res.json(
      await store.exclusive(req.params.id, async () => {
        const { snapshot } = await store.get(req.params.id);
        if (req.body.base !== snapshot.id)
          throw new StudioError(
            "The page changed. Review the current scenario checks.",
            409,
          );
        const manifest = structuredClone(snapshot.manifest);
        const binding = manifest.scenarios.find(
          (b) => b.scenario === req.params.scenario,
        );
        const scenario = parseRequirements(
          snapshot.files,
          manifest.scope,
        ).scenarios.find((s) => s.id === req.params.scenario);
        if (!binding || !scenario)
          throw new StudioError(
            "This scenario needs an implementation and test plan before review.",
          );
        try { binding.steps = orderedScenarioSteps(scenario.steps.map((step) => step.id), binding.steps); }
        catch (error) { throw new StudioError(error instanceof Error ? error.message : String(error), 422); }
        binding.accepted = req.body.accept === true;
        return store.commit(
          req.params.id,
          snapshot.id,
          synchronizeRuntime(snapshot.files, manifest),
          manifest,
          "Review scenario checks",
        );
      }),
    );
  });
  async function verifyScenarioCandidate(
    _project: string,
    snapshot: import("./core/contracts.js").Snapshot,
    repair = false,
  ) {
    const root = path.join(options.root, "quality", snapshot.id);
    await fs.mkdir(root, { recursive: true });
    const report = await checkQuality(snapshot, previews, root, {
      requireReviewed: repair,
    });
    await atomicJSON(path.join(root, "candidate-report.json"), report);
    if (!report.ready)
      throw new StudioError(
        "The staged implementation does not yet satisfy its scenario checks. Accepted work is unchanged.",
        422,
        report.results,
      );
  }
  app.post("/api/projects/:id/quality", async (req, res) => {
    const { snapshot, state } = await store.get(req.params.id);
    if (state.templateReconciliation)
      throw new StudioError(
        "Adapt and review the template before checking delivery.",
      );
    const root = path.join(options.root, "quality", snapshot.id);
    await fs.mkdir(root, { recursive: true });
    const report = await checkQuality(snapshot, previews, root);
    await atomicJSON(path.join(root, "report.json"), report);
    if ((await store.get(req.params.id)).snapshot.id !== snapshot.id)
      throw new StudioError(
        "The page changed during these checks. Run delivery checks on the current page.",
        409,
      );
    const scope = parseRequirements(snapshot.files, snapshot.manifest.scope);
    let repairRun: Run | undefined;
    // Missing business facts, absent mappings and unreviewed checks require a
    // designer decision. Only an existing fully reviewed plan authorizes repair.
    if (
      !report.ready &&
      scope.scenarios.length &&
      scope.scenarios.every((scenario) => {
        const binding = snapshot.manifest.scenarios.find(
          (binding) => binding.scenario === scenario.id,
        );
        return (
          binding?.accepted &&
          scenario.steps.every((step) =>
            binding.steps.some((test) => test.step === step.id),
          )
        );
      })
    ) {
      repairRun = await store.exclusive(req.params.id, async () => {
        const { state, snapshot: current } = await store.get(req.params.id);
        if (
          current.id !== snapshot.id ||
          state.runs.some((run) => ["queued", "running"].includes(run.status))
        )
          return undefined;
        const existing = state.runs.find(
          (run) => run.repair && run.base === snapshot.id,
        );
        if (existing) return existing;
        const run: Run = {
          id: randomUUID(),
          adapter: z
            .enum(["codex", "cursor"])
            .default("codex")
            .parse(req.body.adapter),
          base: snapshot.id,
          status: "queued",
          events: [],
          repair: true,
          prompt: `Repair the existing implementation to meet its unchanged reviewed Gherkin and executable scenario plans. Keep requirements, manifest, test plans and dependency/tooling configuration exactly unchanged. Preserve unrelated source. Return a gap or clarification for missing library capabilities or business facts; do not invent controls or weaken checks. The current accepted snapshot fails: ${JSON.stringify(report.results)}`,
        };
        state.runs.push(run);
        await store.saveState(state);
        return run;
      });
      if (repairRun?.status === "queued")
        void execute(req.params.id, repairRun).catch(() => {});
    }
    res.json({ ...report, revision: snapshot.id, repairRun: repairRun?.id });
  });
  app.get("/api/projects/:id/export", async (req, res) => {
    const { snapshot, state } = await store.get(req.params.id);
    if (state.templateReconciliation)
      throw new StudioError(
        "Adapt and review the template before exporting this new scope.",
      );
    res
      .type("application/zip")
      .attachment("prototype.zip")
      .send(exportArchive(snapshot.files, snapshot.manifest));
  });
  app.post("/api/import", async (req, res) => {
    const body = z
      .object({
        archive: z.string(),
        requirements: filesSchema.optional(),
        confirm: z.boolean().optional(),
        confirmMarkdown: z.boolean().optional(),
        previewStories: z.record(z.string(), z.string()).optional(),
      })
      .parse(req.body);
    const requirements: Record<string, string> = {};
    const markdownProposals: { file: string; source: string }[] = [];
    for (const [file, source] of Object.entries(body.requirements ?? {})) {
      safeRelative(file);
      if (file.endsWith(".md")) {
        const converted = markdownRequirements(source);
        converted.proposals.forEach((content, index) => {
          const name = file.replace(/\.md$/, `-${index + 1}.feature`);
          requirements[name] = content;
          markdownProposals.push({ file: name, source: content });
        });
      } else if (file.endsWith(".feature")) requirements[file] = source;
      else
        throw new StudioError(
          "Supply .feature requirements or Markdown containing Gherkin blocks.",
        );
    }
    if (body.confirm && markdownProposals.length && !body.confirmMarkdown)
      throw new StudioError(
        "Review the extracted Markdown requirements and confirm discrepancies before opening this source.",
        422,
      );
    const inspected = inspectImport(
      readArchive(Buffer.from(body.archive, "base64")),
      requirements,
    );
    if (inspected.diagnostics.length || !body.confirm)
      return res.json({
        ...inspected,
        requiresConfirmation: true,
        markdownProposals,
      });
    if (!inspected.native) {
      for (const page of inspected.manifest.pages) {
        const selected = body.previewStories?.[page.id] ?? page.previewStory;
        if (
          !selected ||
          !inspected.stories?.some(
            (story) =>
              story.page === page.id &&
              story.file + "#" + story.name === selected,
          )
        )
          throw new StudioError(
            "Choose one of this page's original stories as its editing preview.",
          );
        page.previewStory = selected;
      }
      inspected.files = synchronizeRuntime(inspected.files, inspected.manifest);
    }
    const candidate = {
      id: digest([inspected.files, inspected.manifest]),
      at: new Date().toISOString(),
      label: "Import candidate",
      files: inspected.files,
      manifest: inspected.manifest,
    };
    if (!inspected.native) {
      const installed = await previews.materialize(candidate);
      const dependencies =
        JSON.parse(inspected.files["package.json"]).dependencies ?? {};
      for (const name of referencedComponentPackages(inspected.files, inspected.manifest)) {
        const version = dependencies[name];
        if (typeof version !== "string")
          throw new StudioError(
            `${name}: imported React components need an exact direct dependency.`,
          );
        const admitted = await inspectLibrary(installed, name, version);
        inspected.manifest.libraries.push({
          name,
          version,
          components: admitted.components,
        });
      }
      inspected.files = synchronizeRuntime(inspected.files, inspected.manifest);
      candidate.files = inspected.files;
      candidate.manifest = inspected.manifest;
      candidate.id = digest([candidate.files, candidate.manifest]);
    }
    await previews.verify(candidate, true);
    res.json(await store.create(inspected.manifest, inspected.files));
  });
  app.get("/api/templates", async (_req, res) => {
    const root = path.join(options.root, "templates");
    await fs.mkdir(root, { recursive: true });
    const names = (await fs.readdir(root)).filter((f) =>
      /^[a-f0-9-]+\.json$/.test(f),
    );
    res.json(
      await Promise.all(
        names.map(async (file) => {
          const t = JSON.parse(
            await fs.readFile(path.join(root, file), "utf8"),
          );
          return {
            id: file.slice(0, -5),
            name: t.name,
            scenarios: parseRequirements(t.files, t.manifest.scope).scenarios,
          };
        }),
      ),
    );
  });
  app.post("/api/projects/:id/template", async (req, res) => {
    const { snapshot, state } = await store.get(req.params.id);
    if (state.templateReconciliation)
      throw new StudioError(
        "Finish reviewing the template adaptation before saving it as a new template.",
      );
    const id = randomUUID();
    await atomicJSON(path.join(options.root, "templates", id + ".json"), {
      name: z.string().min(1).parse(req.body.name),
      files: snapshot.files,
      manifest: snapshot.manifest,
    });
    res.json({ id });
  });
  app.post("/api/templates/:template/reuse", async (req, res) => {
    if (!/^(?:[a-f0-9-]{36}|[a-f0-9]{64})$/.test(req.params.template))
      throw new StudioError("Template not found.");
    const template = JSON.parse(
      await fs.readFile(
        path.join(options.root, "templates", req.params.template + ".json"),
        "utf8",
      ),
    );
    const files = filesSchema.parse(req.body.requirements);
    const scope = z.array(z.string()).parse(req.body.scope);
    const prior = parseRequirements(template.files, template.manifest.scope);
    const next = parseRequirements(files, scope);
    if (!next.scenarios.length)
      throw new StudioError(
        "Choose new Gherkin requirements before reusing a template.",
      );
    const same =
      JSON.stringify(
        Object.fromEntries(
          Object.entries(template.files).filter(([name]) =>
            name.endsWith(".feature"),
          ),
        ),
      ) === JSON.stringify(files) &&
      JSON.stringify(template.manifest.scope) === JSON.stringify(scope);
    if (!same && req.body.confirm !== true)
      return res.json({
        requiresReconciliation: true,
        prior,
        next,
        message:
          "The template has different business scenarios. Create an adaptation draft, then review its proposed requirements and page changes together.",
      });
    const manifest = {
      ...template.manifest,
      name: req.body.name || template.name,
    };
    const created = await store.create(
      manifest,
      synchronizeRuntime(template.files, manifest),
    );
    if (!same) {
      created.state.templateReconciliation = { requirements: files, scope };
      await store.saveState(created.state);
    }
    res.json(created);
  });
  app.use(
    (
      error: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      if (error instanceof StudioError)
        return res
          .status(error.status)
          .json({ error: error.message, detail: error.detail });
      if (error instanceof z.ZodError)
        return res.status(400).json({
          error: "Some supplied values need correction.",
          detail: error.issues,
        });
      res.status(500).json({
        error:
          "Studio could not complete this operation. Accepted work is unchanged.",
      });
    },
  );
  return {
    app,
    store,
    previews,
    close: async () => {
      installationAbort.abort();
      ai.close();
      await Promise.allSettled([previews.close(), ...installations]);
    },
  };
}
