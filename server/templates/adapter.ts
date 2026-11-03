/** Keep validation and interaction state in the page/controller. Replace only these data methods. */
export type Endpoint = { input: unknown; output: unknown };
export type Handlers<C extends Record<string, Endpoint>> = {
  [K in keyof C]: (
    input: C[K]["input"],
  ) => C[K]["output"] | Promise<C[K]["output"]>;
};
export interface DataAdapter<
  Q extends Record<string, Endpoint>,
  O extends Record<string, Endpoint>,
> {
  query<K extends keyof Q>(
    name: K,
    input: Q[K]["input"],
  ): Promise<Q[K]["output"]>;
  operate<K extends keyof O>(
    name: K,
    input: O[K]["input"],
  ): Promise<O[K]["output"]>;
}
export function adapterFromHandlers<
  Q extends Record<string, Endpoint>,
  O extends Record<string, Endpoint>,
>(queries: Handlers<Q>, operations: Handlers<O>): DataAdapter<Q, O> {
  return {
    query: async (name, input) => queries[name](input),
    operate: async (name, input) => operations[name](input),
  };
}
/** Each scenario owns its own initial state. Reset rebuilds handlers over a fresh copy. */
export function createScenarioAdapter<
  S,
  Q extends Record<string, Endpoint>,
  O extends Record<string, Endpoint>,
>(
  initialState: S,
  configure: (state: S) => { queries: Handlers<Q>; operations: Handlers<O> },
): DataAdapter<Q, O> & { reset(): void } {
  let handlers = configure(structuredClone(initialState));
  return {
    query: async (name, input) => handlers.queries[name](input),
    operate: async (name, input) => handlers.operations[name](input),
    reset: () => {
      handlers = configure(structuredClone(initialState));
    },
  };
}
