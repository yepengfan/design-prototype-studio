import { it, expect } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCommand } from "../server/core/process";
import { sandboxProfile, generationPrompt } from "../server/core/ai";
import { blankProject } from "../server/core/project";
it.skipIf(process.platform !== "darwin")(
  "allows project and private runtime writes while denying outside files and symlink escapes",
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "studio-boundary-"));
    const project = path.join(root, "project");
    const runtime = path.join(root, "runtime");
    const outside = path.join(root, "outside");
    await Promise.all([project, runtime, outside].map((p) => fs.mkdir(p)));
    await fs.symlink(outside, path.join(project, "escape"));
    const profile = sandboxProfile(
      await fs.realpath(project),
      await fs.realpath(runtime),
    );
    const script = `const fs=require('node:fs');const paths=JSON.parse(process.argv[1]);let result=[];for(const p of paths){try{fs.writeFileSync(p,'probe');result.push(true)}catch{result.push(false)}}console.log(JSON.stringify(result))`;
    try {
      const result = await runCommand(
        "/usr/bin/sandbox-exec",
        [
          "-p",
          profile,
          process.execPath,
          "-e",
          script,
          JSON.stringify([
            path.join(project, "page.tsx"),
            path.join(runtime, "state"),
            path.join(outside, "blocked"),
            path.join(project, "escape", "blocked"),
          ]),
        ],
        project,
      );
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual([true, true, false, false]);
      expect(await fs.readdir(outside)).toEqual([]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);
it("emits only the selected project context into the intentional model prompt interface", () => {
  const p = blankProject("Synthetic");
  p.files["requirements/selected.feature"] =
    "Feature: Notice\nScenario: Read\nGiven a notice exists\n";
  p.manifest.scope = ["requirements/selected.feature"];
  const prompt = generationPrompt(
    { ...p, id: "0".repeat(64), label: "base", at: "2026-01-01" },
    "Change spacing",
  );
  // This is a generated model-input contract, not evidence that the model obeys it.
  expect(prompt).toContain("selected.feature");
  expect(prompt).toContain("Change spacing");
  expect(prompt).not.toContain(process.cwd());
});
