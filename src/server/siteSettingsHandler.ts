import {
  SITE_ASSETS_FOLDER_FIELD,
  SITE_NAME_FIELD,
  type SiteImagePreview,
  type SiteSettingsChanges,
  type SiteSettingsField,
  type SiteSettingsTextField,
} from "../protocol/api.ts";
import {
  fetchSogmaSiteSettings,
  listSogmaFiles,
  type PublisherConnection,
  patchSogmaSite,
  readSogmaSiteName,
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
import type { SetupNeed } from "../protocol/setupNeed.ts";
import { readPublishableImage, uploadImage } from "./publishAssets.ts";
import { resolvePublisherSchemas } from "./publisherSchemas.ts";
import type { PublisherResolution } from "./publishers.ts";
import { normalizeAssetsFolder, readSiteFile, updateSiteFile } from "./sites.ts";

type SiteRefusal = { ok: false; message: string; field?: string; need?: SetupNeed; status: 400 | 404 | 502 };

export type SiteSaveResult = { ok: true; siteName: string; assetsFolder: string } | SiteRefusal;

export type SiteSettingsResult =
  | {
      ok: true;
      siteName: string;
      siteNameUpdated?: boolean;
      fields: SiteSettingsField[];
      skipped: number;
      assetsFolder: string;
    }
  | SiteRefusal;

async function resolveSchema(publisher: PublisherConnection): Promise<SogmaSettingsResult<{ schema: unknown }>> {
  const resolved = await resolvePublisherSchemas(publisher);
  if (!resolved.ok) return resolved;
  if (resolved.schemas.settings === undefined) {
    return { ok: false, message: "The publisher's API description carries no settings schema." };
  }
  return { ok: true, schema: resolved.schemas.settings };
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
function imagePreview(file: SogmaFile): SiteImagePreview {
  if (file.status === "ready" && file.url) return { url: file.url, label: file.filename ?? "Image" };
  if (file.status === "failed") return { url: null, label: file.error ?? "The publisher couldn't use this image." };
  return { url: null, label: "Still processing…" };
}

/** Reads a site's settings for the Site Settings dialog: the publisher's own
 * schema, its current values, and the site's name. `siteDir` is the site's
 * folder — the one holding `_site.json`. */
export async function runReadSiteSettings(
  siteDir: string,
  publisher: PublisherConnection,
): Promise<SiteSettingsResult> {
  const site = readSiteFile(siteDir);
  if (!site) return { ok: false, message: "Not a site folder.", status: 404 };

  const schema = await resolveSchema(publisher);
  if (!schema.ok) return { ok: false, message: schema.message, status: schema.responded ? 400 : 502 };

  const [settings, heldName] = await Promise.all([
    fetchSogmaSiteSettings(publisher, site.id),
    readSogmaSiteName(publisher, site.id),
  ]);
  if (!settings.ok) {
    return { ok: false, message: settings.message, field: settings.field, status: settings.responded ? 400 : 502 };
  }

  // The publisher owns the name. `_site.json` keeps a copy for what reads
  // the space alone (the tree, the Websites list), put right here when the
  // site was renamed elsewhere. Best-effort both ways: an unread name falls
  // back to the copy, and a failed write only leaves a stale label.
  let siteNameUpdated = false;
  if (heldName !== undefined && heldName !== site.name) {
    try {
      await updateSiteFile(siteDir, { name: heldName });
      siteNameUpdated = true;
    } catch {
      // the dialog still shows the publisher's name
    }
  }

  return {
    ok: true,
    siteName: heldName ?? site.name,
    ...(siteNameUpdated ? { siteNameUpdated } : {}),
    assetsFolder: site.assetsFolder ?? "",
    ...(await fieldsFor(publisher, site.id, schema.schema, settings.settings)),
  };
}

// Sogma points from the request body. The dialog keys the name by its own
// field and each setting by its pointer inside `settings`; anything else
// names no control, so the refusal is shown for the whole form.
function controlFor(field: string | undefined): string | undefined {
  if (field === "/name") return SITE_NAME_FIELD;
  return field?.startsWith("/settings/") ? field.slice("/settings".length) : undefined;
}

/** One Save, all or nothing: the assets folder is checked before anything
 * is sent, the name and the edited settings go to the publisher in one
 * request, and only once it accepts them are the name it stored and the
 * assets folder written to `_site.json`. A change to the assets folder
 * alone never reaches the publisher, which is resolved only to send. */
export async function runSaveSiteSettings(
  siteDir: string,
  publisherFor: () => Promise<PublisherResolution>,
  changes: SiteSettingsChanges,
): Promise<SiteSaveResult> {
  const site = readSiteFile(siteDir);
  if (!site) return { ok: false, message: "Not a site folder.", status: 404 };

  let assetsFolder: string | undefined;
  if (changes.assetsFolder !== undefined) {
    const folder = normalizeAssetsFolder(changes.assetsFolder);
    if (!folder.ok) return { ok: false, message: folder.message, field: SITE_ASSETS_FOLDER_FIELD, status: 400 };
    assetsFolder = folder.folder;
  }

  let name: string | undefined;
  const settings = Object.keys(changes.edits).length > 0 ? toSettingsPatch(changes.edits) : undefined;
  if (changes.name !== undefined || settings !== undefined) {
    const resolved = await publisherFor();
    if (!resolved.ok) return { ok: false, message: resolved.message, need: resolved.need, status: 400 };
    const patched = await patchSogmaSite(resolved.publisher, site.id, { name: changes.name, settings });
    if (!patched.ok) {
      const field = controlFor(patched.field);
      return {
        ok: false,
        message: patched.message,
        ...(field ? { field } : {}),
        status: patched.responded ? 400 : 502,
      };
    }
    if (changes.name !== undefined) name = patched.name ?? changes.name.trim();
  }

  if (name !== undefined || assetsFolder !== undefined) await updateSiteFile(siteDir, { name, assetsFolder });
  return { ok: true, siteName: name ?? site.name, assetsFolder: assetsFolder ?? site.assetsFolder ?? "" };
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
