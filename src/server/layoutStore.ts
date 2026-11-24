// Each space's remembered layout on this install: open tabs, folded and
// sorted folders, each Table's layout, which Flows show App Mode, and each
// context's frame folder, guides and look. Host state, kept by the space's
// id and never inside the space (docs/architecture.md, Space identity and
// state ownership).
import {
  HostStateParseError,
  readHostStateFile,
  withHostStateLock,
  writeHostStateFile,
} from "../config/hostStateFile.ts";
import { globalLayoutPath } from "../config/loadConfig.ts";
import type { LayoutGroup } from "../protocol/api.ts";
import { type LocalSort, parseLocalSort } from "../protocol/localSort.ts";
import { isTableLayout, type TableLayout } from "../protocol/types.ts";

/** The folder lists as saved, each absent when never saved. */
export interface SavedFolders {
  collapsedFolders?: string[];
  expandedFolders?: string[];
}

/** The editor groups as saved, absent when never saved. */
export interface SavedGroups {
  groups?: LayoutGroup[];
  focusedGroup?: number;
}

type MapChange<T> = (current: Record<string, T>) => Record<string, T> | undefined;

/** A context's guides and look, as the client sent them: it reads what it
 * doesn't know as none. */
export interface ContextViewRecord {
  guides?: unknown;
  look?: unknown;
}

/** Where layouts are kept, by space id. A list or map is replaced whole, as
 * the editor sends it; a change that returns nothing writes nothing. A host
 * with other storage installs its own before any layout is read. */
export interface LayoutStore {
  folders(spaceId: string): Promise<SavedFolders>;
  setFolders(spaceId: string, folders: SavedFolders): Promise<void>;
  groups(spaceId: string): Promise<SavedGroups>;
  setGroups(spaceId: string, groups: Required<SavedGroups>): Promise<void>;
  // Keyed by the folder's rooted path.
  sorts(spaceId: string): Promise<Record<string, LocalSort>>;
  updateSorts(spaceId: string, change: MapChange<LocalSort>): Promise<void>;
  // Keyed by the Table's rooted path.
  tableLayouts(spaceId: string): Promise<Record<string, TableLayout>>;
  updateTableLayouts(spaceId: string, change: MapChange<TableLayout>): Promise<void>;
  // Keyed by the Flow's rooted path.
  flowAppModes(spaceId: string): Promise<Record<string, boolean>>;
  updateFlowAppModes(spaceId: string, change: MapChange<boolean>): Promise<void>;
  // A folder's rooted path, keyed by its context's.
  frameFolders(spaceId: string): Promise<Record<string, string>>;
  updateFrameFolders(spaceId: string, change: MapChange<string>): Promise<void>;
  // Keyed by the context's folder, as frame folders are.
  contextViews(spaceId: string): Promise<Record<string, ContextViewRecord>>;
  updateContextViews(spaceId: string, change: MapChange<ContextViewRecord>): Promise<void>;
}

let installed: LayoutStore | undefined;

export function installLayoutStore(store: LayoutStore): void {
  installed = store;
}

export function layoutStore(): LayoutStore {
  installed ??= createFileLayoutStore();
  return installed;
}

interface LayoutFile extends SavedFolders, SavedGroups {
  localSorts?: Record<string, unknown>;
  tableLayouts?: Record<string, unknown>;
  flowAppModes?: Record<string, unknown>;
  frameFolders?: Record<string, unknown>;
  contextViews?: Record<string, unknown>;
}

const isMap = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

// An entry that doesn't parse is dropped, as if never set.
function sortsOf(file: LayoutFile): Record<string, LocalSort> {
  const sorts: Record<string, LocalSort> = {};
  if (!isMap(file.localSorts)) return sorts;
  for (const [folder, value] of Object.entries(file.localSorts)) {
    const sort = parseLocalSort(value);
    if (sort) sorts[folder] = sort;
  }
  return sorts;
}

function tableLayoutsOf(file: LayoutFile): Record<string, TableLayout> {
  const layouts: Record<string, TableLayout> = {};
  if (!isMap(file.tableLayouts)) return layouts;
  for (const [table, layout] of Object.entries(file.tableLayouts)) if (isTableLayout(layout)) layouts[table] = layout;
  return layouts;
}

function flowAppModesOf(file: LayoutFile): Record<string, boolean> {
  const modes: Record<string, boolean> = {};
  if (!isMap(file.flowAppModes)) return modes;
  for (const [flow, appMode] of Object.entries(file.flowAppModes))
    if (typeof appMode === "boolean") modes[flow] = appMode;
  return modes;
}

function frameFoldersOf(file: LayoutFile): Record<string, string> {
  const folders: Record<string, string> = {};
  if (!isMap(file.frameFolders)) return folders;
  for (const [context, folder] of Object.entries(file.frameFolders))
    if (typeof folder === "string") folders[context] = folder;
  return folders;
}

function contextViewsOf(file: LayoutFile): Record<string, ContextViewRecord> {
  const views: Record<string, ContextViewRecord> = {};
  if (!isMap(file.contextViews)) return views;
  for (const [context, view] of Object.entries(file.contextViews)) {
    if (!isMap(view)) continue;
    const { guides, look } = view;
    views[context] = { ...(guides === undefined ? {} : { guides }), ...(look === undefined ? {} : { look }) };
  }
  return views;
}

/** One file per space: layouts are written on every tab change, and
 * processes sharing the config directory would otherwise overwrite each
 * other's spaces.
 *
 * Unlike config.json and the grants, an unreadable layout reads as none,
 * since losing it costs only the open tabs; and only the fields named here
 * survive, so a key no reader knows is dropped at the next write. */
export function createFileLayoutStore(fileOf: (spaceId: string) => string = globalLayoutPath): LayoutStore {
  function read(spaceId: string): LayoutFile {
    try {
      const parsed = readHostStateFile<LayoutFile>(fileOf(spaceId));
      if (parsed === undefined) return {};
      const {
        collapsedFolders,
        expandedFolders,
        groups,
        focusedGroup,
        localSorts,
        tableLayouts,
        flowAppModes,
        frameFolders,
        contextViews,
      } = parsed;
      return {
        collapsedFolders,
        expandedFolders,
        groups,
        focusedGroup,
        localSorts,
        tableLayouts,
        flowAppModes,
        frameFolders,
        contextViews,
      };
    } catch (error) {
      if (error instanceof HostStateParseError) return {};
      throw error;
    }
  }
  const change = (spaceId: string, edit: (file: LayoutFile) => LayoutFile | undefined) =>
    withHostStateLock(fileOf(spaceId), async () => {
      const next = edit(read(spaceId));
      if (next) writeHostStateFile(fileOf(spaceId), next);
    });
  return {
    async folders(spaceId) {
      const { collapsedFolders, expandedFolders } = read(spaceId);
      return {
        ...(Array.isArray(collapsedFolders) ? { collapsedFolders } : {}),
        ...(Array.isArray(expandedFolders) ? { expandedFolders } : {}),
      };
    },
    setFolders: (spaceId, folders) => change(spaceId, (file) => ({ ...file, ...folders })),
    async groups(spaceId) {
      const { groups, focusedGroup } = read(spaceId);
      return {
        ...(Array.isArray(groups) ? { groups } : {}),
        ...(typeof focusedGroup === "number" ? { focusedGroup } : {}),
      };
    },
    setGroups: (spaceId, groups) => change(spaceId, (file) => ({ ...file, ...groups })),
    sorts: async (spaceId) => sortsOf(read(spaceId)),
    updateSorts: (spaceId, edit) =>
      change(spaceId, (file) => {
        const next = edit(sortsOf(file));
        return next && { ...file, localSorts: next };
      }),
    tableLayouts: async (spaceId) => tableLayoutsOf(read(spaceId)),
    updateTableLayouts: (spaceId, edit) =>
      change(spaceId, (file) => {
        const next = edit(tableLayoutsOf(file));
        return next && { ...file, tableLayouts: next };
      }),
    flowAppModes: async (spaceId) => flowAppModesOf(read(spaceId)),
    updateFlowAppModes: (spaceId, edit) =>
      change(spaceId, (file) => {
        const next = edit(flowAppModesOf(file));
        return next && { ...file, flowAppModes: next };
      }),
    frameFolders: async (spaceId) => frameFoldersOf(read(spaceId)),
    updateFrameFolders: (spaceId, edit) =>
      change(spaceId, (file) => {
        const next = edit(frameFoldersOf(file));
        return next && { ...file, frameFolders: next };
      }),
    contextViews: async (spaceId) => contextViewsOf(read(spaceId)),
    updateContextViews: (spaceId, edit) =>
      change(spaceId, (file) => {
        const next = edit(contextViewsOf(file));
        return next && { ...file, contextViews: next };
      }),
  };
}
