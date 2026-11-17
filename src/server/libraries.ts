// A space's libraries as this host finds them: each one its `_libraries.json`
// declares (src/protocol/libraries.ts), at the folder its space's registry
// entry keeps (docs/architecture.md's Space identity and state ownership). Reads
// only: the write doorway, rootedFiles.ts, resolves `lib:` paths through
// here, so the writers are in spaceLibraries.ts.
import { existsSync, readFileSync } from "node:fs";
import { findSpaceId, type LibraryLocation, loadGlobalConfig } from "../config/loadConfig.ts";
import type { Access, LibraryEntry, LibraryRow, SpaceLibrariesResponse } from "../protocol/api.ts";
import { LIBRARIES_FILENAME, libraryDeclarations } from "../protocol/libraries.ts";
import { isLibraryId } from "../protocol/rootedPath.ts";
import { linkBelow, namedEntryPath } from "./entryOnDisk.ts";

/** The space's `_libraries.json`, or why it declares nothing when it exists
 * but doesn't read. Missing declares nothing. */
export function readLibrariesFile(spaceRoot: string): { file: Record<string, unknown> | undefined; problem?: string } {
  const filePath = namedEntryPath(spaceRoot, LIBRARIES_FILENAME);
  // A link reads as absent, as every file Pragma names itself does.
  if (!existsSync(filePath) || linkBelow(spaceRoot, filePath) !== undefined) return { file: undefined };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { file: undefined, problem: `${LIBRARIES_FILENAME} doesn't parse: ${reason}` };
  }
  const isObject = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed);
  const file = isObject ? (parsed as Record<string, unknown>) : undefined;
  if (!file || (file.libraries !== undefined && !Array.isArray(file.libraries))) {
    return { file: undefined, problem: `${LIBRARIES_FILENAME} holds no list of libraries` };
  }
  return { file };
}

/** Where this host keeps each of the space's libraries, by id: none at all
 * for a space the registry doesn't hold, so its `lib:` paths name nothing. */
export function libraryLocations(spaceRoot: string): Record<string, LibraryLocation> {
  const config = loadGlobalConfig();
  const id = findSpaceId(config, spaceRoot);
  return (id !== undefined && config.spaces?.[id]?.libraries) || {};
}

const locatedAt = (location: LibraryLocation | undefined): string | undefined =>
  typeof location?.path === "string" ? location.path : undefined;

/** The libraries a `lib:<id>/…` path can name in this space: each one it
 * declares that this host has located. */
export function readLibraries(spaceRoot: string): LibraryEntry[] {
  const locations = libraryLocations(spaceRoot);
  return libraryDeclarations(readLibrariesFile(spaceRoot).file).flatMap(({ id, label }) => {
    const path = locatedAt(locations[id]);
    return path === undefined ? [] : [{ id, label, path, access: locations[id].access }];
  });
}

/** Every library the space declares, for the Libraries panel. One this host
 * hasn't located has no path and can't be written to. */
export function libraryRows(spaceRoot: string): SpaceLibrariesResponse {
  const { file, problem } = readLibrariesFile(spaceRoot);
  if (problem !== undefined) return { libraries: [], problem };
  const locations = libraryLocations(spaceRoot);
  const libraries = libraryDeclarations(file).map<LibraryRow>(({ id, label }) => {
    const path = locatedAt(locations[id]);
    if (path === undefined) return { id, label, access: "read-only", missing: true };
    return { id, label, path, access: locations[id].access, missing: !existsSync(path) };
  });
  return { libraries };
}

const slugify = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

/** A library id the space declares nothing under: the folder's own name,
 * slugified, suffixed -2, -3, … past a collision.
 *
 * Readable, unlike a space id, because `lib:<id>/…` lands in Flow config and
 * markdown embeds, where a person reads, types and diffs it. Readable *at
 * mint* only: nothing re-derives an id from the folder name afterwards, since
 * every reference already written depends on it — a drifted id is cosmetic;
 * `label` is the display label. */
export function mintLibraryId(folderName: string, declared: readonly string[]): string {
  const base = slugify(folderName) || "library";
  const taken = new Set(declared);

  let id = base;
  for (let n = 2; taken.has(id); n += 1) id = `${base}-${n}`;

  // Slugification already guarantees this. A failure here means the grammar
  // moved and this minter didn't follow, and the right outcome is a refusal
  // rather than a declared library that no `lib:<id>/…` path can name.
  if (!isLibraryId(id)) throw new Error(`Could not derive a valid library id from "${folderName}"`);
  return id;
}

const ACCESS_LEVELS: readonly Access[] = ["read-only", "read-write"];

export function isAccess(value: unknown): value is Access {
  return typeof value === "string" && (ACCESS_LEVELS as readonly string[]).includes(value);
}
