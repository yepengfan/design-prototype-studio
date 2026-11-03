import express from "express";
import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import { promises as fs } from "node:fs";
import { z } from "zod";
import { ProjectStore } from "./core/store.js";
import { Previews } from "./core/preview.js";
import { blankProject, synchronizeRuntime } from "./core/project.js";
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

export async function createApp(options: { root: string; origin: string }) {
  const app = express();
  const secret = randomBytes(32).toString("hex");
  const store = new ProjectStore(path.join(options.root, "projects"));
  const previews = new Previews(
    path.join(options.root, "previews"),
    options.origin,
  );
  const ai = new LocalAI(path.join(options.root, "ai"));
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
    p.files["package-lock.json"] = await installProject(
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
            converted.proposals.forEach((text, i) => {
              added[file.replace(/\.md$/, `-${i + 1}.feature`)] = text;
            });
          } else if (file.endsWith(".feature")) added[file] = content;
          else
            throw new StudioError(
              "Choose .feature requirements or Markdown containing Gherkin.",
            );
        }
        if (state.templateReconciliation) {
          const requirements = {
            ...state.templateReconciliation.requirements,
            ...added,
          };
          if (!parseRequirements(requirements, body.scope).scenarios.length)
            throw new StudioError("Select at least one scenario.");
          state.templateReconciliation = { requirements, scope: body.scope };
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
        const manifest = { ...snapshot.manifest, scope: body.scope };
        const scope = parseRequirements(files, manifest.scope);
        if (!scope.scenarios.length)
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
        const source = editSource(
          snapshot.files[page.file],
          edit,
          snapshot.manifest.libraries.flatMap((l) => l.components),
        );
        const files = { ...snapshot.files, [page.file]: source };
        const candidate = await store.persist(req.params.id, {
          files,
          manifest: snapshot.manifest,
          label: "Visual edit",
          parent: body.base,
        });
        await previews.verify(candidate);
        return store.commit(
          req.params.id,
          body.base,
          files,
          snapshot.manifest,
          "Visual edit",
        );
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
    files["package-lock.json"] = await installProject(
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
          ...snapshot.manifest.styles,
          ...admitted.components.flatMap((c) => c.styles),
        ]),
      ],
    };
    const candidate = await store.persist(req.params.id, {
      files: synchronizeRuntime(files, manifest),
      manifest,
      label: `Library ${body.name}@${body.version}`,
      parent: body.base,
    });
    await previews.verify(candidate);
    const libraryPreview = await previews.verifyComponents(
      candidate,
      admitted.components,
    );
    if (!body.apply)
      return res.json({
        preview: libraryPreview,
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
          "Review these components and version changes, then import this exact release.",
      });
    previews.stop(libraryPreview.id);
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
    res.json(await previews.start(snapshot, req.body.scenario, component));
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
        (s) => previews.verify(s),
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
        const page = snapshot.manifest.pages.find(
          (p) => p.id === annotation.page,
        );
        const target =
          page &&
          anchors(
            snapshot.files[page.file],
            snapshot.manifest.libraries.flatMap((l) => l.components),
          ).find((n) => n.id === annotation.target);
        if (annotation.target !== "page" && !target)
          throw new StudioError(
            "An annotated item changed. Select its current location and review the annotation before submitting.",
            409,
          );
        const job: Run = {
          id: randomUUID(),
          adapter,
          base: snapshot.id,
          status: "queued",
          events: [],
          annotation: annotation.id,
          annotationText: annotation.text,
          prompt: `Apply only this approved annotation on ${target ? `${page!.title}: ${target.component?.name ?? target.tag}` : "the current page"}: ${annotation.text}. Preserve all accepted independent edits. Diagnose shared behavior or requirement dependencies instead of overwriting them.`,
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
      const run: Run = {
        id: randomUUID(),
        adapter: body.adapter,
        prompt: body.prompt,
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
      const request = pending
        ? {
            ...run,
            prompt: `Adapt the template to ONLY these newly selected requirements. Its prior requirements are context for conflicts, not additional scope: ${JSON.stringify(parseRequirements(snapshot.files, snapshot.manifest.scope))}. Propose source and requirements together and ask about unclear business adjustments. ${run.prompt}`,
          }
        : run;
      let proposal = await ai.generate(request, selected, update);
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          if (!["gap", "clarification"].includes(proposal.kind)) {
            const change = prepareChange(snapshot, proposal, pending?.scope);
            const candidate = await store.persist(project, {
              parent: run.base,
              label: proposal.summary,
              files: change.files,
              manifest: change.manifest,
            });
            await previews.verify(candidate);
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
          a.status = "failed";
          a.message = r.error;
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
    res.json(
      prepareChange(
        snapshot,
        rebaseProposal(
          await store.snapshot(req.params.id, run.base),
          snapshot,
          run.proposal,
        ),
        state.templateReconciliation?.scope,
      ),
    );
  });
  app.post("/api/projects/:id/runs/:run/preview", async (req, res) => {
    const { state, snapshot } = await store.get(req.params.id);
    const run = state.runs.find((r) => r.id === req.params.run);
    if (run?.appliedRevision)
      return res.json(
        await previews.start(
          await store.snapshot(req.params.id, run.appliedRevision),
          req.body.scenario,
        ),
      );
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
    );
    const candidate = await store.persist(req.params.id, {
      files: change.files,
      manifest: change.manifest,
      label: change.summary,
      parent: snapshot.id,
    });
    await previews.verify(candidate);
    res.json(await previews.start(candidate, req.body.scenario));
  });
  app.post("/api/projects/:id/runs/:run/apply", async (req, res) => {
    res.json(
      await store.exclusive(req.params.id, async () => {
        const { state, snapshot } = await store.get(req.params.id);
        const run = state.runs.find((r) => r.id === req.params.run);
        if (!run?.proposal || run.status !== "review")
          throw new StudioError("Choose a validated pending proposal.");
        const original = await store.snapshot(req.params.id, run.base);
        const change = prepareChange(
          snapshot,
          rebaseProposal(original, snapshot, run.proposal),
          state.templateReconciliation?.scope,
        );
        if (
          change.requiresConfirmation &&
          req.body.confirmRequirements !== change.hash
        )
          throw new StudioError(
            "Review and confirm the corresponding Gherkin difference before applying.",
            422,
          );
        const candidate = await store.persist(req.params.id, {
          files: change.files,
          manifest: change.manifest,
          label: change.summary,
          parent: snapshot.id,
          activeAnnotationResults: run.annotation
            ? [...(snapshot.activeAnnotationResults ?? []), run.id]
            : snapshot.activeAnnotationResults,
        });
        await previews.verify(candidate);
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
        if (
          scenario.steps.some(
            (step) => !binding.steps.some((test) => test.step === step.id),
          )
        )
          throw new StudioError(
            "Every requirement step needs an explicit check before approving this test plan.",
          );
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
    res.json(report);
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
      })
      .parse(req.body);
    const inspected = inspectImport(
      readArchive(Buffer.from(body.archive, "base64")),
      body.requirements,
    );
    if (inspected.diagnostics.length || !body.confirm)
      return res.json({ ...inspected, requiresConfirmation: true });
    const candidate = {
      id: digest([inspected.files, inspected.manifest]),
      at: new Date().toISOString(),
      label: "Import candidate",
      files: inspected.files,
      manifest: inspected.manifest,
    };
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
    const created = await store.create(
      { ...template.manifest, name: req.body.name || template.name },
      template.files,
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
    close: () => {
      previews.close();
      ai.close();
    },
  };
}
