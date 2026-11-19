import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { Context, Hono } from "hono";
import {
  findSpaceId,
  loadGlobalConfig,
  type PragmaGlobalConfig,
  rememberKnownSpace,
  saveGlobalConfig,
  showsAllFileTypes,
} from "../../config/loadConfig.ts";
import type {
  ClassRowsResponse,
  FileTypeSettings,
  FlowAppModeRequestBody,
  FolderEntry,
  FolderLayoutRequestBody,
  FolderListingResponse,
  LayoutGroup,
  LayoutRequestBody,
  LayoutResponse,
  LayoutTab,
  LibraryAccessRequestBody,
  LibraryDescriptionRequestBody,
  LibraryLabelRequestBody,
  LocalSortRequestBody,
  RootPathsResponse,
  SpaceChangesResponse,
  SpaceIdRequestBody,
  SpaceInfoResponse,
  SpaceLabelRequestBody,
  SpaceLibrariesResponse,
  SpaceListResponse,
  SpaceRef,
  SpaceSearchResponse,
  SpaceSiteEntry,
  SpaceTrustRequestBody,
  SwitchSpaceRequestBody,
  TableLayoutRequestBody,
} from "../../protocol/api.ts";
import { CHANGES_HEADER, readTabPlace, readTabViewport } from "../../protocol/api.ts";
import { parseFlowFile } from "../../protocol/flowFile.ts";
import { parseSortChoice } from "../../protocol/folderSort.ts";
import { isHiddenPath } from "../../protocol/relativeReference.ts";
import { formatRootedPath } from "../../protocol/rootedPath.ts";
import { parseTableFile } from "../../protocol/tableFile.ts";
import { isFlowFile, isTableFile, isTableLayout, thumbnailKindForPath } from "../../protocol/types.ts";
import { classRows, folderRows, scopeFolderOf } from "../classRows.ts";
import { entryDescription, entryExcerpt } from "../descriptions.ts";
import { clearSpaceGrants } from "../grants.ts";
import { noticeRevision } from "../history.ts";
import {
  type FolderState,
  readFolderState,
  readLayoutGroups,
  readLocalSorts,
  writeFolderState,
  writeLayoutGroups,
} from "../layout.ts";
import { isAccess, libraryRows, readLibraries } from "../libraries.ts";
import { folderSortState, saveFlowAppMode, saveFolderLayout, saveLocalSort, saveTableLayout } from "../localSorts.ts";
import { formatWithinRoot, isSpaceTarget, PathAccessError, resolveRootedPath } from "../rootedFiles.ts";
import { listSites } from "../sites.ts";
import { currentRevision } from "../spaceFiles.ts";
import {
  describeSpaceLibrary,
  LibrariesFileError,
  relabelSpaceLibrary,
  removeSpaceLibrary,
  setSpaceLibraryAccess,
  spaceLibrary,
  UnknownLibraryError,
} from "../spaceLibraries.ts";
import { registeredSpaces, spaceRef } from "../spaceList.ts";
import { searchSpaceContent } from "../spaceSearch.ts";
import { fileVersion } from "../thumbnailStore.ts";
import { buildTree, listRootPaths, spaceListing } from "../tree.ts";
import type { Incoming, RouteContext } from "./shared.ts";

const MAX_UI_SEARCH_MATCHES = 1000;

// Null tells the client the file is gone, and it empties the file's tabs. A
// file whose root is missing (a library's drive unmounted), or that can't be
// read, is left out instead: nothing is known about it.
async function fileRevisions(spaceRoot: string, paths: readonly string[]): Promise<Record<string, string | null>> {
  const revisions: Record<string, string | null> = {};
  await Promise.all(
    paths.map(async (input) => {
      try {
        const { filePath, rootDir } = resolveRootedPath(spaceRoot, input, "read");
        const revision = await currentRevision(filePath);
        if (revision !== undefined) revisions[input] = revision;
        else if (existsSync(rootDir)) revisions[input] = null;
        // A followed file past every text this server last knew of it was
        // changed outside Pragma, and the text it replaced is kept.
        if (input in revisions) noticeRevision(spaceRoot, filePath, revisions[input]);
      } catch {
        // see above
      }
    }),
  );
  return revisions;
}

export function mountSpaceRoutes(
  app: Hono,
  { spaceRoot, spaceSwitcher, ownMachine, thumbnails, changes }: RouteContext,
): void {
  // A target serving other devices serves one space (docs/architecture.md's
  // Runtime and hosting section), so the rest of the registry is unknown to
  // it: no route here lists, switches to or changes another space, the
  // desktop app's among them when the service shares that account. A lookup
  // rather than a filtered config: these routes save the config they read.
  const knownSpace = (config: PragmaGlobalConfig, id: string | undefined) =>
    id !== undefined && (ownMachine || id === findSpaceId(config, spaceRoot)) ? config.spaces?.[id] : undefined;

  app.all("/api/space/info", (c) => {
    const config = loadGlobalConfig();
    const id = findSpaceId(config, spaceRoot);
    return c.json<SpaceInfoResponse>({
      name: path.basename(spaceRoot),
      label: id ? config.spaces?.[id]?.label : undefined,
      path: spaceRoot,
    });
  });

  // Every registered space (Manage Spaces) and the capped recents (the
  // switcher) in one read, so the two agree about which space is open.
  // `current` comes from the live spaceRoot, not config, which may be stale.
  app.all("/api/space/list", (c) => {
    const config = loadGlobalConfig();
    const spaces = config.spaces ?? {};
    const isRef = (ref: SpaceRef | undefined): ref is SpaceRef => ref !== undefined;
    const currentId = findSpaceId(config, spaceRoot);
    return c.json<SpaceListResponse>({
      current: {
        id: currentId,
        path: spaceRoot,
        name: path.basename(spaceRoot),
        label: currentId ? spaces[currentId]?.label : undefined,
        trusted: currentId ? spaces[currentId]?.trusted : undefined,
      },
      spaces: registeredSpaces(config).filter((ref) => knownSpace(config, ref.id)),
      recent: (config.recentSpaceIds ?? [])
        .filter((id) => knownSpace(config, id))
        .map((id) => spaceRef(config, id))
        .filter(isRef),
    });
  });

  // Switches the live space, only ever to a registered path, never an
  // arbitrary one a request names. A target serving other devices refuses
  // outright, since it serves one space.
  app.all("/api/space/switch", async (c) => {
    if (c.req.method !== "POST") return c.body(null, 405);
    if (!spaceSwitcher || !ownMachine) return c.text("Space switching is not available in this mode", 501);

    try {
      const body = (await c.req.json()) as SwitchSpaceRequestBody;

      // Validated against the permanent registry, not the capped recents: a
      // space that aged off recents is still known, and narrowing this would
      // break switching to it — with "loosen the guard" as the tempting fix.
      // See docs/architecture.md's Space identity and state ownership section.
      //
      // The registry call *is* the guard: it refuses to register a path it
      // doesn't already know, so this route cannot mint an id for whatever a
      // request names.
      const registered = rememberKnownSpace(loadGlobalConfig(), body.path);
      if (!registered) return c.text("Not a known space", 400);

      saveGlobalConfig(registered);
      const response = c.body(null, 204);
      spaceSwitcher.switchTo(body.path);
      return response;
    } catch (error) {
      return c.text(error instanceof Error ? error.message : "Internal error", 500);
    }
  });

  // Renames a space's display label. Never touches its id — approvals are
  // keyed by that, so a rename must not orphan them. Safe on every target:
  // this takes an id already in the registry and a string, never a path.
  app.all("/api/space/label", async (c) => {
    if (c.req.method !== "POST") return c.body(null, 405);

    try {
      const body = (await c.req.json()) as SpaceLabelRequestBody;
      const config = loadGlobalConfig();
      const record = knownSpace(config, body.id);
      if (!record) return c.text("Not a known space", 400);

      const label = body.label.trim();
      saveGlobalConfig({
        ...config,
        // An empty label clears it, falling back to the folder name, rather
        // than storing "" as a name nothing would render.
        spaces: { ...config.spaces, [body.id]: { ...record, label: label || undefined } },
      });
      return c.body(null, 204);
    } catch (error) {
      return c.text(error instanceof Error ? error.message : "Internal error", 500);
    }
  });

  // Records whether git may run in a space. Takes an id and a boolean, never
  // a path, so it is safe on every target as /api/space/label is. Declining
  // is recorded too, so the person is asked once rather than on every open.
  app.all("/api/space/trust", async (c) => {
    if (c.req.method !== "POST") return c.body(null, 405);

    try {
      const body = (await c.req.json()) as Incoming<SpaceTrustRequestBody>;
      if (typeof body.id !== "string" || typeof body.trusted !== "boolean") {
        return c.text("Expected a space id and a boolean", 400);
      }
      const config = loadGlobalConfig();
      const record = knownSpace(config, body.id);
      if (!record) return c.text("Not a known space", 400);

      saveGlobalConfig({ ...config, spaces: { ...config.spaces, [body.id]: { ...record, trusted: body.trusted } } });
      return c.body(null, 204);
    } catch (error) {
      return c.text(error instanceof Error ? error.message : "Internal error", 500);
    }
  });

  // Clears every approval recorded for a space. The only way to revoke a
  // whole space's grants at once, and possible at all because grants are
  // keyed by space id — see docs/architecture.md's Space identity and state ownership section.
  app.all("/api/space/grants/reset", async (c) => {
    if (c.req.method !== "POST") return c.body(null, 405);

    try {
      const body = (await c.req.json()) as SpaceIdRequestBody;
      if (!knownSpace(loadGlobalConfig(), body.id)) return c.text("Not a known space", 400);
      await clearSpaceGrants(body.id);
      return c.body(null, 204);
    } catch (error) {
      return c.text(error instanceof Error ? error.message : "Internal error", 500);
    }
  });

  // Drops a space from the registry. Never touches the folder — only what
  // pragma remembers about it. Its approvals go too: re-adding the same
  // folder later mints a *new* id, so grants left behind would be
  // unreachable forever rather than waiting to be reused.
  //
  // Refuses the space being served, which would leave this process serving
  // something the registry no longer knows, and its grants unwritable.
  app.all("/api/space/forget", async (c) => {
    if (c.req.method !== "POST") return c.body(null, 405);

    try {
      const body = (await c.req.json()) as SpaceIdRequestBody;
      const config = loadGlobalConfig();
      if (!knownSpace(config, body.id)) return c.text("Not a known space", 400);
      if (body.id === findSpaceId(config, spaceRoot)) return c.text("Cannot forget the current space", 400);

      const spaces = { ...config.spaces };
      delete spaces[body.id];
      saveGlobalConfig({
        ...config,
        spaces,
        recentSpaceIds: (config.recentSpaceIds ?? []).filter((entry) => entry !== body.id),
      });
      await clearSpaceGrants(body.id);
      return c.body(null, 204);
    } catch (error) {
      return c.text(error instanceof Error ? error.message : "Internal error", 500);
    }
  });

  // Install-global, not per space, like the trash setting: every browser on
  // the host lists the same files, and so does the copilot.
  app.all("/api/file-type-settings", async (c) => {
    if (c.req.method === "GET") {
      return c.json<FileTypeSettings>({ showAllFileTypes: showsAllFileTypes(loadGlobalConfig()) });
    }
    if (c.req.method !== "POST") return c.body(null, 405);
    try {
      const { showAllFileTypes } = (await c.req.json()) as Partial<FileTypeSettings>;
      if (typeof showAllFileTypes !== "boolean") return c.text("showAllFileTypes must be true or false", 400);
      saveGlobalConfig({ ...loadGlobalConfig(), showAllFileTypes: showAllFileTypes ? true : undefined });
      return c.body(null, 204);
    } catch (error) {
      return c.text(error instanceof Error ? error.message : "Internal error", 500);
    }
  });

  // Each folder in its own order. A sort picked on this install is its
  // gallery's alone: the tree follows it once Set as default makes it the
  // folder's own.
  app.all("/api/space/tree", async (c) => {
    try {
      c.header(CHANGES_HEADER, changes.version(spaceRoot));
      return c.json(await buildTree(spaceRoot, spaceRoot, "space", spaceListing()));
    } catch (error) {
      return c.text(error instanceof Error ? error.message : "Internal error", 500);
    }
  });

  app.all("/api/space/paths", async (c) => {
    if (c.req.method !== "GET") return c.body(null, 405);
    try {
      c.header(CHANGES_HEADER, changes.version(spaceRoot));
      return c.json<RootPathsResponse>(await listRootPaths(spaceRoot, "space"));
    } catch (error) {
      return c.text(error instanceof Error ? error.message : "Internal error", 500);
    }
  });

  app.all("/api/space/search", async (c) => {
    try {
      const response = await searchSpaceContent(spaceRoot, c.req.query("q") ?? "", {
        dir: c.req.query("dir") || undefined,
        maxMatches: MAX_UI_SEARCH_MATCHES,
      });
      return c.json<SpaceSearchResponse>(response);
    } catch (error) {
      return c.text(error instanceof Error ? error.message : "Internal error", 500);
    }
  });

  app.all("/api/space/sites", async (c) => {
    if (c.req.method !== "GET") return c.body(null, 405);
    try {
      const sites = await listSites(spaceRoot, spaceRoot);
      return c.json<SpaceSiteEntry[]>(sites);
    } catch (error) {
      return c.text(error instanceof Error ? error.message : "Internal error", 500);
    }
  });

  // The Libraries panel's list. No route here adds or locates a library:
  // both name a filesystem path, which the remote-access target must never
  // accept (docs/architecture.md's Document writes and reference integrity).
  app.all("/api/space/libraries", (c) => {
    // Explicitly GET-only, unlike the read-only routes above it that leave
    // app.all unguarded: a write arriving at the listing has to be refused
    // outright rather than silently answered with it.
    if (c.req.method !== "GET") return c.body(null, 405);

    try {
      // An unreachable root is a state, not an error: the row still lists,
      // so its ⋮ menu and Locate stay reachable.
      return c.json<SpaceLibrariesResponse>(libraryRows(spaceRoot));
    } catch (error) {
      return c.text(error instanceof Error ? error.message : "Internal error", 500);
    }
  });

  // One library's tree. `:id` is looked up among the space's libraries
  // rather than taking a path, so this only walks a root a person located.
  // Read-only: a write into a library goes through the rooted resolver like
  // every other write, and is refused there unless the entry is read-write.
  //
  // `dir` walks from one of its folders instead, its paths still relative
  // to the library's root: with `depth=1`, one folder's own entries, which
  // is how the Libraries panel lists a library a folder at a time.
  app.all("/api/space/libraries/:id/tree", async (c) => {
    if (c.req.method !== "GET") return c.body(null, 405);

    try {
      const id = c.req.param("id");
      const library = readLibraries(spaceRoot).find((entry) => entry.id === id);
      if (!library) return c.text("Unknown library", 404);
      const rawDepth = c.req.query("depth");
      const depth = rawDepth === undefined ? Number.POSITIVE_INFINITY : Number(rawDepth);
      if (!Number.isInteger(depth) && depth !== Number.POSITIVE_INFINITY) return c.text("Invalid depth", 400);
      if (depth < 1) return c.text("Invalid depth", 400);
      const dir = c.req.query("dir") ?? "";
      // The tree never lists a dot entry, so it never walks into one.
      if (isHiddenPath(dir)) return c.text("Not a listed folder", 404);
      const folder =
        dir === ""
          ? library.path
          : resolveRootedPath(spaceRoot, formatRootedPath({ root: { library: id }, path: dir }), "read").filePath;
      c.header(CHANGES_HEADER, changes.version(library.path));
      const keepEmpty = library.access === "read-write";
      // By name: a library keeps no order, and a sort picked here is its
      // gallery's alone.
      return c.json(await buildTree(folder, library.path, "library", { keepEmpty, depth }));
    } catch (error) {
      if (error instanceof PathAccessError) return c.text(error.message, error.status);
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return c.text("Not found", 404);
      if (code === "ENOTDIR") return c.text("Not a folder", 400);
      return c.text(error instanceof Error ? error.message : "Internal error", 500);
    }
  });

  app.all("/api/space/libraries/:id/paths", async (c) => {
    if (c.req.method !== "GET") return c.body(null, 405);
    try {
      const library = readLibraries(spaceRoot).find((entry) => entry.id === c.req.param("id"));
      if (!library) return c.text("Unknown library", 404);
      c.header(CHANGES_HEADER, changes.version(library.path));
      return c.json<RootPathsResponse>(await listRootPaths(library.path, "library"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return c.text("Not found", 404);
      return c.text(error instanceof Error ? error.message : "Internal error", 500);
    }
  });

  // Each tree's version (changeFeeds.ts): the space's always, a library's
  // when one is named. Asking is what keeps a tree followed, so a client
  // asks on a short interval while it is in view.
  app.all("/api/space/changes", async (c) => {
    if (c.req.method !== "GET") return c.body(null, 405);

    try {
      const response: SpaceChangesResponse = { space: changes.version(spaceRoot) };
      const id = c.req.query("library");
      if (id !== undefined) {
        const library = readLibraries(spaceRoot).find((entry) => entry.id === id);
        if (!library) return c.text("Unknown library", 404);
        response.library = changes.version(library.path);
      }
      const files = c.req.queries("file");
      if (files) response.files = await fileRevisions(spaceRoot, files);
      return c.json(response);
    } catch (error) {
      return c.text(error instanceof Error ? error.message : "Internal error", 500);
    }
  });

  // A Class's rows, for its view: a read, in any root. With `dir` instead,
  // that folder's own rows, for a Class made there to take its fields from.
  app.all("/api/space/class", async (c) => {
    if (c.req.method !== "GET") return c.body(null, 405);

    try {
      const dir = c.req.query("dir");
      if (dir !== undefined) {
        const folder = resolveRootedPath(spaceRoot, dir, "read");
        if (!(await stat(folder.filePath)).isDirectory()) return c.text("Not a folder", 400);
        const own = formatRootedPath(folder.rooted);
        const rows = await folderRows(spaceRoot, [{ folder: own, subfolders: false }], scopeFolderOf(spaceRoot, own));
        return c.json<ClassRowsResponse>({ rows });
      }
      const target = c.req.query("path");
      if (target === undefined) return c.text("Missing path query parameter", 400);
      return c.json<ClassRowsResponse>({ rows: await classRows(spaceRoot, target) });
    } catch (error) {
      if (error instanceof PathAccessError) return c.text(error.message, error.status);
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return c.text("Not found", 404);
      return c.text(error instanceof Error ? error.message : "Internal error", 500);
    }
  });

  // One folder's own entries, in the space or a library, for the gallery.
  // A read: a read-only library lists here the same as a writable one.
  app.all("/api/space/folder", async (c) => {
    if (c.req.method !== "GET") return c.body(null, 405);

    try {
      const target = c.req.query("path");
      if (target === undefined) return c.text("Missing path query parameter", 400);
      const resolved = resolveRootedPath(spaceRoot, target, "read");
      const treeRoot = isSpaceTarget(resolved) ? "space" : "library";
      const listing = treeRoot === "space" ? spaceListing() : {};
      const sorts = await readLocalSorts(spaceRoot);
      const stored = sorts[formatWithinRoot(resolved, resolved.filePath)];
      const state = await folderSortState(resolved.filePath, treeRoot, stored, listing);
      const cards = stored?.layout === "cards";
      const entries = await Promise.all(
        state.shown.map(async ({ name, type, stats }): Promise<FolderEntry> => {
          const file = path.join(resolved.filePath, name);
          const version = fileVersion(stats);
          const thumbnailed = type === "file" && thumbnailKindForPath(name) !== undefined;
          const facts = thumbnailed ? await thumbnails.facts({ root: resolved.rootDir, file, version }) : undefined;
          const description = cards ? entryDescription(resolved.filePath, name, type) : undefined;
          const excerpt = cards && !description ? entryExcerpt(resolved.filePath, name, type) : undefined;
          const listed = facts && {
            width: facts.width,
            height: facts.height,
            ...(facts.duration === undefined ? {} : { duration: facts.duration }),
            ...(facts.clip ? { clip: facts.clip } : {}),
            ...(facts.picture ? { picture: facts.picture } : {}),
          };
          return {
            name,
            path: formatWithinRoot(resolved, file),
            type,
            size: type === "file" ? stats.size : 0,
            modified: stats.mtime.toISOString(),
            version,
            thumbnail: facts !== undefined && facts.thumbnail !== false,
            ...listed,
            ...(description ? { description } : {}),
            ...(excerpt ? { excerpt } : {}),
          };
        }),
      );
      const order = { default: state.fallback, ...(state.local ? { local: state.local } : {}) };
      return c.json<FolderListingResponse>({ entries, order, ...(cards ? { layout: "cards" } : {}) });
    } catch (error) {
      if (error instanceof PathAccessError) return c.text(error.message, error.status);
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return c.text("Not found", 404);
      if (code === "ENOTDIR") return c.text("Not a folder", 400);
      return c.text(error instanceof Error ? error.message : "Internal error", 500);
    }
  });

  // A refusal from the space's libraries, as the status that says why.
  const libraryRefusal = (c: Context, error: unknown) => {
    const message = error instanceof Error ? error.message : "Internal error";
    if (error instanceof UnknownLibraryError) return c.text(message, 404);
    if (error instanceof LibrariesFileError) return c.text(message, 409);
    return c.text(message, 500);
  };

  // Sets one library's access. Takes an id the space declares and one of
  // two words, never a path, so it is safe on every target — the footing
  // /api/space/label stands on. Widening is a person's choice per library:
  // locating one records read-only, and nothing derives read-write from the
  // folder.
  app.all("/api/space/libraries/:id/access", async (c) => {
    if (c.req.method !== "POST") return c.body(null, 405);

    try {
      const id = c.req.param("id");
      const row = spaceLibrary(spaceRoot, id);
      const body = (await c.req.json()) as Incoming<LibraryAccessRequestBody>;
      if (!isAccess(body.access)) return c.text("Not a library access", 400);
      if (row.path === undefined) return c.text("Locate this library on this computer first", 409);
      setSpaceLibraryAccess(spaceRoot, id, body.access);
      return c.body(null, 204);
    } catch (error) {
      return libraryRefusal(c, error);
    }
  });

  // Renames a library for display, in the space's `_libraries.json`. An id
  // and a string, never a path, so it is safe on every target as
  // /api/space/label is; the id every reference was written against stays,
  // and so does the folder.
  app.all("/api/space/libraries/:id/label", async (c) => {
    if (c.req.method !== "POST") return c.body(null, 405);

    try {
      const id = c.req.param("id");
      spaceLibrary(spaceRoot, id);
      const body = (await c.req.json()) as Incoming<LibraryLabelRequestBody>;
      if (typeof body.label !== "string") return c.text("Expected a label", 400);
      await relabelSpaceLibrary(spaceRoot, id, body.label);
      return c.body(null, 204);
    } catch (error) {
      return libraryRefusal(c, error);
    }
  });

  // Gives a library a description in the space's `_libraries.json`, or takes
  // it away when blank. An id and a string, never a path, as the label is.
  app.all("/api/space/libraries/:id/description", async (c) => {
    if (c.req.method !== "POST") return c.body(null, 405);

    try {
      const id = c.req.param("id");
      spaceLibrary(spaceRoot, id);
      const body = (await c.req.json()) as Incoming<LibraryDescriptionRequestBody>;
      if (typeof body.description !== "string") return c.text("Expected a description", 400);
      await describeSpaceLibrary(spaceRoot, id, body.description);
      return c.body(null, 204);
    } catch (error) {
      return libraryRefusal(c, error);
    }
  });

  // Takes a library out of the space. Never touches the folder — it is
  // someone's photo archive or a sibling repo, and pragma only ever read
  // from it. Every `lib:<id>/…` reference already written stops resolving,
  // which is what the panel's confirmation warns about.
  app.all("/api/space/libraries/:id", async (c) => {
    if (c.req.method !== "DELETE") return c.body(null, 405);

    try {
      await removeSpaceLibrary(spaceRoot, c.req.param("id"));
      return c.body(null, 204);
    } catch (error) {
      return libraryRefusal(c, error);
    }
  });

  const LAYOUT_TAB_KINDS = new Set([
    "document",
    "gallery",
    "image",
    "video",
    "pdf",
    "lut",
    "table",
    "class",
    "flow",
    "applet",
    "applet-source",
    "empty",
  ]);

  function isValidLayoutTab(entry: unknown): entry is LayoutTab {
    if (!entry || typeof entry !== "object") return false;
    const {
      kind,
      path: tabPath,
      place,
      viewport,
    } = entry as { kind?: unknown; path?: unknown; place?: unknown; viewport?: unknown };
    if (typeof kind !== "string" || !LAYOUT_TAB_KINDS.has(kind)) return false;
    if (place !== undefined && readTabPlace(place) === undefined) return false;
    if (viewport !== undefined && readTabViewport(viewport) === undefined) return false;
    if (kind === "empty") return tabPath === undefined;
    return typeof tabPath === "string";
  }

  function isValidLayoutGroup(entry: unknown): entry is LayoutGroup {
    if (!entry || typeof entry !== "object") return false;
    const { tabs, activeTabIndex, readingView, sourceMode } = entry as {
      tabs?: unknown;
      activeTabIndex?: unknown;
      readingView?: unknown;
      sourceMode?: unknown;
    };
    return (
      Array.isArray(tabs) &&
      tabs.every(isValidLayoutTab) &&
      typeof activeTabIndex === "number" &&
      (readingView === undefined || typeof readingView === "boolean") &&
      (sourceMode === undefined || typeof sourceMode === "boolean")
    );
  }

  app.all("/api/space/layout", async (c) => {
    if (c.req.method === "GET") {
      return c.json<LayoutResponse>({ ...(await readFolderState(spaceRoot)), ...(await readLayoutGroups(spaceRoot)) });
    }

    if (c.req.method !== "POST") return c.body(null, 405);

    try {
      const body = (await c.req.json()) as Incoming<LayoutRequestBody>;

      const folders: Partial<FolderState> = {};
      for (const key of ["collapsedFolders", "expandedFolders"] as const) {
        const value = body[key];
        if (value === undefined) continue;
        if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
          return c.text(`${key} must be an array of strings`, 400);
        }
        folders[key] = value;
      }
      if (Object.keys(folders).length > 0) await writeFolderState(spaceRoot, folders);

      if (body.groups !== undefined) {
        if (
          !Array.isArray(body.groups) ||
          !body.groups.every(isValidLayoutGroup) ||
          (body.focusedGroup !== undefined && typeof body.focusedGroup !== "number")
        ) {
          return c.text(
            "groups must be an array of {tabs, activeTabIndex, readingView?, sourceMode?}, each tab a {kind, path, place?}, readingView and sourceMode booleans, and focusedGroup a number",
            400,
          );
        }
        await writeLayoutGroups(spaceRoot, {
          groups: body.groups,
          focusedGroup: typeof body.focusedGroup === "number" ? body.focusedGroup : 0,
        });
      }

      return c.body(null, 204);
    } catch (error) {
      return c.text(error instanceof Error ? error.message : "Internal error", 500);
    }
  });

  // One folder's sort on this install, in the space or any library: host
  // state, so a read-only library takes one too, and nothing in the folder
  // changes.
  app.all("/api/space/local-sort", async (c) => {
    if (c.req.method !== "POST") return c.body(null, 405);

    try {
      const body = (await c.req.json()) as Incoming<LocalSortRequestBody>;
      const sort = body.sort === null ? undefined : parseSortChoice(body.sort);
      const arrangement =
        body.arrangement === undefined || body.arrangement === null
          ? body.arrangement
          : Array.isArray(body.arrangement) && body.arrangement.every((name) => typeof name === "string")
            ? (body.arrangement as string[])
            : false;
      if (typeof body.dir !== "string") return c.text("dir must be a folder path", 400);
      if (body.sort !== null && !sort) return c.text("sort must be null or a sort", 400);
      if (arrangement === false) return c.text("arrangement must be an array of names", 400);
      const resolved = resolveRootedPath(spaceRoot, body.dir, "read");
      if (!(await stat(resolved.filePath)).isDirectory()) return c.text("Not a folder", 400);
      const key = formatWithinRoot(resolved, resolved.filePath);
      const treeRoot = isSpaceTarget(resolved) ? "space" : "library";
      const listing = treeRoot === "space" ? spaceListing() : {};
      await saveLocalSort(spaceRoot, key, resolved.filePath, treeRoot, { sort, arrangement }, listing);
      return c.body(null, 204);
    } catch (error) {
      if (error instanceof PathAccessError) return c.text(error.message, error.status);
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return c.text("Not found", 404);
      return c.text(error instanceof Error ? error.message : "Internal error", 500);
    }
  });

  // How a gallery draws one folder on this install, kept beside its sort:
  // host state, so a read-only library's folder takes one too.
  app.all("/api/space/folder-layout", async (c) => {
    if (c.req.method !== "POST") return c.body(null, 405);

    try {
      const body = (await c.req.json()) as Incoming<FolderLayoutRequestBody>;
      if (typeof body.dir !== "string") return c.text("dir must be a folder path", 400);
      if (body.layout !== "tiles" && body.layout !== "cards") return c.text('layout must be "tiles" or "cards"', 400);
      const resolved = resolveRootedPath(spaceRoot, body.dir, "read");
      if (!(await stat(resolved.filePath)).isDirectory()) return c.text("Not a folder", 400);
      await saveFolderLayout(spaceRoot, formatWithinRoot(resolved, resolved.filePath), body.layout);
      return c.body(null, 204);
    } catch (error) {
      if (error instanceof PathAccessError) return c.text(error.message, error.status);
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return c.text("Not found", 404);
      return c.text(error instanceof Error ? error.message : "Internal error", 500);
    }
  });

  // How a Table draws its rows on this install, the same host state, so a
  // read-only library's Table takes one too. The file is read only for the
  // layout it names itself, which keeps nothing.
  app.all("/api/space/table-layout", async (c) => {
    if (c.req.method !== "POST") return c.body(null, 405);

    try {
      const body = (await c.req.json()) as Incoming<TableLayoutRequestBody>;
      if (typeof body.path !== "string" || !isTableFile(body.path)) return c.text("path must be a Table", 400);
      if (!isTableLayout(body.layout)) return c.text('layout must be "list" or "cards"', 400);
      const resolved = resolveRootedPath(spaceRoot, body.path, "read");
      if (!(await stat(resolved.filePath)).isFile()) return c.text("Not a Table", 400);
      const own = parseTableFile(await readFile(resolved.filePath, "utf8"))?.layout ?? "list";
      await saveTableLayout(spaceRoot, formatWithinRoot(resolved, resolved.filePath), body.layout, own);
      return c.body(null, 204);
    } catch (error) {
      if (error instanceof PathAccessError) return c.text(error.message, error.status);
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return c.text("Not found", 404);
      return c.text(error instanceof Error ? error.message : "Internal error", 500);
    }
  });

  // Whether a Flow shows App Mode on this install, the same host state, so a
  // read-only library's Flow takes one too. The file is read only for the
  // view it opens in itself, which keeps nothing.
  app.all("/api/space/flow-app-mode", async (c) => {
    if (c.req.method !== "POST") return c.body(null, 405);

    try {
      const body = (await c.req.json()) as Incoming<FlowAppModeRequestBody>;
      if (typeof body.path !== "string" || !isFlowFile(body.path)) return c.text("path must be a Flow", 400);
      if (typeof body.appMode !== "boolean") return c.text("appMode must be true or false", 400);
      const resolved = resolveRootedPath(spaceRoot, body.path, "read");
      if (!(await stat(resolved.filePath)).isFile()) return c.text("Not a Flow", 400);
      const own = parseFlowFile(await readFile(resolved.filePath, "utf8"))?.graph.appModeActive === true;
      await saveFlowAppMode(spaceRoot, formatWithinRoot(resolved, resolved.filePath), body.appMode, own);
      return c.body(null, 204);
    } catch (error) {
      if (error instanceof PathAccessError) return c.text(error.message, error.status);
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return c.text("Not found", 404);
      return c.text(error instanceof Error ? error.message : "Internal error", 500);
    }
  });
}
