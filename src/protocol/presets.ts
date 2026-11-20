// docs/protocol.md's Presets: the folders a space lists in `_presets.json` at
// its root, per kind, where its templates and LUTs come from. Nothing inside
// a listed folder counts as the space's content. One reading for the
// server's reader and writer, the browser, and every surface that leaves
// preset files out.
import { serializeEntryListFile } from "./entryListFile.ts";
import { entryNameKey } from "./entryName.ts";
import { isHiddenPath } from "./relativeReference.ts";
import { formatRootedPath, parseRootedPath, type RootedPath, sameRoot } from "./rootedPath.ts";
import { isLutFile } from "./types.ts";

export const PRESETS_FILENAME = "_presets.json";

/** The kinds a folder can be listed for, each a key of the file. */
export const PRESET_KINDS = ["templates", "luts"] as const;
export type PresetKind = (typeof PRESET_KINDS)[number];

const KIND_NAMES: Record<PresetKind, string> = { templates: "templates", luts: "LUTs" };

/** A listed folder: as the file writes it, and the folder that names. */
export interface PresetFolder {
  kind: PresetKind;
  written: string;
  folder: RootedPath;
}

/** One folder's change: lists it last for its kind, or takes it out. */
export type PresetChange = { add: PresetKind; folder: string } | { remove: PresetKind; folder: string };

export function isPresetKind(value: unknown): value is PresetKind {
  return typeof value === "string" && (PRESET_KINDS as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The folder an entry names: a space folder written from the root, with or
 * without a leading `/`, or a `space:` or `lib:` address; a trailing `/`
 * either way. Undefined for anything naming no folder a list can hold: the
 * space itself, an entry under a dot, a path that doesn't parse. */
export function presetFolderOf(written: string): RootedPath | undefined {
  const trimmed = written.trim().replace(/\/+$/, "");
  try {
    const rooted = parseRootedPath(trimmed.startsWith("/") ? trimmed.slice(1) : trimmed);
    if (rooted.root === "space" && rooted.path === "") return undefined;
    return isHiddenPath(rooted.path) ? undefined : rooted;
  } catch {
    return undefined;
  }
}

/** How the file writes `folder`: from the space's root, or as a library's
 * address, always with the trailing `/` that marks a folder. */
export function formatPresetFolder(folder: RootedPath): string {
  return `${formatRootedPath(folder)}/`;
}

// Whether `entry` is `folder` or inside it, names compared as entry names
// are; a library's top holds all of that library.
function holds(folder: RootedPath, entry: RootedPath): boolean {
  if (!sameRoot(folder.root, entry.root)) return false;
  const outer = entryNameKey(folder.path);
  const inner = entryNameKey(entry.path);
  return outer === "" || inner === outer || inner.startsWith(`${outer}/`);
}

const entriesOf = (file: unknown, kind: PresetKind): unknown[] =>
  isRecord(file) && Array.isArray(file[kind]) ? file[kind] : [];

/** Every folder a parsed file lists, kind by kind, each kind's in file
 * order. An entry naming no folder lists nothing and stays in the file, and
 * a folder inside another listed for the same kind is that one's, so it
 * counts once. */
export function presetFolders(file: unknown): PresetFolder[] {
  const listed: PresetFolder[] = [];
  for (const kind of PRESET_KINDS) {
    const ofKind: PresetFolder[] = [];
    for (const entry of entriesOf(file, kind)) {
      const folder = typeof entry === "string" ? presetFolderOf(entry) : undefined;
      if (folder && !ofKind.some((held) => holds(held.folder, folder)))
        ofKind.push({ kind, written: entry as string, folder });
    }
    listed.push(...ofKind.filter((one) => !ofKind.some((other) => other !== one && holds(other.folder, one.folder))));
  }
  return listed;
}

/** The listed folder holding the entry at `path`, a rooted path as a listing
 * spells it, the folder itself included; only `kind`'s when given. */
export function presetFolderAt(
  folders: readonly PresetFolder[],
  path: string,
  kind?: PresetKind,
): PresetFolder | undefined {
  let entry: RootedPath;
  try {
    entry = parseRootedPath(path);
  } catch {
    return undefined;
  }
  return folders.find((listed) => (kind === undefined || listed.kind === kind) && holds(listed.folder, entry));
}

/** Whether the entry at `path` is in a listed folder, which keeps it out of
 * every surface that offers the space's content. */
export function isPresetPath(folders: readonly PresetFolder[], path: string): boolean {
  return presetFolderAt(folders, path) !== undefined;
}

/** Why `folder` can't be listed for `kind`, or undefined when it can: one
 * already listed for the kind holds it, or it overlaps one listed for
 * another kind, since a folder's files are one kind's. */
export function presetAddRefusal(
  folders: readonly PresetFolder[],
  kind: PresetKind,
  folder: RootedPath,
): string | undefined {
  for (const listed of folders) {
    const name = formatPresetFolder(listed.folder);
    if (listed.kind === kind && holds(listed.folder, folder)) return `${name} already lists these ${KIND_NAMES[kind]}`;
    if (listed.kind !== kind && (holds(listed.folder, folder) || holds(folder, listed.folder))) {
      return `${name} is already listed for ${KIND_NAMES[listed.kind]}`;
    }
  }
  return undefined;
}

// `file` with `kind`'s entries replaced, every other key kept.
function withEntries(file: unknown, kind: PresetKind, entries: unknown[]): Record<string, unknown> {
  return { ...(isRecord(file) ? file : {}), [kind]: entries };
}

const names = (entry: unknown, folder: RootedPath): boolean => {
  const held = typeof entry === "string" ? presetFolderOf(entry) : undefined;
  return held !== undefined && holds(held, folder) && holds(folder, held);
};

/** `file` with `change` applied. Listing a folder drops the kind's entries
 * inside it, which it now holds; every other key and entry is kept, as a
 * writer keeps what it doesn't read. */
export function withPresetChange(file: unknown, change: PresetChange): Record<string, unknown> {
  const folder = presetFolderOf(change.folder);
  const kind = "add" in change ? change.add : change.remove;
  const entries = entriesOf(file, kind);
  if (folder === undefined) return withEntries(file, kind, [...entries]);
  if ("remove" in change)
    return withEntries(
      file,
      kind,
      entries.filter((entry) => !names(entry, folder)),
    );
  if (entries.some((entry) => names(entry, folder))) return withEntries(file, kind, [...entries]);
  const kept = entries.filter((entry) => {
    const held = typeof entry === "string" ? presetFolderOf(entry) : undefined;
    return held === undefined || !holds(folder, held);
  });
  return withEntries(file, kind, [...kept, formatPresetFolder(folder)]);
}

// Each kind's entries mapped by `edit`, which answers an entry's new text,
// null to take it out, or undefined to keep it. Undefined when none changed.
function editEntries(
  file: unknown,
  edit: (folder: RootedPath) => string | null | undefined,
): Record<string, unknown> | undefined {
  let next: Record<string, unknown> | undefined;
  for (const kind of PRESET_KINDS) {
    let changed = false;
    const entries = entriesOf(file, kind).flatMap((entry) => {
      const folder = typeof entry === "string" ? presetFolderOf(entry) : undefined;
      const edited = folder === undefined ? undefined : edit(folder);
      if (edited === undefined) return [entry];
      changed = true;
      return edited === null ? [] : [edited];
    });
    if (changed) next = withEntries(next ?? file, kind, entries);
  }
  return next;
}

/** After the entry `from` moved to `to`, both rooted paths: each listed
 * folder on it or inside it follows. Undefined when none did. */
export function presetsAfterMove(file: unknown, from: string, to: string): Record<string, unknown> | undefined {
  let source: RootedPath;
  let target: RootedPath;
  try {
    source = parseRootedPath(from);
    target = parseRootedPath(to);
  } catch {
    return undefined;
  }
  const depth = source.path === "" ? 0 : source.path.split("/").length;
  return editEntries(file, (folder) => {
    if (!holds(source, folder)) return undefined;
    const rest = folder.path.split("/").slice(depth);
    return formatPresetFolder({ root: target.root, path: [target.path, ...rest].filter(Boolean).join("/") });
  });
}

/** After the entry `removed`, a rooted path, was deleted: each listed folder
 * on it or inside it goes. Undefined when none did. */
export function presetsAfterDelete(file: unknown, removed: string): Record<string, unknown> | undefined {
  let gone: RootedPath;
  try {
    gone = parseRootedPath(removed);
  } catch {
    return undefined;
  }
  return editEntries(file, (folder) => (holds(gone, folder) ? null : undefined));
}

/** A listed entry under a LUTs folder, as a tree lists it. */
export interface LutSource {
  name: string;
  path: string;
  type: "file" | "directory";
  children?: readonly LutSource[];
}

export type LutEntry =
  | { kind: "lut"; name: string; path: string }
  | { kind: "group"; name: string; path: string; entries: LutEntry[] };

/** What a LUTs folder holds: each LUT, and each folder holding any as a
 * group of them. A folder holding none is left out. */
export function readLuts(listing: readonly LutSource[]): LutEntry[] {
  const entries: LutEntry[] = [];
  for (const node of listing) {
    if (node.type === "file") {
      if (isLutFile(node.name)) entries.push({ kind: "lut", name: node.name, path: node.path });
      continue;
    }
    const inner = readLuts(node.children ?? []);
    if (inner.length > 0) entries.push({ kind: "group", name: node.name, path: node.path, entries: inner });
  }
  return entries;
}

/** The file as Pragma writes it: one line per folder, so listing or taking
 * one out is a one-line diff. */
export function serializePresetsFile(file: Record<string, unknown>): string {
  return serializeEntryListFile(file, PRESET_KINDS);
}
