import { Project, Node, ts } from "ts-morph";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  StudioError,
  type Files,
  type Manifest,
  type Proposal,
  type Snapshot,
  type Component,
  type Property,
} from "./contracts.js";
import { validateFiles, digest, safeRelative } from "./files.js";
import { parseRequirements } from "./requirements.js";
import { synchronizeRuntime } from "./project.js";
import { anchors, validateCapabilities } from "./source.js";
import { closureDiagnostics } from "./archive.js";

export const differences = (before: Files, after: Files) =>
  [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .sort()
    .filter((f) => before[f] !== after[f])
    .map((file) => ({
      file,
      before: before[file] ?? "",
      after: after[file] ?? "",
      removed: !(file in after),
    }));
// Compare syntax and literal values, not source spelling. Comments, quote choice and
// indentation carry no business meaning; whitespace inside strings still does.
function withoutPresentation(source: string, components: Component[]) {
  const p = new Project({ useInMemoryFileSystem: true });
  const f = p.createSourceFile("page.tsx", source);
  const literal = (node: ts.Node): boolean => {
    if (
      ts.isStringLiteralLike(node) ||
      ts.isNumericLiteral(node) ||
      [
        ts.SyntaxKind.TrueKeyword,
        ts.SyntaxKind.FalseKeyword,
        ts.SyntaxKind.NullKeyword,
      ].includes(node.kind)
    )
      return true;
    if (ts.isPrefixUnaryExpression(node)) return literal(node.operand);
    if (ts.isObjectLiteralExpression(node))
      return node.properties.every(
        (property) =>
          ts.isPropertyAssignment(property) &&
          (ts.isIdentifier(property.name) ||
            ts.isStringLiteral(property.name) ||
            ts.isNumericLiteral(property.name)) &&
          literal(property.initializer),
      );
    return false;
  };
  const componentAt = new Map(
    anchors(source, components)
      .filter((node) => node.component)
      .map((node) => [node.start, node.component!]),
  );
  const cssModules = new Set(
    f
      .getImportDeclarations()
      .filter((declaration) =>
        /\.module\.css$/.test(declaration.getModuleSpecifierValue()),
      )
      .map((declaration) => declaration.getDefaultImport()?.getText())
      .filter((name): name is string => !!name),
  );
  const hasBusiness = (property: Property): boolean =>
    property.business || Object.values(property.fields ?? {}).some(hasBusiness);
  for (const a of f.getDescendants().filter(Node.isJsxAttribute).reverse()) {
    const name = a.getNameNode().getText();
    const owner = a
      .getAncestors()
      .find(
        (node) =>
          Node.isJsxOpeningElement(node) || Node.isJsxSelfClosingElement(node),
      );
    const prop = owner
      ? componentAt.get(owner.getStart())?.props[name]
      : undefined;
    if (!["style", "className"].includes(name) && (!prop || hasBusiness(prop)))
      continue;
    const initializer = a.getInitializer();
    const expression =
      initializer && Node.isJsxExpression(initializer)
        ? initializer.getExpression()
        : initializer;
    const cssClass =
      name === "className" &&
      expression &&
      Node.isPropertyAccessExpression(expression) &&
      Node.isIdentifier(expression.getExpression()) &&
      cssModules.has(expression.getExpression().getText());
    if (
      (expression && literal(expression.compilerNode)) ||
      cssClass ||
      (!initializer && prop?.type === "boolean")
    )
      a.remove();
  }
  for (const declaration of f.getImportDeclarations()) {
    if (!/\.css$/.test(declaration.getModuleSpecifierValue())) continue;
    const binding = declaration.getDefaultImport();
    if (
      !binding &&
      !declaration.getNamedImports().length &&
      !declaration.getNamespaceImport()
    )
      declaration.remove();
    else if (
      binding &&
      cssModules.has(binding.getText()) &&
      !f
        .getDescendants()
        .filter(Node.isIdentifier)
        .some(
          (identifier) =>
            identifier.getText() === binding.getText() &&
            !identifier.getAncestors().some(Node.isImportDeclaration),
        )
    )
      declaration.remove();
  }
  const transparent = (node: ts.Node): node is ts.JsxElement | ts.JsxFragment =>
    ts.isJsxFragment(node) || (ts.isJsxElement(node) &&
      ["div", "section"].includes(node.openingElement.tagName.getText()) &&
      node.openingElement.attributes.properties.length === 0);
  const flatten = (node: ts.Node): ts.Node[] => transparent(node)
    ? node.children.flatMap(flatten)
    : ts.isJsxText(node) && !node.text.trim() ? [] : [node];
  const fingerprint = (node: ts.Node): unknown => {
    if (
      ts.isStringLiteralLike(node) ||
      ts.isIdentifier(node) ||
      ts.isNumericLiteral(node) ||
      ts.isJsxText(node)
    )
      return [node.kind, node.text];
    const children: unknown[] = [];
    ts.forEachChild(node, (child) => {
      children.push(...flatten(child).map(fingerprint));
    });
    return [node.kind, children];
  };
  return JSON.stringify(fingerprint(f.compilerNode));
}
function isExecutionConfiguration(file: string) {
  return (
    /(^|\/)(?:[^/]*\.config\.[cm]?[jt]s|tsconfig[^/]*\.json)$/.test(file) ||
    /^(?:scripts|bin|tests)\//.test(file) ||
    /^\.storybook\/main\.[cm]?[jt]s$/.test(file) ||
    ["package.json", "package-lock.json", "index.html"].includes(file)
  );
}
// Freeze configuration's local dependency closure too. An imported helper runs
// with the Node process's privileges just like the top-level configuration.
function executionClosure(files: Files) {
  const frozen = new Set(Object.keys(files).filter(isExecutionConfiguration));
  const pending = [...frozen];
  const p = new Project({ useInMemoryFileSystem: true });
  while (pending.length) {
    const name = pending.pop()!;
    if (!/\.[cm]?[jt]sx?$/.test(name)) continue;
    const f = p.createSourceFile(name, files[name], { overwrite: true });
    for (const node of f.getDescendants()) {
      if (!Node.isStringLiteral(node)) continue;
      const spec = node.getLiteralValue();
      // Also protects static require/dynamic import targets. Conservative string
      // references are intentional for configuration, which AI cannot author.
      if (!spec.startsWith(".")) continue;
      const resolved = path.posix.normalize(
        path.posix.join(path.posix.dirname(name), spec),
      );
      const dependency = [
        resolved,
        ...[
          ".ts",
          ".tsx",
          ".js",
          ".mjs",
          ".cjs",
          ".json",
          "/index.ts",
          "/index.js",
        ].map((extension) => resolved + extension),
      ].find((candidate) => candidate in files);
      if (dependency && !frozen.has(dependency)) {
        frozen.add(dependency);
        pending.push(dependency);
      }
    }
  }
  return frozen;
}
export function materializeProposal(base: Snapshot, proposal: Proposal): Files {
  const files = { ...base.files, ...proposal.files };
  for (const deleted of proposal.deleted ?? [])
    delete files[safeRelative(deleted)];
  validateFiles(files);
  return files;
}
export function prepareChange(
  base: Snapshot,
  proposal: Proposal,
  approvedScope = base.manifest.scope,
  options: { repair?: boolean; page?: string } = {},
) {
  if (["gap", "clarification"].includes(proposal.kind))
    throw new StudioError(proposal.summary, 422, proposal.questions);
  validateFiles(proposal.files);
  const manifest: Manifest = structuredClone(
    proposal.manifest ?? { ...base.manifest, ...proposal.manifestChanges },
  );
  if (manifest.sourceOrigin !== base.manifest.sourceOrigin)
    throw new StudioError(
      "An edit cannot change the source import compatibility contract.",
    );
  if (
    JSON.stringify(manifest.libraries) !==
    JSON.stringify(base.manifest.libraries)
  )
    throw new StudioError(
      "Import or upgrade libraries through the library review flow before using them in a proposal.",
    );
  const proposedFiles = materializeProposal(base, proposal);
  const frozen = executionClosure(base.files);
  for (const change of differences(base.files, proposedFiles))
    if (frozen.has(change.file) || isExecutionConfiguration(change.file))
      throw new StudioError(
        "A proposal cannot change executable configuration, its helpers, dependency versions or project commands. Review configuration and library changes separately.",
      );
  if (JSON.stringify(manifest.scope) !== JSON.stringify(approvedScope))
    throw new StudioError(
      "Choose the working requirements scope before generating a proposal.",
    );
  const files = synchronizeRuntime(proposedFiles, manifest);
  const diff = differences(base.files, files);
  const requirementsDiff = diff.filter((d) => d.file.endsWith(".feature"));
  const scopeBefore = parseRequirements(base.files, base.manifest.scope);
  const scopeAfter = parseRequirements(files, manifest.scope);
  const selectedFiles = new Set(
    [...scopeBefore.files, ...scopeAfter.files].map((file) => file.file),
  );
  if (requirementsDiff.some((change) => !selectedFiles.has(change.file)))
    throw new StudioError(
      "A proposal changes requirements outside the selected working scope. Choose that scope before changing its business behavior.",
      422,
    );
  const selectedScenarios = new Set(
    [...scopeBefore.scenarios, ...scopeAfter.scenarios].map(
      (scenario) => scenario.id,
    ),
  );
  for (const binding of base.manifest.scenarios.filter(
    (binding) => !selectedScenarios.has(binding.scenario),
  ))
    if (
      JSON.stringify(
        manifest.scenarios.find(
          (candidate) => candidate.scenario === binding.scenario,
        ),
      ) !== JSON.stringify(binding)
    )
      throw new StudioError(
        "Preserve scenario mappings outside the selected working scope.",
        422,
      );
  const behavior = diff.some((d) => {
    if (d.file === "studio.project.json")
      return (
        JSON.stringify({ ...base.manifest, scenarios: [] }) !==
        JSON.stringify({ ...manifest, scenarios: [] })
      );
    if (/\.[cm]?[jt]sx?$/.test(d.file) && d.before && d.after)
      return (
        withoutPresentation(
          d.before,
          base.manifest.libraries.flatMap((library) => library.components),
        ) !==
        withoutPresentation(
          d.after,
          manifest.libraries.flatMap((library) => library.components),
        )
      );
    return !/\.(css|svg|png|jpg|woff2?)$/.test(d.file);
  });
  if (
    behavior &&
    base.manifest.pages.some(
      (page) =>
        diff.some((change) => change.file === page.file) &&
        base.manifest.scenarios.some(
          (binding) =>
            binding.page === page.id &&
            !selectedScenarios.has(binding.scenario),
        ),
    )
  )
    throw new StudioError(
      "This page also implements requirements outside the current selection. Include its related requirement files before changing its behavior, or leave this proposal pending.",
      422,
    );
  if (
    !behavior &&
    options.page &&
    diff.some((change) =>
      base.manifest.pages.some(
        (page) => page.id !== options.page && page.file === change.file,
      ),
    )
  )
    throw new StudioError(
      "This presentation proposal edits another page. Rework it for the designer's current page.",
      422,
    );
  const initialImplementation =
    base.manifest.generationState === "unstarted" ||
    (base.manifest.sourceOrigin !== "legacy" &&
      base.manifest.scenarios.length > 0 &&
      scopeBefore.scenarios.some(
        (scenario) =>
          !base.manifest.scenarios.some(
            (binding) => binding.scenario === scenario.id,
          ),
      ));
  if (initialImplementation && !requirementsDiff.length)
    for (const binding of base.manifest.scenarios.filter((binding) =>
      selectedScenarios.has(binding.scenario),
    ))
      if (
        JSON.stringify({
          ...manifest.scenarios.find(
            (candidate) => candidate.scenario === binding.scenario,
          ),
          accepted: false,
        }) !== JSON.stringify({ ...binding, accepted: false })
      )
        throw new StudioError(
          "Keep the existing scenario checks while implementing the remaining selected scenarios.",
          422,
        );
  if (
    options.repair &&
    (requirementsDiff.length ||
      JSON.stringify(manifest) !== JSON.stringify(base.manifest))
  )
    throw new StudioError(
      "Implementation repair must preserve the existing requirements and reviewed scenario plans exactly.",
    );
  if (
    behavior &&
    !requirementsDiff.length &&
    !initialImplementation &&
    !options.repair
  )
    throw new StudioError(
      "This proposal changes behavior or configuration without a matching requirements difference. Ask Studio to clarify the affected business scenarios and propose their Gherkin changes.",
      422,
    );
  if (scopeBefore.scenarios.length && !scopeAfter.scenarios.length)
    throw new StudioError(
      "The selected requirements cannot be removed implicitly.",
    );
  if (behavior && !options.repair) {
    manifest.generationState = "generated";
    for (const binding of manifest.scenarios)
      if (selectedScenarios.has(binding.scenario)) binding.accepted = false;
  }
  const closure = closureDiagnostics(files);
  if (closure.length)
    throw new StudioError(
      "The proposed project has missing or unsupported source dependencies.",
      422,
      closure,
    );
  const known = new Set([
    "react",
    "react-dom",
    "react/jsx-runtime",
    ...manifest.libraries.map((l) => l.name),
  ]);
  for (const [file, source] of Object.entries(files))
    if (file.startsWith("src/") && /\.[cm]?[jt]sx?$/.test(file)) {
      const p = new Project({ useInMemoryFileSystem: true });
      const f = p.createSourceFile(file, source);
      for (const imp of f.getImportDeclarations()) {
        const spec = imp.getModuleSpecifierValue();
        if (
          !spec.startsWith(".") &&
          ![...known].some((k) => spec === k || spec.startsWith(k + "/")) &&
          !spec.startsWith("@storybook/")
        )
          throw new StudioError(
            `The proposal uses an unadmitted package: ${spec}. Import and inspect that library first.`,
          );
      }
    }
  validateCapabilities(files, manifest, base.files);
  const finalFiles = synchronizeRuntime(files, manifest);
  return {
    id: randomUUID(),
    base: base.id,
    files: finalFiles,
    manifest,
    diff: differences(base.files, finalFiles),
    requirementsDiff,
    behavior,
    repair: options.repair === true,
    requiresConfirmation:
      requirementsDiff.length > 0 ||
      (behavior && !initialImplementation && !options.repair),
    summary: proposal.summary,
    hash: digest(finalFiles),
  };
}
export type Change = ReturnType<typeof prepareChange>;
export function rebaseProposal(
  base: Snapshot,
  current: Snapshot,
  proposal: Proposal,
): Proposal {
  if (base.id === current.id) return proposal;
  if (
    JSON.stringify(base.manifest.libraries) !==
    JSON.stringify(current.manifest.libraries)
  )
    throw new StudioError(
      "Library versions changed. Rework this result against the current libraries.",
      409,
    );
  const changes = differences(
    base.files,
    materializeProposal(base, proposal),
  ).filter((d) => d.file !== "studio.project.json");
  const conflicts = changes.filter(
    (d) => current.files[d.file] !== base.files[d.file],
  );
  if (conflicts.length)
    throw new StudioError(
      "These results share source or requirements with accepted work. Leave this result pending or rework it against the accepted page.",
      409,
      conflicts.map((d) => d.file),
    );
  const proposedManifest = proposal.manifest ?? {
    ...base.manifest,
    ...proposal.manifestChanges,
  };
  const manifestChanged =
    JSON.stringify(proposedManifest) !== JSON.stringify(base.manifest);
  if (
    manifestChanged &&
    JSON.stringify(current.manifest) !== JSON.stringify(base.manifest)
  )
    throw new StudioError(
      "These results both change page or scenario configuration. Review them together before reworking.",
      409,
    );
  const files = { ...current.files };
  for (const d of changes) {
    if (d.removed) delete files[d.file];
    else files[d.file] = d.after;
  }
  return {
    ...proposal,
    files,
    manifestChanges: undefined,
    manifest: manifestChanged ? proposedManifest : current.manifest,
  };
}
