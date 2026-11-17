import type { SiteImagePreview, SiteSettingsField, SiteSettingsTextField } from "../protocol/api.ts";
import {
  fetchSogmaSettingsSchema,
  fetchSogmaSiteSettings,
  listSogmaFiles,
  type PublisherConnection,
  patchSogmaSiteSettings,
  type SogmaFile,
  type SogmaSettingsResult,
} from "../protocol/publisher.ts";
import { basenameOf, isLibraryPath } from "../protocol/rootedPath.ts";
import {
  flattenSettingsSchema,
  readSettingsToggle,
  readSettingsValue,
  toSettingsPatch,
} from "../protocol/settingsSchema.ts";
import { readPublishableImage, uploadImage } from "./publishAssets.ts";
import { readSiteFile } from "./sites.ts";

export type SiteSettingsResult =
  | { ok: true; siteName: string; fields: SiteSettingsField[]; skipped: number; assetsFolder: string }
  | { ok: false; message: string; field?: string; status: 400 | 404 | 502 };

// Each publisher's settings schema, cached for the life of the process
// against the ETag it served it with. It changes only on a publisher deploy,
// and every site on one publisher shares it, so re-fetching it per dialog
// open would be a round trip to learn nothing. A revalidation still happens
// on every open; the conditional request just answers 304 with no body.
//
// Keyed by publisher: two publishers serve two schemas, and one that can't
// be reached must never fall back to, or revalidate against, the other's.
const cachedSchemas = new Map<string, { etag?: string; schema: unknown }>();

async function resolveSchema(publisher: PublisherConnection): Promise<SogmaSettingsResult<{ schema: unknown }>> {
  const cached = cachedSchemas.get(publisher.id);
  const result = await fetchSogmaSettingsSchema(publisher, cached?.etag);
  if (!result.ok) {
    // A publisher that can't be reached still has a usable form if its
    // schema was fetched earlier this session: the values call below is
    // what actually needs the network, and it will report its own failure.
    if (cached) return { ok: true, schema: cached.schema };
    return result;
  }
  if (result.notModified && cached) return { ok: true, schema: cached.schema };
  if (result.schema === undefined) return { ok: false, message: "The publisher served no settings schema." };
  cachedSchemas.set(publisher.id, { etag: result.etag, schema: result.schema });
  return { ok: true, schema: result.schema };
}

// Descriptors and current values are read together and handed over as one
// list: the dialog draws controls, it doesn't merge two responses. A field
// the schema declares but this pragma can't draw is already gone by here —
// the schema flattening drops it, which is the forward-compatibility rule
// the publisher's own spec asks clients to follow.
async function fieldsFor(
  publisher: PublisherConnection,
  siteId: string,
  schema: unknown,
  settings: unknown,
): Promise<{ fields: SiteSettingsField[]; skipped: number }> {
  const { fields: descriptors, skipped } = flattenSettingsSchema(schema);
  const fields: SiteSettingsField[] = descriptors.map((descriptor) =>
    descriptor.kind === "toggle"
      ? { ...descriptor, kind: "toggle", value: readSettingsToggle(settings, descriptor.pointer) }
      : { ...descriptor, kind: descriptor.kind, value: readSettingsValue(settings, descriptor.pointer) },
  );

  // One list of the site's files serves every image field's preview. The
  // form is still usable when it fails, so a failure only costs previews.
  const images = fields.filter((field): field is SiteSettingsTextField => field.kind === "image" && field.value !== "");
  if (images.length > 0) {
    const listed = await listSogmaFiles(publisher, siteId);
    const byPublicId = new Map(listed.ok ? listed.files.map((file) => [file.publicId, file]) : []);
    for (const field of images) {
      const file = byPublicId.get(field.value);
      field.preview = file
        ? imagePreview(file)
        : { url: null, label: listed.ok ? "The site no longer has this image." : "Couldn't load a preview." };
    }
  }
  return { fields, skipped };
}

/** How the form shows a file the publisher holds. Only a ready file has a
 * URL to show; anything else says where it stands instead of drawing a
 * broken picture. */
export function imagePreview(file: SogmaFile): SiteImagePreview {
  if (file.status === "ready" && file.url) return { url: file.url, label: file.filename ?? "Image" };
  if (file.status === "failed") return { url: null, label: file.error ?? "The publisher couldn't use this image." };
  return { url: null, label: "Still processing…" };
}

/** Reads a site's settings for the Site Settings dialog: the publisher's own
 * schema, its current values, and the space's name for the site. `siteDir`
 * is the site's folder — the one holding `_site.json`. */
export async function runReadSiteSettings(
  siteDir: string,
  publisher: PublisherConnection,
): Promise<SiteSettingsResult> {
  const site = readSiteFile(siteDir);
  if (!site) return { ok: false, message: "Not a site folder.", status: 404 };

  const schema = await resolveSchema(publisher);
  if (!schema.ok) return { ok: false, message: schema.message, status: schema.httpCall ? 400 : 502 };

  const settings = await fetchSogmaSiteSettings(publisher, site.id);
  if (!settings.ok) {
    return { ok: false, message: settings.message, field: settings.field, status: settings.httpCall ? 400 : 502 };
  }

  return {
    ok: true,
    siteName: site.name,
    assetsFolder: site.assetsFolder ?? "",
    ...(await fieldsFor(publisher, site.id, schema.schema, settings.settings)),
  };
}

/** Writes the changed settings as a merge patch and returns what the service
 * stored afterwards. Nothing is written locally: the service is the store
 * for these settings, and its response is the authority on what they now
 * are. */
export async function runSaveSiteSettings(
  siteDir: string,
  publisher: PublisherConnection,
  edits: Record<string, string | boolean | null>,
): Promise<SiteSettingsResult> {
  const site = readSiteFile(siteDir);
  if (!site) return { ok: false, message: "Not a site folder.", status: 404 };

  const schema = await resolveSchema(publisher);
  if (!schema.ok) return { ok: false, message: schema.message, status: schema.httpCall ? 400 : 502 };

  const patched = await patchSogmaSiteSettings(publisher, site.id, toSettingsPatch(edits));
  if (!patched.ok) {
    return { ok: false, message: patched.message, field: patched.field, status: patched.httpCall ? 400 : 502 };
  }

  return {
    ok: true,
    siteName: site.name,
    assetsFolder: site.assetsFolder ?? "",
    ...(await fieldsFor(publisher, site.id, schema.schema, patched.settings)),
  };
}

export type SiteImageUploadResult =
  | { ok: true; publicId: string; preview: SiteImagePreview }
  | { ok: false; message: string; status: 400 | 404 | 502 };

/** Uploads one space image to the site's publisher for an image setting.
 * The setting is not touched: the dialog sends the returned `public_id` with the
 * rest of its Save, so an upload nobody saves only leaves an unused file,
 * which the service keeps at no cost to the site. */
export async function runUploadSiteImage(
  spaceRoot: string,
  siteDir: string,
  publisher: PublisherConnection,
  imagePath: string,
): Promise<SiteImageUploadResult> {
  const site = readSiteFile(siteDir);
  if (!site) return { ok: false, message: "Not a site folder.", status: 404 };

  // A setting names no document, so no embed stands as the author's choice
  // of a library file; the publishable-image reader alone would read one.
  if (isLibraryPath(imagePath))
    return { ok: false, message: "A site setting takes an image from the space.", status: 400 };
  const read = await readPublishableImage(spaceRoot, imagePath);
  if (!read.ok) {
    return { ok: false, message: read.fatal ? read.reason : `Can't use "${imagePath}": ${read.reason}.`, status: 400 };
  }
  const uploaded = await uploadImage(publisher, site.id, {
    spacePath: imagePath,
    filename: basenameOf(imagePath),
    ...read,
  });
  if (!uploaded.ok) return { ok: false, message: uploaded.message, status: uploaded.responded ? 400 : 502 };
  if (!uploaded.file.publicId) return { ok: false, message: "The publisher gave the image no public id.", status: 502 };
  return { ok: true, publicId: uploaded.file.publicId, preview: imagePreview(uploaded.file) };
}
