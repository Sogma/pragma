import { PUBLICATION_DATE_KEY } from "../../src/protocol/frontmatter.ts";
import { opensScope } from "../../src/protocol/scopes.ts";

// The keys Pragma acts on, whose icon says what it does with them. Any other
// key's icon names its value's type, so it changes with the value.
const KNOWN_KEYS: ReadonlySet<string> = new Set(["tags", "description", PUBLICATION_DATE_KEY, "visibility"]);

/** A frontmatter property's icon, beside its key. `path` is the document's:
 * `pragma` wears the scope mark only where it opens a scope, in an
 * `AGENTS.md`, and elsewhere is any other key. */
export function propertyIcon(key: string, data: Record<string, unknown>, path?: string): HTMLElement {
  const icon = document.createElement("span");
  icon.className = "property-icon";
  icon.setAttribute("aria-hidden", "true");
  if (KNOWN_KEYS.has(key) || (key === "pragma" && path !== undefined && opensScope(path, () => data))) {
    icon.dataset.knownKey = key;
  } else {
    icon.dataset.valueType = valueType(data[key]);
  }
  return icon;
}

function valueType(value: unknown): "text" | "number" | "boolean" | "list" | "object" {
  if (Array.isArray(value)) return "list";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  return value !== null && typeof value === "object" ? "object" : "text";
}
