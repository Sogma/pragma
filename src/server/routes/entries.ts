// One tree entry at a time. Every route writes, so each resolves its target
// through the rooted resolver, not the space's own — the one doorway that
// refuses a root not marked read-write (docs/architecture.md's Document
// writes and reference integrity section).
//
// Binder order, folder sorts, site queues, published copies and link
// rewriting are space bookkeeping a library has none of: the per-folder
// routes at the end refuse a library outright, and the rest skip that
// bookkeeping for one.
import { constants, createWriteStream, existsSync, readFileSync, statSync } from "node:fs";
import { copyFile, mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import type { Hono } from "hono";
import type {
  CreateEntryRequestBody,
  CreateEntryResponse,
  DeleteEntryRequestBody,
  DeleteEntryResponse,
  DuplicateEntryRequestBody,
  MoveEntryRequestBody,
  MoveEntryResponse,
  SetOrderRequestBody,
  SetSortRequestBody,
  SortKeysResponse,
  UploadEntryResponse,
} from "../../protocol/api.ts";
import { bookmarksAfterDelete, bookmarksAfterMove } from "../../protocol/bookmarks.ts";
import { illegalEntryNameReason, isHiddenName, sanitizeEntryName } from "../../protocol/entryName.ts";
import { parseSortChoice, toSortValue } from "../../protocol/folderSort.ts";
import { isPrivate, parseFrontmatter, withoutPublishState } from "../../protocol/frontmatter.ts";
import { presetsAfterDelete, presetsAfterMove } from "../../protocol/presets.ts";
import { deleteSogmaDocument } from "../../protocol/publisher.ts";
import { sameRoot } from "../../protocol/rootedPath.ts";
import { isMarkdownFile, rawFileTypeForPath } from "../../protocol/types.ts";
import { forgottenContexts, movedContexts } from "../contextMemory.ts";
import { documentIndex } from "../documentIndex.ts";
import { readFolderProperties, writeFolderProperties } from "../folderProperties.ts";
import { forgottenFrameFolders, movedFrameFolders } from "../frameFolders.ts";
import { moveHistory } from "../history.ts";
import {
  updateContextViews,
  updateFlowAppModes,
  updateFrameFolders,
  updateLocalSorts,
  updateTableLayouts,
} from "../layout.ts";
import {
  duplicatedLocalSorts,
  forgottenByPath,
  forgottenLocalSorts,
  movedByPath,
  movedLocalSorts,
} from "../localSorts.ts";
import { keepSpacePresets } from "../presets.ts";
import { requirePublisher } from "../publishers.ts";
import {
  formatWithinRoot,
  isSpaceTarget,
  namedEntryPath,
  PathAccessError,
  refuseLink,
  resolveRootedPath,
} from "../rootedFiles.ts";
import {
  addPendingEntry,
  forgetPendingPaths,
  movePendingPaths,
  queuePendingDeletes,
  removePendingEntry,
  resolveSiteForPath,
} from "../sites.ts";
import { keepSpaceBookmarks } from "../spaceBookmarks.ts";
import { findNameCollision, moveEntryToTrash, resolveWithinSpace, uniqueEntryName } from "../spaceFiles.ts";
import { type ReferenceRewriteResult, rewriteMovedReferences } from "../spaceReferences.ts";
import {
  duplicateStructureEntry,
  readStructure,
  removeStructureEntry,
  renameStructureEntry,
  writeStructure,
} from "../structure.ts";
import { isSpaceListedFile, isTreeVisibleFile, spaceListing } from "../tree.ts";
import type { Incoming, RouteContext } from "./shared.ts";

export function mountEntryRoutes(app: Hono, { spaceRoot }: RouteContext): void {
  // A root's own top level: the tree spells it "." and the path grammar
  // spells it "", which is the one place the two have to be reconciled —
  // "." is a traversal segment the parser refuses by design.
  const atRoot = (value: string | undefined): string => (value && value !== "." ? value : "");

  // A posted order must be exactly the directory's current tree-visible
  // entries, by the tree's own inclusion rule — otherwise a stale client
  // could silently drop or invent an entry.
  const isCurrentOrder = async (dirPath: string, order: unknown): Promise<boolean> => {
    if (!Array.isArray(order)) return false;
    const entries = await readdir(dirPath, { withFileTypes: true });
    const listing = spaceListing();
    const currentNames = new Set(
      entries
        .filter(
          (entry) =>
            !isHiddenName(entry.name) &&
            !entry.isSymbolicLink() &&
            (entry.isDirectory() || isSpaceListedFile(entry.name, listing)),
        )
        .map((entry) => entry.name),
    );
    return order.length === currentNames.size && order.every((name) => currentNames.has(name));
  };

  // A folder's sort on this install follows what happens to its entries, in
  // any root. Best-effort: the entry has already changed, and a sort is only
  // how it shows.
  const keepLocalSorts = async (change: Parameters<typeof updateLocalSorts>[1]): Promise<void> => {
    try {
      await updateLocalSorts(spaceRoot, change);
    } catch {
      // best-effort only — the entry already changed
    }
  };

  // A Table's layout on this install follows its file the same way.
  const keepTableLayouts = async (change: Parameters<typeof updateTableLayouts>[1]): Promise<void> => {
    try {
      await updateTableLayouts(spaceRoot, change);
    } catch {
      // best-effort only — the entry already changed
    }
  };

  // And a Flow's App Mode.
  const keepFlowAppModes = async (change: Parameters<typeof updateFlowAppModes>[1]): Promise<void> => {
    try {
      await updateFlowAppModes(spaceRoot, change);
    } catch {
      // best-effort only — the entry already changed
    }
  };

  // And the folder a context's frames were last saved to.
  const keepFrameFolders = async (change: Parameters<typeof updateFrameFolders>[1]): Promise<void> => {
    try {
      await updateFrameFolders(spaceRoot, change);
    } catch {
      // best-effort only — the entry already changed
    }
  };

  // And the guides and look a context's media show.
  const keepContextViews = async (change: Parameters<typeof updateContextViews>[1]): Promise<void> => {
    try {
      await updateContextViews(spaceRoot, change);
    } catch {
      // best-effort only — the entry already changed
    }
  };

  /** A directory the space's own per-folder files live in. Its order is
   * `_structure.json` and `_properties.json`, which are space machinery by
   * definition — so a library is refused here even when it is writable.
   * This is the refusal that never flips. */
  const spaceDirOnly = (dir: string | undefined): string => {
    const resolved = resolveRootedPath(spaceRoot, atRoot(dir), "write");
    if (!isSpaceTarget(resolved)) {
      throw new PathAccessError(400, "Ordering is for space folders only");
    }
    return resolved.filePath;
  };

  app.all("/api/space/create", async (c) => {
    if (c.req.method !== "POST") return c.body(null, 405);

    const body = (await c.req.json()) as CreateEntryRequestBody;

    if (body.type !== "file" && body.type !== "directory") {
      return c.text('type must be "file" or "directory"', 400);
    }

    const name = body.name?.trim() ?? "";
    if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\")) {
      return c.text("Invalid name", 400);
    }
    // Refused rather than repaired, unlike upload's: someone typed this, so
    // they can be told which rule it broke instead of finding the file
    // under a name they didn't choose.
    const illegal = illegalEntryNameReason(name);
    if (illegal) return c.text(illegal, 400);

    // A file of no kind Pragma opens becomes a note, so nothing is created
    // that can't be opened, or hidden while every file type isn't shown.
    // The test is the kind, not "has an extension": by the last-dot
    // reading, a title like `Police find $59.1m painting` has one.
    const entryName = body.type === "file" && !isTreeVisibleFile(name) ? `${name}.md` : name;

    const parent = resolveRootedPath(spaceRoot, atRoot(body.parentPath), "write");
    const parentDir = parent.filePath;
    const targetPath = path.join(parentDir, entryName);

    // Guarded on the parent existing because this is the one route handed
    // a parent that doesn't: `mkdir` below is recursive, so creating
    // `notes/2026/` in one gesture is legal and nothing there can collide.
    if (existsSync(parentDir) && findNameCollision(parentDir, entryName)) {
      return c.text("Already exists", 409);
    }

    if (body.type === "directory") {
      await mkdir(targetPath, { recursive: true });
    } else {
      await writeFile(targetPath, typeof body.content === "string" ? body.content : "", { flag: "wx" });
    }

    return c.json<CreateEntryResponse>({ path: formatWithinRoot(parent, targetPath), type: body.type });
  });

  // Bytes into a root, the only write route whose body isn't JSON; picks a
  // name that doesn't collide and reports back the path it made. Electron
  // copies a dropped file through this same call a remote browser tab makes, so
  // neither host gets a shortcut the other lacks.
  //
  // Streamed to disk, never read whole, into a hidden temp file renamed into
  // place only after the last byte, so a cut-off drop leaves nothing a tree
  // would list.
  app.all("/api/space/upload", async (c) => {
    if (c.req.method !== "POST") return c.body(null, 405);

    const requested = c.req.query("name")?.trim() ?? "";
    // Whatever the OS put in front of the name is dropped rather than
    // honored: a drag can carry a full path, and a name is a name.
    const name = sanitizeEntryName(requested.split(/[/\\]/).pop() ?? "");
    if (!name) return c.text("Invalid name", 400);

    // The extension decides, and only media and LUTs pass. The bytes are never
    // sniffed: a root is a folder of files a person also opens in other
    // tools, so a `.png` that isn't one is their file to keep, not this
    // route's to second-guess — and a permissive sniff is how an executable
    // gets written under a name the tree renders as a picture.
    if (!rawFileTypeForPath(name)) {
      return c.text("Only image, video, PDF and LUT files can be added this way", 415);
    }

    const parent = resolveRootedPath(spaceRoot, atRoot(c.req.query("dir")), "write");
    const parentDir = parent.filePath;
    if (!existsSync(parentDir) || !statSync(parentDir).isDirectory()) return c.text("No such folder", 404);

    const body = c.req.raw.body;
    if (!body) return c.text("Empty file", 400);

    const tempPath = path.join(parentDir, `.${name}.${process.pid}.${Date.now().toString(36)}.tmp`);
    try {
      await pipeline(Readable.fromWeb(body as unknown as NodeReadableStream), createWriteStream(tempPath));
      if ((await stat(tempPath)).size === 0) {
        await rm(tempPath, { force: true });
        return c.text("Empty file", 400);
      }
      // Named only now, after the last byte: two drops of the same name
      // racing each other would otherwise be handed one name twice.
      const finalName = uniqueEntryName(parentDir, name);
      await rename(tempPath, path.join(parentDir, finalName));
      return c.json<UploadEntryResponse>({
        path: formatWithinRoot(parent, path.join(parentDir, finalName)),
        name: finalName,
      });
    } catch (error) {
      await rm(tempPath, { force: true }).catch(() => undefined);
      throw error;
    }
  });

  // A copy beside the original, named the way upload steps around a taken
  // name (`inventory 2.table.html`), so the gesture can never overwrite.
  // Files only: a folder copy would carry a site's `_site.json` binding, and
  // two folders would then publish to one remote site.
  app.all("/api/space/duplicate", async (c) => {
    if (c.req.method !== "POST") return c.body(null, 405);

    const body = (await c.req.json()) as DuplicateEntryRequestBody;
    const source = resolveRootedPath(spaceRoot, body.path, "write");
    const sourcePath = source.filePath;
    if (!existsSync(sourcePath)) return c.text("Not found", 404);
    if (!statSync(sourcePath).isFile()) return c.text("Only a file can be duplicated", 400);

    // Sanitized first: the original may carry a name written outside
    // pragma, and a name pragma writes has to be legal everywhere.
    const dir = path.dirname(sourcePath);
    const name = sanitizeEntryName(path.basename(sourcePath));
    if (!name) return c.text("Invalid name", 400);
    const copyName = uniqueEntryName(dir, name);
    const copyPath = path.join(dir, copyName);

    const relative = path.relative(spaceRoot, sourcePath).split(path.sep).join("/");
    const inSite = isSpaceTarget(source) && resolveSiteForPath(spaceRoot, relative) !== undefined;
    const unpublished =
      inSite && isMarkdownFile(sourcePath) ? withoutPublishState(readFileSync(sourcePath, "utf8")) : undefined;
    if (unpublished !== undefined) {
      await writeFile(copyPath, unpublished, { flag: "wx" });
    } else {
      await copyFile(sourcePath, copyPath, constants.COPYFILE_EXCL);
    }

    if (isSpaceTarget(source)) duplicateStructureEntry(dir, path.basename(sourcePath), copyName);
    await keepLocalSorts((sorts) => duplicatedLocalSorts(sorts, formatWithinRoot(source, sourcePath), copyName));

    return c.json<CreateEntryResponse>({ path: formatWithinRoot(source, copyPath), type: "file" });
  });

  app.all("/api/space/move", async (c) => {
    if (c.req.method !== "POST") return c.body(null, 405);

    const body = (await c.req.json()) as MoveEntryRequestBody;

    const from = resolveRootedPath(spaceRoot, body.from, "write");
    const to = resolveRootedPath(spaceRoot, body.to, "write");
    // Carrying an entry from one root to another is a copy, not a rename:
    // `rename` cannot cross a device, and a path that changed roots would
    // leave every reference already written against the old one pointing
    // at nothing. Refused whole rather than performed halfway.
    if (!sameRoot(from.rooted.root, to.rooted.root)) {
      return c.text("A move stays inside one root", 400);
    }
    const fromPath = from.filePath;
    const toPath = to.filePath;

    if (fromPath === toPath) return c.json<MoveEntryResponse>({ path: body.to });

    // Only the last segment is new: a move's destination directories
    // already exist on disk, so they were named under whatever rule
    // applied when they were made, and re-judging them here would refuse
    // a legal rename because of a folder the writer isn't touching.
    const illegal = illegalEntryNameReason(path.basename(toPath));
    if (illegal) return c.text(illegal, 400);

    // A directory can't be dropped into itself or one of its own
    // descendants — `rename` would otherwise throw a cryptic ENOTEMPTY
    // (or, on some platforms, silently corrupt the tree).
    if (toPath.startsWith(fromPath + path.sep)) {
      return c.text("Cannot move a folder into itself", 400);
    }

    if (findNameCollision(path.dirname(toPath), path.basename(toPath), fromPath)) {
      return c.text("Already exists", 409);
    }

    const isDirectory = statSync(fromPath).isDirectory();

    await rename(fromPath, toPath);
    await keepLocalSorts((sorts) =>
      movedLocalSorts(sorts, formatWithinRoot(from, fromPath), formatWithinRoot(to, toPath)),
    );
    await keepTableLayouts((layouts) =>
      movedByPath(layouts, formatWithinRoot(from, fromPath), formatWithinRoot(to, toPath)),
    );
    await keepFlowAppModes((modes) =>
      movedByPath(modes, formatWithinRoot(from, fromPath), formatWithinRoot(to, toPath)),
    );
    await keepFrameFolders((folders) =>
      movedFrameFolders(folders, formatWithinRoot(from, fromPath), formatWithinRoot(to, toPath)),
    );
    await keepContextViews((views) =>
      movedContexts(views, formatWithinRoot(from, fromPath), formatWithinRoot(to, toPath)),
    );
    // A bookmark follows its entry, in any root, as a sort does.
    await keepSpaceBookmarks(spaceRoot, (file) =>
      bookmarksAfterMove(file, formatWithinRoot(from, fromPath), formatWithinRoot(to, toPath)),
    );
    // So does a listed preset folder, the one or the folder holding it.
    await keepSpacePresets(spaceRoot, (file) =>
      presetsAfterMove(file, formatWithinRoot(from, fromPath), formatWithinRoot(to, toPath)),
    );

    // Everything below is the space's own bookkeeping, and a library has
    // none of it: no binder manifest to keep in order, no site to
    // republish to, and no markdown whose links this could have broken —
    // a library document's own links resolve inside that library, which a
    // move within it leaves alone.
    if (!isSpaceTarget(from)) {
      return c.json<MoveEntryResponse>({ path: formatWithinRoot(to, toPath), rewritten: [], warnings: [] });
    }

    // A file's earlier versions follow it, everything in a folder with it.
    await moveHistory(spaceRoot, fromPath, toPath);

    // A same-directory rename keeps the entry's position in its parent's
    // _structure.json. A move between directories only leaves the old
    // order: a position in one directory's order means nothing in
    // another's, where the entry follows the ones listed until rearranged.
    if (path.dirname(fromPath) === path.dirname(toPath)) {
      renameStructureEntry(path.dirname(fromPath), path.basename(fromPath), path.basename(toPath));
    } else {
      removeStructureEntry(path.dirname(fromPath), path.basename(fromPath));
    }

    // A published page's slug comes from its name and its parent from its
    // folder, so any move or rename leaves the service copy out of date. A
    // folder is carried by its own index.md: the pages under it follow
    // their parent on the service. Best-effort, like every other
    // pending-queue trigger.
    const movedPage = isDirectory ? namedEntryPath(toPath, "index.md") : isMarkdownFile(toPath) ? toPath : undefined;
    if (movedPage) {
      try {
        refuseLink(toPath, movedPage);
        if (existsSync(movedPage)) {
          const { data } = parseFrontmatter(readFileSync(movedPage, "utf8"));
          if (!isPrivate(data) && typeof data.id === "string") {
            const relativePagePath = path.relative(spaceRoot, movedPage).split(path.sep).join("/");
            const target = resolveSiteForPath(spaceRoot, relativePagePath);
            if (target) addPendingEntry(path.join(spaceRoot, target.siteDir), { op: "publish", id: data.id });
          }
        }
      } catch {
        // best-effort only — the move above already succeeded
      }
    }

    const movedFrom = path.relative(spaceRoot, fromPath).split(path.sep).join("/");
    const relative = path.relative(spaceRoot, toPath).split(path.sep).join("/");

    // A page never published is queued by its path, and the move just
    // changed that path. Best-effort, like the trigger above.
    try {
      await movePendingPaths(spaceRoot, movedFrom, relative);
    } catch {
      // best-effort only — the move above already succeeded
    }

    // Links last, and best-effort: the rename has already landed, so a
    // rewrite that throws costs some stale references rather than an
    // aborted move. The paths it touched travel back so an open pane can
    // reload before its own next save puts the old text back.
    let references: ReferenceRewriteResult = { rewritten: [], warnings: [] };
    try {
      references = await rewriteMovedReferences(spaceRoot, movedFrom, relative);
    } catch {
      // best-effort only — the move above already succeeded
    }

    // A rewritten document's content changed, so a published copy of it is
    // now out of date — the same reason an ordinary save queues one
    // (routes/file.ts). Dates are deliberately not restamped: the writer
    // did not edit these files, and moving one document should not mark
    // twenty others as freshly updated.
    for (const rewrittenPath of references.rewritten) {
      try {
        const { data } = parseFrontmatter(readFileSync(resolveWithinSpace(spaceRoot, rewrittenPath), "utf8"));
        if (isPrivate(data)) continue;
        const target = resolveSiteForPath(spaceRoot, rewrittenPath);
        if (!target) continue;
        addPendingEntry(
          path.join(spaceRoot, target.siteDir),
          typeof data.id === "string" ? { op: "publish", id: data.id } : { op: "publish", path: rewrittenPath },
        );
      } catch {
        // best-effort only — the move and the rewrite both already succeeded
      }
    }

    return c.json<MoveEntryResponse>({ path: relative, ...references });
  });

  app.all("/api/space/delete", async (c) => {
    if (c.req.method !== "POST") return c.body(null, 405);

    const body = (await c.req.json()) as DeleteEntryRequestBody;

    const target = resolveRootedPath(spaceRoot, body.path, "write");
    const targetPath = target.filePath;
    const inSpace = isSpaceTarget(target);

    if (targetPath === target.rootDir) return c.text("Cannot delete the root itself", 400);
    if (!existsSync(targetPath)) return c.text("Not found", 404);

    // Published documents are captured before they're gone — afterwards
    // there is no frontmatter left to read an id from. Best-effort and never
    // blocks the delete. Nothing in a library is published.
    const queuedDeletes = inSpace ? await queuePendingDeletes(spaceRoot, targetPath) : [];

    // Soft delete unless the client sends an explicit `false`: a missing
    // field must never mean a real `rm`.
    //
    // Into the deleted entry's *own* root's `.trash`, not the open space's:
    // a rename onto another device would fail outright.
    if (body.trash !== false) await moveEntryToTrash(target.rootDir, targetPath);
    else await rm(targetPath, { recursive: true });
    if (inSpace) removeStructureEntry(path.dirname(targetPath), path.basename(targetPath));
    await keepLocalSorts((sorts) => forgottenLocalSorts(sorts, formatWithinRoot(target, targetPath)));
    await keepTableLayouts((layouts) => forgottenByPath(layouts, formatWithinRoot(target, targetPath)));
    await keepFlowAppModes((modes) => forgottenByPath(modes, formatWithinRoot(target, targetPath)));
    await keepFrameFolders((folders) => forgottenFrameFolders(folders, formatWithinRoot(target, targetPath)));
    await keepContextViews((views) => forgottenContexts(views, formatWithinRoot(target, targetPath)));
    await keepSpaceBookmarks(spaceRoot, (file) => bookmarksAfterDelete(file, formatWithinRoot(target, targetPath)));
    await keepSpacePresets(spaceRoot, (file) => presetsAfterDelete(file, formatWithinRoot(target, targetPath)));

    // A page never published is queued by its path, which now names
    // nothing. Best-effort, like the capture above.
    if (inSpace) {
      try {
        forgetPendingPaths(spaceRoot, formatWithinRoot(target, targetPath));
      } catch {
        // best-effort only — the delete above already succeeded
      }
    }

    // Best-effort unpublish of each queued document, after the local
    // delete has already landed: a service failure never blocks a local
    // delete. Whatever fails here (no publisher, a network error) stays
    // queued and is counted back to the client rather than dropped.
    let pendingUnpublish = 0;
    for (const { siteDir, id, publisherId } of queuedDeletes) {
      // Each document unpublishes from the publisher its own site lives
      // on, so deleting a folder spanning two sites on two services
      // reaches both.
      const resolved = await requirePublisher(publisherId);
      const unpublished = resolved.ok ? (await deleteSogmaDocument(resolved.publisher, id)).ok : false;
      if (unpublished) removePendingEntry(path.join(spaceRoot, siteDir), { id });
      else pendingUnpublish++;
    }

    return c.json<DeleteEntryResponse>({ path: formatWithinRoot(target, targetPath), pendingUnpublish });
  });

  app.all("/api/space/order", async (c) => {
    if (c.req.method !== "POST") return c.body(null, 405);

    const body = (await c.req.json()) as SetOrderRequestBody;
    const dirPath = spaceDirOnly(body.dir);
    if (!(await isCurrentOrder(dirPath, body.order))) {
      return c.text("order must match the directory's current entries exactly", 400);
    }

    writeStructure(dirPath, body.order);
    return c.body(null, 204);
  });

  // One rule per folder, in `_properties.json`'s `sort`: never the order it
  // shows. No rule leaves `_structure.json`, so the old arrangement comes back
  // when manual is picked again. Name from A is the order with neither, so it
  // is written only while a kept manifest would otherwise win.
  app.all("/api/space/sort", async (c) => {
    if (c.req.method !== "POST") return c.body(null, 405);

    const body = (await c.req.json()) as Incoming<SetSortRequestBody>;
    const dirPath = spaceDirOnly(typeof body.dir === "string" ? body.dir : undefined);
    const sort = parseSortChoice(body.sort);
    if (!sort) return c.text("sort must be a sort", 400);
    const { sort: _previous, ...rest } = readFolderProperties(dirPath);
    const hasStructure = readStructure(dirPath) !== null;

    if (sort.by === "manual") {
      if (!hasStructure) {
        if (!(await isCurrentOrder(dirPath, body.order))) {
          return c.text("order must match the directory's current entries exactly", 400);
        }
        writeStructure(dirPath, body.order as string[]);
      }
      writeFolderProperties(dirPath, rest);
      return c.body(null, 204);
    }

    const plain = sort.by === "name" && sort.order === "asc" && !hasStructure;
    writeFolderProperties(dirPath, plain ? rest : { ...rest, sort });
    return c.body(null, 204);
  });

  // What the Property… picker suggests, from the same frontmatter the tree
  // orders by, so asking costs nothing once the folder has been sorted. A
  // read, so a library folder answers too: it takes a property sort on this
  // install, never as its own order.
  app.all("/api/space/sort-keys", async (c) => {
    if (c.req.method !== "GET") return c.body(null, 405);

    const dirPath = resolveRootedPath(spaceRoot, atRoot(c.req.query("dir")), "read").filePath;
    const sources: string[] = [];
    for (const entry of await readdir(dirPath, { withFileTypes: true })) {
      if (isHiddenName(entry.name) || entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) sources.push(namedEntryPath(path.join(dirPath, entry.name), "index.md"));
      else if (isMarkdownFile(entry.name)) sources.push(path.join(dirPath, entry.name));
    }
    const counts = new Map<string, number>();
    for (const data of sources.map((source) => documentIndex().frontmatter(source))) {
      for (const [key, value] of Object.entries(data)) {
        if (toSortValue(value) !== undefined) counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
    const keys = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([key]) => key);
    return c.json<SortKeysResponse>({ keys });
  });
}
