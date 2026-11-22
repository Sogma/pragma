// Publishers, sites, and publishing a document.
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Hono } from "hono";
import {
  canonicalEndpointOrUndefined,
  credentialStore,
  credentialStoreDescription,
  publisherKeyStatus,
  saveCredential,
} from "../../config/credentials.ts";
import {
  loadGlobalConfig,
  removePublisherConfig,
  resolvePublishers,
  upsertPublisherConfig,
  validatePublisherInput,
  withConfigMutationLock,
} from "../../config/loadConfig.ts";
import type {
  CreateSiteErrorBody,
  CreateSiteRequestBody,
  CreateSiteResponse,
  ErrorBody,
  PublishDocumentRequestBody,
  PublishDocumentResponse,
  PublisherIdRequestBody,
  PublisherRow,
  PublisherSaveResult,
  PublishersResponse,
  SavePublisherRequestBody,
  SaveSiteSettingsRequestBody,
  SaveSiteSettingsResponse,
  SiteImageUploadRequestBody,
  SiteImageUploadResponse,
  SiteSettingsErrorBody,
  SiteSettingsResponse,
} from "../../protocol/api.ts";
import { SITE_FILENAME } from "../../protocol/pragmaFiles.ts";
import { createSogmaSite, deleteSogmaSite, type SogmaSite, verifyPublisherKey } from "../../protocol/publisher.ts";
import { requirePublisher, requirePublisherForSite } from "../publishers.ts";
import { runPublish } from "../publishHandler.ts";
import { isSpaceTarget, newFolderIn, PathAccessError, resolveRootedPath } from "../rootedFiles.ts";
import { runReadSiteSettings, runSaveSiteSettings, runUploadSiteImage } from "../siteSettingsHandler.ts";
import { readSiteFile, resolveSiteForPath } from "../sites.ts";
import { findNameCollision, resolveWithinSpace } from "../spaceFiles.ts";
import type { RouteContext } from "./shared.ts";

// A refused path keeps the status it was refused with, as on every other
// write route; anything else these routes catch is the request's fault.
function refusalStatus(error: unknown): 400 | 403 | 404 {
  return error instanceof PathAccessError ? error.status : 400;
}

const isTextOrAbsent = (value: unknown) => value === undefined || typeof value === "string";

export function mountPublishingRoutes(app: Hono, { spaceRoot }: RouteContext): void {
  // Publishers (docs/publishing.md): the same shape as /api/providers, but
  // with their own config field and credential kind, so a publisher's key
  // never collides with a model provider's of the same id.
  app.all("/api/publishers", async (c) => {
    try {
      if (c.req.method === "POST") {
        const body = (await c.req.json()) as SavePublisherRequestBody;
        const { apiKey, ...fields } = body;
        const existing = loadGlobalConfig().publishers?.find((entry) => entry.id === fields.id);
        const kind = fields.kind ?? existing?.kind;
        const baseURL = (fields.baseURL ?? existing?.baseURL) || undefined;

        if (apiKey !== undefined && apiKey !== "") {
          validatePublisherInput(fields);
          // A rejected key never creates or touches an entry. `error` rides
          // along on success so the client can log a verification call that
          // failed without disproving the key.
          let verificationError: string | undefined;
          const saved = await saveCredential({
            kind: "publisher-keys",
            id: fields.id,
            endpoint: canonicalEndpointOrUndefined(baseURL),
            secret: apiKey,
            verify: async () => {
              const verification = await verifyPublisherKey({
                id: fields.id,
                label: fields.label ?? existing?.label ?? fields.id,
                kind: kind ?? "sogma",
                baseURL,
                apiKey,
              });
              verificationError = verification.error;
              return verification.ok ? undefined : "The publisher rejected that API key.";
            },
            publish: () => upsertPublisherConfig(fields),
          });
          if (!saved.ok) return c.json({ message: saved.message }, saved.status);
          return c.json<PublisherSaveResult>({ error: verificationError });
        }

        upsertPublisherConfig(fields);
        return c.body(null, 204);
      }
      if (c.req.method !== "GET") return c.body(null, 405);

      const config = loadGlobalConfig();
      const configuredIds = new Set((config.publishers ?? []).map((entry) => entry.id));
      const publishers = await Promise.all(
        resolvePublishers(config).map(async (publisher): Promise<PublisherRow> => {
          const key = await publisherKeyStatus(publisher);
          return {
            id: publisher.id,
            label: publisher.label,
            kind: publisher.kind,
            baseURL: publisher.baseURL ?? "",
            configured: configuredIds.has(publisher.id),
            keySource: key.source === "env" ? "none" : key.source,
            ...(key.problem ? { keyProblem: key.problem } : {}),
          };
        }),
      );
      return c.json<PublishersResponse>({ publishers, store: credentialStoreDescription() });
    } catch (error) {
      return c.json({ message: error instanceof Error ? error.message : "Bad request" }, 400);
    }
  });

  // Removes a publisher entry and its stored key.
  app.all("/api/publishers/delete", async (c) => {
    if (c.req.method !== "POST") return c.body(null, 405);
    try {
      const { id } = (await c.req.json()) as Partial<PublisherIdRequestBody>;
      if (!id) return c.text("Missing id", 400);
      await credentialStore().clear({ kind: "publisher-keys", id });
      await withConfigMutationLock(async () => removePublisherConfig(id));
      return c.body(null, 204);
    } catch (error) {
      return c.json({ message: error instanceof Error ? error.message : "Internal error" }, 500);
    }
  });

  // New Site (docs/publishing.md's Creating a site). Holds the publisher
  // token itself: this is file-tree chrome, not a toolkit button's run.
  //
  // The remote site is created first because the folder name is Sogma's
  // slug; a local failure rolls it back, which is always safe since the site
  // is still empty. `existingSite` lets a retry after a failed rollback redo
  // only the local steps instead of minting a second site.
  app.all("/api/space/site", async (c) => {
    if (c.req.method !== "POST") return c.body(null, 405);

    try {
      const body = (await c.req.json()) as Partial<CreateSiteRequestBody>;

      // A retry after a failed local scaffold must land on the same
      // publisher the site was already created on, so `publisherId` rides
      // along with `existingSite` rather than being re-picked.
      const resolved = await requirePublisher(body.publisherId);
      if (!resolved.ok) return c.json<ErrorBody>({ message: resolved.message, need: resolved.need }, 400);
      const { publisher } = resolved;

      // Through the write doorway, before the service is asked for a site, so
      // a folder no write may enter never leaves one to roll back. A site is
      // the space's own bookkeeping, so a library is refused outright.
      const parent = resolveRootedPath(spaceRoot, body.parentPath === "." ? "" : (body.parentPath ?? ""), "write");
      if (!isSpaceTarget(parent)) return c.json({ message: "A site can only be made in the space." }, 400);
      const parentDir = parent.filePath;

      let site: SogmaSite;

      if (body.existingSite) {
        site = body.existingSite;
      } else {
        const name = body.name?.trim();
        if (!name) return c.json({ message: "Enter a site name." }, 400);

        const result = await createSogmaSite(publisher, { name, domain: body.domain });
        if (!result.ok) {
          // `responded` ⇔ a response came back; absent means the fetch
          // itself threw.
          return c.json({ message: result.message }, result.responded ? 400 : 502);
        }
        site = result.site;
      }

      try {
        // The folder takes the slug as its name, so the slug is held to the
        // rule a typed name is, and taken when another entry folds to it.
        const placed = newFolderIn(parentDir, site.slug);
        if ("refused" in placed) throw new Error(`The publisher named the site "${site.slug}". ${placed.refused}.`);
        const siteDir = placed.folder;
        if (existsSync(parentDir) && findNameCollision(parentDir, path.basename(siteDir))) {
          throw new Error(`"${site.slug}" already exists here.`);
        }

        await mkdir(siteDir, { recursive: true });
        await writeFile(
          path.join(siteDir, SITE_FILENAME),
          `${JSON.stringify(
            {
              id: site.id,
              slug: site.slug,
              name: site.name,
              domain: site.domain,
              primaryDomain: site.primaryDomain,
              publisherId: publisher.id,
            },
            null,
            2,
          )}\n`,
        );
        await writeFile(path.join(siteDir, "index.md"), `# ${site.name}\n`);

        const relative = path.relative(spaceRoot, siteDir).split(path.sep).join("/");
        return c.json<CreateSiteResponse>({ path: relative, siteId: site.id, siteSlug: site.slug });
      } catch (localError) {
        const message = localError instanceof Error ? localError.message : "Failed to set up the site locally.";
        const existingSite = {
          id: site.id,
          slug: site.slug,
          name: site.name,
          domain: site.domain,
          primaryDomain: site.primaryDomain,
        };
        // Only a site this request created is rolled back. A retry names one
        // it was handed, and nothing in a request shows that is the one that
        // failed: trusting it would let a forged retry delete any empty site.
        if (body.existingSite) return c.json<CreateSiteErrorBody>({ message, existingSite }, 500);

        // Rollback: the site is always empty at this point (New Site never
        // publishes a document itself), so the delete's own empty-only
        // constraint can't reject it — a failure here means the delete
        // request itself didn't go through, not that Sogma refused it.
        const deleteResult = await deleteSogmaSite(publisher, site.id);
        if (deleteResult.ok) {
          return c.json({ message }, 500);
        }
        return c.json<CreateSiteErrorBody>(
          {
            message: `${message} The site was created on Sogma (as "${site.slug}") but couldn't be cleaned up automatically. Retrying will finish setting it up locally.`,
            existingSite,
          },
          500,
        );
      }
    } catch (error) {
      return c.json({ message: error instanceof Error ? error.message : "Internal error" }, refusalStatus(error));
    }
  });

  // Per-document Publish/Update (docs/publishing.md's Publishing a
  // document). Holds the token itself, like New Site: this is app chrome,
  // not a document-scoped toolkit run.
  app.all("/api/space/publish", async (c) => {
    if (c.req.method !== "POST") return c.body(null, 405);

    try {
      const body = (await c.req.json()) as Partial<PublishDocumentRequestBody>;
      if (!body.path) return c.json({ message: "Missing path." }, 400);
      resolveWithinSpace(spaceRoot, body.path); // throws on a path escaping the space, before any site file is read

      // The document's own site names the publisher. A path that resolves to
      // no site still gets a publisher here (the first configured one) — the
      // publish below is what rejects it, with the reason that actually
      // applies.
      const resolved = await requirePublisher(resolveSiteForPath(spaceRoot, body.path)?.site.publisherId);
      if (!resolved.ok) return c.json<ErrorBody>({ message: resolved.message, need: resolved.need }, 400);

      const result = await runPublish(spaceRoot, resolved.publisher, body.path);
      if (!result.ok) return c.json({ message: result.message }, result.status);
      return c.json<PublishDocumentResponse>({
        id: result.document.id,
        url: result.document.url,
        pushed: result.document.updatedAt,
        ...(result.date ? { date: result.date } : {}),
        notes: result.notes,
        writeBacks: result.writeBacks,
      });
    } catch (error) {
      return c.json({ message: error instanceof Error ? error.message : "Internal error" }, refusalStatus(error));
    }
  });

  // Site Settings (docs/publishing.md's Site settings): the publisher's
  // schema and values, through a token-holding route like New Site. A Save
  // writes `_site.json` too, so it resolves the site as a write, which
  // refuses one in a hidden folder. A refusal's `field` names the control.
  app.all("/api/space/site/settings", async (c) => {
    if (c.req.method !== "GET" && c.req.method !== "POST") return c.body(null, 405);

    try {
      const body = c.req.method === "POST" ? ((await c.req.json()) as Partial<SaveSiteSettingsRequestBody>) : undefined;
      const sitePath = body?.path ?? c.req.query("path");
      if (typeof sitePath !== "string") return c.json({ message: "Missing path." }, 400);

      const site = resolveRootedPath(spaceRoot, sitePath, body ? "write" : "read");
      const siteDir = site.filePath;
      if (!isSpaceTarget(site) || !readSiteFile(siteDir)) return c.json({ message: "Not a site folder." }, 404);

      if (body) {
        if (!isTextOrAbsent(body.name) || !isTextOrAbsent(body.assetsFolder)) {
          return c.json({ message: "name and assetsFolder must be text." }, 400);
        }
        const changes = { edits: body.edits ?? {}, name: body.name, assetsFolder: body.assetsFolder };
        const saved = await runSaveSiteSettings(siteDir, () => requirePublisherForSite(siteDir), changes);
        if (!saved.ok) {
          const refusal = { message: saved.message, field: saved.field, need: saved.need };
          return c.json<SiteSettingsErrorBody>(refusal, saved.status);
        }
        return c.json<SaveSiteSettingsResponse>({ siteName: saved.siteName, assetsFolder: saved.assetsFolder });
      }

      const resolved = await requirePublisherForSite(siteDir);
      if (!resolved.ok) return c.json<ErrorBody>({ message: resolved.message, need: resolved.need }, 400);
      const result = await runReadSiteSettings(siteDir, resolved.publisher);
      if (!result.ok) {
        return c.json<SiteSettingsErrorBody>({ message: result.message, field: result.field }, result.status);
      }
      return c.json<SiteSettingsResponse>({
        siteName: result.siteName,
        ...(result.siteNameUpdated ? { siteNameUpdated: true } : {}),
        publisherLabel: resolved.publisher.label,
        fields: result.fields,
        skipped: result.skipped,
        assetsFolder: result.assetsFolder,
      });
    } catch (error) {
      return c.json({ message: error instanceof Error ? error.message : "Internal error" }, refusalStatus(error));
    }
  });

  // An image for an image setting (a logo, a site icon), uploaded from the
  // space to the site's publisher. Same token-holding posture as the
  // settings route; the setting itself changes only on that route's Save.
  app.all("/api/space/site/image", async (c) => {
    if (c.req.method !== "POST") return c.body(null, 405);

    try {
      const body = (await c.req.json()) as Partial<SiteImageUploadRequestBody>;
      if (typeof body.path !== "string" || typeof body.image !== "string") {
        return c.json({ message: "Missing path or image." }, 400);
      }
      const siteDir = resolveWithinSpace(spaceRoot, body.path); // throws on a path escaping the space
      resolveWithinSpace(spaceRoot, body.image); // likewise for the image
      const resolved = await requirePublisherForSite(siteDir);
      if (!resolved.ok) return c.json<ErrorBody>({ message: resolved.message, need: resolved.need }, 400);

      const result = await runUploadSiteImage(spaceRoot, siteDir, resolved.publisher, body.image);
      if (!result.ok) return c.json({ message: result.message }, result.status);
      return c.json<SiteImageUploadResponse>({ publicId: result.publicId, preview: result.preview });
    } catch (error) {
      return c.json({ message: error instanceof Error ? error.message : "Internal error" }, 400);
    }
  });
}
