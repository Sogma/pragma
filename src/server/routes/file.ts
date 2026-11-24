import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Hono } from "hono";
import type {
  AppletFileResponse,
  BacklinksResponse,
  ClassFileResponse,
  ClipDetails,
  ClipFactsResponse,
  ClipHeaderResponse,
  DocumentLock,
  FileDescriptionResponse,
  FileInfoResponse,
  FileSha256Response,
  FlowFileResponse,
  PictureDetails,
  PixelFormatResponse,
  PutFileRequestBody,
  PutFileResponse,
  TableFileResponse,
  TextFileResponse,
  TextToolkitInfo,
  ThumbnailUsageResponse,
} from "../../protocol/api.ts";
import { contentHashFor, readAppletFile } from "../../protocol/appletFile.ts";
import { parseClassFile } from "../../protocol/classFile.ts";
import { flowActions } from "../../protocol/flowActions.ts";
import { capabilityDigest, emptyFlowFile, parseFlowFile, readFlowFile } from "../../protocol/flowFile.ts";
import { computeFlowCapabilities } from "../../protocol/flowNodes.ts";
import { dirnameOf, formatRootedPath, isLibraryRoot } from "../../protocol/rootedPath.ts";
import { parseTableFile } from "../../protocol/tableFile.ts";
import {
  documentTypeFor,
  emptyClass,
  emptyTable,
  isAppletFile,
  isClassFile,
  isFlowFile,
  isNewerFormatVersion,
  isTableFile,
  mediaTypeForPath,
  rasterImageMediaTypeForPath,
  rawFileTypeForPath,
  thumbnailKindForPath,
  vectorImageMediaTypeForPath,
  videoMediaTypeForPath,
} from "../../protocol/types.ts";
import { readAppletImports } from "../appletImports.ts";
import { entryDescription } from "../descriptions.ts";
import { readDigitalSourceType } from "../digitalSourceType.ts";
import { documentIndex, type IndexRoot } from "../documentIndex.ts";
import { grantedCapabilities, grantPath, unattendedStanding } from "../grants.ts";
import { withHeaderReader } from "../headerReader.ts";
import { noteKnown } from "../history.ts";
import { readPixelFormat, UnreadableImageHeader } from "../imageHeader.ts";
import { readFlowAppModes, readTableLayouts } from "../layout.ts";
import { presetPaths } from "../presets.ts";
import { parseByteRange } from "../rangeRequest.ts";
import { resolveToolkits } from "../resolveToolkits.ts";
import { formatWithinRoot, isSpaceTarget, resolveRootedPath } from "../rootedFiles.ts";
import { saveDocument } from "../saveDocument.ts";
import { classesLinking, classLinkedFiles } from "../spaceClasses.ts";
import { readRevision, revisionOf, withFileLock } from "../spaceFiles.ts";
import {
  checkThumbnail,
  fileVersion,
  InvalidThumbnail,
  isFileVersion,
  MAX_THUMBNAIL_BYTES,
  parseDecoded,
  parseFacts,
  type ThumbnailFacts,
  thumbnailMediaType,
} from "../thumbnailStore.ts";
import { type ClipHeader, readClipHeader, UnreadableVideoFormat } from "../videoFormat.ts";
import type { RouteContext } from "./shared.ts";

const NO_CLIP_DETAILS: ClipDetails = {
  codec: null,
  frameRate: null,
  variableFrameRate: false,
  bitDepth: null,
  hdr: null,
  alpha: false,
  audio: null,
  startTimecode: null,
};

function clipDetails(header: ClipHeader): ClipDetails {
  const { codec, frameRate, variableFrameRate, bitDepth, hdr, alpha, audio, startTimecode } = header;
  return { codec, frameRate, variableFrameRate, bitDepth, hdr, alpha, audio, startTimecode };
}

const NO_PICTURE_DETAILS: PictureDetails = { sourceType: null, pixels: null };

// What the host reads of a media file's header for its folder entry. A
// header that doesn't read leaves the details unknown; it never refuses the
// thumbnail they are kept with.
async function headerDetails(filePath: string): Promise<{ clip: ClipDetails } | { picture: PictureDetails }> {
  const videoType = videoMediaTypeForPath(filePath);
  if (videoType) {
    const header = await withHeaderReader(filePath, (read, size) => readClipHeader(videoType, read, size)).catch(
      () => undefined,
    );
    return { clip: header ? clipDetails(header) : NO_CLIP_DETAILS };
  }
  if (!rasterImageMediaTypeForPath(filePath)) return { picture: NO_PICTURE_DETAILS };
  const picture = await withHeaderReader(filePath, async (read, size) => ({
    sourceType: await readDigitalSourceType(read, size).catch(() => null),
    pixels: await readPixelFormat(read).catch(() => null),
  })).catch(() => NO_PICTURE_DETAILS);
  return { picture };
}

// A Table, Class or Flow is re-serialized whole on save, so one this build
// couldn't fully read goes out locked, never as a document to save over.
// `undefined` is a parse that failed on non-blank text.
function lockFor(parsed: { version: string } | undefined): DocumentLock | undefined {
  if (!parsed) return "unreadable";
  return isNewerFormatVersion(parsed.version) ? "newer-format" : undefined;
}

// A vector image opened as a page also loads nothing from elsewhere: a file
// it names would tell that file's owner it was opened, and from where. It
// keeps what a self-contained one draws with, inline styles and data: URL
// images and fonts. No other kind can request anything by itself.
const VECTOR_IMAGE_PAGE_POLICY =
  "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:";

export function mountFileRoutes(app: Hono, { spaceRoot, thumbnails }: RouteContext): void {
  // Binary counterpart to /api/file, read-only, and never decoded as utf8 —
  // a text decode corrupts an image's, a video's or a PDF's bytes. The media
  // panes and reading view's inline embeds point their src here, and a LUT's
  // readers fetch it here.
  //
  // `path` may name the space (bare) or a library (`lib:<id>/…`); the
  // resolver, not this route, decides read access.
  app.all("/api/file/raw", async (c) => {
    const relativePath = c.req.query("path");
    if (!relativePath) return c.text("Missing path query parameter", 400);

    const { filePath } = resolveRootedPath(spaceRoot, relativePath, "read");
    const mediaType = rawFileTypeForPath(filePath);
    if (!mediaType) return c.text("Not a recognized image, video, PDF or LUT file", 404);

    const { size } = await stat(filePath);
    const range = parseByteRange(c.req.header("range"), size);
    // Only a range that parsed and cannot be satisfied is refused; one
    // this server does not understand already came back as "send it all".
    if (range === null) {
      return c.body(null, 416, { "content-range": `bytes */${size}`, "accept-ranges": "bytes" });
    }

    const start = range?.start ?? 0;
    const end = range?.end ?? size - 1;
    const headers: Record<string, string> = {
      "content-type": mediaType,
      // Set explicitly rather than relying on an automatic Content-Length:
      // on HEAD the body is dropped before sending, which otherwise
      // silently breaks a media pane's Size lookup (a HEAD request
      // against this same route).
      "content-length": String(size === 0 ? 0 : end - start + 1),
      // Advertised on every answer, not only a partial one: it is how a
      // player learns it may seek at all, before it has asked for a byte.
      "accept-ranges": "bytes",
      // A space SVG opened as a page (a link to this URL, "open image in
      // new tab") would otherwise run its scripts on the app's own origin,
      // with the whole API in reach. An <img> or <video> ignores the
      // header, so embeds and the media panes are unaffected.
      "content-security-policy": vectorImageMediaTypeForPath(filePath) ? VECTOR_IMAGE_PAGE_POLICY : "sandbox",
    };
    if (range) headers["content-range"] = `bytes ${start}-${end}/${size}`;

    const status = range ? 206 : 200;
    if (c.req.method === "HEAD" || size === 0) return c.body(null, status, headers);
    // Streamed, never read whole, images included: a library take runs to
    // gigabytes, and buffering one per request lets a handful of seeks
    // take the server down.
    return c.body(Readable.toWeb(createReadStream(filePath, { start, end })) as ReadableStream, status, headers);
  });

  // A media file's thumbnail, from the host's cache. GET answers the one made
  // from the file as it is now, or 404 when there is none; PUT stores one a
  // client rendered, naming the version it rendered from and what it decoded
  // (width, height, a video's duration), kept with what the host reads of
  // the file's header. A stale one is refused, never filed under the newer version.
  //
  // The file is resolved for reading even on PUT: the thumbnail lands in
  // host state, never in the root, so a read-only library gets one too.
  app.all("/api/file/thumbnail", async (c) => {
    const method = c.req.method;
    if (method !== "GET" && method !== "PUT") return c.body(null, 405);

    try {
      const target = c.req.query("path");
      if (!target) return c.text("Missing path query parameter", 400);
      const resolved = resolveRootedPath(spaceRoot, target, "read");
      if (!thumbnailKindForPath(resolved.filePath))
        return c.text("Only a raster image or a video has a thumbnail", 400);
      const stats = await stat(resolved.filePath);
      if (!stats.isFile()) return c.text("Not a file", 400);
      const key = { root: resolved.rootDir, file: resolved.filePath, version: fileVersion(stats) };

      if (method === "GET") {
        const bytes = await thumbnails.read(key);
        const mediaType = bytes && thumbnailMediaType(bytes);
        // Never cached: the same URL answers once the client has made one.
        if (!bytes || !mediaType) return c.body(null, 404, { "cache-control": "no-store" });
        const etag = `"${key.version}"`;
        const headers = { etag, "cache-control": "no-cache", "content-security-policy": "sandbox" };
        if (c.req.header("if-none-match") === etag) return c.body(null, 304, headers);
        return c.body(Buffer.from(bytes), 200, { ...headers, "content-type": mediaType });
      }

      const version = c.req.query("version");
      if (!version || !isFileVersion(version)) return c.text("Missing or malformed version query parameter", 400);
      if (version !== key.version) return c.text("The file has changed since this thumbnail was made", 409);
      const duration = c.req.query("duration");
      const decoded = parseDecoded({
        width: Number(c.req.query("width")),
        height: Number(c.req.query("height")),
        duration: duration === undefined ? undefined : Number(duration),
      });
      if (!decoded) return c.text("Missing or malformed width, height or duration query parameter", 400);
      const declared = Number(c.req.header("content-length"));
      if (declared > MAX_THUMBNAIL_BYTES) return c.text("Thumbnail too large", 413);
      const bytes = new Uint8Array(await c.req.arrayBuffer());
      await checkThumbnail(bytes, decoded);
      await thumbnails.write(key, bytes, { ...decoded, ...(await headerDetails(resolved.filePath)) });
      return c.body(null, 204);
    } catch (error) {
      if (error instanceof InvalidThumbnail) return c.text(error.message, 422);
      throw error;
    }
  });

  // The Info tab's SHA-256 row, for any file. Hashed here rather than in the
  // browser, where it would mean downloading a whole take to learn 32 bytes.
  // Streamed, so a gigabyte file costs time, never memory — and a route of
  // its own, so /api/file/info stays stat-only and never waits on a hash.
  app.get("/api/file/sha256", async (c) => {
    try {
      const relativePath = c.req.query("path");
      if (!relativePath) return c.text("Missing path query parameter", 400);

      const { filePath } = resolveRootedPath(spaceRoot, relativePath, "read");
      const hash = createHash("sha256");
      await pipeline(createReadStream(filePath), hash);
      return c.json<FileSha256Response>({ sha256: hash.digest("hex") });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EISDIR") return c.text("A folder has no bytes to hash", 400);
      throw error;
    }
  });

  // The image pane's color mode and bit depth, read from the header through
  // an open handle, never the whole file — see imageHeader.ts. A route of its
  // own, like the hash, so /api/file/info stays stat-only.
  app.get("/api/file/pixel-format", async (c) => {
    try {
      const relativePath = c.req.query("path");
      if (!relativePath) return c.text("Missing path query parameter", 400);

      const { filePath } = resolveRootedPath(spaceRoot, relativePath, "read");
      if (!rasterImageMediaTypeForPath(filePath)) return c.text("Not a raster image", 400);

      const format = await withHeaderReader(filePath, async (read, size) => ({
        ...(await readPixelFormat(read)),
        sourceType: await readDigitalSourceType(read, size),
      }));
      return c.json<PixelFormatResponse>(format);
    } catch (error) {
      if (error instanceof UnreadableImageHeader) return c.text(error.message, 422);
      throw error;
    }
  });

  // Facts in place of a thumbnail, for a clip the browser couldn't decode:
  // its size, length and details read from its header, kept for its version
  // and listed with its folder entry as a thumbnail's facts are.
  app.all("/api/file/thumbnail-facts", async (c) => {
    if (c.req.method !== "POST") return c.body(null, 405);
    try {
      const target = c.req.query("path");
      if (!target) return c.text("Missing path query parameter", 400);
      const resolved = resolveRootedPath(spaceRoot, target, "read");
      const mediaType = videoMediaTypeForPath(resolved.filePath);
      if (!mediaType) return c.text("Only a video has facts without a thumbnail", 400);
      const version = c.req.query("version");
      if (!version || !isFileVersion(version)) return c.text("Missing or malformed version query parameter", 400);
      const stats = await stat(resolved.filePath);
      if (!stats.isFile()) return c.text("Not a file", 400);
      const key = { root: resolved.rootDir, file: resolved.filePath, version: fileVersion(stats) };
      if (version !== key.version) return c.text("The file has changed since it was listed", 409);

      const header = await withHeaderReader(resolved.filePath, (read, size) => readClipHeader(mediaType, read, size));
      const facts: ThumbnailFacts = {
        width: header.width ?? 0,
        height: header.height ?? 0,
        ...(header.duration === null ? {} : { duration: header.duration }),
        thumbnail: false,
        clip: clipDetails(header),
      };
      if (!parseFacts(facts)) return c.text("The clip's header gives no picture size", 422);
      await thumbnails.write(key, null, facts);
      const { width, height, duration, clip } = facts;
      return c.json<ClipFactsResponse>({
        width,
        height,
        ...(duration === undefined ? {} : { duration }),
        clip: clip ?? NO_CLIP_DETAILS,
      });
    } catch (error) {
      if (error instanceof UnreadableVideoFormat) return c.text(error.message, 422);
      throw error;
    }
  });

  // What the install's thumbnails take, for Settings, and clearing them all.
  app.get("/api/thumbnails", async (c) => {
    return c.json<ThumbnailUsageResponse>(await thumbnails.usage());
  });
  app.all("/api/thumbnails/clear", async (c) => {
    if (c.req.method !== "POST") return c.body(null, 405);
    await thumbnails.clear();
    return c.body(null, 204);
  });

  // A clip's details for the video pane's Info, the same way — see videoFormat.ts.
  app.get("/api/file/video-format", async (c) => {
    try {
      const relativePath = c.req.query("path");
      if (!relativePath) return c.text("Missing path query parameter", 400);

      const { filePath } = resolveRootedPath(spaceRoot, relativePath, "read");
      const mediaType = videoMediaTypeForPath(filePath);
      if (!mediaType) return c.text("Not a video", 400);

      return c.json<ClipHeaderResponse>(
        await withHeaderReader(filePath, (read, size) => readClipHeader(mediaType, read, size)),
      );
    } catch (error) {
      if (error instanceof UnreadableVideoFormat) return c.text(error.message, 422);
      throw error;
    }
  });

  // A Links row's description, by the rule a gallery card's is read by. A
  // route of its own, like the hash, so /api/file/info stays stat-only, and so
  // a row never downloads a whole document, or an Applet's imports, for a line.
  app.get("/api/file/description", async (c) => {
    const relativePath = c.req.query("path");
    if (!relativePath) return c.text("Missing path query parameter", 400);

    const { filePath } = resolveRootedPath(spaceRoot, relativePath, "read");
    const type = (await stat(filePath)).isDirectory() ? "directory" : "file";
    const description = entryDescription(path.dirname(filePath), path.basename(filePath), type);
    return c.json<FileDescriptionResponse>(description ? { description } : {});
  });

  // The Links tab's Backlinks. A library document can be named from the space
  // as `lib:<id>/…` as well as from inside its library, so both are read.
  app.get("/api/file/backlinks", async (c) => {
    const relativePath = c.req.query("path");
    if (!relativePath) return c.text("Missing path query parameter", 400);

    const resolved = resolveRootedPath(spaceRoot, relativePath, "read");
    const space: IndexRoot = { dir: spaceRoot, root: "space" };
    const roots = isSpaceTarget(resolved) ? [space] : [{ dir: resolved.rootDir, root: resolved.rooted.root }, space];
    const backlinks = await documentIndex().backlinks(formatRootedPath(resolved.rooted), roots, presetPaths(spaceRoot));
    return c.json<BacklinksResponse>({ backlinks });
  });

  // The assistant's Info tab: facts every entry has, for any kind. Stat only —
  // never a read — so it costs the same for a gigabyte take as for a note.
  // An empty path is the space's own folder, whose gallery asks too.
  app.get("/api/file/info", async (c) => {
    const relativePath = c.req.query("path");
    if (relativePath === undefined) return c.text("Missing path query parameter", 400);

    const { filePath } = resolveRootedPath(spaceRoot, relativePath, "read");
    const info = await stat(filePath);
    return c.json<FileInfoResponse>({
      kind: info.isDirectory() ? "directory" : "file",
      name: path.basename(filePath),
      size: info.size,
      modified: info.mtime.toISOString(),
      systemFolder: path.dirname(filePath),
      systemPath: filePath,
    });
  });

  app.all("/api/file", async (c) => {
    const relativePath = c.req.query("path");
    if (!relativePath) return c.text("Missing path query parameter", 400);

    // Reads may name a library (`lib:<id>/…`); writes are resolved for
    // write access, so a read-only root refuses here with a 403 rather
    // than anywhere downstream having to know libraries exist.
    const write = c.req.method === "PUT";
    const resolved = resolveRootedPath(spaceRoot, relativePath, write ? "write" : "read");
    const { filePath, rooted } = resolved;
    const inSpace = !isLibraryRoot(rooted.root);

    if (c.req.method === "GET") {
      // Media never comes back through this route. An image or a PDF
      // decoded as utf8 is mangled, and a video decoded as utf8 is a
      // gigabyte-scale string built to be thrown away — each has a pane
      // that reads /api/file/raw instead. Checked before anything below
      // reads the file.
      if (mediaTypeForPath(filePath)) {
        return c.text("This is an image, video or PDF file. Its contents can't be read as text.", 400);
      }

      // Hashed before anything below reads the file again, never after: a
      // write landing between the two then pairs newer content with an
      // older revision, and costs one needless conflict. The other order
      // would pair older content with the newer revision, and a save
      // built from it would overwrite that write unrefused.
      //
      // A missing file hashes as empty, the way the parsers read one.
      const bytes = await readFile(filePath).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      const revision = revisionOf(bytes ?? "");
      // Decoded once for the branches below, so their content and the
      // revision come from one read; the applet's reader opens the file
      // itself, hence the order above.
      const text = bytes?.toString("utf8") ?? "";
      // The text this window now holds, kept if something outside Pragma
      // writes over it before the window next saves.
      if (inSpace && bytes !== undefined) noteKnown(spaceRoot, filePath, text);

      // Tables: docs/protocol.md's Tables section. No dedicated write
      // route — the client re-serializes the whole table to HTML and saves
      // it through the PUT branch below like any other file.
      if (isTableFile(filePath)) {
        const parsed = parseTableFile(text);
        const table = parsed ?? emptyTable();
        const localLayout = (await readTableLayouts(spaceRoot))[formatWithinRoot(resolved, filePath)];
        return c.json<TableFileResponse>({
          kind: "table",
          path: relativePath,
          revision,
          version: table.version,
          name: table.name,
          metadata: table.metadata,
          columns: table.columns,
          rows: table.rows,
          layout: table.layout,
          ...(localLayout ? { localLayout } : {}),
          locked: lockFor(parsed),
          ...(bytes === undefined ? { missing: true as const } : {}),
        });
      }

      // Classes: the definition only. Its rows are its notes', read by
      // /api/space/class as they change.
      if (isClassFile(filePath)) {
        const parsed = parseClassFile(text);
        return c.json<ClassFileResponse>({
          kind: "class",
          path: relativePath,
          revision,
          ...(parsed ?? emptyClass()),
          locked: lockFor(parsed),
        });
      }

      // Applets: self-contained HTML carrying real logic, sandboxed
      // client-side (docs/protocol.md's Applets section). `html` is the full
      // raw file, script tags included, for a sandboxed iframe's srcdoc.
      if (isAppletFile(filePath)) {
        const { manifest, html } = await readAppletFile(filePath);
        // From the resolved path, not the request's spelling: an Applet
        // opened as `space:a/x.applet.html` imports from `a`.
        const { imports, error: importError } = await readAppletImports(
          spaceRoot,
          dirnameOf(inSpace ? rooted.path : relativePath),
          manifest,
        );
        return c.json<AppletFileResponse>({
          kind: "applet",
          path: relativePath,
          revision,
          manifest,
          html,
          contentHash: contentHashFor(
            html,
            imports.map((entry) => entry.source),
          ),
          imports,
          ...(importError ? { importError } : {}),
        });
      }

      // Flows: docs/protocol.md's Flows section. Unlike an applet's
      // manifest, `capabilities` is never stored: a Flow graph is
      // statically walkable, so it's derived from the graph on every read
      // and can't drift from what the graph actually does.
      if (isFlowFile(filePath)) {
        const parsed = parseFlowFile(text);
        const { version, name, metadata, graph } = parsed ?? emptyFlowFile(text);
        const capabilities = computeFlowCapabilities(graph, relativePath);
        const flowSubject = { path: grantPath(spaceRoot, filePath), contentHash: capabilityDigest(graph) };
        const unattended = await unattendedStanding(spaceRoot, flowSubject);
        const localAppMode = (await readFlowAppModes(spaceRoot))[formatWithinRoot(resolved, filePath)];
        return c.json<FlowFileResponse>({
          kind: "flow",
          path: relativePath,
          revision,
          version,
          name,
          metadata,
          graph,
          ...(localAppMode === undefined ? {} : { localAppMode }),
          capabilities,
          grantedCapabilities: await grantedCapabilities(spaceRoot, flowSubject),
          runsUnattended: unattended.allowed,
          unattendedUntil: unattended.until,
          locked: lockFor(parsed),
        });
      }

      if (bytes === undefined) return c.text("Not found", 404);
      const documentType = documentTypeFor(filePath);

      // Toolkits come from the Classes holding the document as a row
      // (docs/protocol.md's Toolkit resolution). Every candidate is sent
      // down, in order, so the client can offer all of them. The other
      // files those Classes link go to the Links tab.
      //
      // Toolkits are space machinery: resolution reads the space's own
      // Classes, and a library document has none, nor any use for buttons
      // that would write to a root it can't write to.
      const classes = inSpace ? await classesLinking(spaceRoot, { path: rooted.path, filePath }) : [];
      const toolkits = await Promise.all(
        resolveToolkits(spaceRoot, classes).map(async ({ classPath, path: flowPath }): Promise<TextToolkitInfo> => {
          const { name, graph } = await readFlowFile(path.join(spaceRoot, flowPath));
          return { classPath, path: flowPath, name: name ?? "", actions: flowActions(graph) };
        }),
      );

      return c.json<TextFileResponse>({
        kind: "text",
        path: relativePath,
        revision,
        content: text,
        documentType,
        toolkits,
        classLinks: classLinkedFiles(spaceRoot, classes, rooted.path),
      });
    }

    if (c.req.method === "PUT") {
      const body = (await c.req.json()) as PutFileRequestBody;
      return await withFileLock(filePath, async () => {
        if (body.baseRevision !== undefined && (await readRevision(filePath)) !== body.baseRevision) {
          return c.text("The file changed since this copy of it was read", 409);
        }
        const source = body.source === "copilot" || body.source === "restored" ? body.source : "edit";
        // A restore may bring back a deleted file, and the folder it was in.
        if (source === "restored") await mkdir(path.dirname(filePath), { recursive: true });
        const saved = await saveDocument(spaceRoot, { filePath, relativePath }, body.content, source);
        return c.json<PutFileResponse>(saved);
      });
    }

    return c.body(null, 405);
  });
}
