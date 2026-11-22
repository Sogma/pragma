// The space's `_tags.json` (docs/protocol.md's Tags): read whole, changed one
// tag at a time against the file as it stands, so a change made from another
// window, or by hand, survives the next one made here.
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
import { type EntryListFileKind, readEntryListFile } from "./entryListFile.ts";
import { presetPaths } from "./presets.ts";
import { namedEntryPath } from "./rootedFiles.ts";
import { changeEntryListFile } from "./spaceFiles.ts";

const TAGS_FILE: EntryListFileKind = {
  name: TAGS_FILENAME,
  at: (spaceRoot) => namedEntryPath(spaceRoot, TAGS_FILENAME),
  lists: ["tags"],
  serialize: serializeTagsFile,
  noList: `${TAGS_FILENAME} holds no list of tags`,
};

/** The declared tags, in file order. Missing reads as none declared. */
export function readSpaceTags(spaceRoot: string): SpaceTagsResponse {
  const { file, problem } = readEntryListFile(spaceRoot, TAGS_FILE);
  return problem === undefined ? { tags: tagDefinitions(file) } : { tags: [], problem };
}

/** Applies one tag's change and answers with the tags as they now are. No
 * tags and nothing else in it leaves no file. */
export async function changeSpaceTag(spaceRoot: string, change: TagChange): Promise<SpaceTagsResponse> {
  const next = await changeEntryListFile(spaceRoot, TAGS_FILE, (file) => withTagChange(file, change));
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
