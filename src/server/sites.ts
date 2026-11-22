// Sites (docs/publishing.md): the site file, resolving which site a path
// publishes to, listing them, and the pending-delete queue.

import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SpaceSiteEntry } from "../protocol/api.ts";
import { isHiddenName, isNamed } from "../protocol/entryName.ts";
import { isPrivateDocument, readFrontmatter } from "../protocol/frontmatter.ts";
import { QUEUE_FILENAME, SITE_FILENAME } from "../protocol/pragmaFiles.ts";
import { isHiddenPath } from "../protocol/relativeReference.ts";
import { isWithin } from "../protocol/rootedPath.ts";
import { isMarkdownFile } from "../protocol/types.ts";
import { namedEntryPath, refuseLink } from "./rootedFiles.ts";
import { walkSpace } from "./spaceWalk.ts";

/** Reads `<dir>/_site.json`'s tree-facing fields — a missing or malformed
 * manifest just reads as "not a site root" rather than throwing. New Site
 * writes a fuller shape (see the full reader below); the tree reads only
 * these. */

export function readSiteManifest(dir: string): { name: string; assetsFolder?: string } | null {
  const sitePath = namedEntryPath(dir, SITE_FILENAME);
  if (!existsSync(sitePath)) return null;

  try {
    refuseLink(dir, sitePath);
    const parsed = JSON.parse(readFileSync(sitePath, "utf8")) as { name?: unknown; assetsFolder?: unknown };
    if (typeof parsed.name !== "string") return null;
    return {
      name: parsed.name,
      ...(typeof parsed.assetsFolder === "string" && parsed.assetsFolder ? { assetsFolder: parsed.assetsFolder } : {}),
    };
  } catch {
    return null;
  }
}

export interface SiteFile {
  id: string;
  slug: string;
  name: string;
  domain?: string;
  primaryDomain: string | null;
  // Which configured publisher this site lives on. Absent resolves to the
  // first configured publisher (src/server/publishers.ts).
  publisherId?: string;
  // Site-relative folder that pasted and dropped images land in; absent
  // keeps them beside the document.
  assetsFolder?: string;
}

/** Reads `<dir>/_site.json` in full — every field New Site (`/api/space/site`)
 * writes. Server-internal only: publish (publishHandler.ts) needs the real
 * `id` to send Sogma as `site_id`; nothing tree-facing needs more than the
 * tree-facing reader above gives it. */

export function readSiteFile(dir: string): SiteFile | null {
  const sitePath = namedEntryPath(dir, SITE_FILENAME);
  if (!existsSync(sitePath)) return null;

  try {
    refuseLink(dir, sitePath);
    const parsed = JSON.parse(readFileSync(sitePath, "utf8")) as Partial<SiteFile>;
    if (typeof parsed.id !== "string" || typeof parsed.slug !== "string" || typeof parsed.name !== "string") {
      return null;
    }
    return {
      id: parsed.id,
      slug: parsed.slug,
      name: parsed.name,
      domain: typeof parsed.domain === "string" ? parsed.domain : undefined,
      primaryDomain: typeof parsed.primaryDomain === "string" ? parsed.primaryDomain : null,
      publisherId: typeof parsed.publisherId === "string" ? parsed.publisherId : undefined,
      assetsFolder: typeof parsed.assetsFolder === "string" && parsed.assetsFolder ? parsed.assetsFolder : undefined,
    };
  } catch {
    return null;
  }
}

/** Normalizes an assets folder as typed into the site-relative form
 * `_site.json` stores, or a message saying why it can't be one. Empty
 * clears the setting. A dot-prefixed segment is refused because the space
 * never writes under one, so every paste would fail there. */
export function normalizeAssetsFolder(typed: string): { ok: true; folder: string } | { ok: false; message: string } {
  const folder = typed
    .trim()
    .replace(/\\/g, "/")
    .split("/")
    .filter((segment) => segment !== "")
    .join("/");
  if (isHiddenPath(folder)) {
    return { ok: false, message: "Must be a folder inside the site, not a hidden one or one above it." };
  }
  return { ok: true, folder };
}

/** Writes the keys given into `<dir>/_site.json`: `name`, the name the
 * publisher holds, and `assetsFolder`, which "" clears. A set assets folder
 * is created, so the first paste has somewhere to land. */
export async function updateSiteFile(dir: string, changes: { name?: string; assetsFolder?: string }): Promise<void> {
  const { name, assetsFolder } = changes;
  if (assetsFolder) await mkdir(path.join(dir, ...assetsFolder.split("/")), { recursive: true });
  const sitePath = namedEntryPath(dir, SITE_FILENAME);
  refuseLink(dir, sitePath);
  // Edited as the parsed file, never rebuilt from SiteFile: every key this
  // write doesn't set stays exactly as written.
  const site = JSON.parse(await readFile(sitePath, "utf8")) as Record<string, unknown>;
  if (name !== undefined) site.name = name;
  if (assetsFolder) site.assetsFolder = assetsFolder;
  else if (assetsFolder === "") delete site.assetsFolder;
  await writeFile(sitePath, `${JSON.stringify(site, null, 2)}\n`);
}

export interface SitePublishTarget {
  siteDir: string; // space-relative, forward-slash — "" for a site at the space root
  site: SiteFile;
}

/** Resolves which site a document belongs to: the nearest `_site.json` up
 * from its folder wins outright — a nearer one shadowing a site it sits
 * inside is the point, not an edge case (see docs/publishing.md's Publishing
 * a document section). Re-resolved here, not trusted from the client's own
 * tree walk, since this is what decides where the publish request goes. */

export function resolveSiteForPath(spaceRoot: string, relativeFilePath: string): SitePublishTarget | undefined {
  const segments = relativeFilePath.split("/");
  for (let i = segments.length - 1; i >= 0; i--) {
    const relativeDir = segments.slice(0, i).join("/");
    const site = readSiteFile(path.join(spaceRoot, relativeDir));
    if (site) return { siteDir: relativeDir, site };
  }
  return undefined;
}

/** Walks the whole space for every `_site.json`, backing `GET
 * /api/space/sites` for the Websites sidebar panel. Recurses into every
 * directory regardless of whether it's itself a site root — a site nested
 * inside another site's folder is unusual but not disallowed, so it still
 * shows up as its own entry. */

export async function listSites(dir: string, spaceRoot: string): Promise<SpaceSiteEntry[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const sites: SpaceSiteEntry[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || isHiddenName(entry.name)) continue;

    const absolute = path.join(dir, entry.name);
    const relative = path.relative(spaceRoot, absolute).split(path.sep).join("/");

    const site = readSiteFile(absolute);
    if (site) sites.push({ ...site, path: relative });

    sites.push(...(await listSites(absolute, spaceRoot)));
  }

  return sites;
}

/** The space-relative `index.md` whose `id` is the `parent_id` of a document
 * about to be published, or undefined for a top-level one. The file need
 * not exist. A folder's own `index.md` looks one level further up: that
 * index is the file being resolved, so reading it would be self-referential.
 *
 * The site root is not a section, though it has an `index.md` (the home
 * page): without that rule a flat `about.md` would take the home page as
 * `parent_id` and publish at `/index/about`. */
export function parentIndexPath(relativeFilePath: string, siteDir: string): string | undefined {
  const isIndex = isNamed(path.posix.basename(relativeFilePath), "index.md");
  const ownDir = path.posix.dirname(relativeFilePath);
  const hierarchyDir = isIndex ? path.posix.dirname(ownDir) : ownDir;
  // path.dirname bottoms out at "." while a space-root site's siteDir is ""
  if ((hierarchyDir === "." ? "" : hierarchyDir) === siteDir) return undefined;
  return `${hierarchyDir}/index.md`;
}

/** A document that just had a `delete` entry queued — `siteDir` is
 * space-relative (`SitePublishTarget.siteDir`'s own contract), so a caller
 * attempting the remote unpublish needs `path.join(spaceRoot, siteDir)`
 * before touching `_queue.json` again. */

export interface QueuedPendingDelete {
  siteDir: string;
  id: string;
  // Captured here rather than re-read from `_site.json` later: by the time
  // the caller attempts the remote unpublish the site folder itself may be
  // the thing that was deleted, and with it the only record of which
  // service the document was published to.
  publisherId?: string;
}

// A folder that can't be read is passed over: queueing never blocks a
// delete, so it queues the notes in every folder it can read.
async function queuePendingDeleteFrom(spaceRoot: string, absolutePath: string): Promise<QueuedPendingDelete[]> {
  if (!(await stat(absolutePath)).isDirectory()) return queuePendingDeleteOf(spaceRoot, absolutePath);
  const queued: QueuedPendingDelete[] = [];
  for (const file of (await walkSpace(absolutePath, "skip")).files) {
    queued.push(...(await queuePendingDeleteOf(spaceRoot, path.join(absolutePath, ...file.split("/")))));
  }
  return queued;
}

async function queuePendingDeleteOf(spaceRoot: string, absolutePath: string): Promise<QueuedPendingDelete[]> {
  if (!isMarkdownFile(absolutePath)) return []; // not a note — nothing Sogma ever received

  const relativeFilePath = path.relative(spaceRoot, absolutePath).split(path.sep).join("/");
  const content = await readFile(absolutePath, "utf8");
  if (isPrivateDocument(content)) return [];
  const { data } = readFrontmatter(content);
  if (typeof data.id !== "string") return []; // never published — nothing to unpublish

  const target = resolveSiteForPath(spaceRoot, relativeFilePath);
  if (!target) return [];

  addPendingEntry(path.join(spaceRoot, target.siteDir), { op: "delete", id: data.id });
  return [{ siteDir: target.siteDir, id: data.id, publisherId: target.site.publisherId }];
}

/** Queues a `delete` pending-entry for every already-published document the
 * deletion of `absolutePath` is about to remove, and returns them so the
 * caller can attempt each remote unpublish right away. Must run *before* the
 * filesystem delete: it is the last moment a file's frontmatter `id` exists,
 * and without it the document can never be unpublished.
 *
 * Never throws and never blocks the delete — an unreadable file just isn't
 * queued; nothing remote may stop a user deleting their own local file. */

export async function queuePendingDeletes(spaceRoot: string, absolutePath: string): Promise<QueuedPendingDelete[]> {
  try {
    return await queuePendingDeleteFrom(spaceRoot, absolutePath);
  } catch {
    return []; // best-effort only — see doc comment above
  }
}

/** One unsynced change a site's `_queue.json` is tracking — see
 * docs/publishing.md's The pending queue section. A `delete` entry is
 * always `id`-keyed: the file is gone by the time it matters. Deliberately
 * no idempotency key or last-attempt bookkeeping — retry mechanics are
 * generated in memory per attempt, not facts about what's pending. */

export interface PendingEntry {
  op: "publish" | "delete";
  id?: string;
  path?: string;
}

/** Reads `<siteAbsoluteDir>/_queue.json` — same graceful-fallback shape as
 * every other manifest here: a missing or malformed file just means
 * "nothing pending" rather than an error. Takes an *absolute* directory,
 * not `SitePublishTarget.siteDir` (space-relative) directly; join that
 * against `spaceRoot` first. */

export function readPendingQueue(siteAbsoluteDir: string): PendingEntry[] {
  const pendingPath = namedEntryPath(siteAbsoluteDir, QUEUE_FILENAME);
  if (!existsSync(pendingPath)) return [];

  try {
    refuseLink(siteAbsoluteDir, pendingPath);
    const parsed = JSON.parse(readFileSync(pendingPath, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Writes `<siteAbsoluteDir>/_queue.json` wholesale. An empty list deletes
 * the file rather than writing `[]` — a site with nothing pending has no
 * manifest. Same absolute-directory contract as the reader above. */

export function writePendingQueue(siteAbsoluteDir: string, entries: PendingEntry[]): void {
  const pendingPath = namedEntryPath(siteAbsoluteDir, QUEUE_FILENAME);
  if (entries.length === 0) {
    if (existsSync(pendingPath)) unlinkSync(pendingPath);
    return;
  }
  refuseLink(siteAbsoluteDir, pendingPath);
  writeFileSync(pendingPath, `${JSON.stringify(entries, null, 2)}\n`);
}

function pendingEntryKey(entry: Pick<PendingEntry, "op" | "id" | "path">): string {
  return `${entry.op}:${entry.id ?? entry.path}`;
}

/** Adds `entry` to `<siteAbsoluteDir>/_queue.json` if an equivalent entry
 * (same op, same id-or-path) isn't already queued — every save of an
 * eligible document calls this, so this dedup is what keeps repeated saves
 * from piling up duplicate entries. Same absolute-directory contract as
 * the reader above. */

export function addPendingEntry(siteAbsoluteDir: string, entry: PendingEntry): void {
  const entries = readPendingQueue(siteAbsoluteDir);
  const newKey = pendingEntryKey(entry);
  if (entries.some((existing) => pendingEntryKey(existing) === newKey)) return;
  writePendingQueue(siteAbsoluteDir, [...entries, entry]);
}

/** Removes every entry matching `id` or `path` from
 * `<siteAbsoluteDir>/_queue.json`, once a document's current state has
 * reached Sogma. Either key matches, since a document published for the
 * first time may have been queued by `path` before it had an `id`. Same
 * absolute-directory contract as the reader above. */

export function removePendingEntry(siteAbsoluteDir: string, match: { id?: string; path?: string }): void {
  const entries = readPendingQueue(siteAbsoluteDir);
  const filtered = entries.filter((entry) => {
    if (match.id !== undefined && entry.id === match.id) return false;
    if (match.path !== undefined && entry.path === match.path) return false;
    return true;
  });
  if (filtered.length !== entries.length) writePendingQueue(siteAbsoluteDir, filtered);
}

/** After `from` moved to `to`, both space-relative: each `path` entry on or
 * under `from` follows to its new path, in the queue of the site that path
 * sits in now, and goes when it sits in none. An `id` entry needs nothing:
 * the id travels in the file's own frontmatter. */
export async function movePendingPaths(spaceRoot: string, from: string, to: string): Promise<void> {
  const isMoved = (entry: PendingEntry): entry is PendingEntry & { path: string } =>
    typeof entry.path === "string" && isWithin(from, entry.path);

  // Two kinds of queue can hold one: the queue of the site `from` sat in,
  // which the move left in place, and the queue of each site the move
  // carried along, whose entries still name the old folder.
  const siteDirs = new Set<string>();
  const left = resolveSiteForPath(spaceRoot, from);
  if (left) siteDirs.add(left.siteDir);
  const movedDir = path.join(spaceRoot, to);
  if ((await stat(movedDir)).isDirectory()) {
    if (readSiteFile(movedDir)) siteDirs.add(to);
    for (const site of await listSites(movedDir, spaceRoot)) siteDirs.add(site.path);
  }

  for (const siteDir of siteDirs) {
    const queueDir = path.join(spaceRoot, siteDir);
    const entries = readPendingQueue(queueDir);
    if (!entries.some(isMoved)) continue;
    // Keyed, so a rename onto a path a stale entry names leaves one entry.
    const kept = new Map<string, PendingEntry>();
    for (const entry of entries) {
      if (!isMoved(entry)) {
        kept.set(pendingEntryKey(entry), entry);
        continue;
      }
      const followed = { ...entry, path: to + entry.path.slice(from.length) };
      const site = resolveSiteForPath(spaceRoot, followed.path);
      if (site?.siteDir === siteDir) kept.set(pendingEntryKey(followed), followed);
      else if (site) addPendingEntry(path.join(spaceRoot, site.siteDir), followed);
    }
    writePendingQueue(queueDir, [...kept.values()]);
  }
}

/** After `removed` (space-relative) was deleted: each `path` entry on or
 * under it goes from the queue of the site it sat in, since a page never
 * published leaves nothing on the service to delete. A site deleted with it
 * took its own queue along. */
export function forgetPendingPaths(spaceRoot: string, removed: string): void {
  const site = resolveSiteForPath(spaceRoot, removed);
  if (!site) return;
  const queueDir = path.join(spaceRoot, site.siteDir);
  const entries = readPendingQueue(queueDir);
  const kept = entries.filter((entry) => typeof entry.path !== "string" || !isWithin(removed, entry.path));
  if (kept.length !== entries.length) writePendingQueue(queueDir, kept);
}
