// Sharing: a file a provider fetches by link goes into the person's own
// bucket for the length of its job, behind a link that expires. Files are
// deleted when their job ends, and whatever a job that never ended left
// behind is swept once its links have expired.
import { randomBytes } from "node:crypto";
import { sharingKey } from "../config/credentials.ts";
import { loadGlobalConfig, type ResolvedSharing, resolveSharing } from "../config/loadConfig.ts";
import { SetupError } from "../protocol/setupNeed.ts";
import { extensionForMediaType } from "../protocol/types.ts";
import { regionOf, type S3Client, s3Client } from "./s3.ts";

export interface SharedFile {
  url: string;
  key: string;
}

export interface LinkSharing {
  share(file: { mediaType: string; data: Uint8Array }, signal?: AbortSignal): Promise<SharedFile>;
  /** Deletes shared files, as far as it can: a failure leaves the file for
   * the sweep, never fails the caller. */
  unshare(keys: readonly string[]): Promise<void>;
}

// A provider may queue a job before fetching its inputs, so a link lasts a
// day; the sweep waits a day past that.
const LINK_SECONDS = 24 * 60 * 60;
const SWEEP_AFTER_MS = 2 * LINK_SECONDS * 1000;
const SWEEP_EVERY_MS = 6 * 60 * 60 * 1000;

// Every shared file's key starts here, so the sweep never touches anything
// else in the bucket.
export const SHARED_PREFIX = "pragma-shared/";

let installed: (() => Promise<LinkSharing | undefined>) | undefined;

/** Installs how sharing is opened, for a host that keeps files elsewhere, or
 * a test; undefined restores the bucket config.json names. */
export function setLinkSharing(open: (() => Promise<LinkSharing | undefined>) | undefined): void {
  installed = open;
}

/** The sharing set up on this host, or undefined when there is none. A setup
 * whose secret can't be read here is refused by name. */
export function linkSharing(): Promise<LinkSharing | undefined> {
  return (installed ?? configuredSharing)();
}

/** The refusal of a request that needs sharing with none set up. */
export function sharingNeeded(label: string): SetupError {
  return new SetupError(`${label} takes frames and references as links. Set up Sharing in Settings.`, {
    kind: "sharing",
  });
}

async function configuredSharing(): Promise<LinkSharing | undefined> {
  const sharing = resolveSharing(loadGlobalConfig());
  if (!sharing) return undefined;
  const found = await sharingKey(sharing);
  if (!found.found) {
    throw new SetupError(found.problem ?? "Sharing has no secret key saved. Enter it in Settings.", {
      kind: "sharing",
    });
  }
  return bucketSharing(clientFor(sharing, found.key), { sweepKey: `${sharing.endpoint}/${sharing.bucket}` });
}

/** The client for a sharing setup and its secret. */
export function clientFor(sharing: ResolvedSharing, secretAccessKey: string): S3Client {
  return s3Client({
    endpoint: sharing.endpoint,
    bucket: sharing.bucket,
    region: regionOf(sharing.endpoint, sharing.region),
    accessKeyId: sharing.accessKeyId,
    secretAccessKey,
  });
}

// When each bucket was last swept, by `sweepKey`: however many files go in,
// a bucket is listed at most once every six hours.
const lastSweep = new Map<string, number>();

/** Sharing through one bucket. `sweepKey` names the bucket for the sweep's
 * pace, so two setups in one process don't hold each other back. */
export function bucketSharing(client: S3Client, deps: { now?: () => number; sweepKey?: string } = {}): LinkSharing {
  const now = deps.now ?? Date.now;
  const sweepKey = deps.sweepKey ?? "default";

  async function sweep(): Promise<void> {
    const at = now();
    if (at - (lastSweep.get(sweepKey) ?? 0) < SWEEP_EVERY_MS) return;
    lastSweep.set(sweepKey, at);
    const stale = (await client.list(SHARED_PREFIX)).filter((object) => at - object.lastModified > SWEEP_AFTER_MS);
    for (const object of stale) await client.delete(object.key).catch(() => {});
  }

  return {
    async share(file, signal) {
      const extension = extensionForMediaType(file.mediaType);
      const key = `${SHARED_PREFIX}${randomBytes(16).toString("hex")}${extension ? `.${extension}` : ""}`;
      await client.put(key, file.data, file.mediaType, signal);
      void sweep().catch(() => {});
      return { key, url: client.link(key, LINK_SECONDS) };
    },
    async unshare(keys) {
      await Promise.all(keys.map((key) => client.delete(key).catch(() => {})));
    },
  };
}

/** Puts a small file in the bucket, reads it back by its link with no
 * credentials, as a provider would, and deletes it. Throws, saying which
 * step failed, when any does. */
export async function checkSharing(client: S3Client, deps: { fetch?: typeof fetch } = {}): Promise<void> {
  const read = deps.fetch ?? fetch;
  const key = `${SHARED_PREFIX}check-${randomBytes(8).toString("hex")}.txt`;
  const text = `Pragma checked this bucket at ${new Date().toISOString()}.`;
  try {
    await client.put(key, new TextEncoder().encode(text), "text/plain");
  } catch (error) {
    throw new Error(`Couldn't put a file in the bucket. ${messageOf(error)}`);
  }
  try {
    const response = await read(client.link(key, 60));
    if (!response.ok) throw new Error(`The link answered ${response.status}.`);
    if ((await response.text()) !== text) throw new Error("The link answered with other content.");
  } catch (error) {
    await client.delete(key).catch(() => {});
    throw new Error(`The file went in, but its link didn't open it. ${messageOf(error)}`);
  }
  try {
    await client.delete(key);
  } catch (error) {
    throw new Error(`The file went in and its link worked, but it couldn't be deleted. ${messageOf(error)}`);
  }
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));
