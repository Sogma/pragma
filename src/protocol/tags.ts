// docs/protocol.md's Tags: what a tag's name may be, and the tags a space
// declares, in `_tags.json` at its root. One reading of a tag wherever it is
// written, shared by the index, Classes, the Tags section, the tag inputs and
// the pills, so none of them disagrees about what a value names.

import { serializeEntryListFile } from "./entryListFile.ts";
import { entryNameKey } from "./entryName.ts";

// Space root, single fixed location, never redefinable per folder: a tag's
// meaning has to be consistent everywhere it's used.
export const TAGS_FILENAME = "_tags.json";

export interface TagDefinition {
  name: string;
  // As the entry holds it; "" for none.
  color: string;
}

/** One tag's change: declares `name` when nothing does yet, sets the color
 * given ("" takes it off the entry), or takes the entry out. */
export interface TagChange {
  name: string;
  color?: string;
  remove?: boolean;
}

// A tag name's characters: no whitespace, and no punctuation but `_`, `-` and
// `/`. Punctuation is ASCII's, and Unicode's General and Supplemental
// Punctuation blocks. Shared with the reading of `#name` in text, so a tag
// read from a file is always one a note could write.
export const TAG_NAME_CHARACTER = /[^\s -⁯⸀-⹿!"#$%&'()*+,.:;<=>?@[\\\]^`{|}~]/;
const TAG_NAME = new RegExp(`^${TAG_NAME_CHARACTER.source}+$`);
const DIGITS = /^[0-9]+$/;

/** Whether `name` is a tag's name: one or more of its characters, and not
 * only the digits 0–9. */
export function isTagName(name: string): boolean {
  return TAG_NAME.test(name) && !DIGITS.test(name);
}

/** `value` trimmed, with one leading `#` dropped: `#` marks a tag in text and
 * is never part of its name. What's left may still name no tag. */
export function unmarkedTagName(value: string): string {
  return value.trim().replace(/^#/, "");
}

/** The tag `value` names, as a file or a person writes it, or undefined for
 * a value that names none. */
export function tagNameOf(value: string): string | undefined {
  const name = unmarkedTagName(value);
  return isTagName(name) ? name : undefined;
}

/** Why `value` names no tag, phrased for whoever typed it, or null if it
 * names one. */
export function illegalTagNameReason(value: string): string | null {
  const name = unmarkedTagName(value);
  if (isTagName(name)) return null;
  if (name === "") return "A tag needs a name";
  if (DIGITS.test(name)) return "A tag can't be only digits";
  return "A tag can't contain spaces, or punctuation other than _ - and /";
}

/** The form two tags are compared in: case aside, as entry names are, so
 * `Draft` and `draft` are one tag. */
export function tagKey(name: string): string {
  return entryNameKey(name);
}

export function sameTag(a: string, b: string): boolean {
  return tagKey(a) === tagKey(b);
}

/** Whether `tag` is `wanted` or nested under it, as `project/alpha` is under
 * `project`. */
export function isTagOrNested(tag: string, wanted: string): boolean {
  const key = tagKey(tag);
  const under = tagKey(wanted);
  return key === under || key.startsWith(`${under}/`);
}

/** The tags a `tags` value names: a list's text items, or a lone text value,
 * as `tags: poetry` is read. An item that names no tag, or isn't text, is
 * none. */
export function tagsOf(value: unknown): string[] {
  const items = Array.isArray(value) ? value : [value];
  return items.flatMap((item) => {
    const name = typeof item === "string" ? tagNameOf(item) : undefined;
    return name === undefined ? [] : [name];
  });
}

/** The entry declaring `name`: of two naming one tag, the first. */
export function tagDefinition(tags: readonly TagDefinition[], name: string): TagDefinition | undefined {
  const key = tagKey(name);
  return tags.find((tag) => tagKey(tag.name) === key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// The tag an entry declares, its `name` read as any tag value is.
const nameOf = (entry: unknown): string | undefined =>
  isRecord(entry) && typeof entry.name === "string" ? tagNameOf(entry.name) : undefined;

/** Every entry of a parsed `_tags.json` that names a tag, in file order. */
export function tagDefinitions(file: unknown): TagDefinition[] {
  const entries = isRecord(file) && Array.isArray(file.tags) ? file.tags : [];
  const definitions: TagDefinition[] = [];
  for (const entry of entries) {
    const name = nameOf(entry);
    if (name === undefined || !isRecord(entry)) continue;
    definitions.push({ name, color: typeof entry.color === "string" ? entry.color.trim() : "" });
  }
  return definitions;
}

/** `file` with `change` applied to the first entry naming the tag, in any
 * case, or to a new one added last. Every other key and entry is kept as it
 * was: a writer keeps what it doesn't read (docs/protocol.md's Tags). */
export function withTagChange(file: unknown, change: TagChange): Record<string, unknown> {
  const next: Record<string, unknown> = isRecord(file) ? { ...file } : {};
  const tags: unknown[] = Array.isArray(next.tags) ? [...next.tags] : [];
  const index = tags.findIndex((entry) => {
    const name = nameOf(entry);
    return name !== undefined && sameTag(name, change.name);
  });
  if (change.remove) {
    if (index !== -1) tags.splice(index, 1);
  } else {
    const entry: Record<string, unknown> = index === -1 ? { name: change.name } : { ...(tags[index] as object) };
    if (change.color === "") delete entry.color;
    else if (change.color !== undefined) entry.color = change.color;
    if (index === -1) tags.push(entry);
    else tags[index] = entry;
  }
  next.tags = tags;
  return next;
}

/** `_tags.json` as Pragma writes it: one line per tag, so adding, recoloring
 * or removing one tag is a one-line diff. Any other key keeps its value. */
export function serializeTagsFile(file: Record<string, unknown>): string {
  return serializeEntryListFile(file, "tags");
}
