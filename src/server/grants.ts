// Capability approvals, read and written through the installed grant store
// (grantStore.ts), an accidental-propagation guard, not a local attacker
// defense (docs/architecture.md's Space identity and state ownership).
//
// Pinned to a content hash, so edited logic re-prompts; a flow hashes its
// capability digest (flowFile.ts) so dragging a node doesn't. Keyed by path,
// never id — every copy keeps the id — so a copy or a move is prompted fresh.
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { findSpaceId, loadGlobalConfig } from "../config/loadConfig.ts";
import { localDay, parseLocalDay } from "../protocol/localDay.ts";
import { type GrantRecord, grantStore } from "./grantStore.ts";

// Who a grant belongs to. `path` is the grant key below; `contentHash` is
// the hash the caller computed from the file as it is right now, and an entry
// counts only if it was recorded at this exact hash.
export interface GrantSubject {
  path: string;
  contentHash: string;
}

/** A flow's leave to run unattended: whether it holds on a given day, and
 * the last day it was given, passed or not, when it was given one. */
export interface UnattendedStanding {
  allowed: boolean;
  until?: string;
}

/** The key a document's grants are stored under: its space-relative path,
 * `/`-separated and lexically normalized, and otherwise spelled exactly as
 * given. Never folded by case or Unicode — two spellings of one file only
 * cost a re-prompt, but two files folded onto one key would share their
 * approvals. `filePath` is the absolute path the request resolved to. */
export function grantPath(spaceRoot: string, filePath: string): string {
  return path.relative(spaceRoot, filePath).split(path.sep).join("/");
}

/** A served space is always registered — every path that opens one
 * registers it — so an unregistered spaceRoot here means that
 * invariant broke. Reads treat it as "nothing granted", which fails closed;
 * writes throw, because silently discarding an approval a human just clicked
 * would re-prompt forever with no way to notice why. */
function spaceIdFor(spaceRoot: string): string | undefined {
  return findSpaceId(loadGlobalConfig(), spaceRoot);
}

function requireSpaceId(spaceRoot: string): string {
  const id = spaceIdFor(spaceRoot);
  if (!id) throw new Error(`Cannot record a grant: ${spaceRoot} is not a registered space.`);
  return id;
}

// The record at the subject's hash: one at another hash counts for nothing.
async function recordFor(spaceRoot: string, subject: GrantSubject): Promise<GrantRecord | undefined> {
  const id = spaceIdFor(spaceRoot);
  const record = id === undefined ? undefined : await grantStore().get(id, subject.path);
  return record?.contentHash === subject.contentHash ? record : undefined;
}

/** Whether a document whose approvals are kept is gone, so approvals for
 * deleted files don't pile up. Only a definite ENOENT counts: a file that
 * can't be checked — permissions, I/O, a network drive timing out — isn't
 * known to be gone. A missing space folder counts nothing, since the space
 * is then unreachable rather than emptied. */
function goneFrom(spaceRoot: string): (documentPath: string) => boolean {
  if (!existsSync(spaceRoot)) return () => false;
  return (documentPath) => {
    try {
      statSync(path.join(spaceRoot, documentPath));
      return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT";
    }
  };
}

/** Sets the record at `subject`'s path and hash from the one there now,
 * replacing whatever that path held: one at another hash was approved for
 * the file's earlier content, which the approval a human just gave
 * supersedes. A change returning nothing writes nothing. */
function record(
  spaceRoot: string,
  subject: GrantSubject,
  change: (current: GrantRecord | undefined) => Omit<GrantRecord, "contentHash"> | undefined,
): Promise<GrantRecord | undefined> {
  return grantStore().update(
    requireSpaceId(spaceRoot),
    subject.path,
    (stored) => {
      const next = change(stored?.contentHash === subject.contentHash ? stored : undefined);
      return next && { contentHash: subject.contentHash, ...next };
    },
    goneFrom(spaceRoot),
  );
}

/** Drops every approval recorded for a space, by **id** rather than path —
 * the Manage Spaces actions that need this (Reset approvals, Forget) act on a
 * registry entry whose folder may have been moved or deleted, so there is no
 * path to resolve. */
export async function clearSpaceGrants(spaceId: string): Promise<void> {
  await grantStore().clear(spaceId);
}

/** Whether `capabilityKey` is currently granted to `subject` — false with no
 * entry at the subject's current hash. */
export async function isCapabilityGranted(
  spaceRoot: string,
  subject: GrantSubject,
  capabilityKey: string,
): Promise<boolean> {
  return (await recordFor(spaceRoot, subject))?.capabilities[capabilityKey] === true;
}

/** Every capability key currently valid for `subject` — what a file
 * response reports alongside the manifest, so the client knows upfront
 * which declared capabilities still need a first-use prompt. */
export async function grantedCapabilities(spaceRoot: string, subject: GrantSubject): Promise<string[]> {
  const found = await recordFor(spaceRoot, subject);
  return Object.entries(found?.capabilities ?? {})
    .filter(([, granted]) => granted)
    .map(([key]) => key);
}

/** Records `capabilityKey` as granted to `subject`. Earlier grants carry
 * forward only at the same hash; at a new one the entry starts over — the
 * same all-or-nothing invalidation the check above applies on read. */
export async function grantCapability(spaceRoot: string, subject: GrantSubject, capabilityKey: string): Promise<void> {
  await record(spaceRoot, subject, (existing) => ({
    capabilities: { ...existing?.capabilities, [capabilityKey]: true },
    unattended: existing?.unattended,
  }));
}

/** Revokes `capabilityKey` for `subject` — the deliberate counterpart to a
 * hash mismatch. A no-op when there is no entry at the subject's hash. */
export async function revokeCapability(spaceRoot: string, subject: GrantSubject, capabilityKey: string): Promise<void> {
  await record(spaceRoot, subject, (existing) => {
    if (!existing) return undefined;
    const { [capabilityKey]: _revoked, ...capabilities } = existing.capabilities;
    return { capabilities, unattended: existing.unattended };
  });
}

/** Carries the entry at `documentPath` from `fromHash` to `toHash`,
 * capabilities untouched — the one deliberate exception to "a content change
 * invalidates every grant", taken only once the caller has proven the change
 * cannot alter what was approved. Resolves false, a no-op, when the entry is
 * not at `fromHash`. */
export async function remapGrantHash(
  spaceRoot: string,
  documentPath: string,
  fromHash: string,
  toHash: string,
): Promise<boolean> {
  const moved = await grantStore().update(
    requireSpaceId(spaceRoot),
    documentPath,
    (stored) => (stored?.contentHash === fromHash ? { ...stored, contentHash: toHash } : undefined),
    goneFrom(spaceRoot),
  );
  return moved !== undefined;
}

/** `subject`'s leave to run with nobody at the canvas, on `now`'s day —
 * none with no entry at the subject's current hash. A last day holds through
 * its end. One that names no real day holds nothing, so a hand-edited typo
 * fails closed. */
export async function unattendedStanding(
  spaceRoot: string,
  subject: GrantSubject,
  now: Date = new Date(),
): Promise<UnattendedStanding> {
  const recorded = (await recordFor(spaceRoot, subject))?.unattended;
  if (recorded === true) return { allowed: true };
  if (typeof recorded !== "string" || !parseLocalDay(recorded)) return { allowed: false };
  return { allowed: localDay(now) <= recorded, until: recorded };
}

/** Whether `subject` may run with nobody at the canvas on `now`'s day. */
export async function isUnattendedGranted(spaceRoot: string, subject: GrantSubject, now?: Date): Promise<boolean> {
  return (await unattendedStanding(spaceRoot, subject, now)).allowed;
}

/** Grants `subject`'s leave to run unattended, through the end of `until`
 * (`YYYY-MM-DD`) or, without one, until revoked; or withdraws it. Granting
 * at a hash with no entry starts one with no capabilities, exactly as
 * granting a capability does. */
export async function setUnattended(
  spaceRoot: string,
  subject: GrantSubject,
  allowed: boolean,
  until?: string,
): Promise<void> {
  await record(spaceRoot, subject, (existing) => {
    if (!existing && !allowed) return undefined;
    return { capabilities: existing?.capabilities ?? {}, unattended: allowed ? (until ?? true) : undefined };
  });
}
