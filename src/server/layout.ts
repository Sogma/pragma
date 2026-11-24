// Each space's remembered layout on this install, read and written through
// the installed layout store (layoutStore.ts), by the space's id. What a
// space shows before anything was saved is decided here.
import { existsSync } from "node:fs";
import path from "node:path";
import { findSpaceId, loadGlobalConfig } from "../config/loadConfig.ts";
import type { LayoutResponse } from "../protocol/api.ts";
import type { LocalSort } from "../protocol/localSort.ts";
import type { TableLayout } from "../protocol/types.ts";
import { layoutStore } from "./layoutStore.ts";
import { namedEntryPath } from "./rootedFiles.ts";
import { listRootPaths } from "./tree.ts";

const spaceIdOf = (spaceRoot: string) => findSpaceId(loadGlobalConfig(), spaceRoot);

/** A served space is always registered, so a write for an unregistered one
 * means that invariant broke, and it throws rather than dropping the layout
 * where no one would notice. A read of one finds nothing saved. */
function registered(spaceRoot: string): string {
  const id = spaceIdOf(spaceRoot);
  if (id === undefined) throw new Error(`Cannot save the layout: ${spaceRoot} is not a registered space.`);
  return id;
}

export type FolderState = Pick<LayoutResponse, "collapsedFolders" | "expandedFolders">;

/** A space whose folds were never saved opens with only its top-level
 * folders open, every folder below them folded. */
export async function readFolderState(spaceRoot: string): Promise<FolderState> {
  const id = spaceIdOf(spaceRoot);
  const { collapsedFolders, expandedFolders } = id === undefined ? {} : await layoutStore().folders(id);
  return {
    collapsedFolders: collapsedFolders ?? (await foldersBelowTopLevel(spaceRoot)),
    expandedFolders: expandedFolders ?? [],
  };
}

async function foldersBelowTopLevel(spaceRoot: string): Promise<string[]> {
  const { folders } = await listRootPaths(spaceRoot, "space");
  return folders.filter((folder) => folder.includes("/"));
}

/** Replaces whichever folder lists are given: the client always posts each
 * list whole. */
export async function writeFolderState(spaceRoot: string, state: Partial<FolderState>): Promise<void> {
  await layoutStore().setFolders(registered(spaceRoot), state);
}

export type GroupState = Pick<LayoutResponse, "groups" | "focusedGroup">;

/** Groups never saved open the space's root README.md, the page that says
 * what the space is. Groups saved with every tab closed stay empty: that is
 * a choice, not an absence. */
export async function readLayoutGroups(spaceRoot: string): Promise<GroupState> {
  const id = spaceIdOf(spaceRoot);
  const { groups, focusedGroup } = id === undefined ? {} : await layoutStore().groups(id);
  if (!groups) {
    const readme = namedEntryPath(spaceRoot, "README.md");
    return {
      groups: existsSync(readme)
        ? [{ tabs: [{ kind: "document", path: path.basename(readme) }], activeTabIndex: 0 }]
        : [],
      focusedGroup: 0,
    };
  }
  return { groups, focusedGroup: focusedGroup ?? 0 };
}

/** Replaces the editor groups: the client always posts every group. */
export async function writeLayoutGroups(spaceRoot: string, state: GroupState): Promise<void> {
  await layoutStore().setGroups(registered(spaceRoot), state);
}

/** Each folder's sort on this install. */
export async function readLocalSorts(spaceRoot: string): Promise<Record<string, LocalSort>> {
  const id = spaceIdOf(spaceRoot);
  return id === undefined ? {} : layoutStore().sorts(id);
}

/** Rewrites every folder's sort through `change`, which returns the new map,
 * or undefined to write nothing: a move in a space whose folders keep no
 * sort here never writes. */
export async function updateLocalSorts(
  spaceRoot: string,
  change: (sorts: Record<string, LocalSort>) => Record<string, LocalSort> | undefined,
): Promise<void> {
  await layoutStore().updateSorts(registered(spaceRoot), change);
}

/** Each Table's layout on this install. */
export async function readTableLayouts(spaceRoot: string): Promise<Record<string, TableLayout>> {
  const id = spaceIdOf(spaceRoot);
  return id === undefined ? {} : layoutStore().tableLayouts(id);
}

/** Rewrites every Table's layout through `change`, as the folders' sorts
 * are rewritten above. */
export async function updateTableLayouts(
  spaceRoot: string,
  change: (layouts: Record<string, TableLayout>) => Record<string, TableLayout> | undefined,
): Promise<void> {
  await layoutStore().updateTableLayouts(registered(spaceRoot), change);
}

/** Whether each Flow shows App Mode on this install. */
export async function readFlowAppModes(spaceRoot: string): Promise<Record<string, boolean>> {
  const id = spaceIdOf(spaceRoot);
  return id === undefined ? {} : layoutStore().flowAppModes(id);
}

/** Rewrites every Flow's App Mode through `change`, as the Tables' layouts
 * are rewritten above. */
export async function updateFlowAppModes(
  spaceRoot: string,
  change: (modes: Record<string, boolean>) => Record<string, boolean> | undefined,
): Promise<void> {
  await layoutStore().updateFlowAppModes(registered(spaceRoot), change);
}

/** The folder each context's frames were last saved to on this install. */
export async function readFrameFolders(spaceRoot: string): Promise<Record<string, string>> {
  const id = spaceIdOf(spaceRoot);
  return id === undefined ? {} : layoutStore().frameFolders(id);
}

/** Rewrites every context's frame folder through `change`, as the Flows'
 * App Mode is rewritten above. */
export async function updateFrameFolders(
  spaceRoot: string,
  change: (folders: Record<string, string>) => Record<string, string> | undefined,
): Promise<void> {
  await layoutStore().updateFrameFolders(registered(spaceRoot), change);
}
