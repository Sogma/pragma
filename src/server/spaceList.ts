import { existsSync } from "node:fs";
import path from "node:path";
import type { PragmaGlobalConfig } from "../config/loadConfig.ts";
import type { ListedSpace, SpaceRef } from "../protocol/api.ts";

// The registry as the surfaces that list it read it: Manage Spaces over
// HTTP, the desktop app's welcome window over IPC. One builder, so both
// agree on what a missing space is and in which order the spaces come.

/** The registry entry under `id` as a row, or undefined when there is none:
 * a row with no path does nothing, so an id the registry lost is skipped. */
export function spaceRef(config: PragmaGlobalConfig, id: string): SpaceRef | undefined {
  const record = config.spaces?.[id];
  return record
    ? {
        id,
        path: record.path,
        name: path.basename(record.path),
        label: record.label,
        missing: !existsSync(record.path),
        trusted: record.trusted,
      }
    : undefined;
}

/** Every registered space, by what its row shows, so a renamed space sorts
 * where the reader sees it rather than by its folder name. */
export function registeredSpaces(config: PragmaGlobalConfig): SpaceRef[] {
  return Object.keys(config.spaces ?? {})
    .map((id) => spaceRef(config, id))
    .filter((ref): ref is SpaceRef => ref !== undefined)
    .sort((a, b) => (a.label || a.name).localeCompare(b.label || b.name));
}

/** The welcome window's rows: each space with the folder that holds it. */
export function listedSpaces(config: PragmaGlobalConfig): ListedSpace[] {
  return registeredSpaces(config).map((ref) => ({ ...ref, parent: path.dirname(ref.path) }));
}
