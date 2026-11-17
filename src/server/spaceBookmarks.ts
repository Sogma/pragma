// The space's `.pragma/bookmarks.json`: read whole, changed one bookmark at a
// time against the file as it stands, as `_tags.json` is, so a change made
// from another window, or by hand, survives the next one made here.
//
// The one place Pragma writes under a dot besides the trash
// (docs/architecture.md's Space identity and state ownership). No route names a
// path here: the writer resolves its own fixed file, never a request's.
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { mkdir, rmdir, unlink } from "node:fs/promises";
import type { SpaceBookmark, SpaceBookmarksResponse } from "../protocol/api.ts";
import {
  BOOKMARKS_FILENAME,
  BOOKMARKS_FOLDER,
  type BookmarkChange,
  bookmarkPaths,
  serializeBookmarksFile,
  withBookmarkChange,
} from "../protocol/bookmarks.ts";
import { linkBelow, namedEntryPath, PathAccessError, refuseLink, resolveRootedPath } from "./rootedFiles.ts";
import { writeFileAtomic } from "./spaceFiles.ts";

const FILE_NAME = `${BOOKMARKS_FOLDER}/${BOOKMARKS_FILENAME}`;

/** A bookmarks file that exists but can't be read. Never written over: the
 * write would replace whatever someone wrote by hand with one bookmark. */
export class BookmarksFileError extends Error {}

type FileChange = (file: Record<string, unknown> | undefined) => Record<string, unknown> | undefined;

function filePaths(spaceRoot: string): { dir: string; file: string } {
  const dir = namedEntryPath(spaceRoot, BOOKMARKS_FOLDER);
  return { dir, file: namedEntryPath(dir, BOOKMARKS_FILENAME) };
}

// The file, or why it holds no bookmarks when it exists but doesn't read.
function readBookmarksFile(spaceRoot: string): { file: Record<string, unknown> | undefined; problem?: string } {
  const { file: filePath } = filePaths(spaceRoot);
  // A link reads as absent, as every file Pragma names itself does.
  if (!existsSync(filePath) || linkBelow(spaceRoot, filePath) !== undefined) return { file: undefined };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { file: undefined, problem: `${FILE_NAME} doesn't parse: ${reason}` };
  }
  const isObject = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed);
  const file = isObject ? (parsed as Record<string, unknown>) : undefined;
  if (!file || (file.bookmarks !== undefined && !Array.isArray(file.bookmarks))) {
    return { file: undefined, problem: `${FILE_NAME} holds no list of bookmarks` };
  }
  return { file };
}

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
  const { file, problem } = readBookmarksFile(spaceRoot);
  return problem === undefined ? answer(spaceRoot, file) : { bookmarks: [], problem };
}

// A file left holding no bookmarks and nothing else is removed, and its
// folder with it once that folder is empty, so a space nobody bookmarked
// in keeps no trace.
async function write(spaceRoot: string, next: Record<string, unknown>): Promise<void> {
  const { dir, file } = filePaths(spaceRoot);
  refuseLink(spaceRoot, file);
  const entries = Array.isArray(next.bookmarks) ? next.bookmarks : [];
  if (entries.length === 0 && Object.keys(next).length === 1) {
    if (existsSync(file)) await unlink(file);
    await rmdir(dir).catch(() => undefined);
    return;
  }
  await mkdir(dir, { recursive: true });
  await writeFileAtomic(file, serializeBookmarksFile(next));
}

async function changeFile(spaceRoot: string, change: FileChange): Promise<Record<string, unknown> | undefined> {
  const { file, problem } = readBookmarksFile(spaceRoot);
  if (problem !== undefined) throw new BookmarksFileError(`${problem}. Fix the file, then try again.`);
  const next = change(file);
  if (next !== undefined) await write(spaceRoot, next);
  return next ?? file;
}

/** Applies one bookmark's change and answers with the bookmarks as they now
 * are. Only an entry that exists is added: a bookmark starts out naming it. */
export async function changeSpaceBookmark(spaceRoot: string, change: BookmarkChange): Promise<SpaceBookmarksResponse> {
  if ("add" in change && located(spaceRoot, change.add).type === undefined) {
    throw new PathAccessError(404, `Not found: ${change.add}`);
  }
  return answer(spaceRoot, await changeFile(spaceRoot, (file) => withBookmarkChange(file, change)));
}

/** Keeps the bookmarks on an entry a move or delete just changed. Best-effort:
 * the entry has already changed, and a file that doesn't read is left alone. */
export async function keepSpaceBookmarks(
  spaceRoot: string,
  change: (file: Record<string, unknown>) => Record<string, unknown> | undefined,
): Promise<void> {
  try {
    await changeFile(spaceRoot, (file) => (file === undefined ? undefined : change(file)));
  } catch {
    // best-effort only — the entry already changed
  }
}
