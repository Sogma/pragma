// A page's `params` (docs/publishing.md's Frontmatter fields section): the
// frontmatter keys its publisher's `DocumentParams` schema lists, sent under
// the same names. The list is the publisher's and never kept here, so a key
// the service adds reaches authors without a Pragma release.

import { pointerSegments } from "./settingsSchema.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The keys a publisher takes as `params`: the property names of its
 * `DocumentParams` schema. `undefined` when it has none, and so takes no
 * `params` at all. */
export function documentParamKeys(schema: unknown): string[] | undefined {
  if (!isRecord(schema)) return undefined;
  return isRecord(schema.properties) ? Object.keys(schema.properties) : [];
}

/** The `params` a page sends: each listed key its frontmatter sets, with the
 * value as written. Empty text sets nothing, as an empty `date` does.
 *
 * A key with no value goes out as `null`, and the publisher refuses it: YAML
 * reads `anchor: #v0.6.1` as a key and a comment, and dropping it here would
 * lose what the author typed without a word. */
export function documentParams(data: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const entries: [string, unknown][] = [];
  for (const key of keys) {
    if (!Object.hasOwn(data, key)) continue;
    const value = data[key];
    if (typeof value === "string" && value.trim() === "") continue;
    entries.push([key, value]);
  }
  return Object.fromEntries(entries);
}

/** The `params` key a refusal's JSON Pointer names (`/params/anchor` →
 * `anchor`), or `undefined` for a pointer anywhere else. */
export function paramKeyOf(field: string | undefined): string | undefined {
  if (field === undefined) return undefined;
  const segments = pointerSegments(field);
  return segments.length === 2 && segments[0] === "params" ? segments[1] : undefined;
}
