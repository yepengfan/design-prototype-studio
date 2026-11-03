import { spawn, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import express from "express";
import {
  StudioError,
  type Snapshot,
  type Files,
  type Component,
} from "./contracts.js";
import { chromium } from "@playwright/test";
import { installProject } from "./libraries.js";
import { stopChild, runCommand } from "./process.js";
import { componentReference } from "./component-reference.js";
import { providerSetup, projectSpecifier } from "./providers.js";
import { writeFiles } from "./files.js";

export type Preview = {
  id: string;
  root: string;
  url: string;
  child: ChildProcess;
  revision: string;
};
export class Previews {
  private previews = new Map<string, Preview>();
  private storybooks = new Map<string, Server>();
  constructor(
    readonly root: string,
    readonly origin: string,
  ) {}
  async materialize(snapshot: Snapshot, key = snapshot.id) {
    await fs.mkdir(path.join(this.root, key), { recursive: true });
    const root = await fs.realpath(path.join(this.root, key));
    const marker = path.join(root, ".installed");
    if ((await fs.readFile(marker, "utf8").catch(() => "")) === snapshot.id)
      return root;
    await fs.mkdir(root, { recursive: true });
    await installProject(root, snapshot.files, snapshot.manifest.libraries);
    await fs.writeFile(marker, snapshot.id);
    return root;
  }
  async verify(snapshot: Snapshot, build = false) {
    const root = await this.materialize(snapshot);
    const result = await runCommand(
      path.join(root, "node_modules", ".bin", "tsc"),
      ["--noEmit"],
      root,
    );
    if (result.code)
      throw new StudioError(
        "The proposed source does not typecheck. Accepted work was kept.",
        422,
        result.stdout.slice(0, 12000),
      );
    if (build) {
      const built = await runCommand("npm", ["run", "build"], root);
      if (built.code)
        throw new StudioError(
          "React build failed. The project is not deliverable.",
          422,
          built.stdout.slice(0, 12000),
        );
      const stories = await runCommand(
        "npm",
        ["run", "build-storybook", "--", "--quiet"],
        root,
        { timeout: 180_000 },
      );
      if (stories.code)
        throw new StudioError(
          "Storybook build failed. The project is not deliverable.",
          422,
          stories.stdout.slice(0, 12000),
        );
    }
  }
  async start(
    snapshot: Snapshot,
    scenario?: string,
    componentPreview?: {
      package: string;
      export: string;
      props: Record<string, unknown>;
      children?: string;
      styles: string[];
      provider?: string;
    },
    pageId?: string,
    gallery?: Component[],
  ) {
    const id = randomUUID();
    const root = await this.materialize(snapshot, id);
    let launcher: string;
    let galleryFile: { path: string; source: string } | undefined;
    if (gallery) {
      const imports: string[] = [];
      const examples: string[] = [];
      gallery.forEach((component, i) => {
        const reference = componentReference(component.export);
        imports.push(
          `import { ${reference.root} as Root${i} } from ${JSON.stringify(component.package)}; const C${i} = Root${i}${reference.suffix};`,
        );
        imports.push(
          ...component.styles.map(
            (style) => `import ${JSON.stringify(style)};`,
          ),
        );
        const provider = providerSetup(
          component.provider,
          "../",
          `Provider${i}`,
        );
        imports.push(provider.imports);
        component.examples.forEach((example, j) =>
          examples.push(
            `<section aria-label=${JSON.stringify(component.package + "/" + component.name + "/" + example.name)} key=${JSON.stringify(i + "-" + j)}><h2>{${JSON.stringify(component.name + " · " + example.name)}}</h2>${provider.wrap(`<C${i} {...${JSON.stringify(example.props)}}>${component.children ? `{${JSON.stringify(example.children ?? "")}}` : ""}</C${i}>`)}</section>`,
          ),
        );
      });
      galleryFile = {
        path: `src/studio-gallery-${id}.tsx`,
        source: `${imports.join("\n")}\nexport default function Gallery(){return <main>${examples.join("\n")}</main>}`,
      };
      launcher = `import Page from ${JSON.stringify("./" + galleryFile.path)};`;
    } else if (componentPreview) {
      const reference = componentReference(componentPreview.export);
      launcher = `import { ${reference.root} as RootExample } from ${JSON.stringify(componentPreview.package)};\nconst Example = RootExample${reference.suffix};\n${componentPreview.styles.map((s) => `import ${JSON.stringify(projectSpecifier(s, "./"))};`).join("\n")}\nconst Page = () => <Example {...${JSON.stringify(componentPreview.props)}}>{${JSON.stringify(componentPreview.children ?? "")}}</Example>;\n`;
    } else {
      const binding = snapshot.manifest.scenarios.find(
        (s) => s.scenario === scenario,
      );
      if (binding) {
        const [file, story] = binding.story.split("#");
        if (!snapshot.files[file] || !story)
          throw new StudioError(
            "This scenario needs its matching Storybook story before preview.",
          );
        const previewConfig = snapshot.files[".storybook/preview.tsx"]
          ? "../.storybook/preview"
          : snapshot.files[".storybook/preview.ts"]
            ? "../.storybook/preview"
            : undefined;
        launcher = `import { composeStories, setProjectAnnotations } from '@storybook/react-vite';\nimport * as stories from ${JSON.stringify("../" + file.replace(/\.tsx?$/, ""))};\n${previewConfig ? `import * as annotations from ${JSON.stringify(previewConfig)}; setProjectAnnotations(annotations);` : ""}\nconst Page = composeStories(stories)[${JSON.stringify(story)}];\n`;
      } else {
        const page =
          snapshot.manifest.pages.find((p) => p.id === pageId) ??
          snapshot.manifest.pages[0];
        if (!page) throw new StudioError("Create a page before previewing.");
        launcher = `import { ${page.export === "default" ? "default" : page.export} as Page } from ${JSON.stringify("../" + page.file.replace(/\.tsx?$/, ""))};\n`;
      }
    }
    const provider = providerSetup(
      componentPreview?.provider ??
        (scenario ? undefined : snapshot.manifest.provider),
      "./",
    );
    const files: Files = {
      "studio-preview.tsx": `import React from 'react';\nimport { createRoot } from 'react-dom/client';\n${launcher}\n${snapshot.manifest.styles.map((s) => `import ${JSON.stringify(projectSpecifier(s, "./"))};`).join("\n")}\n${provider.imports}createRoot(document.getElementById('root')!).render(${provider.wrap("<Page />")});\n`,
      "studio-preview.html":
        '<!doctype html><html><head><meta charset="UTF-8"/><title>Scenario preview</title></head><body style="margin:0"><div id="root"></div><script type="module" src="/studio-preview.tsx"></script></body></html>',
    };
    if (galleryFile) files[galleryFile.path] = galleryFile.source;
    // launcher lives at project root, so project source imports are root-relative.
    files["studio-preview.tsx"] = files["studio-preview.tsx"]
      .replaceAll('"../src/', '"./src/')
      .replaceAll('"../.storybook/', '"./.storybook/');
    await writeFiles(root, files);
    if (galleryFile) {
      const checked = await runCommand(
        path.join(root, "node_modules", ".bin", "tsc"),
        ["--noEmit"],
        root,
      );
      if (checked.code)
        throw new StudioError(
          "Published component examples do not match this release's exported types or required setup. Ask the library maintainer for a corrected release.",
          422,
          checked.stdout.slice(0, 12000),
        );
    }
    const worker = fileURLToPath(
      new URL("../preview-worker.ts", import.meta.url),
    );
    const child = spawn(
      process.execPath,
      ["--import", "tsx", worker, root, this.origin],
      {
        cwd: fileURLToPath(new URL("../..", import.meta.url)),
        detached: true,
        env: { PATH: process.env.PATH, NODE_ENV: "development", HOME: root },
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      },
    );
    const url = await new Promise<string>((resolve, reject) => {
      let output = "";
      const timer = setTimeout(() => {
        stopChild(child);
        reject(
          new StudioError(
            "The preview did not start. Check the project configuration.",
            422,
          ),
        );
      }, 30_000);
      child.stdout!.on("data", (chunk) => {
        output += chunk;
        for (const line of output.split("\n"))
          try {
            const event = JSON.parse(line);
            if (event.ready) {
              clearTimeout(timer);
              resolve(event.url);
            }
          } catch {
            /* Vite logs are not protocol */
          }
      });
      child.once("error", () => {
        clearTimeout(timer);
        reject(new StudioError("The preview process could not start."));
      });
      child.once("exit", () => {
        clearTimeout(timer);
        reject(
          new StudioError(
            "The preview stopped before it was ready. Check Vite configuration and dependency closure.",
            422,
          ),
        );
      });
      child.stderr!.resume();
    });
    const preview = {
      id,
      root,
      url: url + "/studio-preview.html",
      child,
      revision: snapshot.id,
    };
    this.previews.set(id, preview);
    return { id, url: preview.url, revision: preview.revision };
  }
  async verifyComponents(snapshot: Snapshot, components: Component[]) {
    const preview = await this.start(
      snapshot,
      undefined,
      undefined,
      undefined,
      components,
    );
    const browser = await chromium.launch({
      headless: true,
      executablePath: process.env.STUDIO_CHROME,
    });
    const errors: string[] = [];
    try {
      const page = await browser.newPage();
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error") errors.push(message.text());
      });
      await page.goto(preview.url);
      for (const component of components)
        for (const example of component.examples)
          await page
            .getByRole("region", {
              name:
                component.package + "/" + component.name + "/" + example.name,
              exact: true,
            })
            .waitFor();
      if (errors.length)
        throw new StudioError(
          "Published component previews reported runtime errors. Ask the maintainer to fix the affected exports, providers or styles.",
          422,
          errors,
        );
      return preview;
    } catch (error) {
      this.stop(preview.id);
      throw error;
    } finally {
      await browser.close();
    }
  }
  async startStorybook(snapshot: Snapshot) {
    const root = await this.materialize(snapshot);
    const output = path.join(root, "storybook-static");
    const index = JSON.parse(
      await fs.readFile(path.join(output, "index.json"), "utf8"),
    );
    const app = express();
    app.disable("x-powered-by");
    app.use(express.static(output, { dotfiles: "deny" }));
    const server = createServer(app);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string")
      throw new StudioError("Storybook did not start.");
    const id = randomUUID();
    this.storybooks.set(id, server);
    const stories = Object.values(
      index.entries as Record<
        string,
        { id: string; importPath: string; exportName: string; type: string }
      >,
    ).filter((e) => e.type === "story");
    return { id, url: `http://127.0.0.1:${address.port}`, stories };
  }
  stop(id: string) {
    const storybook = this.storybooks.get(id);
    if (storybook) {
      storybook.closeAllConnections();
      storybook.close();
      this.storybooks.delete(id);
    }
    const preview = this.previews.get(id);
    if (preview) {
      stopChild(preview.child);
      this.previews.delete(id);
    }
  }
  close() {
    for (const id of this.previews.keys()) this.stop(id);
    for (const id of this.storybooks.keys()) this.stop(id);
  }
}
