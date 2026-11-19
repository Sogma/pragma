// Reading and locating space files: path resolution that never escapes the
// space, the private-document refusal every model-facing read goes
// through, the trash, and the nearest project README.
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, statSync } from "node:fs";
import { lstat, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { TrashEntry } from "../protocol/api.ts";
import { entryNameKey, isHiddenName, sanitizeEntryName } from "../protocol/entryName.ts";
import { isPrivate, readFrontmatter, withoutPublishState } from "../protocol/frontmatter.ts";
import { isPrivateContent } from "../protocol/privacy.ts";
import { isHiddenPath } from "../protocol/relativeReference.ts";
import {
  isLutFile,
  isMarkdownFile,
  notARasterImage,
  pdfMediaTypeForPath,
  type RasterImageMediaType,
  rasterImageMediaTypeForPath,
  splitDocumentName,
  videoMediaTypeForPath,
} from "../protocol/types.ts";
import { aliasedOnWindows, hiddenBelow, pathOnDisk } from "./entryOnDisk.ts";
import {
  absent,
  escapesRoot,
  namedEntryPath,
  PathAccessError,
  refuseLink,
  resolveContentPath,
  resolveRootedPath,
} from "./rootedFiles.ts";

export function resolveWithinSpace(spaceRoot: string, relativePath: string): string {
  return resolveContentPath(spaceRoot, relativePath, "Path escapes the space");
}

/** Whether two paths are the same file on disk rather than two files.
 * Identity is dev+ino, not a case-folded path comparison: on a
 * case-sensitive filesystem `Foo.md` and `foo.md` are two real files, and a
 * caller that concluded otherwise would overwrite one of them.
 *
 * A filesystem reporting no inode number answers "different", so a caller
 * that can't tell refuses rather than overwrites. */
function isSameEntry(a: string, b: string): boolean {
  const left = statSync(a);
  const right = statSync(b);
  return left.ino !== 0 && left.ino === right.ino && left.dev === right.dev;
}

/** The entry already in `dir` that stops `name` from being written there, or
 * undefined. Folds case and Unicode normalization on every platform, per
 * docs/protocol.md's entry-name rule — enforcing it only where the
 * filesystem folds would leave portability an accident of where a space was
 * written.
 *
 * `exempt` is the entry being renamed, never its own collision. Compared by
 * identity, so the scan still catches a second spelling already present. */
export function findNameCollision(dir: string, name: string, exempt?: string): string | undefined {
  const folded = entryNameKey(name);
  for (const entry of readdirSync(dir)) {
    if (entryNameKey(entry) !== folded) continue;
    if (exempt !== undefined && isSameEntry(path.join(dir, entry), exempt)) continue;
    return entry;
  }
  return undefined;
}

export const TRASH_DIRNAME = ".trash";

/** Writes a file without ever leaving a half-written one behind: a plain
 * writeFile truncates first, so a failure partway destroys the old content.
 * A temp file renamed over the target means a reader sees the whole old file
 * or the whole new one. A sibling, not /tmp, because rename is only atomic
 * within a filesystem; dot-prefixed, so a crash leaves nothing the tree shows.
 *
 * Bytes as well as text: passing "utf8" for a dropped image would re-encode
 * the binary into mojibake. Bytes may also stream in, for a download too big
 * to hold. */
export async function writeFileAtomic(
  filePath: string,
  content: string | Uint8Array | AsyncIterable<Uint8Array>,
): Promise<void> {
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now().toString(36)}.tmp`,
  );
  try {
    await writeFile(tempPath, content, typeof content === "string" ? "utf8" : null);
    await rename(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

/** A file's revision: an opaque token for its exact bytes, which a save
 * echoes back to say what it was composed from. Hashed from the bytes, never
 * from a utf8 decode of them — a file holding invalid utf8 decodes lossily,
 * and a revision minted from the decoded text would never match the file
 * again, so every save to it would conflict. */
export function revisionOf(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

/** The revision of what is on disk now. A missing file reads as empty, the
 * way every document reader treats one, so a save based on a file that has
 * since been deleted still conflicts. */
export async function readRevision(filePath: string): Promise<string> {
  try {
    return revisionOf(await readFile(filePath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return revisionOf("");
    throw error;
  }
}

// The last revision hashed per file, with the stat it was hashed under:
// enough for the files a few windows hold open, oldest dropped first.
const hashedRevisions = new Map<string, { mtimeMs: number; size: number; ino: number; revision: string }>();
const HASHED_REVISIONS_MAX = 512;

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** The revision of the file at `filePath` now, or undefined when no file is
 * there. Hashed again only once its modified time, size or inode moves, so a
 * file a client asks about every few seconds is read once per change. */
export async function currentRevision(filePath: string): Promise<string | undefined> {
  try {
    const info = await stat(filePath);
    if (!info.isFile()) return undefined;
    const known = hashedRevisions.get(filePath);
    if (known && known.mtimeMs === info.mtimeMs && known.size === info.size && known.ino === info.ino) {
      return known.revision;
    }
    const revision = revisionOf(await readFile(filePath));
    hashedRevisions.delete(filePath);
    hashedRevisions.set(filePath, { mtimeMs: info.mtimeMs, size: info.size, ino: info.ino, revision });
    if (hashedRevisions.size > HASHED_REVISIONS_MAX) {
      const [oldest] = hashedRevisions.keys();
      hashedRevisions.delete(oldest);
    }
    return revision;
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

const fileLocks = new Map<string, Promise<void>>();

/** Runs `task` with no other locked task on `filePath` running, so a
 * compare-then-write can't have a second compare land between its two
 * steps: two stale saves racing would otherwise both match and the later
 * one would overwrite the earlier. Only writers that compare take it. */
export async function withFileLock<T>(filePath: string, task: () => Promise<T>): Promise<T> {
  const run = (fileLocks.get(filePath) ?? Promise.resolve()).then(task);
  const settled = run.then(
    () => {},
    () => {},
  );
  fileLocks.set(filePath, settled);
  try {
    return await run;
  } finally {
    if (fileLocks.get(filePath) === settled) fileLocks.delete(filePath);
  }
}

/** `name` if nothing in `dir` is called that, otherwise the name with " 2",
 * " 3", … before the *whole* extension: `inventory 2.table.html`, never a
 * path.extname() split's `inventory.table 2.html`, which is no longer a table.
 *
 * Steps around rather than overwrites: both callers (a soft delete, a dropped
 * file) have no one to ask, so this is the repair half of docs/protocol.md's
 * entry-name rule — a name that only folds onto a sibling is stepped around
 * too. `dir` must exist. */
export function uniqueEntryName(dir: string, name: string): string {
  const taken = new Set(readdirSync(dir).map(entryNameKey));
  if (!taken.has(entryNameKey(name))) return name;
  const { stem, extension } = splitDocumentName(name);
  for (let attempt = 2; ; attempt++) {
    const candidate = `${stem} ${attempt}${extension}`;
    if (!taken.has(entryNameKey(candidate))) return candidate;
  }
}

/** Moves an entry into a `.trash/` folder at the root it came from instead
 * of deleting it outright — the default soft delete, toggleable off in
 * Settings > General. Dot-prefixed, so the tree's dotfile rule keeps it out
 * of every listing but the trash's own.
 *
 * `rootDir` is the entry's own root, not always the space: a writable
 * library's deletions stay in that library — a rename across devices would
 * fail, and its own trash is where someone would look for a lost take. */
export async function moveEntryToTrash(rootDir: string, targetPath: string): Promise<void> {
  const trashDir = path.join(rootDir, TRASH_DIRNAME);
  refuseLink(rootDir, trashDir);
  await mkdir(trashDir, { recursive: true });
  await rename(targetPath, path.join(trashDir, uniqueEntryName(trashDir, path.basename(targetPath))));
}

/** The top level of a root's `.trash/`, folders first then by name, as the
 * tree orders a folder. A dot-prefixed entry stays hidden, as everywhere. */
export async function listTrash(rootDir: string): Promise<TrashEntry[]> {
  const trashDir = path.join(rootDir, TRASH_DIRNAME);
  refuseLink(rootDir, trashDir);
  if (!existsSync(trashDir)) return [];
  const entries = await readdir(trashDir, { withFileTypes: true });
  return entries
    .filter((entry) => !isHiddenName(entry.name))
    .map((entry): TrashEntry => ({ name: entry.name, type: entry.isDirectory() ? "directory" : "file" }))
    .sort((a, b) => (a.type !== b.type ? (a.type === "directory" ? -1 : 1) : a.name.localeCompare(b.name)));
}

/** One entry of `.trash/`, by a bare name, never a path: the trash is the one
 * place Pragma writes under a dot segment, and only an entry the listing
 * shows can be named. */
function trashEntryPath(rootDir: string, name: unknown): string {
  if (typeof name !== "string" || !name || isHiddenName(name) || name.includes("/") || name.includes("\\")) {
    throw new PathAccessError(400, "name must be one entry of the trash");
  }
  const trashDir = path.join(rootDir, TRASH_DIRNAME);
  refuseLink(rootDir, trashDir);
  const target = path.join(trashDir, name);
  // lstat, not exists: a link in the trash is found as itself, never followed.
  if (!lstatSync(target, { throwIfNoEntry: false })) throw new PathAccessError(404, `"${name}" is not in the trash`);
  return target;
}

/** Removes one entry of `.trash/` for good: a link itself, never what it
 * points at. */
export async function deleteFromTrash(rootDir: string, name: unknown): Promise<void> {
  await rm(trashEntryPath(rootDir, name), { recursive: true });
}

/** Moves one entry of `.trash/` into `destinationDir` under the name the
 * listing shows, stepped around one taken there, since a Trash row can't be
 * renamed first. Returns where it landed. Its paths are left as written: the
 * trash keeps no record of where it came from, and a move's link rewrite
 * would read them as written from `.trash/`. */
export async function moveFromTrash(rootDir: string, name: unknown, destinationDir: string): Promise<string> {
  const source = trashEntryPath(rootDir, name);
  // A link would bring whatever it points at into the space.
  refuseLink(path.join(rootDir, TRASH_DIRNAME), source);
  if (!statSync(destinationDir, { throwIfNoEntry: false })?.isDirectory()) {
    throw new PathAccessError(404, "No such folder");
  }
  // Sanitized, as a duplicate's name is: a name written outside Pragma may
  // not be legal everywhere, and no one is asked to retype it.
  const landingName = sanitizeEntryName(path.basename(source));
  if (!landingName) throw new PathAccessError(400, "Invalid name");
  await dropPublishState(source);
  const target = path.join(destinationDir, uniqueEntryName(destinationDir, landingName));
  await rename(source, target);
  return target;
}

/** Drops `id` and `pushed` from every Markdown file at or under `entryPath`,
 * passing over dot entries and links as the tree does. The delete that sent
 * it to the trash took its pages down, or queued that, so an `id` kept would
 * aim the next publish at a page that is gone. */
async function dropPublishState(entryPath: string): Promise<void> {
  const stats = await lstat(entryPath);
  if (stats.isDirectory()) {
    for (const entry of await readdir(entryPath, { withFileTypes: true })) {
      if (isHiddenName(entry.name) || entry.isSymbolicLink()) continue;
      await dropPublishState(path.join(entryPath, entry.name));
    }
    return;
  }
  if (!stats.isFile() || !isMarkdownFile(entryPath)) return;
  const unpublished = withoutPublishState(await readFile(entryPath, "utf8"));
  if (unpublished !== undefined) await writeFileAtomic(entryPath, unpublished);
}

/** Removes everything in `.trash/`, the hidden entries included. */
export async function emptyTrash(rootDir: string): Promise<void> {
  const trashDir = path.join(rootDir, TRASH_DIRNAME);
  refuseLink(rootDir, trashDir);
  await rm(trashDir, { recursive: true, force: true });
}

const PRIVATE_REFUSAL = "This document is marked `visibility: private` and can't be read this way.";

// What reading a file that isn't there throws, word for word, so refusing a
// hidden file never confirms that it exists.

/** Reads any space-relative file as text, whatever its extension — the tree's
 * filter is display, not security — but refuses raster images, video, PDFs
 * and any file with a NUL byte early on, rather than decode their bytes into
 * garbage.
 *
 * The one required doorway for a read whose content is about to reach a
 * model: it refuses a private file (docs/architecture.md's Privacy section),
 * and reads a hidden one as absent, since `.git/config` can hold a remote's
 * credentials. Find in context's scan and search_space_files check privacy
 * inline instead, since they must skip a private file and keep going. */
export async function readSpaceFile(spaceRoot: string, relativePath: string): Promise<string> {
  if (aliasedOnWindows(relativePath)) throw absent(relativePath);
  const filePath = resolveWithinSpace(spaceRoot, relativePath);
  const spelled = path.relative(spaceRoot, filePath).split(path.sep).join("/");
  if (isHiddenPath(spelled) || hiddenBelow(spaceRoot, filePath)) throw absent(filePath);
  // What the file is, and so whether it is private, by the disk's name for it.
  const onDisk = pathOnDisk(filePath);
  if (rasterImageMediaTypeForPath(onDisk) !== undefined) {
    throw new Error("This is a raster image file. Its contents can't be read as text.");
  }
  if (videoMediaTypeForPath(onDisk) !== undefined) {
    throw new Error("This is a video file. Its contents can't be read as text.");
  }
  if (pdfMediaTypeForPath(onDisk) !== undefined) {
    throw new Error("This is a PDF file. Its text can't be read yet.");
  }
  if (isLutFile(onDisk)) throw new Error("This is a LUT file. Its contents can't be read as text.");
  const bytes = await readFile(filePath);
  if (bytes.subarray(0, 8000).includes(0)) throw new Error("This file isn't text, so it can't be read.");
  const content = bytes.toString("utf8");
  if (isMarkdownFile(onDisk)) {
    const { data, error } = readFrontmatter(content);
    if (error !== undefined) {
      throw new Error(
        `This document's frontmatter isn't valid YAML (${error}), so it is treated as private and can't be read this way.`,
      );
    }
    if (isPrivate(data)) throw new Error(PRIVATE_REFUSAL);
  } else if (isPrivateContent(onDisk, content)) {
    throw new Error(PRIVATE_REFUSAL);
  }
  return content;
}

/** The doorway's read of a raster image's bytes, for a model to see, from the
 * space or a library: a hidden one reads as absent, and none is private, since
 * neither a raster image nor a library holds a `visibility`. */
export async function readRasterImage(
  spaceRoot: string,
  input: string,
): Promise<{ mediaType: RasterImageMediaType; data: Uint8Array }> {
  const { filePath } = resolveRootedPath(spaceRoot, input, "read");
  const mediaType = rasterImageMediaTypeForPath(filePath);
  if (mediaType === undefined) throw new Error(notARasterImage(input));
  return { mediaType, data: await readFile(filePath) };
}

/** The doorway read for a file the copilot's prompt folds in on its own:
 * `null` when the model may not see it, private included. Never a raw read,
 * since what this returns reaches the model. */
async function readForPrompt(spaceRoot: string, relativePath: string): Promise<string | null> {
  try {
    return await readSpaceFile(spaceRoot, relativePath);
  } catch {
    return null;
  }
}

// A link reads as absent, as wherever a host looks for a file it names itself.
function isFileAt(absolutePath: string): boolean {
  return lstatSync(absolutePath, { throwIfNoEntry: false })?.isFile() ?? false;
}

/** The entry `name` in the space folder `folder`, written with `/`, its name
 * in any case, read for the prompt: null when it is absent, a link, outside
 * the space, or not for the model. */
export async function readNamedForPrompt(
  spaceRoot: string,
  folder: string,
  name: string,
): Promise<{ path: string; content: string } | null> {
  const dir = path.join(spaceRoot, folder);
  if (escapesRoot(path.relative(spaceRoot, dir))) return null;
  const filePath = namedEntryPath(dir, name);
  if (!isFileAt(filePath)) return null;
  const relativePath = path.relative(spaceRoot, filePath).split(path.sep).join("/");
  const content = await readForPrompt(spaceRoot, relativePath);
  return content === null ? null : { path: relativePath, content };
}

/** The space-root operating-rules filenames, in the order they win. The
 * scaffold writes `AGENTS.md`; `CLAUDE.md` is still read so a space holding
 * only that keeps loading its rules instead of silently losing them, and a
 * space carrying both resolves to the tool-neutral name. */
const SPACE_RULES_FILES = ["AGENTS.md", "CLAUDE.md"] as const;

export interface SpaceRules {
  /** Which of SPACE_RULES_FILES was found, spelled as on disk — the copilot's
   * prompt names it, so the writer can tell which file the rules came from. */
  name: string;
  content: string;
}

/** Best-effort read of the space-root operating-rules file: loaded once per
 * chat and folded into the system prompt, silently absent if the space has
 * none. A private one is withheld, never passed over for the next name, as a
 * private README ends the walk below. */
export async function readSpaceRulesFile(spaceRoot: string): Promise<SpaceRules | null> {
  const found = SPACE_RULES_FILES.map((each) => namedEntryPath(spaceRoot, each)).find(isFileAt);
  if (found === undefined) return null;
  const name = path.basename(found);
  const content = await readForPrompt(spaceRoot, name);
  return content === null ? null : { name, content };
}

export interface NearestReadme {
  path: string;
  content: string;
}

/** Walks up from `startDir` toward (but excluding) the space root, returning
 * the nearest ancestor `README.md`, its name in any case — the project-folder
 * "hub" convention this space's own operating-rules file prescribes
 * (logline, status, `## Draws on`, `## Log`).
 *
 * A private one still ends the walk: protocol.md's Project context makes the
 * first README.md the boundary, so the model gets no project context rather
 * than a README from outside it.
 *
 * The space root's own README.md is deliberately excluded: unlike the rules
 * file, it's not documented as loading every session. */

export async function findNearestReadme(spaceRoot: string, startDir: string): Promise<NearestReadme | null> {
  const resolvedRoot = path.resolve(spaceRoot);
  let dir = path.resolve(startDir);

  while (dir !== resolvedRoot) {
    const relativeDir = path.relative(resolvedRoot, dir);
    if (escapesRoot(relativeDir)) break;

    const readme = namedEntryPath(dir, "README.md");
    if (isFileAt(readme)) {
      const relativePath = path.join(relativeDir, path.basename(readme)).split(path.sep).join("/");
      const content = await readForPrompt(spaceRoot, relativePath);
      return content === null ? null : { path: relativePath, content };
    }

    dir = path.dirname(dir);
  }

  return null;
}
