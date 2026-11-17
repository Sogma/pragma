// Which publisher a publishing call goes to (docs/publishing.md's Publisher
// configuration section). Every route that talks to a publishing service
// resolves its target through here rather than reaching for whatever entry
// `config.publishers` holds first — publishers are separate services
// speaking the same protocol, so "which one" has a wrong answer.
import { credentialHint, publisherKey } from "../config/credentials.ts";
import { loadGlobalConfig, resolvePublishers } from "../config/loadConfig.ts";
import type { PublisherConnection } from "../protocol/publisher.ts";
import type { SetupNeed } from "../protocol/setupNeed.ts";
import { readSiteFile } from "./sites.ts";

export type PublisherResolution =
  // `message` is written to be shown to the user as-is: every caller
  // answers with it verbatim, so the reason a publish didn't happen says
  // which publisher was wanted and what to do about it.
  { ok: true; publisher: PublisherConnection } | { ok: false; message: string; need: SetupNeed };

/**
 * A publisher that can actually be called — configured, with an endpoint
 * and a key — or the message to answer with instead. An unnamed target (New
 * Site with nothing chosen, a `_site.json` without a `publisherId`) resolves
 * to the first configured publisher.
 *
 * A *named* one no longer configured is an error, not a fallback: publishing
 * a site's documents to a different service than the one it lives on is
 * worse than not publishing them.
 */
export async function requirePublisher(publisherId?: string): Promise<PublisherResolution> {
  const publishers = resolvePublishers(loadGlobalConfig());
  const publisher = publisherId ? publishers.find((entry) => entry.id === publisherId) : publishers[0];

  if (!publisher) {
    return {
      ok: false,
      message: publisherId
        ? `This site publishes to "${publisherId}", which isn't configured. Add it in Settings > Publishing.`
        : "No publisher configured. Add one in Settings > Publishing.",
      need: { kind: "publisher" },
    };
  }
  const found = publisher.baseURL ? await publisherKey(publisher) : undefined;
  if (!found?.found) {
    return {
      ok: false,
      message: found?.problem
        ? `"${publisher.label}": ${found.problem} Set it in Settings > Publishing.`
        : `"${publisher.label}" has no API key. Set one in Settings > Publishing.${credentialHint("key")}`,
      need: { kind: "publisherKey", publisher: publisher.id },
    };
  }
  return { ok: true, publisher: { ...publisher, apiKey: found.key } };
}

/** The publisher a site is bound to, read from its own `_site.json`. Takes
 * an *absolute* directory — join `SitePublishTarget.siteDir` against
 * `spaceRoot` first. */
export function requirePublisherForSite(siteAbsoluteDir: string): Promise<PublisherResolution> {
  return requirePublisher(readSiteFile(siteAbsoluteDir)?.publisherId);
}
