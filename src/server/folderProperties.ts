// A directory's own `_properties.json` (docs/protocol.md, Folder order).
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { PROPERTIES_FILENAME } from "../protocol/pragmaFiles.ts";
import { namedEntryPath, refuseLink } from "./rootedFiles.ts";

/** Reads `<dir>/_properties.json` if present — a directory's counterpart to
 * a document's frontmatter; missing or malformed reads as "no properties".
 * Kept apart from `_structure.json`, whose presence means manual order, so
 * a sort rule never switches that on. It travels with the folder on a move. */

export function readFolderProperties(dir: string): Record<string, unknown> {
  const propertiesPath = namedEntryPath(dir, PROPERTIES_FILENAME);
  if (!existsSync(propertiesPath)) return {};

  try {
    refuseLink(dir, propertiesPath);
    const parsed = JSON.parse(readFileSync(propertiesPath, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Writes `<dir>/_properties.json` wholesale. No properties left means no
 * file, so it deletes the file when every value in `data` is empty, not just
 * when `data` has no keys: an empty list or string is still nothing worth a
 * file for. */

export function writeFolderProperties(dir: string, data: Record<string, unknown>): void {
  const propertiesPath = namedEntryPath(dir, PROPERTIES_FILENAME);
  const isEmptyValue = (value: unknown): boolean =>
    Array.isArray(value) ? value.length === 0 : value === "" || value === null || value === undefined;
  if (Object.values(data).every(isEmptyValue)) {
    if (existsSync(propertiesPath)) unlinkSync(propertiesPath);
    return;
  }
  refuseLink(dir, propertiesPath);
  writeFileSync(propertiesPath, `${JSON.stringify(data, null, 2)}\n`);
}
