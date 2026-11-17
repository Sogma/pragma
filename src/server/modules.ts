// Pragma's server modules, each registered here with the registries core
// consults, so no other file in core names a module.
import { type ContextSourceRegistry, createContextSources } from "./copilotContext.ts";
import { okfContext } from "./modules/okf/context.ts";

/** The context sources of the modules Pragma ships. */
export function shippedContextSources(): ContextSourceRegistry {
  const sources = createContextSources();
  sources.register("okf", okfContext);
  return sources;
}
