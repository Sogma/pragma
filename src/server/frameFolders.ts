// Where a frame saved from a clip goes unless the person picks another
// folder: the one picked last in the same context, else the clip's own
// folder where Pragma may write there, else the space's top folder. Kept
// per context (contextMemory.ts) so a frame from another project's clip
// never defaults into this one's folder; host state in the space's layout.
import { statSync } from "node:fs";
import { dirnameOf } from "../protocol/rootedPath.ts";
import { followMove, forgottenContexts, isAtOrUnder, movedContexts } from "./contextMemory.ts";
import { readFrameFolders, updateFrameFolders } from "./layout.ts";
import { resolveRootedPath } from "./rootedFiles.ts";

/** The folder a frame of the clip at the rooted path `clip`, seen in
 * `context`, saves to by default. A remembered folder since deleted, or in
 * a library made read-only, is passed over, and a context that names no
 * folder has none. */
export async function frameFolderFor(spaceRoot: string, clip: string, context: string | undefined): Promise<string> {
  const remembered = context === undefined ? undefined : (await readFrameFolders(spaceRoot))[context];
  for (const candidate of [remembered, dirnameOf(clip)]) {
    if (candidate !== undefined && isWritableFolder(spaceRoot, candidate)) return candidate;
  }
  return "";
}

/** Remembers `folder` as where frames seen in `context` go. */
export async function rememberFrameFolder(spaceRoot: string, context: string, folder: string): Promise<void> {
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

/** After `from` moved to `to`: a context's entry follows its folder, and the
 * folder it names follows too. Undefined when nothing changed. */
export function movedFrameFolders(
  folders: Record<string, string>,
  from: string,
  to: string,
): Record<string, string> | undefined {
  return movedContexts(folders, from, to, (folder) => followMove(folder, from, to));
}

/** After `removed` was deleted: the entry of a context inside it goes, and
 * so does one naming a folder inside it, its context back to the default.
 * Undefined when none did. */
export function forgottenFrameFolders(
  folders: Record<string, string>,
  removed: string,
): Record<string, string> | undefined {
  return forgottenContexts(folders, removed, (folder) => isAtOrUnder(folder, removed));
}
