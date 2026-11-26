import { PUBLICATION_DATE_KEY } from "../../src/protocol/frontmatter.ts";
import { opensScope } from "../../src/protocol/scopes.ts";
import type { FieldDefinition } from "../../src/protocol/types.ts";

// The keys Pragma acts on, whose icon says what it does with them. Any other
// key's icon names its field's type where a Class gives it one, else its
// value's type, so it changes with the value.
const KNOWN_KEYS: ReadonlySet<string> = new Set(["tags", "description", PUBLICATION_DATE_KEY, "visibility"]);

/** A frontmatter property's icon, beside its key. `path` is the document's:
 * `pragma` wears the scope mark only where it opens a scope, in an
 * `AGENTS.md`, and elsewhere is any other key. `field` is the one the key is
 * drawn with. */
export function propertyIcon(
  key: string,
  data: Record<string, unknown>,
  path?: string,
  field?: FieldDefinition,
): HTMLElement {
  const icon = document.createElement("span");
  icon.className = "property-icon";
  icon.setAttribute("aria-hidden", "true");
  if (KNOWN_KEYS.has(key) || (key === "pragma" && path !== undefined && opensScope(path, () => data))) {
    icon.dataset.knownKey = key;
  } else if (field) {
    icon.dataset.fieldType = field.type;
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
