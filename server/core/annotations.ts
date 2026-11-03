import { randomUUID } from "node:crypto";
import { ProjectStore } from "./store.js";
import {
  StudioError,
  type Snapshot,
  type Run,
  type Files,
} from "./contracts.js";
import { differences } from "./changes.js";
import { synchronizeRuntime } from "./project.js";
export class Annotations {
  constructor(
    private store: ProjectStore,
    private verify: (s: Snapshot) => Promise<void>,
  ) {}
  async draft(
    project: string,
    input: { target: string; page: string; text: string },
  ) {
    return this.store.exclusive(project, async () => {
      const { state } = await this.store.get(project);
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
        activeAnnotationResults: active.filter((id) => !skipped.has(id)),
      });
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
