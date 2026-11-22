import { promises as fs } from "node:fs";
import path from "node:path";
import { compile } from "tailwindcss";
import { Scanner } from "@tailwindcss/oxide";
import { create } from "enhanced-resolve";
import * as esbuild from "esbuild";
import { config, paths } from "./config.js";
import { StudioError } from "./errors.js";
import type { ResolvedFile } from "./sources/registry.js";

export type PreviewBuild = {
  files: ResolvedFile[];
  /** Base stylesheet produced from the design system's own theme payload. */
  styles: string;
  /** Project-relative path of the generated page module. */
  entryModule: string;
};

const annotationStyles = `
/* Studio annotation mode: selecting an element takes a note instead of acting. */
body.studio-annotating,
body.studio-annotating * {
  cursor: crosshair !important;
}
body.studio-annotating [data-studio-anchor]:hover {
  outline: 2px solid var(--ring, #7357cf);
  outline-offset: 2px;
}
`;

/** Writes a generated project to disk, then bundles it for the preview iframe. */
export async function buildPreview(projectId: string, build: PreviewBuild): Promise<void> {
  const root = paths.project(projectId);
  const source = paths.projectSource(projectId);
  await fs.rm(path.join(source, "registry"), { recursive: true, force: true });
  await fs.mkdir(source, { recursive: true });

  for (const file of build.files) await writeFile(root, file.path, file.content);
  await writeFile(root, "src/lib/utils.ts", utilsSource);
  await writeFile(root, "src/preview/bridge.ts", await readRuntime("bridge.ts"));
  await writeFile(root, "src/preview/main.tsx", mainSource(build.entryModule));
  await writeFile(root, "src/styles.css", `${build.styles}\n@source "./";\n${annotationStyles}`);
  const assertAllowedFile = await previewFileBoundary(root, build.files);
  const output = await fs.mkdtemp(path.join(root, "preview-build-"));
  try {
    await bundle(root, output, assertAllowedFile);
    await compileStyles(root, output, build.files, assertAllowedFile);
    let componentCss = "";
    try {
      componentCss = await fs.readFile(path.join(output, "preview.css"), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await fs.appendFile(path.join(output, "preview.theme.css"), `\n${componentCss}`);
    const dist = paths.projectDist(projectId);
    await fs.mkdir(dist, { recursive: true });
    const version = path.basename(output);
    await fs.rename(output, path.join(dist, version));
    const pendingIndex = path.join(root, "preview-index.html");
    await fs.writeFile(pendingIndex, indexHtml.replaceAll("./preview.", `./${version}/preview.`));
    await fs.rename(pendingIndex, path.join(dist, "index.html"));
  } finally {
    await fs.rm(output, { recursive: true, force: true });
  }
}

async function previewFileBoundary(root: string, files: ResolvedFile[]): Promise<(file: string) => Promise<void>> {
  const canonicalRoot = await fs.realpath(root);
  const generated = new Set([
    ...files.map((file) => file.path),
    "src/lib/utils.ts", "src/preview/bridge.ts", "src/preview/main.tsx", "src/styles.css",
  ].map((file) => path.resolve(canonicalRoot, file)));
  const dependencies: string[] = [];
  for (const directory of [path.join(root, "node_modules"), path.join(config.repoRoot, "node_modules")]) {
    try {
      dependencies.push(await fs.realpath(directory));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return async (file) => {
    const resolved = await fs.realpath(file);
    if (!generated.has(resolved) && !dependencies.some((directory) => resolved.startsWith(directory + path.sep)))
      throw new StudioError(`Preview imports must resolve to generated sources or dependency packages: ${file}`, 422);
  };
}

async function bundle(root: string, output: string, assertAllowedFile: (file: string) => Promise<void>): Promise<void> {
  const src = path.join(root, "src");
  try {
    await esbuild.build({
      absWorkingDir: root,
      entryPoints: [path.join(src, "preview", "main.tsx")],
      outfile: path.join(output, "preview.js"),
      bundle: true,
      format: "iife",
      platform: "browser",
      target: ["es2022"],
      jsx: "automatic",
      loader: { ".json": "json", ".svg": "dataurl" },
      alias: { "@": src, cn: path.join(src, "lib", "utils.ts"), ...reactAliases() },
      nodePaths: [path.join(root, "node_modules"), path.join(config.repoRoot, "node_modules")],
      define: { "process.env.NODE_ENV": '"development"' },
      logLevel: "silent",
      plugins: [{
        name: "preview-file-boundary",
        setup(build) {
          build.onLoad({ filter: /.*/, namespace: "file" }, async (args) => {
            await assertAllowedFile(args.path);
            return undefined;
          });
        },
      }],
    });
  } catch (error) {
    throw new StudioError(buildFailure(error), 422);
  }
}

/**
 * Previews render with the Studio's own React.
 *
 * Installing a design system's runtime dependencies into a project can bring a
 * second copy of React with it, and two copies break hooks the moment a
 * component from each copy meets in one tree. Pinning both packages to the
 * Studio's installation is what a bundler's `dedupe` setting does.
 */
function reactAliases(): Record<string, string> {
  const modules = path.join(config.repoRoot, "node_modules");
  return { react: path.join(modules, "react"), "react-dom": path.join(modules, "react-dom") };
}

async function compileStyles(
  root: string,
  output: string,
  files: ResolvedFile[],
  assertAllowedFile: (file: string) => Promise<void>,
): Promise<void> {
  try {
    const resolveCss = create.sync({
      extensions: [".css"], mainFields: ["style"], conditionNames: ["style"],
      modules: ["node_modules", path.join(config.repoRoot, "node_modules")],
    });
    const compiler = await compile(await fs.readFile(path.join(root, "src/styles.css"), "utf8"), {
      base: path.join(root, "src"),
      loadModule: async () => { throw new Error("JavaScript plugins and configuration are not allowed in preview styles."); },
      loadStylesheet: async (id, base) => {
        const resolved = resolveCss(base, id);
        if (!resolved) throw new Error(`Could not resolve stylesheet ${id}`);
        await assertAllowedFile(resolved);
        return { path: resolved, base: path.dirname(resolved), content: await fs.readFile(resolved, "utf8") };
      },
    });
    const scanner = new Scanner({});
    const candidates = scanner.scanFiles(files.map((file) => ({
      content: file.content, extension: path.extname(file.path).slice(1),
    })));
    await fs.writeFile(path.join(output, "preview.theme.css"), compiler.build(candidates));
  } catch (error) {
    throw new StudioError(
      `The preview stylesheet could not be compiled. ${error instanceof Error ? error.message : "Check the design system's base styles."}`,
      422,
    );
  }
}

function buildFailure(error: unknown): string {
  const errors = (error as { errors?: esbuild.Message[] }).errors ?? [];
  const first = errors[0];
  if (!first) return `The preview could not be built: ${error instanceof Error ? error.message : String(error)}`;
  const where = first.location ? ` (${first.location.file}:${first.location.line})` : "";
  return `The preview could not be built${where}: ${first.text}`;
}

async function writeFile(root: string, relative: string, content: string): Promise<void> {
  const target = path.resolve(root, relative);
  if (!target.startsWith(root + path.sep))
    throw new StudioError(`A design system tried to write outside the project: ${relative}`);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content);
}

async function readRuntime(name: string): Promise<string> {
  return fs.readFile(path.join(config.repoRoot, "preview-runtime", name), "utf8");
}

function mainSource(entryModule: string): string {
  return `import { createRoot } from "react-dom/client"
import { installAnnotationBridge } from "./bridge"
import Page from "${entryModule}"

installAnnotationBridge()

const container = document.getElementById("root")
if (container) createRoot(container).render(<Page />)
`;
}

const utilsSource = `import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
`;

const indexHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="icon" href="data:," />
    <title>Prototype preview</title>
    <link rel="stylesheet" href="./preview.theme.css" />
  </head>
  <body>
    <div id="root"></div>
    <script src="./preview.js"></script>
  </body>
</html>
`;

