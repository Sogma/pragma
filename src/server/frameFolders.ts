// Where a frame saved from a clip goes unless the person picks another
// folder: the one picked last for a clip in the same context, else the
// clip's own folder where Pragma may write there, else the space's top
// folder. Kept per context so a frame from another project's clip never
// defaults into this one's folder; host state in the space's layout.
import { statSync } from "node:fs";
import { dirnameOf } from "../protocol/rootedPath.ts";
import { scopeFolderOf } from "./classRows.ts";
import { readFrameFolders, updateFrameFolders } from "./layout.ts";
import { resolveRootedPath } from "./rootedFiles.ts";

/** The folder a frame of the clip at the rooted path `clip` saves to by
 * default. A remembered folder since deleted, or in a library made
 * read-only, is passed over. */
export async function frameFolderFor(spaceRoot: string, clip: string): Promise<string> {
  const folder = dirnameOf(clip);
  const remembered = (await readFrameFolders(spaceRoot))[scopeFolderOf(spaceRoot, folder)];
  for (const candidate of [remembered, folder]) {
    if (candidate !== undefined && isWritableFolder(spaceRoot, candidate)) return candidate;
  }
  return "";
}

/** Remembers `folder` as where frames of clips in `clip`'s context go. */
export async function rememberFrameFolder(spaceRoot: string, clip: string, folder: string): Promise<void> {
  const context = scopeFolderOf(spaceRoot, dirnameOf(clip));
  await updateFrameFolders(spaceRoot, (folders) =>
    folders[context] === folder ? undefined : { ...folders, [context]: folder },
  );
}

function isWritableFolder(spaceRoot: string, folder: string): boolean {
  try {
    const { filePath } = resolveRootedPath(spaceRoot, folder, "write");
    return statSync(filePath, { throwIfNoEntry: false })?.isDirectory() === true;
  } catch {
    return false;
  }
}

const isAtOrUnder = (rooted: string, entry: string) => rooted === entry || rooted.startsWith(`${entry}/`);

/** After `from` moved to `to`: a context's entry follows its folder, and the
 * folder it names follows too. Undefined when nothing changed. */
export function movedFrameFolders(
  folders: Record<string, string>,
  from: string,
  to: string,
): Record<string, string> | undefined {
  const follow = (rooted: string) => (isAtOrUnder(rooted, from) ? to + rooted.slice(from.length) : rooted);
  let changed = false;
  const next: Record<string, string> = {};
  for (const [context, folder] of Object.entries(folders)) {
    const movedContext = follow(context);
    const movedFolder = follow(folder);
    changed ||= movedContext !== context || movedFolder !== folder;
    next[movedContext] = movedFolder;
  }
  return changed ? next : undefined;
}

/** After `removed` was deleted: the entry of a context inside it goes, and
 * so does one naming a folder inside it, its context back to the default.
 * Undefined when none did. */
export function forgottenFrameFolders(
  folders: Record<string, string>,
  removed: string,
): Record<string, string> | undefined {
  const kept = Object.entries(folders).filter(
    ([context, folder]) => !isAtOrUnder(context, removed) && !isAtOrUnder(folder, removed),
  );
  return kept.length === Object.keys(folders).length ? undefined : Object.fromEntries(kept);
}
