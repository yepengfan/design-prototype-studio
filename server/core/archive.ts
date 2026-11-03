import AdmZip from "adm-zip";
import { inflateRawSync, crc32 } from "node:zlib";
import path from "node:path";
import { Project, Node, SyntaxKind, type Expression } from "ts-morph";
import {
  manifestSchema,
  StudioError,
  type Files,
  type Manifest,
} from "./contracts.js";
import {
  safeRelative,
  validateFiles,
  encodeFile,
  decodeFile,
} from "./files.js";
import { parseRequirements } from "./requirements.js";
import { synchronizeRuntime } from "./project.js";

export function exportArchive(files: Files, manifest: Manifest) {
  const zip = new AdmZip();
  const content = synchronizeRuntime(files, manifest);
  validateFiles(content);
  for (const [file, value] of Object.entries(content))
    zip.addFile(safeRelative(file), decodeFile(file, value));
  return zip.toBuffer();
}
export function readArchive(buffer: Buffer): Files {
  if (buffer.length > 50_000_000)
    throw new StudioError("Archive is too large.");
  const zip = new AdmZip(buffer);
  const files: Files = {};
  let bytes = 0;
  const entries = zip.getEntries();
  if (entries.length > 5000)
    throw new StudioError("Archive contains too many entries.");
  for (const entry of entries) {
    const name = entry.entryName.replace(/\/$/, "");
    if (!name) continue;
    safeRelative(name);
    const mode = (entry.header.attr >>> 16) & 0o170000;
    if (mode === 0o120000)
      throw new StudioError(
        "Archives containing symbolic links cannot be imported.",
      );
    if (entry.isDirectory) continue;
    if (bytes + entry.header.size > 40_000_000 || entry.header.size > 4_000_000)
      throw new StudioError("Expanded archive exceeds the source size limit.");
    if (name in files)
      throw new StudioError("Archive contains duplicate file paths.");
    if (entry.header.flags & 1 || ![0, 8].includes(entry.header.method))
      throw new StudioError(
        "Encrypted or unsupported archive compression is not supported.",
      );
    let data: Buffer;
    try {
      const compressed = entry.getCompressedData();
      data =
        entry.header.method === 0
          ? compressed
          : inflateRawSync(compressed, { maxOutputLength: 4_000_001 });
    } catch {
      throw new StudioError(
        "Archive data is invalid or exceeds the source size limit.",
      );
    }
    bytes += data.byteLength;
    if (
      data.byteLength > 4_000_000 ||
      bytes > 40_000_000 ||
      data.byteLength !== entry.header.size ||
      crc32(data) !== entry.header.crc
    )
      throw new StudioError("Archive size or checksum is invalid.");
    files[name] = encodeFile(name, data);
  }
  validateFiles(files);
  return files;
}
export function inspectImport(files: Files, suppliedRequirements: Files = {}) {
  files = { ...files, ...suppliedRequirements };
  validateFiles(files);
  if (files["studio.project.json"]) {
    const manifest = manifestSchema.parse(
      JSON.parse(files["studio.project.json"]),
    );
    const requirements = parseRequirements(files, manifest.scope);
    if (!requirements.scenarios.length)
      throw new StudioError(
        "Supply Gherkin requirements and select the working scope before editing.",
      );
    return {
      files,
      manifest,
      diagnostics: [
        ...closureDiagnostics(files),
        ...dependencyDiagnostics(files, manifest),
      ],
      native: true,
    };
  }
  const features = Object.keys(files).filter((f) => f.endsWith(".feature"));
  if (!features.length)
    throw new StudioError(
      "This historical project has no supplied Gherkin. Add the matching requirements before entering editing.",
      422,
    );
  const pkg = JSON.parse(files["package.json"] ?? "{}");
  const diagnostics = closureDiagnostics(files);
  diagnostics.push(...dependencyDiagnostics(files));
  if (!files[".storybook/main.ts"] && !files[".storybook/main.js"])
    diagnostics.push("The Storybook configuration is missing.");
  const pages: Manifest["pages"] = [];
  const stories: { file: string; name: string; page: string }[] = [];
  const project = new Project({ useInMemoryFileSystem: true });
  for (const [name, content] of Object.entries(files).filter(([f]) =>
    /\.stories\.[tj]sx?$/.test(f),
  )) {
    const source = project.createSourceFile(name, content);
    const assignment = source.getExportAssignments()[0];
    let expression: Expression | undefined = assignment?.getExpression();
    if (expression && Node.isIdentifier(expression))
      expression = source
        .getVariableDeclaration(expression.getText())
        ?.getInitializer();
    while (
      expression &&
      (Node.isSatisfiesExpression(expression) ||
        Node.isAsExpression(expression) ||
        Node.isParenthesizedExpression(expression))
    )
      expression = expression.getExpression();
    if (!expression || !Node.isObjectLiteralExpression(expression)) {
      diagnostics.push(
        `${name}: computed Storybook metadata is unsupported and remains intact.`,
      );
      continue;
    }
    const component = expression.getProperty("component");
    const identifier =
      component && Node.isPropertyAssignment(component)
        ? component.getInitializer()?.getText()
        : undefined;
    const declaration = source
      .getImportDeclarations()
      .find(
        (d) =>
          d.getDefaultImport()?.getText() === identifier ||
          d
            .getNamedImports()
            .some(
              (i) =>
                (i.getAliasNode()?.getText() ?? i.getName()) === identifier,
            ),
      );
    if (!declaration) {
      diagnostics.push(
        `${name}: the page component cannot be resolved to an imported source module.`,
      );
      continue;
    }
    const specifier = declaration.getModuleSpecifierValue();
    if (!specifier.startsWith(".")) {
      diagnostics.push(
        `${name}: direct package stories are library examples, not editable page source.`,
      );
      continue;
    }
    const file = resolveLocal(files, name, specifier);
    if (!file) {
      diagnostics.push(`${name}: page source is missing.`);
      continue;
    }
    const named = declaration
      .getNamedImports()
      .find((i) => (i.getAliasNode()?.getText() ?? i.getName()) === identifier);
    const page = {
      id: `page-${pages.length + 1}`,
      title: identifier!,
      file,
      export: named?.getName() ?? "default",
    };
    if (!pages.some((p) => p.file === file)) pages.push(page);
    const pageId = pages.find((p) => p.file === file)!.id;
    for (const variable of source.getVariableDeclarations()) {
      if (!variable.getVariableStatement()?.isExported()) continue;
      let init = variable.getInitializer();
      while (
        init &&
        (Node.isSatisfiesExpression(init) || Node.isAsExpression(init))
      )
        init = init.getExpression();
      if (init && Node.isObjectLiteralExpression(init)) {
        stories.push({ file: name, name: variable.getName(), page: pageId });
        const target = pages.find((page) => page.id === pageId)!;
        target.previewStory ??= name + "#" + variable.getName();
      } else
        diagnostics.push(
          `${name}: exported story ${variable.getName()} is not a supported CSF object.`,
        );
    }
  }
  if (!pages.length)
    diagnostics.push(
      "No supported CSF TSX page stories were found. Static Storybook builds are not editable source.",
    );
  const requirements = parseRequirements(files, features);
  // Never infer business equivalence from story order or name. Designer maps them explicitly.
  const manifest: Manifest = {
    schemaVersion: 1,
    generationState: "generated",
    name: pkg.name ?? "Imported prototype",
    sourceOrigin: "legacy",
    pages,
    scope: features,
    libraries: [],
    scenarios: [],
    styles: [],
  };
  return { files, manifest, diagnostics, native: false, stories, requirements };
}
function dependencyDiagnostics(files: Files, manifest?: Manifest) {
  const diagnostics: string[] = [];
  const pkg = JSON.parse(files["package.json"] ?? "{}");
  const dependencies = { ...pkg.dependencies, ...pkg.devDependencies };
  for (const [name, version] of Object.entries(dependencies))
    if (
      typeof version !== "string" ||
      !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)
    )
      diagnostics.push(
        `${name} needs an exact published npm version. Local, portal, git and ranged dependencies cannot be restored reproducibly.`,
      );
  if (!files["package-lock.json"])
    diagnostics.push(
      "Supply a matching npm lockfile with the complete dependency closure.",
    );
  for (const library of manifest?.libraries ?? []) {
    if (dependencies[library.name] !== library.version)
      diagnostics.push(
        `${library.name}: the admitted release differs from the project's exact dependency.`,
      );
    if (
      library.components.some(
        (component) =>
          component.package !== library.name ||
          component.version !== library.version,
      )
    )
      diagnostics.push(
        `${library.name}: component identities do not match this pinned release.`,
      );
  }
  return diagnostics;
}
export function resolveLocal(files: Files, from: string, specifier: string) {
  const base = path.posix.normalize(
    path.posix.join(path.posix.dirname(from), specifier),
  );
  if (base.startsWith("../") || base.startsWith("/")) return undefined;
  return [
    base,
    ...[
      ".tsx",
      ".ts",
      ".jsx",
      ".js",
      ".css",
      ".json",
      "/index.tsx",
      "/index.ts",
    ].map((ext) => base + ext),
  ].find((f) => f in files);
}
export function closureDiagnostics(files: Files) {
  const errors: string[] = [];
  const project = new Project({ useInMemoryFileSystem: true });
  for (const [name, content] of Object.entries(files)) {
    if (!/\.[cm]?[tj]sx?$/.test(name)) continue;
    const file = project.createSourceFile(name, content);
    for (const d of file.getImportDeclarations()) {
      const spec = d.getModuleSpecifierValue();
      if (spec.startsWith(".") && !resolveLocal(files, name, spec))
        errors.push(`${name}: local dependency ${spec} is missing.`);
      if (spec.startsWith("/") || spec.includes("portal:"))
        errors.push(`${name}: machine-local imports are unsupported.`);
    }
    if (
      file
        .getDescendantsOfKind(SyntaxKind.CallExpression)
        .some(
          (c) =>
            c.getExpression().getText() === "import" &&
            !Node.isStringLiteral(c.getArguments()[0]),
        )
    )
      errors.push(
        `${name}: computed dynamic imports need a compatibility update; source remains intact.`,
      );
  }
  return errors;
}
