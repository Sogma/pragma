// The folders the space's `_presets.json` lists, read with the space's tree:
// what a picker offering the space's content leaves out, and what New ▸
// Template, Looks and the Presets section offer.
import type { PresetFolderView, SpacePresetsResponse } from "../../src/protocol/api.ts";
import {
  isPresetPath as holds,
  type PresetFolder,
  type PresetKind,
  presetFolderAt,
  presetFolderOf,
} from "../../src/protocol/presets.ts";
import { postSpacePresetChange } from "./apiClient.ts";

let current: SpacePresetsResponse = { folders: [] };
let folders: PresetFolder[] = [];
const listeners = new Set<() => void>();

/** Takes in the presets as the server answered them, and tells whoever
 * draws them. */
export function setPresets(next: SpacePresetsResponse): void {
  // An answer holding no list of folders lists none.
  current = Array.isArray(next?.folders) ? next : { folders: [] };
  folders = current.folders.flatMap((view) => {
    const folder = presetFolderOf(view.written);
    return folder ? [{ kind: view.kind, written: view.written, folder }] : [];
  });
  for (const listener of listeners) listener();
}

/** Every listed folder, as last read. */
export function presets(): SpacePresetsResponse {
  return current;
}

/** The folders listed for `kind`, in the file's order. */
export function presetFoldersOf(kind: PresetKind): PresetFolderView[] {
  return current.folders.filter((view) => view.kind === kind);
}

/** Whether the entry at a rooted path is in a listed folder. */
export function isPresetPath(path: string): boolean {
  return holds(folders, path);
}

/** Whether the entry at a rooted path is in a folder listed for templates. */
export function inTemplateFolders(path: string): boolean {
  return presetFolderAt(folders, path, "templates") !== undefined;
}

export function onPresetsChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Lists `folder`, a rooted path, for `kind`, or takes it out; the answer is
 * the presets as they then stand. */
export async function changePresets(
  change: { add: PresetKind } | { remove: PresetKind },
  folder: string,
): Promise<void> {
  const body = "add" in change ? { add: change.add, folder } : { remove: change.remove, folder };
  setPresets(await postSpacePresetChange(body));
}
