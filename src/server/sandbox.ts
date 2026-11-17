// The sandbox broker's server half: given a request's `kind` and document
// path, the grant subject its approvals are checked against (grants.ts) and
// which capabilities the document declares — a Flow's, derived from its
// graph.
//
// The /api/sandbox/* routes do nothing kind-specific themselves: everything
// that differs between kinds is a row in KINDS below, so another kind is
// another row, not another set of handlers.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { findSpaceId, loadGlobalConfig } from "../config/loadConfig.ts";
import {
  type AddRowResponse,
  EFFORT_LEVELS,
  type GenerateImageRequestBody,
  type GenerateImageResponse,
  type GenerateOptionsRequestBody,
  type GenerateOptionsResponse,
  type GenerateRequestBody,
  type GenerateResponse,
  type GenerateVideoRequestBody,
  type GenerateVideoResponse,
  isEffortLevel,
  type ReferenceImagePayload,
  type SandboxKind,
  type SandboxReadResult,
} from "../protocol/api.ts";
import { generationEffort } from "../protocol/dispatchAction.ts";
import { fileStemFor } from "../protocol/entryName.ts";
import { capabilityDigest, readFlowFile } from "../protocol/flowFile.ts";
import type { AffixMode } from "../protocol/flowNodes.ts";
import {
  computeFlowCapabilities,
  type WiredAccess,
  type WiredPin,
  wiredCapability,
  wiredCapabilityOfKey,
  wiredPathAccess,
} from "../protocol/flowNodes.ts";
import { callImageModel } from "../protocol/imageGeneration.ts";
import { addTextToNote } from "../protocol/markdownTitle.ts";
import { stampTableDates } from "../protocol/metadata.ts";
import { DEFAULT_IMAGE_MENTION, mentionedImagePins, spellImageMentions } from "../protocol/referenceMentions.ts";
import { formatRootPath, formatWrittenPath, resolveDeclaredPath } from "../protocol/relativeReference.ts";
import {
  dirnameOf,
  formatDeclaredPath,
  formatRootedPath,
  isLibraryRoot,
  type RootedPath,
} from "../protocol/rootedPath.ts";
import type { ScopeFolders } from "../protocol/scopes.ts";
import { emptyTable, parseTableFile } from "../protocol/tableFile.ts";
import { serializeTableFile } from "../protocol/tableHtml.ts";
import {
  type ContextFile,
  type ContextMessage,
  type ContextSent,
  flowCapabilityKey,
  holdsPath,
  isFlowFile,
  isMarkdownFile,
  isNewerFormatVersion,
  isTableFile,
  newRowValue,
  noFileAt,
  rasterImageMediaTypeForPath,
} from "../protocol/types.ts";
import { startVideoJob } from "../protocol/videoGeneration.ts";
import { resolutionName, resolutionShortSide, resolutionSize } from "../protocol/videoResolution.ts";
import { runGenerate, runGenerateOptions } from "./actionHandler.ts";
import { type ContextLook, lookFurther, refusesTools } from "./contextLook.ts";
import { findResult, IMAGE_EXTENSIONS_BY_TYPE } from "./generatedResults.ts";
import { type GrantSubject, grantPath, isCapabilityGranted } from "./grants.ts";
import { writeDocument } from "./history.ts";
import { type JobOutcome, type JobRunner, jobRunner } from "./jobRunner.ts";
import type { JobRecord } from "./jobs.ts";
import { type ResolvedImageModel, type ResolvedVideoModel, resolveImageModel } from "./mediaModels.ts";
import { modelSupport } from "./modelSupport.ts";
import { placeContext, readContext } from "./pathContext.ts";
import { resolveHeldPath } from "./rootedFiles.ts";
import { recordDocumentChange } from "./saveDocument.ts";
import { readSpaceFile, resolveWithinSpace, withFileLock, writeFileAtomic } from "./spaceFiles.ts";
import { listRootPaths, scopesOnDisk } from "./tree.ts";

// One declared capability, kind-agnostic: its grant key, plus the type and
// target address the read and write routes match a request against.
export interface SandboxCapability {
  key: string;
  type: string;
  path?: string;
}

export interface SandboxDocument {
  kind: SandboxKind;
  // The grant key (grants.ts) of the file the request named.
  path: string;
  subject: GrantSubject;
  // "This flow" — the subject of a refusal message.
  label: string;
  capabilities: SandboxCapability[];
  // What the document's wired path pins may ask for, beyond `capabilities`:
  // a path a wire chose is no declaration, so it is allowed by the pin and
  // asked for per file, or for a context per scope. Empty for a document
  // with no such pin.
  wired: ReadonlySet<WiredPin>;
}

// A request the broker refuses before touching anything: a malformed body,
// a kind the path doesn't match, an undeclared capability (400), or a
// declared one the writer hasn't granted (403).
// 502 is a provider that failed the call, as opposed to a request pragma
// refused.
export class SandboxRequestError extends Error {
  readonly status: 400 | 403 | 404 | 502;

  constructor(status: 400 | 403 | 404 | 502, message: string) {
    super(message);
    this.status = status;
  }
}

interface KindRow {
  isFile(filePath: string): boolean;
  // `docPath` is the document's path in the space, which its paths are read
  // from.
  read(
    filePath: string,
    docPath: string,
  ): Promise<{ contentHash: string; capabilities: SandboxCapability[]; wired: ReadonlySet<WiredPin> }>;
}

const KINDS: Record<SandboxKind, KindRow> = {
  flow: {
    isFile: isFlowFile,
    async read(filePath, docPath) {
      const { graph } = await readFlowFile(filePath);
      return {
        contentHash: capabilityDigest(graph),
        capabilities: computeFlowCapabilities(graph, docPath).map((capability) => ({
          key: flowCapabilityKey(capability),
          type: capability.type,
          path: "path" in capability ? capability.path : undefined,
        })),
        wired: wiredPathAccess(graph),
      };
    },
  },
};

export function isSandboxKind(value: unknown): value is SandboxKind {
  return typeof value === "string" && Object.keys(KINDS).includes(value);
}

/** Reads the document a broker request names. A kind the path's extension
 * doesn't match is refused: a request can't borrow one kind's rules for a
 * file of another. */
export async function readSandboxDocument(
  spaceRoot: string,
  kind: unknown,
  relativePath: unknown,
): Promise<SandboxDocument> {
  if (!isSandboxKind(kind)) throw new SandboxRequestError(400, "Unknown sandbox kind");
  if (typeof relativePath !== "string" || !relativePath) throw new SandboxRequestError(400, "Missing path");
  const row = KINDS[kind];
  if (!row.isFile(relativePath)) throw new SandboxRequestError(400, `Not a ${kind} document: ${relativePath}`);
  const filePath = resolveWithinSpace(spaceRoot, relativePath);
  const docPath = grantPath(spaceRoot, filePath);
  const { contentHash, capabilities, wired } = await row.read(filePath, docPath);
  return { kind, path: docPath, subject: { path: docPath, contentHash }, label: `This ${kind}`, capabilities, wired };
}

/** The declaration of `type` a request for `target` falls under, if any:
 * one naming the file itself or its folder — flat containment, matching a
 * Flow's folder nodes' non-recursive listing.
 *
 * Compared as addresses, so a request finds its declaration however either
 * spells the path, and a library's file only matches a declaration naming
 * that library. */
function declaredFor(doc: SandboxDocument, type: string, target: RootedPath): SandboxCapability | undefined {
  const address = formatDeclaredPath(target);
  const folder = target.path === "" ? undefined : formatDeclaredPath(folderOf(target));
  return doc.capabilities.find(
    (capability) => capability.type === type && (capability.path === address || capability.path === folder),
  );
}

/** The declared read `target` falls under, if any: the file or its folder. */
export function findReadCapability(doc: SandboxDocument, target: RootedPath): SandboxCapability | undefined {
  return declaredFor(doc, "readFile", target);
}

/** Reads a granted target, parsed by its kind. `resolvedTargetPath` is a
 * rooted path (the space written bare), already
 * resolved from its document-relative form; the rooted resolver, not the
 * space's, lands a library path in its own root and refuses an unregistered
 * library.
 *
 * Only raster images are read from a library (protocol.md's Capabilities and
 * grants): the Table reader would work there, but a library listed for
 * display is no permission to hand its content to a running graph.
 */
export async function readSandboxTarget(spaceRoot: string, resolvedTargetPath: string): Promise<SandboxReadResult> {
  const { filePath, rooted } = resolveHeldPath(spaceRoot, resolvedTargetPath, "read");
  const inLibrary = isLibraryRoot(rooted.root);

  try {
    const mediaType = rasterImageMediaTypeForPath(filePath);
    if (mediaType) return { kind: "image", mediaType, data: (await readFile(filePath)).toString("base64") };
    // Not readTableFile: it reads a file that isn't there as an empty one,
    // and a Flow would run on nothing. Blank or unparseable text still reads
    // as empty, as it does there. Through the space read, so a private one is
    // refused as a private note is.
    if (!inLibrary && isTableFile(filePath)) {
      const table = parseTableFile(await readSpaceFile(spaceRoot, rooted.path)) ?? emptyTable();
      return { kind: "table", columns: table.columns, rows: table.rows };
    }

    if (inLibrary) {
      throw new SandboxRequestError(400, `Only raster images can be read from a library: "${resolvedTargetPath}"`);
    }
    return { kind: "text", content: await readSpaceFile(spaceRoot, rooted.path) };
  } catch (error) {
    // A graph keeps a path after its file moves or goes, and the raw ENOENT
    // names the absolute path on disk rather than the one the graph stores.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new SandboxRequestError(404, noFileAt(resolvedTargetPath));
    }
    throw error;
  }
}

// ── Performing a granted capability ─────────────────────────────────────
//
// The enforcement half, kept here rather than inside the /api/sandbox/*
// route closures so a second caller can't get a second copy of it: the
// headless Flow runner (flowRun.ts) calls these rather than re-deriving the
// checks, since server-side enforcement only holds while there is one
// implementation of it.

async function requireGranted(spaceRoot: string, doc: SandboxDocument, key: string): Promise<void> {
  if (!(await isCapabilityGranted(spaceRoot, doc.subject, key))) {
    throw new SandboxRequestError(403, `${doc.label} hasn't been granted "${key}"`);
  }
}

/** Where a path a request names leads, read from the document's folder as
 * the document's own paths are, before any capability is matched. */
function resolveDeclared(doc: SandboxDocument, declaredPath: string): RootedPath {
  try {
    return resolveDeclaredPath(dirnameOf(doc.path), declaredPath);
  } catch (error) {
    throw new SandboxRequestError(400, error instanceof Error ? error.message : String(error));
  }
}

/** The capability a wired path asks for, when the document has a pin a wire
 * could bring it on. It is no declaration: its key is as good as a person's
 * allowing it. */
function wiredRequest(doc: SandboxDocument, access: WiredAccess, target: RootedPath): SandboxCapability | undefined {
  const capability = wiredCapability(doc.wired, access, formatDeclaredPath(target));
  return capability && { key: flowCapabilityKey(capability), type: capability.type, path: capability.path };
}

function folderOf(target: RootedPath): RootedPath {
  return { root: target.root, path: dirnameOf(target.path) };
}

/** Refuses a write of `target` the document doesn't declare, or hasn't been
 * granted: every write the sandbox makes asks here, by the same match. A
 * wired path asks for its file, or for its folder when a node writes into
 * one, so either key allows the write once granted. */
async function requireWrite(spaceRoot: string, doc: SandboxDocument, target: RootedPath, asked: string): Promise<void> {
  const candidates = [
    declaredFor(doc, "writeDocument", target),
    wiredRequest(doc, "write", target),
    target.path === "" ? undefined : wiredRequest(doc, "write", folderOf(target)),
  ].filter((capability) => capability !== undefined);
  if (candidates.length === 0) throw new SandboxRequestError(400, `${doc.label} doesn't declare a write of "${asked}"`);
  for (const capability of candidates) {
    if (await isCapabilityGranted(spaceRoot, doc.subject, capability.key)) return;
  }
  throw new SandboxRequestError(403, `${doc.label} hasn't been granted "${candidates[0].key}"`);
}

/** Whether the document may be asked to grant `key`: a capability it
 * declares, or a wired path its pins could bring. The consent routes check
 * this, so a tampered client can't record or clear one it never asked for. */
export function declaresCapability(doc: SandboxDocument, key: string): boolean {
  return (
    doc.capabilities.some((candidate) => candidate.key === key) || wiredCapabilityOfKey(doc.wired, key) !== undefined
  );
}

/** Reads a target the document declares, or one a wire chose, and has been
 * granted. Throws SandboxRequestError when it allows no such read, or allows
 * one that nobody has approved. */
export async function performSandboxRead(
  spaceRoot: string,
  doc: SandboxDocument,
  targetPath: string,
): Promise<SandboxReadResult> {
  const target = resolveDeclared(doc, targetPath);
  const capability = findReadCapability(doc, target) ?? wiredRequest(doc, "read", target);
  if (!capability) throw new SandboxRequestError(400, `${doc.label} doesn't declare a read of "${targetPath}"`);
  await requireGranted(spaceRoot, doc, capability.key);
  return readSandboxTarget(spaceRoot, formatRootedPath(target));
}

/** Writes `content` over a target the document declares and has been
 * granted: a plain utf8 write with no format enforcement, deliberately, since
 * a write to a granted path is the same overwrite as the document's own
 * save. */
export async function performSandboxWrite(
  spaceRoot: string,
  doc: SandboxDocument,
  targetPath: string,
  content: string,
): Promise<void> {
  const target = resolveDeclared(doc, targetPath);
  await requireWrite(spaceRoot, doc, target, targetPath);
  // Resolved for write, not read: no node produces a `writeDocument` naming a
  // library, so only a hand-edited graph carries one, and the doorway is
  // what refuses it on a read-only library.
  const { filePath, rooted } = resolveHeldPath(spaceRoot, formatRootedPath(target), "write");
  // A missing folder is refused, never made: a mistyped path would leave a
  // stray one behind.
  if (!(await stat(path.dirname(filePath)).catch(() => undefined))?.isDirectory()) {
    throw new SandboxRequestError(400, `"${formatRootPath(folderOf(target), true)}" isn't a folder`);
  }
  await writeDocument(spaceRoot, filePath, content, { source: "flow", detail: doc.path });
  await recordGrantedWrite(spaceRoot, filePath, rooted, content);
}

/** A granted write still owes the site the pending entry and `updated`
 * stamp an editor save does. Not the editor's save path: that would also
 * carry a flow's grants across the write, and consent belongs to the human
 * who granted it. A library target belongs to no site, so it skips this. */
async function recordGrantedWrite(
  spaceRoot: string,
  filePath: string,
  rooted: RootedPath,
  content: string,
): Promise<void> {
  if (isLibraryRoot(rooted.root)) return;
  const relativePath = path.relative(spaceRoot, filePath).split(path.sep).join("/");
  await recordDocumentChange(spaceRoot, { filePath, relativePath }, content);
}

/** Adds `text` to a note the document declares a write of and has been
 * granted: at its end, or where its body starts. Under the lock an editor
 * save takes, as Add Row's append is, and a gone note is refused rather than
 * read as an empty one. */
export async function performSandboxAddToNote(
  spaceRoot: string,
  doc: SandboxDocument,
  targetPath: string,
  text: string,
  mode: AffixMode,
): Promise<void> {
  const resolved = resolveDeclared(doc, targetPath);
  await requireWrite(spaceRoot, doc, resolved, targetPath);
  const target = formatRootedPath(resolved);
  if (!isMarkdownFile(target)) throw new SandboxRequestError(400, `"${targetPath}" isn't a markdown note`);
  const { filePath, rooted } = resolveHeldPath(spaceRoot, target, "write");

  await withFileLock(filePath, async () => {
    const before = await readFile(filePath, "utf8").catch(() => undefined);
    if (before === undefined) throw new SandboxRequestError(400, noFileAt(target));
    const content = addTextToNote(before, text, mode);
    if (content === before) return;
    await writeDocument(spaceRoot, filePath, content, { source: "flow", detail: doc.path });
    await recordGrantedWrite(spaceRoot, filePath, rooted, content);
  });
}

// A Flow names an entry from its own folder; a Table's media or path cell
// names one from the Table's, as a note's link does, by the scope rule. The
// same entry, re-spelled for where it is written, a folder keeping its `/`.
function cellPath(flowDir: string, tableDir: string, value: string, scopes: ScopeFolders): string {
  let target: RootedPath;
  try {
    target = resolveDeclaredPath(flowDir, value);
  } catch (error) {
    throw new SandboxRequestError(400, error instanceof Error ? error.message : String(error));
  }
  const folder = /[/\\]$/.test(value);
  const reference = formatWrittenPath(tableDir, target, { form: "markdown", scopes, folder });
  if (reference === undefined) {
    throw new SandboxRequestError(400, `A Table in a library can only name files in that library, not "${value}"`);
  }
  return reference;
}

/** Adds one row to a Table the document declares a write of and has been
 * granted, returning the Table's path from the space root. Taken under the
 * lock an editor save takes: an append reads then writes, and a save landing
 * between the two would be overwritten rather than refused as stale. */
export async function performSandboxAddRow(
  spaceRoot: string,
  doc: SandboxDocument,
  targetPath: string,
  values: Record<string, string>,
): Promise<AddRowResponse> {
  const resolved = resolveDeclared(doc, targetPath);
  await requireWrite(spaceRoot, doc, resolved, targetPath);
  const flowDir = dirnameOf(doc.path);
  const target = formatRootedPath(resolved);
  if (!isTableFile(target)) throw new SandboxRequestError(400, `"${targetPath}" isn't a table`);
  const { filePath, rooted } = resolveHeldPath(spaceRoot, target, "write");
  const tableDir = dirnameOf(formatRootedPath(rooted));

  return withFileLock(filePath, async () => {
    const raw = await readFile(filePath, "utf8").catch(() => undefined);
    // The resolved path, unlike the messages below: a read's 404 names it so,
    // and a gone Table should read the same from Add Row as from a loader.
    if (raw === undefined) throw new SandboxRequestError(400, noFileAt(target));
    const table = parseTableFile(raw);
    // Written back whole, as any save is, so a file this build can't fully
    // read is refused rather than saved over with what it could.
    if (!table || isNewerFormatVersion(table.version)) {
      throw new SandboxRequestError(400, `"${targetPath}" is a Table this version of Pragma can't fully read`);
    }
    if (table.columns.length === 0) throw new SandboxRequestError(400, `"${targetPath}" has no columns yet`);
    const unknown = Object.keys(values).find((id) => !table.columns.some((column) => column.id === id));
    if (unknown !== undefined) throw new SandboxRequestError(400, `"${targetPath}" has no column "${unknown}"`);

    const now = new Date();
    const scopes = scopesOnDisk(spaceRoot);
    const row: Record<string, string> = {};
    for (const column of table.columns) {
      const given = values[column.id];
      if (given === undefined) row[column.id] = newRowValue(column, now);
      else
        row[column.id] =
          holdsPath(column.type) && given.trim() ? cellPath(flowDir, tableDir, given.trim(), scopes) : given;
    }
    table.rows.push({ values: row });
    const today = now.toISOString().slice(0, 10);
    table.metadata = stampTableDates(table.metadata, today);
    const content = serializeTableFile(table);
    await writeDocument(spaceRoot, filePath, content, { source: "flow", detail: doc.path });
    await recordGrantedWrite(spaceRoot, filePath, rooted, content);
    return { path: formatRootedPath(rooted) };
  });
}

/** One `generateText` grant covers generate-options too: a different response
 * shape off the same model-call trust boundary, not a separate grantable
 * capability. */
export async function requireGenerate(spaceRoot: string, doc: SandboxDocument): Promise<void> {
  if (!doc.capabilities.some((candidate) => candidate.type === "generateText")) {
    throw new SandboxRequestError(400, `${doc.label} doesn't declare the generateText capability`);
  }
  await requireGranted(spaceRoot, doc, "generateText");
}

interface RequestContext {
  // The path as the trace shows it.
  shown: string;
  files: ContextFile[];
  messages: ContextMessage[];
  look: ContextLook;
}

/** The files a generation request's `context` starts from, once the scope
 * its path sits in is granted, and the look further in that scope's folder.
 * Undefined for a request without one. The scope is worked out here, never
 * taken from the request, so a grant covers only its folder. */
async function requestContext(
  spaceRoot: string,
  doc: SandboxDocument,
  body: GenerateRequestBody,
): Promise<RequestContext | undefined> {
  const address: unknown = body.context;
  if (address === undefined) return undefined;
  if (typeof address !== "string" || !address.trim()) throw new SandboxRequestError(400, "context must be a path");
  const target = resolveDeclared(doc, address);
  if (isLibraryRoot(target.root)) {
    throw new SandboxRequestError(400, `"${address}" is in a library, which has no context to send`);
  }
  const listing = await listRootPaths(spaceRoot, "space");
  const place = placeContext(listing, target.path);
  if (!place) throw new SandboxRequestError(404, noFileAt(formatRootPath(target)));
  const capability = wiredCapability(doc.wired, "context", formatDeclaredPath({ root: "space", path: place.scope }));
  if (!capability) throw new SandboxRequestError(400, `${doc.label} has no context pin with a wire`);
  await requireGranted(spaceRoot, doc, flowCapabilityKey(capability));
  const { files, messages } = await readContext(spaceRoot, listing, place);
  const shown = formatRootPath({ root: "space", path: place.path }, place.type === "directory");
  // The look reaches as far as the level the generation will run at.
  const look = await lookFurther(
    spaceRoot,
    listing,
    place,
    files.map((file) => file.path),
    { effort: generationEffort(body.model, body.effort) },
  );
  return { shown, files, messages, look };
}

// A model that takes no tools answers from the starting files alone, and the
// trace says so rather than the run failing over a search it can't make.
async function generateLooking<T>(context: RequestContext, generate: (look?: ContextLook) => Promise<T>): Promise<T> {
  try {
    return await generate(context.look);
  } catch (error) {
    if (!refusesTools(error)) throw error;
    const trace = context.look.trace;
    trace.files = [];
    trace.searches = [];
    const why = (error as Error).message.replace(/\.$/, "");
    trace.messages = [{ level: "warn", text: `Didn't look further: the model can't use tools (${why}).` }];
    return generate();
  }
}

function contextSent(context: RequestContext): ContextSent {
  const { files, searches, messages } = context.look.trace;
  return {
    path: context.shown,
    files: [...context.files.map((file) => file.path), ...files],
    searches,
    messages: [...context.messages, ...messages],
  };
}

// A Flow file names its effort as written, so one that names no level is
// refused, naming the ones there are, rather than run at another.
function requireEffort(effort: unknown): void {
  if (effort !== undefined && !isEffortLevel(effort)) {
    throw new SandboxRequestError(400, `effort must be one of ${EFFORT_LEVELS.join(", ")}`);
  }
}

export async function performSandboxGenerate(
  spaceRoot: string,
  doc: SandboxDocument,
  body: GenerateRequestBody,
  signal?: AbortSignal,
): Promise<GenerateResponse> {
  await requireGenerate(spaceRoot, doc);
  requireEffort(body.effort);
  const context = await requestContext(spaceRoot, doc, body);
  if (!context) return runGenerate(body, signal);
  const result = await generateLooking(context, (look) => runGenerate(body, signal, context.files, look));
  return { ...result, context: contextSent(context) };
}

export async function performSandboxGenerateOptions(
  spaceRoot: string,
  doc: SandboxDocument,
  body: GenerateOptionsRequestBody,
  signal?: AbortSignal,
): Promise<GenerateOptionsResponse> {
  await requireGenerate(spaceRoot, doc);
  requireEffort(body.effort);
  const context = await requestContext(spaceRoot, doc, body);
  if (!context) return runGenerateOptions(body, signal);
  const result = await generateLooking(context, (look) => runGenerateOptions(body, signal, context.files, look));
  return { ...result, context: contextSent(context) };
}

const IMAGE_NAME_EXTENSION = /\.(png|jpe?g|webp|gif)$/i;
const VIDEO_NAME_EXTENSION = /\.(mp4|m4v|webm|mov)$/i;

// The node's `prefix`, which starts the result's name before its digest,
// "image" or "video" when blank: never the prompt, which a folder of results
// would all start alike.
const typedPrefix = (prefix: string | undefined, extension: RegExp) => fileStemFor(prefix ?? "", extension);

// The folder a generation writes into: the one the document declares for
// `type` and has been granted, as a file path, and as the request names it.
async function resultsFolder(
  spaceRoot: string,
  doc: SandboxDocument,
  declared: string,
  type: "generateImage" | "generateVideo",
): Promise<{ folderPath: string; folder: string; rooted: string }> {
  const target = resolveDeclared(doc, declared);
  const address = formatDeclaredPath(target);
  const capability = doc.capabilities.find((candidate) => candidate.type === type && candidate.path === address);
  if (!capability) {
    const what = type === "generateImage" ? "image" : "video";
    throw new SandboxRequestError(400, `${doc.label} doesn't declare ${what} generation into "${declared}"`);
  }
  await requireGranted(spaceRoot, doc, capability.key);
  const rooted = formatRootedPath(target);
  const { filePath: folderPath } = resolveHeldPath(spaceRoot, rooted, "write");
  const folderStat = await stat(folderPath).catch(() => undefined);
  if (!folderStat?.isDirectory()) throw new SandboxRequestError(400, `"${declared}" isn't a folder`);
  return { folderPath, folder: declared.replace(/\/+$/, ""), rooted };
}

interface SentReferences {
  prompt: string;
  references: Array<{ mediaType: string; data: Uint8Array }>;
  warnings: string[];
}

// The references a model gets, and the prompt naming them in its words for
// a reference (docs/model-support.md). Past the number the model takes, the
// rest are left out and said so, and a prompt naming one of those is refused.
function sentReferences(
  prompt: string,
  given: readonly ReferenceImagePayload[],
  resolved: { modelId: string; host?: string },
  model: string,
): SentReferences {
  const support = modelSupport(resolved.modelId, resolved.host);
  const limit = support.references.image;
  const kept = limit === undefined ? given : given.slice(0, limit);
  const leftOut = given.slice(kept.length).map((reference) => `image_${reference.pin}`);
  const takes = `${model} takes ${limit} reference ${limit === 1 ? "image" : "images"}`;
  for (const pin of mentionedImagePins(prompt)) {
    if (leftOut.includes(`image_${pin}`)) {
      throw new SandboxRequestError(400, `The prompt names @image_${pin}, but ${takes}, so image_${pin} was left out`);
    }
  }
  let spelled: string;
  try {
    spelled = spellImageMentions(
      prompt,
      kept.map((reference) => reference.pin),
      support.mention.image ?? DEFAULT_IMAGE_MENTION,
    );
  } catch (error) {
    throw new SandboxRequestError(400, error instanceof Error ? error.message : String(error));
  }
  return {
    prompt: spelled,
    references: kept.map((reference) => ({
      mediaType: reference.mediaType,
      data: new Uint8Array(Buffer.from(reference.data, "base64")),
    })),
    warnings: leftOut.length
      ? [`${takes}, so ${leftOut.join(", ")} ${leftOut.length === 1 ? "was" : "were"} left out`]
      : [],
  };
}

/** An image already in the folder for a request's inputs, one made at
 * once, or the job recorded to make it, with whether an earlier request
 * started that job. */
export type StartedImage =
  | { found: GenerateImageResponse }
  | { job: JobRecord; resumed: boolean; folder: string; model: string };

/** Generates an image into the folder the document declares and has been
 * granted, or hands back the one already there for the same inputs. The
 * inputs are the resolved model ref, the prompt, the reference images'
 * bytes, the aspect ratio and the seed; a result is found by their digest
 * in its name, so nothing about a run is written into the Flow.
 *
 * The `prefix` is not one of the inputs: a new prefix on the same inputs
 * copies the image to it rather than paying again. A file named by an older
 * scheme is found all the same, since only the digest is matched.
 *
 * A model whose provider makes each image as a job has the job recorded and
 * followed, as a clip's is; any other makes it within the request. */
export async function startSandboxGenerateImage(
  spaceRoot: string,
  doc: SandboxDocument,
  body: GenerateImageRequestBody,
  signal?: AbortSignal,
  // Tests stand a mock model, and a runner over a mock store, in for the configured ones.
  resolve: (ref: string | undefined) => ResolvedImageModel = resolveImageModel,
  runner: JobRunner = jobRunner(),
): Promise<StartedImage> {
  const { folderPath, folder, rooted } = await resultsFolder(spaceRoot, doc, body.folder, "generateImage");

  let resolved: ResolvedImageModel;
  try {
    resolved = resolve(body.model);
  } catch (error) {
    throw new SandboxRequestError(400, error instanceof Error ? error.message : String(error));
  }
  const model = `${resolved.providerId}/${resolved.modelId}`;
  const { prompt, references, warnings } = sentReferences(body.prompt, body.references, resolved, model);
  const key = createHash("sha256")
    .update(
      JSON.stringify({
        model,
        prompt,
        references: references.map((reference) => createHash("sha256").update(reference.data).digest("hex")),
        aspectRatio: body.aspectRatio ?? "",
        seed: body.seed ?? "",
      }),
    )
    .digest("hex");
  const digest = key.slice(0, 12);
  const named = typedPrefix(body.prefix, IMAGE_NAME_EXTENSION);
  const stem = `${named || "image"}-${digest}`;
  const existing = await findResult(folderPath, stem, digest, named);
  if (existing) {
    const { found, kept } = existing;
    const data = await readFile(path.join(folderPath, found));
    if (kept !== found) await writeFileAtomic(path.join(folderPath, kept), data);
    const mediaType = rasterImageMediaTypeForPath(kept) ?? "application/octet-stream";
    return {
      found: {
        image: { mediaType, data: data.toString("base64") },
        path: `${folder}/${kept}`,
        model,
        reused: true,
        warnings: [],
      },
    };
  }

  const seed = body.seed && /^\d+$/.test(body.seed) ? Number(body.seed) : undefined;
  const aspectRatio = body.aspectRatio as `${number}:${number}` | undefined;
  const jobs = resolved.jobs;
  if (!jobs) {
    let result: Awaited<ReturnType<typeof callImageModel>>;
    try {
      result = await callImageModel(resolved.model, { prompt, references, aspectRatio, seed, signal });
    } catch (error) {
      throw new SandboxRequestError(502, error instanceof Error ? error.message : String(error));
    }
    const name = `${stem}.${IMAGE_EXTENSIONS_BY_TYPE[result.mediaType] ?? "png"}`;
    await writeFileAtomic(path.join(folderPath, name), result.data);
    return {
      found: {
        image: { mediaType: result.mediaType, data: Buffer.from(result.data).toString("base64") },
        path: `${folder}/${name}`,
        model,
        reused: false,
        warnings: [...warnings, ...result.warnings],
        ...(result.notes.length ? { notes: result.notes } : {}),
        ...(result.cost ? { cost: result.cost } : {}),
      },
    };
  }

  const spaceId = findSpaceId(loadGlobalConfig(), spaceRoot);
  if (spaceId === undefined) throw new Error(`${spaceRoot} is not a registered space`);
  let job = await runner.live(key);
  let resumed = job !== undefined;
  if (!job) {
    try {
      // Never stopped by a request's abort, as a clip's start isn't.
      const begun = await runner.begin(
        {
          kind: "image",
          digest: key,
          spaceId,
          document: doc.path,
          folder: rooted,
          folderName: folder,
          stem,
          prefix: named,
          model,
          summary: summaryOf(body.prompt),
        },
        async () => {
          const started = await jobs.start({ prompt, references, aspectRatio, seed });
          return { ...started, warnings: [...warnings, ...started.warnings] };
        },
      );
      job = begun.job;
      resumed = begun.joined;
    } catch (error) {
      throw new SandboxRequestError(502, error instanceof Error ? error.message : String(error));
    }
  }
  runner.follow(job);
  return { job, resumed, folder, model };
}

/** What a run hands on once its image job saved `file`, as a clip's run
 * does: only the request that started the job reports what it cost. */
export async function imageResponse(
  spaceRoot: string,
  started: { job: JobRecord; resumed: boolean; folder: string; model: string },
  file: string,
): Promise<GenerateImageResponse> {
  const { job, resumed, folder, model } = started;
  const { filePath } = resolveHeldPath(spaceRoot, `${job.folder}/${file}`, "read");
  const data = await readFile(filePath);
  const provider = job.provider;
  return {
    image: {
      mediaType: rasterImageMediaTypeForPath(file) ?? "application/octet-stream",
      data: data.toString("base64"),
    },
    path: `${folder}/${file}`,
    model,
    reused: false,
    warnings: provider?.warnings ?? [],
    ...(!resumed && provider?.notes.length ? { notes: provider.notes } : {}),
    ...(!resumed && provider?.quote ? { cost: provider.quote } : {}),
  };
}

/** Generates an image, or finds it, waiting for a job in-process: a headless
 * run's call. The editor's route answers once a job is recorded instead. */
export async function performSandboxGenerateImage(
  spaceRoot: string,
  doc: SandboxDocument,
  body: GenerateImageRequestBody,
  signal?: AbortSignal,
  resolve: (ref: string | undefined) => ResolvedImageModel = resolveImageModel,
  runner: JobRunner = jobRunner(),
): Promise<GenerateImageResponse> {
  const started = await startSandboxGenerateImage(spaceRoot, doc, body, signal, resolve, runner);
  if ("found" in started) return started.found;
  let outcome: JobOutcome;
  try {
    outcome = await runner.collect(started.job, signal);
  } catch (error) {
    if (signal?.aborted) {
      const reason = signal.reason instanceof Error ? signal.reason.message : "the request stopped";
      throw new SandboxRequestError(
        502,
        `Stopped waiting for the image: ${reason}. It is still being made, and Pragma saves it into ${started.folder}/ when it's done.`,
      );
    }
    throw new SandboxRequestError(502, error instanceof Error ? error.message : String(error));
  }
  if (outcome.file === undefined) throw new SandboxRequestError(502, outcome.error);
  return imageResponse(spaceRoot, started, outcome.file);
}

// The prompt as the lists that show a job name it: one line, cut short.
function summaryOf(prompt: string): string {
  const line = prompt.replace(/\s+/g, " ").trim();
  return line.length > 120 ? `${line.slice(0, 119)}…` : line;
}

/** A clip already in the folder for a request's inputs, or the job recorded
 * to make it, with whether an earlier request started that job. */
export type StartedVideo =
  | { found: GenerateVideoResponse }
  | { job: JobRecord; resumed: boolean; folder: string; model: string };

/** Finds the clip already in the folder the document declares and has been
 * granted for the same inputs, or starts the job that makes it: the resolved
 * model ref, the prompt, the frames' or references' bytes, the aspect ratio,
 * the resolution, the duration and the take. As for an image, a new `prefix`
 * copies the clip.
 *
 * A job outlives the request that started it. It is recorded as it starts,
 * and the host saves its clip whether or not the request still waits, so a
 * stopped run, a closed page or a restart never loses it; a request asking
 * for the same inputs joins the job instead of paying again. */
export async function startSandboxGenerateVideo(
  spaceRoot: string,
  doc: SandboxDocument,
  body: GenerateVideoRequestBody,
  // Tests stand a runner over a mock model and store in for the configured ones.
  runner: JobRunner = jobRunner(),
): Promise<StartedVideo> {
  const { folderPath, folder, rooted } = await resultsFolder(spaceRoot, doc, body.folder, "generateVideo");

  let resolved: ResolvedVideoModel;
  try {
    resolved = runner.model(body.model);
  } catch (error) {
    throw new SandboxRequestError(400, error instanceof Error ? error.message : String(error));
  }
  const bytes = (frame: GenerateVideoRequestBody["startFrame"]) =>
    frame ? new Uint8Array(Buffer.from(frame.data, "base64")) : undefined;
  const startFrame = bytes(body.startFrame);
  const endFrame = bytes(body.endFrame);
  if ((startFrame || endFrame) && body.references?.length) {
    throw new SandboxRequestError(400, "A video generation takes frames or references, not both");
  }
  const duration = body.duration && /^\d+$/.test(body.duration) ? Number(body.duration) : undefined;
  const shortSide = body.resolution ? resolutionShortSide(body.resolution) : undefined;
  // Take 1 is the first result, written blank, so going back to it finds it.
  const take = body.take && /^\d+$/.test(body.take) && Number(body.take) > 1 ? String(Number(body.take)) : "";
  const model = `${resolved.providerId}/${resolved.modelId}`;
  const { prompt, references, warnings } = sentReferences(body.prompt, body.references ?? [], resolved, model);
  const hashOf = (data: Uint8Array | undefined) => (data ? createHash("sha256").update(data).digest("hex") : "");
  const key = createHash("sha256")
    .update(
      JSON.stringify({
        model,
        prompt,
        startFrame: hashOf(startFrame),
        endFrame: hashOf(endFrame),
        // Left out when none go, so a clip made without any keeps its name.
        ...(references.length ? { references: references.map((reference) => hashOf(reference.data)) } : {}),
        aspectRatio: body.aspectRatio ?? "",
        // Left out at Default, never "", so a Default clip keeps its name.
        ...(shortSide ? { resolution: resolutionName(shortSide) } : {}),
        duration: duration ?? "",
        take,
      }),
    )
    .digest("hex");
  const digest = key.slice(0, 12);
  const named = typedPrefix(body.prefix, VIDEO_NAME_EXTENSION);
  const stem = `${named || "video"}-${digest}`;
  const existing = await findResult(folderPath, stem, digest, named);
  if (existing) {
    const { found, kept } = existing;
    if (kept !== found)
      await writeFileAtomic(path.join(folderPath, kept), createReadStream(path.join(folderPath, found)));
    return { found: { path: `${folder}/${kept}`, model, reused: true, resumed: false, warnings: [] } };
  }

  const spaceId = findSpaceId(loadGlobalConfig(), spaceRoot);
  if (spaceId === undefined) throw new Error(`${spaceRoot} is not a registered space`);
  let job = await runner.live(key);
  let resumed = job !== undefined;
  if (!job) {
    try {
      // Never stopped by a request's abort: a start stopped midway could
      // submit a job and never record it, paid for and lost.
      const begun = await runner.begin(
        {
          kind: "video",
          digest: key,
          spaceId,
          document: doc.path,
          folder: rooted,
          folderName: folder,
          stem,
          prefix: named,
          model,
          summary: summaryOf(body.prompt),
        },
        async () => {
          const started = await startVideoJob(resolved.model, {
            prompt,
            startFrame,
            endFrame,
            references,
            aspectRatio: body.aspectRatio as `${number}:${number}` | undefined,
            resolution: shortSide ? resolutionSize(shortSide) : undefined,
            duration,
          });
          return { ...started, warnings: [...warnings, ...started.warnings] };
        },
      );
      job = begun.job;
      resumed = begun.joined;
    } catch (error) {
      throw new SandboxRequestError(502, error instanceof Error ? error.message : String(error));
    }
  }
  // This host waits on the job from here, whether the caller does or not.
  runner.follow(job);
  return { job, resumed, folder, model };
}

/** What a run hands on once its job saved `file`. One job, one price: only
 * the request that started it reports the quote. */
export function videoResponse(
  started: { job: JobRecord; resumed: boolean; folder: string; model: string },
  file: string,
): GenerateVideoResponse {
  const { job, resumed, folder, model } = started;
  const provider = job.provider;
  return {
    path: `${folder}/${file}`,
    model,
    reused: false,
    resumed,
    warnings: provider?.warnings ?? [],
    ...(!resumed && provider?.notes.length ? { notes: provider.notes } : {}),
    ...(!resumed && provider?.quote ? { quote: provider.quote } : {}),
  };
}

/** Generates a clip, or finds it, and waits for it in-process: a headless
 * run's call. The editor's route answers once the job is recorded instead,
 * and its run waits through /api/jobs. */
export async function performSandboxGenerateVideo(
  spaceRoot: string,
  doc: SandboxDocument,
  body: GenerateVideoRequestBody,
  signal?: AbortSignal,
  runner: JobRunner = jobRunner(),
): Promise<GenerateVideoResponse> {
  const started = await startSandboxGenerateVideo(spaceRoot, doc, body, runner);
  if ("found" in started) return started.found;
  const { job, folder } = started;
  let outcome: JobOutcome;
  try {
    outcome = await runner.collect(job, signal);
  } catch (error) {
    if (signal?.aborted) {
      const reason = signal.reason instanceof Error ? signal.reason.message : "the request stopped";
      throw new SandboxRequestError(
        502,
        `Stopped waiting for the clip: ${reason}. It is still being made, and Pragma saves it into ${folder}/ when it's done.`,
      );
    }
    throw new SandboxRequestError(502, error instanceof Error ? error.message : String(error));
  }
  if (outcome.file === undefined) throw new SandboxRequestError(502, outcome.error);
  return videoResponse(started, outcome.file);
}
