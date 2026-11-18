import {
  fetchSogmaApiSchemas,
  type PublisherConnection,
  type SogmaApiSchemas,
  type SogmaSettingsResult,
} from "../protocol/publisher.ts";

// Each publisher's schemas, cached for the life of the process against the
// ETag they were served with. They change only on a publisher deploy, and
// every site on one publisher shares them, so re-fetching them per use would
// be a round trip to learn nothing. A revalidation still happens on every
// use; the conditional request just answers 304 with no body.
//
// Keyed by publisher: two publishers serve two descriptions, and one that
// can't be reached must never fall back to, or revalidate against, the other's.
const cachedSchemas = new Map<string, { etag?: string; schemas: SogmaApiSchemas }>();

/** The schemas a publisher's API description holds, for the Site Settings
 * dialog and for a page's `params`. */
export async function resolvePublisherSchemas(
  publisher: PublisherConnection,
): Promise<SogmaSettingsResult<{ schemas: SogmaApiSchemas }>> {
  const cached = cachedSchemas.get(publisher.id);
  const result = await fetchSogmaApiSchemas(publisher, cached?.etag);
  if (!result.ok) {
    // A publisher that can't be reached still has usable schemas if they were
    // fetched earlier this session: the call that follows is what actually
    // needs the network, and it will report its own failure.
    if (cached) return { ok: true, schemas: cached.schemas };
    return result;
  }
  if (result.notModified && cached) return { ok: true, schemas: cached.schemas };
  if (result.schemas === undefined) return { ok: false, message: "The publisher served no API description." };
  cachedSchemas.set(publisher.id, { etag: result.etag, schemas: result.schemas });
  return { ok: true, schemas: result.schemas };
}
