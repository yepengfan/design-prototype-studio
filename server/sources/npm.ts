import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import ts from "typescript";
import { capabilitiesFor } from "../capabilities.js";
import type { CatalogComponent, NpmSourceSpec } from "../contracts.js";
import { StudioError } from "../errors.js";

const run = promisify(execFile);

export type NpmImport = {
  components: CatalogComponent[];
  warnings: string[];
  version: string;
};

/**
 * Installs a published npm design system into a project and reads its catalog
 * from the type declarations it publishes.
 *
 * Only exported React components with a props type are listed: a package that
 * publishes no types cannot be searched, and saying so is more useful to a
 * designer than guessing at a component list.
 */
export async function importNpmPackage(
  sourceId: string,
  sourceName: string,
  spec: NpmSourceSpec,
  projectDir: string,
): Promise<NpmImport> {
  assertPackageName(spec.package);
  await install(spec, projectDir);

  const root = path.join(projectDir, "node_modules", ...spec.package.split("/"));
  const manifest = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")) as {
    name: string;
    version: string;
    types?: string;
    typings?: string;
    exports?: Record<string, { types?: string } | string>;
  };

  const entry =
    manifest.types ??
    manifest.typings ??
    (typeof manifest.exports?.["."] === "object" ? manifest.exports["."].types : undefined);
  if (!entry)
    throw new StudioError(
      `${spec.package} publishes no type declarations, so its components cannot be searched. Ask the maintainer to publish typed React exports.`,
      422,
    );

  const declarationPath = path.resolve(root, entry);
  if (!declarationPath.startsWith(root + path.sep))
    throw new StudioError(`${spec.package} points its types outside the published package.`);

  const warnings: string[] = [];
  const components = readDeclarations(
    await fs.readFile(declarationPath, "utf8"),
    declarationPath,
    { sourceId, sourceName, package: spec.package, version: manifest.version },
    warnings,
  );

  if (components.length === 0)
    throw new StudioError(
      `${spec.package}@${manifest.version} exports no React components the Studio can describe.`,
      422,
      warnings,
    );

  return { components, warnings, version: manifest.version };
}

function readDeclarations(
  source: string,
  fileName: string,
  origin: { sourceId: string; sourceName: string; package: string; version: string },
  warnings: string[],
): CatalogComponent[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const components: CatalogComponent[] = [];

  const add = (name: string, description: string | undefined) => {
    if (!/^[A-Z]/.test(name)) return;
    components.push({
      id: `${origin.sourceId}:${name}`,
      sourceId: origin.sourceId,
      sourceName: origin.sourceName,
      name,
      title: name.replace(/([a-z])([A-Z])/g, "$1 $2"),
      kind: "export",
      description,
      exports: [name],
      importPath: origin.package,
      capabilities: capabilitiesFor(name, [name]),
      provenance: `${origin.package}@${origin.version} ${path.basename(fileName)}`,
    });
  };

  const visit = (node: ts.Node) => {
    const exported =
      ts.canHaveModifiers(node) &&
      ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
    if (!exported) return;
    const doc = docComment(node);
    if (ts.isFunctionDeclaration(node) && node.name) add(node.name.text, doc);
    if (ts.isVariableStatement(node))
      for (const declaration of node.declarationList.declarations)
        if (ts.isIdentifier(declaration.name)) add(declaration.name.text, doc);
    if (ts.isClassDeclaration(node) && node.name) add(node.name.text, doc);
  };

  ts.forEachChild(file, visit);
  if (components.length === 0)
    warnings.push(
      `${origin.package}: no exported identifiers starting with a capital letter were found in ${path.basename(fileName)}.`,
    );
  return components;
}

function docComment(node: ts.Node): string | undefined {
  const jsDoc = (node as ts.Node & { jsDoc?: ts.JSDoc[] }).jsDoc;
  const text = jsDoc?.[0]?.comment;
  return typeof text === "string" && text.trim() ? text.trim() : undefined;
}

async function install(spec: NpmSourceSpec, projectDir: string): Promise<void> {
  await fs.mkdir(projectDir, { recursive: true });
  const args = [
    "install",
    `${spec.package}@${spec.version}`,
    "--prefix",
    projectDir,
    "--no-save",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--loglevel=error",
  ];
  if (spec.registry) args.push(`--registry=${registryUrl(spec.registry)}`);
  try {
    await run("npm", args, { cwd: projectDir, timeout: 180_000 });
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr ?? "";
    throw new StudioError(
      `npm could not install ${spec.package}@${spec.version}. ${firstLine(stderr) || "Check the package name, version and registry."}`,
      422,
    );
  }
}

function registryUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new StudioError(`"${value}" is not a valid npm registry URL.`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw new StudioError("An npm registry URL must use http or https.");
  return url.toString();
}

export function assertPackageName(name: string): void {
  if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(name))
    throw new StudioError(`"${name}" is not a valid npm package name.`);
}

function firstLine(value: string): string {
  return value.split("\n").find((line) => line.trim())?.trim() ?? "";
}
