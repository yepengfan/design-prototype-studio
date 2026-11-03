import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { atomicJSON, digest, validateFiles } from "./files.js";
import {
  manifestSchema,
  StudioError,
  type Files,
  type Manifest,
  type ProjectState,
  type Snapshot,
} from "./contracts.js";
import { parseRequirements } from "./requirements.js";

export class ProjectStore {
  private queues = new Map<string, Promise<unknown>>();
  constructor(readonly root: string) {}
  dir(id: string) {
    if (!/^[a-f0-9-]{36}$/.test(id))
      throw new StudioError("Project not found.", 404);
    return path.join(this.root, id);
  }
  async exclusive<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const before = this.queues.get(id) ?? Promise.resolve();
    const next = before.catch(() => {}).then(fn);
    this.queues.set(id, next);
    try {
      return await next;
    } finally {
      if (this.queues.get(id) === next) this.queues.delete(id);
    }
  }
  async list() {
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    const results = [];
    for (const id of await fs.readdir(this.root)) {
      if (!/^[a-f0-9-]{36}$/.test(id)) continue;
      try {
        await fs.access(path.join(this.dir(id), "state.json"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      const { snapshot } = await this.get(id);
      results.push({ id, name: snapshot.manifest.name, updated: snapshot.at });
    }
    return results.sort((a, b) => b.updated.localeCompare(a.updated));
  }
  async create(manifest: Manifest, files: Files) {
    const id = randomUUID();
    const snap = await this.persist(id, {
      files,
      manifest,
      label: "Created project",
    });
    await this.saveState({
      id,
      head: snap.id,
      redo: [],
      versions: [],
      annotations: [],
      runs: [],
    });
    return this.get(id);
  }
  async get(id: string) {
    const state: ProjectState = JSON.parse(
      await fs
        .readFile(path.join(this.dir(id), "state.json"), "utf8")
        .catch(() => {
          throw new StudioError(
            "Project not found or its journal needs recovery.",
            404,
          );
        }),
    );
    const snapshot = await this.snapshot(id, state.head);
    return { state, snapshot };
  }
  async snapshot(id: string, revision: string): Promise<Snapshot> {
    if (!/^[a-f0-9]{64}$/.test(revision))
      throw new StudioError("Unknown version.");
    const snap: Snapshot = JSON.parse(
      await fs.readFile(
        path.join(this.dir(id), "revisions", revision + ".json"),
        "utf8",
      ),
    );
    if (digest({ ...snap, id: undefined }) !== revision)
      throw new StudioError(
        "Saved version failed integrity verification.",
        409,
      );
    return snap;
  }
  async saveState(state: ProjectState) {
    await atomicJSON(path.join(this.dir(state.id), "state.json"), state);
  }
  async persist(id: string, input: Omit<Snapshot, "id" | "at">) {
    validateFiles(input.files);
    manifestSchema.parse(input.manifest);
    for (const p of input.manifest.pages)
      if (!(p.file in input.files))
        throw new StudioError(`Page source is missing: ${p.title}`);
    parseRequirements(input.files, input.manifest.scope);
    const activeAnnotationResults =
      input.activeAnnotationResults ??
      (input.parent
        ? (await this.snapshot(id, input.parent)).activeAnnotationResults
        : []) ??
      [];
    const body = {
      ...input,
      activeAnnotationResults,
      at: new Date().toISOString(),
      id: undefined,
    };
    const revision = digest(body);
    const snap = { ...body, id: revision };
    await atomicJSON(
      path.join(this.dir(id), "revisions", revision + ".json"),
      snap,
    );
    return snap;
  }
  // Must be called under exclusive(). Snapshot is durable before the atomic head pointer changes.
  async commit(
    id: string,
    base: string,
    files: Files,
    manifest: Manifest,
    label: string,
  ) {
    const { state, snapshot } = await this.get(id);
    if (snapshot.id !== base)
      throw new StudioError(
        "The page changed while this edit was prepared. Review it against the current version.",
        409,
      );
    const candidate = await this.persist(id, {
      files,
      manifest,
      parent: base,
      label,
    });
    state.head = candidate.id;
    state.redo = [];
    await this.saveState(state);
    return this.get(id);
  }
  async history(id: string) {
    const { state } = await this.get(id);
    const out: Omit<Snapshot, "files" | "manifest">[] = [];
    let revision: string | undefined = state.head;
    while (revision && out.length < 200) {
      const snap = await this.snapshot(id, revision);
      out.push({
        id: snap.id,
        parent: snap.parent,
        at: snap.at,
        label: snap.label,
      });
      revision = snap.parent;
    }
    return out;
  }
  async navigate(
    id: string,
    action: "undo" | "redo" | "restore",
    verify: (s: Snapshot) => Promise<void>,
    revision?: string,
  ) {
    return this.exclusive(id, async () => {
      const { state, snapshot } = await this.get(id);
      const target =
        action === "undo"
          ? snapshot.parent
          : action === "redo"
            ? state.redo.at(-1)
            : revision;
      if (!target) throw new StudioError(`Nothing to ${action}.`);
      const saved = await this.snapshot(id, target);
      await verify(saved); // Exact dependencies must be available before changing the working revision.
      if (action === "undo") state.redo.push(state.head);
      else if (action === "redo") state.redo.pop();
      else state.redo = [];
      state.head = target;
      for (const a of state.annotations) {
        const active = [...(saved.activeAnnotationResults ?? [])]
          .reverse()
          .map((result) => state.runs.find((run) => run.id === result))
          .find((run) => run?.annotation === a.id);
        if (active) a.status = "accepted";
        else if (a.status === "accepted") a.status = "undone";
      }
      await this.saveState(state);
      return this.get(id);
    });
  }
  async recoverRuns() {
    for (const project of await this.list())
      await this.exclusive(project.id, async () => {
        const { state } = await this.get(project.id);
        let changed = false;
        for (const run of state.runs)
          if (["queued", "running"].includes(run.status)) {
            run.status = "interrupted";
            run.error =
              "Studio restarted. Partial output was quarantined. Retry from the current accepted version.";
            changed = true;
          }
        for (const a of state.annotations)
          if (a.status === "processing") {
            a.status = "pending";
            changed = true;
          }
        if (changed) await this.saveState(state);
      });
  }
}
