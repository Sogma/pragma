import { readFile } from "node:fs/promises";
import { type HTMLElement, parse } from "node-html-parser";
import type { MetadataEntry, TableColumn, TableFile, TableRow } from "./types.ts";
import { emptyTable, parseFieldValueType, parseTableLayout } from "./types.ts";

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

    return {
      version: html.getAttribute("data-format-version") || "1.0",
      name: root.querySelector("head > title")?.textContent.trim() || undefined,
      metadata: readMetadataBlock(root),
      columns,
      rows: readRows(data?.querySelector("tbody") ?? null, columns),
      ...(layout ? { layout } : {}),
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

/** A `<thead>`'s columns, the field definitions a Table and a Class
 * share, so the two kinds read them alike. */
export function readFieldColumns(thead: HTMLElement | null): TableColumn[] {
  if (!thead) return [];
  return thead.querySelectorAll("th").map((th) => {
    const type = th.getAttribute("data-type");
    const optionsAttr = th.getAttribute("data-options");
    const column: TableColumn = {
      id: th.getAttribute("data-field") || "",
      type: parseFieldValueType(type),
      label: th.textContent.trim(),
    };
    if (optionsAttr) column.options = optionsAttr.split(",").map((option) => option.trim());
    const mediaFolder = th.getAttribute("data-media-folder");
    if (mediaFolder) column.mediaFolder = mediaFolder;
    if (column.type === "media" && th.hasAttribute("data-show-name")) column.showName = true;
    if (column.type === "timestamp" && th.getAttribute("data-default") === "now") column.default = "now";
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
