import { vi } from "vitest";
import type { RootPathsResponse } from "../../../src/protocol/api.ts";
import { noteWritten, refresh } from "../../../web/core/spaceTree.ts";

/** Lists the space as `listing` holds it, its tree empty, until listed
 * again: what a tab's scope, and so its context, is read from. */
export async function listSpace(listing: RootPathsResponse): Promise<void> {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => Response.json(String(url).startsWith("/api/space/paths") ? listing : [])),
  );
  await refresh();
  vi.unstubAllGlobals();
}

/** A space with no scope listed, whose listing calls nothing gone: as if
 * files were written since it was read. */
export async function unlistSpace(): Promise<void> {
  await listSpace({ files: [], folders: [], scopes: [] });
  noteWritten([]);
}
