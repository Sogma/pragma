// Paths as a document writes them — a Markdown link's `notes.md`, an image's
// `../art/cover.png`, a wikilink's `plan`, a Flow node's `space:refs` — and
// the one rule for reading one and the one for writing one. Two halves kept
// together so a path that survives a move round-trips: read what the author
// wrote, then write the equivalent from wherever the document ended up.
import { isHiddenName } from "./entryName.ts";
import {
  formatDeclaredPath,
  formatRootedPath,
  hasPathScheme,
  isLibraryId,
  isLibraryRoot,
  type PathRoot,
  parseRootedPath,
  type RootedPath,
  sameRoot,
} from "./rootedPath.ts";
import { type ScopeFolders, sameScope } from "./scopes.ts";

/** How a path is written: `markdown` for a Markdown link or embed and every
 * path a document declares, percent-encoded as a URL is; `wikilink` for a
 * wikilink's target, read as written. */
export type PathForm = "markdown" | "wikilink";

export interface WrittenPath {
  /** The entry the path spells, in the root it names. */
  target: RootedPath;
  /** It ends in `/`, so it names only a folder. */
  folder: boolean;
}

type Failure = "above-root" | "hidden" | "unreadable" | "outside-library";

const SCHEME = /^([A-Za-z][A-Za-z0-9+.-]*):(.*)$/s;
// A backslash separates too, as a browser reads one in a URL: on Windows it
// is the separator, and a `..\` it didn't split on would climb unseen.
const SEPARATOR = /[/\\]/;

// A `%XX` run decodes as UTF-8 where it can; a stray `%` stays a `%`.
function decodePercent(text: string): string {
  return text.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      return run;
    }
  });
}

// Each segment is decoded on its own, so an encoded `/` never splits one.
// A `..` past the root names nothing rather than stopping there: a folder
// opened alone would otherwise read a climbing path as one of its own.
//
// An address names its root, so it has one spelling: a `.`, `..` or empty
// segment in one names nothing, as protocol.md's grammar says, where a
// relative path takes them as steps.
function walk(start: readonly string[], text: string, decode: boolean, address: boolean): string[] | Failure {
  const segments = [...start];
  const raw = text.split(SEPARATOR);
  // One trailing separator marks a folder; it is no segment.
  if (raw.length > 1 && raw[raw.length - 1] === "") raw.pop();
  for (const each of raw) {
    const segment = decode ? decodePercent(each) : each;
    if (SEPARATOR.test(segment)) return "unreadable";
    if (address && text !== "" && (segment === "" || segment === "." || segment === "..")) return "unreadable";
    if (segment === "" || segment === ".") continue;
    if (segment !== "..") segments.push(segment);
    else if (segments.pop() === undefined) return "above-root";
  }
  return segments.some(isHiddenName) ? "hidden" : segments;
}

function read(docDir: string, written: string, form: PathForm): WrittenPath | Failure {
  let doc: RootedPath;
  try {
    doc = parseRootedPath(docDir);
  } catch {
    return "unreadable";
  }
  const decode = form === "markdown";
  // A Markdown link's `#anchor` and `?query` aren't part of the file it names.
  const text = decode ? written.trim().replace(/[?#].*$/s, "") : written.trim();
  if (text === "" || text.startsWith("//")) return "unreadable";

  let root: PathRoot = doc.root;
  let start = doc.path === "" ? [] : doc.path.split("/");
  let rest = text;
  const scheme = SCHEME.exec(text);
  if (scheme) {
    const [, name, after] = scheme;
    const slash = after.indexOf("/");
    if (name === "space") root = "space";
    else if (name === "lib" && isLibraryId(slash === -1 ? after : after.slice(0, slash))) {
      root = { library: slash === -1 ? after : after.slice(0, slash) };
    } else return "unreadable";
    start = [];
    rest = name === "space" ? after : slash === -1 ? "" : after.slice(slash + 1);
  } else if (SEPARATOR.test(text[0])) {
    start = [];
  }
  // A library means the same in every space that browses it, so its
  // documents name nothing outside it.
  if (isLibraryRoot(doc.root) && !sameRoot(doc.root, root)) return "outside-library";

  const segments = walk(start, rest, decode, scheme !== null);
  if (typeof segments === "string") return segments;
  return { target: { root, path: segments.join("/") }, folder: SEPARATOR.test(text.at(-1) ?? "") };
}

/** What a path written in a document at `docDir` spells: a scheme names its
 * root, a leading `/` the document's root, and anything else is read from
 * the document's folder. Whether the entry is there is the index's to say.
 *
 * Undefined for a path that names nothing: one that climbs past its root,
 * names a dot-entry, carries another scheme, steps inside an address, or
 * leaves a library from inside it. */
export function readWrittenPath(docDir: string, written: string, form: PathForm): WrittenPath | undefined {
  const result = read(docDir, written, form);
  return typeof result === "string" ? undefined : result;
}

/** Where a file reference in a document points — an image embed in a note,
 * a Table's `media` cell — as a rooted path, or undefined when it names
 * nothing. A reference carrying a scheme (`lib:<id>/…`, `space:…`) is read
 * by its own root, so `lib:cover.png` is never taken for a sibling file of
 * that name; anything else resolves from the document's folder. */
export function resolveFileReference(docDir: string, reference: string): string | undefined {
  const read = readWrittenPath(docDir, reference, "markdown");
  return read && formatRootedPath(read.target);
}

// Percent-encodes one path segment for use in a reference. `encodeURIComponent`
// leaves parentheses alone, and a bare `)` closes a Markdown link
// destination early — so the two that would truncate the reference are
// encoded by hand on top of it.
function encodeSegment(segment: string): string {
  return encodeURIComponent(segment).replace(/\(/g, "%28").replace(/\)/g, "%29");
}

// The `..` hops and then the segments that lead from `fromDir` to
// `targetPath`, both under the same root and relative to it, unencoded.
function relativeSegments(fromDir: string, targetPath: string): string[] {
  const from = fromDir === "" ? [] : fromDir.split("/");
  const to = targetPath === "" ? [] : targetPath.split("/");

  // Stops one short of `to`'s last segment: that one names the file itself,
  // never a directory the two paths can be said to share.
  let shared = 0;
  while (shared < from.length && shared < to.length - 1 && from[shared] === to[shared]) shared++;

  const hops = Array.from({ length: from.length - shared }, () => "..");
  return [...hops, ...to.slice(shared)];
}

function joinSegments(path: string, form: PathForm): string {
  if (path === "") return "";
  const segments = path.split("/");
  return (form === "markdown" ? segments.map(encodeSegment) : segments).join("/");
}

function libraryPath(library: string, path: string, form: PathForm): string {
  return path === "" ? `lib:${library}` : `lib:${library}/${joinSegments(path, form)}`;
}

export interface WritingOptions {
  form: PathForm;
  /** The folders a scope opens over in the document's own root. */
  scopes: ScopeFolders;
  /** The target is a folder, so the path ends in `/`. */
  folder?: boolean;
}

/** How a document in the folder `docDir` writes a path to `target`, both
 * rooted. Relative when the two sit in one scope, so the path keeps naming
 * its file wherever that scope is opened or moved; from the root otherwise;
 * `lib:<id>/…` into a library from the space. Undefined when a library
 * document would name outside it. */
export function formatWrittenPath(docDir: string, target: RootedPath, options: WritingOptions): string | undefined {
  const { form, scopes, folder = false } = options;
  const doc = parseRootedPath(docDir);
  // A wikilink leaves off `.md`, which it reads back as optional.
  const path = form === "wikilink" && !folder ? target.path.replace(/\.md$/i, "") : target.path;
  const slash = folder && path !== "" ? "/" : "";
  if (!sameRoot(doc.root, target.root)) {
    if (isLibraryRoot(doc.root) || !isLibraryRoot(target.root)) return undefined;
    return `${libraryPath(target.root.library, path, form)}${folder ? "/" : ""}`;
  }
  if (sameScope(scopes, doc, target)) {
    const segments = relativeSegments(doc.path, path);
    const relative = (form === "markdown" ? segments.map(encodeSegment) : segments).join("/");
    return relative === "" ? "./" : `${relative}${slash}`;
  }
  return `/${joinSegments(path, form)}${slash}`;
}

/** An entry written from its root, unencoded: `/a/b.md` in the space,
 * `lib:<id>/a/b.md` in a library, `/` for the space itself. A folder ends in
 * `/`. The same spelling from any folder, so a path a node hands on names one
 * entry wherever it is read. */
export function formatRootPath(target: RootedPath, folder = false): string {
  const slash = folder && target.path !== "" ? "/" : "";
  if (isLibraryRoot(target.root)) return `${libraryPath(target.root.library, target.path, "wikilink")}${slash}`;
  return `/${target.path}${slash}`;
}

/** Whether a `/`-separated path names an entry a listing hides, one with a
 * segment starting with a dot. Every path-level dot test goes through this. */
export function isHiddenPath(relativePath: string): boolean {
  return relativePath.split("/").some(isHiddenName);
}

/** Where a path a document declares leads: a Flow node's, an Applet's
 * import. Read as every path in a document is, from `docDir`, the folder the
 * document sits in. Throws, naming why, for a path that names nothing; the
 * file may still be absent. */
export function resolveDeclaredPath(docDir: string, declared: string): RootedPath {
  const result = read(docDir, declared, "markdown");
  if (result === "outside-library") {
    throw new Error(`A library document names only files in its own library: "${declared}"`);
  }
  if (typeof result === "string") throw new Error(`"${declared}" ${DECLARED_FAILURES[result]}`);
  return result.target;
}

const DECLARED_FAILURES: Record<Exclude<Failure, "outside-library">, string> = {
  "above-root": "climbs above its root",
  hidden: "names a hidden entry, which no path reaches",
  unreadable: "isn't a path Pragma can read",
};

/** Whether `input` is an address in its one canonical spelling, the only
 * form a path reaches the server in when a wire chose it. */
export function isDeclaredAddress(input: string): boolean {
  if (!hasPathScheme(input)) return false;
  try {
    return formatDeclaredPath(parseRootedPath(input)) === input;
  } catch {
    return false;
  }
}
