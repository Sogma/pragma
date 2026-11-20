import { spellingIn } from "../../src/protocol/entryName.ts";
import { isPathDestination, noteLinks } from "../../src/protocol/markdownLinks.ts";
import type { NameIndex } from "../../src/protocol/nameIndex.ts";
import {
  createPathIndex,
  type FoundEntry,
  matchEntries,
  type PathIndex,
  resolveWrittenPath,
} from "../../src/protocol/pathIndex.ts";
import {
  formatWrittenPath,
  type PathForm,
  readWrittenPath,
  resolveFileReference,
} from "../../src/protocol/relativeReference.ts";
import {
  dirnameOf,
  formatRootedPath,
  isLibraryPath,
  isLibraryRoot,
  isWithin,
  type PathRoot,
  parseRootedPath,
  type RootedPath,
} from "../../src/protocol/rootedPath.ts";
import { isAgentsFile, type ScopeFolders } from "../../src/protocol/scopes.ts";
import { isTemplatePath, TEMPLATES_FOLDER } from "../../src/protocol/templates.ts";
import { type DocumentType, documentTypeFor, imageMediaTypeForPath, isMarkdownFile } from "../../src/protocol/types.ts";
import { createWorldIndex, resolveWorldName, worldFolder } from "../../src/protocol/worldNames.ts";
import type { PathNames } from "../lib/pathLabel.ts";
import type { LinkLead } from "../markdownRender.ts";
import {
  fetchLibraryPaths,
  fetchLibraryTree,
  fetchSpacePaths,
  fetchTree,
  type RootPathsResponse,
  type SpaceTreeNode,
} from "./apiClient.ts";
import { ownSortOf } from "./folderOrder.ts";
import { ensureLibraryPermissions, libraryIds, libraryName } from "./libraries.ts";
import {
  type EntryIcon,
  entryIcon,
  type FileType,
  fileTypeClass,
  flattenTreeFilePaths,
  isJsonFile,
  nodeFileType,
  pathHint,
} from "./paths.ts";

// Owns the last tree fetched from the server — every consumer (the tree
// view, drag/reorder, link resolution) reads from here rather than each
// holding its own copy or re-fetching. One module-level instance: a space has
// exactly one tree, same reasoning as services/gitStatus.ts's single
// gitStatusStore.
let currentTree: SpaceTreeNode[] = [];
// Every file and folder the space holds, which a written path is read
// against: the tree leaves out the files it doesn't show. Undefined until the
// first read lands.
let currentPaths: RootPathsResponse | undefined;
// The change version the tree was read at, undefined until a read names one.
let readAt: string | undefined;
// Writes noted since the window opened, and how many of them the listing
// held when its read went out: undefined until a read lands.
let unlistedWrites = 0;
let listedThrough: number | undefined;

export function getTree(): SpaceTreeNode[] {
  return currentTree;
}

/** Every file a picker offers, in tree order: the templates left out, since
 * the space's content never holds one. New ▸ Template and the Templates
 * section are where they are offered. */
export function offeredFiles(): string[] {
  return flattenTreeFilePaths(currentTree).filter((path) => !isTemplatePath(path));
}

/** Every file a Class can link, by path, in tree order: what a picker
 * offers, and the space's Markdown templates, which its New note starts
 * from. */
export function classLinkFiles(): string[] {
  return flattenTreeFilePaths(currentTree).filter((path) => !isTemplatePath(path) || isMarkdownFile(path));
}

/** The change version the current tree was read at: equal to the space's
 * version now means nothing changed since. */
export function treeChanges(): string | undefined {
  return readAt;
}

const libraryLoadListeners = new Set<() => void>();

// A library's tree and listing, kept beside the space's because a document
// in a library resolves its links against its own library. Each loads the
// first time something asks, so a library nobody reads costs nothing, and is
// announced when it lands or fails, so an open document can resolve again.
function libraryCache<T>(fetch: (id: string) => Promise<T>) {
  const loaded = new Map<string, T>();
  // A load in flight, or failed: either way not asked for again until the
  // library is forgotten, or every redraw of an unresolved link would ask once
  // more. A load a forget overtook is dropped when it lands.
  const loads = new Map<string, Promise<T | undefined>>();
  const failed = new Set<string>();
  const announce = () => {
    for (const listener of libraryLoadListeners) listener();
  };
  function load(id: string): Promise<T | undefined> {
    const known = loaded.get(id);
    if (known) return Promise.resolve(known);
    const pending = loads.get(id);
    if (pending) return pending;
    const next: Promise<T | undefined> = fetch(id).then(
      (value) => {
        if (loads.get(id) !== next) return undefined;
        loaded.set(id, value);
        announce();
        return value;
      },
      () => {
        if (loads.get(id) === next) {
          failed.add(id);
          announce();
        }
        return undefined;
      },
    );
    loads.set(id, next);
    return next;
  }
  function get(id: string): T | undefined {
    const known = loaded.get(id);
    if (!known) void load(id);
    return known;
  }
  return {
    get,
    // Asked for, and neither landed nor failed.
    pending: (id: string) => get(id) === undefined && !failed.has(id),
    load,
    forget(id: string): void {
      loaded.delete(id);
      loads.delete(id);
      failed.delete(id);
    },
  };
}

const libraryTrees = libraryCache(fetchLibraryTree);
const libraryPaths = libraryCache(fetchLibraryPaths);

export async function loadLibraryTree(id: string): Promise<SpaceTreeNode[]> {
  return (await libraryTrees.load(id)) ?? [];
}

/** Drops a library's tree and listing after its files changed, so the next
 * document to ask loads them afresh. */
export function forgetLibraryTree(id: string): void {
  libraryTrees.forget(id);
  libraryPaths.forget(id);
}

/** Calls `listener` whenever a library's tree or listing lands, or fails to. */
export function onLibraryTreeLoaded(listener: () => void): () => void {
  libraryLoadListeners.add(listener);
  return () => libraryLoadListeners.delete(listener);
}

// Fetches a fresh tree and listing and stores them. Callers re-render
// whatever they own afterward (the tree view) — this module has no
// subscribers of its own.
//
// A read started before a write never counts that write as listed, even
// landing after a newer read.
export async function refresh(): Promise<SpaceTreeNode[]> {
  const through = unlistedWrites;
  const [read, paths] = await Promise.all([fetchTree(), fetchSpacePaths()]);
  currentTree = read.tree;
  readAt = read.changes;
  currentPaths = paths;
  listedThrough = through;
  return currentTree;
}

/** Notes that files may have been written which the listing doesn't hold
 * yet: a copy dropped in, a Flow's run. Until a read started after this
 * lands, the listing never says a file is gone. */
export function noteUnlistedWrites(): void {
  unlistedWrites++;
}

/** Whether the space's listing says nothing is at `rootedPath`. Never for a
 * library's path, whose listing may be old or not loaded yet, or while the
 * listing may lack a write noted since its read went out. */
export function listedAsGone(rootedPath: string): boolean {
  if (listedThrough !== unlistedWrites || !currentPaths) return false;
  const { root, path } = parseRootedPath(rootedPath);
  if (isLibraryRoot(root)) return false;
  return matchEntries(path, "any", indexesOf(currentPaths).paths.names).length === 0;
}

function findChildrenIn(tree: SpaceTreeNode[], dirPath: string): SpaceTreeNode[] | undefined {
  if (dirPath === "") return tree;
  for (const node of tree) {
    if (node.type === "directory" && node.path === dirPath) return node.children ?? [];
    if (node.children) {
      const found = findChildrenIn(node.children, dirPath);
      if (found) return found;
    }
  }
  return undefined;
}

function findNodeIn(tree: SpaceTreeNode[], dirPath: string): SpaceTreeNode | undefined {
  for (const node of tree) {
    if (node.type === "directory" && node.path === dirPath) return node;
    if (node.children) {
      const found = findNodeIn(node.children, dirPath);
      if (found) return found;
    }
  }
  return undefined;
}

// Returns the live node/children arrays from the current tree — not a
// clone — so a caller that mutates a returned node in place is mutating the
// one tree every other reader sees too.
export function findDirectoryChildren(dirPath: string): SpaceTreeNode[] | undefined {
  return findChildrenIn(currentTree, dirPath);
}

export function findDirectoryNode(dirPath: string): SpaceTreeNode | undefined {
  return findNodeIn(currentTree, dirPath);
}

/** A space folder's entry names in its own order, as the tree lists them,
 * while that order is manual, so a drag can arrange it; undefined while it
 * is another, and for the space's top folder, which has no row to carry an
 * order. */
export function manualArrangement(dirPath: string): string[] | undefined {
  const node = dirPath === "" ? undefined : findDirectoryNode(dirPath);
  if (!node || ownSortOf(node).by !== "manual") return undefined;
  return (findDirectoryChildren(dirPath) ?? []).map((child) => child.name);
}

/** The space's templates folder as the root lists it, its name in any case,
 * or its own name before one is made. */
export function templatesFolder(): string {
  const folders = currentTree.filter((node) => node.type === "directory").map((node) => node.name);
  return spellingIn(folders, TEMPLATES_FOLDER) ?? TEMPLATES_FOLDER;
}

/** A file or folder the tree draws, by its space path. */
export function findEntry(path: string, tree: SpaceTreeNode[] = currentTree): SpaceTreeNode | undefined {
  for (const node of tree) {
    if (node.path === path) return node;
    const found = node.children && findEntry(path, node.children);
    if (found) return found;
  }
  return undefined;
}

/** The class a file's icon wears where only its rooted path is at hand: a
 * tab, a Quick Open row, a search result, a Links row, a gallery tile. Never
 * for a library tree's row, whose paths are relative to the library: a space
 * file at the same path would lend it Pragma's colours. */
export function fileTypeAt(path: string): FileType | undefined {
  const entry = isAgentsFile(path) || isJsonFile(path) ? findEntry(path) : undefined;
  return entry ? nodeFileType(entry) : fileTypeClass(path);
}

/** An entry's icon where only its rooted path is at hand, as the tree draws
 * it: a folder takes its site and scope from the tree, a file its kind as
 * `fileTypeAt` reads it, under the same rule. */
export function entryIconAt(path: string, type: "file" | "directory"): EntryIcon {
  if (type === "file") return { glyph: fileTypeAt(path) };
  const folder = findDirectoryNode(path);
  return folder ? entryIcon(folder) : { glyph: "folder" };
}

/** What a path label asks of the space: a library's name and an entry's
 * icon, each as every other surface draws it. */
export const pathNames: PathNames = { libraryName, icon: entryIconAt };

export interface SiteRoot {
  siteDir: string;
  siteName: string;
  assetsFolder?: string;
}

// Gates the assistant panel's Publish/Update section: the server's site
// resolution (src/server/sites.ts) and its nearest-ancestor rule
// (docs/publishing.md's Publishing a document section), run on the loaded
// tree to skip a round trip. Only `_site.json`'s name travels in the client
// tree; the full record is resolved server-side at publish time.
export function findSiteRoot(filePath: string): SiteRoot | undefined {
  const segments = filePath.split("/");
  for (let i = segments.length - 1; i >= 1; i--) {
    const dirPath = segments.slice(0, i).join("/");
    const node = findDirectoryNode(dirPath);
    if (node?.site) return { siteDir: dirPath, siteName: node.site.name, assetsFolder: node.site.assetsFolder };
  }
  return undefined;
}

// Every image under `dirPath`, raster or vector, in tree order, for a
// site's image settings to choose from: the service takes either.
export function imagesUnder(dirPath: string): string[] {
  const images: string[] = [];
  const walk = (nodes: readonly SpaceTreeNode[]): void => {
    for (const node of nodes) {
      if (node.type === "directory") walk(node.children ?? []);
      else if (imageMediaTypeForPath(node.path)) images.push(node.path);
    }
  };
  walk(findDirectoryNode(dirPath)?.children ?? []);
  return images;
}

// The folder an image pasted or dropped into `docPath` is copied into: its
// site's assets folder when it has one, else beside the document. A named
// folder that no longer exists falls back too, since the upload refuses a
// missing destination rather than creating it.
export function imageFolderFor(docPath: string): string {
  const site = findSiteRoot(docPath);
  if (site?.assetsFolder) {
    const folder = `${site.siteDir}/${site.assetsFolder}`;
    if (findDirectoryNode(folder)) return folder;
  }
  return dirnameOf(docPath);
}

// ---- Reading a written path ----

interface RootIndexes {
  paths: PathIndex;
  scopes: ReadonlySet<string>;
}

// Keyed by the listing itself: a refresh replaces it, which is what retires
// the index built from it. Built once per listing, not per lookup, because
// reading view resolves every link on each render.
const rootIndexes = new WeakMap<RootPathsResponse, RootIndexes>();

function indexesOf(listing: RootPathsResponse): RootIndexes {
  let indexes = rootIndexes.get(listing);
  if (!indexes) {
    indexes = { paths: createPathIndex(listing), scopes: new Set(listing.scopes) };
    rootIndexes.set(listing, indexes);
  }
  return indexes;
}

function pathIndexOf(root: PathRoot): PathIndex | undefined {
  const listing = isLibraryRoot(root) ? libraryPaths.get(root.library) : currentPaths;
  return listing && indexesOf(listing).paths;
}

// Whether a path written in a document in the folder `docDir` points into a
// root whose listing is still to land, so what it names can't be told. A
// library whose listing failed to load names nothing.
function pendingFrom(docDir: string, written: string, form: PathForm): boolean {
  const read = readWrittenPath(docDir, written, form);
  if (!read) return false;
  const { root } = read.target;
  return isLibraryRoot(root) ? libraryPaths.pending(root.library) : currentPaths === undefined;
}

/** What a path written in the document at `docPath` names, read by `form`:
 * the entry's rooted path and type. Undefined when it names nothing, or its
 * root's listing hasn't landed yet: that one is asked for, and announced
 * when it lands. */
export function resolvePathFrom(docPath: string, written: string, form: PathForm): FoundEntry | undefined {
  return resolveWrittenPath(dirnameOf(docPath), written, form, pathIndexOf);
}

/** The folders a scope opens over in the root `path` sits in, for writing a
 * path from there. A library is one scope. */
export function scopesOf(path: string): ReadonlySet<string> {
  return isLibraryPath(path) || !currentPaths ? new Set() : indexesOf(currentPaths).scopes;
}

/** How a document in the folder `docDir` writes a path to `target`, by the
 * protocol's one writing rule, with its root's scopes; undefined when it
 * can't name the target. Every path the browser writes comes from here. */
export function writePathFrom(
  docDir: string,
  target: RootedPath,
  { form = "markdown", folder = false, scopes = scopesOf(docDir) }: WritePathOptions = {},
): string | undefined {
  return formatWrittenPath(docDir, target, { form, scopes, folder });
}

export interface WritePathOptions {
  form?: PathForm;
  folder?: boolean;
  /** The root's scopes, when the caller holds them already. */
  scopes?: ScopeFolders;
}

// A folder's path ends in `/`, as a link writes one, so whatever opens it
// knows to show its gallery.
const linkTarget = (found: FoundEntry | undefined) =>
  found && (found.type === "directory" ? `${found.path}/` : found.path);

/** How reading view resolves what the document at `docPath` points at.
 * An embed or a Markdown link into a library whose listing hasn't landed
 * keeps the path as written, since the server can still serve it. */
export function readingResolvers(docPath: string) {
  return readingResolversIn(dirnameOf(docPath));
}

/** The same for text read as a document in the folder `docDir` reads it,
 * `""` being the space root. A wikilink into a root whose listing is still
 * to land is pending: neither a link nor missing until the listing lands. */
export function readingResolversIn(docDir: string) {
  const found = (written: string, form: PathForm) => linkTarget(resolveWrittenPath(docDir, written, form, pathIndexOf));
  const markdown = (href: string) => found(href, "markdown") ?? resolveFileReference(docDir, href);
  const pending = (written: string, form: PathForm) => pendingFrom(docDir, written, form);
  return {
    image(href: string): string | undefined {
      const path = markdown(href);
      return path !== undefined && imageMediaTypeForPath(path)
        ? `/api/file/raw?path=${encodeURIComponent(path)}`
        : undefined;
    },
    link: (href: string) => (href.startsWith("#") ? undefined : markdown(href)),
    wikilink: (target: string) => found(target, "wikilink"),
    wikilinkPending: (target: string) => pending(target, "wikilink"),
    hint: (lead: LinkLead, text: string) => linkHint(lead, text, pending),
  };
}

// A link's hint where no page of its file shows: the file's path, the web
// address, or the target as written when the listing holds nothing there.
// A Markdown link to no file at all, a bare `#anchor`, says nothing, and so
// does a path whose root's listing is still to land.
function linkHint(
  lead: LinkLead,
  text: string,
  pending: (written: string, form: PathForm) => boolean,
): string | undefined {
  if ("url" in lead) return lead.url === text ? undefined : lead.url;
  if (lead.path !== undefined && !listedAsGone(lead.path)) return pathHint(lead.path, text);
  const written = lead.written.trim();
  if (!written || (lead.form === "markdown" && !isPathDestination(written))) return undefined;
  return pending(lead.written, lead.form) ? undefined : `Not found: ${written}`;
}

/** What a `[[` offers in one document, and what it writes the pick by. */
export interface LinkScope {
  /** The document's own path, rooted. */
  docPath: string;
  /** The files the document's root shows, and its folders, rooted. */
  files: readonly string[];
  folders: readonly string[];
  /** The folders a scope opens over in that root. */
  scopes: ReadonlySet<string>;
}

function treeFolders(nodes: readonly SpaceTreeNode[]): string[] {
  return nodes.flatMap((node) => (node.type === "directory" ? [node.path, ...treeFolders(node.children ?? [])] : []));
}

/** What a `[[` in the document at `docPath` offers from its own root. An
 * unloaded library offers nothing yet. */
export function linkScope(docPath: string): LinkScope | undefined {
  let rooted: RootedPath;
  try {
    rooted = parseRootedPath(docPath);
  } catch {
    return undefined;
  }
  const { root } = rooted;
  const tree = isLibraryRoot(root) ? (libraryTrees.get(root.library) ?? []) : currentTree;
  const address = (path: string) => formatRootedPath({ root, path });
  return {
    docPath,
    files: flattenTreeFilePaths(tree).map(address),
    folders: treeFolders(tree).map(address),
    scopes: scopesOf(docPath),
  };
}

/** Every file the registered libraries show, rooted, for a space document's
 * `[[`. Each library's tree loads the first time this asks. */
export async function libraryFiles(): Promise<string[]> {
  await ensureLibraryPermissions();
  const trees = await Promise.all(libraryIds().map(async (id) => ({ id, tree: await libraryTrees.load(id) })));
  return trees.flatMap(({ id, tree }) =>
    flattenTreeFilePaths(tree ?? []).map((path) => formatRootedPath({ root: { library: id }, path })),
  );
}

interface TreeNames {
  files: readonly string[];
  worlds: Map<string, NameIndex>;
}

// Keyed by the tree itself, as the listing's indexes are: a screenplay
// resolves every capitalised run on screen on each redraw.
const treeNames = new WeakMap<SpaceTreeNode[], TreeNames>();

function namesOf(tree: SpaceTreeNode[]): TreeNames {
  let names = treeNames.get(tree);
  if (!names) {
    const files = flattenTreeFilePaths(tree);
    names = { files, worlds: new Map() };
    treeNames.set(tree, names);
  }
  return names;
}

/** What a name in the screenplay at `docPath` links to, by its world: the
 * folder its scope's World setting names. Undefined for a screenplay no scope
 * gives one, a library's among them, since a library opens no scope. */
export function worldNameResolver(docPath: string): ((name: string) => string | undefined) | undefined {
  let rooted: RootedPath;
  try {
    rooted = parseRootedPath(docPath);
  } catch {
    return undefined;
  }
  const { root, path } = rooted;
  if (isLibraryRoot(root)) return undefined;
  const names = namesOf(currentTree);
  const folder = worldFolder(scopeBlock, path);
  if (folder === undefined) return undefined;
  let world = names.worlds.get(folder);
  if (!world) {
    world = createWorldIndex(names.files, folder);
    names.worlds.set(folder, world);
  }
  const index = world;
  return (name) => {
    const found = resolveWorldName(index, name);
    return found === undefined ? undefined : formatRootedPath({ root, path: found });
  };
}

/** The settings of the scope a space folder opens, as its AGENTS.md's
 * `pragma` value holds them; undefined for a folder that opens none, or
 * whose block holds no settings. "" is the space's own. */
export function scopeBlock(folder: string): unknown {
  return currentPaths?.settings?.[folder];
}

/** Whether the space folder at `folder` holds a document of `type` anywhere
 * under it. */
export function holdsDocumentType(folder: string, type: DocumentType): boolean {
  return currentPaths?.files.some((file) => isWithin(folder, file) && documentTypeFor(file) === type) ?? false;
}

/** What a document links to: each file it names, once, in order of first
 * mention, with where it names it and, when worth showing, how often; then
 * the targets that name no file, as written, and those pointing into a root
 * whose listing is still to land, which can't be told either way. */
export interface DocumentLinks {
  found: { path: string; count?: number; mentions: { from: number; to: number }[] }[];
  missing: string[];
  pending?: string[];
}

/** A Markdown document's links, as the protocol reads a note's, mentions as
 * offsets into `content`; a link to a folder is left out. */
export function markdownLinks(docPath: string, content: string): DocumentLinks {
  const found = new Map<string, { from: number; to: number }[]>();
  const missing = new Set<string>();
  const pending = new Set<string>();
  for (const link of noteLinks(content)) {
    const hit = resolvePathFrom(docPath, link.raw, link.form);
    if (hit === undefined) {
      (pendingFrom(dirnameOf(docPath), link.raw, link.form) ? pending : missing).add(link.raw.trim());
      continue;
    }
    if (hit.type === "directory") continue;
    const mentions = found.get(hit.path);
    if (mentions) mentions.push({ from: link.from, to: link.to });
    else found.set(hit.path, [{ from: link.from, to: link.to }]);
  }
  return {
    found: [...found].map(([path, mentions]) => ({ path, mentions })),
    missing: [...missing],
    pending: [...pending],
  };
}

/** `paths` in the order the file tree draws them, each root's tree in turn;
 * a path no loaded tree holds goes last, as given. */
export function inTreeOrder(paths: readonly string[]): string[] {
  const roots = new Map<string, RootedPath["root"]>();
  for (const path of paths) {
    try {
      const { root } = parseRootedPath(path);
      roots.set(isLibraryRoot(root) ? `lib:${root.library}` : "space", root);
    } catch {
      // Unparseable: no tree holds it.
    }
  }
  const rank = new Map<string, number>();
  for (const root of roots.values()) {
    const tree = isLibraryRoot(root) ? libraryTrees.get(root.library) : currentTree;
    for (const file of flattenTreeFilePaths(tree ?? [])) rank.set(formatRootedPath({ root, path: file }), rank.size);
  }
  const at = (path: string) => rank.get(path) ?? rank.size;
  return [...paths].sort((a, b) => at(a) - at(b));
}
