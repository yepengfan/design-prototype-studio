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

export function readDeclarations(
  fileName: string,
  origin: { sourceId: string; sourceName: string; package: string; version: string },
  warnings: string[],
): CatalogComponent[] {
  const probePath = path.join(path.dirname(fileName), "__studio_component_probe__.ts");
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true,
    skipLibCheck: true,
  };
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (name, languageVersion, onError, shouldCreateNewSourceFile) =>
    name === probePath
      ? ts.createSourceFile(name, 'import type { JSXElementConstructor } from "react"; export type Candidate = JSXElementConstructor<any>;', ts.ScriptTarget.Latest, true)
      : getSourceFile(name, languageVersion, onError, shouldCreateNewSourceFile);
  const program = ts.createProgram([fileName, probePath], options, host);
  const checker = program.getTypeChecker();
  const file = program.getSourceFile(fileName);
  const probe = program.getSourceFile(probePath)!;
  const candidate = probe.statements.find(ts.isTypeAliasDeclaration)!;
  const componentType = checker.getTypeFromTypeNode(candidate.type);
  if (componentType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown))
    throw new StudioError("React type declarations are required to inspect npm components.", 422);
  const module = file && checker.getSymbolAtLocation(file);
  const components: CatalogComponent[] = [];
  for (const exported of module ? checker.getExportsOfModule(module) : []) {
    const name = exported.name;
    if (!/^[A-Z]/.test(name)) continue;
    const symbol = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
    const declaration = symbol.valueDeclaration;
    if (!declaration) continue;
    const type = checker.getTypeOfSymbolAtLocation(symbol, declaration);
    if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) continue;
    if (!checker.isTypeAssignableTo(type, componentType)) continue;
    components.push({
      id: `${origin.sourceId}:${name}`,
      sourceId: origin.sourceId,
      sourceName: origin.sourceName,
      name,
      title: name.replace(/([a-z])([A-Z])/g, "$1 $2"),
      kind: "export",
      description: ts.displayPartsToString(symbol.getDocumentationComment(checker)) || undefined,
      exports: [name],
      importPath: origin.package,
      capabilities: capabilitiesFor(name, [name]),
      provenance: `${origin.package}@${origin.version} ${path.basename(fileName)}`,
    });
  }
  const exports = components.map((component) => component.name);
  for (const component of components) component.exports = exports;
  if (components.length === 0)
    warnings.push(`${origin.package}: no public React component exports were found in ${path.basename(fileName)}.`);
  return components;
}

async function install(spec: NpmSourceSpec, projectDir: string): Promise<void> {
  await fs.mkdir(projectDir, { recursive: true });
  const args = [
    "install",
    `${spec.package}@${spec.version}`,
    "--prefix",
    projectDir,
    "--save",
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
