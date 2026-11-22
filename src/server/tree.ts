// The space tree: which files show, the tree itself, the private-document
// filter every model-facing caller applies, and search.

import { type Dirent, readdirSync, type Stats } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { loadGlobalConfig, showsAllFileTypes } from "../config/loadConfig.ts";
import type { RootPathsResponse, SpaceTreeNode } from "../protocol/api.ts";
import { isHiddenName, isNamed } from "../protocol/entryName.ts";
import { compareEntryNames, parseFolderSort } from "../protocol/folderSort.ts";
import { hasMetadataBlock } from "../protocol/metadata.ts";
import { pragmaFileRole, SITE_FILENAME } from "../protocol/pragmaFiles.ts";
import { isPrivateContent } from "../protocol/privacy.ts";
import { dirnameOf } from "../protocol/rootedPath.ts";
import { isSettingsBlock, settingFolder, settingValue, WORLD_SETTING } from "../protocol/scopeSettings.ts";
import { isAgentsFile, opensScope, type ScopeFolders } from "../protocol/scopes.ts";
import { type FileKind, fileKindForPath, hasKnownKind, isMarkdownFile } from "../protocol/types.ts";
import { entryDescription } from "./descriptions.ts";
import { documentIndex } from "./documentIndex.ts";
import { orderByFolder } from "./folderOrder.ts";
import { readFolderProperties } from "./folderProperties.ts";
import { namedEntryPath } from "./rootedFiles.ts";
import { readSiteManifest } from "./sites.ts";
import { walkSpace } from "./spaceWalk.ts";
import { readStructure } from "./structure.ts";

// Flows and applets are out because their panes have no reading view.
const LIBRARY_KINDS = new Set<FileKind>(["note", "screenplay", "table", "class", "image", "video", "pdf", "lut"]);

/** What a library tree lists, which is narrower than what a space tree
 * does: only kinds whose pane can render the document non-editably, since a
 * read-only library can't host a pane that autosaves. */
export function isLibraryVisibleFile(name: string): boolean {
  const kind = fileKindForPath(name);
  return !isHiddenName(name) && kind !== undefined && LIBRARY_KINDS.has(kind);
}

export function isTreeVisibleFile(name: string): boolean {
  return !isHiddenName(name) && hasKnownKind(name);
}

export interface ListingOptions {
  /** Every file but a dotfile, not only those Pragma opens: Settings →
   * Files, "Show all file types". A space listing only. */
  allFileTypes?: boolean;
}

/** How the space lists its files by the install's config, read per call so
 * a change in Settings shows on the next read. */
export function spaceListing(): ListingOptions {
  return { allFileTypes: showsAllFileTypes(loadGlobalConfig()) };
}

/** What a space listing shows, by the setting above. */
export function isSpaceListedFile(name: string, { allFileTypes = false }: ListingOptions = {}): boolean {
  if (!allFileTypes) return isTreeVisibleFile(name);
  return !isHiddenName(name);
}

function fileTest(treeRoot: TreeRoot, listing: ListingOptions): (name: string) => boolean {
  return treeRoot === "library" ? isLibraryVisibleFile : (name) => isSpaceListedFile(name, listing);
}

/** Resolves a client-supplied relative path against the space root, rejecting
 * anything that escapes it (`..` traversal, absolute paths). Shared by every
 * space-touching surface — the HTTP API, the embedded copilot's tools, and
 * (eventually) the MCP server — so this boundary is enforced exactly once. */

/** Which root is being walked. A library is not a space, so none of the
 * space's own machinery applies to it — no `_structure.json` or
 * `_properties.json` ordering, no site manifests — regardless of
 * whether it ever becomes writable. That is a separate question from
 * permission, which only governs writing. */
export type TreeRoot = "space" | "library";

/** `keepEmpty` keeps a library folder that lists nothing. Set for a writable
 * library: a folder just made through its tree would otherwise vanish on the
 * re-read, before anything could go in it. A space walk keeps them always.
 *
 * `depth` stops the walk that many levels down: a folder at the limit comes
 * back with no `children` at all, which is what tells a reader it was not
 * listed rather than listed empty. Kept even where `keepEmpty` would prune
 * it, since knowing it is empty would mean walking it. */
export async function buildTree(
  dir: string,
  root: string,
  treeRoot: TreeRoot = "space",
  {
    keepEmpty = false,
    depth = Number.POSITIVE_INFINITY,
    ...listing
  }: { keepEmpty?: boolean; depth?: number } & ListingOptions = {},
): Promise<SpaceTreeNode[]> {
  const isVisible = fileTest(treeRoot, listing);
  // The folders a scope's World setting names. A scope names only a folder
  // inside it, so its own walk adds one before any row under it is drawn.
  const worlds = new Set<string>();

  // `properties` is `dir`'s own `_properties.json`, read once by the caller,
  // which also needs its sort.
  //
  // Siblings are read in parallel: on a slow mount (a Windows drive under
  // WSL) every readdir is a round trip, and a serial walk pays them all in
  // a row. The sort below restores order, so the parallel map can't leak it.
  async function walk(dir: string, properties: Record<string, unknown>, level: number): Promise<SpaceTreeNode[]> {
    const entries = await readdir(dir, { withFileTypes: true });
    const place = {
      atRoot: path.relative(root, dir) === "",
      inSite: entries.some((entry) => entry.isFile() && isNamed(entry.name, SITE_FILENAME)),
    };
    const agents = treeRoot === "space" && entries.find((entry) => entry.isFile() && isAgentsFile(entry.name));
    if (agents) {
      const scope = path.relative(root, dir).split(path.sep).join("/");
      const world = settingValue(documentIndex().frontmatter(path.join(dir, agents.name)).pragma, WORLD_SETTING);
      const folder = typeof world === "string" ? settingFolder(scope, world) : undefined;
      if (folder !== undefined) worlds.add(folder);
    }

    const listed = await Promise.all(
      entries.map(async (entry): Promise<SpaceTreeNode | undefined> => {
        // Dotfiles (.git/, .trash/, etc.) never reach the tree.
        //
        // Nor does a link: the resolver refuses every path through one, so a
        // listed link would be a row that never opens.
        if (isHiddenName(entry.name) || entry.isSymbolicLink()) return undefined;

        const absolute = path.join(dir, entry.name);
        const relative = path.relative(root, absolute).split(path.sep).join("/");

        if (entry.isDirectory()) {
          const world = worlds.has(relative) ? { world: true } : {};
          if (level + 1 >= depth) return { name: entry.name, path: relative, type: "directory", ...world };

          if (treeRoot === "library") {
            const children = await walk(absolute, {}, level + 1);
            // Pruned in a read-only library: nothing can be created there, so a
            // folder that came back empty holds only kinds this phase doesn't
            // list, and saying so by omission beats a row that opens onto nothing.
            return keepEmpty || children.length > 0
              ? { name: entry.name, path: relative, type: "directory", children }
              : undefined;
          }

          // Empty directories still need to show up — otherwise a folder created
          // via the tree's "New Folder" action would vanish immediately, before
          // anyone had a chance to create a file inside it.
          const folderProperties = readFolderProperties(absolute);
          const children = await walk(absolute, folderProperties, level + 1);
          const sort = parseFolderSort(folderProperties.sort);
          const sortable = sort === undefined && readStructure(absolute) !== null;
          const site = readSiteManifest(absolute);
          return {
            name: entry.name,
            path: relative,
            type: "directory",
            children,
            sortable,
            ...(sort ? { sort } : {}),
            ...(site ? { site } : {}),
            ...world,
          };
        }

        if (!isVisible(entry.name)) return undefined;
        const scope = treeRoot === "space" && opensScope(entry.name, () => documentIndex().frontmatter(absolute));
        const role = treeRoot === "space" ? pragmaFileRole(entry.name, place) : undefined;
        return {
          name: entry.name,
          path: relative,
          type: "file",
          ...(scope ? { opensScope: true } : {}),
          ...(role ? { pragmaFile: role } : {}),
        };
      }),
    );
    const nodes = listed.filter((node): node is SpaceTreeNode => node !== undefined);

    nodes.sort(compareEntryNames);

    if (treeRoot === "library") return nodes;

    const statsOf = (node: SpaceTreeNode) => stat(path.join(dir, node.name)).catch(() => undefined);
    const { ordered, manifest } = await orderByFolder(dir, nodes, properties, statsOf);
    if (!manifest) return ordered;

    return ordered.map((node) => {
      const description = entryDescription(dir, node.name, node.type);
      return description ? { ...node, description } : node;
    });
  }

  return walk(dir, treeRoot === "space" ? readFolderProperties(dir) : {}, 0);
}

/** Every file and folder under `rootDir`, by the walk the tree takes but
 * with nothing left out for its kind: what a written path is read against.
 * A space's scopes come with it, read from each AGENTS.md's frontmatter. */
export async function listRootPaths(rootDir: string, treeRoot: TreeRoot): Promise<RootPathsResponse> {
  const { files, folders } = await walkSpace(rootDir, "fail");
  const scopes: string[] = [];
  const settings: Record<string, Record<string, unknown>> = {};
  for (const file of treeRoot === "space" ? files : []) {
    if (!isAgentsFile(file)) continue;
    const frontmatter = documentIndex().frontmatter(path.join(rootDir, ...file.split("/")));
    if (!Object.hasOwn(frontmatter, "pragma")) continue;
    // The space is a scope whatever its own AGENTS.md says, so only its
    // settings are listed, never its folder.
    const folder = dirnameOf(file);
    if (folder !== "") scopes.push(folder);
    if (isSettingsBlock(frontmatter.pragma)) settings[folder] = frontmatter.pragma;
  }
  const listed = { files: files.sort(), folders: folders.sort(), scopes: scopes.sort() };
  return treeRoot === "space" ? { ...listed, settings } : listed;
}

/** The folders a scope opens over in the space, asked one folder at a time:
 * an answer reads that folder's names and its AGENTS.md's frontmatter,
 * cached, so a path the server writes costs a few reads, never a walk of the
 * space. */
export function scopesOnDisk(spaceRoot: string): ScopeFolders {
  return {
    has(folder) {
      const dir = path.join(spaceRoot, ...folder.split("/"));
      let entries: Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return false;
      }
      return entries.some(
        (entry) =>
          entry.isFile() && opensScope(entry.name, () => documentIndex().frontmatter(path.join(dir, entry.name))),
      );
    },
  };
}

export interface FolderListingEntry {
  name: string;
  type: "file" | "directory";
  stats: Stats;
}

/** One folder's own entries, by the same visibility the tree applies, each
 * with what the filesystem says of it — directories first, then by name.
 *
 * A library folder that lists nothing is kept, unlike in the library tree:
 * knowing it would mean walking everything under it, on the folder a large
 * library is browsed through. An entry gone by the time it is read is left
 * out, not reported. */
export async function listFolder(
  dir: string,
  treeRoot: TreeRoot,
  listing: ListingOptions = {},
): Promise<FolderListingEntry[]> {
  const isVisible = fileTest(treeRoot, listing);
  const dirents = await readdir(dir, { withFileTypes: true });
  const listed = await Promise.all(
    dirents
      .filter((entry) => !isHiddenName(entry.name) && !entry.isSymbolicLink())
      .filter((entry) => entry.isDirectory() || (entry.isFile() && isVisible(entry.name)))
      .map(async (entry): Promise<FolderListingEntry | undefined> => {
        try {
          const stats = await stat(path.join(dir, entry.name));
          return { name: entry.name, type: entry.isDirectory() ? "directory" : "file", stats };
        } catch {
          return undefined;
        }
      }),
  );
  return listed.filter((entry): entry is FolderListingEntry => entry !== undefined).sort(compareEntryNames);
}

/** Whether a file is marked `visibility: private` (see docs/architecture.md's
 * Privacy section): a note in its frontmatter, a Table, Flow or
 * Class in its metadata block. Anything else is never private.
 *
 * Best-effort: an unreadable file reads as not-private rather than throwing,
 * since this filters what a remote-model-facing listing shows, not a
 * security boundary a missing file should be able to break. A file it does
 * read whose block doesn't parse is private: nothing can show it isn't. */

export async function isPrivateFile(absolutePath: string): Promise<boolean> {
  if (!isMarkdownFile(absolutePath) && !hasMetadataBlock(absolutePath)) return false;
  let content: string;
  try {
    content = await readFile(absolutePath, "utf8");
  } catch {
    return false;
  }
  return isPrivateContent(absolutePath, content);
}

/** Strips `visibility: private` files out of an already-built tree — used
 * only by surfaces that hand the tree to a model (the copilot's
 * list_space_files, the agent API). The space tree UI shows everything
 * unfiltered: `private` hides content from a remote model, not from the
 * writer who owns the space.
 *
 * Directories are kept even once every child inside them turns out private,
 * so a private note doesn't also erase its parent folder from what the model
 * sees exists. */

export async function filterPrivateNodes(spaceRoot: string, nodes: SpaceTreeNode[]): Promise<SpaceTreeNode[]> {
  const result: SpaceTreeNode[] = [];
  for (const node of nodes) {
    if (node.type === "directory") {
      const children = node.children ? await filterPrivateNodes(spaceRoot, node.children) : undefined;
      // A folder's description is its README's, so a private README keeps it.
      const { description, ...rest } = node;
      const readme = namedEntryPath(path.join(spaceRoot, node.path), "README.md");
      const hidden = description !== undefined && (await isPrivateFile(readme));
      result.push({ ...(hidden ? rest : node), children });
      continue;
    }
    if (await isPrivateFile(path.join(spaceRoot, node.path))) continue;
    result.push(node);
  }
  return result;
}

export interface SpaceSearchMatch {
  path: string;
  line: number;
  text: string;
}

const MAX_SEARCH_MATCHES = 50;

// Deliberately narrower than the tree's own visibility, which includes
// images: a substring scan reads every returned path as utf8 text (below),
// which would just decode binary image bytes into garbage. So this stays
// scoped to genuinely text files rather than "whatever the tree shows."
const SEARCHED_KINDS = new Set<FileKind>(["note", "screenplay", "table", "class", "flow", "applet"]);

function flattenFilePaths(nodes: SpaceTreeNode[]): string[] {
  const paths: string[] = [];
  for (const node of nodes) {
    const kind = node.type === "file" ? fileKindForPath(node.path) : undefined;
    if (kind !== undefined && SEARCHED_KINDS.has(kind)) paths.push(node.path);
    else if (node.children) paths.push(...flattenFilePaths(node.children));
  }
  return paths;
}

/** Every text file the space tree shows, space-relative, in tree order —
 * what both searches walk — under the folder `dir` when given. */
export async function searchableFiles(spaceRoot: string, dir = ""): Promise<string[]> {
  return flattenFilePaths(await buildTree(path.join(spaceRoot, ...dir.split("/")), spaceRoot));
}

/** Plain in-process, case-insensitive substring scan across every text file
 * the space tree shows, under `dir` when given — no `rg` dependency, fine at
 * personal-space scale. The agent tools' search: private documents skipped,
 * raw lines, first 50 matches. */
export async function searchSpaceFiles(spaceRoot: string, query: string, dir = ""): Promise<SpaceSearchMatch[]> {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];

  const matches: SpaceSearchMatch[] = [];

  for (const relativePath of await searchableFiles(spaceRoot, dir)) {
    if (matches.length >= MAX_SEARCH_MATCHES) break;

    const content = await readFile(path.join(spaceRoot, relativePath), "utf8");
    if (isPrivateContent(relativePath, content)) continue;
    const lines = content.split("\n");
    for (let i = 0; i < lines.length && matches.length < MAX_SEARCH_MATCHES; i++) {
      if (lines[i].toLowerCase().includes(needle)) {
        matches.push({ path: relativePath, line: i + 1, text: lines[i].trim() });
      }
    }
  }

  return matches;
}
