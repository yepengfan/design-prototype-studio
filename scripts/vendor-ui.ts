/**
 * Vendors the shadcn/ui components the Studio's own interface is built from.
 *
 * The Studio uses the same registry client it offers designers, so the files
 * under `src/components/ui` are the registry's published source, unmodified.
 * Re-run with `npm run vendor:ui` to pick up a registry update.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { config } from "../server/config.js";
import { presets } from "../server/presets.js";
import { resolveClosure } from "../server/sources/registry.js";
import { resolveTheme } from "../server/sources/theme.js";

const wanted = [
  "alert",
  "badge",
  "button",
  "card",
  "input",
  "label",
  "scroll-area",
  "select",
  "separator",
  "tabs",
  "textarea",
];

const spec = presets[0]!.spec;
const { files, packages } = await resolveClosure(spec, wanted);
const theme = await resolveTheme(spec);

for (const file of files) {
  // Registry paths carry the style prefix; the Studio keeps them under `ui/`.
  const name = path.basename(file.path);
  const folder = file.path.includes("/hooks/") ? "hooks" : file.path.includes("/lib/") ? "lib" : "ui";
  const target = path.join(config.repoRoot, "src", "components", folder, name);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, rewriteImports(file.content));
  process.stdout.write(`vendored src/components/${folder}/${name}\n`);
}

await fs.writeFile(
  path.join(config.repoRoot, "src", "index.css"),
  `${theme.css}\n@source "./";\n`,
);
process.stdout.write(`wrote src/index.css\nruntime packages: ${packages.sort().join(", ")}\n`);

/** Registry source paths are rewritten once, to the Studio's own folders. */
function rewriteImports(content: string): string {
  return content.replace(/@\/registry\/[^/]+\/(ui|hooks|lib)\//g, "@/components/$1/");
}
