import { readFileSync } from "node:fs";
import path from "node:path";
import { PACKAGE_ROOT } from "../config/packageRoot.ts";
import type { ReferenceCounts } from "../protocol/api.ts";
import { FRAME_KINDS, type FrameKind } from "../protocol/flowNodes.ts";

// The format and the rules for its facts are docs/model-support.md's. A
// mistake in the file fails the generation that reads it, naming the entry,
// and the unit suite reads the shipped file, so a bad edit fails there first.

const KINDS = ["image", "video", "audio"] as const;
type ReferenceKind = (typeof KINDS)[number];

/** What the file says about one model as one host serves it. A kind with no
 * mention takes the host's default words for a reference; no `frames` means
 * nobody says which frames it takes. */
export interface ModelSupport {
  references: ReferenceCounts;
  mention: Partial<Record<ReferenceKind, string>>;
  frames?: FrameKind[];
}

interface Facts {
  references?: ReferenceCounts;
  frames?: FrameKind[];
  // null in a host's exception: the default words, whatever the model's are.
  mention?: Partial<Record<ReferenceKind, string | null>>;
}

export interface ModelSupportEntry extends Facts {
  name: string;
  ids: string[];
  hosts: Record<string, Facts>;
}

type Entry = ModelSupportEntry;

const FILE_NAME = "src/server/modelSupport.json";
let loaded: Entry[] | undefined;

/** Every entry in the shipped file, read once. */
export function modelSupportEntries(): Entry[] {
  loaded ??= parseModelSupport(readFileSync(path.join(PACKAGE_ROOT, FILE_NAME), "utf8"));
  return loaded;
}

/** The facts for the model a host calls `modelId`, with the host's
 * exception laid over them. A model the file doesn't list has none. */
export function modelSupport(modelId: string, host?: string): ModelSupport {
  return supportIn(modelSupportEntries(), modelId, host);
}

export function supportIn(list: readonly Entry[], modelId: string, host?: string): ModelSupport {
  const entry = matchEntry(list, modelId);
  if (!entry) return { references: {}, mention: {} };
  const exception = host ? entry.hosts[host] : undefined;
  const frames = exception?.frames ?? entry.frames;
  const mention: Partial<Record<ReferenceKind, string>> = {};
  for (const kind of KINDS) {
    const words = exception?.mention && kind in exception.mention ? exception.mention[kind] : entry.mention?.[kind];
    if (words) mention[kind] = words;
  }
  return { references: { ...entry.references, ...exception?.references }, mention, ...(frames ? { frames } : {}) };
}

// An id names one model exactly, or every id it starts when it ends in `*`;
// an exact id wins, then the longest start. Ids fold case, as every name
// Pragma matches does.
function matchEntry(list: readonly Entry[], modelId: string): Entry | undefined {
  const wanted = modelId.toLowerCase();
  let best: { entry: Entry; length: number } | undefined;
  for (const entry of list) {
    for (const id of entry.ids) {
      const folded = id.toLowerCase();
      if (folded === wanted) return entry;
      if (folded.endsWith("*") && wanted.startsWith(folded.slice(0, -1)) && folded.length > (best?.length ?? 0)) {
        best = { entry, length: folded.length };
      }
    }
  }
  return best?.entry;
}

/** Reads the file's text, refusing anything its format doesn't allow, so a
 * typo fails loudly instead of being read as no facts. */
export function parseModelSupport(text: string): Entry[] {
  const fail = (where: string, problem: string): never => {
    throw new Error(`${FILE_NAME}: ${where}: ${problem}. See docs/model-support.md.`);
  };
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    fail("the file", `isn't JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  const top = record(data) ?? fail("the file", "isn't an object");
  onlyKeys(top, ["$comment", "models"], "the file", fail);
  const models = record(top.models) ?? fail("models", "isn't an object");
  const seen = new Map<string, string>();
  return Object.entries(models).map(([name, value]) => {
    const raw = record(value) ?? fail(name, "isn't an object");
    onlyKeys(raw, ["ids", "references", "frames", "mention", "source", "checked", "hosts"], name, fail);
    const ids = Array.isArray(raw.ids) ? raw.ids : fail(name, "has no ids list");
    if (ids.length === 0) fail(name, "lists no ids");
    for (const id of ids) {
      const star = typeof id === "string" ? id.indexOf("*") : -1;
      if (typeof id !== "string" || !id.trim() || id === "*" || (star !== -1 && star !== id.length - 1)) {
        fail(name, `has an id that is neither a model id nor the start of one ending in *: ${JSON.stringify(id)}`);
      }
      const folded = (id as string).toLowerCase();
      const other = seen.get(folded);
      if (other) fail(name, `shares the id "${id}" with ${other}`);
      seen.set(folded, name);
    }
    sourced(raw, name, fail);
    const hosts: Record<string, Facts> = {};
    if (raw.hosts !== undefined) {
      const listed = record(raw.hosts) ?? fail(name, "hosts isn't an object");
      for (const [host, exception] of Object.entries(listed)) {
        const where = `${name}, host ${host}`;
        const facts = record(exception) ?? fail(where, "isn't an object");
        onlyKeys(facts, ["references", "frames", "mention", "source", "checked"], where, fail);
        sourced(facts, where, fail);
        hosts[host] = readFacts(facts, where, fail, true);
      }
    }
    return { name, ids: ids as string[], hosts, ...readFacts(raw, name, fail, false) };
  });
}

type Fail = (where: string, problem: string) => never;

function readFacts(raw: Record<string, unknown>, where: string, fail: Fail, exception: boolean): Facts {
  const facts: Facts = {};
  if (raw.references !== undefined) {
    const counts = record(raw.references) ?? fail(where, "references isn't an object");
    onlyKeys(counts, KINDS, `${where}, references`, fail);
    for (const [kind, count] of Object.entries(counts)) {
      if (!Number.isInteger(count) || (count as number) < 1) fail(where, `references.${kind} isn't a whole number`);
    }
    facts.references = counts as ReferenceCounts;
  }
  if (raw.frames !== undefined) {
    const frames = Array.isArray(raw.frames) ? raw.frames : fail(where, "frames isn't a list");
    for (const frame of frames) {
      if (!FRAME_KINDS.includes(frame as FrameKind))
        fail(where, `frames names ${JSON.stringify(frame)}, not start or end`);
    }
    if (new Set(frames).size !== frames.length) fail(where, "frames names a frame twice");
    facts.frames = frames as FrameKind[];
  }
  if (raw.mention !== undefined) {
    const words = record(raw.mention) ?? fail(where, "mention isn't an object");
    onlyKeys(words, KINDS, `${where}, mention`, fail);
    for (const [kind, template] of Object.entries(words)) {
      if (template === null && exception) continue;
      if (typeof template !== "string" || !template.includes("{n}")) {
        fail(where, `mention.${kind} has no {n} for the reference's place`);
      }
    }
    facts.mention = words as Facts["mention"];
  }
  return facts;
}

// Every fact names where it was read and when, so a stale one can be found.
function sourced(raw: Record<string, unknown>, where: string, fail: Fail): void {
  const sources = typeof raw.source === "string" ? [raw.source] : raw.source;
  if (!Array.isArray(sources) || sources.length === 0 || sources.some((s) => typeof s !== "string" || !s.trim())) {
    fail(where, "names no source");
  }
  if (typeof raw.checked !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw.checked)) {
    fail(where, "has no checked date, as YYYY-MM-DD");
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function onlyKeys(raw: Record<string, unknown>, allowed: readonly string[], where: string, fail: Fail): void {
  for (const key of Object.keys(raw)) if (!allowed.includes(key)) fail(where, `has an unknown key "${key}"`);
}
