// Keeping paths intact across a move: after a rename lands on disk, every
// path a space document holds that the move would break is rewritten to name
// what it named before, written from the document's place as a new one would
// be.
//
// A scan, not an index: an index would be a second copy of the file listing
// with no watcher to keep it true through a git pull or an outside edit.
// Resolve, then compare — never a substring replace: `projects/a` must not
// match inside `projects/ab`, and a reference in a code fence is not one.
import { readFile } from "node:fs/promises";
import { folderNamed, folderValueOf, isThisFolder } from "../protocol/class.ts";
import { withoutBom } from "../protocol/frontmatter.ts";
import { applyReferenceEdits, findMarkdownReferences } from "../protocol/markdownLinks.ts";
import {
  createPathIndex,
  type FoundEntry,
  findEntry,
  type PathIndex,
  resolveWrittenPath,
} from "../protocol/pathIndex.ts";
import { formatWrittenPath, type PathForm } from "../protocol/relativeReference.ts";
import { dirnameOf, isLibraryRoot, type PathRoot } from "../protocol/rootedPath.ts";
import { scopeOf } from "../protocol/scopes.ts";
import { isMarkdownFile } from "../protocol/types.ts";
import { holdsPaths, rewriteDocumentPaths } from "./documentPaths.ts";
import { writeDocument } from "./history.ts";
import { readRevision, resolveWithinSpace, revisionOf, withFileLock } from "./spaceFiles.ts";
import { listRootPaths } from "./tree.ts";

// A destination that isn't a path: a web link, `mailto:` and the like, or a
// bare `#anchor`.
const NOT_A_PATH = /^(?!(?:lib|space):)[A-Za-z][A-Za-z0-9+.-]*:|^\/\/|^#/;

/** How many documents are read at once. High enough that the filesystem
 * stays busy, low enough to stay well clear of the open-file limit. */
const READ_CONCURRENCY = 64;

export interface ReferenceRewriteResult {
  /** Space paths, as they are after the move, whose content this changed. A
   * pane holding one of these has a buffer that is now behind the file, and
   * its next save would put the stale text back. */
  rewritten: string[];
  /** What the rewrite could not fix, in the user's words. */
  warnings: string[];
}

interface MoveIndexes {
  before: PathIndex;
  after: PathIndex;
  scopes: ReadonlySet<string>;
  scopesBefore: ReadonlySet<string>;
  /** Old path → new, for every file and folder the move carried. */
  moved: ReadonlyMap<string, string>;
}

// A move happens inside the space, so a path into a library is never one it
// breaks.
const spaceOnly =
  (index: PathIndex) =>
  (root: PathRoot): PathIndex | undefined =>
    isLibraryRoot(root) ? undefined : index;

// A wikilink is read as written; anything else carries its `#anchor` or
// `?query` through the rewrite.
function splitSuffix(raw: string, form: PathForm): { path: string; suffix: string } {
  const at = form === "markdown" ? raw.search(/[?#]/) : -1;
  return at === -1 ? { path: raw, suffix: "" } : { path: raw.slice(0, at), suffix: raw.slice(at) };
}

/** The folders a document's paths are read from, before the move and after. */
interface Place {
  fromDir: string;
  toDir: string;
}

/** The replacement for one path, or undefined to leave it alone. Only a path
 * that no longer names what it named before is rewritten: still naming it,
 * it stays as written, which is what keeps a moved scope's relative paths
 * between its own files untouched. */
function rewritePath(raw: string, form: PathForm, { fromDir, toDir }: Place, indexes: MoveIndexes): string | undefined {
  const { path: written, suffix } = splitSuffix(raw.trim(), form);
  if (written === "" || (form === "markdown" && NOT_A_PATH.test(written))) return undefined;

  const was: FoundEntry | undefined = resolveWrittenPath(fromDir, written, form, spaceOnly(indexes.before));
  if (was === undefined) return undefined;
  const nowAt = indexes.moved.get(was.path) ?? was.path;
  if (nowAt === was.path && fromDir === toDir) return undefined;
  if (resolveWrittenPath(toDir, written, form, spaceOnly(indexes.after))?.path === nowAt) return undefined;

  const rewritten = formatWrittenPath(
    toDir,
    { root: "space", path: nowAt },
    { form, scopes: indexes.scopes, folder: was.type === "directory" },
  );
  if (rewritten === undefined) return undefined;
  // An author who wrote a wikilink's `.md` keeps it.
  const md = form === "wikilink" && was.type === "file" && /\.md$/i.test(written) && /\.md$/i.test(nowAt);
  return `${rewritten}${md ? ".md" : ""}${suffix}`;
}

/** The replacement for one of a Class's Folder values, written from its
 * scope's folder, `before` the move and `after`, or undefined to leave it
 * alone: a pattern names no one folder, `this.file.folder` is whichever
 * folder the Class is in, and a value still naming the folder it named stays
 * as written. */
function rewriteFolderValue(raw: string, before: string, after: string, indexes: MoveIndexes): string | undefined {
  const value = raw.trim();
  if (value === "" || value.includes("*") || isThisFolder(value)) return undefined;
  const was = findEntry(indexes.before, folderNamed(before, value).folder, "directory")?.path;
  if (was === undefined) return undefined;
  const nowAt = indexes.moved.get(was) ?? was;
  if (nowAt === was && before === after) return undefined;
  if (findEntry(indexes.after, folderNamed(after, value).folder, "directory")?.path === nowAt) return undefined;
  return folderValueOf(after, nowAt);
}

/** Rewrites every path the move at `from` → `to` would otherwise have
 * broken. Call it *after* the rename has landed: it reads the space as it is
 * now and reconstructs what each path meant before the move, so a failure
 * here costs some stale links rather than an aborted move.
 *
 * A library is never rewritten, being no part of the space's own
 * bookkeeping. */
export async function rewriteMovedReferences(
  spaceRoot: string,
  from: string,
  to: string,
): Promise<ReferenceRewriteResult> {
  const after = await listRootPaths(spaceRoot, "space");

  // One move relocates one entry — but a folder carries every descendant
  // with it, so what a path has to be matched against is a set of pairs,
  // keyed both ways: old → new to retarget with, new → old to work out what
  // a moved document's own paths meant before the move.
  const moved = new Map<string, string>();
  const movedFrom = new Map<string, string>();
  const oldPath = (path: string) =>
    path === to ? from : path.startsWith(`${to}/`) ? from + path.slice(to.length) : undefined;
  for (const path of [...after.files, ...after.folders]) {
    const old = oldPath(path);
    if (old === undefined) continue;
    moved.set(old, path);
    movedFrom.set(path, old);
  }
  if (moved.size === 0) return { rewritten: [], warnings: [] };

  const back = (path: string) => movedFrom.get(path) ?? path;
  const indexes: MoveIndexes = {
    before: createPathIndex({ files: after.files.map(back), folders: after.folders.map(back) }),
    after: createPathIndex(after),
    scopes: new Set(after.scopes),
    scopesBefore: new Set(after.scopes.map(back)),
    moved,
  };

  // Per document, so one unreadable or unwritable file costs its own stale
  // paths and not the rest of the space's. The rename has already succeeded
  // either way. Returns the path when it was rewritten.
  async function rewriteDocument(docPath: string): Promise<string | undefined> {
    const absolute = resolveWithinSpace(spaceRoot, docPath);
    try {
      const bytes = await readFile(absolute);
      const content = bytes.toString("utf8");
      const place = { fromDir: dirnameOf(back(docPath)), toDir: dirnameOf(docPath) };

      const edits = [];
      for (const reference of isMarkdownFile(docPath) ? findMarkdownReferences(content) : []) {
        const form: PathForm = reference.kind === "wikilink" ? "wikilink" : "markdown";
        const replacement = rewritePath(reference.raw, form, place, indexes);
        if (replacement !== undefined && replacement !== reference.raw) {
          edits.push({ from: reference.from, to: reference.to, replacement });
        }
      }
      const linked = applyReferenceEdits(content, edits);
      const scopes = {
        before: scopeOf(indexes.scopesBefore, place.fromDir),
        after: scopeOf(indexes.scopes, place.toDir),
      };
      const rewritten =
        rewriteDocumentPaths(
          docPath,
          linked,
          (written) => rewritePath(written, "markdown", place, indexes),
          (value) => rewriteFolderValue(value, scopes.before, scopes.after, indexes),
        ) ?? linked;
      if (rewritten === content) return undefined;

      // A save landing between the read above and this write would be
      // overwritten by a copy that predates it, so the rewrite yields: that
      // document keeps its stale links, and the save keeps its edit.
      return await withFileLock(absolute, async () => {
        if ((await readRevision(absolute)) !== revisionOf(bytes)) return undefined;
        const written = isMarkdownFile(docPath) ? withoutBom(rewritten) : rewritten;
        await writeDocument(spaceRoot, absolute, written, { source: "links" });
        return docPath;
      });
    } catch {
      return undefined;
    }
  }

  // In batches rather than one file after another: the pass is dominated by
  // waiting on the filesystem, and a whole space read one `await` at a time
  // spends most of its time idle. Bounded so a large space cannot exhaust
  // the process's file descriptors, and each batch keeps its listing order
  // so the reported paths don't shuffle between runs.
  const documents = after.files.filter((path) => isMarkdownFile(path) || holdsPaths(path));
  const rewritten: string[] = [];
  for (let i = 0; i < documents.length; i += READ_CONCURRENCY) {
    const batch = await Promise.all(documents.slice(i, i + READ_CONCURRENCY).map(rewriteDocument));
    for (const docPath of batch) if (docPath !== undefined) rewritten.push(docPath);
  }

  return { rewritten, warnings: [] };
}
