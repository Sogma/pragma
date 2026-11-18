import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { PublishNote, PublishWriteBack } from "../protocol/api.ts";
import { documentParamKeys, documentParams, paramKeyOf } from "../protocol/documentParams.ts";
import { isNamed } from "../protocol/entryName.ts";
import {
  editFrontmatter,
  isPrivate,
  type ParsedFrontmatter,
  PUBLICATION_DATE_KEY,
  parseFrontmatter,
  publishWriteBackKeys,
  readFrontmatter,
} from "../protocol/frontmatter.ts";
import { localDay } from "../protocol/localDay.ts";
import { splitTitleHeading } from "../protocol/markdownTitle.ts";
import {
  createSogmaDocument,
  type PublisherConnection,
  type SogmaDocument,
  updateSogmaDocument,
} from "../protocol/publisher.ts";
import { splitDocumentName } from "../protocol/types.ts";
import { writeDocument } from "./history.ts";
import { collectPublishImages, describeImageNotes, rewriteImageEmbeds, uploadPublishImages } from "./publishAssets.ts";
import { resolvePublisherSchemas } from "./publisherSchemas.ts";
import { namedEntryPath, PathAccessError, resolveRootedPath } from "./rootedFiles.ts";
import { addPendingEntry, parentIndexPath, removePendingEntry, resolveSiteForPath } from "./sites.ts";
import { resolveWithinSpace, revisionOf, writeFileAtomic } from "./spaceFiles.ts";

export type PublishResult =
  // `notes` reports what the publish did to the body that the file on disk
  // does not show: embeds left as written, and images sent from outside the
  // site folder. Empty on a document with nothing to say about it.
  // `date` is the publication date a first push added, absent when it added none.
  // `writeBacks` is every file the publish wrote into, sections first.
  | { ok: true; document: SogmaDocument; notes: PublishNote[]; date?: string; writeBacks: PublishWriteBack[] }
  | { ok: false; message: string; status: 400 | 403 | 404 | 502 };

const HOME_PAGE_SLUG = "index";

// Lowercase alphanumeric segments separated by hyphens, per public-api.md
// §4's `slug` field — a fallback of "untitled" only ever fires for a name
// that's entirely punctuation/whitespace (an edge case the API doesn't
// specify a behavior for), not a normal filename or folder name.
function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "untitled"
  );
}

// The page's title is the document's display title (docs/protocol.md's
// Document kinds section), else the file name, as the editor's title-bar
// placeholder does. The lifted heading is stripped from the `content` sent
// to Sogma: `title` is a separate field, so leaving the heading in the body
// would show it twice.
function extractTitleAndMarkdown(body: string, fallbackTitle: string): { title: string; markdown: string } {
  const { title, rest } = splitTitleHeading(body.replace(/^\n+/, ""));
  return title === undefined ? { title: fallbackTitle, markdown: body } : { title, markdown: rest };
}

// The author's publication date, sent as `published_at`. An absent or empty
// `date` is no date at all. The value is passed through as written: the
// service owns which date formats it accepts.
function publicationDate(data: Record<string, unknown>): { ok: true; value: string | null } | { ok: false } {
  const raw = data[PUBLICATION_DATE_KEY];
  if (raw === null || raw === undefined) return { ok: true, value: null };
  if (typeof raw !== "string") return { ok: false };
  return { ok: true, value: raw.trim() || null };
}

// The service's message names its own fields (`'params.anchor'`, `'slug'`),
// which an author never sees. A refusal it pins on one is told in the page's
// terms instead: the property the value came from, or the page's name on the
// site when that is what stands in for an anchor.
function refusalMessage(
  refusal: { message: string; code?: string; field?: string },
  slug: string,
  params: Record<string, unknown> | undefined,
): string {
  const key = paramKeyOf(refusal.field);
  if (refusal.code === "anchor_conflict" && key !== undefined) {
    return `Another page at the same level already has the ${key} "${String(params?.[key])}".`;
  }
  if (refusal.code === "anchor_conflict" && refusal.field === "/slug") {
    return `Another page at the same level uses "${slug}", this page's name on the site, as its anchor. Give this page an anchor of its own, or rename it.`;
  }
  return key === undefined ? refusal.message : `The publisher refused the ${key} property. ${refusal.message}`;
}

type ParentResult =
  | { ok: true; id?: string; writeBacks?: PublishWriteBack[] }
  | { ok: false; message: string; status: 400 | 403 | 404 | 502 };

// A document's section is published before the document itself, so the
// service gets a real `parent_id` instead of silently filing the page at the
// top level. Resolved on every publish, not just the first: an update naming
// a different parent moves the page on the service.
//
// A missing section `index.md` is created as a bare heading named after its
// folder — its frontmatter is the only place the section's id can live.
// Publishing the section recurses, so each missing level resolves its own
// parent first.
async function ensurePublishedParent(
  spaceRoot: string,
  publisher: PublisherConnection,
  relativeFilePath: string,
  siteDir: string,
): Promise<ParentResult> {
  const parentPath = parentIndexPath(relativeFilePath, siteDir);
  if (!parentPath) return { ok: true };

  // Contained here, not by the route: the section's index.md is a path this
  // derives, and its contents are about to be published. It is found in any
  // case, so a section's own `Index.md` never gains a second index beside it.
  const sectionDir = resolveWithinSpace(spaceRoot, path.posix.dirname(parentPath));
  const sectionIndex = path.relative(spaceRoot, namedEntryPath(sectionDir, "index.md")).split(path.sep).join("/");
  const absolute = resolveRootedPath(spaceRoot, sectionIndex, "write").filePath;
  if (existsSync(absolute)) {
    const { data } = readFrontmatter(readFileSync(absolute, "utf8"));
    if (typeof data.id === "string") return { ok: true, id: data.id };
  } else {
    await writeFileAtomic(absolute, `# ${path.posix.basename(path.posix.dirname(parentPath))}\n`);
  }

  const published = await runPublish(spaceRoot, publisher, sectionIndex);
  if (!published.ok) {
    return {
      ok: false,
      message: `Couldn't publish its section ${sectionIndex}: ${published.message}`,
      status: published.status,
    };
  }
  return { ok: true, id: published.document.id, writeBacks: published.writeBacks };
}

// The native Publish/Update control's action (docs/publishing.md's
// Publishing a document section): creates or updates by whether the
// document carries an `id`, publishing its section first when that has none,
// and writes the returned id/url back into frontmatter on success.
//
// The `/api/space/publish` route owns request parsing and the publisher
// lookup; this owns everything specific to *which* document goes *where*.
export async function runPublish(
  spaceRoot: string,
  publisher: PublisherConnection,
  relativeFilePath: string,
): Promise<PublishResult> {
  // A publish writes the document's id back into it, so its path goes
  // through the write doorway, which refuses one under a dot-prefixed folder.
  let filePath: string;
  try {
    filePath = resolveRootedPath(spaceRoot, relativeFilePath, "write").filePath;
  } catch (error) {
    if (error instanceof PathAccessError) return { ok: false, message: error.message, status: error.status };
    throw error;
  }
  if (!existsSync(filePath)) return { ok: false, message: "File not found.", status: 404 };

  const raw = readFileSync(filePath, "utf8");
  const { data, body, error } = readFrontmatter(raw);

  // The client already hides the button for these cases — re-checked here
  // since this is what actually decides where the request goes, not the
  // button's own state.
  if (error !== undefined) {
    return {
      ok: false,
      message: `This document's frontmatter isn't valid YAML (${error}). Fix it before publishing.`,
      status: 400,
    };
  }
  if (isPrivate(data)) {
    return { ok: false, message: "Private documents can't be published.", status: 400 };
  }

  const target = resolveSiteForPath(spaceRoot, relativeFilePath);
  if (!target) {
    return { ok: false, message: "This document isn't inside a published site.", status: 400 };
  }

  const isIndex = isNamed(path.posix.basename(relativeFilePath), "index.md");
  const isHomePage = isIndex && path.posix.dirname(relativeFilePath) === (target.siteDir || ".");
  const basename = splitDocumentName(path.basename(relativeFilePath)).stem;
  const slug = isHomePage
    ? HOME_PAGE_SLUG
    : isIndex
      ? slugify(path.basename(path.dirname(relativeFilePath)))
      : slugify(basename);

  const { title, markdown } = extractTitleAndMarkdown(body, basename);
  const visibility = data.visibility === "unlisted" ? "unlisted" : "public";
  const existingId = typeof data.id === "string" ? data.id : undefined;
  // A page's first push dates it that day unless the author already chose,
  // an empty `date` included. Section and home `index.md` pages stay undated:
  // the service renders an undated page without a dateline, which is what
  // an index wants.
  const seededDate = !existingId && !(PUBLICATION_DATE_KEY in data) && !isIndex ? localDay(new Date()) : undefined;
  const date = seededDate ? { ok: true as const, value: seededDate } : publicationDate(data);
  if (!date.ok) {
    return { ok: false, message: "The date property must be a date, like 2026-09-23.", status: 400 };
  }

  // Read before anything is sent, a section or an image included: a page
  // can't go out without the `params` its publisher takes, since an update
  // without them clears the page's keys on the site.
  const described = await resolvePublisherSchemas(publisher);
  if (!described.ok) {
    return {
      ok: false,
      message: described.httpCall
        ? `Couldn't read the publisher's API description. ${described.message}`
        : described.message,
      status: described.httpCall ? 400 : 502,
    };
  }
  const paramKeys = documentParamKeys(described.schemas.documentParams);
  const params = paramKeys && documentParams(data, paramKeys);

  const parent: ParentResult = isHomePage
    ? { ok: true }
    : await ensurePublishedParent(spaceRoot, publisher, relativeFilePath, target.siteDir);
  if (!parent.ok) return parent;

  // Images travel first, and the document carries references to them. A
  // reference resolves before its bytes land, so the order is not forced by
  // the format — it is so that an upload failing after the page went live
  // cannot leave an image that never appears and nothing to say so.
  //
  // Collected against `markdown`, not `body`: the spans are offsets into
  // whichever string gets rewritten, and the title lift above has already
  // moved everything after the leading heading.
  const collected = await collectPublishImages(spaceRoot, relativeFilePath, target.siteDir, markdown);
  if (!collected.ok) return { ok: false, message: collected.message, status: 400 };

  const uploaded = await uploadPublishImages(publisher, target.site.id, collected.images);
  if (!uploaded.ok) return { ok: false, message: uploaded.message, status: uploaded.responded ? 400 : 502 };

  const publishedMarkdown = rewriteImageEmbeds(markdown, collected.images, uploaded.references);

  const result = existingId
    ? await updateSogmaDocument(publisher, existingId, {
        parentId: parent.id ?? null,
        slug,
        title,
        content: publishedMarkdown,
        visibility,
        publishedAt: date.value,
        params,
      })
    : await createSogmaDocument(publisher, {
        siteId: target.site.id,
        parentId: parent.id,
        slug,
        title,
        content: publishedMarkdown,
        visibility,
        publishedAt: date.value ?? undefined,
        params,
      });

  if (!result.ok) {
    // httpCall present ⇔ Sogma actually responded (and rejected the
    // request) — absent means the fetch itself never got a response. Same
    // 400-vs-502 distinction /api/space/site's New Site route makes.
    return { ok: false, message: refusalMessage(result, slug, params), status: result.httpCall ? 400 : 502 };
  }

  // `pushed` mirrors Sogma's own `updated_at`. The published URL is not
  // stored: a domain change or an ancestor's move changes it without this
  // document being republished, so a stored copy would silently go stale.
  //
  // Written over the file as it is now, not as it was read: the service
  // round trip takes seconds, and a save that landed meanwhile must survive.
  const current = readCurrentDocument(filePath, raw);
  const writeBack = { id: result.document.id, pushed: result.document.updatedAt, date: seededDate };
  const written = editFrontmatter(current.raw, { ...current.data, ...publishWriteBackKeys(current.data, writeBack) });
  // Atomic, and deliberately not through the document-change bookkeeping:
  // this write *is* the result of publishing, and queuing it would re-add
  // the pending entry cleared just below, leaving the document permanently
  // dirty. A torn write here is the costly one — `id` is the only link back
  // to the published copy and cannot be recomputed locally.
  await writeDocument(spaceRoot, filePath, written, { source: "published" });

  // Clears whatever _queue.json entry got this document here — by `id`
  // (an already-published document that was edited again) and by `path`
  // (its first-ever publish, queued before it had an `id` to be keyed by).
  // A file that changed during the publish is already ahead of what the
  // service holds, so it stays pending, under the `id` it now has.
  const siteRoot = path.join(spaceRoot, target.siteDir);
  removePendingEntry(siteRoot, { id: existingId, path: relativeFilePath });
  if (current.raw !== raw) addPendingEntry(siteRoot, { op: "publish", id: result.document.id });

  return {
    ok: true,
    document: result.document,
    notes: describeImageNotes(collected.images, collected.skipped),
    date: seededDate,
    writeBacks: [...(parent.writeBacks ?? []), { path: relativeFilePath, revision: revisionOf(written), ...writeBack }],
  };
}

// The document as it is on disk now. One that can no longer be read as one
// — moved or deleted mid-publish, or its frontmatter broken — falls back to
// the copy that was published: the write-back's `id` is worth more than
// either, since nothing else links the file to its published page.
function readCurrentDocument(filePath: string, published: string): ParsedFrontmatter & { raw: string } {
  try {
    const raw = readFileSync(filePath, "utf8");
    return { ...parseFrontmatter(raw), raw };
  } catch {
    return { ...parseFrontmatter(published), raw: published };
  }
}
