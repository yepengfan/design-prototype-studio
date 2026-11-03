import { it, expect, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ProjectStore } from "../server/core/store";
import { blankProject } from "../server/core/project";
import { LocalAI } from "../server/core/ai";
import * as processTools from "../server/core/process";

it("rejects activation and duplication of preserved native controls before publishing a revision", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "studio-reconstructed-store-"));
  try {
    const store = new ProjectStore(root);
    for (const [before, after] of [
      ["false && <button>Confirm</button>", "true && <button>Confirm</button>"],
      ["<button>Confirm</button>", "<><button>Confirm</button><button>Confirm</button></>"],
    ]) {
      const project = blankProject("Preserved source");
      project.files["src/pages/Page.tsx"] = `export function Page(){return <main>{${before}}</main>}`;
      const accepted = await store.create(project.manifest, project.files);
      const candidate = { ...accepted.snapshot.files, "src/pages/Page.tsx": `export function Page(){return <main>{${after}}</main>}` };
      await expect(store.commit(accepted.state.id, accepted.snapshot.id, candidate, project.manifest, "Unsafe source")).rejects.toThrow(/control|execution/i);
      expect((await store.get(accepted.state.id)).state.head).toBe(accepted.snapshot.id);
    }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

it("honors cancellation while workspace initialization is held and never starts an adapter", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "studio-reconstructed-cancel-"));
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  const command = vi.spyOn(processTools, "runCommand").mockImplementation(async () => {
    entered(); await held;
    // A synthetic failure guarantees this test never launches an account-backed adapter.
    return { code: 1, stdout: "fixture stopped initialization", stderr: "" };
  });
  const ai = new LocalAI(root);
  const project = blankProject("Cancellation");
  const run = { id: "cancel-setup", base: "base", adapter: "codex" as const, prompt: "fixture", status: "running" as const, events: [] };
  const result = ai.generate(run, { ...project, id: "base", at: "now", label: "base" }, async () => {});
  void result.catch(() => {});
  try {
    await started;
    await ai.cancel(run.id);
    release();
    await expect(result).rejects.toThrow(/cancel/i);
    expect(command).toHaveBeenCalledTimes(1);
  } finally { release(); ai.close(); command.mockRestore(); await fs.rm(root, { recursive: true, force: true }); }
});

it("orders every Gherkin step canonically and retains checks within a step", async () => {
  const { orderedScenarioSteps } = await import("../server/templates/scenario-order");
  const checks = [{step:"3",value:"then"},{step:"1",value:"given"},{step:"2",value:"first"},{step:"2",value:"second"}];
  expect(orderedScenarioSteps(["1","2","3"], checks).map((check) => check.value)).toEqual(["given","first","second","then"]);
  expect(() => orderedScenarioSteps(["1","2"], [{step:"1"}])).toThrow("explicit check");
  expect(() => orderedScenarioSteps(["1"], [{step:"1"},{step:"2"}])).toThrow("unknown");
});

it("does not initialize a run cancelled before adapter invocation", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "studio-reconstructed-pre-cancel-"));
  const ai = new LocalAI(root);
  const command = vi.spyOn(processTools, "runCommand");
  try {
    await ai.cancel("queued-run");
    const project = blankProject("Cancelled before setup");
    await expect(ai.generate({id:"queued-run",base:"base",adapter:"cursor",prompt:"fixture",status:"queued",events:[]}, {...project,id:"base",at:"now",label:"base"}, async () => {})).rejects.toThrow("Cancelled");
    expect(command).not.toHaveBeenCalled();
    expect(await fs.readdir(root)).toEqual([]);
  } finally { ai.close(); command.mockRestore(); await fs.rm(root,{recursive:true,force:true}); }
});
