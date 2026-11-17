// docs/protocol.md's World names: which names in a Fountain screenplay link,
// and to which file. Pure string work over a line's text and a file list, so
// every host that links a screenplay links the same names to the same files.

import { entryNameKey } from "./entryName.ts";
import { fountainToken, settledToken } from "./fountainElements.ts";
import { fountainNotes, frameLine, startFrame } from "./fountainLines.ts";
import { sceneNumber } from "./fountainSceneNumber.ts";
import { createNameIndex, type NameIndex, uniqueStem } from "./nameIndex.ts";
import { dirnameOf } from "./rootedPath.ts";
import { type ScopeBlocks, settingFolderFor, WORLD_SETTING } from "./scopeSettings.ts";
import { mediaTypeForPath } from "./types.ts";

/** The kinds of screenplay line a name is read from. */
export type WorldNameLine = "character" | "scene-heading" | "action";

const WORLD_NAME_LINES: Record<string, WorldNameLine> = {
  "fountain-character": "character",
  "fountain-character-dual": "character",
  "fountain-scene-heading": "scene-heading",
  "fountain-action": "action",
};

/** The kind of line a settled Fountain token's names are read from, or
 * undefined for a line whose names never link. */
export function worldNameLine(token: string): WorldNameLine | undefined {
  return Object.hasOwn(WORLD_NAME_LINES, token) ? WORLD_NAME_LINES[token] : undefined;
}

/** A linked name: its span in the line's text and the file it names. */
export interface WorldName {
  from: number;
  to: number;
  path: string;
}

/** The folder holding the world of the screenplay at `docPath`: the one the
 * World setting of its nearest scope that sets one names, or undefined. */
export function worldFolder(blocks: ScopeBlocks, docPath: string): string | undefined {
  return settingFolderFor(blocks, dirnameOf(docPath), WORLD_SETTING);
}

/** Every file under `folder` but media, indexed by name. The folder
 * compares folded, as entry names do.
 * Media stays out so a picture saved beside its note, `Lina.jpg` beside
 * `Lina.md`, never makes the name ambiguous and unlinks it. */
export function createWorldIndex(paths: readonly string[], folder: string): NameIndex {
  const prefix = entryNameKey(`${folder}/`);
  return createNameIndex(
    paths.filter((filePath) => entryNameKey(filePath).startsWith(prefix) && !mediaTypeForPath(filePath)),
  );
}

/** The one world file whose basename, extension stripped, is `name`; two
 * files sharing it leave the name unlinked. */
export function resolveWorldName(world: NameIndex, name: string): string | undefined {
  return uniqueStem(world, name.replace(/\s+/g, " ").trim());
}

interface Word {
  from: number;
  // End of the word less a possessive `'s`, which is tried with and without.
  to: number;
  end: number;
}

const WORD = /[\p{L}\p{N}](?:[\p{L}\p{N}'’-]*[\p{L}\p{N}])?/gu;
const POSSESSIVE = /['’]s$/i;
const CUE = /^(\s*@?\s*)(.*?)\s*(?:\([^)]*\)\s*)*\^?\s*$/;
const HEADING_PREFIX = /^\s*(?:\.(?!\.)|(?:int\.?\/ext|ext\.?\/int|i\.?\/e|int|ext|est)(?:\.\s*|\s+))/i;
const NOTE = /\[\[.*?\]\]/g;

// The first cased letter decides, not the first character, so `3D` counts
// and `30s` doesn't.
function isCapitalised(text: string): boolean {
  return /^[^\p{Lu}\p{Ll}]*\p{Lu}/u.test(text);
}

// Runs of eligible words with only whitespace between them. A note is
// blanked before the scan, so nothing inside `[[…]]` is read as a name, but
// the gaps are checked in the original text: a blanked note between two
// words is not whitespace.
function wordRuns(text: string, from: number, to: number, eligible: (word: string) => boolean): Word[][] {
  const scanned = text.slice(0, to).replace(NOTE, (note) => " ".repeat(note.length));
  const runs: Word[][] = [];
  let run: Word[] = [];
  for (const match of scanned.matchAll(WORD)) {
    if (match.index < from) continue;
    const end = match.index + match[0].length;
    const word = { from: match.index, to: POSSESSIVE.test(match[0]) ? end - 2 : end, end };
    const isEligible = eligible(text.slice(word.from, word.to));
    const previous = run.at(-1);
    if (previous && (!isEligible || !/^\s+$/.test(text.slice(previous.end, word.from)))) {
      runs.push(run);
      run = [];
    }
    if (isEligible) run.push(word);
  }
  if (run.length) runs.push(run);
  return runs;
}

// Longest span first, scanning from the left, so `THE THING` links whole
// before `THING` alone is tried.
function matchRun(text: string, run: Word[], resolve: (name: string) => string | undefined, out: WorldName[]): void {
  let start = 0;
  while (start < run.length) {
    const found = longestFrom(text, run, start, resolve);
    if (!found) {
      start++;
      continue;
    }
    out.push(found.name);
    start = found.next;
  }
}

function longestFrom(
  text: string,
  run: Word[],
  start: number,
  resolve: (name: string) => string | undefined,
): { name: WorldName; next: number } | undefined {
  const from = run[start].from;
  for (let last = run.length - 1; last >= start; last--) {
    const ends = run[last].to === run[last].end ? [run[last].end] : [run[last].end, run[last].to];
    for (const to of ends) {
      const path = resolve(text.slice(from, to));
      if (path !== undefined) return { name: { from, to, path }, next: last + 1 };
    }
  }
  return undefined;
}

/** The names in one screenplay line that resolve, by docs/protocol.md's
 * World names rules. Spans are offsets into `text`. */
export function findWorldNames(
  text: string,
  line: WorldNameLine,
  resolve: (name: string) => string | undefined,
): WorldName[] {
  const names: WorldName[] = [];
  if (line === "character") {
    const cue = CUE.exec(text);
    if (!cue) return names;
    const from = cue[1].length;
    const to = from + cue[2].length;
    const path = to > from ? resolve(text.slice(from, to)) : undefined;
    if (path !== undefined) names.push({ from, to, path });
    return names;
  }

  let from = 0;
  let to = text.length;
  let eligible = isCapitalised;
  if (line === "scene-heading") {
    const prefix = HEADING_PREFIX.exec(text);
    if (!prefix) return names;
    from = prefix[0].length;
    // Notes are blanked to find the parts, so a note at the end never joins
    // the last part and a ` - ` inside one splits nothing. Names resolve on
    // the text itself, where a note inside a part is no space, as between an
    // action line's words.
    const blanked = text.replace(NOTE, (note) => " ".repeat(note.length));
    const number = sceneNumber(text);
    if (number) to = number.from;
    const ends = headingPartEnds(blanked, from, to);
    const joined = joinedParts(text, blanked, from, ends, resolve);
    if (joined) return [joined];
    to = ends[0];
    eligible = () => true;
  }
  for (const run of wordRuns(text, from, to, eligible)) matchRun(text, run, resolve, names);
  return names;
}

// Where each ` - `-separated part of a heading's location ends; the last
// ends at `to`.
function headingPartEnds(text: string, from: number, to: number): number[] {
  const ends: number[] = [];
  for (let dash = text.indexOf(" - ", from); dash !== -1 && dash < to; dash = text.indexOf(" - ", dash + 3)) {
    ends.push(dash);
  }
  ends.push(to);
  return ends;
}

// Two or more leading parts, longest first, matched whole: a room's file
// carries its master location's name (`VOSTOK STATION - KITCHEN`), and a
// later part on its own is never tried, so the time of day never links.
function joinedParts(
  text: string,
  blanked: string,
  from: number,
  ends: number[],
  resolve: (name: string) => string | undefined,
): WorldName | undefined {
  const start = from + (/^\s*/.exec(blanked.slice(from))?.[0].length ?? 0);
  for (let last = ends.length - 1; last > 0; last--) {
    const to = start + blanked.slice(start, ends[last]).trimEnd().length;
    const path = resolve(text.slice(start, to));
    if (path !== undefined) return { from: start, to, path };
  }
  return undefined;
}

/** Every world file a screenplay's source names, once each, in the order it
 * first names them. Each line gets the kind an editor draws it as: framed,
 * given its element token, a cue settled against the line below, and a line
 * inside a note over several lines taking the kind of the line it opened on.
 * Nothing inside a note is a name. */
export function worldFilesNamed(source: string, resolve: (name: string) => string | undefined): string[] {
  const lines: { from: number; text: string; token?: string }[] = [];
  const frame = startFrame();
  let afterBlank = true;
  let inDialogue = false;
  let from = 0;
  for (const raw of source.split("\n")) {
    const text = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const line: { from: number; text: string; token?: string } = { from, text };
    lines.push(line);
    from += raw.length + 1;
    // Only an empty line is blank, inside a boneyard too, as an editor's
    // tokenizer is told of one.
    if (text === "") {
      frameLine(frame, "");
      afterBlank = true;
      inDialogue = false;
      continue;
    }
    const kind = frameLine(frame, text);
    const blankAbove = afterBlank;
    afterBlank = false;
    if (kind === "boneyard") inDialogue = false;
    if (kind !== "text") continue;
    const read = fountainToken(text.trim(), blankAbove, inDialogue);
    inDialogue = read.inDialogue;
    line.token = read.token;
  }

  const settled = lines.map((line, index) => line.token && settledToken(line.token, lines[index + 1]?.text));
  const notes = fountainNotes(source);
  const lineAt = (offset: number) => lines.findLastIndex((line) => line.from <= offset);
  const found: string[] = [];
  lines.forEach((line, index) => {
    const note = notes.find((span) => span.from < line.from && line.from < span.to);
    const token = note ? settled[lineAt(note.from)] : settled[index];
    const nameLine = token && worldNameLine(token);
    if (!nameLine) return;
    for (const name of findWorldNames(line.text, nameLine, resolve)) {
      const start = line.from + name.from;
      const end = line.from + name.to;
      if (notes.some((span) => start < span.to && end > span.from)) continue;
      if (!found.includes(name.path)) found.push(name.path);
    }
  });
  return found;
}
