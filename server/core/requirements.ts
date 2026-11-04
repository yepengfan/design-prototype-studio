import { generateMessages } from "@cucumber/gherkin";
import { IdGenerator, SourceMediaType } from "@cucumber/messages";
import { digest, safeRelative } from "./files.js";
import { StudioError, type Files } from "./contracts.js";

export type Scenario = {
  id: string;
  file: string;
  feature: string;
  name: string;
  steps: { id: string; keyword: string; text: string; argument?: unknown }[];
  tags: string[];
};
export function parseRequirements(files: Files, selected: string[]) {
  const included = Object.keys(files)
    .filter(
      (f) =>
        f.endsWith(".feature") &&
        selected.some(
          (s) => f === s || f.startsWith(s.replace(/\/$/, "") + "/"),
        ),
    )
    .sort();
  const scenarios: Scenario[] = [];
  for (const file of included) {
    safeRelative(file);
    const envelopes = generateMessages(
      files[file],
      file,
      SourceMediaType.TEXT_X_CUCUMBER_GHERKIN_PLAIN,
      {
        newId: IdGenerator.incrementing(),
        includeSource: false,
        includeGherkinDocument: true,
        includePickles: true,
      },
    );
    const errors = envelopes.flatMap((e) =>
      e.parseError ? [e.parseError.message] : [],
    );
    if (errors.length)
      throw new StudioError(
        `Requirements in ${file} need correction.`,
        422,
        errors,
      );
    const doc = envelopes.find((e) => e.gherkinDocument)?.gherkinDocument;
    for (const e of envelopes)
      if (e.pickle) {
        const p = e.pickle;
        scenarios.push({
          id: digest([file, p.astNodeIds, p.name]).slice(0, 20),
          file,
          feature: doc?.feature?.name ?? "",
          name: p.name,
          tags: p.tags.map((t) => t.name),
          steps: p.steps.map((s, i) => ({
            id: `${i + 1}`,
            keyword: s.type ?? "Unknown",
            text: s.text,
            argument: s.argument,
          })),
        });
      }
  }
  return {
    files: included.map((file) => ({ file, hash: digest(files[file]) })),
    scenarios,
  };
}
export function markdownRequirements(markdown: string) {
  const fenced = [
    ...markdown.matchAll(/```(?:gherkin|feature)\s*\n([\s\S]*?)```/g),
  ].map((m) => m[1]);
  if (fenced.length)
    return {
      proposals: fenced,
      warning:
        "Review these extracted blocks against the original document and prototype before confirming.",
    };
  const start = markdown.search(/^\s*(?:Feature|# language):/m);
  if (start >= 0)
    return {
      proposals: [markdown.slice(start)],
      warning:
        "Unfenced requirements may contain prose. Confirm and correct the proposed feature before editing.",
    };
  throw new StudioError(
    "No Gherkin block was found. Supply the missing requirements before editing.",
  );
}
