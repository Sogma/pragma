// What the host knows of each document without reading it again: facts
// read from one file the first time they are asked for, kept while its stats
// still match, so an edit from pragma, git or another editor is seen with no
// watcher. The inode is in the check because pragma saves a file by replacing
// it, which a coarse-mtime filesystem can't show.
//
// A question about one file is synchronous, like the tree walk that asks it:
// a cold read of a folder of thousands is ten times faster than through the
// thread pool. A question about a whole root first checks every file in it.
//
// A note's links are kept as written and filed by the path each names. Only
// an answer resolves them, against the listing its check just read, since
// whether a link lands on a file depends on which files exist then.
import { closeSync, type Dirent, lstatSync, openSync, readFileSync, readSync, type Stats } from "node:fs";
import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "node-html-parser";
import type { Backlink } from "../protocol/api.ts";
import { parseClassFile } from "../protocol/classFile.ts";
import { entryNameKey, isHiddenName } from "../protocol/entryName.ts";
import { opensFrontmatter, readFrontmatterYaml, splitFrontmatter } from "../protocol/frontmatter.ts";
import { leadingCommentsEnd } from "../protocol/markdownComments.ts";
import { noteLinksAndTags } from "../protocol/markdownLinks.ts";
import { noteExcerpt, splitNoteTitle } from "../protocol/markdownTitle.ts";
import { hasMetadataBlock } from "../protocol/metadata.ts";
import { createPathIndex, findEntry, type PathIndex, resolveWrittenPath } from "../protocol/pathIndex.ts";
import { type PathForm, readWrittenPath } from "../protocol/relativeReference.ts";
import {
  dirnameOf,
  formatRootedPath,
  type PathRoot,
  parseRootedPath,
  type RootedPath,
  sameRoot,
} from "../protocol/rootedPath.ts";
import { readMetadataBlock } from "../protocol/tableFile.ts";
import { tagsOf } from "../protocol/tags.ts";
import { type ClassFile, isClassFile, isMarkdownFile } from "../protocol/types.ts";

/** A note's frontmatter and its display title, the plain text of a leading
 * heading (docs/protocol.md's Display titles section). The title is
 * undefined for a note with none, or a file that isn't one; `error` says
 * why a block doesn't parse. */
export interface NoteHead {
  data: Record<string, unknown>;
  title: string | undefined;
  error?: string;
}

/** A root a question reads: its folder, absolute, and how a path names it. */
export interface IndexRoot {
  dir: string;
  root: PathRoot;
}

/** A Class in a root, by its path within it, with its definition. */
export interface IndexedClass {
  path: string;
  definition: ClassFile;
}

/** A tag a document carries, as written. One written in a note's text says
 * where: its line, counted from 1, the line as written, and where on it the
 * `#` is. */
export interface IndexedTag {
  name: string;
  line?: number;
  text?: string;
  at?: number;
}

/** A path a note links to, as written, and how it is read. */
export interface WrittenLink {
  form: PathForm;
  raw: string;
}

/** A document in a root carrying tags, by its path within the root. */
export interface TaggedDocument {
  path: string;
  tags: IndexedTag[];
}

/** The questions the index answers. Each names a file by its absolute path,
 * in the space or a library, but for a whole root's. */
export interface DocumentIndex {
  /** A document's frontmatter, `{}` for one with none, a malformed block, or
   * a file that can't be read. */
  frontmatter(file: string): Record<string, unknown>;
  noteHead(file: string): NoteHead;
  /** A note's opening as plain text, read from its head. One path is always
   * asked with the same `maxChars`. */
  noteExcerpt(file: string, maxChars: number): string | undefined;
  /** A file's description as `describe` reads it from the file's text
   * (docs/protocol.md's Descriptions). One path is always read by the same
   * `describe`, since its kind comes from its name. */
  description(file: string, describe: (text: string) => string | undefined): string | undefined;
  /** The notes of `roots` whose own text links to the file at the rooted path
   * `target`, each with its mentions, the file's own links and a preset's
   * links to a file outside the presets left out. A library file's come
   * from its library and the space, which may name it as `lib:<id>/…`. */
  backlinks(target: string, roots: readonly IndexRoot[], isPreset?: (path: string) => boolean): Promise<Backlink[]>;
  /** Every Class under `root` whose file reads as one, after checking the
   * root, in no set order. */
  classes(root: IndexRoot): Promise<IndexedClass[]>;
  /** The tags a note writes in its text, in source order. */
  inlineTags(file: string): string[];
  /** The paths a note's own text names, as written, in source order: what
   * it links to, as backlinks read it, and the images it embeds. */
  notePaths(file: string): { links: readonly WrittenLink[]; embeds: readonly string[] };
  /** Every document under `root` carrying a tag, after checking the root, in
   * no set order: a note by its frontmatter `tags` and the tags written in
   * its text, a Table, Class or Flow by the `tags` in its metadata. */
  tagged(root: IndexRoot): Promise<TaggedDocument[]>;
  /** What a question about a whole root runs first: every file under it
   * listed and checked, an entry whose file changed or went dropped, and each
   * note's links filed. A check asked for while one runs is that one. */
  check(root: IndexRoot): Promise<void>;
}

/** The index this process keeps in memory, and how many files it holds an
 * entry for. */
export interface MemoryDocumentIndex extends DocumentIndex {
  readonly size: number;
}

// A link as the note writes it, and where it sits: its line, counted from 1
// over the whole file, the line as written, and where on it the path starts.
interface IndexedLink {
  form: PathForm;
  raw: string;
  line: number;
  text: string;
  at: number;
}

// One file's stats when it was first read, and each fact read from it since.
// A fact read as none is held as `{ value: undefined }`, so it isn't read
// again.
interface Entry {
  mtimeMs: number;
  size: number;
  ino: number;
  frontmatter?: { data: Record<string, unknown>; error?: string };
  title?: { value: string | undefined };
  excerpt?: { value: string | undefined };
  // From the whole file: a screenplay's can sit anywhere, and an HTML
  // document keeps its own in the body.
  description?: { value: string | undefined };
  // Read together, from one parse of the note.
  links?: readonly IndexedLink[];
  inlineTags?: readonly IndexedTag[];
  embeds?: readonly string[];
  // A Table's, Class's or Flow's.
  metadataTags?: { value: readonly string[] | undefined };
  classFile?: { value: ClassFile | undefined };
  // The root whose lookup holds the note's links, and under which keys: an
  // entry dropped takes them back, whichever check found the change.
  filed?: { root: RootState; keys: readonly string[] };
}

// A root's listing at its last check, its files and as the resolver reads
// it, and each key a link files under, with the notes that file one there.
interface RootState {
  dir: string;
  root: PathRoot;
  files: readonly string[];
  paths: PathIndex;
  lookup: Map<string, Set<string>>;
}

// The first read's size. Each later read takes as much again as the head
// already holds: a fixed size would decode the whole head again per chunk,
// quadratic in a large file whose block never closes.
const CHUNK_BYTES = 4096;

// Only the head of the file is read: the block ends at its closing `---`
// line, and a document's body can be any length.
//
// A chunk can end inside a longer line that starts `---`, so a closing line
// counts only once its line break is in, or the file has ended.
function readFrontmatterBlock(absolutePath: string): { data: Record<string, unknown>; error?: string } {
  const fd = openSync(absolutePath, "r");
  try {
    let buffer = Buffer.alloc(0);
    for (;;) {
      const chunk = Buffer.alloc(Math.max(CHUNK_BYTES, buffer.length));
      const bytesRead = readSync(fd, chunk, 0, chunk.length, buffer.length);
      buffer = Buffer.concat([buffer, chunk.subarray(0, bytesRead)]);
      const text = buffer.toString("utf8");
      if (!opensFrontmatter(text)) return { data: {} };
      const split = splitFrontmatter(bytesRead === 0 ? text : text.slice(0, text.lastIndexOf("\n") + 1));
      if (split) return readFrontmatterYaml(split.yaml);
      if (bytesRead === 0) return { data: {} };
    }
  } finally {
    closeSync(fd);
  }
}

// The head of a note: its frontmatter block, the comments it opens with, and
// enough after them to hold a leading heading, which no title runs past, and
// the opening a card shows.
const HEAD_CHARS = 4096;

function readHeadText(absolutePath: string): string {
  const fd = openSync(absolutePath, "r");
  try {
    let buffer = Buffer.alloc(0);
    for (;;) {
      const chunk = Buffer.alloc(Math.max(CHUNK_BYTES, buffer.length));
      const bytesRead = readSync(fd, chunk, 0, chunk.length, buffer.length);
      buffer = Buffer.concat([buffer, chunk.subarray(0, bytesRead)]);
      const text = buffer.toString("utf8");
      const split = splitFrontmatter(text);
      const blockOpen = opensFrontmatter(text) && split === undefined;
      const body = split?.body ?? text;
      if (bytesRead === 0 || (!blockOpen && body.length - leadingCommentsEnd(body) >= HEAD_CHARS)) return text;
    }
  } finally {
    closeSync(fd);
  }
}

// A fact that can't be read is none, as for a file that has none.
function attempt<T>(read: () => T | undefined): { value: T | undefined } {
  try {
    return { value: read() };
  } catch {
    return { value: undefined };
  }
}

// Where an offset into `text` sits: its line, the line as written, and the
// column. A `\r` before a line break belongs to the break, never to the line.
function placesIn(text: string): (offset: number) => { line: number; text: string; at: number } {
  const starts = [0];
  for (let at = text.indexOf("\n"); at !== -1; at = text.indexOf("\n", at + 1)) starts.push(at + 1);
  return (offset) => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (starts[middle] <= offset) low = middle;
      else high = middle - 1;
    }
    const end = low + 1 < starts.length ? starts[low + 1] - 1 : text.length;
    return { line: low + 1, text: text.slice(starts[low], end).replace(/\r$/, ""), at: offset - starts[low] };
  };
}

function readNote(text: string): { links: IndexedLink[]; tags: IndexedTag[]; embeds: string[] } {
  const place = placesIn(text);
  const { links, embeds, tags } = noteLinksAndTags(text);
  return {
    links: links.map((link) => ({ form: link.form, raw: link.raw, ...place(link.from) })),
    tags: tags.map((tag) => ({ name: tag.name, ...place(tag.from) })),
    embeds,
  };
}

function frontmatterIn(text: string): { data: Record<string, unknown>; error?: string } {
  const split = opensFrontmatter(text) ? splitFrontmatter(text) : undefined;
  return split ? readFrontmatterYaml(split.yaml) : { data: {} };
}

// Most files never name the key, and a Flow can take megabytes to parse.
function metadataTagsIn(text: string): string[] {
  if (!text.includes("tags")) return [];
  return tagsOf(readMetadataBlock(parse(text)).find((entry) => entry.key === "tags")?.values);
}

// The path a link names, folded as entry names compare, so a link files
// under one key whatever case it spells the path in. A library id keeps its
// spelling, since ids compare exactly.
function linkKey(target: RootedPath): string {
  return formatRootedPath({ root: target.root, path: entryNameKey(target.path) });
}

const sameStats = (entry: Entry, stats: Stats) =>
  entry.mtimeMs === stats.mtimeMs && entry.size === stats.size && entry.ino === stats.ino;

// Every file and folder under `dir` a path can name, relative to it: no dot
// entry, and nothing reached through a link. Siblings are listed in parallel,
// since on a slow mount every listing is a round trip. A folder that can't be
// listed holds nothing.
async function listRoot(dir: string): Promise<{ files: string[]; folders: string[] }> {
  const files: string[] = [];
  const folders: string[] = [];
  const walk = async (absolute: string, relative: string): Promise<void> => {
    let listed: Dirent[];
    try {
      listed = await readdir(absolute, { withFileTypes: true });
    } catch {
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

/** How many files a check reads at once. Enough to keep a slow mount busy;
 * other requests run between one batch and the next. */
const CHECK_BATCH = 64;

export function createDocumentIndex(): MemoryDocumentIndex {
  const entries = new Map<string, Entry>();
  const roots = new Map<string, RootState>();
  const checks = new Map<string, { state: Promise<RootState>; done?: Promise<void> }>();

  function unfile(file: string, entry: Entry): void {
    if (!entry.filed) return;
    const { root, keys } = entry.filed;
    for (const key of keys) {
      const notes = root.lookup.get(key);
      notes?.delete(file);
      if (notes?.size === 0) root.lookup.delete(key);
    }
    entry.filed = undefined;
  }

  // A changed or missing file loses its whole entry, so no fact outlives
  // another.
  function drop(file: string): void {
    const entry = entries.get(file);
    if (entry) unfile(file, entry);
    entries.delete(file);
  }

  function entryFor(file: string): Entry | undefined {
    let stats: Stats | undefined;
    try {
      // Not stat: a link is no file here, so its facts never reach the
      // tree. Pragma follows no link in a space.
      stats = lstatSync(file, { throwIfNoEntry: false });
    } catch {
      stats = undefined;
    }
    if (!stats?.isFile()) {
      drop(file);
      return undefined;
    }
    const held = entries.get(file);
    if (held && sameStats(held, stats)) return held;
    drop(file);
    const entry: Entry = { mtimeMs: stats.mtimeMs, size: stats.size, ino: stats.ino };
    entries.set(file, entry);
    return entry;
  }

  function frontmatterOf(file: string, entry: Entry): { data: Record<string, unknown>; error?: string } {
    if (!entry.frontmatter) {
      try {
        entry.frontmatter = readFrontmatterBlock(file);
      } catch {
        entry.frontmatter = { data: {} };
      }
    }
    return entry.frontmatter;
  }

  // Each link under the path it names, read from the note's own folder. A
  // link to a folder never lands on a file, so it files nowhere.
  function fileLinks(state: RootState, file: string, relative: string, entry: Entry): void {
    if (!entry.links || entry.filed?.root === state) return;
    unfile(file, entry);
    const docDir = dirnameOf(formatRootedPath({ root: state.root, path: relative }));
    const keys = new Set<string>();
    for (const link of entry.links) {
      const read = readWrittenPath(docDir, link.raw, link.form);
      if (read && !read.folder) keys.add(linkKey(read.target));
    }
    for (const key of keys) {
      const notes = state.lookup.get(key) ?? new Set<string>();
      notes.add(file);
      state.lookup.set(key, notes);
    }
    entry.filed = { root: state, keys: [...keys] };
  }

  // A listed file brought up to date. The entry kept is compared with the
  // stats read here when the reads end, whatever a question did to it
  // meanwhile; one that changed after them is caught by the next check.
  async function refresh(state: RootState, relative: string): Promise<void> {
    const file = path.join(state.dir, ...relative.split("/"));
    const stats = await lstat(file).catch(() => undefined);
    if (!stats?.isFile()) return drop(file);
    if (!isMarkdownFile(relative)) {
      const held = entries.get(file);
      if (held && !sameStats(held, stats)) drop(file);
      return;
    }
    const held = entries.get(file);
    const known = held && sameStats(held, stats) && held.links;
    const text = known ? undefined : await readFile(file, "utf8").catch(() => undefined);
    let entry = entries.get(file);
    if (!entry || !sameStats(entry, stats)) {
      drop(file);
      entry = { mtimeMs: stats.mtimeMs, size: stats.size, ino: stats.ino };
      entries.set(file, entry);
    }
    if (!entry.links) {
      const read = text === undefined ? { links: [], tags: [], embeds: [] } : readNote(text);
      entry.links = read.links;
      entry.inlineTags = read.tags;
      entry.embeds = read.embeds;
      if (text !== undefined) entry.frontmatter ??= attempt(() => frontmatterIn(text)).value ?? { data: {} };
    }
    fileLinks(state, file, relative, entry);
  }

  async function checkRoot(state: RootState): Promise<RootState> {
    const listing = await listRoot(state.dir);
    state.files = listing.files;
    state.paths = createPathIndex(listing);
    const listed = new Set(listing.files.map((relative) => path.join(state.dir, ...relative.split("/"))));
    const inside = state.dir.endsWith(path.sep) ? state.dir : state.dir + path.sep;
    for (const file of [...entries.keys()]) if (file.startsWith(inside) && !listed.has(file)) drop(file);
    const work = listing.files.filter(
      (relative) => isMarkdownFile(relative) || entries.has(path.join(state.dir, ...relative.split("/"))),
    );
    for (let i = 0; i < work.length; i += CHECK_BATCH) {
      await Promise.all(work.slice(i, i + CHECK_BATCH).map((relative) => refresh(state, relative)));
    }
    return state;
  }

  // A root is one folder: one named another way than before files afresh,
  // since its notes' keys spell its old root.
  function stateFor({ dir, root }: IndexRoot): RootState {
    const key = path.resolve(dir);
    const held = roots.get(key);
    if (held && sameRoot(held.root, root)) return held;
    if (held) {
      const filed = new Set([...held.lookup.values()].flatMap((notes) => [...notes]));
      for (const file of filed) {
        const entry = entries.get(file);
        if (entry) unfile(file, entry);
      }
    }
    const state: RootState = {
      dir: key,
      root,
      files: [],
      paths: createPathIndex({ files: [], folders: [] }),
      lookup: new Map(),
    };
    roots.set(key, state);
    return state;
  }

  function checked(root: IndexRoot): { state: Promise<RootState>; done?: Promise<void> } {
    const state = stateFor(root);
    let running = checks.get(state.dir);
    if (!running) {
      running = { state: checkRoot(state).finally(() => checks.delete(state.dir)) };
      checks.set(state.dir, running);
    }
    return running;
  }

  return {
    get size() {
      return entries.size;
    },
    frontmatter(file) {
      const entry = entryFor(file);
      return entry ? frontmatterOf(file, entry).data : {};
    },
    noteHead(file) {
      const entry = entryFor(file);
      if (!entry) return { data: {}, title: undefined };
      const { data, error } = frontmatterOf(file, entry);
      entry.title ??= attempt(() => splitNoteTitle(readHeadText(file)).title);
      return { data, title: entry.title.value, ...(error ? { error } : {}) };
    },
    noteExcerpt(file, maxChars) {
      const entry = entryFor(file);
      if (!entry) return undefined;
      entry.excerpt ??= attempt(() => noteExcerpt(readHeadText(file), maxChars));
      return entry.excerpt.value;
    },
    description(file, describe) {
      const entry = entryFor(file);
      if (!entry) return undefined;
      entry.description ??= attempt(() => describe(readFileSync(file, "utf8")));
      return entry.description.value;
    },
    // A wikilink may leave off `.md`, so a note's links file under its path
    // with the extension and without, and the resolver, on the listings just
    // read, keeps only the links that land on it.
    async backlinks(target, inRoots, isPreset = () => false) {
      const states = await Promise.all(inRoots.map((root) => checked(root).state));
      const indexOf = (root: PathRoot) => states.find((state) => sameRoot(state.root, root))?.paths;
      const wanted = parseRootedPath(target);
      const index = indexOf(wanted.root);
      const found = index && findEntry(index, wanted.path, "file");
      if (!found) return [];
      const spelled = formatRootedPath({ root: wanted.root, path: found.path });
      const keys = [linkKey({ root: wanted.root, path: found.path })];
      if (entryNameKey(found.path).endsWith(".md")) {
        keys.push(linkKey({ root: wanted.root, path: found.path.slice(0, -".md".length) }));
      }
      const answer: Backlink[] = [];
      for (const state of states) {
        const notes = new Set(keys.flatMap((key) => [...(state.lookup.get(key) ?? [])]));
        for (const note of notes) {
          const relative = path.relative(state.dir, note).split(path.sep).join("/");
          const linking = formatRootedPath({ root: state.root, path: relative });
          if (linking === spelled || (isPreset(linking) && !isPreset(spelled))) continue;
          const docDir = dirnameOf(linking);
          const mentions = (entries.get(note)?.links ?? [])
            .filter((link) => {
              const hit = resolveWrittenPath(docDir, link.raw, link.form, indexOf);
              return hit?.type === "file" && hit.path === spelled;
            })
            .map(({ line, text, at, raw }) => ({ line, text, at, length: raw.length }));
          if (mentions.length > 0) answer.push({ path: linking, mentions });
        }
      }
      return answer.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    },
    async classes(root) {
      const state = await checked(root).state;
      const found: IndexedClass[] = [];
      for (const relative of state.files) {
        if (!isClassFile(relative)) continue;
        const file = path.join(state.dir, ...relative.split("/"));
        const entry = entryFor(file);
        if (!entry) continue;
        entry.classFile ??= attempt(() => parseClassFile(readFileSync(file, "utf8")));
        if (entry.classFile.value) found.push({ path: relative, definition: entry.classFile.value });
      }
      return found;
    },
    inlineTags(file) {
      const entry = entryFor(file);
      if (!entry) return [];
      if (!entry.inlineTags) {
        const read = attempt(() => readNote(readFileSync(file, "utf8"))).value;
        entry.links ??= read?.links ?? [];
        entry.embeds ??= read?.embeds ?? [];
        entry.inlineTags = read?.tags ?? [];
      }
      return entry.inlineTags.map((tag) => tag.name);
    },
    notePaths(file) {
      const entry = entryFor(file);
      if (!entry) return { links: [], embeds: [] };
      if (!entry.links || !entry.embeds) {
        const read = attempt(() => readNote(readFileSync(file, "utf8"))).value;
        entry.links ??= read?.links ?? [];
        entry.inlineTags ??= read?.tags ?? [];
        entry.embeds ??= read?.embeds ?? [];
      }
      return { links: entry.links.map(({ form, raw }) => ({ form, raw })), embeds: entry.embeds ?? [] };
    },
    // A note's entry is as the check just read it; a Table's, Class's or
    // Flow's tags are read here, as no other question needs them.
    async tagged(root) {
      const state = await checked(root).state;
      const found: TaggedDocument[] = [];
      for (const relative of state.files) {
        const file = path.join(state.dir, ...relative.split("/"));
        const tags: IndexedTag[] = [];
        if (isMarkdownFile(relative)) {
          const entry = entries.get(file);
          if (!entry) continue;
          for (const name of tagsOf(frontmatterOf(file, entry).data.tags)) tags.push({ name });
          tags.push(...(entry.inlineTags ?? []));
        } else if (hasMetadataBlock(relative)) {
          const entry = entryFor(file);
          if (!entry) continue;
          entry.metadataTags ??= attempt(() => metadataTagsIn(readFileSync(file, "utf8")));
          for (const name of entry.metadataTags.value ?? []) tags.push({ name });
        }
        if (tags.length > 0) found.push({ path: relative, tags });
      }
      return found;
    },
    check(root) {
      const running = checked(root);
      running.done ??= running.state.then(() => undefined);
      return running.done;
    },
  };
}

let installed: DocumentIndex | undefined;

/** The process's one index, made the first time anything asks for it. The
 * space and every library share it, so a space switched back to is still
 * indexed and a library's facts serve every space. */
export function documentIndex(): DocumentIndex {
  installed ??= createDocumentIndex();
  return installed;
}

/** A host that keeps the index in other storage installs its own before
 * anything asks a question. Two indexes would disagree, so a late install is
 * refused rather than taking over halfway. */
export function installDocumentIndex(index: DocumentIndex): void {
  if (installed) throw new Error("The document index is already in use: install one before the host serves");
  installed = index;
}
