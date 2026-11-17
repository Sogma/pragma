// Earlier versions of the space's files: the text a write replaced, kept as
// host state beside config.json, never inside the space, so no copy or sync
// of the space carries them. Every writer of an existing document goes
// through the one write below, which keeps that text first.
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { findSpaceId, keepsHistory, loadGlobalConfig } from "../config/loadConfig.ts";
import type { HistoryFile, HistorySource, HistoryVersion } from "../protocol/api.ts";
import { isHiddenPath } from "../protocol/relativeReference.ts";
import {
  isAppletFile,
  isClassFile,
  isFlowFile,
  isFountainFile,
  isMarkdownFile,
  isTableFile,
} from "../protocol/types.ts";
import { historyStore } from "./historyStore.ts";
import { revisionOf, withFileLock, writeFileAtomic } from "./spaceFiles.ts";

// A week, and fifty a file: enough to outlast a weekend away, short enough
// to scan.
const KEEP_MS = 7 * 24 * 60 * 60 * 1000;
const KEEP_PER_FILE = 50;
// Your own saves land every few seconds; one version per five minutes of
// them bounds a loss to what you can still remember writing.
const EDIT_INTERVAL_MS = 5 * 60 * 1000;
const MAX_BYTES = 1024 * 1024;

/** The write a version is kept for: who wrote, and for a Flow, which. */
export interface HistoryChange {
  source: HistorySource;
  detail?: string;
}

/** Writes `content` over a space document, keeping the text it replaces
 * first. A writer that goes around this leaves nothing to take back. */
export async function writeDocument(
  spaceRoot: string,
  filePath: string,
  content: string,
  change: HistoryChange,
): Promise<void> {
  await keepVersion(spaceRoot, filePath, change);
  noteKnown(spaceRoot, filePath, content);
  await writeFileAtomic(filePath, content);
}

/** Keeps what `filePath` holds now, before `change` writes over it. Best
 * effort: a version that can't be kept never stops the write it precedes. */
export async function keepVersion(spaceRoot: string, filePath: string, change: HistoryChange): Promise<void> {
  try {
    const target = historyTarget(spaceRoot, filePath);
    if (!target) return;
    const content = await readFile(filePath, "utf8").catch(() => undefined);
    if (content !== undefined) await keepText(target, content, change);
  } catch {
    // see above
  }
}

interface Target {
  spaceId: string;
  spacePath: string;
}

// Nothing is kept with history off, for a space with no id, or for a file
// outside the space, under a dot folder, or of a kind Pragma doesn't write.
function historyTarget(spaceRoot: string, filePath: string): Target | undefined {
  const spacePath = spacePathOf(spaceRoot, filePath);
  if (spacePath === undefined || isHiddenPath(spacePath) || !keepsVersionsOf(spacePath)) return undefined;
  const config = loadGlobalConfig();
  const spaceId = keepsHistory(config) ? findSpaceId(config, spaceRoot) : undefined;
  return spaceId === undefined ? undefined : { spaceId, spacePath };
}

function spacePathOf(spaceRoot: string, filePath: string): string | undefined {
  const relative = path.relative(spaceRoot, filePath);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return undefined;
  }
  return relative.split(path.sep).join("/");
}

function keepsVersionsOf(spacePath: string): boolean {
  return [isMarkdownFile, isFountainFile, isTableFile, isClassFile, isFlowFile, isAppletFile].some((is) =>
    is(spacePath),
  );
}

// Your own saves keep one version per five minutes of them, unless another
// writer came between, whose text is then what your next save replaces. A
// text the same as the newest version is never kept twice.
async function keepText({ spaceId, spacePath }: Target, content: string, change: HistoryChange): Promise<void> {
  if (Buffer.byteLength(content) > MAX_BYTES) return;
  const store = historyStore();
  // A key no file has, so a writer already holding the file's own lock
  // can keep a version without waiting on itself.
  await withFileLock(`history\0${spaceId}\0${spacePath}`, async () => {
    const versions = await store.versions(spaceId, spacePath);
    const latest = versions[0];
    const now = Date.now();
    if (change.source === "edit" && latest?.source === "edit" && now - latest.time < EDIT_INTERVAL_MS) return;
    if (latest && (await store.read(spaceId, spacePath, latest.id)) === content) return;
    const version: HistoryVersion = { id: randomUUID(), time: now, source: change.source };
    if (change.detail !== undefined) version.detail = change.detail;
    await store.add(spaceId, spacePath, version, content);
    const dropped = versions.filter((old, index) => index >= KEEP_PER_FILE - 1 || now - old.time > KEEP_MS);
    if (dropped.length > 0)
      await store.remove(
        spaceId,
        spacePath,
        dropped.map((old) => old.id),
      );
  });
}

// The texts this server last served a window or wrote, per space file, so a
// change made outside Pragma keeps what it replaced. A few each, and a write
// noted before it lands: a check racing the write finds either side known,
// and never takes Pragma's own write for someone else's. Bounded, the least
// recently noted file going first.
const KNOWN_PER_FILE = 3;
const KNOWN_BYTES = 32 * 1024 * 1024;
const known = new Map<string, { revision: string; content: string; bytes: number }[]>();
let knownBytes = 0;

/** Notes a text a window now holds for `filePath`: one just served or written. */
export function noteKnown(spaceRoot: string, filePath: string, content: string): void {
  const spacePath = spacePathOf(spaceRoot, filePath);
  if (spacePath === undefined || !keepsVersionsOf(spacePath)) return;
  const bytes = Buffer.byteLength(content);
  if (bytes > MAX_BYTES) return;
  const revision = revisionOf(content);
  const texts = [
    ...(known.get(filePath) ?? []).filter((text) => text.revision !== revision),
    { revision, content, bytes },
  ];
  forget(filePath);
  const kept = texts.slice(-KNOWN_PER_FILE);
  known.set(filePath, kept);
  knownBytes += kept.reduce((sum, text) => sum + text.bytes, 0);
  for (const [oldest] of known) {
    if (knownBytes <= KNOWN_BYTES || oldest === filePath) break;
    forget(oldest);
  }
}

function forget(filePath: string): void {
  for (const text of known.get(filePath) ?? []) knownBytes -= text.bytes;
  known.delete(filePath);
}

/** Told a space file's revision as a window asks after it, null when the file
 * is gone. One past every text Pragma knows for it changed outside Pragma,
 * and the last known text is kept as the version that change replaced. */
export function noticeRevision(spaceRoot: string, filePath: string, revision: string | null): void {
  const texts = known.get(filePath);
  if (!texts || texts.some((text) => text.revision === revision)) return;
  const replaced = texts[texts.length - 1];
  forget(filePath);
  try {
    const target = historyTarget(spaceRoot, filePath);
    if (target) void keepText(target, replaced.content, { source: "outside" }).catch(() => undefined);
  } catch {
    // An unreadable config keeps nothing.
  }
}

function spaceIdOf(spaceRoot: string): string | undefined {
  return findSpaceId(loadGlobalConfig(), spaceRoot);
}

/** Every file with a version, most recently kept first. A file whose every
 * version has run out is dropped from the store as it is found. */
export async function historyFiles(spaceRoot: string): Promise<HistoryFile[]> {
  const spaceId = spaceIdOf(spaceRoot);
  if (spaceId === undefined) return [];
  const store = historyStore();
  const cutoff = Date.now() - KEEP_MS;
  const files: HistoryFile[] = [];
  for (const file of await store.files(spaceId)) {
    if (file.latest >= cutoff) files.push(file);
    else
      await store.remove(
        spaceId,
        file.path,
        (await store.versions(spaceId, file.path)).map(({ id }) => id),
      );
  }
  return files;
}

/** A file's versions, newest first, without the ones run out. */
export async function historyVersions(spaceRoot: string, spacePath: string): Promise<HistoryVersion[]> {
  const spaceId = spaceIdOf(spaceRoot);
  if (spaceId === undefined) return [];
  const store = historyStore();
  const cutoff = Date.now() - KEEP_MS;
  const versions = await store.versions(spaceId, spacePath);
  const expired = versions.filter((version) => version.time < cutoff).map(({ id }) => id);
  if (expired.length > 0) await store.remove(spaceId, spacePath, expired);
  return versions.filter((version) => version.time >= cutoff);
}

export async function historyVersion(spaceRoot: string, spacePath: string, id: string): Promise<string | undefined> {
  const spaceId = spaceIdOf(spaceRoot);
  return spaceId === undefined ? undefined : historyStore().read(spaceId, spacePath, id);
}

/** Carries the versions of an entry, a file or everything in a folder, to
 * where a move put it. Best effort, as the move's other bookkeeping is. */
export async function moveHistory(spaceRoot: string, fromPath: string, toPath: string): Promise<void> {
  const from = spacePathOf(spaceRoot, fromPath);
  const to = spacePathOf(spaceRoot, toPath);
  try {
    const spaceId = spaceIdOf(spaceRoot);
    if (spaceId !== undefined && from !== undefined && to !== undefined) await historyStore().move(spaceId, from, to);
  } catch {
    // see above
  }
}

export async function clearHistory(spaceRoot: string): Promise<void> {
  const spaceId = spaceIdOf(spaceRoot);
  if (spaceId !== undefined) await historyStore().clear(spaceId);
}
