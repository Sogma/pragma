// docs/protocol.md's Context of a path: the files a generation's `context`
// pin sends with its call. Every read goes through the space's privacy
// doorway, and nothing outside the folder of the scope the path sits in is
// sent, since that folder is what the person allowed.
import path from "node:path";
import type { RootPathsResponse } from "../protocol/api.ts";
import { noteLinks } from "../protocol/markdownLinks.ts";
import { createNameIndex, projectFolder } from "../protocol/nameIndex.ts";
import {
  createPathIndex,
  type EntryType,
  findEntry,
  type PathIndex,
  resolveWrittenPath,
} from "../protocol/pathIndex.ts";
import { formatRootPath } from "../protocol/relativeReference.ts";
import { dirnameOf, isWithin, parseRootedPath } from "../protocol/rootedPath.ts";
import { scopeOf } from "../protocol/scopes.ts";
import { type ContextFile, type ContextMessage, isFountainFile, isMarkdownFile } from "../protocol/types.ts";
import { createWorldIndex, resolveWorldName, worldFilesNamed, worldFolder } from "../protocol/worldNames.ts";
import { headingsPast, type MarkdownOutline, type MarkdownSection, outlineOf } from "./markdownSections.ts";
import { readSpaceFile } from "./spaceFiles.ts";
import { isPrivateFile } from "./tree.ts";

/** One file's longest share of a context, in characters, and the whole's. A
 * model on the writer's own machine may have a few thousand tokens in all. */
export const CONTEXT_FILE_LIMIT = 8000;
export const CONTEXT_LIMIT = 32000;

/** Where a context path leads, spelled as on disk, and the folder of the
 * scope it sits in, "" for the space's own. */
export interface ContextPlace {
  path: string;
  type: EntryType;
  scope: string;
}

/** What a context sends: the files, and a message for each one cut or left
 * out, for the person who started the run. */
export interface ContextRead {
  files: ContextFile[];
  messages: ContextMessage[];
}

/** A space path as a context shows it, from the root. */
export const fromRoot = (spacePath: string, folder = false) =>
  formatRootPath({ root: "space", path: spacePath }, folder);

/** Where `spacePath` leads in the space's listing, and its scope; undefined
 * when it names nothing there. */
export function placeContext(listing: RootPathsResponse, spacePath: string): ContextPlace | undefined {
  const found = findEntry(createPathIndex(listing), spacePath, "any");
  return found && { ...found, scope: scopeOf(new Set(listing.scopes), found.path) };
}

/** The context of the entry at `place`, in the order it goes: its scope's
 * AGENTS.md, its project's README, then each note or screenplay it names, in
 * the order it first names them. Never the entry itself, never a file twice,
 * and within each file's and the whole's size limit. */
export async function readContext(
  spaceRoot: string,
  listing: RootPathsResponse,
  place: ContextPlace,
): Promise<ContextRead> {
  const paths = createPathIndex(listing);
  const names = createNameIndex(listing.files);
  const project = projectFolder(names, place.type === "directory" ? place.path : dirnameOf(place.path));
  const messages: ContextMessage[] = [];
  const warn = (text: string) => messages.push({ level: "warn", text });
  const candidates = [
    findEntry(paths, place.scope ? `${place.scope}/AGENTS.md` : "AGENTS.md", "file")?.path,
    project === undefined ? undefined : findEntry(paths, `${project}/README.md`, "file")?.path,
    ...(await namedFiles(spaceRoot, listing, paths, place, warn)),
  ];

  const files: ContextFile[] = [];
  const seen = new Set([place.path]);
  let room = CONTEXT_LIMIT;
  for (const candidate of candidates) {
    if (candidate === undefined || seen.has(candidate)) continue;
    seen.add(candidate);
    const shown = fromRoot(candidate);
    if (!isWithin(place.scope, candidate)) {
      warn(`Left out ${shown}: it's outside ${fromRoot(place.scope, true)}.`);
      continue;
    }
    let content: string;
    try {
      content = await readSpaceFile(spaceRoot, candidate);
    } catch {
      if (await isPrivateFile(path.join(spaceRoot, ...candidate.split("/")))) warn(`Left out ${shown}: it's private.`);
      continue;
    }
    if (content.length > CONTEXT_FILE_LIMIT) {
      const outline = isMarkdownFile(candidate) ? outlineOf(content) : undefined;
      content = cut(content, CONTEXT_FILE_LIMIT) + cutMark(outline);
      messages.push({
        level: "info",
        text: `Cut ${shown} to its first ${CONTEXT_FILE_LIMIT.toLocaleString("en-US")} characters.`,
      });
    }
    if (content.length > room) {
      warn(`Left out ${shown}: the context is full.`);
      continue;
    }
    room -= content.length;
    files.push({ path: shown, content });
  }
  return { files, messages };
}

// Read through the doorway, so a private note's links stay unread too:
// which files it names says something of what it holds.
async function namedFiles(
  spaceRoot: string,
  listing: RootPathsResponse,
  paths: PathIndex,
  place: ContextPlace,
  warn: (text: string) => void,
): Promise<string[]> {
  if (place.type !== "file" || (!isFountainFile(place.path) && !isMarkdownFile(place.path))) return [];
  let source: string;
  try {
    source = await readSpaceFile(spaceRoot, place.path);
  } catch {
    warn(`Left out what ${fromRoot(place.path)} names: it's private.`);
    return [];
  }
  return filesNamedBy(listing, paths, place.path, source);
}

/** The notes and screenplays the document at `filePath` names in `source`,
 * in the order it first names them: a screenplay's world files, a note's
 * links. */
export function filesNamedBy(listing: RootPathsResponse, paths: PathIndex, filePath: string, source: string): string[] {
  if (isFountainFile(filePath)) {
    const folder = worldFolder((scope) => listing.settings?.[scope], filePath);
    if (folder === undefined) return [];
    const world = createWorldIndex(listing.files, folder);
    return worldFilesNamed(source, (name) => resolveWorldName(world, name));
  }
  if (!isMarkdownFile(filePath)) return [];
  const docDir = dirnameOf(filePath);
  return noteLinks(source).flatMap((link) => {
    const found = resolveWrittenPath(docDir, link.raw, link.form, (root) => (root === "space" ? paths : undefined));
    const named = found?.type === "file" ? parseRootedPath(found.path).path : undefined;
    return named !== undefined && (isMarkdownFile(named) || isFountainFile(named)) ? [named] : [];
  });
}

// Says where a file was cut and, for a note, the headings past the cut, so a
// model that may look further can ask for those sections by name.
function cutMark(outline: MarkdownOutline | undefined): string {
  const { within, after } = outline ? headingsPast(outline, CONTEXT_FILE_LIMIT) : { after: [] };
  const named = (section: MarkdownSection) => `${"#".repeat(section.level)} ${section.title}`;
  const where = within ? `, in ${named(within)}` : "";
  const rest = after.length > 0 ? ` It goes on with ${after.map(named).join(", ")}.` : "";
  return `\n\n(Cut to its first ${CONTEXT_FILE_LIMIT.toLocaleString("en-US")} characters${where}.${rest})`;
}

// Never between the halves of a surrogate pair, which would hand the model
// half a character.
export function cut(text: string, limit: number): string {
  return text.slice(0, /[\uD800-\uDBFF]/.test(text[limit - 1]) ? limit - 1 : limit);
}
