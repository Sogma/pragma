// Changes to a space's libraries: its `_libraries.json`, one library at a
// time against the file as it stands, as `_tags.json` is, and each library's
// folder and access on the space's registry entry.
//
// A folder comes only from Electron's main process, picked there or one this
// host located for another space, never from a request (docs/architecture.md's
// Document writes and reference integrity).
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  findSpaceId,
  type LibraryLocation,
  loadGlobalConfig,
  type PragmaGlobalConfig,
  saveGlobalConfig,
} from "../config/loadConfig.ts";
import type { LibraryEntry, LibraryOffer, LibraryRow } from "../protocol/api.ts";
import { BOOKMARKS_FILENAME, BOOKMARKS_FOLDER } from "../protocol/bookmarks.ts";
import { type LibraryChange, libraryDeclarations, withLibraryChange } from "../protocol/libraries.ts";
import { isLibraryId } from "../protocol/rootedPath.ts";
import { EntryListFileError } from "./entryListFile.ts";
import {
  isAccess,
  LIBRARIES_FILE,
  libraryLocations,
  libraryRows,
  mintLibraryId,
  readLibraries,
  readLibrariesFile,
} from "./libraries.ts";
import { changeEntryListFile } from "./spaceFiles.ts";
import { walkSpace } from "./spaceWalk.ts";

/** A library id the space doesn't declare. */
export class UnknownLibraryError extends Error {}

function declaredLibraries(spaceRoot: string) {
  const { file, problem } = readLibrariesFile(spaceRoot);
  if (problem !== undefined) throw new EntryListFileError(problem);
  return libraryDeclarations(file);
}

/** Applies one library's change to the space's `_libraries.json`. A file left
 * declaring none and holding nothing else is removed. */
async function changeSpaceLibrary(spaceRoot: string, change: LibraryChange): Promise<void> {
  await changeEntryListFile(spaceRoot, LIBRARIES_FILE, (file) => withLibraryChange(file, change));
}

// `config` with the space's location for `id` set, or taken off.
function withLocation(
  config: PragmaGlobalConfig,
  spaceRoot: string,
  id: string,
  location: LibraryLocation | undefined,
): PragmaGlobalConfig {
  const spaceId = findSpaceId(config, spaceRoot);
  const record = spaceId === undefined ? undefined : config.spaces?.[spaceId];
  if (spaceId === undefined || record === undefined) throw new Error(`${spaceRoot} is not a registered space`);
  const { libraries: held, ...rest } = record;
  const libraries = { ...held };
  if (location === undefined) delete libraries[id];
  else libraries[id] = location;
  const next = Object.keys(libraries).length > 0 ? { ...rest, libraries } : rest;
  return { ...config, spaces: { ...config.spaces, [spaceId]: next } };
}

function saveLocation(spaceRoot: string, id: string, location: LibraryLocation | undefined): void {
  saveGlobalConfig(withLocation(loadGlobalConfig(), spaceRoot, id, location));
}

/** The library `id` names among those the space declares, as the panel
 * lists it. Throws when the space declares none by that id, or its file
 * doesn't read. */
export function spaceLibrary(spaceRoot: string, id: string): LibraryRow {
  const { libraries, problem } = libraryRows(spaceRoot);
  if (problem !== undefined) throw new EntryListFileError(problem);
  const row = libraries.find((library) => library.id === id);
  if (row === undefined) throw new UnknownLibraryError("Not one of this space's libraries");
  return row;
}

/** Declares a library for a folder, under the id, label and description
 * `named` gives when that id is free here, else an id minted from the
 * folder's name, and locates it there, read-only until a person says
 * otherwise: it is someone's photo archive or a sibling repo. */
export async function addSpaceLibrary(
  spaceRoot: string,
  folder: string,
  named?: { id: string; label: string; description?: string },
): Promise<LibraryEntry> {
  const declared = declaredLibraries(spaceRoot);
  const locations = libraryLocations(spaceRoot);
  // One folder under two ids would leave every `lib:<id>/…` path depending
  // on which entry happened to resolve it.
  if (declared.some(({ id }) => locations[id]?.path === folder)) {
    throw new Error("That folder is already one of this space's libraries");
  }
  if (findSpaceId(loadGlobalConfig(), spaceRoot) === undefined) {
    throw new Error(`${spaceRoot} is not a registered space`);
  }
  const label = named?.label ?? path.basename(folder);
  const ids = declared.map((library) => library.id);
  const id = named && !ids.includes(named.id) ? named.id : mintLibraryId(path.basename(folder), ids);
  const description = named?.description?.trim();
  await changeSpaceLibrary(spaceRoot, { add: { id, label, description } });
  const library: LibraryEntry = {
    id,
    label,
    ...(description ? { description } : {}),
    path: folder,
    access: "read-only",
  };
  saveLocation(spaceRoot, id, { path: folder, access: library.access });
  return library;
}

/** The folders this host located for other spaces' libraries, each once and
 * there now, that the space at `spaceRoot` hasn't got: what adding a library
 * offers besides a picker, by label. Each keeps the id, label and
 * description it has in the first space found holding it. */
export function libraryOffers(spaceRoot: string): LibraryOffer[] {
  const config = loadGlobalConfig();
  const here = findSpaceId(config, spaceRoot);
  const held = new Set(readLibraries(spaceRoot).map((library) => library.path));
  const offers: LibraryOffer[] = [];
  for (const [space, record] of Object.entries(config.spaces ?? {})) {
    if (space === here || !existsSync(record.path)) continue;
    for (const { id, label, description, path: folder } of readLibraries(record.path)) {
      if (held.has(folder) || offers.some((offer) => offer.path === folder) || !existsSync(folder)) continue;
      offers.push({ space, id, label, ...(description ? { description } : {}), path: folder });
    }
  }
  return offers.sort(
    (a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" }) || a.path.localeCompare(b.path),
  );
}

/** Adds the library an offer names, by its space's id and its own: the same
 * folder, label and description, and the same id where that is free here, so
 * a link copied from the other space still resolves. Read-only, as any new
 * library starts, whatever the other space allows. */
export async function addOfferedLibrary(
  spaceRoot: string,
  from: { space?: unknown; id?: unknown },
): Promise<LibraryEntry> {
  const offer = libraryOffers(spaceRoot).find(
    (candidate) => candidate.space === from.space && candidate.id === from.id,
  );
  if (offer === undefined) throw new Error("No other space on this computer has that library");
  const { id, label, description } = offer;
  return addSpaceLibrary(spaceRoot, offer.path, { id, label, description });
}

/** Points a library the space declares at a folder a person just picked,
 * keeping its id, which every `lib:<id>/…` path already written depends on,
 * and its access. */
export function locateSpaceLibrary(spaceRoot: string, id: string, folder: string): void {
  spaceLibrary(spaceRoot, id);
  const locations = libraryLocations(spaceRoot);
  const declared = declaredLibraries(spaceRoot);
  if (declared.some((library) => library.id !== id && locations[library.id]?.path === folder)) {
    throw new Error("That folder is already another of this space's libraries");
  }
  const access = locations[id]?.access;
  saveLocation(spaceRoot, id, { path: folder, access: isAccess(access) ? access : "read-only" });
}

/** Sets what Pragma may do in a library this host has located. Checked
 * against the closed set even when the caller already did: the write doorway
 * denies anything but the literal `read-write`, so a misspelt value would act
 * as read-only while the config held an access nobody chose. */
export function setSpaceLibraryAccess(spaceRoot: string, id: string, access: unknown): void {
  const row = spaceLibrary(spaceRoot, id);
  if (!isAccess(access)) throw new Error(`Not a library access: ${String(access)}`);
  if (row.path === undefined) throw new Error("Locate this library on this computer first");
  saveLocation(spaceRoot, id, { path: row.path, access });
}

/** Gives a library a new label, the id and the folder staying. A blank label
 * goes back to the folder's own name, or the id where there is none. */
export async function relabelSpaceLibrary(spaceRoot: string, id: string, label: unknown): Promise<void> {
  if (typeof label !== "string") throw new Error("A library's label must be text");
  const row = spaceLibrary(spaceRoot, id);
  const next = label.trim() || (row.path === undefined ? id : path.basename(row.path));
  await changeSpaceLibrary(spaceRoot, { relabel: id, label: next });
}

/** Gives a library a description in the space's file, or takes it away when
 * blank. No length is enforced here: the 80-character limit is the Libraries
 * panel's, for typing and for its tooltip, and the format sets none. */
export async function describeSpaceLibrary(spaceRoot: string, id: string, description: unknown): Promise<void> {
  if (typeof description !== "string") throw new Error("A library's description must be text");
  spaceLibrary(spaceRoot, id);
  await changeSpaceLibrary(spaceRoot, { describe: id, description });
}

/** Takes a library out of the space, here and wherever the space is opened,
 * and forgets its folder on this host. The folder itself is never touched. */
export async function removeSpaceLibrary(spaceRoot: string, id: string): Promise<void> {
  spaceLibrary(spaceRoot, id);
  await changeSpaceLibrary(spaceRoot, { remove: id });
  if (findSpaceId(loadGlobalConfig(), spaceRoot) !== undefined) saveLocation(spaceRoot, id, undefined);
}

const NAMED_LIBRARY = /lib:([a-z0-9][a-z0-9-]*)\//g;
const HOLDS_PATHS = /\.(md|markdown|txt|fountain|html)$/i;

// The library ids a space's documents and bookmarks name, read off their
// text: no dot entry but the bookmarks, and no symbolic link.
async function libraryIdsNamedIn(spaceRoot: string): Promise<Set<string>> {
  const named = new Set<string>();
  const readNames = async (file: string) => {
    const text = await readFile(file, "utf8").catch(() => "");
    for (const match of text.matchAll(NAMED_LIBRARY)) named.add(match[1]);
  };
  for (const file of (await walkSpace(spaceRoot, "skip")).files) {
    if (HOLDS_PATHS.test(file)) await readNames(path.join(spaceRoot, ...file.split("/")));
  }
  await readNames(path.join(spaceRoot, BOOKMARKS_FOLDER, BOOKMARKS_FILENAME));
  return named;
}

/** Moves a config.json's install-wide `libraries[]` onto its spaces, before a
 * host serves one. Each registered space whose folder is there declares those
 * its files name, keeping their ids and folders; one no space names goes to
 * the space opened last.
 *
 * A declaration or location already there is kept, and the list stays until
 * every library has a space, so the next start finishes a failed run. */
export async function moveLibrariesOntoSpaces(): Promise<void> {
  const config = loadGlobalConfig();
  if (config.libraries === undefined) return;
  const listed = (Array.isArray(config.libraries) ? config.libraries : []).filter(
    (entry) => typeof entry?.id === "string" && isLibraryId(entry.id) && typeof entry.path === "string",
  );
  const roots = new Map(
    Object.entries(config.spaces ?? {})
      .filter(([, record]) => existsSync(record.path))
      .map(([id, record]) => [id, record.path]),
  );

  const given = new Map<string, LibraryEntry[]>();
  for (const [spaceId, root] of roots) {
    const named = await libraryIdsNamedIn(root);
    const entries = listed.filter((entry) => named.has(entry.id));
    if (entries.length > 0) given.set(spaceId, entries);
  }
  const placed = new Set([...given.values()].flat().map((entry) => entry.id));
  const unplaced = listed.filter((entry) => !placed.has(entry.id));
  const last = [...(config.recentSpaceIds ?? []), ...roots.keys()].find((id) => roots.has(id));
  if (unplaced.length > 0 && last !== undefined) given.set(last, [...(given.get(last) ?? []), ...unplaced]);

  const failed: string[] = unplaced.length > 0 && last === undefined ? ["no space to take them"] : [];
  for (const [spaceId, entries] of given) {
    const root = roots.get(spaceId);
    if (root === undefined) continue;
    try {
      for (const { id, label } of entries) {
        await changeSpaceLibrary(root, { add: { id, label: (typeof label === "string" && label.trim()) || id } });
      }
    } catch (error) {
      failed.push(`${root}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    const current = loadGlobalConfig();
    const record = current.spaces?.[spaceId];
    if (record === undefined) continue;
    const libraries = { ...record.libraries };
    for (const entry of entries) {
      libraries[entry.id] ??= { path: entry.path, access: isAccess(entry.access) ? entry.access : "read-only" };
    }
    saveGlobalConfig({ ...current, spaces: { ...current.spaces, [spaceId]: { ...record, libraries } } });
  }
  if (failed.length > 0) {
    throw new Error(`config.json keeps its libraries list until each library has a space: ${failed.join("; ")}`);
  }
  const { libraries: _moved, ...rest } = loadGlobalConfig();
  saveGlobalConfig(rest);
}
