import type { LocalAI } from "../server/core/ai";
// Unexpected quality failures must fail the journey, never trigger a paid CI request.
export const accountFreeAI: Pick<LocalAI, "generate" | "cancel" | "close"> = {
  async generate() {
    throw new Error(
      "This deterministic fixture does not invoke account-backed AI.",
    );
  },
  async cancel() {},
  close() {},
};
