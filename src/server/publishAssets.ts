// Images inside a document being published: found in the body, uploaded to
// the site, and swapped for references the service resolves when it renders
// the page.
//
// The swap happens on the string sent over the wire, never on the file on
// disk: the space document keeps its relative embeds, so it still renders in
// any Markdown tool and the move rewriter keeps maintaining them.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { PublishNote } from "../protocol/api.ts";
import { applyReferenceEdits, findMarkdownReferences, type MarkdownReference } from "../protocol/markdownLinks.ts";
import { type PublisherConnection, putSogmaFileBytes, type SogmaFile, stageSogmaFile } from "../protocol/publisher.ts";
import { resolveFileReference } from "../protocol/relativeReference.ts";
import { dirnameOf, hasPathScheme, isLibraryPath } from "../protocol/rootedPath.ts";
import { imageMediaTypeForPath } from "../protocol/types.ts";
import { PathAccessError, resolveHeldPath } from "./rootedFiles.ts";

/** The publisher's ceiling for an image, which is lower than its ceiling for
 * a file because the image pipeline has its own input limit. The publisher's
 * number, not pragma's: pragma's own upload route streams and has no cap.
 *
 * Only a pre-flight guess: it spares an obviously doomed upload, and the
 * service's own refusal is what decides. Keep the two consistent by reporting
 * that refusal verbatim rather than restating this number when one arrives. */
const MAX_PUBLISHED_IMAGE_BYTES = 10 * 1024 * 1024;

/** Sizes as a person reads them. Rounded **up**, because the only caller is
 * a message contrasting a file against a ceiling: rounding to nearest lets a
 * file a byte over the limit print the same number as the limit, which reads
 * as a contradiction rather than a reason. */
function describeSize(bytes: number): string {
  const megabytes = Math.ceil((bytes / (1024 * 1024)) * 10) / 10;
  return `${megabytes.toFixed(1).replace(/\.0$/, "")} MB`;
}

/** An embed's destination that names something this publish cannot upload —
 * a scheme other than a space or library path, an unknown extension, a file
 * that is not there. Left exactly as written and reported, rather than failing the
 * publish: a stale embed is a state of the document, and one of them should
 * not stop the other pages of a site going out. */
interface SkippedEmbed {
  raw: string;
  reason: string;
}

/** One distinct file to upload, with every embed that names it. Keyed by
 * content, so a document that shows the same image three times uploads it
 * once and rewrites all three spans. */
export interface PublishImage {
  sha256: string;
  /** Rooted: bare for the space, `lib:<id>/…` for a library file. */
  spacePath: string;
  filename: string;
  mimeType: string;
  bytes: Uint8Array<ArrayBuffer>;
  references: MarkdownReference[];
  /** Outside the site folder, which is the published tree. Allowed, and
   * named in the result so a person is told which files leave the site by
   * being published rather than finding out from the live page. A library
   * file is always outside. */
  outsideSite: boolean;
}

export type CollectImagesResult =
  | { ok: true; images: PublishImage[]; skipped: SkippedEmbed[] }
  | { ok: false; message: string };

// `http`/`https` is already published and needs nothing. Every other
// scheme goes to the path parser, which reads `lib:` and refuses the rest —
// never resolved against the space, where it would upload the wrong file.
const WEB_URL = /^https?:/i;

/** Reads one image — a space path, or a `lib:` path into a library — as the
 * publisher will take it, or says why it can't be sent. `fatal` marks the one
 * refusal that stops a whole publish — an image over the size ceiling —
 * rather than leaving an embed as written. */
export async function readPublishableImage(
  spaceRoot: string,
  spacePath: string,
): Promise<
  | { ok: true; mimeType: string; bytes: Uint8Array<ArrayBuffer>; sha256: string }
  | { ok: false; reason: string; fatal?: boolean }
> {
  const mimeType = imageMediaTypeForPath(spacePath);
  if (!mimeType) return { ok: false, reason: "not an image Pragma recognizes" };

  let absolute: string;
  try {
    absolute = resolveHeldPath(spaceRoot, spacePath, "read").filePath;
  } catch (error) {
    if (error instanceof PathAccessError) return { ok: false, reason: error.message };
    throw error;
  }
  if (!existsSync(absolute)) return { ok: false, reason: "the file is missing" };

  // Copied out of the Buffer `readFile` hands back rather than passed
  // along: a Buffer's backing store is wider than a request body accepts,
  // so sending one directly does not compile. The copy costs about a
  // millisecond per megabyte and is what keeps the upload untyped-cast-free.
  const bytes = new Uint8Array(await readFile(absolute));
  if (bytes.byteLength === 0) return { ok: false, reason: "the file is empty" };
  if (bytes.byteLength > MAX_PUBLISHED_IMAGE_BYTES) {
    return {
      ok: false,
      fatal: true,
      reason:
        `"${spacePath}" is ${describeSize(bytes.byteLength)}, over the ` +
        `${describeSize(MAX_PUBLISHED_IMAGE_BYTES)} the publisher accepts for images.`,
    };
  }
  return { ok: true, mimeType, bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
}

/** Finds every image embed in `markdown`, resolves each to a file in the
 * space or a library, and reads the bytes it will upload. A library is read
 * one embedded file at a time, never listed: the embed is the author naming
 * that file for the page.
 *
 * `markdown` must be the exact string that gets sent, because the spans this
 * returns are offsets into it.
 */
export async function collectPublishImages(
  spaceRoot: string,
  relativeFilePath: string,
  siteDir: string,
  markdown: string,
): Promise<CollectImagesResult> {
  const documentDir = dirnameOf(relativeFilePath);
  const byDigest = new Map<string, PublishImage>();
  const skipped: SkippedEmbed[] = [];

  for (const reference of findMarkdownReferences(markdown)) {
    if (!reference.isImage) continue;
    const raw = reference.raw.trim();
    if (!raw || raw.startsWith("#")) continue;

    if (WEB_URL.test(raw)) continue;

    const spacePath = resolveFileReference(documentDir, raw);
    if (spacePath === undefined) {
      const reason = hasPathScheme(raw) ? "not a file in this space or a library" : "the path could not be resolved";
      skipped.push({ raw, reason });
      continue;
    }

    const read = await readPublishableImage(spaceRoot, spacePath);
    if (!read.ok) {
      if (read.fatal) return { ok: false, message: read.reason };
      skipped.push({ raw, reason: read.reason });
      continue;
    }
    const { mimeType, bytes, sha256 } = read;
    const existing = byDigest.get(sha256);
    if (existing) {
      existing.references.push(reference);
      continue;
    }

    byDigest.set(sha256, {
      sha256,
      spacePath,
      filename: path.basename(spacePath),
      mimeType,
      bytes,
      references: [reference],
      outsideSite: isLibraryPath(spacePath) || (siteDir !== "" && !spacePath.startsWith(`${siteDir}/`)),
    });
  }

  return { ok: true, images: [...byDigest.values()], skipped };
}

/** `responded` separates a service that rejected the upload from one that
 * was never reached, which is the only thing the caller needs to pick
 * between a 400 and a 502. */
interface UploadFailure {
  ok: false;
  message: string;
  responded: boolean;
}

export type UploadImagesResult = { ok: true; references: Map<string, string> } | UploadFailure;

/** What a document body should say to name a file the service now holds.
 *
 * An `asset:` reference beats the file's URL: the identifier exists from the
 * moment the file is staged, so nothing here waits for verification to
 * finish, and the body survives any later change to how CDN paths are shaped.
 *
 * The URL is the fallback for a record that somehow carries no identifier,
 * and a file with neither leaves its embed alone rather than writing a
 * reference to nothing. */
function referenceFor(file: SogmaFile): string | undefined {
  if (file.publicId) return `asset:${file.publicId}`;
  return file.url ?? undefined;
}

/** Uploads each image and returns what to write for it, keyed by digest.
 *
 * Bytes go up before the document does, even though a reference resolves
 * without them: an upload that fails after the page was published would
 * leave an image that never appears and nothing to say so. Nothing partial
 * is rolled back — an uploaded file is immutable, so a retry reuses it.
 */
export async function uploadPublishImages(
  publisher: PublisherConnection,
  siteId: string,
  images: PublishImage[],
): Promise<UploadImagesResult> {
  const references = new Map<string, string>();

  for (const image of images) {
    const uploaded = await uploadImage(publisher, siteId, image);
    if (!uploaded.ok) return uploaded;
    // Verification finishes on its own afterwards. A file that fails it
    // renders as its alt text rather than as a broken image, which is worth
    // more than holding every publish open until the service catches up.
    const reference = referenceFor(uploaded.file);
    if (reference) references.set(image.sha256, reference);
  }

  return { ok: true, references };
}

/** Stages one image and sends its bytes, answering with the file the
 * service now holds — or already held, matched by digest. */
export async function uploadImage(
  publisher: PublisherConnection,
  siteId: string,
  image: Pick<PublishImage, "spacePath" | "filename" | "mimeType" | "bytes" | "sha256">,
): Promise<{ ok: true; file: SogmaFile } | UploadFailure> {
  const staged = await stageSogmaFile(publisher, {
    siteId,
    filename: image.filename,
    mimeType: image.mimeType,
    sizeBytes: image.bytes.byteLength,
    sha256: image.sha256,
  });
  if (!staged.ok) {
    // A size refusal names its cap in `limit_bytes` precisely because the
    // prose carrying it may not be parsed, and the image cap is lower than
    // the general one. Without that member there is nothing better to say
    // than what the service said.
    const message =
      staged.code === "payload_too_large" && staged.limitBytes
        ? `"${image.spacePath}" is ${describeSize(image.bytes.byteLength)}, over the ` +
          `${describeSize(staged.limitBytes)} the publisher accepts for images.`
        : staged.message;
    return { ok: false, message, responded: staged.responded === true };
  }

  // No upload target means the site already holds these bytes, matched by
  // digest, and handed back the file it has. Nothing to send.
  if (staged.file.upload) {
    const sent = await putSogmaFileBytes(staged.file.upload, image.bytes);
    if (!sent.ok) return { ok: false, message: sent.message, responded: sent.responded };
  }
  return { ok: true, file: staged.file };
}

/** Replaces each embed's destination with what names the uploaded file. An
 * image missing from `references` keeps what the author wrote, so a gap
 * degrades to an un-rewritten embed rather than to an empty destination. */
export function rewriteImageEmbeds(markdown: string, images: PublishImage[], references: Map<string, string>): string {
  const edits: Array<{ from: number; to: number; replacement: string }> = [];
  for (const image of images) {
    const replacement = references.get(image.sha256);
    if (!replacement) continue;
    for (const embed of image.references) {
      edits.push({ from: embed.from, to: embed.to, replacement });
    }
  }
  return applyReferenceEdits(markdown, edits);
}

/** What the publish reports back about files it did not upload, and about
 * files that were not the site's own. Both are things a person would
 * otherwise discover by looking at the live page. */
export function describeImageNotes(images: PublishImage[], skipped: SkippedEmbed[]): PublishNote[] {
  const notes: PublishNote[] = skipped.map((entry) => ({
    level: "warn",
    text: `Left "${entry.raw}" as written: ${entry.reason}.`,
  }));

  const outside = images.filter((image) => image.outsideSite);
  if (outside.length > 0) {
    const count = outside.length === 1 ? "1 image" : `${outside.length} images`;
    notes.push({
      level: "info",
      text: `Published ${count} from outside the site folder: ${outside.map((image) => image.spacePath).join(", ")}.`,
    });
  }
  return notes;
}
