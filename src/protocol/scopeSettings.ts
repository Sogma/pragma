// docs/protocol.md's Scopes: the settings a scope's `pragma` value holds.
// Core's own sit directly under `pragma`; a document kind's sit under the
// kind's name, so a host that doesn't support that kind leaves its block as
// written. Every setting is declared here, and every rule about reading or
// writing one is a function here.
import { readWrittenPath } from "./relativeReference.ts";
import { dirnameOf, isLibraryRoot, isWithin } from "./rootedPath.ts";

/** A setting a scope's `pragma` value can hold: a folder, written as a path
 * in its AGENTS.md is. */
export interface ScopeSetting {
  /** The document kind it belongs to, whose name it sits under; absent for
   * core's own, which sit directly under `pragma`. */
  readonly kind?: string;
  readonly key: string;
  /** The folder a scope takes for it when it is turned on, read from the
   * scope's folder, wherever that folder holds it. */
  readonly start?: string;
}

/** Where a screenplay's world notes are (docs/protocol.md, World names). */
export const WORLD_SETTING: ScopeSetting = { kind: "screenplay", key: "world", start: "world/" };

export const SCOPE_SETTINGS: readonly ScopeSetting[] = [WORLD_SETTING];

type Block = Record<string, unknown>;

/** Whether a `pragma` value, or a kind's part of one, is a map of settings. */
export function isSettingsBlock(value: unknown): value is Block {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The value `setting` holds in a scope's `pragma` value, or undefined. */
export function settingValue(pragma: unknown, setting: ScopeSetting): unknown {
  if (!isSettingsBlock(pragma)) return undefined;
  const holder = setting.kind === undefined ? pragma : pragma[setting.kind];
  return isSettingsBlock(holder) ? holder[setting.key] : undefined;
}

/** Sets `setting` in an AGENTS.md's frontmatter, or clears it with
 * undefined, leaving every other key as it was. A set makes the maps it
 * needs; a clear drops the key and any map it leaves empty, but never
 * `pragma` itself, which an emptied block leaves as `""`: clearing a
 * setting must not close the scope. */
export function writeSetting(
  frontmatter: Record<string, unknown>,
  setting: ScopeSetting,
  value: string | undefined,
): void {
  const block: Block = isSettingsBlock(frontmatter.pragma) ? { ...frontmatter.pragma } : {};
  const holder: Block =
    setting.kind === undefined
      ? block
      : isSettingsBlock(block[setting.kind])
        ? { ...(block[setting.kind] as Block) }
        : {};
  if (value === undefined) delete holder[setting.key];
  else holder[setting.key] = value;
  if (setting.kind !== undefined) {
    if (Object.keys(holder).length > 0) block[setting.kind] = holder;
    else delete block[setting.kind];
  }
  if (value === undefined && !isSettingsBlock(frontmatter.pragma)) return;
  frontmatter.pragma = Object.keys(block).length > 0 ? block : "";
}

/** Each scope's `pragma` value, by the folder it opens over, "" being the
 * space's own: undefined for a folder that opens none. */
export type ScopeBlocks = (folder: string) => unknown;

/** The nearest scope at or above `folder` whose block gives `setting` a
 * value, and that value: an inner scope's replaces an outer one's. */
export function settingSource(
  blocks: ScopeBlocks,
  folder: string,
  setting: ScopeSetting,
): { scope: string; value: string } | undefined {
  for (let at = folder; ; at = dirnameOf(at)) {
    const value = settingValue(blocks(at), setting);
    if (typeof value === "string" && value.trim() !== "") return { scope: at, value };
    if (at === "") return undefined;
  }
}

/** The folder a setting given by the scope at `scope` names, read from that
 * scope's folder; undefined unless it names a folder inside that scope, its
 * own included, so a scope never reaches outside itself. */
export function settingFolder(scope: string, written: string): string | undefined {
  const read = readWrittenPath(scope, written.trim(), "markdown");
  if (!read || isLibraryRoot(read.target.root)) return undefined;
  return isWithin(scope, read.target.path) ? read.target.path : undefined;
}

/** The folder `setting` comes to for whatever sits in `folder`: the one the
 * nearest scope that sets it names, or undefined. */
export function settingFolderFor(blocks: ScopeBlocks, folder: string, setting: ScopeSetting): string | undefined {
  const source = settingSource(blocks, folder, setting);
  return source && settingFolder(source.scope, source.value);
}

/** The settings a scope turned on at `scope` takes: each declared start
 * folder its own folder holds, by `isFolder`. */
export function startingSettings(
  scope: string,
  isFolder: (path: string) => boolean,
): { setting: ScopeSetting; folder: string }[] {
  return SCOPE_SETTINGS.flatMap((setting) => {
    const folder = setting.start === undefined ? undefined : settingFolder(scope, setting.start);
    return folder !== undefined && isFolder(folder) ? [{ setting, folder }] : [];
  });
}
