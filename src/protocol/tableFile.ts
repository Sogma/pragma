import { readFile } from "node:fs/promises";
import { type HTMLElement, parse } from "node-html-parser";
import type { CardTile, MetadataEntry, TableColumn, TableFile, TableRow } from "./types.ts";
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

    return {
      version: html.getAttribute("data-format-version") || "1.0",
      name: root.querySelector("head > title")?.textContent.trim() || undefined,
      metadata: readMetadataBlock(root),
      columns,
      rows: readRows(data?.querySelector("tbody") ?? null, columns),
      ...(layout ? { layout } : {}),
      ...(card ? { card } : {}),
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
      const entry: MetadataEntry = { key: child.textContent.trim(), values: [] };
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
  const span = (raw: string | undefined): number | undefined => {
    const value = Number(raw?.trim());
    return Number.isInteger(value) && value >= 1 ? value : undefined;
  };
  return list.children.flatMap((li): CardTile[] => {
    if (li.tagName !== "LI") return [];
    const field = li.getAttribute("data-field")?.trim();
    if (field) {
      const columns = span(li.getAttribute("data-columns"));
      const rows = span(li.getAttribute("data-rows"));
      return [{ field, ...(columns ? { columns } : {}), ...(rows ? { rows } : {}) }];
    }
    const heading = li.getAttribute("data-heading");
    return heading === undefined ? [] : [{ heading: heading.trim() }];
  });
}

// What a header says whatever its column's type.
const READ_ATTRIBUTES = ["data-field", "data-type", "data-options", "data-media-folder"];

/** A `<thead>`'s columns, the field definitions a Table and a Class
 * share, so the two kinds read them alike. */
export function readFieldColumns(thead: HTMLElement | null): TableColumn[] {
  if (!thead) return [];
  return thead.querySelectorAll("th").map((th) => {
    const written = th.getAttribute("data-type");
    const optionsAttr = th.getAttribute("data-options");
    const column: TableColumn = {
      id: th.getAttribute("data-field") || "",
      type: parseFieldValueType(written),
      label: th.textContent.trim(),
    };
    if (written && written !== column.type) column.unknownType = written;
    if (optionsAttr) column.options = optionsAttr.split(",").map((option) => option.trim());
    const mediaFolder = th.getAttribute("data-media-folder");
    if (mediaFolder) column.mediaFolder = mediaFolder;
    const read = new Set(READ_ATTRIBUTES);
    if (column.type === "media" && th.hasAttribute("data-show-name")) {
      column.showName = true;
      read.add("data-show-name");
    }
    if (column.type === "timestamp" && th.getAttribute("data-default") === "now") {
      column.default = "now";
      read.add("data-default");
    }
    const max = Number(th.getAttribute("data-max") ?? "");
    if (column.type === "score" && isScoreMax(max)) {
      column.max = max;
      read.add("data-max");
    }
    if (column.type === "score" && th.hasAttribute("data-reject")) {
      column.reject = true;
      read.add("data-reject");
    }
    const unknown = Object.entries(th.attributes).filter(([name]) => !read.has(name.toLowerCase()));
    if (unknown.length > 0) column.unknownAttributes = unknown;
    return column;
  });
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
