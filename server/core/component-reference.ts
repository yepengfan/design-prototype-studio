import { StudioError } from "./contracts.js";
export function componentReference(exported: string) {
  if (
    !/^(?:default|[A-Z][A-Za-z0-9_$]*)(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*$/.test(
      exported,
    )
  )
    throw new StudioError(
      "The component export is not a supported React export.",
    );
  const [root, ...members] = exported.split(".");
  return { root, suffix: members.length ? "." + members.join(".") : "" };
}
