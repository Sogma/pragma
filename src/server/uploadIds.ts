// The media ids a provider's server gave the reference images uploaded to
// it, by each image's digest, so an image uploads once per server. A cache:
// losing an entry costs one upload again, so the file implementation keeps
// it in the cache directory, never with host state.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { withHostStateLock, writeHostStateFile } from "../config/hostStateFile.ts";
import { globalCacheDir } from "../config/loadConfig.ts";

/** Where upload ids are kept. A host with other storage installs its own
 * before any upload. */
export interface UploadIdStore {
  get(serverId: string, digest: string): Promise<string | undefined>;
  set(serverId: string, digest: string, mediaId: string): Promise<void>;
  drop(serverId: string, digest: string): Promise<void>;
}

let installed: UploadIdStore | undefined;

export function installUploadIdStore(store: UploadIdStore): void {
  installed = store;
}

export function uploadIdStore(): UploadIdStore {
  installed ??= createFileUploadIdStore();
  return installed;
}

/** One file per server, digest → media id. */
export function createFileUploadIdStore(
  dirOf: () => string = () => path.join(globalCacheDir(), "mcp-media"),
): UploadIdStore {
  const fileOf = (serverId: string) => path.join(dirOf(), `${encodeURIComponent(serverId)}.json`);
  const load = async (serverId: string): Promise<Record<string, string>> => {
    try {
      return JSON.parse(await readFile(fileOf(serverId), "utf8")) as Record<string, string>;
    } catch {
      return {};
    }
  };
  // Locked across processes, as every read-modify-write of a shared file is.
  const change = (serverId: string, edit: (entries: Record<string, string>) => void) =>
    withHostStateLock(fileOf(serverId), async () => {
      const entries = await load(serverId);
      edit(entries);
      writeHostStateFile(fileOf(serverId), entries);
    });
  return {
    get: async (serverId, digest) => (await load(serverId))[digest],
    set: (serverId, digest, mediaId) =>
      change(serverId, (entries) => {
        entries[digest] = mediaId;
      }),
    drop: (serverId, digest) =>
      change(serverId, (entries) => {
        delete entries[digest];
      }),
  };
}
