import { it, expect } from "vitest";
import {
  createScenarioAdapter,
  adapterFromHandlers,
  type DataAdapter,
} from "../server/templates/adapter";
type Queries = {
  notice: { input: { id: string }; output: { title: string } | null };
};
type Operations = {
  acknowledge: { input: { id: string }; output: { ok: boolean } };
};
it("resets scenario data and permits replacing queries/operations without changing controller validation", async () => {
  const mock = createScenarioAdapter<{ read: boolean }, Queries, Operations>(
    { read: false },
    (state) => ({
      queries: { notice: () => ({ title: state.read ? "Read" : "Notice" }) },
      operations: {
        acknowledge: () => {
          state.read = true;
          return { ok: true };
        },
      },
    }),
  );
  const replacement = adapterFromHandlers<Queries, Operations>(
    { notice: async ({ id }) => (id === "n1" ? { title: "Notice" } : null) },
    { acknowledge: async () => ({ ok: true }) },
  );
  const controller = async (
    adapter: DataAdapter<Queries, Operations>,
    id: string,
  ) => {
    if (!id.trim()) return "A notice is required";
    const notice = await adapter.query("notice", { id });
    if (!notice) return "No notice";
    const result = await adapter.operate("acknowledge", { id });
    return result.ok ? "Acknowledged" : "Try again";
  };
  for (const adapter of [mock, replacement]) {
    expect(await controller(adapter, "")).toBe("A notice is required");
    expect(await controller(adapter, "n1")).toBe("Acknowledged");
  }
  expect(await mock.query("notice", { id: "n1" })).toEqual({ title: "Read" });
  mock.reset();
  expect(await mock.query("notice", { id: "n1" })).toEqual({ title: "Notice" });
});
