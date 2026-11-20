// The space's `_presets.json` (src/protocol/presets.ts): read, with what each
// listed folder holds as this host finds it, changed one folder at a time
// against the file as it stands, as `_tags.json` is, and kept on its folders
// through a move or delete.
import { existsSync, readFileSync, statSync } from "node:fs";
import { unlink } from "node:fs/promises";
import type { PresetFolderView, SpacePresetsResponse, SpaceTreeNode } from "../protocol/api.ts";
import { libraryDeclarations } from "../protocol/libraries.ts";
import {
  formatPresetFolder,
  isPresetKind,
  isPresetPath,
  PRESET_KINDS,
  PRESETS_FILENAME,
  type PresetChange,
  type PresetFolder,
  presetAddRefusal,
  presetFolderAt,
  presetFolderOf,
  presetFolders,
  readLuts,
  serializePresetsFile,
  withPresetChange,
} from "../protocol/presets.ts";
import { formatRootedPath, isLibraryRoot, type PathRoot } from "../protocol/rootedPath.ts";
import { readTemplates, type TemplateSource } from "../protocol/templates.ts";
import { readLibraries, readLibrariesFile } from "./libraries.ts";
import { linkBelow, namedEntryPath, PathAccessError, refuseLink, resolveHeldPath } from "./rootedFiles.ts";
import { writeFileAtomic } from "./spaceFiles.ts";
import { buildTree, spaceListing } from "./tree.ts";

/** A `_presets.json` that exists but can't be read. Never written over: the
 * write would replace whatever someone wrote by hand with one folder. */
export class PresetsFileError extends Error {}

/** A folder the list can't take as asked, in the person's words. */
export class PresetRefusal extends Error {}

/** The space's `_presets.json`, or why it lists nothing when it exists but
 * doesn't read. Missing lists nothing. */
export function readPresetsFile(spaceRoot: string): { file: Record<string, unknown> | undefined; problem?: string } {
  const filePath = namedEntryPath(spaceRoot, PRESETS_FILENAME);
  // A link reads as absent, as every file Pragma names itself does.
  if (!existsSync(filePath) || linkBelow(spaceRoot, filePath) !== undefined) return { file: undefined };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { file: undefined, problem: `${PRESETS_FILENAME} doesn't parse: ${reason}` };
  }
  const isObject = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed);
  const file = isObject ? (parsed as Record<string, unknown>) : undefined;
  if (!file) return { file: undefined, problem: `${PRESETS_FILENAME} holds no lists of folders` };
  const notList = PRESET_KINDS.find((kind) => file[kind] !== undefined && !Array.isArray(file[kind]));
  if (notList) return { file: undefined, problem: `${PRESETS_FILENAME}'s "${notList}" is no list of folders` };
  return { file };
}

// Every search and index walk asks, so the file is read again only when its
// time or size moves, and dropped on every write made here.
const listed = new Map<string, { stamp: string; folders: PresetFolder[] }>();

/** The folders the space lists, kind by kind; none while the file doesn't
 * read. */
export function listedPresetFolders(spaceRoot: string): PresetFolder[] {
  const stats = statSync(namedEntryPath(spaceRoot, PRESETS_FILENAME), { throwIfNoEntry: false });
  const stamp = stats ? `${stats.mtimeMs}:${stats.size}` : "";
  const held = listed.get(spaceRoot);
  if (held?.stamp === stamp) return held.folders;
  const folders = stamp ? presetFolders(readPresetsFile(spaceRoot).file) : [];
  listed.set(spaceRoot, { stamp, folders });
  return folders;
}

/** Whether a rooted path is in a folder the space lists: what every surface
 * offering the space's content leaves out. */
export function presetPaths(spaceRoot: string): (rootedPath: string) => boolean {
  const folders = listedPresetFolders(spaceRoot);
  return folders.length === 0 ? () => false : (rootedPath) => isPresetPath(folders, rootedPath);
}

/** Whether a rooted path is in a folder the space lists for templates: what
 * a Class's New note may start from. */
export function templatePaths(spaceRoot: string): (rootedPath: string) => boolean {
  const folders = listedPresetFolders(spaceRoot);
  return (rootedPath) => presetFolderAt(folders, rootedPath, "templates") !== undefined;
}

// A tree's nodes with each path rooted in `root`, as the readers take them.
function rootedTree(nodes: readonly SpaceTreeNode[], root: PathRoot): TemplateSource[] {
  return nodes.map((node) => ({
    name: node.name,
    path: formatRootedPath({ root, path: node.path }),
    type: node.type,
    ...(node.pragmaFile ? { pragmaFile: node.pragmaFile } : {}),
    ...(node.children ? { children: rootedTree(node.children, root) } : {}),
  }));
}

/** One listed folder as this host finds it: where it is, and what it holds. */
export async function presetFolderView(spaceRoot: string, preset: PresetFolder): Promise<PresetFolderView> {
  const { folder } = preset;
  const view: PresetFolderView = { kind: preset.kind, written: preset.written, path: formatRootedPath(folder) };
  if (isLibraryRoot(folder.root)) {
    const id = folder.root.library;
    const declared = libraryDeclarations(readLibrariesFile(spaceRoot).file).find((library) => library.id === id);
    view.library = { id, label: declared?.label ?? id };
    const located = readLibraries(spaceRoot).find((library) => library.id === id);
    if (!located || !existsSync(located.path)) return { ...view, missing: "library" };
  }
  let resolved: ReturnType<typeof resolveHeldPath>;
  try {
    resolved = resolveHeldPath(spaceRoot, formatRootedPath(folder), "read");
  } catch {
    return { ...view, missing: "folder" };
  }
  if (!statSync(resolved.filePath, { throwIfNoEntry: false })?.isDirectory()) return { ...view, missing: "folder" };
  const inLibrary = isLibraryRoot(resolved.rooted.root);
  const nodes = await buildTree(
    resolved.filePath,
    resolved.rootDir,
    inLibrary ? "library" : "space",
    inLibrary ? {} : spaceListing(),
  );
  const tree = rootedTree(nodes, resolved.rooted.root);
  view.path = formatRootedPath(resolved.rooted);
  if (preset.kind === "templates") view.templates = readTemplates(tree);
  else view.luts = readLuts(tree);
  return view;
}

/** Every listed folder, kind by kind, each with what it holds here. */
export async function readSpacePresets(spaceRoot: string): Promise<SpacePresetsResponse> {
  const { problem } = readPresetsFile(spaceRoot);
  if (problem !== undefined) return { folders: [], problem };
  const folders = listedPresetFolders(spaceRoot);
  return { folders: await Promise.all(folders.map((preset) => presetFolderView(spaceRoot, preset))) };
}

// A file left listing no folder and holding nothing else is removed, so a
// space with no presets keeps no trace of them.
async function write(spaceRoot: string, next: Record<string, unknown>): Promise<void> {
  const filePath = namedEntryPath(spaceRoot, PRESETS_FILENAME);
  refuseLink(spaceRoot, filePath);
  listed.delete(spaceRoot);
  const empty = Object.entries(next).every(
    ([key, value]) => isPresetKind(key) && Array.isArray(value) && value.length === 0,
  );
  if (empty) {
    if (existsSync(filePath)) await unlink(filePath);
    return;
  }
  await writeFileAtomic(filePath, serializePresetsFile(next));
}

async function changeFile(
  spaceRoot: string,
  change: (file: Record<string, unknown> | undefined) => Record<string, unknown> | undefined,
): Promise<void> {
  const { file, problem } = readPresetsFile(spaceRoot);
  if (problem !== undefined) throw new PresetsFileError(`${problem}. Fix the file, then try again.`);
  const next = change(file);
  if (next !== undefined) await write(spaceRoot, next);
}

/** Applies one folder's change and answers with every listed folder as it
 * now stands. Only a folder that exists is listed, spelled as found. */
export async function changeSpacePresets(spaceRoot: string, change: PresetChange): Promise<SpacePresetsResponse> {
  if ("add" in change) {
    const folder = presetFolderOf(change.folder);
    if (folder === undefined) throw new PresetRefusal(`${change.folder || "That"} is no folder a preset list can hold`);
    const resolved = resolveHeldPath(spaceRoot, formatRootedPath(folder), "read");
    if (!statSync(resolved.filePath, { throwIfNoEntry: false })?.isDirectory()) {
      throw new PathAccessError(404, `No folder at ${formatRootedPath(folder)}`);
    }
    const refusal = presetAddRefusal(listedPresetFolders(spaceRoot), change.add, resolved.rooted);
    if (refusal !== undefined) throw new PresetRefusal(refusal);
    const add = { add: change.add, folder: formatPresetFolder(resolved.rooted) };
    await changeFile(spaceRoot, (file) => withPresetChange(file, add));
  } else {
    await changeFile(spaceRoot, (file) => withPresetChange(file, change));
  }
  return readSpacePresets(spaceRoot);
}

/** Keeps the list on folders a move or delete just changed. Best-effort: the
 * entry has already changed, and a file that doesn't read is left alone. */
export async function keepSpacePresets(
  spaceRoot: string,
  change: (file: Record<string, unknown>) => Record<string, unknown> | undefined,
): Promise<void> {
  try {
    await changeFile(spaceRoot, (file) => (file === undefined ? undefined : change(file)));
  } catch {
    // best-effort only — the entry already changed
  }
}
