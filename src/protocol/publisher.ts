import type { ResolvedPublisher } from "../config/loadConfig.ts";
import { type HttpCallMeta, httpCall } from "./httpCall.ts";

/**
 * The Sogma client: every call shares one base-URL normalization and
 * bearer-auth header, and no route touches Sogma's wire shape (headers,
 * `/sites` paths, snake_case response fields) directly. Kind-dispatched
 * (`kind === "sogma"`) rather than one module per kind: with a single
 * publisher kind, per-kind modules would be structure ahead of need.
 */

/** A publisher with the key read for this call, never kept beyond it. */
export type PublisherConnection = ResolvedPublisher & { apiKey: string };

function sogmaBase(publisher: PublisherConnection): string {
  return (publisher.baseURL ?? "").replace(/\/+$/, "");
}

function sogmaHeaders(publisher: PublisherConnection, extra?: Record<string, string>): Record<string, string> {
  return {
    ...(publisher.apiKey ? { Authorization: `Bearer ${publisher.apiKey}` } : {}),
    ...extra,
  };
}

export interface PublisherKeyVerification {
  ok: boolean;
  // Set when the call itself threw (network error) — `ok` still comes back
  // `true` in that case ("can't disprove it"), but the caller can still
  // show that the verification call failed, independent of the business
  // outcome.
  error?: string;
}

/**
 * Probes a publisher's endpoint with its resolved key, so the Publishing
 * settings panel can refuse to record a rejected key as "set" — the same
 * posture as provider-key verification (modelProvider.ts).
 *
 * `ok` is `false` only on an unambiguous auth rejection (401/403); a network
 * error, an unreachable dev endpoint, or anything else comes back `ok: true`
 * ("can't disprove it"). Dispatches on `kind`, so another kind adds a branch.
 */
export async function verifyPublisherKey(publisher: PublisherConnection): Promise<PublisherKeyVerification> {
  if (!publisher.baseURL) return { ok: true };
  if (publisher.kind !== "sogma") return { ok: true };
  try {
    const { response } = await httpCall(`${sogmaBase(publisher)}/sites`, { headers: sogmaHeaders(publisher) });
    return { ok: response.status !== 401 && response.status !== 403 };
  } catch (error) {
    return { ok: true, error: error instanceof Error ? error.message : "Network error" };
  }
}

export interface SogmaSite {
  id: string;
  slug: string;
  name: string;
  domain?: string;
  primaryDomain: string | null;
}

export type CreateSogmaSiteResult =
  | { ok: true; site: SogmaSite }
  // `httpCall` present ⇔ a response actually came back from Sogma — absent
  // means the fetch itself threw, which the caller (routes.ts) uses to pick
  // a 502 (never reached Sogma) vs. 400 (Sogma rejected the request).
  | { ok: false; message: string; httpCall?: HttpCallMeta };

// New Site (docs/publishing.md's Creating a site section) — `POST
// /v1/sites`. `domain` is only ever a caller-supplied request field, never
// echoed by Sogma's response, so it's threaded straight through rather than
// read back out of `created`.
export async function createSogmaSite(
  publisher: PublisherConnection,
  { name, domain }: { name: string; domain?: string },
): Promise<CreateSogmaSiteResult> {
  let call: Awaited<ReturnType<typeof httpCall>>;
  try {
    call = await httpCall(`${sogmaBase(publisher)}/sites`, {
      method: "POST",
      headers: sogmaHeaders(publisher, {
        "content-type": "application/json",
        "Idempotency-Key": crypto.randomUUID(),
      }),
      body: JSON.stringify({ name, domain: domain || undefined }),
    });
  } catch {
    return { ok: false, message: "Couldn't reach the publisher. Check the connection and try again." };
  }

  const { response, meta } = call;
  if (!response.ok) {
    const errorBody = (await response.json().catch(() => undefined)) as { error?: { message?: string } } | undefined;
    return {
      ok: false,
      message: errorBody?.error?.message ?? `Sogma rejected the request (${response.status}).`,
      httpCall: meta,
    };
  }

  const created = (await response.json()) as { id: string; slug: string; name: string; primary_domain: string | null };
  return {
    ok: true,
    site: {
      id: created.id,
      slug: created.slug,
      name: created.name,
      domain: domain || undefined,
      primaryDomain: created.primary_domain,
    },
  };
}

export interface DeleteSogmaSiteResult {
  ok: boolean;
}

// The rollback half of New Site: `DELETE /v1/sites/{id}`, fired when local
// scaffolding fails after Sogma already created the site. Never throws —
// the caller only cares whether the rollback itself succeeded, to decide
// whether the site needs a manual retry.
export async function deleteSogmaSite(publisher: PublisherConnection, siteId: string): Promise<DeleteSogmaSiteResult> {
  try {
    const { response } = await httpCall(`${sogmaBase(publisher)}/sites/${siteId}`, {
      method: "DELETE",
      headers: sogmaHeaders(publisher),
    });
    return { ok: response.ok };
  } catch {
    return { ok: false };
  }
}

/** A site's name as the publisher holds it, or undefined when it can't be
 * read. `GET /v1/sites` is the one read that carries it: the settings read
 * leaves it out. */
export async function readSogmaSiteName(publisher: PublisherConnection, siteId: string): Promise<string | undefined> {
  try {
    const { response } = await httpCall(`${sogmaBase(publisher)}/sites`, { headers: sogmaHeaders(publisher) });
    if (!response.ok) return undefined;
    const body = (await response.json()) as { sites?: Array<{ id?: unknown; name?: unknown }> };
    const site = Array.isArray(body.sites) ? body.sites.find((entry) => entry.id === siteId) : undefined;
    return typeof site?.name === "string" ? site.name : undefined;
  } catch {
    return undefined;
  }
}

export type SogmaSettingsResult<T> =
  | ({ ok: true } & T)
  // Same httpCall-present-or-not distinction as CreateSogmaSiteResult above.
  // `field` is the JSON Pointer Sogma names when a single field is to blame
  // (its Errors section) — carried through so a form can say which control
  // was rejected instead of showing one message for the whole dialog.
  | { ok: false; message: string; field?: string; httpCall?: HttpCallMeta };

/** The schemas Pragma reads out of a publisher's API description. */
export interface SogmaApiSchemas {
  /** `SiteSettings`: the fields of the Site Settings dialog. */
  settings?: unknown;
  /** `DocumentParams`: the frontmatter keys a page sends as `params`. */
  documentParams?: unknown;
}

// The schemas out of Sogma's OpenAPI description. Fetched, not hardcoded:
// they are generated from the server's own validation, so they can't
// describe a shape the API would reject, and a setting or a param added
// service-side needs no release here.
//
// A 404 is an answer, not a failure: a publisher that serves no description
// describes no settings and takes no params, and it still publishes.
//
// Unauthenticated by spec; the bearer goes along so no call assembles its own
// headers. `etag` in and out is the whole caching story: a caller holding one
// gets a 304 with nothing to parse (`schemas` absent, `notModified` true).
export async function fetchSogmaApiSchemas(
  publisher: PublisherConnection,
  etag?: string,
): Promise<SogmaSettingsResult<{ schemas?: SogmaApiSchemas; etag?: string; notModified: boolean }>> {
  let call: Awaited<ReturnType<typeof httpCall>>;
  try {
    call = await httpCall(`${sogmaBase(publisher)}/openapi.json`, {
      headers: sogmaHeaders(publisher, etag ? { "if-none-match": etag } : {}),
    });
  } catch {
    return { ok: false, message: "Couldn't reach the publisher. Check the connection and try again." };
  }

  const { response, meta } = call;
  if (response.status === 304) return { ok: true, notModified: true, etag };
  if (response.status === 404) return { ok: true, notModified: false, schemas: {} };
  if (!response.ok) {
    return { ok: false, message: `Sogma rejected the request (${response.status}).`, httpCall: meta };
  }

  const document = (await response.json().catch(() => undefined)) as
    | { components?: { schemas?: Record<string, unknown> } }
    | undefined;
  if (!document || typeof document !== "object") {
    return { ok: false, message: "The publisher's API description couldn't be read." };
  }
  const schemas = document.components?.schemas;
  return {
    ok: true,
    notModified: false,
    schemas: { settings: schemas?.SiteSettings, documentParams: schemas?.DocumentParams },
    etag: response.headers.get("etag") ?? undefined,
  };
}

// `GET /v1/sites/{id}/settings` — every known field always present, `null`
// when unset, so a form renders the same shape for a site with nothing
// configured as for one fully set up.
export async function fetchSogmaSiteSettings(
  publisher: PublisherConnection,
  siteId: string,
): Promise<SogmaSettingsResult<{ settings: unknown }>> {
  let call: Awaited<ReturnType<typeof httpCall>>;
  try {
    call = await httpCall(`${sogmaBase(publisher)}/sites/${siteId}/settings`, { headers: sogmaHeaders(publisher) });
  } catch {
    return { ok: false, message: "Couldn't reach the publisher. Check the connection and try again." };
  }
  return readSettingsResponse(call);
}

// `PATCH /v1/sites/{id}`: the name and the settings in one request, which
// Sogma applies as one change. `settings` is a JSON Merge Patch (RFC 7396),
// so it carries only what changed: the whole blob would overwrite fields
// this pragma may not know about. Plain JSON, not the merge-patch media
// type: Sogma merges into the `settings` member of an ordinary body.
//
// A refusal's `field` is Sogma's own, rooted at the request body. The
// answer's `name` is the one Sogma stored, which it trims.
export async function patchSogmaSite(
  publisher: PublisherConnection,
  siteId: string,
  patch: { name?: string; settings?: Record<string, unknown> },
): Promise<SogmaSettingsResult<{ name?: string; settings: unknown }>> {
  let call: Awaited<ReturnType<typeof httpCall>>;
  try {
    call = await httpCall(`${sogmaBase(publisher)}/sites/${siteId}`, {
      method: "PATCH",
      headers: sogmaHeaders(publisher, { "content-type": "application/json" }),
      body: JSON.stringify(patch),
    });
  } catch {
    return { ok: false, message: "Couldn't reach the publisher. Check the connection and try again." };
  }
  return readSettingsResponse(call);
}

// Both settings calls answer with the same envelope, and reject with the
// same one — so the success parse and the `field`-carrying error parse live
// together rather than being written twice.
async function readSettingsResponse(
  call: Awaited<ReturnType<typeof httpCall>>,
): Promise<SogmaSettingsResult<{ name?: string; settings: unknown }>> {
  const { response, meta } = call;
  if (!response.ok) {
    const body = (await response.json().catch(() => undefined)) as
      | { error?: { message?: string; field?: string } }
      | undefined;
    return {
      ok: false,
      message: body?.error?.message ?? `Sogma rejected the request (${response.status}).`,
      ...(body?.error?.field ? { field: body.error.field } : {}),
      httpCall: meta,
    };
  }
  const body = (await response.json().catch(() => undefined)) as { name?: unknown; settings?: unknown } | undefined;
  return { ok: true, settings: body?.settings ?? {}, ...(typeof body?.name === "string" ? { name: body.name } : {}) };
}

export interface SogmaDocument {
  id: string;
  url: string;
  title: string;
  visibility: "public" | "unlisted";
  // Sogma's own server-computed timestamp — the source for the local
  // `published` frontmatter field (docs/publishing.md), same reasoning
  // `url` is taken from the response rather than constructed locally.
  updatedAt: string;
}

export type PublishSogmaDocumentResult =
  | { ok: true; document: SogmaDocument }
  // Same httpCall-present-or-not distinction as CreateSogmaSiteResult above.
  // `code` and `field` are the error envelope's, for a caller that tells the
  // refusal in the document's own terms.
  | { ok: false; message: string; code?: string; field?: string; httpCall?: HttpCallMeta };

/** The useful members of the error envelope. `code` is the stable string
 * the spec says to branch on, and `field` the JSON Pointer to the value to
 * blame; `message` is human-readable, may change between versions, and is
 * explicitly not to be parsed — so it is carried through to be shown, never
 * mined for the values inside it. */
async function readSogmaError(
  response: Response,
  fallback: string,
): Promise<{ message: string; code?: string; field?: string; limitBytes?: number }> {
  const body = (await response.json().catch(() => undefined)) as
    | { error?: { message?: string; code?: string; field?: string; limit_bytes?: number } }
    | undefined;
  return {
    message: body?.error?.message ?? fallback,
    ...(body?.error?.code ? { code: body.error.code } : {}),
    ...(body?.error?.field ? { field: body.error.field } : {}),
    ...(typeof body?.error?.limit_bytes === "number" ? { limitBytes: body.error.limit_bytes } : {}),
  };
}

async function readSogmaDocumentError(
  response: Response,
  fallback: string,
): Promise<{ message: string; code?: string; field?: string }> {
  const { message, code, field } = await readSogmaError(response, fallback);
  return { message, ...(code ? { code } : {}), ...(field ? { field } : {}) };
}

function parseSogmaDocument(raw: {
  id: string;
  url: string;
  title: string;
  visibility: "public" | "unlisted";
  updated_at: string;
}): SogmaDocument {
  return { id: raw.id, url: raw.url, title: raw.title, visibility: raw.visibility, updatedAt: raw.updated_at };
}

// Per-document publish, first publish (docs/publishing.md's Publishing a
// document section) — `POST /v1/documents`. `site_id`/`parent_id` are
// resolved by the caller (src/server/sites.ts) beforehand; this only knows
// the wire shape.
export async function createSogmaDocument(
  publisher: PublisherConnection,
  input: {
    siteId: string;
    parentId?: string;
    slug: string;
    title: string;
    content: string;
    visibility: "public" | "unlisted";
    publishedAt?: string;
    // Absent for a publisher that takes no `params`, which would refuse the
    // member as an unknown field.
    params?: Record<string, unknown>;
  },
): Promise<PublishSogmaDocumentResult> {
  let call: Awaited<ReturnType<typeof httpCall>>;
  try {
    // `content_format` is sent even though `markdown` is Sogma's default:
    // a PUT without it resets the stored format instead of keeping it, so
    // both calls name the body's format rather than leaving it implied.
    call = await httpCall(`${sogmaBase(publisher)}/documents`, {
      method: "POST",
      headers: sogmaHeaders(publisher, {
        "content-type": "application/json",
        "Idempotency-Key": crypto.randomUUID(),
      }),
      body: JSON.stringify({
        site_id: input.siteId,
        parent_id: input.parentId,
        slug: input.slug,
        title: input.title,
        content: input.content,
        content_format: "markdown",
        visibility: input.visibility,
        published_at: input.publishedAt,
        params: input.params,
      }),
    });
  } catch {
    return { ok: false, message: "Couldn't reach the publisher. Check the connection and try again." };
  }

  const { response, meta } = call;
  if (!response.ok) {
    return {
      ok: false,
      ...(await readSogmaDocumentError(response, `Sogma rejected the request (${response.status}).`)),
      httpCall: meta,
    };
  }

  const created = (await response.json()) as {
    id: string;
    url: string;
    title: string;
    visibility: "public" | "unlisted";
    updated_at: string;
  };
  return { ok: true, document: parseSogmaDocument(created) };
}

// Per-document publish, every publish after the first (docs/publishing.md's
// Publishing a document section) — `PUT /v1/documents/{id}`. `parent_id` is
// required on the wire and a different value moves the document, so `null`
// is sent for a top-level page rather than omitted.
//
// `published_at` is sent the same way: the PUT is a full replacement, so
// omitting it clears the stored date just as `null` does, and naming it keeps
// that visible. `params` too, whole on every update to a publisher that takes
// them: a key left out of it is cleared.
export async function updateSogmaDocument(
  publisher: PublisherConnection,
  documentId: string,
  input: {
    parentId: string | null;
    slug: string;
    title: string;
    content: string;
    visibility: "public" | "unlisted";
    publishedAt: string | null;
    params?: Record<string, unknown>;
  },
): Promise<PublishSogmaDocumentResult> {
  let call: Awaited<ReturnType<typeof httpCall>>;
  try {
    call = await httpCall(`${sogmaBase(publisher)}/documents/${documentId}`, {
      method: "PUT",
      headers: sogmaHeaders(publisher, { "content-type": "application/json" }),
      body: JSON.stringify({
        parent_id: input.parentId,
        slug: input.slug,
        title: input.title,
        content: input.content,
        content_format: "markdown",
        visibility: input.visibility,
        published_at: input.publishedAt,
        params: input.params,
      }),
    });
  } catch {
    return { ok: false, message: "Couldn't reach the publisher. Check the connection and try again." };
  }

  const { response, meta } = call;
  if (!response.ok) {
    return {
      ok: false,
      ...(await readSogmaDocumentError(response, `Sogma rejected the request (${response.status}).`)),
      httpCall: meta,
    };
  }

  const updated = (await response.json()) as {
    id: string;
    url: string;
    title: string;
    visibility: "public" | "unlisted";
    updated_at: string;
  };
  return { ok: true, document: parseSogmaDocument(updated) };
}

export interface DeleteSogmaDocumentResult {
  ok: boolean;
}

// Unpublish (docs/publishing.md's The pending queue section) — `DELETE
// /v1/documents/{id}`. Idempotent per spec (204 on success and on a document
// already gone), so no Idempotency-Key. No message/httpCall on failure, like
// the site delete: the caller's fallback is a `_queue.json` entry, never a
// reason shown to the user.
export async function deleteSogmaDocument(
  publisher: PublisherConnection,
  documentId: string,
): Promise<DeleteSogmaDocumentResult> {
  try {
    const { response } = await httpCall(`${sogmaBase(publisher)}/documents/${documentId}`, {
      method: "DELETE",
      headers: sogmaHeaders(publisher),
    });
    return { ok: response.ok };
  } catch {
    return { ok: false };
  }
}

/** One staged or stored file on a site — `POST /v1/files` and `GET
 * /v1/files/{id}` answer with the same record. `upload` is present only on
 * the stage response, a one-time target never handed out again, so a caller
 * not sending the bytes immediately must keep it. `url` stays null until
 * `status` reaches `"ready"`, so an embed can't be rewritten before then. */
export interface SogmaFile {
  id: string;
  /** What an `asset:` reference in a document body names. Assigned when the
   * file row is created, so it is usable from the stage response onward —
   * which is what lets a document be published without waiting for its
   * images to finish verifying. */
  publicId: string | null;
  filename: string | null;
  status: "pending" | "uploaded" | "processing" | "ready" | "failed";
  url: string | null;
  error: string | null;
  upload?: {
    url: string;
    method: string;
    headers: Record<string, string>;
    expiresAt: string;
  };
}

export type SogmaFileResult =
  | { ok: true; file: SogmaFile }
  // Same httpCall-present-or-not distinction as CreateSogmaSiteResult above.
  // `code` rides along because a size rejection has to be told from every
  // other refusal, and the service's own limit only ever appears in prose
  // its spec forbids parsing.
  | { ok: false; message: string; code?: string; limitBytes?: number; httpCall?: HttpCallMeta };

/** Sogma's own wire shape for a file, snake_case and all. Kept beside the
 * parser rather than exported: nothing outside this module should be reading
 * `expires_at` off a response. */
interface SogmaFileBody {
  id: string;
  public_id?: string | null;
  filename?: string | null;
  status: SogmaFile["status"];
  url?: string | null;
  error?: string | null;
  upload?: { url: string; method: string; headers: Record<string, string>; expires_at: string };
}

function parseSogmaFile(raw: SogmaFileBody): SogmaFile {
  return {
    id: raw.id,
    publicId: raw.public_id ?? null,
    filename: raw.filename ?? null,
    status: raw.status,
    url: raw.url ?? null,
    error: raw.error ?? null,
    ...(raw.upload
      ? {
          upload: {
            url: raw.upload.url,
            method: raw.upload.method,
            headers: raw.upload.headers,
            expiresAt: raw.upload.expires_at,
          },
        }
      : {}),
  };
}

// Step one of an image upload (docs/publishing.md's Images section) — `POST
// /v1/files`, which reserves the file and hands back where to PUT the bytes.
// No Idempotency-Key: the endpoint neither needs nor accepts one, since a
// lost response only abandons an upload the service cleans up on its own.
//
// `sha256` is what turns on deduplication: a site that already holds a ready
// file with these bytes answers with that file and no `upload` member, and
// nothing is sent. Presence of `upload` is the branch, never the status code.
export async function stageSogmaFile(
  publisher: PublisherConnection,
  input: { siteId: string; filename: string; mimeType: string; sizeBytes: number; sha256: string },
): Promise<SogmaFileResult> {
  let call: Awaited<ReturnType<typeof httpCall>>;
  try {
    call = await httpCall(`${sogmaBase(publisher)}/files`, {
      method: "POST",
      headers: sogmaHeaders(publisher, { "content-type": "application/json" }),
      body: JSON.stringify({
        site_id: input.siteId,
        filename: input.filename,
        content_type: "image",
        mime_type: input.mimeType,
        size_bytes: input.sizeBytes,
        sha256: input.sha256,
      }),
    });
  } catch {
    return { ok: false, message: "Couldn't reach the publisher. Check the connection and try again." };
  }

  const { response, meta } = call;
  if (!response.ok) {
    return {
      ok: false,
      ...(await readSogmaError(response, `Sogma rejected the upload (${response.status}).`)),
      httpCall: meta,
    };
  }
  return { ok: true, file: parseSogmaFile((await response.json()) as SogmaFileBody) };
}

// Step two — the bytes themselves, sent to storage rather than to the API.
// The request has to match the staged `upload` block exactly: same method,
// same headers, and a body whose real byte count equals the declared
// content-length, or the target rejects it.
//
// This is the one call whose failure does not arrive in the JSON envelope
// the Errors section describes — the response comes from the storage
// provider in its own format, so only the status code is read.
export async function putSogmaFileBytes(
  upload: NonNullable<SogmaFile["upload"]>,
  bytes: Uint8Array<ArrayBuffer>,
): Promise<{ ok: true } | { ok: false; message: string; responded: boolean }> {
  try {
    const { response } = await httpCall(upload.url, {
      method: upload.method,
      headers: upload.headers,
      body: bytes,
    });
    if (response.ok) return { ok: true };
    return { ok: false, message: `The upload was rejected by storage (${response.status}).`, responded: true };
  } catch {
    return {
      ok: false,
      message: "Couldn't reach the upload target. Check the connection and try again.",
      responded: false,
    };
  }
}

// `GET /v1/files?site_id=` — every file a site holds, in one call. How an
// image setting's `public_id` is turned back into something to show: the
// service stores only the id and signs URLs itself, so a client matches
// the list on `public_id` rather than building a URL.
export async function listSogmaFiles(
  publisher: PublisherConnection,
  siteId: string,
): Promise<{ ok: true; files: SogmaFile[] } | { ok: false; message: string; httpCall?: HttpCallMeta }> {
  let call: Awaited<ReturnType<typeof httpCall>>;
  try {
    call = await httpCall(`${sogmaBase(publisher)}/files?site_id=${encodeURIComponent(siteId)}`, {
      headers: sogmaHeaders(publisher),
    });
  } catch {
    return { ok: false, message: "Couldn't reach the publisher. Check the connection and try again." };
  }

  const { response, meta } = call;
  if (!response.ok) {
    return {
      ok: false,
      ...(await readSogmaError(response, `Sogma rejected the request (${response.status}).`)),
      httpCall: meta,
    };
  }
  const body = (await response.json()) as { files?: SogmaFileBody[] };
  return { ok: true, files: (body.files ?? []).map(parseSogmaFile) };
}
