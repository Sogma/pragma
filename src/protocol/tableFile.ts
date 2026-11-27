import { readFile } from "node:fs/promises";
import { type HTMLElement, parse } from "node-html-parser";
import { isMetadataType } from "./metadata.ts";
import type {
  CardTile,
  FieldDefinition,
  MetadataEntry,
  SmallCardTile,
  TableColumn,
  TableFile,
  TableRow,
} from "./types.ts";
import { emptyTable, isScoreMax, parseFieldValueType, parseTableLayout } from "./types.ts";

/** Graceful-fallback reader, same convention as every other file reader in
 * this codebase: a missing, empty, or malformed `.table.html` file never
 * throws, it just reads as a table with no columns/rows — what a brand-new
 * file created via "New File" looks like before anyone's defined its shape.
 *
 * For callers that never save what they read. One that saves parses the
 * text itself, below, which tells blank from unreadable. */
export async function readTableFile(filePath: string): Promise<TableFile> {
  try {
    return parseTableFile(await readFile(filePath, "utf8")) ?? emptyTable();
  } catch {
    return emptyTable();
  }
}

/** Blank text is a new, empty table; non-blank text that isn't one is
 * `undefined`, never an empty table. Saving that empty table back would
 * erase the file (docs/protocol.md's "Reading and write protection"). */
export function parseTableFile(raw: string): TableFile | undefined {
  if (!raw.trim()) return emptyTable();
  try {
    const root = parse(raw);
    const html = root.querySelector("html");
    if (html?.getAttribute("data-format") !== "table") return undefined;

    const data = root.querySelector("table[data-role=data]");
    const columns = readFieldColumns(data?.querySelector("thead") ?? null);
    const layout = parseTableLayout(data?.getAttribute("data-layout"));
    const card = readCardBlock(root.querySelector("body > ol[data-role=card]"));
    const smallCard = readSmallCardBlock(root.querySelector("body > ol[data-role=small-card]"));
    const links = root
      .querySelectorAll("body > ul[data-role=links] > li")
      .map((li) => li.textContent.trim())
      .filter(Boolean);

    return {
      version: html.getAttribute("data-format-version") || "1.0",
      name: root.querySelector("head > title")?.textContent.trim() || undefined,
      metadata: readMetadataBlock(root),
      columns,
      rows: readRows(data?.querySelector("tbody") ?? null, columns),
      ...(layout ? { layout } : {}),
      ...(card ? { card } : {}),
      ...(smallCard ? { smallCard } : {}),
      ...(links.length > 0 ? { links } : {}),
    };
  } catch {
    return undefined;
  }
}

/** The `<dl data-role="metadata">` block a Flow and Class share
 * with a Table, in file order. Grouped as HTML groups a description list:
 * the `<dt>`s in a run share the `<dd>`s after them. A key written twice
 * keeps its first group, an empty value is none, and a key with none is
 * still an entry. */
export function readMetadataBlock(root: HTMLElement): MetadataEntry[] {
  const dl = root.querySelector("dl[data-role=metadata]");
  if (!dl) return [];
  const entries: MetadataEntry[] = [];
  let names: MetadataEntry[] = [];
  let named = true;
  for (const child of dl.children) {
    if (child.tagName === "DT") {
      if (!named) names = [];
      named = true;
      const field = readKeyType(child);
      const entry: MetadataEntry = { key: child.textContent.trim(), values: [], ...(field ? { field } : {}) };
      // A repeat still joins the run, so its values land nowhere.
      if (entry.key && !entries.some((each) => each.key === entry.key)) entries.push(entry);
      names.push(entry);
    } else if (child.tagName === "DD") {
      named = false;
      const value = child.textContent.trim();
      if (value) for (const entry of names) entry.values.push(value);
    }
  }
  return entries;
}

/** A row's card, the `<ol data-role="card">` a Table and a Class share:
 * its tiles in order, or undefined with no block. An item naming neither a
 * field nor a heading is skipped, and a span that isn't a whole number from
 * 1 up is left to the host. */
export function readCardBlock(list: HTMLElement | null | undefined): CardTile[] | undefined {
  if (!list) return undefined;
  return list.children.flatMap((li) => {
    const tile = li.tagName === "LI" ? readCardTile(li) : undefined;
    return tile ? [tile] : [];
  });
}

/** The card a cards view draws, the `<ol data-role="small-card">` a Table
 * and a Class share: a row card's tiles, and `data-title` for the card's
 * title, or undefined with no block. */
export function readSmallCardBlock(list: HTMLElement | null | undefined): SmallCardTile[] | undefined {
  if (!list) return undefined;
  return list.children.flatMap((li): SmallCardTile[] => {
    if (li.tagName !== "LI") return [];
    if (!li.getAttribute("data-field")?.trim() && li.getAttribute("data-title") !== undefined) {
      return [{ title: true, ...tileSpans(li) }];
    }
    const tile = readCardTile(li);
    return tile ? [tile] : [];
  });
}

function readCardTile(li: HTMLElement): CardTile | undefined {
  const field = li.getAttribute("data-field")?.trim();
  if (field) return { field, ...tileSpans(li) };
  const heading = li.getAttribute("data-heading");
  return heading === undefined ? undefined : { heading: heading.trim() };
}

function tileSpans(li: HTMLElement): { columns?: number; rows?: number } {
  const span = (raw: string | undefined): number | undefined => {
    const value = Number(raw?.trim());
    return Number.isInteger(value) && value >= 1 ? value : undefined;
  };
  const columns = span(li.getAttribute("data-columns"));
  const rows = span(li.getAttribute("data-rows"));
  return { ...(columns ? { columns } : {}), ...(rows ? { rows } : {}) };
}

// What a type's attributes say whatever the type.
const READ_ATTRIBUTES = ["data-type", "data-options", "data-media-folder"];

// A type and its settings, as a column's `<th>` or a key's `<dt>` says them,
// and the attributes this build doesn't read but those in `own`, which the
// element's reader takes itself.
function readFieldDefinition(el: HTMLElement, own: readonly string[]): FieldDefinition {
  const written = el.getAttribute("data-type");
  const optionsAttr = el.getAttribute("data-options");
  const field: FieldDefinition = { type: parseFieldValueType(written) };
  if (written && written !== field.type) field.unknownType = written;
  if (optionsAttr) field.options = optionsAttr.split(",").map((option) => option.trim());
  const mediaFolder = el.getAttribute("data-media-folder");
  if (mediaFolder) field.mediaFolder = mediaFolder;
  const read = new Set([...own, ...READ_ATTRIBUTES]);
  if (field.type === "media" && el.hasAttribute("data-show-name")) {
    field.showName = true;
    read.add("data-show-name");
  }
  if (field.type === "timestamp" && el.getAttribute("data-default") === "now") {
    field.default = "now";
    read.add("data-default");
  }
  const max = Number(el.getAttribute("data-max") ?? "");
  if (field.type === "score" && isScoreMax(max)) {
    field.max = max;
    read.add("data-max");
  }
  if (field.type === "score" && el.hasAttribute("data-reject")) {
    field.reject = true;
    read.add("data-reject");
  }
  const unknown = Object.entries(el.attributes).filter(([name]) => !read.has(name.toLowerCase()));
  if (unknown.length > 0) field.unknownAttributes = unknown;
  return field;
}

/** A `<thead>`'s columns, the field definitions a Table and a Class
 * share, so the two kinds read them alike. */
export function readFieldColumns(thead: HTMLElement | null): TableColumn[] {
  if (!thead) return [];
  return thead.querySelectorAll("th").map((th) => {
    const field = readFieldDefinition(th, ["data-field"]);
    return { id: th.getAttribute("data-field") || "", label: th.textContent.trim(), ...field };
  });
}

// A key's type, from its `<dt>`: none for one that says nothing beyond text,
// so a plain key stays plain. `media` and `path` are no key's type, so one
// reads as text and is kept as written, as a type this build doesn't know is.
function readKeyType(dt: HTMLElement): FieldDefinition | undefined {
  const field = readFieldDefinition(dt, []);
  if (!isMetadataType(field.type)) {
    field.unknownType ??= field.type;
    field.type = "text";
  }
  const { type, ...rest } = field;
  return type === "text" && Object.keys(rest).length === 0 ? undefined : field;
}

function readRows(tbody: HTMLElement | null, columns: TableColumn[]): TableRow[] {
  if (!tbody) return [];
  return tbody.querySelectorAll("tr").map((tr) => {
    const cells = tr.querySelectorAll("td");
    const values: Record<string, string> = {};
    columns.forEach((column, index) => {
      values[column.id] = cells[index]?.textContent.trim() ?? "";
    });
    return { values };
  });
}
