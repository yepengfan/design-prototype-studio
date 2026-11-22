import { execFile } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { config } from "./config.js";
import { StudioError } from "./errors.js";
import { assertPackageName } from "./sources/npm.js";

const run = promisify(execFile);

export type DependencyReport = {
  /** Packages already resolvable, so no install was needed. */
  satisfied: string[];
  /** Packages installed into the project for this build. */
  installed: string[];
};

/**
 * Makes every package a generated project imports resolvable before it is
 * bundled.
 *
 * The Studio's own packages satisfy most of a registry's dependencies, because
 * the Studio is built with the same design system. Anything else is installed
 * into the project, which is also how a design system nobody anticipated gets
 * its runtime dependencies.
 */
export async function ensurePackages(
  projectDir: string,
  packages: string[],
): Promise<DependencyReport> {
  const wanted = [...new Set(packages)].filter((name) => name && !name.startsWith("@/"));
  const satisfied: string[] = [];
  const missing: string[] = [];

  for (const name of wanted) {
    assertPackageName(name);
    if (resolves(name, projectDir)) satisfied.push(name);
    else missing.push(name);
  }

  if (missing.length === 0) return { satisfied, installed: [] };

  await fs.mkdir(projectDir, { recursive: true });
  try {
    await run(
      "npm",
      [
        "install",
        ...wanted,
        "--prefix",
        projectDir,
        "--save",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--loglevel=error",
      ],
      { cwd: projectDir, timeout: 300_000 },
    );
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr ?? "";
    throw new StudioError(
      `The preview needs ${missing.join(", ")}, which npm could not install. ${firstLine(stderr)}`.trim(),
      422,
    );
  }

  const stillMissing = missing.filter((name) => !resolves(name, projectDir));
  if (stillMissing.length)
    throw new StudioError(
      `${stillMissing.join(", ")} did not resolve after installation, so the preview cannot be built.`,
      422,
    );

  return { satisfied, installed: missing };
}

/**
 * Looks for the installed package directory rather than resolving an entry
 * point: a design system can depend on a CSS-only package whose `exports` map
 * publishes no importable module, and that package is still installed.
 */
function resolves(name: string, projectDir: string): boolean {
  return [projectDir, config.repoRoot].some((base) =>
    existsSync(path.join(base, "node_modules", ...name.split("/"), "package.json")),
  );
}

function firstLine(value: string): string {
  return value.split("\n").find((line) => line.trim())?.trim() ?? "";
}
