import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import AdmZip from "adm-zip";
import { anchors, editSource } from "../../server/core/source";
import { digest } from "../../server/core/files";
import { createApp } from "../../server/app";
import { registryFixture } from "../registry";
import { installProject } from "../../server/core/libraries";
import { prototypeFixture } from "../prototype";

test("legacy CSF source keeps controllers, providers, decorators and styles through visual, prompt and annotation editing", async ({
  browser,
}) => {
  test.setTimeout(240000);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "studio-legacy-e2e-"));
  const registry = await registryFixture(root);
  const prior = process.env.npm_config_userconfig;
  process.env.npm_config_userconfig = registry.config;
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No port");
  const origin = `http://127.0.0.1:${address.port}`;
  const studio = await createApp({
    root: path.join(root, "studio"),
    origin,
    ai: {
      async generate(run, snapshot) {
        const file = snapshot.manifest.pages[0].file;
        return {
          kind: "presentation",
          summary: run.prompt,
          files: {
            [file]: editSource(
              snapshot.files[file],
              {
                anchor: anchors(snapshot.files[file]).find(
                  (node) => node.tag === "main",
                )!.id,
                sourceHash: digest(snapshot.files[file]),
                operation: "style",
                value: { padding: run.annotation ? 64 : 56 },
              },
              [],
            ),
          },
          questions: [],
          affectedScenarios: [],
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
    const packageJson = JSON.parse(prototype.files["package.json"]);
    delete packageJson.scripts.lint;
    for (const name of ["eslint", "@eslint/js", "typescript-eslint"]) delete packageJson.devDependencies[name];
    prototype.files["package.json"] = JSON.stringify(packageJson, null, 2);
    delete prototype.files["eslint.config.js"];
    prototype.files["package-lock.json"] = await installProject(path.join(root, "original"), prototype.files, prototype.manifest.libraries, true);
    const zip = new AdmZip();
    const supplied: Record<string, string> = {};
    for (const [file, content] of Object.entries(prototype.files)) {
      if (file === "studio.project.json") continue;
      if (file.endsWith(".feature")) {
        supplied[file] = content;
        continue;
      }
      zip.addFile(file, Buffer.from(content));
    }
    const archive = zip.toBuffer().toString("base64");
    expect((await request("/import", { archive }, true)).error).toContain(
      "Gherkin",
    );
    const markdownSupplied = Object.fromEntries(
      Object.entries(supplied).map(([file, source]) => [
        file.replace(/\.feature$/, ".md"),
        "Submitted requirements\n```gherkin\n" + source + "\n```\n",
      ]),
    );
    const inspected = await request("/import", {
      archive,
      requirements: markdownSupplied,
    });
    expect(inspected.markdownProposals).toHaveLength(1);
    expect(
      (
        await request(
          "/import",
          { archive, requirements: markdownSupplied, confirm: true },
          true,
        )
      ).error,
    ).toContain("Review the extracted Markdown");
    expect(inspected.native).toBe(false);
    expect(inspected.diagnostics).toEqual([]);
    expect(inspected.manifest.scenarios).toEqual([]);
    const imported = await request("/import", {
      archive,
      requirements: markdownSupplied,
      confirm: true,
      confirmMarkdown: true,
      previewStories: { "page-1": "src/Notice.stories.tsx#Success" },
    });
    const id = imported.state.id;
    expect(
      imported.snapshot.manifest.libraries
        .map((library: { name: string }) => library.name)
        .sort(),
    ).toEqual(["@studio-test/controls", "@studio-test/layout"]);
    for (const file of [
      "src/pages/Page.tsx",
      "src/data/notices.ts",
      ".storybook/preview.tsx",
      "src/main.tsx",
      "src/providers.tsx",
      "src/styles.css",
      "src/Notice.stories.tsx",
      "package.json",
      "package-lock.json",
    ])
      expect(imported.snapshot.files[file]).toBe(prototype.files[file]);
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const experience = async (padding: string) => {
      const preview = await request(`/projects/${id}/preview`, {
        page: "page-1",
      });
      await page.goto(preview.url);
      await expect(
        page.getByRole("heading", { name: "Notice workspace" }),
      ).toBeVisible();
      await expect(page.locator(".story-frame main")).toHaveCSS(
        "padding-left",
        padding,
      );
      await page.getByRole("button", { name: "Acknowledge" }).click();
      await expect(page.getByRole("alert")).toHaveText("Name is required");
      await page.getByRole("textbox", { name: "Your name" }).fill("Alex");
      await page.getByRole("button", { name: "Acknowledge" }).click();
      await expect(
        page.getByRole("status", { name: "Acknowledgement" }),
      ).toHaveText("Acknowledged Alex");
      studio.previews.stop(preview.id);
    };
    await experience("40px");
    let data = await request(`/projects/${id}`);
    const status = data.outline[0].nodes.find((node: { tag: string; props: Record<string, unknown> }) => node.tag === "p" && node.props.role === "status");
    const removal = await request(`/projects/${id}/edit`, {
      base: data.snapshot.id, page: "page-1",
      edit: { anchor: status.id, sourceHash: data.outline[0].hash, operation: "remove" },
    }, true);
    expect(removal.error).toContain("required interaction");
    expect((await request(`/projects/${id}`)).snapshot.id).toBe(data.snapshot.id);
    const main = data.outline[0].nodes.find(
      (node: { tag: string }) => node.tag === "main",
    );
    await request(`/projects/${id}/edit`, {
      base: data.snapshot.id,
      page: "page-1",
      edit: {
        anchor: main.id,
        sourceHash: data.outline[0].hash,
        operation: "style",
        value: { padding: 48 },
      },
    });
    await experience("48px");
    const complete = async (run: { id: string }) => {
      await expect
        .poll(
          async () => {
            data = await request(`/projects/${id}`);
            return data.state.runs.find(
              (item: { id: string }) => item.id === run.id,
            ).status;
          },
          { timeout: 120000 },
        )
        .toBe("review");
      const diff = await request(`/projects/${id}/runs/${run.id}/diff`);
      expect(diff.requirementsDiff).toEqual([]);
      await request(`/projects/${id}/runs/${run.id}/apply`, {});
    };
    const prompt = await request(`/projects/${id}/generate`, {
      adapter: "codex",
      prompt: "Prompt: increase padding only",
    });
    await complete(prompt);
    await experience("56px");
    data = await request(`/projects/${id}`);
    const note = await request(`/projects/${id}/annotations`, {
      page: "page-1",
      target: data.outline[0].nodes.find(
        (node: { tag: string }) => node.tag === "main",
      ).id,
      text: "Increase padding only",
    });
    const noteId = note.annotations[0].id;
    await request(`/projects/${id}/annotations/approve`, { ids: [noteId] });
    const submitted = await request(`/projects/${id}/annotations/submit`, {
      adapter: "cursor",
    });
    await complete(submitted.jobs[0]);
    await experience("64px");
    data = await request(`/projects/${id}`);
    for (const file of [
      "src/data/notices.ts",
      ".storybook/preview.tsx",
      "src/main.tsx",
      "src/providers.tsx",
      "src/styles.css",
      "src/Notice.stories.tsx",
    ])
      expect(data.snapshot.files[file]).toBe(prototype.files[file]);
    expect(errors).toEqual([]);
    await page.screenshot({
      path: test.info().outputPath("legacy-edited.png"),
      fullPage: true,
    });
    await page.close();
    const catalog = await request(`/projects/${id}/stories`);
    expect(
      catalog.some(
        (story: { story: string }) =>
          story.story === "src/Notice.stories.tsx#Success",
      ),
    ).toBe(true);
    await request(
      `/projects/${id}/scenarios/${data.scope.scenarios[0].id}/map`,
      {
        base: data.snapshot.id,
        page: "page-1",
        story: "src/Notice.stories.tsx#Success",
      },
    );
    data = await request(`/projects/${id}`);
    expect(data.snapshot.manifest.scenarios[0]).toMatchObject({
      story: "src/Notice.stories.tsx#Success",
      accepted: false,
      steps: [],
    });
  } finally {
    await studio.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await registry.close();
    if (prior === undefined) delete process.env.npm_config_userconfig;
    else process.env.npm_config_userconfig = prior;
    await fs.rm(root, { recursive: true, force: true });
  }
});
