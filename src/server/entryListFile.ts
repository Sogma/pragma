// A JSON file a space keeps a list of entries in, as this host reads it: a
// missing file or a link holds nothing, and one that doesn't read says why,
// so a change refuses it rather than writing over what someone wrote by hand.
//
// Nothing here may reach rootedFiles.ts: libraries.ts reads through this
// module, and rootedFiles.ts resolves library paths through libraries.ts. The
// writer, which goes through the write doorway, is in spaceFiles.ts.
import { existsSync, readFileSync } from "node:fs";
import { linkBelow } from "./entryOnDisk.ts";

/** A kind of list file, as a space keeps it. */
export interface EntryListFileKind {
  /** Its name in the problems it reports. */
  name: string;
  /** Where it is in a space. */
  at(spaceRoot: string): string;
  /** The keys that hold its lists. */
  lists: readonly string[];
  serialize(file: Record<string, unknown>): string;
  /** The problem when it holds no object, or a list key holds no list. */
  noList: string;
  /** The problem when list key `key` holds no list, where it says more. */
  notList?(key: string): string;
  /** A folder of its own, made for it and removed with it once empty. */
  folder?(spaceRoot: string): string;
}

/** A list file that exists but can't be read. Never written over: the write
 * would replace whatever someone wrote by hand with one entry. */
export class EntryListFileError extends Error {
  constructor(problem: string) {
    super(`${problem}. Fix the file, then try again.`);
    this.name = "EntryListFileError";
  }
}

/** `kind`'s file in `spaceRoot`, or why it holds nothing when it exists but
 * doesn't read. */
export function readEntryListFile(
  spaceRoot: string,
  kind: EntryListFileKind,
): { file: Record<string, unknown> | undefined; problem?: string } {
  const filePath = kind.at(spaceRoot);
  if (!existsSync(filePath) || linkBelow(spaceRoot, filePath) !== undefined) return { file: undefined };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { file: undefined, problem: `${kind.name} doesn't parse: ${reason}` };
  }
  const isObject = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed);
  const file = isObject ? (parsed as Record<string, unknown>) : undefined;
  if (!file) return { file: undefined, problem: kind.noList };
  const notList = kind.lists.find((key) => file[key] !== undefined && !Array.isArray(file[key]));
  if (notList !== undefined) return { file: undefined, problem: kind.notList?.(notList) ?? kind.noList };
  return { file };
}
