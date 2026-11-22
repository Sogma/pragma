import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileStemFor, isHiddenName } from "../protocol/entryName.ts";
import { refuseLink } from "./rootedFiles.ts";
import { withFileLock } from "./spaceFiles.ts";

/** The extension a generated result of each type is saved under. */
export const IMAGE_EXTENSIONS_BY_TYPE: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

export const VIDEO_EXTENSIONS_BY_TYPE: Record<string, string> = {
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
};

/** How a result's name begins, before `_` and its digest: the prefix as its
 * run filled the dates in, `{{$number}}` still to come, and as typed,
 * placeholders and all, which a result already made is matched against.
 * Both are "" for a blank prefix, which leaves the name's `_` first and
 * which every result found carries. */
export interface ResultStart {
  filled: string;
  typed: string;
}

// The placeholders the host fills, named in any case as every placeholder
// is: the dates, and a result's number.
const PLACEHOLDERS = /\{\{\$[a-z]+(?::[^{}\n]*)?\}\}/gi;
const NUMBER = /\{\{\$number\}\}/i;
const NUMBERS = /\{\{\$number\}\}/gi;

// The private-use characters a typed prefix's placeholders stand as while it
// is repaired, so the repair never reaches inside one.
const MARK = 0xe000;
const MARKS = /[-]/g;

/** A result's start from its node's prefix, as filled and as typed, each
 * repaired as a file name is. A blank prefix starts with nothing, never the
 * prompt, which a folder of results would all start alike. */
export function resultStart(filled: string | undefined, typed: string | undefined, extension: RegExp): ResultStart {
  const start = fileStemFor(filled ?? "", extension);
  if (!start) return { filled: "", typed: "" };
  const placeholders: string[] = [];
  const marked = (typed ?? filled ?? "").replace(PLACEHOLDERS, (placeholder) => {
    placeholders.push(placeholder);
    return String.fromCharCode(MARK + placeholders.length - 1);
  });
  const repaired = fileStemFor(marked, extension).replace(
    MARKS,
    (mark) => placeholders[mark.charCodeAt(0) - MARK] ?? "",
  );
  return { filled: start, typed: repaired };
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// A typed start as a pattern of names: its own words as they stand and each
// placeholder any value, so a result made on another day, or numbered
// earlier, still carries it. The first `{{$number}}` is caught.
function startPattern(typed: string): string {
  let pattern = "";
  let from = 0;
  let caught = false;
  for (const match of typed.normalize("NFC").matchAll(PLACEHOLDERS)) {
    pattern += escapeRegExp(typed.normalize("NFC").slice(from, match.index));
    if (NUMBER.test(match[0])) {
      pattern += caught ? "\\d+" : "(\\d+)";
      caught = true;
    } else {
      pattern += ".+?";
    }
    from = match.index + match[0].length;
  }
  return pattern + escapeRegExp(typed.normalize("NFC").slice(from));
}

/** The file already in the folder for these inputs: one whose name ends in
 * `_`, the digest and an extension, in any case. One carrying `start` comes
 * first, and `carried` says whether the one found does; one that doesn't is
 * copied to the request's prefix.
 *
 * Only a regular file is found: callers read it without resolving it again,
 * and a link can point anywhere. A link carrying the start refuses, as
 * docs/protocol.md's Symbolic links says of a write naming one; read as
 * absent, the run would pay again and its save would replace the link. */
export async function findResult(
  folderPath: string,
  digest: string,
  start: ResultStart,
): Promise<{ found: string; carried: boolean } | undefined> {
  const ending = new RegExp(`_${digest}\\.[a-z0-9]+$`, "i");
  const carries = new RegExp(`^${startPattern(start.typed)}$`, "i");
  const carried = (entry: Dirent) =>
    start.typed === "" || carries.test(entry.name.normalize("NFC").replace(ending, ""));
  const digested = (await readdir(folderPath, { withFileTypes: true })).filter(
    (entry) => !isHiddenName(entry.name) && ending.test(entry.name),
  );
  const link = digested.find((entry) => entry.isSymbolicLink() && carried(entry));
  if (link) refuseLink(folderPath, path.join(folderPath, link.name));
  const files = digested.filter((entry) => entry.isFile());
  const found = files.find(carried) ?? files[0];
  return found && { found: found.name, carried: carried(found) };
}

/** Saves a new result as its start, then `_` and the digest.
 * `{{$number}}` in the start becomes one past the highest number a
 * result in the folder has under the same typed start, four digits at least,
 * taken while no other save into the folder can. `write` gets the name's path
 * without an extension and answers the path it wrote. */
export async function saveResult(
  folderPath: string,
  start: ResultStart,
  digest: string,
  write: (base: string) => Promise<string>,
): Promise<string> {
  const base = (filled: string) => path.join(folderPath, `${filled}_${digest}`);
  if (!NUMBER.test(start.filled)) return write(base(start.filled));
  return withFileLock(path.join(folderPath, "{{$number}}"), async () => {
    const numbered = new RegExp(`^${startPattern(start.typed || start.filled)}_[0-9a-f]{12}\\.[a-z0-9]+$`, "i");
    let highest = 0;
    for (const name of await readdir(folderPath)) {
      highest = Math.max(highest, Number(numbered.exec(name.normalize("NFC"))?.[1] ?? 0));
    }
    return write(base(start.filled.replace(NUMBERS, String(highest + 1).padStart(4, "0"))));
  });
}
