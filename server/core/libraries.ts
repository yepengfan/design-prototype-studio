import { promises as fs } from "node:fs";
import path from "node:path";
import semver from "semver";
import { publishedStories } from "./published-stories.js";
import { componentReference } from "./component-reference.js";
import { Project, Node, ts } from "ts-morph";
import {
  componentSchema,
  StudioError,
  type Component,
  type Files,
} from "./contracts.js";
import { safeRelative, writeFiles } from "./files.js";
import { npmFailure, registryURL, runCommand } from "./process.js";

/** External JSX building blocks need the same published contract on legacy import. */
export function referencedComponentPackages(files: Files) {
  const packages = new Set<string>();
  const project = new Project({ useInMemoryFileSystem: true });
  for (const [name, content] of Object.entries(files)) {
    if (!/\.[tj]sx$/.test(name)) continue;
    const source = project.createSourceFile(name, content);
    const tags = new Set(
      source
        .getDescendants()
        .filter(
          (node) =>
            Node.isJsxOpeningElement(node) ||
            Node.isJsxSelfClosingElement(node),
        )
        .map((node) => node.getTagNameNode().getText().split(".")[0]),
    );
    for (const declaration of source.getImportDeclarations()) {
      const specifier = declaration.getModuleSpecifierValue();
      if (
        specifier.startsWith(".") ||
        specifier === "react" ||
        specifier.startsWith("react/")
      )
        continue;
      const locals = [
        declaration.getDefaultImport()?.getText(),
        declaration.getNamespaceImport()?.getText(),
        ...declaration
          .getNamedImports()
          .map(
            (binding) => binding.getAliasNode()?.getText() ?? binding.getName(),
          ),
      ];
      if (locals.some((local) => local && tags.has(local)))
        packages.add(
          specifier.startsWith("@")
            ? specifier.split("/").slice(0, 2).join("/")
            : specifier.split("/")[0],
        );
    }
  }
  return [...packages];
}
export function packageIdentity(name: string, version: string) {
  if (
    !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(name) ||
    !semver.valid(version) ||
    semver.valid(version) !== version
  )
    throw new StudioError(
      "Enter an npm package name and exact published version, such as 1.2.3.",
    );
}
export async function installProject(
  root: string,
  files: Files,
  registries: { name: string; registry?: string }[] = [],
  updateLock = false,
  signal?: AbortSignal,
) {
  await fs.mkdir(root, { recursive: true });
  await writeFiles(root, files);
  const args = [
    files["package-lock.json"] && !updateLock ? "ci" : "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--loglevel=error",
  ];
  const registryFlags = new Map<string, string>();
  for (const library of registries)
    if (library.registry) {
      const registry = registryURL(library.registry);
      const key = library.name.startsWith("@")
        ? `--${library.name.split("/")[0]}:registry`
        : "--registry";
      if (registryFlags.has(key) && registryFlags.get(key) !== registry)
        throw new StudioError(
          "Packages in the same npm scope must use the same registry.",
        );
      registryFlags.set(key, registry);
    }
  args.push(
    ...[...registryFlags].map(([key, registry]) => `${key}=${registry}`),
  );
  const result = await runCommand("npm", args, root, {
    timeout: 180_000,
    signal,
    env: { npm_config_save_exact: "true" },
  });
  if (result.code) throw new StudioError(npmFailure(result.stderr), 422);
  return await fs.readFile(path.join(root, "package-lock.json"), "utf8");
}
function within(root: string, relative: string) {
  relative = relative.replace(/^\.\//, "");
  safeRelative(relative);
  const target = path.resolve(root, relative);
  if (!target.startsWith(root + path.sep))
    throw new StudioError(
      "The library references files outside its published package.",
    );
  return target;
}
export async function inspectLibrary(
  installedRoot: string,
  name: string,
  version: string,
): Promise<{
  components: Component[];
  templates: string[];
  warnings: string[];
}> {
  packageIdentity(name, version);
  const root = path.join(installedRoot, "node_modules", name);
  const pkg = JSON.parse(
    await fs.readFile(path.join(root, "package.json"), "utf8"),
  );
  if (pkg.name !== name || pkg.version !== version)
    throw new StudioError(
      "Installed package identity differs from the requested exact release.",
    );
  const components: Component[] = [];
  const warnings: string[] = [];
  let templates: string[] = [];
  if (pkg.studio) {
    const metadata = JSON.parse(
      await fs.readFile(
        within(
          root,
          typeof pkg.studio === "string" ? pkg.studio : pkg.studio.manifest,
        ),
        "utf8",
      ),
    );
    if (metadata.schemaVersion !== 1)
      throw new StudioError(
        "This published Studio information version is unsupported.",
      );
    for (const entry of metadata.components ?? [])
      components.push(
        componentSchema.parse({
          ...entry,
          package: name,
          version,
          provenance: "Published package Studio manifest",
        }),
      );
    templates = (metadata.templates ?? []).map((t: string) => {
      within(root, t);
      return t;
    });
  } else {
    // Published declaration documentation and executable JSX examples are sufficient for scalar surfaces.
    const entry = pkg.types ?? pkg.typings ?? pkg.exports?.["."]?.types;
    if (!entry || typeof entry !== "string")
      throw new StudioError(
        "This release does not publish discoverable component types. Ask the maintainer to publish documented React exports.",
      );
    const project = new Project({
      compilerOptions: {
        jsx: ts.JsxEmit.ReactJSX,
        strict: true,
        skipLibCheck: true,
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
        module: ts.ModuleKind.NodeNext,
      },
    });
    const file = project.addSourceFileAtPath(
      within(root, entry.replace(/^\.\//, "")),
    );
    const readme = await fs
      .readFile(path.join(root, "README.md"), "utf8")
      .catch(() => "");
    const stories = await publishedStories(await fs.realpath(root), name);
    const checker = project.getTypeChecker();
    for (const [symbolName, declarations] of file.getExportedDeclarations()) {
      const declaration = declarations[0];
      const type = declaration.getType();
      const signature = type.getCallSignatures()[0] ?? type.getConstructSignatures()[0];
      const componentName=symbolName==="default" && (Node.isFunctionDeclaration(declaration)||Node.isClassDeclaration(declaration)||Node.isVariableDeclaration(declaration)) ? declaration.getName() ?? "Default component" : symbolName;
      if (!signature || (symbolName!=="default" && !/^[A-Z]/.test(symbolName))) continue;
      const symbol = declaration.getSymbol();
      const declaredDescription = symbol
        ? ts.displayPartsToString(
            symbol.compilerSymbol.getDocumentationComment(
              checker.compilerObject,
            ),
          )
        : "";
      const description =
        declaredDescription || stories.get(symbolName)?.description || "";
      const propsType = signature
        .getParameters()[0]
        ?.getTypeAtLocation(declaration);
      if (!description || !propsType) {
        warnings.push(
          `${symbolName}: a purpose description or props declaration is missing.`,
        );
        continue;
      }
      const props: Component["props"] = {};
      let unsupportedRequired = false;
      let children = false;
      for (const prop of propsType.getProperties()) {
        const pname = prop.getName();
        if (pname === "children") {
          children = true;
          continue;
        }
        const ptype = prop.getTypeAtLocation(declaration);
        const parts = ptype.isUnion()
          ? ptype.getUnionTypes().filter((t) => !t.isUndefined())
          : [ptype];
        const doc = ts.displayPartsToString(
          prop.compilerSymbol.getDocumentationComment(checker.compilerObject),
        );
        const required = !prop.isOptional();
        const options = parts.every((t) => t.isStringLiteral())
          ? parts.map((t) => t.getLiteralValue() as string)
          : undefined;
        const kind = options
          ? "enum"
          : parts.every((t) => t.isString())
            ? "string"
            : parts.every((t) => t.isNumber())
              ? "number"
              : parts.every((t) => t.isBoolean() || t.isBooleanLiteral())
                ? "boolean"
                : undefined;
        if (!kind || !doc) {
          if (required) unsupportedRequired = true;
          continue;
        }
        const tags = prop.compilerSymbol.getJsDocTags(checker.compilerObject);
        props[pname] = {
          type: kind,
          description: doc,
          options,
          required,
          business:
            tags.some((t) => t.name === "business") ||
            [
              "value",
              "defaultValue",
              "checked",
              "defaultChecked",
              "required",
              "disabled",
              "readOnly",
              "min",
              "max",
              "pattern",
              "minLength",
              "maxLength",
            ].includes(pname),
        };
      }
      const examples: Component["examples"] = [];
      const docs = declarations
        .flatMap((d) =>
          Node.isJSDocable(d) ? d.getJsDocs().map((j) => j.getInnerText()) : [],
        )
        .join("\n");
      for (const match of [
        ...(readme + "\n" + docs).matchAll(/```(?:tsx|jsx)\s*\n([\s\S]*?)```/g),
      ]) {
        const sample = project.createSourceFile(
          `example-${examples.length}-${symbolName}.tsx`,
          match[1],
          { overwrite: true },
        );
        for (const jsx of sample
          .getDescendants()
          .filter(
            (n) => Node.isJsxElement(n) || Node.isJsxSelfClosingElement(n),
          )) {
          const op = Node.isJsxElement(jsx) ? jsx.getOpeningElement() : jsx;
          if (op.getTagNameNode().getText() !== componentName) continue;
          const values: Record<string, unknown> = {};
          let valid = true;
          for (const attr of op.getAttributes()) {
            if (!Node.isJsxAttribute(attr)) {
              valid = false;
              break;
            }
            const init = attr.getInitializer();
            let v: unknown = true;
            if (init)
              try {
                v = JSON.parse(
                  Node.isJsxExpression(init)
                    ? (init.getExpression()?.getText() ?? "null")
                    : init.getText(),
                );
              } catch {
                valid = false;
              }
            values[attr.getNameNode().getText()] = v;
          }
          const text = Node.isJsxElement(jsx)
            ? jsx
                .getJsxChildren()
                .filter(Node.isJsxText)
                .map((n) => n.getText())
                .join("")
                .trim()
            : undefined;
          if (valid)
            examples.push({
              name: `Example ${examples.length + 1}`,
              props: values,
              children: text,
            });
        }
        sample.forget();
      }
      const published = stories.get(symbolName)?.examples ?? [];
      examples.push(...published);
      if ((unsupportedRequired && !published.length) || !examples.length) {
        warnings.push(
          `${symbolName}: a required non-scalar property or a runnable documented example needs a library update.`,
        );
        continue;
      }
      components.push(
        componentSchema.parse({
          name: componentName,
          export: symbolName,
          description,
          package: name,
          version,
          provenance: `Published ${entry} and README examples`,
          props,
          children,
          examples,
          requiresBehavior: unsupportedRequired,
        }),
      );
    }
  }
  if (!components.length)
    throw new StudioError(
      "No components have sufficient published descriptions, property contracts and runnable examples. Ask the library maintainer to address the listed gaps.",
      422,
      warnings,
    );
  const declarations = pkg.types ?? pkg.typings ?? pkg.exports?.["."]?.types;
  const api =
    typeof declarations === "string"
      ? await fs
          .readFile(within(root, declarations), "utf8")
          .catch(() => undefined)
      : undefined;
  const documentation = await fs
    .readFile(path.join(root, "README.md"), "utf8")
    .catch(() => undefined);
  for (const component of components) {
    // Supply published callback/controlled-value contracts to generation too.
    // Scalar visual properties alone do not describe interaction semantics.
    if (api && Buffer.byteLength(api) <= 200_000) component.api = api;
    if (documentation && Buffer.byteLength(documentation) <= 40_000)
      component.documentation = documentation;
  }
  // Verify symbols against actual runtime exports in the preview/build phase, never import package code into this service.
  for (const c of components) {
    componentReference(c.export);
    for (const example of c.examples)
      if (example.story) {
        within(root, example.story.file);
        if (example.story.annotations) within(root, example.story.annotations);
        if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(example.story.export))
          throw new StudioError("Published story export is invalid.");
      }
    for (const style of c.styles) {
      if (
        !style.startsWith(name + "/") ||
        style.split("/").includes("..") ||
        style.includes("\\")
      )
        throw new StudioError(
          "Library styles must identify a published package subpath.",
        );
    }
  }
  return { components, templates, warnings };
}
export function searchComponents(components: Component[], query: string) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return components
    .map((c) => ({
      c,
      score: words.reduce(
        (s, w) =>
          s +
          (c.name.toLowerCase().includes(w) ? 4 : 0) +
          (c.description.toLowerCase().includes(w) ? 2 : 0) +
          (c.package.toLowerCase().includes(w) ? 1 : 0),
        0,
      ),
    }))
    .filter((x) => !words.length || x.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.c);
}

export async function readLibraryTemplates(
  installedRoot: string,
  name: string,
  version: string,
  paths: string[],
) {
  const { readArchive, inspectImport } = await import("./archive.js");
  const { filesSchema, manifestSchema } = await import("./contracts.js");
  const root = await fs.realpath(
    path.join(installedRoot, "node_modules", name),
  );
  const templates: {
    id: string;
    name: string;
    files: Files;
    manifest: import("./contracts.js").Manifest;
  }[] = [];
  const warnings: string[] = [];
  for (const entry of paths) {
    try {
      const file = await fs.realpath(within(root, entry));
      if (!file.startsWith(root + path.sep))
        throw new StudioError("Template points outside its published package.");
      const data = await fs.readFile(file);
      let files: Files;
      if (entry.endsWith(".zip")) files = readArchive(data);
      else {
        const parsed = JSON.parse(data.toString("utf8"));
        const manifest = manifestSchema.parse(parsed.manifest);
        files = {
          ...filesSchema.parse(parsed.files),
          "studio.project.json": JSON.stringify(manifest, null, 2),
        };
      }
      const inspected = inspectImport(files);
      if (!inspected.native || inspected.diagnostics.length)
        throw new StudioError(
          "Template needs complete native source, requirements and dependency closure.",
        );
      if (
        !inspected.manifest.libraries.some(
          (l) => l.name === name && l.version === version,
        )
      )
        throw new StudioError(
          "Template does not pin its providing package release.",
        );
      const { digest } = await import("./files.js");
      templates.push({
        id: digest([name, version, entry]),
        name: `${inspected.manifest.name} · ${name}@${version}`,
        files: inspected.files,
        manifest: inspected.manifest,
      });
    } catch (e) {
      warnings.push(
        `Template ${entry}: ${e instanceof StudioError ? e.message : "Published template is incomplete or invalid; ask its maintainer for a corrected release."}`,
      );
    }
  }
  return { templates, warnings };
}
