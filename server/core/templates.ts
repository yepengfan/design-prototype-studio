import type { ProjectState, Snapshot } from "./contracts.js";
import { synchronizeRuntime } from "./project.js";
/** An adaptation draft retains the accepted template until source and new requirements are approved together. */
export function templateInput(
  snapshot: Snapshot,
  pending: ProjectState["templateReconciliation"],
): Snapshot {
  if (!pending) return snapshot;
  const files = Object.fromEntries(
    Object.entries(snapshot.files).filter(
      ([name]) => !name.endsWith(".feature"),
    ),
  );
  const manifest = { ...snapshot.manifest, scope: pending.scope };
  return {
    ...snapshot,
    files: synchronizeRuntime({ ...files, ...pending.requirements }, manifest),
    manifest,
  };
}
