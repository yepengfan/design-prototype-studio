import { randomUUID } from "node:crypto";
import { ProjectStore } from "./store.js";
import {
  StudioError,
  type Snapshot,
  type Run,
  type Files,
  type ProjectState,
  type Proposal,
  type Annotation,
} from "./contracts.js";
import { differences } from "./changes.js";
import { anchors } from "./source.js";
import { digest } from "./files.js";
import { synchronizeRuntime } from "./project.js";
export class Annotations {
  constructor(
    private store: ProjectStore,
    private verify: (s: Snapshot) => Promise<void>,
  ) {}
  async impact(
    project: string,
    snapshot: Snapshot,
    state: ProjectState,
    files: Files,
    proposal: Proposal,
  ) {
    const changed = new Set(
      differences(snapshot.files, files)
        .map((change) => change.file)
        .filter((file) => file !== "studio.project.json"),
    );
    const affected: {
      id: string;
      text: string;
      reason: string;
      files: string[];
    }[] = [];
    for (const id of snapshot.activeAnnotationResults ?? []) {
      const accepted = state.runs.find((run) => run.id === id);
      if (!accepted?.appliedBase || !accepted.appliedRevision)
        throw new StudioError(
          "An accepted result has incomplete history. Restore a complete saved version before reworking.",
          409,
        );
      const before = await this.store.snapshot(project, accepted.appliedBase);
      const after = await this.store.snapshot(
        project,
        accepted.appliedRevision,
      );
      const overlap = differences(before.files, after.files)
        .map((change) => change.file)
        .filter((file) => changed.has(file));
      const sharedScenarios = accepted.proposal?.affectedScenarios.some(
        (scenario) => proposal.affectedScenarios.includes(scenario),
      );
      if (overlap.length || sharedScenarios)
        affected.push({
          id,
          text:
            accepted.annotationText ??
            accepted.proposal?.summary ??
            after.label,
          reason: overlap.length
            ? "Shares source or requirements with this accepted result; independence cannot be established"
            : "Shares affected business scenarios",
          files: overlap,
        });
    }
    return {
      affectedAcceptedResults: affected,
      acceptedResultsConfirmation: digest({
        base: snapshot.id,
        files: digest(files),
        affected,
      }),
    };
  }
  async target(project: string, snapshot: Snapshot, note: Annotation) {
    const page = snapshot.manifest.pages.find((page) => page.id === note.page);
    if (!page)
      throw new StudioError(
        "The annotated page is no longer available. Select its current location before submitting.",
        409,
      );
    if (note.target === "page") return { page, node: undefined };
    const original = await this.store.snapshot(project, note.base);
    const oldPage = original.manifest.pages.find(
      (page) => page.id === note.page,
    );
    const before = oldPage && original.files[oldPage.file];
    const current = snapshot.files[page.file];
    const previous =
      before && anchors(before).find((node) => node.id === note.target);
    const candidates = anchors(
      current,
      snapshot.manifest.libraries.flatMap((library) => library.components),
    );
    const matching = !previous
      ? []
      : candidates.filter((node) =>
          before === current
            ? node.id === previous.id
            : current.slice(node.start, node.end) ===
              before.slice(previous.start, previous.end),
        );
    if (matching.length !== 1)
      throw new StudioError(
        "An annotated item changed or has more than one matching location. Select its current location and review the annotation before submitting.",
        409,
      );
    return { page, node: matching[0] };
  }
  async revise(
    project: string,
    id: string,
    input: { base: string; text: string; page: string; target: string },
  ) {
    return this.store.exclusive(project, async () => {
      const { state, snapshot } = await this.store.get(project);
      const note = state.annotations.find((note) => note.id === id);
      if (input.base !== snapshot.id)
        throw new StudioError(
          "The page changed. Review the annotation's current location again.",
          409,
        );
      if (
        !note ||
        !["draft", "pending", "failed", "undone", "approved"].includes(
          note.status,
        )
      )
        throw new StudioError(
          "Only an unsubmitted or pending annotation can be revised.",
          409,
        );
      if (!input.text.trim())
        throw new StudioError("Write the change you want.");
      await this.target(project, snapshot, {
        ...note,
        ...input,
        base: snapshot.id,
      });
      Object.assign(note, {
        text: input.text,
        page: input.page,
        target: input.target,
        base: snapshot.id,
        status: "draft",
      });
      delete note.message;
      // A prior proposal can still be inspected through its history, but must
      // never be applied after its designer instruction was revised.
      for (const result of state.runs)
        if (result.annotation === id && result.status === "review") {
          result.status = "cancelled";
          result.error = "The annotation was revised and needs fresh approval.";
        }
      delete note.run;
      await this.store.saveState(state);
      return state;
    });
  }
  async draft(
    project: string,
    input: { target: string; page: string; text: string },
  ) {
    return this.store.exclusive(project, async () => {
      const { state, snapshot } = await this.store.get(project);
      await this.target(project, snapshot, {
        ...input,
        id: "draft",
        base: snapshot.id,
        status: "draft",
      });
      if (!input.text.trim())
        throw new StudioError("Write the change you want.");
      state.annotations.push({
        ...input,
        id: randomUUID(),
        base: state.head,
        status: "draft",
      });
      await this.store.saveState(state);
      return state;
    });
  }
  async approve(project: string, ids: string[]) {
    return this.store.exclusive(project, async () => {
      const { state } = await this.store.get(project);
      const items = state.annotations.filter((a) => ids.includes(a.id));
      if (
        !items.length ||
        items.some(
          (a) => !["draft", "pending", "failed", "undone"].includes(a.status),
        )
      )
        throw new StudioError(
          "Review pending annotations before approving this batch.",
        );
      for (const a of items) a.status = "approved";
      await this.store.saveState(state);
      return items;
    });
  }
  async undo(
    project: string,
    result: string,
    includeDependents = false,
    expectedBase?: string,
  ) {
    return this.store.exclusive(project, async () => {
      const { state, snapshot } = await this.store.get(project);
      if (expectedBase && snapshot.id !== expectedBase)
        throw new StudioError(
          "The page changed. Review the affected results again.",
          409,
        );
      const active = snapshot.activeAnnotationResults ?? [];
      const selected = [...active]
        .reverse()
        .map((id) => state.runs.find((run) => run.id === id))
        .find((run) => run && (run.id === result || run.annotation === result));
      if (!selected?.appliedBase || !selected.appliedRevision)
        throw new StudioError("Choose an accepted annotation result.");
      const base = await this.store.snapshot(project, selected.appliedBase);
      const chain: Snapshot[] = [];
      let cursor: Snapshot | undefined = snapshot;
      while (cursor && cursor.id !== base.id) {
        chain.push(cursor);
        cursor = cursor.parent
          ? await this.store.snapshot(project, cursor.parent)
          : undefined;
        if (chain.length > 1000)
          throw new StudioError(
            "This history is too large for a safe selective undo. Restore a named version instead.",
            409,
          );
      }
      if (!cursor)
        throw new StudioError(
          "The result belongs to a different restored history. Restore its named version or rework from the current page.",
          409,
        );
      chain.reverse();
      const skipped = new Set([selected.id]);
      const affected: { id: string; text: string; reason: string }[] = [];
      const activeRuns = active
        .map((id) => state.runs.find((run) => run.id === id))
        .filter((r): r is Run => !!r);
      const selectedIndex = active.indexOf(selected.id);
      const scenarios = new Set(selected.proposal?.affectedScenarios ?? []);
      for (const run of activeRuns.slice(selectedIndex + 1))
        if (run.proposal?.affectedScenarios.some((id) => scenarios.has(id))) {
          skipped.add(run.id);
          run.proposal.affectedScenarios.forEach((id) => scenarios.add(id));
          affected.push({
            id: run.id,
            text: run.annotationText ?? run.proposal.summary,
            reason: "Shares affected business scenarios",
          });
        }
      const files: Files = { ...base.files };
      const survivingResults = new Set(base.activeAnnotationResults ?? []);
      let previous = base;
      for (const revision of chain) {
        const run = activeRuns.find(
          (run) => run.appliedRevision === revision.id,
        );
        const delta = differences(previous.files, revision.files);
        if (run && skipped.has(run.id)) {
          previous = revision;
          continue;
        }
        const conflict = delta.some((d) => (files[d.file] ?? "") !== d.before);
        if (conflict) {
          if (run) skipped.add(run.id);
          affected.push({
            id: run?.id ?? revision.id,
            text: run?.annotationText ?? revision.label,
            reason:
              "Depends on changed source or requirements; independence cannot be established",
          });
          previous = revision;
          continue;
        }
        for (const id of previous.activeAnnotationResults ?? [])
          if (!revision.activeAnnotationResults?.includes(id))
            survivingResults.delete(id);
        for (const id of revision.activeAnnotationResults ?? [])
          if (!skipped.has(id)) survivingResults.add(id);
        for (const change of delta) {
          if (change.removed) delete files[change.file];
          else files[change.file] = change.after;
        }
        previous = revision;
      }
      if (affected.length && !includeDependents)
        throw new StudioError(
          "Undoing this result also affects these later changes. Undo them together or keep the page.",
          409,
          affected,
        );
      const manifest = JSON.parse(files["studio.project.json"]);
      const candidate = await this.store.persist(project, {
        parent: snapshot.id,
        label: "Undo annotation results",
        files: synchronizeRuntime(files, manifest),
        manifest,
        activeAnnotationResults: [...survivingResults].filter(
          (id) => !skipped.has(id),
        ),
      }, base.id);
      await this.verify(candidate);
      state.head = candidate.id;
      state.redo = [];
      for (const note of state.annotations) {
        const hasActive = candidate.activeAnnotationResults?.some(
          (id) => state.runs.find((r) => r.id === id)?.annotation === note.id,
        );
        if (hasActive) note.status = "accepted";
        else if (note.status === "accepted") note.status = "undone";
      }
      await this.store.saveState(state);
      return this.store.get(project);
    });
  }
}
