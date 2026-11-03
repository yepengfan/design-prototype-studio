// Shared by Studio checks and the runnable source handoff.
export function orderedScenarioSteps<T extends { step: string }>(
  requirementSteps: readonly string[],
  checks: readonly T[],
): T[] {
  const known = new Set(requirementSteps);
  if (checks.some((check) => !known.has(check.step)))
    throw new Error("The test plan references an unknown Gherkin step.");
  return requirementSteps.flatMap((id) => {
    const group = checks.filter((check) => check.step === id);
    if (!group.length) throw new Error("Every requirement step needs an explicit check: " + id);
    return group;
  });
}
