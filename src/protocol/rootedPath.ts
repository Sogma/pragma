// A path plus the root it is relative to. A bare string or `space:` means
// the space; a library root is named by the string itself. The grammar is
// protocol.md's Address grammar section — this module is the only
// place that implements it. A pure string parser, not a filesystem boundary:
// refusing to escape a real directory stays with the server's resolver.

/** Which root a path is relative to. A library is named by the id its own
 * install assigned it in the global config's `libraries[]` — never re-derived
 * from the folder name, so the id outlives a rename or a remount. */
export type PathRoot = "space" | { library: string };

export interface RootedPath {
  root: PathRoot;
  /** Relative to the root, `/`-separated, never leading or trailing. Empty
   * means the root itself — `lib:footage` is the library, not a file in it,
   * which is what a "this whole library is unavailable" state refers to. */
  path: string;
}

// A scheme is matched case-insensitively so that `Lib:x/y` is recognized as
// a scheme and rejected, rather than silently read as a space file literally
// named `Lib:x`. Only the lowercase spelling is a legal scheme: one
// canonical form per path is worth more here than tolerance.
const SCHEME = /^([A-Za-z][A-Za-z0-9+.-]*):(.*)$/s;

// Slugified from the folder basename with a numeric suffix on collision, so
// it holds neither `/` nor `:` and needs no escaping anywhere.
const LIBRARY_ID = /^[a-z0-9][a-z0-9-]*$/;

function parseRelative(input: string, context: string): string {
  if (input === "") return "";
  // Before the trailing slash is dropped, or "//" would trim to "" and read
  // as the root itself rather than as the empty segment it is.
  if (input.startsWith("/")) throw new Error(`${context} must be relative, not absolute: "${input}"`);
  // Refused rather than read as a separator. Windows splits a path at `\`
  // too, so a check that read this string would miss a segment the disk
  // sees; and callers pass the string on as written, so one that parses
  // must already be its one spelling.
  if (input.includes("\\")) throw new Error(`${context} must use "/" between names, not "\\": "${input}"`);

  // One trailing slash is tolerated and dropped; everything else about the
  // shape has exactly one spelling.
  const trimmed = input.endsWith("/") ? input.slice(0, -1) : input;
  if (trimmed === "") return "";

  for (const segment of trimmed.split("/")) {
    if (segment === "") throw new Error(`${context} has an empty path segment: "${input}"`);
    // Rejected here as well as at the resolver: a traversal that never parses
    // can't reach a resolver that forgot to check, and a stored path
    // containing `..` is a bug wherever it came from.
    if (segment === "." || segment === "..") {
      throw new Error(`${context} must not contain "." or ".." segments: "${input}"`);
    }
  }

  return trimmed;
}

/** Whether a path names its own root, as opposed to being relative to
 * something — not whether that root exists: `foo:bar` answers true here and
 * then fails to parse, which is the point. A caller resolving against a
 * *directory* must hand an unrecognized scheme to the parser to be refused
 * by name, never treat it as a filename.
 *
 * Scheme first, then the slash rule: a bare name means "next to the referring
 * document" only once the string is known to carry no scheme. */
export function hasPathScheme(input: string): boolean {
  return SCHEME.test(input);
}

/** Parses a path as it appears in storage and on pragma's own wire: a bare
 * relative string means the space, as does `space:`, and only `lib:` names
 * another root. Throws on a scheme it doesn't define, never falling back to
 * treating it as a space path — `foo:bar/baz.md` would otherwise resolve
 * against a space folder named `foo:bar` if one happened to exist. */
export function parseRootedPath(input: string): RootedPath {
  const scheme = SCHEME.exec(input);
  if (!scheme) return { root: "space", path: parseRelative(input, "A space path") };

  const [, name, rest] = scheme;
  // No id: a caller reaches exactly one space, the one it is bound to.
  if (name === "space") return { root: "space", path: parseRelative(rest, "A space path") };
  if (name === "lib") {
    const slash = rest.indexOf("/");
    const id = slash === -1 ? rest : rest.slice(0, slash);
    const within = slash === -1 ? "" : rest.slice(slash + 1);
    if (!LIBRARY_ID.test(id)) throw new Error(`"${input}" has no valid library id after "lib:"`);
    return { root: { library: id }, path: parseRelative(within, "A library path") };
  }

  throw new Error(`"${name}:" is not a path scheme Pragma recognizes: "${input}"`);
}

/** The inverse of the parser above, so a path handed out can be handed back.
 * Bare for the space, which is what storage and documents already contain. */
export function formatRootedPath(rooted: RootedPath): string {
  if (rooted.root === "space") return rooted.path;
  return rooted.path === "" ? `lib:${rooted.root.library}` : `lib:${rooted.root.library}/${rooted.path}`;
}

/** How a document stores a path someone dragged into it: the address, which
 * names its root outright, so the same entry is meant wherever the document
 * sits or later moves. A bare space path would read as beside the document. */
export function formatDeclaredPath(rooted: RootedPath): string {
  if (rooted.root === "space") return `space:${rooted.path}`;
  return formatRootedPath(rooted);
}

/** The folder an entry sits in, in its path's own form: rooted for a rooted
 * path, since a library id holds no `/` and the cut never lands inside the
 * root, and "" for an entry at the space's top level. */
export function dirnameOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

/** An entry's own name, the last segment of its path. */
export function basenameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** Whether the entry at `path` is the folder `folder` or inside it, both
 * spelled as one listing spells them; everything is within "", the root. */
export function isWithin(folder: string, path: string): boolean {
  return folder === "" || path === folder || path.startsWith(`${folder}/`);
}

/** Whether `input` is a legal library id, by the same pattern `lib:<id>/…`
 * is parsed with above. Exported so that whatever *mints* an id checks it
 * against the grammar that will have to parse it: an id this module would
 * refuse names a library no path can ever address, and the registry is the
 * wrong place to discover that. */
export function isLibraryId(input: string): boolean {
  return LIBRARY_ID.test(input);
}

/** Narrowing helper for the call sites that only support the space, so
 * "which root is this?" is answered by the type rather than by re-inspecting
 * the string. */
export function isLibraryRoot(root: PathRoot): root is { library: string } {
  return root !== "space";
}

/** Whether two paths are addressed against the same root. A move is the
 * caller that needs this: renaming within a root is one filesystem
 * operation, while carrying a file from one root to another is a copy, over
 * a boundary the two roots may not even share a device across. */
export function sameRoot(a: PathRoot, b: PathRoot): boolean {
  if (!isLibraryRoot(a) || !isLibraryRoot(b)) return a === b;
  return a.library === b.library;
}

/** Whether a stored path string names a library rather than the space, for
 * callers holding the raw persisted string. An unparseable path is not a
 * library: this decides which root, never validates — the resolver refuses a
 * malformed path naming what is wrong, and "true" here would send it down the
 * library branch to be refused for the wrong reason. */
export function isLibraryPath(input: string): boolean {
  try {
    return isLibraryRoot(parseRootedPath(input).root);
  } catch {
    return false;
  }
}
