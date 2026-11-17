// Each folder's sort on this install (src/protocol/localSort.ts), applied to
// its gallery alone. Never to what a folder keeps, nor to the tree, a Class
// or what a model or agent reads: those list the folder's own order. Its
// layout, tiles or cards, is kept in the same record. A Table's layout is
// kept beside them and follows its file the same way.
import { NAME_ORDER, type SortChoice, sameSortChoice } from "../protocol/folderSort.ts";
import type { FolderLayout, LocalSort } from "../protocol/localSort.ts";
import { basenameOf, dirnameOf, formatRootedPath, parseRootedPath } from "../protocol/rootedPath.ts";
import type { TableLayout } from "../protocol/types.ts";
import { orderByFolder, orderEntries } from "./folderOrder.ts";
import { readFolderProperties } from "./folderProperties.ts";
import { readLocalSorts, updateFlowAppModes, updateLocalSorts, updateTableLayouts } from "./layout.ts";
import { applyStructure } from "./structure.ts";
import { type FolderListingEntry, type ListingOptions, listFolder, type TreeRoot } from "./tree.ts";

// A listing carries each entry's stats already.
const listedStats = async (entry: FolderListingEntry) => entry.stats;

export interface FolderSortState {
  /** The folder's entries, in the order shown. */
  shown: FolderListingEntry[];
  /** The folder's own order, as a sort. */
  fallback: SortChoice;
  /** This install's sort, while it shows the folder another way. */
  local?: SortChoice;
  /** The folder's `_structure.json`, followed or kept. */
  manifest: string[] | null;
}

const sameNames = (a: { name: string }[], b: { name: string }[]) =>
  a.length === b.length && a.every((entry, i) => entry.name === b[i].name);

/** How `dir` lists for a person here: its own order, unless `stored` picks
 * one that shows it differently. Two manual orders differ by arrangement,
 * any other two by kind, direction or property. A library keeps no order,
 * so it lists by name. */
export async function folderSortState(
  dir: string,
  treeRoot: TreeRoot,
  stored: LocalSort | undefined,
  options: ListingOptions = {},
): Promise<FolderSortState> {
  const listing = await listFolder(dir, treeRoot, options);
  const own =
    treeRoot === "space"
      ? await orderByFolder(dir, listing, readFolderProperties(dir), listedStats)
      : { ordered: listing, rule: NAME_ORDER, manifest: null };
  const state: FolderSortState = { shown: own.ordered, fallback: own.rule, manifest: own.manifest };
  const sort = stored?.sort;
  if (!sort) return state;
  const shown = await orderEntries(dir, listing, sort, stored.arrangement ?? [], listedStats);
  const differs =
    sort.by === "manual" && own.rule.by === "manual" ? !sameNames(shown, own.ordered) : !sameSortChoice(sort, own.rule);
  return differs ? { ...state, shown, local: sort } : state;
}

/** Sets how `dir` lists here. A manual sort with no arrangement takes the
 * one last dragged here, else the folder's own `_structure.json`, followed
 * or kept, else the order on screen, so picking it never reshuffles the
 * folder.
 *
 * A sort that shows the folder as its own order is dropped, so Set as
 * default is offered only while there is something to set; a manual one
 * takes its arrangement with it. Names no longer in the folder are pruned. */
export async function saveLocalSort(
  spaceRoot: string,
  key: string,
  dir: string,
  treeRoot: TreeRoot,
  change: { sort?: SortChoice; arrangement?: string[] | null },
  options: ListingOptions = {},
): Promise<void> {
  const stored = (await readLocalSorts(spaceRoot))[key];
  const listing = await listFolder(dir, treeRoot, options);
  const present = new Set(listing.map((entry) => entry.name));
  const kept = change.arrangement === null ? undefined : (change.arrangement ?? stored?.arrangement);
  let arrangement = kept?.filter((name) => present.has(name));
  if (change.sort?.by === "manual" && !arrangement?.length) {
    const state = await folderSortState(dir, treeRoot, stored, options);
    arrangement = (state.manifest ? applyStructure(listing, state.manifest) : state.shown).map((entry) => entry.name);
  }
  let next: LocalSort = {
    ...(change.sort ? { sort: change.sort } : {}),
    ...(arrangement?.length ? { arrangement } : {}),
  };
  if (next.sort && !(await folderSortState(dir, treeRoot, next, options)).local) {
    next = next.sort.by === "manual" || !next.arrangement ? {} : { arrangement: next.arrangement };
  }
  await updateLocalSorts(spaceRoot, (sorts) => {
    const { [key]: previous, ...rest } = sorts;
    return withRecord(rest, key, { ...next, ...(previous?.layout ? { layout: previous.layout } : {}) });
  });
}

/** Sets how a gallery draws `key`'s folder here. Every folder starts as
 * tiles, so tiles keeps nothing. */
export async function saveFolderLayout(spaceRoot: string, key: string, layout: FolderLayout): Promise<void> {
  await updateLocalSorts(spaceRoot, (sorts) => {
    const { [key]: previous, ...rest } = sorts;
    const { layout: _layout, ...others } = previous ?? {};
    return withRecord(rest, key, layout === "cards" ? { ...others, layout } : others);
  });
}

/** Sets how the Table at `key` draws its rows here. Its file's own layout,
 * `own`, keeps nothing, so the file leads again. */
export async function saveTableLayout(
  spaceRoot: string,
  key: string,
  layout: TableLayout,
  own: TableLayout,
): Promise<void> {
  await updateTableLayouts(spaceRoot, (layouts) => {
    const { [key]: previous, ...rest } = layouts;
    const next = layout === own ? undefined : layout;
    if (next === previous) return undefined;
    return next ? { ...rest, [key]: next } : rest;
  });
}

/** Sets whether the Flow at `key` shows App Mode here. Its file's own,
 * `own`, keeps nothing, so the file leads again. */
export async function saveFlowAppMode(spaceRoot: string, key: string, appMode: boolean, own: boolean): Promise<void> {
  await updateFlowAppModes(spaceRoot, (modes) => {
    const { [key]: previous, ...rest } = modes;
    const next = appMode === own ? undefined : appMode;
    if (next === previous) return undefined;
    return next === undefined ? rest : { ...rest, [key]: next };
  });
}

// `rest` with `key`'s record, unless the record keeps nothing.
function withRecord(rest: Record<string, LocalSort>, key: string, record: LocalSort): Record<string, LocalSort> {
  return record.sort || record.arrangement || record.layout ? { ...rest, [key]: record } : rest;
}

/** The rooted path of the folder holding `rooted`, and its name there. */
function placeOf(rooted: string): { folder: string; name: string } {
  const { root, path: within } = parseRootedPath(rooted);
  return { folder: formatRootedPath({ root, path: dirnameOf(within) }), name: basenameOf(within) };
}

const isAtOrUnder = (key: string, rooted: string) => key === rooted || key.startsWith(`${rooted}/`);

/** After `from` moved to `to`: a folder's sort follows it, with those of the
 * folders under it. A rename keeps the entry's place in its folder's
 * arrangement; a move out of the folder leaves it, as `_structure.json`
 * does. Undefined when nothing changed. */
export function movedLocalSorts(
  sorts: Record<string, LocalSort>,
  from: string,
  to: string,
): Record<string, LocalSort> | undefined {
  let changed = false;
  const next: Record<string, LocalSort> = {};
  for (const [key, sort] of Object.entries(sorts)) {
    const moved = isAtOrUnder(key, from) ? to + key.slice(from.length) : key;
    changed ||= moved !== key;
    next[moved] = sort;
  }
  const before = placeOf(from);
  const after = placeOf(to);
  const holder = next[before.folder];
  if (holder?.arrangement?.includes(before.name)) {
    changed = true;
    const arrangement =
      before.folder === after.folder
        ? holder.arrangement.map((name) => (name === before.name ? after.name : name))
        : holder.arrangement.filter((name) => name !== before.name);
    next[before.folder] = { ...holder, arrangement };
  }
  return changed ? next : undefined;
}

/** After `removed` was deleted: its sort goes, with those of the folders
 * under it, and so does its place in its folder's arrangement. */
export function forgottenLocalSorts(
  sorts: Record<string, LocalSort>,
  removed: string,
): Record<string, LocalSort> | undefined {
  const { folder, name } = placeOf(removed);
  let changed = false;
  const next: Record<string, LocalSort> = {};
  for (const [key, sort] of Object.entries(sorts)) {
    if (isAtOrUnder(key, removed)) changed = true;
    else if (key === folder && sort.arrangement?.includes(name)) {
      changed = true;
      next[key] = { ...sort, arrangement: sort.arrangement.filter((entry) => entry !== name) };
    } else next[key] = sort;
  }
  return changed ? next : undefined;
}

/** After `from` moved to `to`: what is kept by a file's path follows it, a
 * Table's layout or a Flow's App Mode, as do those under a moved folder.
 * Undefined when none did. */
export function movedByPath<T>(entries: Record<string, T>, from: string, to: string): Record<string, T> | undefined {
  let changed = false;
  const next: Record<string, T> = {};
  for (const [key, entry] of Object.entries(entries)) {
    const moved = isAtOrUnder(key, from) ? to + key.slice(from.length) : key;
    changed ||= moved !== key;
    next[moved] = entry;
  }
  return changed ? next : undefined;
}

/** After `removed` was deleted: what is kept by the paths on or under it
 * goes. Undefined when none did. */
export function forgottenByPath<T>(entries: Record<string, T>, removed: string): Record<string, T> | undefined {
  const kept = Object.entries(entries).filter(([key]) => !isAtOrUnder(key, removed));
  return kept.length === Object.keys(entries).length ? undefined : Object.fromEntries(kept);
}

/** After `original` was duplicated as `copyName` beside it: the copy sits
 * right after it in the folder's arrangement, as in `_structure.json`. */
export function duplicatedLocalSorts(
  sorts: Record<string, LocalSort>,
  original: string,
  copyName: string,
): Record<string, LocalSort> | undefined {
  const { folder, name } = placeOf(original);
  const arrangement = sorts[folder]?.arrangement?.filter((entry) => entry !== copyName);
  const index = arrangement?.indexOf(name) ?? -1;
  if (!arrangement || index === -1) return undefined;
  arrangement.splice(index + 1, 0, copyName);
  return { ...sorts, [folder]: { ...sorts[folder], arrangement } };
}
