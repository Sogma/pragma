// The one menu every preset picker draws, New ▸ Template and a player's
// Looks: each source under a heading with its mark, in `_presets.json` order
// and Pragma's own last, folders as flyouts, and a search over all of them.
// A picker passes what a row does; the shape and the words are this
// module's, so no two pickers' lists drift apart.
import type { PresetFolderView } from "../../src/protocol/api.ts";
import { type LutEntry, PRESET_KINDS, type PresetKind, presetFolderOf } from "../../src/protocol/presets.ts";
import { basenameOf, dirnameOf, formatRootedPath, parseRootedPath } from "../../src/protocol/rootedPath.ts";
import type { TemplateEntry } from "../../src/protocol/templates.ts";
import { type EntryIcon, fileTypeClass, stripExtension } from "../core/paths.ts";
import { changePresets, presetFoldersOf, presets } from "../core/presets.ts";
import type { MenuItem, MenuSearch } from "./menus.ts";

/** One pickable preset, or a folder of them. */
export interface PresetRow {
  /** A rooted path, or for one of Pragma's own its path among them. */
  path: string;
  label: string;
  icon: EntryIcon;
  rows?: PresetRow[];
  pragma?: true;
}

/** Where presets come from: the space, a library, or Pragma. */
export interface PresetSource {
  key: string;
  label: string;
  mark: EntryIcon;
  folders: { path: string; label: string; missing?: string; rows: PresetRow[] }[];
}

export const PRAGMA_SOURCE = "pragma";

const templateRow = (entry: TemplateEntry): PresetRow =>
  entry.kind === "group"
    ? { path: entry.path, label: entry.name, icon: { glyph: "folder" }, rows: entry.entries.map(templateRow) }
    : {
        path: entry.path,
        label: entry.kind === "file" ? stripExtension(entry.name) : entry.name,
        icon: entry.kind === "folder" ? { glyph: "folder" } : { glyph: fileTypeClass(entry.path) ?? "file" },
      };

const lutRow = (entry: LutEntry): PresetRow =>
  entry.kind === "group"
    ? { path: entry.path, label: entry.name, icon: { glyph: "folder" }, rows: entry.entries.map(lutRow) }
    : { path: entry.path, label: stripExtension(entry.name), icon: { glyph: "lut" } };

/** Pragma's own templates as preset rows, their paths Pragma's. */
export function pragmaTemplateRows(entries: readonly TemplateEntry[]): PresetRow[] {
  const own = (row: PresetRow): PresetRow => ({
    ...row,
    pragma: true,
    ...(row.rows ? { rows: row.rows.map(own) } : {}),
  });
  return entries.map((entry) => own(templateRow(entry)));
}

// The folder a listed one is shown as, within its root.
function folderLabel(view: PresetFolderView): string {
  const folder = presetFolderOf(view.written);
  return folder?.path || view.library?.label || view.path;
}

/** The sources of `kind` the space lists, roots in the order the file first
 * names them, and Pragma's own last when given. */
export function presetSources(kind: PresetKind, pragma: readonly PresetRow[] = []): PresetSource[] {
  const sources: PresetSource[] = [];
  for (const view of presetFoldersOf(kind)) {
    const key = view.library ? `lib:${view.library.id}` : "space";
    let source = sources.find((held) => held.key === key);
    if (!source) {
      source = view.library
        ? { key, label: view.library.label, mark: { glyph: "library" }, folders: [] }
        : { key, label: "This space", mark: { glyph: "space" }, folders: [] };
      sources.push(source);
    }
    const missing =
      view.missing === "library" ? "Not on this computer" : view.missing === "folder" ? "Missing" : undefined;
    const rows = kind === "templates" ? (view.templates ?? []).map(templateRow) : (view.luts ?? []).map(lutRow);
    source.folders.push({ path: view.path, label: folderLabel(view), ...(missing ? { missing } : {}), rows });
  }
  if (pragma.length > 0) {
    sources.push({
      key: PRAGMA_SOURCE,
      label: "Pragma",
      mark: { glyph: "pragma" },
      folders: [{ path: "", label: "", rows: [...pragma] }],
    });
  }
  return sources;
}

/** How many presets the sources hold, Pragma's left out. */
export function countPresets(sources: readonly PresetSource[]): number {
  const count = (rows: readonly PresetRow[]): number =>
    rows.reduce((total, row) => total + (row.rows ? count(row.rows) : 1), 0);
  return sources
    .filter((source) => source.key !== PRAGMA_SOURCE)
    .reduce((total, source) => total + source.folders.reduce((sum, folder) => sum + count(folder.rows), 0), 0);
}

// A source's rows as menu items: a folder a flyout, a preset what `leaf`
// makes of it.
function rowItems(rows: readonly PresetRow[], group: string, leaf: (row: PresetRow) => MenuItem): MenuItem[] {
  return rows.map((row) =>
    row.rows
      ? { label: row.label, icon: true, entryIcon: row.icon, group, submenu: rowItems(row.rows, "inner", leaf) }
      : { ...leaf(row), icon: true, entryIcon: row.icon, group },
  );
}

// A row under its source's heading, set in from it.
const indented = (item: MenuItem): MenuItem => ({
  ...item,
  className: [item.className, "context-menu-indented"].filter(Boolean).join(" "),
});

/** Each source under its heading, a line between sources. A source with one
 * folder shows what it holds; with several, each folder is a flyout. */
export function presetMenuItems(sources: readonly PresetSource[], leaf: (row: PresetRow) => MenuItem): MenuItem[] {
  return sources.flatMap((source) => {
    const heading: MenuItem = { label: source.label, icon: true, entryIcon: source.mark, group: source.key };
    const shown = source.folders.flatMap((folder): MenuItem[] => {
      if (folder.missing) {
        return [
          {
            label: folder.label,
            icon: true,
            entryIcon: { glyph: "folder" },
            detail: folder.missing,
            group: source.key,
          },
        ];
      }
      if (source.folders.length === 1) return rowItems(folder.rows, source.key, leaf);
      if (folder.rows.length === 0) return [];
      const submenu = rowItems(folder.rows, "inner", leaf);
      return [{ label: folder.label, icon: true, entryIcon: { glyph: "folder" }, group: source.key, submenu }];
    });
    return [heading, ...shown.map(indented)];
  });
}

// Where a preset sits, said after its name in a search's matches: its
// source, then the folder holding it.
function whereLabel(source: PresetSource, path: string): string {
  if (source.key === PRAGMA_SOURCE) return source.label;
  let folder = "";
  try {
    folder = dirnameOf(parseRootedPath(path).path);
  } catch {
    folder = "";
  }
  return folder ? `${source.label} › ${folder}` : source.label;
}

/** A search over every source's presets: a flat list, each match saying
 * where it sits. */
export function presetSearch(
  sources: readonly PresetSource[],
  placeholder: string,
  leaf: (row: PresetRow) => MenuItem,
): MenuSearch {
  return {
    placeholder,
    filter(query) {
      const wanted = query.trim().toLocaleLowerCase();
      const matches: MenuItem[] = [];
      const walk = (source: PresetSource, rows: readonly PresetRow[]) => {
        for (const row of rows) {
          if (row.rows) {
            walk(source, row.rows);
            continue;
          }
          const where = whereLabel(source, row.path);
          if (!`${row.label} ${where}`.toLocaleLowerCase().includes(wanted)) continue;
          matches.push({ ...leaf(row), icon: true, entryIcon: row.icon, detail: where, group: "matches" });
        }
      };
      for (const source of sources) for (const folder of source.folders) walk(source, folder.rows);
      return matches;
    },
  };
}

/** A preset's name as a picker shows it, from its path. */
export function presetLabel(path: string): string {
  try {
    return stripExtension(basenameOf(formatRootedPath(parseRootedPath(path))));
  } catch {
    return path;
  }
}

const KIND_NAMES: Record<PresetKind, string> = { templates: "Templates", luts: "LUTs" };

/** The words a kind of preset goes by on every surface. */
export function presetKindName(kind: PresetKind): string {
  return KIND_NAMES[kind];
}

/** A folder's own items, on every surface that draws one: Add to Presets,
 * by kind, or Remove from Presets once the space lists it. `folderOf` reads
 * the folder's rooted path from the menu's argument, undefined for none. */
export function presetFolderItems(
  folderOf: (arg: unknown) => string | undefined,
  report: (message: string) => void,
  group = "presets",
): MenuItem[] {
  const listedAs = (arg: unknown) => {
    const folder = folderOf(arg);
    const wanted = folder === undefined ? undefined : presetFolderOf(folder);
    if (wanted === undefined) return undefined;
    return presets().folders.find((view) => {
      const listed = presetFolderOf(view.written);
      return (
        listed !== undefined &&
        formatRootedPath(listed).toLocaleLowerCase() === formatRootedPath(wanted).toLocaleLowerCase()
      );
    });
  };
  const change = async (
    kindChange: { add: PresetKind } | { remove: PresetKind },
    folder: string,
    failure: string,
  ): Promise<void> => {
    try {
      await changePresets(kindChange, folder);
    } catch (error) {
      report(error instanceof Error ? error.message : failure);
    }
  };
  return [
    {
      label: "Add to Presets",
      group,
      when: (_, arg) => folderOf(arg) !== undefined && listedAs(arg) === undefined,
      submenu: PRESET_KINDS.map((kind) => ({
        label: KIND_NAMES[kind],
        run: (_, arg) => {
          const folder = folderOf(arg);
          if (folder !== undefined) void change({ add: kind }, folder, "Couldn't add that folder.");
        },
      })),
    },
    {
      label: "Remove from Presets",
      group,
      when: (_, arg) => listedAs(arg) !== undefined,
      run: (_, arg) => {
        const listed = listedAs(arg);
        if (listed) void change({ remove: listed.kind }, listed.written, "Couldn't remove that folder.");
      },
    },
  ];
}
