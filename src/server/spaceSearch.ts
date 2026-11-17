// The Search view's search: each file searched as what its kind holds, not
// as its source. A Table, Class or Flow is markup on disk, and a
// line match there is mostly noise — every one of them has a <title>, a
// data-type, a <select> — so those are read through their own readers and
// matched by value. Text documents and Applets match by line.
//
// The agent tools' search (tree.ts) stays on raw lines: an agent goes on to
// read and edit the raw file.
//
// A `tag:` term keeps the documents carrying the tag, as the document index
// has them. A query of tags alone lists where each document writes them.
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { SpaceSearchFile, SpaceSearchHit, SpaceSearchResponse } from "../protocol/api.ts";
import { readClassFile } from "../protocol/classFile.ts";
import { readFlowFile } from "../protocol/flowFile.ts";
import { FLOW_NODE_REGISTRY } from "../protocol/flowNodes.ts";
import { readSearchQuery } from "../protocol/searchQuery.ts";
import { readTableFile } from "../protocol/tableFile.ts";
import { isTagOrNested } from "../protocol/tags.ts";
import { isTemplatePath } from "../protocol/templates.ts";
import { isClassFile, isFlowFile, isTableFile, type MetadataEntry } from "../protocol/types.ts";
import { documentIndex, type IndexedTag } from "./documentIndex.ts";
import { searchableFiles } from "./tree.ts";

// A value shown on one row: a multi-line prompt reads as one line.
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

type Value = { label: string; text: string };

// Every value the file's metadata block holds, each under its key, as a
// note's frontmatter lines match.
function metadataValues(metadata: readonly MetadataEntry[] | undefined): Value[] {
  return (metadata ?? []).flatMap(({ key, values }) =>
    values.map((text) => ({ label: key === "description" ? "Description" : key, text })),
  );
}

async function tableValues(filePath: string): Promise<Value[]> {
  const table = await readTableFile(filePath);
  const values: Value[] = [];
  if (table.name) values.push({ label: "Title", text: table.name });
  values.push(...metadataValues(table.metadata));
  for (const column of table.columns) values.push({ label: "Column", text: column.label });
  for (const row of table.rows) {
    for (const column of table.columns) values.push({ label: column.label, text: row.values[column.id] ?? "" });
  }
  return values;
}

// The Class's own words: its notes are searched as notes.
async function classValues(filePath: string): Promise<Value[]> {
  const file = await readClassFile(filePath);
  const values: Value[] = [];
  if (file.name) values.push({ label: "Title", text: file.name });
  values.push(...metadataValues(file.metadata));
  for (const field of file.fields) values.push({ label: "Field", text: field.label });
  for (const view of file.views) if (view.name) values.push({ label: "View", text: view.name });
  return values;
}

async function flowValues(filePath: string): Promise<Value[]> {
  const flow = await readFlowFile(filePath);
  const values: Value[] = [];
  if (flow.name) values.push({ label: "Title", text: flow.name });
  values.push(...metadataValues(flow.metadata));
  for (const node of flow.graph.nodes) {
    const label = node.label || FLOW_NODE_REGISTRY[node.type]?.label || node.type;
    values.push({ label: "Node", text: label });
    for (const value of Object.values(node.config)) {
      if (typeof value === "string") values.push({ label, text: value });
    }
  }
  return values;
}

// Undefined for a kind with no reader, and for a file its reader found
// nothing in (the readers return an empty document for a malformed file
// rather than failing): both are searched by line instead, so a file pragma
// can't parse is still findable.
async function structuredValues(filePath: string): Promise<Value[] | undefined> {
  const read = isTableFile(filePath)
    ? tableValues
    : isClassFile(filePath)
      ? classValues
      : isFlowFile(filePath)
        ? flowValues
        : undefined;
  const values = read ? await read(filePath) : [];
  return values.length > 0 ? values : undefined;
}

async function textHits(filePath: string, needle: string): Promise<SpaceSearchHit[]> {
  const values = await structuredValues(filePath);
  if (values) {
    return values
      .filter(({ text }) => text.toLowerCase().includes(needle))
      .map(({ label, text }) => ({ label, text: oneLine(text) }));
  }
  return (await readFile(filePath, "utf8"))
    .split("\n")
    .flatMap((text, index) => (text.toLowerCase().includes(needle) ? [{ line: index + 1, text: text.trim() }] : []));
}

// Where a document writes the tags a query asks for: a line once for the tags
// written on it, and a property's tag by its key.
function tagHits(tags: readonly IndexedTag[], wanted: readonly string[]): SpaceSearchHit[] {
  const hits: SpaceSearchHit[] = [];
  const lines = new Set<number>();
  for (const tag of tags) {
    if (!wanted.some((name) => isTagOrNested(tag.name, name))) continue;
    if (tag.line === undefined) hits.push({ label: "tags", text: tag.name });
    else if (!lines.has(tag.line)) {
      lines.add(tag.line);
      hits.push({ line: tag.line, text: (tag.text ?? "").trim() });
    }
  }
  return hits;
}

// The documents carrying every tag in `wanted`, each with its tags.
async function carrying(spaceRoot: string, wanted: readonly string[]): Promise<Map<string, IndexedTag[]>> {
  const found = new Map<string, IndexedTag[]>();
  for (const document of await documentIndex().tagged({ dir: spaceRoot, root: "space" })) {
    const carries = (name: string) => document.tags.some((tag) => isTagOrNested(tag.name, name));
    if (wanted.every(carries)) found.set(document.path, document.tags);
  }
  return found;
}

/** Case-insensitive substring search over every file the space tree shows,
 * under `dir` when given, private documents included — this is the person
 * searching their own space, and nothing here reaches a model. Stops at
 * `maxMatches` and says so. */
export async function searchSpaceContent(
  spaceRoot: string,
  query: string,
  options: { dir?: string; maxMatches: number },
): Promise<SpaceSearchResponse> {
  const { tags: wanted, text } = readSearchQuery(query);
  const needle = text.toLowerCase();
  if (!needle && wanted.length === 0) return { files: [], truncated: false };
  const tagged = wanted.length > 0 ? await carrying(spaceRoot, wanted) : undefined;

  const prefix = options.dir ? `${options.dir}/` : "";
  // A template is found only by a search narrowed to the templates: the
  // rest of the space is its content, which never holds one.
  const amongTemplates = options.dir !== undefined && isTemplatePath(options.dir);
  const files: SpaceSearchFile[] = [];
  let count = 0;

  for (const relativePath of await searchableFiles(spaceRoot)) {
    if (!relativePath.startsWith(prefix)) continue;
    if (!amongTemplates && isTemplatePath(relativePath)) continue;
    const tags = tagged?.get(relativePath);
    if (tagged && !tags) continue;
    const hits = tags && !needle ? tagHits(tags, wanted) : await textHits(path.join(spaceRoot, relativePath), needle);
    if (hits.length === 0) continue;
    const room = options.maxMatches - count;
    files.push({ path: relativePath, matches: hits.slice(0, room) });
    count += Math.min(hits.length, room);
    if (hits.length > room) return { files, truncated: true };
  }

  return { files, truncated: false };
}
