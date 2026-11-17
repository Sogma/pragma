// Where capability approvals are kept: install-global, outside every space,
// so approvals can't travel with a copied space, and by registry id, never
// folder, so a relocated space keeps them (docs/architecture.md, Space
// identity and state ownership).
import {
  HostStateParseError,
  readHostStateFile,
  withHostStateLock,
  writeHostStateFile,
} from "../config/hostStateFile.ts";
import { globalGrantsPath } from "../config/loadConfig.ts";

/** One document's approvals in one space, at the content hash they were
 * given for. */
export interface GrantRecord {
  contentHash: string;
  capabilities: Record<string, boolean>;
  // A flow's leave to run with nobody at the canvas: `true` until revoked,
  // or the last day it holds, `YYYY-MM-DD` in local time. A sibling of
  // `capabilities`, never a key in it: not what a run may touch, but whether
  // one may start unwatched.
  unattended?: true | string;
}

/** Where approvals are kept, by space id and document path. A host with
 * other storage installs its own before anything is granted. */
export interface GrantStore {
  /** A document's record, or none; none too when the store can't be read,
   * since a check then denies, the safe direction, and the person is asked
   * again. */
  get(spaceId: string, path: string): Promise<GrantRecord | undefined>;
  /** Sets a document's record from the one stored now, as one step; a change
   * returning nothing writes nothing. Every write drops the space's records
   * whose documents `gone` names. A store that can't be read throws, rather
   * than write over approvals it can't see. */
  update(
    spaceId: string,
    path: string,
    change: (record: GrantRecord | undefined) => GrantRecord | undefined,
    gone: (path: string) => boolean,
  ): Promise<GrantRecord | undefined>;
  /** Forgets every record of a space. */
  clear(spaceId: string): Promise<void>;
}

let installed: GrantStore | undefined;

export function installGrantStore(store: GrantStore): void {
  installed = store;
}

export function grantStore(): GrantStore {
  installed ??= createFileGrantStore();
  return installed;
}

/** The whole file: space id → document path → record. */
type GrantsFile = Record<string, Record<string, GrantRecord>>;

/** One file apart from config.json: approvals are written on every grant
 * while config is written rarely, and a corrupted grants file must not take
 * API keys with it. */
export function createFileGrantStore(fileOf: () => string = globalGrantsPath): GrantStore {
  const read = () => readHostStateFile<GrantsFile>(fileOf()) ?? {};
  return {
    async get(spaceId, path) {
      try {
        return read()[spaceId]?.[path];
      } catch (error) {
        if (error instanceof HostStateParseError) return undefined;
        throw error;
      }
    },
    update: (spaceId, path, change, gone) =>
      withHostStateLock(fileOf(), async () => {
        const all = read();
        const next = change(all[spaceId]?.[path]);
        if (!next) return undefined;
        const kept = Object.entries(all[spaceId] ?? {}).filter(([each]) => !gone(each));
        all[spaceId] = { ...Object.fromEntries(kept), [path]: next };
        writeHostStateFile(fileOf(), all);
        return next;
      }),
    clear: (spaceId) =>
      withHostStateLock(fileOf(), async () => {
        const all = read();
        if (!(spaceId in all)) return;
        delete all[spaceId];
        writeHostStateFile(fileOf(), all);
      }),
  };
}
