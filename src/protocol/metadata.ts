// The `<dl data-role="metadata">` block a Table, Flow and Class
// carry: what the file says about itself, as a note's frontmatter does
// (docs/protocol.md's Metadata section). Pure, so the server and the browser
// read it alike; the block's reader and writer sit with the Table's.
import { isListFrontmatterKey } from "./frontmatter.ts";
import { isClassFile, isFlowFile, isTableFile, type MetadataEntry } from "./types.ts";

export function hasMetadataBlock(filePath: string): boolean {
  return isTableFile(filePath) || isFlowFile(filePath) || isClassFile(filePath);
}

/** A key's text: its first value, or undefined when it has none. */
export function metadataText(metadata: readonly MetadataEntry[] | undefined, key: string): string | undefined {
  return metadata?.find((entry) => entry.key === key)?.values[0];
}

/** The keys a host sets on a Table itself, which no one else writes. */
export const TABLE_DATE_KEYS = ["created", "modified"] as const;

/** A Table's dates after a save on `day`: `created` set the first time,
 * `modified` every time, each in its place or else at the end. */
export function stampTableDates(metadata: readonly MetadataEntry[] | undefined, day: string): MetadataEntry[] {
  const created = metadataText(metadata, "created") ?? day;
  return withText(withText(metadata ?? [], "created", created), "modified", day);
}

function withText(metadata: readonly MetadataEntry[], key: string, text: string): MetadataEntry[] {
  const entry = { key, values: [text] };
  return metadata.some((each) => each.key === key)
    ? metadata.map((each) => (each.key === key ? entry : each))
    : [...metadata, entry];
}

/** Whether the block marks its file private (docs/architecture.md's Privacy
 * section). A `visibility` holding `private` among other values counts too:
 * a misread here sends a file to a model. */
export function isPrivateMetadata(metadata: readonly MetadataEntry[] | undefined): boolean {
  return metadata?.some((entry) => entry.key === "visibility" && entry.values.includes("private")) ?? false;
}

/** The block as a property editor's data: one value as text, several as a
 * list, none as "", and `tags` always a list, as in frontmatter. */
export function metadataProperties(metadata: readonly MetadataEntry[] | undefined): Record<string, string | string[]> {
  const properties: Record<string, string | string[]> = {};
  for (const { key, values } of metadata ?? []) {
    properties[key] = isListFrontmatterKey(key) || values.length > 1 ? [...values] : (values[0] ?? "");
  }
  return properties;
}

/** A property editor's data as the block, in the editor's order, which keeps
 * a renamed key in its place. */
export function metadataFromProperties(properties: Record<string, unknown>): MetadataEntry[] {
  return Object.entries(properties).map(([key, value]) => ({ key, values: metadataValues(value) }));
}

// A value is text: a list's items are its values, and an empty one is none.
function metadataValues(value: unknown): string[] {
  return (Array.isArray(value) ? value : [value]).flatMap((item) => {
    if (item === null || item === undefined) return [];
    const text = (typeof item === "object" ? JSON.stringify(item) : String(item)).trim();
    return text ? [text] : [];
  });
}
