// The space's `.pragma/bookmarks.json`: read whole, changed one bookmark at a
// time against the file as it stands, as `_tags.json` is, so a change made
// from another window, or by hand, survives the next one made here.
//
// The one place Pragma writes under a dot besides the trash
// (docs/architecture.md's Space identity and state ownership). No route names a
// path here: the writer resolves its own fixed file, never a request's.
import { lstatSync } from "node:fs";
import type { SpaceBookmark, SpaceBookmarksResponse } from "../protocol/api.ts";
import {
  BOOKMARKS_FILENAME,
  BOOKMARKS_FOLDER,
  type BookmarkChange,
  bookmarkPaths,
  serializeBookmarksFile,
  withBookmarkChange,
} from "../protocol/bookmarks.ts";
import { type EntryListFileKind, readEntryListFile } from "./entryListFile.ts";
import { namedEntryPath, PathAccessError, resolveRootedPath } from "./rootedFiles.ts";
import { changeEntryListFile } from "./spaceFiles.ts";

const FILE_NAME = `${BOOKMARKS_FOLDER}/${BOOKMARKS_FILENAME}`;

const BOOKMARKS_FILE: EntryListFileKind = {
  name: FILE_NAME,
  at: (spaceRoot) => namedEntryPath(namedEntryPath(spaceRoot, BOOKMARKS_FOLDER), BOOKMARKS_FILENAME),
  lists: ["bookmarks"],
  serialize: serializeBookmarksFile,
  noList: `${FILE_NAME} holds no list of bookmarks`,
  // Gone with the file once empty, so a space nobody bookmarked in keeps no
  // trace.
  folder: (spaceRoot) => namedEntryPath(spaceRoot, BOOKMARKS_FOLDER),
};

/** What `path` names as the reader sees it now. One that resolves nowhere, to
 * a link, or into a library this install hasn't registered names nothing. */
function located(spaceRoot: string, path: string): SpaceBookmark {
  try {
    const stats = lstatSync(resolveRootedPath(spaceRoot, path, "read").filePath, { throwIfNoEntry: false });
    if (stats?.isDirectory()) return { path, type: "directory" };
    if (stats?.isFile()) return { path, type: "file" };
  } catch {
    // Refused paths are shown as missing, the way a deleted entry is.
  }
  return { path };
}

const answer = (spaceRoot: string, file: unknown): SpaceBookmarksResponse => ({
  bookmarks: bookmarkPaths(file).map((path) => located(spaceRoot, path)),
});

/** The bookmarks, in file order. Missing reads as none. */
export function readSpaceBookmarks(spaceRoot: string): SpaceBookmarksResponse {
  const { file, problem } = readEntryListFile(spaceRoot, BOOKMARKS_FILE);
  return problem === undefined ? answer(spaceRoot, file) : { bookmarks: [], problem };
}

/** Applies one bookmark's change and answers with the bookmarks as they now
 * are. Only an entry that exists is added: a bookmark starts out naming it. */
export async function changeSpaceBookmark(spaceRoot: string, change: BookmarkChange): Promise<SpaceBookmarksResponse> {
  if ("add" in change && located(spaceRoot, change.add).type === undefined) {
    throw new PathAccessError(404, `Not found: ${change.add}`);
  }
  return answer(
    spaceRoot,
    await changeEntryListFile(spaceRoot, BOOKMARKS_FILE, (file) => withBookmarkChange(file, change)),
  );
}

/** Keeps the bookmarks on an entry a move or delete just changed. Best-effort:
 * the entry has already changed, and a file that doesn't read is left alone. */
export async function keepSpaceBookmarks(
  spaceRoot: string,
  change: (file: Record<string, unknown>) => Record<string, unknown> | undefined,
): Promise<void> {
  try {
    await changeEntryListFile(spaceRoot, BOOKMARKS_FILE, (file) => (file === undefined ? undefined : change(file)));
  } catch {
    // best-effort only — the entry already changed
  }
}
