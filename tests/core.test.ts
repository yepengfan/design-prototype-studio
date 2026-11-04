import type { Proposal } from "../server/core/contracts";
import { describe, it, expect, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import AdmZip from "adm-zip";
import {
  parseRequirements,
  markdownRequirements,
} from "../server/core/requirements";
import { blankProject, synchronizeRuntime } from "../server/core/project";
import { ProjectStore } from "../server/core/store";
import { anchors, editSource } from "../server/core/source";
import { digest, writeFiles, readTree } from "../server/core/files";
import {
  readArchive,
  exportArchive,
  inspectImport,
} from "../server/core/archive";
import { prepareChange } from "../server/core/changes";
import { Annotations } from "../server/core/annotations";
const roots: string[] = [];
async function temp() {
  const p = await fs.mkdtemp(path.join(os.tmpdir(), "studio-test-"));
  roots.push(p);
  return p;
}
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((p) => fs.rm(p, { recursive: true, force: true })),
  );
});
const feature = `Feature: Reading a notice
  Background:
    Given the notice is available
  Scenario Outline: A notice for each reader
    When <reader> opens the notice
    Then the notice is visible
    Examples:
      | reader |
      | Alex   |
      | Blair  |
`;
function project() {
  const p = blankProject("Notices");
  p.manifest.generationState = "generated";
  p.files["requirements/notices.feature"] = feature;
  p.manifest.scope = ["requirements"];
  p.files = synchronizeRuntime(p.files, p.manifest);
  return p;
}
describe("selected requirements", () => {
  it("executes outline expansion and backgrounds, excluding independent files", () => {
    const result = parseRequirements(
      {
        "chosen/a.feature": feature,
        "other/b.feature":
          "Feature: Independent\nScenario: Other\nGiven another thing",
      },
      ["chosen"],
    );
    expect(result.scenarios).toHaveLength(2);
    expect(result.scenarios[0].steps.map((s) => s.text)).toEqual([
      "the notice is available",
      "Alex opens the notice",
      "the notice is visible",
    ]);
    expect(result.files.map((f) => f.file)).toEqual(["chosen/a.feature"]);
  });
  it("rejects malformed documents and proposes Markdown blocks for confirmation", () => {
    expect(() =>
      parseRequirements({ "a.feature": "invalid\nScenario:" }, ["a.feature"]),
    ).toThrow();
    expect(
      markdownRequirements("Prose\n```gherkin\n" + feature + "\n```").proposals,
    ).toEqual([feature + "\n"]);
  });
});
describe("durable project history", () => {
  it("reopens autosaved source and retains the prior head when exact dependency verification fails", async () => {
    const root = await temp();
    const store = new ProjectStore(root);
    const p = project();
    const initial = await store.create(p.manifest, p.files);
    const id = initial.state.id;
    const next = await store.exclusive(id, () =>
      store.commit(
        id,
        initial.snapshot.id,
        { ...p.files, "src/data/mock.ts": "export const data = 2;" },
        p.manifest,
        "New adapter",
      ),
    );
    const reopened = new ProjectStore(root);
    expect(
      (await reopened.get(id)).snapshot.files["src/data/mock.ts"],
    ).toContain("2");
    await expect(
      reopened.navigate(id, "undo", async () => {
        throw new Error("Exact release unavailable");
      }),
    ).rejects.toThrow("unavailable");
    expect((await reopened.get(id)).state.head).toBe(next.snapshot.id);
    await reopened.navigate(id, "undo", async () => {});
    expect((await reopened.get(id)).state.head).toBe(initial.snapshot.id);
    await reopened.navigate(id, "redo", async () => {});
    expect((await reopened.get(id)).state.head).toBe(next.snapshot.id);
  });
  it("quarantines interrupted jobs while preserving pending annotations and accepted head", async () => {
    const store = new ProjectStore(await temp());
    const p = project();
    const { state } = await store.create(p.manifest, p.files);
    state.runs.push({
      id: "run",
      adapter: "codex",
      base: state.head,
      prompt: "test",
      status: "running",
      events: [],
    });
    state.annotations.push({
      id: "note",
      target: "page",
      page: "page",
      text: "Keep this",
      base: state.head,
      status: "processing",
    });
    await store.saveState(state);
    await store.recoverRuns();
    const recovered = await store.get(state.id);
    expect(recovered.state.runs[0].status).toBe("interrupted");
    expect(recovered.state.annotations[0].status).toBe("pending");
    expect(recovered.state.head).toBe(state.head);
  });
});
describe("canonical bounded source editing", () => {
  const source = `import { useState } from 'react';
export function Page(){const [value,setValue]=useState('');return <main><section><h1>Welcome</h1></section><aside>Help</aside></main>}`;
  it("edits text repeatedly, nests, duplicates and moves without rewriting a controller", () => {
    let text = source;
    const edit = (tag: string, values: any) => {
      const a = anchors(text).find((n) => n.tag === tag)!;
      text = editSource(
        text,
        { anchor: a.id, sourceHash: digest(text), ...values },
        [],
      );
    };
    edit("h1", { operation: "text", value: "Hello" });
    edit("h1", { operation: "text", value: "Again" });
    edit("h1", { operation: "wrap", layout: "grid" });
    edit("aside", { operation: "duplicate" });
    expect(anchors(text).filter((n) => n.tag === "aside")).toHaveLength(2);
    expect(anchors(text).find((n) => n.tag === "h1")?.text).toBe("Again");
    const parent = anchors(text).find((n) => n.tag === "section")!.id;
    edit("aside", { operation: "move", parent, index: 0 });
    expect(
      anchors(text).filter(
        (n) =>
          n.tag === "aside" &&
          n.parent === anchors(text).find((n) => n.tag === "section")!.id,
      ),
    ).toHaveLength(1);
    expect(text).toContain("const [value,setValue]=useState('')");
  });
  it("rejects stale anchors rather than editing the wrong repeated element", () => {
    const a = anchors(source)[0];
    expect(() =>
      editSource(
        source + "\n",
        { anchor: a.id, sourceHash: digest(source), operation: "remove" },
        [],
      ),
    ).toThrow("stale");
  });
});
describe("safe source handoff", () => {
  it("roundtrips current text and binary assets without changing canonical bytes", async () => {
    const root = await temp();
    const p = project();
    const zip = new AdmZip(exportArchive(p.files, p.manifest));
    const bytes = Buffer.from([137, 80, 78, 71, 0, 255]);
    zip.addFile("public/mark.png", bytes);
    const read = readArchive(zip.toBuffer());
    const inspected = inspectImport(read);
    expect(inspected.native).toBe(true);
    await writeFiles(root, read);
    expect(await fs.readFile(path.join(root, "public/mark.png"))).toEqual(
      bytes,
    );
    const again = readArchive(exportArchive(await readTree(root), p.manifest));
    expect(again).toEqual(read);
  });
  it("rejects credential paths, archive symlinks, and existing directory symlinks", async () => {
    const zip = new AdmZip();
    zip.addFile(".npmrc", Buffer.from("private"));
    expect(() => readArchive(zip.toBuffer())).toThrow("Private");
    const link = new AdmZip();
    link.addFile("asset", Buffer.from("target"));
    link.getEntry("asset")!.header.attr = (0o120777 << 16) >>> 0;
    expect(() => readArchive(link.toBuffer())).toThrow("symbolic");
    const root = await temp();
    const outside = await temp();
    await fs.symlink(outside, path.join(root, "src"));
    await expect(writeFiles(root, { "src/escape.ts": "no" })).rejects.toThrow(
      "safe directory",
    );
    expect(await fs.readdir(outside)).toEqual([]);
  });
  it("bounds actual decompression even when an archive lies about expanded sizes and detects corrupt content", () => {
    const zip = new AdmZip();
    zip.addFile("src/large.txt", Buffer.alloc(4_100_000, 65));
    const buffer = zip.toBuffer();
    const local = buffer.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    const central = buffer.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    buffer.writeUInt32LE(1, local + 22);
    buffer.writeUInt32LE(1, central + 24);
    expect(() => readArchive(buffer)).toThrow(/size limit|checksum|size/);
    const small = new AdmZip();
    small.addFile("src/notice.txt", Buffer.from("Notice"));
    const corrupt = small.toBuffer();
    const header = corrupt.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    corrupt.writeUInt32LE(0, header + 16);
    expect(() => readArchive(corrupt)).toThrow("checksum");
  });
  it("preserves legacy render, decorators, hooks and styles and reports missing requirements", () => {
    const files = {
      "package.json": '{"name":"legacy","dependencies":{"react":"19.3.1"}}',
      "package-lock.json": "{}",
      ".storybook/main.ts": "export default {}",
      "src/Page.tsx":
        'import {useState} from "react"; import "./style.css"; export default function Page(){const [v]=useState("hello");return <h1>{v}</h1>}',
      "src/style.css": "h1{color:green}",
      "src/Page.stories.tsx":
        'import Page from "./Page"; const meta = {component:Page,decorators:[(Story:any)=><section><Story/></section>]} satisfies object; export default meta; export const Default = {render:()=> <Page/>};',
    };
    expect(() => inspectImport(files)).toThrow("Gherkin");
    const result = inspectImport(files, {
      "requirements/page.feature": feature,
    });
    expect(result.files["src/Page.tsx"]).toBe(files["src/Page.tsx"]);
    expect(result.files["src/Page.stories.tsx"]).toBe(
      files["src/Page.stories.tsx"],
    );
    expect(result.stories).toHaveLength(1);
    expect(result.manifest.pages[0].export).toBe("default");
  });
});
describe("requirements and implementation transaction", () => {
  it("requires matching business Gherkin changes and preserves accepted source on failure", async () => {
    const p = project();
    const store = new ProjectStore(await temp());
    const { snapshot } = await store.create(p.manifest, p.files);
    const proposal: Proposal = {
      kind: "presentation",
      summary: "Change behavior",
      files: {
        ...p.files,
        "src/data/operation.ts": "export const submit = () => false;",
      },
      questions: [],
      affectedScenarios: [],
    };
    expect(() => prepareChange(snapshot, proposal)).toThrow(
      "matching requirements",
    );
    proposal.files["requirements/notices.feature"] = feature.replace(
      "notice is visible",
      "notice is confirmed",
    );
    expect(prepareChange(snapshot, proposal).requiresConfirmation).toBe(true);
    expect((await store.get((await store.list())[0].id)).state.head).toBe(
      snapshot.id,
    );
  });
  it("rejects invented replacement controls despite model self-classification", async () => {
    const p = project();
    const store = new ProjectStore(await temp());
    const { snapshot } = await store.create(p.manifest, p.files);
    expect(() =>
      prepareChange(snapshot, {
        kind: "business",
        summary: "Add action",
        files: {
          ...p.files,
          "src/pages/Page.tsx":
            "export function Page(){return <button>Fake</button>}",
          "requirements/notices.feature": feature.replace(
            "notice is visible",
            "action is visible",
          ),
        },
        questions: [],
        affectedScenarios: [],
      }),
    ).toThrow("invents");
  });
});
describe("annotation result history", () => {
  async function acceptedFixture(dependent = false) {
    const store = new ProjectStore(await temp());
    const p = project();
    const initial = await store.create(p.manifest, p.files);
    const aFiles = { ...p.files, "src/a.css": "a{color:green}" };
    const bFiles = dependent
      ? { ...aFiles, "src/a.css": "a{color:blue}" }
      : { ...aFiles, "src/b.css": "b{color:blue}" };
    const a = await store.persist(initial.state.id, {
      parent: initial.snapshot.id,
      label: "Result A",
      files: aFiles,
      manifest: p.manifest,
      activeAnnotationResults: ["r-a"],
    });
    const b = await store.persist(initial.state.id, {
      parent: a.id,
      label: "Result B",
      files: bFiles,
      manifest: p.manifest,
      activeAnnotationResults: ["r-a", "r-b"],
    });
    const state = initial.state;
    state.head = b.id;
    state.runs = [
      {
        id: "r-a",
        adapter: "codex",
        base: initial.snapshot.id,
        prompt: "A",
        events: [],
        status: "applied",
        annotation: "a",
        annotationText: "A",
        appliedBase: initial.snapshot.id,
        appliedRevision: a.id,
      },
      {
        id: "r-b",
        adapter: "codex",
        base: a.id,
        prompt: "B",
        events: [],
        status: "applied",
        annotation: "b",
        annotationText: "B",
        appliedBase: a.id,
        appliedRevision: b.id,
      },
    ];
    state.annotations = [
      {
        id: "a",
        page: "page",
        target: "a",
        text: "A",
        base: initial.snapshot.id,
        status: "accepted",
        run: "r-a",
      },
      {
        id: "b",
        page: "page",
        target: "b",
        text: "B",
        base: a.id,
        status: "accepted",
        run: "r-b",
      },
      {
        id: "pending",
        page: "page",
        target: "page",
        text: "Try again",
        base: initial.snapshot.id,
        status: "pending",
      },
    ];
    await store.saveState(state);
    return { store, state, initial, a, b };
  }
  it("replays surviving independent results and restores exact result decisions with history", async () => {
    const { store, state, b } = await acceptedFixture();
    const notes = new Annotations(store, async () => {});
    const undone = await notes.undo(state.id, "r-a");
    expect(undone.snapshot.files["src/a.css"]).toBeUndefined();
    expect(undone.snapshot.files["src/b.css"]).toBe("b{color:blue}");
    expect(undone.snapshot.activeAnnotationResults).toEqual(["r-b"]);
    expect(undone.state.annotations[2].status).toBe("pending");
    const restored = await store.navigate(
      state.id,
      "restore",
      async () => {},
      b.id,
    );
    expect(restored.snapshot.activeAnnotationResults).toEqual(["r-a", "r-b"]);
    expect(restored.state.annotations.slice(0, 2).map((a) => a.status)).toEqual(
      ["accepted", "accepted"],
    );
    expect(restored.state.annotations[2].text).toBe("Try again");
  });
  it("restores an earlier acceptance when undoing the result that explicitly replaced it", async () => {
    const { store, state, b } = await acceptedFixture(true);
    const replacement = await store.persist(state.id, {
      parent: b.parent,
      label: "Replace A with B",
      files: b.files,
      manifest: b.manifest,
      activeAnnotationResults: ["r-b"],
    });
    state.head = replacement.id;
    state.runs[1].appliedRevision = replacement.id;
    state.annotations[0].status = "pending";
    await store.saveState(state);
    const undone = await new Annotations(store, async () => {}).undo(
      state.id,
      "r-b",
    );
    expect(undone.snapshot.activeAnnotationResults).toEqual(["r-a"]);
    expect(undone.state.annotations[0].status).toBe("accepted");
    expect(undone.snapshot.files["src/a.css"]).toBe("a{color:green}");
  });
  it("identifies accepted work touched by a new rework even when it is already in the proposal base", async () => {
    const { store, state, b } = await acceptedFixture();
    const notes = new Annotations(store, async () => {});
    const proposal: Proposal = {
      kind: "presentation",
      summary: "Rework A",
      files: { "src/a.css": "a{color:red}" },
      questions: [],
      affectedScenarios: [],
    };
    const impact = await notes.impact(
      state.id,
      b,
      state,
      { ...b.files, ...proposal.files },
      proposal,
    );
    expect(impact.affectedAcceptedResults.map((result) => result.id)).toEqual([
      "r-a",
    ]);
    expect(impact.affectedAcceptedResults[0].text).toBe("A");
    const independent = await notes.impact(
      state.id,
      b,
      state,
      { ...b.files, "src/new.css": "h1{color:green}" },
      proposal,
    );
    expect(independent.affectedAcceptedResults).toEqual([]);
    expect(independent.acceptedResultsConfirmation).not.toBe(
      impact.acceptedResultsConfirmation,
    );
  });
  it("retargets pending drafts, resolves unique untouched regions and refuses ambiguous matches", async () => {
    const store = new ProjectStore(await temp());
    const p = project();
    const page = p.manifest.pages[0];
    p.files[page.file] =
      "export function Page(){return <main><h1>First</h1><aside>Other</aside></main>}";
    const initial = await store.create(p.manifest, p.files);
    const notes = new Annotations(store, async () => {});
    const target = anchors(initial.snapshot.files[page.file]).find(
      (node) => node.tag === "h1",
    )!;
    const drafted = await notes.draft(initial.state.id, {
      page: page.id,
      target: target.id,
      text: "Make this clearer",
    });
    const note = drafted.annotations[0];
    const shifted = await store.commit(
      initial.state.id,
      initial.snapshot.id,
      {
        ...p.files,
        [page.file]: p.files[page.file].replace(
          "<main>",
          "<main><p>Introduction</p>",
        ),
      },
      p.manifest,
      "Insert independent introduction",
    );
    expect(
      (await notes.target(initial.state.id, shifted.snapshot, note)).node?.text,
    ).toBe("First");
    const duplicated = await store.commit(
      initial.state.id,
      shifted.snapshot.id,
      {
        ...shifted.snapshot.files,
        [page.file]: shifted.snapshot.files[page.file].replace(
          "<h1>First</h1>",
          "<h1>First</h1><h1>First</h1>",
        ),
      },
      p.manifest,
      "Repeat heading",
    );
    await expect(
      notes.target(initial.state.id, duplicated.snapshot, note),
    ).rejects.toThrow("more than one");
    const chosen = anchors(duplicated.snapshot.files[page.file]).find(
      (node) => node.tag === "aside",
    )!;
    const revised = await notes.revise(initial.state.id, note.id, {
      base: duplicated.snapshot.id,
      page: page.id,
      target: chosen.id,
      text: "Change help text",
    });
    expect(revised.annotations[0]).toMatchObject({
      text: "Change help text",
      target: chosen.id,
      base: duplicated.snapshot.id,
      status: "draft",
    });
    await notes.approve(initial.state.id, [note.id]);
    const second = await notes.revise(initial.state.id, note.id, {
      base: duplicated.snapshot.id,
      page: page.id,
      target: chosen.id,
      text: "Reconsider help",
    });
    expect(second.annotations[0].status).toBe("draft");
  });
  it("requires a choice for dependent results and preserves unrelated ordinary edits", async () => {
    const { store, state, b } = await acceptedFixture(true);
    const ordinary = await store.exclusive(state.id, () =>
      store.commit(
        state.id,
        b.id,
        { ...b.files, "src/unrelated.css": "p{margin:0}" },
        b.manifest,
        "Independent spacing",
      ),
    );
    const notes = new Annotations(store, async () => {});
    await expect(notes.undo(state.id, "r-a")).rejects.toMatchObject({
      status: 409,
    });
    expect((await store.get(state.id)).state.head).toBe(ordinary.snapshot.id);
    const undone = await notes.undo(
      state.id,
      "r-a",
      true,
      ordinary.snapshot.id,
    );
    expect(undone.snapshot.files["src/a.css"]).toBeUndefined();
    expect(undone.snapshot.files["src/unrelated.css"]).toBe("p{margin:0}");
    expect(undone.snapshot.activeAnnotationResults).toEqual([]);
  });
});
