import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { LibraryEntry } from "../../src/protocol/api.ts";

// A space's libraries as a host that located each one holds them: declared in
// the space's `_libraries.json`, each folder and access on the space's
// registry entry in `configDir`'s config.json, which registers the space when
// it isn't yet. Whatever else the config holds is kept, since a test server
// registered its space there and grants key off that id.
export function giveSpaceLibraries(configDir: string, spaceRoot: string, libraries: readonly LibraryEntry[]): void {
  const configPath = path.join(configDir, "config.json");
  const config = existsSync(configPath)
    ? (JSON.parse(readFileSync(configPath, "utf8")) as { spaces?: Record<string, { path: string }> })
    : {};
  const spaces = { ...config.spaces };
  const id =
    Object.entries(spaces).find(([, record]) => record.path === spaceRoot)?.[0] ??
    `spc_test${Object.keys(spaces).length}`;
  const located = Object.fromEntries(
    libraries.map((library) => [library.id, { path: library.path, access: library.access }]),
  );
  spaces[id] = { ...spaces[id], path: spaceRoot, libraries: located } as { path: string };
  writeFileSync(configPath, JSON.stringify({ ...config, spaces }));
  const declared = libraries.map((library) => ({ id: library.id, label: library.label }));
  writeFileSync(path.join(spaceRoot, "_libraries.json"), JSON.stringify({ libraries: declared }));
}
