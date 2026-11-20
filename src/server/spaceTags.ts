// The space's `_tags.json` (docs/protocol.md's Tags): read whole, changed one
// tag at a time against the file as it stands, so a change made from another
// window, or by hand, survives the next one made here.
import { existsSync, readFileSync } from "node:fs";
import { unlink } from "node:fs/promises";
import type { SpaceTagsResponse } from "../protocol/api.ts";
import {
  serializeTagsFile,
  TAGS_FILENAME,
  type TagChange,
  type TagDefinition,
  tagDefinitions,
  tagKey,
  withTagChange,
} from "../protocol/tags.ts";
import { documentIndex } from "./documentIndex.ts";
import { presetPaths } from "./presets.ts";
import { linkBelow, namedEntryPath, refuseLink } from "./rootedFiles.ts";
import { writeFileAtomic } from "./spaceFiles.ts";

/** A `_tags.json` that exists but can't be read. Never written over: the
 * write would replace whatever someone wrote by hand with one tag. */
export class TagsFileError extends Error {}

// A file whose tags read as none, and why, when it exists but doesn't read.
function readTagsFile(spaceRoot: string): { file: Record<string, unknown> | undefined; problem?: string } {
  const filePath = namedEntryPath(spaceRoot, TAGS_FILENAME);
  // A link reads as absent, as every file Pragma names itself does.
  if (!existsSync(filePath) || linkBelow(spaceRoot, filePath) !== undefined) return { file: undefined };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { file: undefined, problem: `${TAGS_FILENAME} doesn't parse: ${reason}` };
  }
  const isObject = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed);
  const file = isObject ? (parsed as Record<string, unknown>) : undefined;
  if (!file || (file.tags !== undefined && !Array.isArray(file.tags))) {
    return { file: undefined, problem: `${TAGS_FILENAME} holds no list of tags` };
  }
  return { file };
}

/** The declared tags, in file order. Missing reads as none declared. */
export function readSpaceTags(spaceRoot: string): SpaceTagsResponse {
  const { file, problem } = readTagsFile(spaceRoot);
  return problem === undefined ? { tags: tagDefinitions(file) } : { tags: [], problem };
}

/** Applies one tag's change and answers with the tags as they now are. No
 * tags and nothing else in it leaves no file. */
export async function changeSpaceTag(spaceRoot: string, change: TagChange): Promise<SpaceTagsResponse> {
  const filePath = namedEntryPath(spaceRoot, TAGS_FILENAME);
  refuseLink(spaceRoot, filePath);
  const { file, problem } = readTagsFile(spaceRoot);
  if (problem !== undefined) throw new TagsFileError(`${problem}. Fix the file, then try again.`);
  const next = withTagChange(file, change);
  const tags = next.tags as unknown[];
  if (tags.length === 0 && Object.keys(next).length === 1) {
    if (existsSync(filePath)) await unlink(filePath);
  } else {
    await writeFileAtomic(filePath, serializeTagsFile(next));
  }
  return { tags: tagDefinitions(next) };
}

/** The tags the space's documents carry that no entry in `declared` names,
 * each once, spelled as most documents carrying it write it, in name order:
 * the walk finds documents in no fixed order. A preset's are left out, as
 * the space's content never holds one. */
export async function undeclaredTags(spaceRoot: string, declared: readonly TagDefinition[]): Promise<string[]> {
  const named = new Set(declared.map((tag) => tagKey(tag.name)));
  const isPreset = presetPaths(spaceRoot);
  const spellings = new Map<string, Map<string, number>>();
  for (const document of await documentIndex().tagged({ dir: spaceRoot, root: "space" })) {
    if (isPreset(document.path)) continue;
    for (const name of new Set(document.tags.map((tag) => tag.name))) {
      const key = tagKey(name);
      if (named.has(key)) continue;
      const counts = spellings.get(key) ?? new Map<string, number>();
      counts.set(name, (counts.get(name) ?? 0) + 1);
      spellings.set(key, counts);
    }
  }
  return [...spellings.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(
      ([, counts]) =>
        [...counts].sort(([a, countA], [b, countB]) => countB - countA || (a < b ? -1 : a > b ? 1 : 0))[0][0],
    );
}
