import type { ModelLists } from "../../../web/services/modelLists.ts";

// Model lists that never arrive, for a Flow view whose test isn't about its
// model pickers. The pickers over real lists are modelOptions.test.ts's.
export function emptyModelLists(): ModelLists {
  return {
    get: () => undefined,
    load() {},
    refresh: async () => {},
    defaultOf: () => "",
    setDefault: async () => {},
    subscribe: () => () => {},
  };
}
