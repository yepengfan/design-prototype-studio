import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../../server/app";
import { registryFixture } from "../registry";
import { prototypeFixture } from "../prototype";
import { parseRequirements } from "../../server/core/requirements";
import { exportArchive } from "../../server/core/archive";
import { synchronizeRuntime } from "../../server/core/project";

test("saved and published page templates retain source and require atomic reconciliation with a new selected scope", async ({
  browser,
}) => {
  test.setTimeout(300000);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "studio-template-e2e-"));
  const registry = await registryFixture(root);
  const prior = process.env.npm_config_userconfig,
    cache = process.env.npm_config_cache;
  process.env.npm_config_userconfig = registry.config;
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No port");
  const origin = `http://127.0.0.1:${address.port}`;
  let originalScenarios: any[] = [];
  const studio = await createApp({
    root: path.join(root, "studio"),
    origin,
    ai: {
      async generate(_run, snapshot) {
        const parsed = parseRequirements(
          snapshot.files,
          snapshot.manifest.scope,
        );
        return {
          kind: "business",
          summary: "Use the selected equivalent scenarios only",
          files: Object.fromEntries(
            Object.entries(snapshot.files).filter(([file]) =>
              file.endsWith(".feature"),
            ),
          ),
          deleted: ["requirements/notices.feature"],
          manifestChanges: {
            scope: snapshot.manifest.scope,
            scenarios: parsed.scenarios.map((scenario, index) => ({
              ...originalScenarios[index],
              scenario: scenario.id,
              accepted: false,
            })),
          },
          questions: [],
          affectedScenarios: parsed.scenarios.map((scenario) => scenario.id),
        };
      },
      async cancel() {},
      close() {},
    },
  });
  server.on("request", studio.app);
  const secret = (await (await fetch(origin + "/api/session")).json()).secret;
  const request = async (
    url: string,
    body?: unknown,
    allowedFailure = false,
  ) => {
    const response = await fetch(origin + "/api" + url, {
      method: body ? "POST" : "GET",
      headers: {
        "Content-Type": "application/json",
        "X-Studio-Session": secret,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await response.json();
    if (!response.ok && !allowedFailure) throw new Error(JSON.stringify(data));
    return data;
  };
  try {
    const prototype = await prototypeFixture(
      path.join(root, "original"),
      registry.base,
    );
    originalScenarios = prototype.manifest.scenarios;
    const imported = await request("/import", {
      archive: exportArchive(prototype.files, prototype.manifest).toString(
        "base64",
      ),
      confirm: true,
    });
    const id = imported.state.id;
    const saved = await request(`/projects/${id}/template`, {
      name: "Complete notice page",
    });
    const requirements = {
      "requirements/notices.feature":
        prototype.files["requirements/notices.feature"],
    };
    const reused = await request(`/templates/${saved.id}/reuse`, {
      requirements,
      scope: prototype.manifest.scope,
      name: "Reused notice",
    });
    expect(reused.state.templateReconciliation).toBeUndefined();
    for (const [file, content] of Object.entries(prototype.files))
      if (file !== "studio.project.json")
        expect(reused.snapshot.files[file]).toBe(content);
    expect(JSON.parse(reused.snapshot.files["studio.project.json"])).toEqual(
      reused.snapshot.manifest,
    );
    const next = {
      "requirements/reused.feature":
        prototype.files["requirements/notices.feature"],
    };
    const comparison = await request(`/templates/${saved.id}/reuse`, {
      requirements: next,
      scope: ["requirements/reused.feature"],
    });
    expect(comparison.requiresReconciliation).toBe(true);
    expect(comparison.prior.scenarios).toHaveLength(4);
    expect(comparison.next.scenarios).toHaveLength(4);
    const draft = await request(`/templates/${saved.id}/reuse`, {
      requirements: next,
      scope: ["requirements/reused.feature"],
      confirm: true,
    });
    const draftId = draft.state.id;
    expect(draft.snapshot.files["requirements/notices.feature"]).toBe(
      requirements["requirements/notices.feature"],
    );
    expect(draft.snapshot.files["requirements/reused.feature"]).toBeUndefined();
    expect(
      (await request(`/projects/${draftId}/quality`, {}, true)).error,
    ).toContain("Adapt and review");
    const data = await request(`/projects/${draftId}`);
    const main = data.outline[0].nodes.find(
      (node: { tag: string }) => node.tag === "main",
    );
    expect(
      (
        await request(
          `/projects/${draftId}/edit`,
          {
            base: data.snapshot.id,
            page: "page",
            edit: {
              anchor: main.id,
              sourceHash: data.outline[0].hash,
              operation: "style",
              value: { padding: 60 },
            },
          },
          true,
        )
      ).error,
    ).toContain("template");
    const run = await request(`/projects/${draftId}/generate`, {
      adapter: "codex",
      prompt:
        "Adapt to the selected equivalent scenarios, retaining all source behavior",
    });
    await expect
      .poll(
        async () =>
          (await request(`/projects/${draftId}`)).state.runs.find(
            (item: { id: string }) => item.id === run.id,
          ).status,
        { timeout: 120000 },
      )
      .toBe("review");
    const diff = await request(`/projects/${draftId}/runs/${run.id}/diff`);
    expect(
      diff.requirementsDiff.map((item: { file: string }) => item.file).sort(),
    ).toEqual(["requirements/notices.feature", "requirements/reused.feature"]);
    expect(diff.requiresConfirmation).toBe(true);
    expect(
      (await request(`/projects/${draftId}/runs/${run.id}/apply`, {}, true))
        .error,
    ).toContain("confirm");
    await request(`/projects/${draftId}/runs/${run.id}/apply`, {
      confirmRequirements: diff.hash,
    });
    let adapted = await request(`/projects/${draftId}`);
    expect(adapted.state.templateReconciliation).toBeUndefined();
    expect(
      adapted.snapshot.files["requirements/notices.feature"],
    ).toBeUndefined();
    expect(adapted.snapshot.files["requirements/reused.feature"]).toBe(
      next["requirements/reused.feature"],
    );
    expect(adapted.snapshot.files["src/pages/Page.tsx"]).toBe(
      prototype.files["src/pages/Page.tsx"],
    );
    for (const scenario of adapted.scope.scenarios) {
      await request(`/projects/${draftId}/scenarios/${scenario.id}/review`, {
        base: adapted.snapshot.id,
        accept: true,
      });
      adapted = await request(`/projects/${draftId}`);
    }
    const quality = await request(`/projects/${draftId}/quality`, {});
    expect(quality.ready).toBe(true);
    expect(
      quality.results.flatMap(
        (result: { failures: string[] }) => result.failures,
      ),
    ).toEqual([]);
    await request(`/projects/${draftId}/history`, { action: "undo" }); // Accepted requirements and source stay coherent through ordinary history.
    const afterUndo = await request(`/projects/${draftId}`);
    expect(afterUndo.snapshot.manifest.scope).toEqual([
      "requirements/reused.feature",
    ]);
    // A provider package can embed a complete native template. Its own lock entry
    // omits integrity to avoid a circular self-checksum inside its npm tarball.
    const template = structuredClone(prototype);
    const lock = JSON.parse(template.files["package-lock.json"]);
    delete lock.packages["node_modules/@studio-test/layout"].integrity;
    template.files["package-lock.json"] = JSON.stringify(lock);
    template.files = synchronizeRuntime(template.files, template.manifest);
    const dir = path.join(root, "layout");
    const manifest = JSON.parse(
      await fs.readFile(path.join(dir, "package.json"), "utf8"),
    );
    const metadata = JSON.parse(
      await fs.readFile(path.join(dir, "studio.json"), "utf8"),
    );
    metadata.templates = ["./notice-template.json"];
    const published: Record<string, string> = {
      "studio.json": JSON.stringify(metadata),
      "notice-template.json": JSON.stringify({
        files: template.files,
        manifest: template.manifest,
      }),
    };
    for (const file of ["index.js", "index.d.ts", "tokens.css"])
      published[file] = await fs.readFile(path.join(dir, file), "utf8");
    await registry.publish(manifest, published);
    process.env.npm_config_cache = path.join(root, "template-cache");
    const blank = await request("/projects", {
      name: "Library template workspace",
    });
    const admitted = await request(`/projects/${blank.state.id}/library`, {
      base: blank.snapshot.id,
      name: "@studio-test/layout",
      version: "1.0.0",
      registry: registry.base,
      trust: true,
      apply: true,
    });
    expect(admitted.snapshot.manifest.libraries[0].name).toBe(
      "@studio-test/layout",
    );
    const templates = await request("/templates");
    const libraryTemplate = templates.find((entry: { name: string }) =>
      entry.name.includes("@studio-test/layout@1.0.0"),
    );
    expect(libraryTemplate).toBeDefined();
    const fromLibrary = await request(
      `/templates/${libraryTemplate.id}/reuse`,
      { requirements, scope: prototype.manifest.scope },
    );
    expect(fromLibrary.snapshot.files["src/pages/Page.tsx"]).toBe(
      prototype.files["src/pages/Page.tsx"],
    );
    const preview = await request(`/projects/${fromLibrary.state.id}/preview`, {
      scenario: prototype.manifest.scenarios[0].scenario,
    });
    const page = await browser.newPage();
    await page.goto(preview.url);
    await expect(
      page.getByRole("heading", { name: "Notice workspace" }),
    ).toBeVisible();
    await page.screenshot({
      path: test.info().outputPath("library-template.png"),
      fullPage: true,
    });
    await page.close();
  } finally {
    await studio.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await registry.close();
    if (prior === undefined) delete process.env.npm_config_userconfig;
    else process.env.npm_config_userconfig = prior;
    if (cache === undefined) delete process.env.npm_config_cache;
    else process.env.npm_config_cache = cache;
    await fs.rm(root, { recursive: true, force: true });
  }
});
