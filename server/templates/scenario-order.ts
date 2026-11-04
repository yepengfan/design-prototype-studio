// Shared by Studio checks and the runnable source handoff.
export function orderedScenarioSteps<T extends { step: string; action?: string; value?: string; count?: number }>(
  requirementSteps: readonly string[],
  checks: readonly T[],
): T[] {
  for (const check of checks) {
    if (["text", "value", "fill"].includes(check.action ?? "") && typeof check.value !== "string")
      throw new Error("The " + check.action + " check requires an explicit value operand.");
    if (check.action === "count" && (typeof check.count !== "number" || !Number.isSafeInteger(check.count) || check.count < 0))
      throw new Error("The count check requires an explicit nonnegative integer count operand.");
  }
  const known = new Set(requirementSteps);
  if (checks.some((check) => !known.has(check.step)))
    throw new Error("The test plan references an unknown Gherkin step.");
  return requirementSteps.flatMap((id) => {
    const group = checks.filter((check) => check.step === id);
    if (!group.length) throw new Error("Every requirement step needs an explicit check: " + id);
    return group;
  });
}
