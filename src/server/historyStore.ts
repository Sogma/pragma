// Where a space's earlier file versions are kept: host state beside its
// layout, never inside the space, so no copy or sync of the space holds them
// (docs/architecture.md, Space identity and state ownership).
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { globalHistoryDir } from "../config/loadConfig.ts";
import type { HistoryFile, HistoryVersion } from "../protocol/api.ts";
import { writeFileAtomic } from "./spaceFiles.ts";

/** Where versions are kept, by space id and space path, newest first. A host
 * with other storage installs its own before anything is written. */
export interface HistoryStore {
  files(spaceId: string): Promise<HistoryFile[]>;
  versions(spaceId: string, spacePath: string): Promise<HistoryVersion[]>;
  read(spaceId: string, spacePath: string, id: string): Promise<string | undefined>;
  add(spaceId: string, spacePath: string, version: HistoryVersion, content: string): Promise<void>;
  remove(spaceId: string, spacePath: string, ids: readonly string[]): Promise<void>;
  /** Re-keys every version at or under `from` to the same place under `to`. */
  move(spaceId: string, from: string, to: string): Promise<void>;
  clear(spaceId: string): Promise<void>;
}

let installed: HistoryStore | undefined;

export function installHistoryStore(store: HistoryStore): void {
  installed = store;
}

export function historyStore(): HistoryStore {
  installed ??= createLocalHistoryStore();
  return installed;
}

interface Entries {
  path: string;
  versions: HistoryVersion[];
}

function isEntries(value: unknown): value is Entries {
  if (!value || typeof value !== "object") return false;
  const { path: spacePath, versions } = value as Partial<Entries>;
  return (
    typeof spacePath === "string" &&
    Array.isArray(versions) &&
    versions.every((version) => typeof version?.id === "string" && typeof version.time === "number")
  );
}

/** One folder per file, named by a hash of its space path so any path makes
 * a short, safe name; its entries.json names the path, so the store lists
 * without the space. Each version is a file of its own beside it. */
export function createLocalHistoryStore(): HistoryStore {
  const fileDir = (spaceId: string, spacePath: string) =>
    path.join(globalHistoryDir(spaceId), createHash("sha256").update(spacePath).digest("hex"));
  const versionFile = (dir: string, id: string) => path.join(dir, `${id}.txt`);
  const entriesFile = (dir: string) => path.join(dir, "entries.json");

  async function readEntries(dir: string): Promise<Entries | undefined> {
    try {
      const parsed: unknown = JSON.parse(await readFile(entriesFile(dir), "utf8"));
      return isEntries(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  async function everyFile(spaceId: string): Promise<{ dir: string; entries: Entries }[]> {
    const root = globalHistoryDir(spaceId);
    const names = await readdir(root).catch((): string[] => []);
    const read = await Promise.all(
      names.map(async (name) => ({ dir: path.join(root, name), entries: await readEntries(path.join(root, name)) })),
    );
    return read.filter((file): file is { dir: string; entries: Entries } => file.entries !== undefined);
  }

  return {
    async files(spaceId) {
      return (await everyFile(spaceId))
        .filter(({ entries }) => entries.versions.length > 0)
        .map(({ entries }) => ({ path: entries.path, latest: entries.versions[0].time }))
        .sort((a, b) => b.latest - a.latest);
    },
    async versions(spaceId, spacePath) {
      return (await readEntries(fileDir(spaceId, spacePath)))?.versions ?? [];
    },
    // Only an id the entries name is read, so no id reaches a path outside
    // the file's folder.
    async read(spaceId, spacePath, id) {
      const dir = fileDir(spaceId, spacePath);
      if (!(await readEntries(dir))?.versions.some((version) => version.id === id)) return undefined;
      return readFile(versionFile(dir, id), "utf8").catch(() => undefined);
    },
    async add(spaceId, spacePath, version, content) {
      const dir = fileDir(spaceId, spacePath);
      await mkdir(dir, { recursive: true });
      await writeFileAtomic(versionFile(dir, version.id), content);
      const versions = (await readEntries(dir))?.versions ?? [];
      await writeFileAtomic(entriesFile(dir), JSON.stringify({ path: spacePath, versions: [version, ...versions] }));
    },
    async remove(spaceId, spacePath, ids) {
      const dir = fileDir(spaceId, spacePath);
      const entries = await readEntries(dir);
      if (!entries) return;
      const gone = new Set(ids);
      const versions = entries.versions.filter((version) => !gone.has(version.id));
      if (versions.length === 0) {
        await rm(dir, { recursive: true, force: true });
        return;
      }
      await writeFileAtomic(entriesFile(dir), JSON.stringify({ ...entries, versions }));
      await Promise.all([...gone].map((id) => rm(versionFile(dir, id), { force: true })));
    },
    async move(spaceId, from, to) {
      for (const { dir, entries } of await everyFile(spaceId)) {
        if (entries.path !== from && !entries.path.startsWith(`${from}/`)) continue;
        const moved = to + entries.path.slice(from.length);
        const target = fileDir(spaceId, moved);
        if (target === dir) continue;
        // Joined to any versions already kept there, newest first.
        const there = (await readEntries(target))?.versions ?? [];
        await mkdir(target, { recursive: true });
        for (const { id } of entries.versions) {
          await rename(versionFile(dir, id), versionFile(target, id)).catch(() => undefined);
        }
        const versions = [...entries.versions, ...there].sort((a, b) => b.time - a.time);
        await writeFileAtomic(entriesFile(target), JSON.stringify({ path: moved, versions }));
        await rm(dir, { recursive: true, force: true });
      }
    },
    async clear(spaceId) {
      await rm(globalHistoryDir(spaceId), { recursive: true, force: true });
    },
  };
}
