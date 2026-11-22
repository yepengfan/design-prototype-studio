import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import * as esbuild from "esbuild";
import { config, paths } from "./config.js";
import { StudioError } from "./errors.js";
import type { ResolvedFile } from "./sources/registry.js";

const run = promisify(execFile);

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
  await writeFile(root, "dist/index.html", indexHtml);

  await bundle(root);
  await compileStyles(root);
}

async function bundle(root: string): Promise<void> {
  const src = path.join(root, "src");
  try {
    await esbuild.build({
      absWorkingDir: root,
      entryPoints: [path.join(src, "preview", "main.tsx")],
      outfile: path.join(root, "dist", "preview.js"),
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

async function compileStyles(root: string): Promise<void> {
  const binary = path.join(config.repoRoot, "node_modules", ".bin", "tailwindcss");
  try {
    await run(binary, ["-i", path.join(root, "src", "styles.css"), "-o", path.join(root, "dist", "preview.css")], {
      cwd: root,
      timeout: 120_000,
    });
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr ?? "";
    throw new StudioError(
      `The preview stylesheet could not be compiled. ${firstLine(stderr) || "Check the design system's base styles."}`,
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
    <link rel="stylesheet" href="./preview.css" />
  </head>
  <body>
    <div id="root"></div>
    <script src="./preview.js"></script>
  </body>
</html>
`;

function firstLine(value: string): string {
  return value.split("\n").find((line) => line.trim())?.trim() ?? "";
}
