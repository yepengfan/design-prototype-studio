import { Project, Node } from "ts-morph";
import { randomUUID } from "node:crypto";
import {
  StudioError,
  type Files,
  type Manifest,
  type Proposal,
  type Snapshot,
} from "./contracts.js";
import { validateFiles, digest, safeRelative } from "./files.js";
import { parseRequirements } from "./requirements.js";
import { synchronizeRuntime } from "./project.js";
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
function withoutPresentation(source: string) {
  const p = new Project({ useInMemoryFileSystem: true });
  const f = p.createSourceFile("page.tsx", source);
  for (const a of f.getDescendants().filter(Node.isJsxAttribute).reverse())
    if (["style", "className"].includes(a.getNameNode().getText())) a.remove();
  f.formatText();
  return f.getFullText();
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
) {
  if (["gap", "clarification"].includes(proposal.kind))
    throw new StudioError(proposal.summary, 422, proposal.questions);
  validateFiles(proposal.files);
  const manifest: Manifest = structuredClone(
    proposal.manifest ?? { ...base.manifest, ...proposal.manifestChanges },
  );
  if (
    JSON.stringify(manifest.libraries) !==
    JSON.stringify(base.manifest.libraries)
  )
    throw new StudioError(
      "Import or upgrade libraries through the library review flow before using them in a proposal.",
    );
  for (const name of ["package.json", "package-lock.json"])
    if (
      (name in proposal.files && proposal.files[name] !== base.files[name]) ||
      proposal.deleted?.includes(name)
    )
      throw new StudioError(
        "A proposal cannot change dependency versions or project commands. Review library changes separately.",
      );
  if (JSON.stringify(manifest.scope) !== JSON.stringify(approvedScope))
    throw new StudioError(
      "Choose the working requirements scope before generating a proposal.",
    );
  const files = synchronizeRuntime(
    materializeProposal(base, proposal),
    manifest,
  );
  const diff = differences(base.files, files);
  const requirementsDiff = diff.filter((d) => d.file.endsWith(".feature"));
  const scopeBefore = parseRequirements(base.files, base.manifest.scope);
  const scopeAfter = parseRequirements(files, manifest.scope);
  const behavior = diff.some((d) => {
    if (d.file === "studio.project.json")
      return JSON.stringify(base.manifest) !== JSON.stringify(manifest);
    if (/\.tsx?$/.test(d.file) && d.before && d.after)
      return withoutPresentation(d.before) !== withoutPresentation(d.after);
    return !/\.(css|svg|png|jpg|woff2?)$/.test(d.file);
  });
  const initialImplementation = base.manifest.generationState === "unstarted";
  if (behavior && !requirementsDiff.length && !initialImplementation)
    throw new StudioError(
      "This proposal changes behavior or configuration without a matching requirements difference. Ask Studio to clarify the affected business scenarios and propose their Gherkin changes.",
      422,
    );
  if (scopeBefore.scenarios.length && !scopeAfter.scenarios.length)
    throw new StudioError(
      "The selected requirements cannot be removed implicitly.",
    );
  if (behavior) {
    manifest.generationState = "generated";
    for (const binding of manifest.scenarios) binding.accepted = false;
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
    if (file.startsWith("src/") && /\.tsx?$/.test(file)) {
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
      for (const n of f
        .getDescendants()
        .filter(
          (n) => Node.isJsxElement(n) || Node.isJsxSelfClosingElement(n),
        )) {
        const tag = (Node.isJsxElement(n) ? n.getOpeningElement() : n)
          .getTagNameNode()
          .getText();
        if (
          ["button", "input", "select", "textarea", "dialog"].includes(tag) &&
          !base.files[file]?.includes(n.getText())
        )
          throw new StudioError(
            `The proposal invents a ${tag} control. Studio must use the admitted library capability.`,
          );
      }
    }
  const finalFiles = synchronizeRuntime(files, manifest);
  return {
    id: randomUUID(),
    base: base.id,
    files: finalFiles,
    manifest,
    diff: differences(base.files, finalFiles),
    requirementsDiff,
    requiresConfirmation:
      requirementsDiff.length > 0 || (behavior && !initialImplementation),
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
export function replayChanges(
  base: Files,
  changes: { before: Files; after: Files }[],
) {
  const files = { ...base };
  for (const change of changes)
    for (const d of differences(change.before, change.after)) {
      if ((files[d.file] ?? "") !== d.before)
        throw new StudioError(
          `Accepted changes depend on the same source: ${d.file}. Choose to undo dependent results together or keep the current page.`,
          409,
        );
      if (d.removed) delete files[d.file];
      else files[d.file] = d.after;
    }
  return files;
}
