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
import { DependencyCache } from "./dependencies.js";
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
  private controller = new AbortController();
  private pending = new Set<Promise<unknown>>();
  private starting = new Set<ChildProcess>();
  private dependencies: DependencyCache;
  private ensureOpen() {
    if (this.controller.signal.aborted)
      throw new StudioError(
        "Studio is closing. Reopen it before starting another preview.",
        409,
      );
  }
  private track<T>(job: Promise<T>) {
    this.pending.add(job);
    void job.finally(() => this.pending.delete(job)).catch(() => {});
    return job;
  }
  private command(...args: Parameters<typeof runCommand>) {
    const [command, argv, cwd, options] = args;
    return runCommand(command, argv, cwd, {
      ...options,
      signal: this.controller.signal,
    });
  }
  async materialize(...args: Parameters<Previews["materializeInternal"]>) {
    this.ensureOpen();
    return this.track(this.materializeInternal(...args));
  }
  async verify(...args: Parameters<Previews["verifyInternal"]>) {
    this.ensureOpen();
    return this.track(this.verifyInternal(...args));
  }
  async start(...args: Parameters<Previews["startInternal"]>) {
    this.ensureOpen();
    return this.track(this.startInternal(...args));
  }
  async verifyComponents(
    ...args: Parameters<Previews["verifyComponentsInternal"]>
  ) {
    this.ensureOpen();
    return this.track(this.verifyComponentsInternal(...args));
  }
  async startStorybook(
    ...args: Parameters<Previews["startStorybookInternal"]>
  ) {
    this.ensureOpen();
    return this.track(this.startStorybookInternal(...args));
  }
  private storybooks = new Map<string, Server>();
  constructor(
    readonly root: string,
    readonly origin: string,
  ) {
    this.dependencies = new DependencyCache(
      path.join(root, "dependencies"),
      this.controller.signal,
    );
  }
  private async materializeInternal(
    snapshot: Snapshot,
    key = snapshot.id,
  ): Promise<string> {
    await fs.mkdir(path.join(this.root, key), { recursive: true });
    const root = await fs.realpath(path.join(this.root, key));
    const marker = path.join(root, ".installed");
    if ((await fs.readFile(marker, "utf8").catch(() => "")) === snapshot.id)
      return root;
    await fs.mkdir(root, { recursive: true });
    await this.dependencies.materialize(root, snapshot);
    this.ensureOpen();
    await fs.writeFile(marker, snapshot.id);
    return root;
  }
  private async verifyInternal(
    snapshot: Snapshot,
    build = false,
  ): Promise<void> {
    const root = await this.materialize(snapshot);
    const result = await this.command(
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
      const built = await this.command("npm", ["run", "build"], root);
      if (built.code)
        throw new StudioError(
          "React build failed. The project is not deliverable.",
          422,
          built.stdout.slice(0, 12000),
        );
      const stories = await this.command(
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
  private async startInternal(
    snapshot: Snapshot,
    scenario?: string,
    componentPreview?: {
      package: string;
      export: string;
      props: Record<string, unknown>;
      children?: string;
      styles: string[];
      provider?: string;
      story?: { file: string; export: string; annotations?: string };
    },
    pageId?: string,
    gallery?: Component[],
  ) {
    const id = randomUUID();
    const root = await this.materialize(snapshot, id);
    let launcher: string;
    let composed = false;
    let galleryFile: { path: string; source: string } | undefined;
    if (gallery) {
      const imports: string[] = [];
      const examples: string[] = [];
      if (
        gallery.some((component) =>
          component.examples.some((example) => example.story),
        )
      )
        imports.push(
          "import {composeStories as composeLibraryStories,setProjectAnnotations as setLibraryAnnotations} from '@storybook/react-vite';",
        );
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
        component.examples.forEach((example, j) => {
          let content = `<C${i} {...${JSON.stringify(example.props)}}>${component.children ? `{${JSON.stringify(example.children ?? "")}}` : ""}</C${i}>`;
          if (example.story) {
            const module =
              "../node_modules/" +
              component.package +
              "/" +
              example.story.file.replace(/\.[tj]sx?$/, "");
            imports.push(
              `import * as StateModule${i}_${j} from ${JSON.stringify(module)};`,
            );
            let annotations = "{}";
            if (example.story.annotations) {
              imports.push(
                `import * as StateAnnotations${i}_${j} from ${JSON.stringify("../node_modules/" + component.package + "/" + example.story.annotations.replace(/\.[tj]sx?$/, ""))};`,
              );
              annotations = `StateAnnotations${i}_${j}`;
            }
            imports.push(
              `setLibraryAnnotations(${annotations});const State${i}_${j}=composeLibraryStories(StateModule${i}_${j})[${JSON.stringify(example.story.export)}];`,
            );
            content = `<State${i}_${j} />`;
          }
          examples.push(
            `<section aria-label=${JSON.stringify(component.package + "/" + component.name + "/" + example.name)} key=${JSON.stringify(i + "-" + j)}><h2>{${JSON.stringify(component.name + " · " + example.name)}}</h2>${provider.wrap(content)}</section>`,
          );
        });
      });
      galleryFile = {
        path: `src/studio-gallery-${id}.tsx`,
        source: `${imports.join("\n")}\nexport default function Gallery(){return <main>${examples.join("\n")}</main>}`,
      };
      launcher = `import Page from ${JSON.stringify("./" + galleryFile.path)};`;
    } else if (componentPreview) {
      const reference = componentReference(componentPreview.export);
      if (componentPreview.story) {
        const story = componentPreview.story;
        launcher = `import {composeStories,setProjectAnnotations} from '@storybook/react-vite';
import * as states from ${JSON.stringify("./node_modules/" + componentPreview.package + "/" + story.file.replace(/\.[tj]sx?$/, ""))};
${story.annotations ? `import * as annotations from ${JSON.stringify("./node_modules/" + componentPreview.package + "/" + story.annotations.replace(/\.[tj]sx?$/, ""))};setProjectAnnotations(annotations);` : "setProjectAnnotations({});"}
const Page=composeStories(states)[${JSON.stringify(story.export)}];`;
      } else {
        launcher = `import { ${reference.root} as RootExample } from ${JSON.stringify(componentPreview.package)};\nconst Example = RootExample${reference.suffix};\n${componentPreview.styles.map((s) => `import ${JSON.stringify(projectSpecifier(s, "./"))};`).join("\n")}\nconst Page = () => <Example {...${JSON.stringify(componentPreview.props)}}>{${JSON.stringify(componentPreview.children ?? "")}}</Example>;\n`;
      }
    } else {
      const binding = snapshot.manifest.scenarios.find(
        (s) => s.scenario === scenario,
      );
      if (scenario && !binding)
        throw new StudioError(
          "This scenario needs its mapped story and initial state before previewing.",
        );
      const page =
        snapshot.manifest.pages.find((page) => page.id === pageId) ??
        snapshot.manifest.pages[0];
      const chosenStory = binding?.story ?? page?.previewStory;
      if (chosenStory) {
        composed = true;
        const [file, story] = chosenStory.split("#");
        if (!snapshot.files[file] || !story)
          throw new StudioError(
            "This preview needs its matching original Storybook story.",
          );
        const previewConfig = [
          ".storybook/preview.tsx",
          ".storybook/preview.ts",
          ".storybook/preview.jsx",
          ".storybook/preview.js",
        ].find((file) => snapshot.files[file]);
        launcher = `import { composeStories, setProjectAnnotations } from '@storybook/react-vite';
import * as stories from ${JSON.stringify("./" + file.replace(/\.[tj]sx?$/, ""))};
${previewConfig ? `import * as annotations from ${JSON.stringify("./" + previewConfig.replace(/\.[tj]sx?$/, ""))}; setProjectAnnotations(annotations);` : ""}
const Page = composeStories(stories)[${JSON.stringify(story)}];
`;
      } else {
        if (!page) throw new StudioError("Create a page before previewing.");
        launcher = `import { ${page.export === "default" ? "default" : page.export} as Page } from ${JSON.stringify("./" + page.file.replace(/\.[tj]sx?$/, ""))};\n`;
      }
    }
    const provider = providerSetup(
      componentPreview?.provider ??
        (composed ? undefined : snapshot.manifest.provider),
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
      const checked = await this.command(
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
    const dependencyRoot = path.dirname(
      await fs.realpath(path.join(root, "node_modules/.bin")),
    );
    this.ensureOpen();
    const child = spawn(
      process.execPath,
      ["--import", "tsx", worker, root, this.origin, dependencyRoot],
      {
        cwd: fileURLToPath(new URL("../..", import.meta.url)),
        detached: true,
        env: { PATH: process.env.PATH, NODE_ENV: "development", HOME: root },
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      },
    );
    this.starting.add(child);
    child.once("exit", () => this.starting.delete(child));
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
    this.ensureOpen();
    this.previews.set(id, preview);
    this.starting.delete(child);
    return { id, url: preview.url, revision: preview.revision };
  }
  private async verifyComponentsInternal(
    snapshot: Snapshot,
    components: Component[],
  ) {
    const preview = await this.start(
      snapshot,
      undefined,
      undefined,
      undefined,
      components,
    );
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    const errors: string[] = [];
    let failRuntime!: (error: Error) => void;
    const runtimeFailure = new Promise<never>((_resolve, reject) => {
      failRuntime = reject;
    });
    void runtimeFailure.catch(() => {});
    const reportRuntime = (message: string) => {
      errors.push(message);
      failRuntime(new Error("Published example failed in the browser"));
    };
    try {
      browser = await chromium.launch({
        headless: true,
        executablePath: process.env.STUDIO_CHROME,
      });
      const page = await browser.newPage();
      page.on("pageerror", (error) => reportRuntime(error.message));
      page.on("console", (message) => {
        if (message.type() === "error") reportRuntime(message.text());
      });
      await page.goto(preview.url);
      for (const component of components)
        for (const example of component.examples)
          await Promise.race([
            runtimeFailure,
            page
              .getByRole("region", {
                name:
                  component.package + "/" + component.name + "/" + example.name,
                exact: true,
              })
              .waitFor({ timeout: 15000 }),
          ]);
      if (errors.length) throw new Error("Published example failed");
      return preview;
    } catch (error) {
      this.stop(preview.id);
      if (errors.length)
        throw new StudioError(
          "Published component previews reported runtime errors. Ask the maintainer to fix the affected exports, providers or styles.",
          422,
          errors,
        );
      if (!browser)
        throw new StudioError(
          "The preview browser could not start. Install Chromium with npx playwright install chromium, then retry this library preview.",
          503,
        );
      throw new StudioError(
        "Published common-state examples could not render. Ask the maintainer to check this release's exports, required setup and examples.",
        422,
        error instanceof StudioError ? error.message : undefined,
      );
    } finally {
      await browser?.close();
    }
  }

  private async startStorybookInternal(snapshot: Snapshot) {
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
  async close() {
    this.controller.abort();
    const children = new Set([
      ...this.starting,
      ...[...this.previews.values()].map((preview) => preview.child),
    ]);
    const stopped = [...children].map(
      (child) =>
        new Promise<void>((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) {
            resolve();
            return;
          }
          child.once("exit", () => resolve());
          child.once("error", () => resolve());
          stopChild(child);
        }),
    );
    for (const id of this.previews.keys()) this.stop(id);
    for (const id of this.storybooks.keys()) this.stop(id);
    await Promise.allSettled([...this.pending, ...stopped]);
  }
}
