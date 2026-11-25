import { readFile } from "node:fs/promises";
import { HTMLElement, parse } from "node-html-parser";
import { readCardBlock, readFieldColumns, readMetadataBlock } from "./tableFile.ts";
import type { ClassFile, ClassRule, ClassView } from "./types.ts";
import { emptyClass, parseTableLayout } from "./types.ts";

/** Graceful-fallback reader, as for every other kind: a missing, empty or
 * malformed file reads as an empty Class. For callers that never save
 * what they read; one that saves parses the text itself, below. */
export async function readClassFile(filePath: string): Promise<ClassFile> {
  try {
    return parseClassFile(await readFile(filePath, "utf8")) ?? emptyClass();
  } catch {
    return emptyClass();
  }
}

/** Blank text is a new, empty Class; non-blank text that isn't one is
 * `undefined`, never an empty Class, since saving that back would erase
 * the file (docs/protocol.md's "Reading and write protection"). */
export function parseClassFile(raw: string): ClassFile | undefined {
  if (!raw.trim()) return emptyClass();
  try {
    const root = parse(raw);
    const html = root.querySelector("html");
    if (html?.getAttribute("data-format") !== "class") return undefined;
    // The filter, views and links are read from the body's own children: a
    // view carries a filter of its own, which a document-wide query would
    // take for the Class's.
    const body = root.querySelector("body") ?? html;
    const paths = (role: string) =>
      childElements(childElements(body, "ul", role)[0], "li").map((li) => li.textContent.trim());
    const card = readCardBlock(childElements(body, "ol", "card")[0]);

    return {
      version: html.getAttribute("data-format-version") || "1.0",
      name: root.querySelector("head > title")?.textContent.trim() || undefined,
      metadata: readMetadataBlock(root),
      filter: readRules(childElements(body, "ul", "filter")[0]),
      fields: readFieldColumns(root.querySelector("table[data-role=fields] thead") ?? null),
      views: childElements(childElements(body, "ol", "views")[0], "li").map(readView),
      links: paths("links").filter(Boolean),
      ...(card ? { card } : {}),
    };
  } catch {
    return undefined;
  }
}

function childElements(parent: HTMLElement | undefined, tag: string, role?: string): HTMLElement[] {
  return (parent?.childNodes ?? []).filter(
    (node): node is HTMLElement =>
      node instanceof HTMLElement &&
      node.rawTagName?.toLowerCase() === tag &&
      (role === undefined || node.getAttribute("data-role") === role),
  );
}

// A rule's values and a view's fields are comma-separated, as a select's
// options are.
function commaList(text: string): string[] {
  return text
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function readRules(list: HTMLElement | undefined): ClassRule[] {
  return childElements(list, "li").flatMap((li) => {
    const property = li.getAttribute("data-property")?.trim();
    const test = li.getAttribute("data-test")?.trim();
    if (!property || !test) return [];
    return [{ property, test, values: commaList(li.textContent) }];
  });
}

function readView(li: HTMLElement): ClassView {
  const sort = li.getAttribute("data-sort")?.trim();
  const groupBy = li.getAttribute("data-group-by")?.trim();
  const fields = li.getAttribute("data-fields");
  return {
    name: li.getAttribute("data-name")?.trim() ?? "",
    layout: parseTableLayout(li.getAttribute("data-layout")) ?? "list",
    ...(sort ? { sort: { property: sort, order: li.getAttribute("data-order") === "desc" ? "desc" : "asc" } } : {}),
    ...(groupBy ? { groupBy } : {}),
    ...(fields !== undefined ? { fields: commaList(fields) } : {}),
    filter: readRules(childElements(li, "ul", "filter")[0]),
  };
}
