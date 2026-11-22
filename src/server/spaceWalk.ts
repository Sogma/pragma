// Every file and folder under a folder that a path can name: no dot entry,
// and nothing reached through a link, which the resolver refuses. Siblings
// are listed in parallel, since on a slow mount every listing is a round trip.
import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { isHiddenName } from "../protocol/entryName.ts";

export interface SpaceWalk {
  files: string[];
  folders: string[];
}

/** The files and folders under `dir`, relative to it with `/`, in no set
 * order. A folder that can't be listed holds nothing when `unreadable` is
 * "skip", and fails the whole walk when it is "fail": a caller that edits or
 * unpublishes what it finds must not act on part of it. */
export async function walkSpace(dir: string, unreadable: "skip" | "fail"): Promise<SpaceWalk> {
  const files: string[] = [];
  const folders: string[] = [];
  const walk = async (absolute: string, relative: string): Promise<void> => {
    let listed: Dirent[];
    try {
      listed = await readdir(absolute, { withFileTypes: true });
    } catch (error) {
      if (unreadable === "fail") throw error;
      return;
    }
    await Promise.all(
      listed.map(async (entry) => {
        if (isHiddenName(entry.name) || entry.isSymbolicLink()) return;
        const child = relative === "" ? entry.name : `${relative}/${entry.name}`;
        if (entry.isDirectory()) {
          folders.push(child);
          await walk(path.join(absolute, entry.name), child);
        } else if (entry.isFile()) {
          files.push(child);
        }
      }),
    );
  };
  await walk(dir, "");
  return { files, folders };
}
