// A model's reads of the space: its files listed, their text searched, a file
// read whole or by its sections, and a file's links. A generation's look, the
// copilot and the agent API hand their models these same tools, each with
// limits of its own, so a private, hidden or outside file answers like a
// missing one wherever a model asks. Every read goes through scopedReads.ts.
import { lstat } from "node:fs/promises";
import path from "node:path";
import { type ToolSet, tool } from "ai";
import { z } from "zod";
import type { RootPathsResponse, SpaceTreeNode } from "../protocol/api.ts";
import { createPathIndex, type EntryType, findEntry, type PathIndex } from "../protocol/pathIndex.ts";
import { isHiddenPath } from "../protocol/relativeReference.ts";
import { formatRootedPath, isWithin, parseRootedPath } from "../protocol/rootedPath.ts";
import { type ContextFile, type ContextMessage, isMarkdownFile } from "../protocol/types.ts";
import { entryDescription } from "./descriptions.ts";
import { documentIndex } from "./documentIndex.ts";
import { aliasedOnWindows, hiddenBelow, pathOnDisk } from "./entryOnDisk.ts";
import {
  anchorKey,
  findSection,
  type MarkdownOutline,
  type MarkdownSection,
  outlineOf,
  sectionText,
} from "./markdownSections.ts";
import { cut, filesNamedBy, fromRoot } from "./pathContext.ts";
import { namedEntryPath, PathAccessError } from "./rootedFiles.ts";
import { readInScope, scopeTree, searchScope } from "./scopedReads.ts";
import { isPrivateFile, isSpaceListedFile, listRootPaths, spaceListing } from "./tree.ts";

/** How much a reader's answers may hold, in characters; a limit left out is
 * none. */
export interface ReaderLimits {
  /** One answer: a list, a search, a note's headings, a file's links. */
  answer?: number;
  /** One read: past it a long note comes back as its headings, and anything
   * else is cut. */
  file?: number;
  /** Every answer together: once it is spent, the reads stop. */
  total?: number;
  /** The matches a search shows, and how much of each line. */
  matches: number;
  line?: number;
}

export interface SpaceReaderOptions {
  spaceRoot: string;
  /** The folder the reads are bounded to, "" for the whole space. */
  scope: string;
  /** The space's listing, where the caller has it; read on first need. */
  listing?: RootPathsResponse;
  /** Paths shown from the root, `/a/b.md`, rather than `a/b.md`. */
  rooted?: boolean;
  /** The reads' bound, as the model is told it. */
  where: string;
  limits: ReaderLimits;
  /** A list shows folders, and descriptions, besides files. */
  folders?: boolean;
  descriptions?: boolean;
  /** The link a model copies to name an entry in its reply. */
  linkTo?: (spacePath: string, folder: boolean) => string | undefined;
  /** Only what the tree lists is read, as the agent API promises. */
  listedOnly?: boolean;
  /** The files the model has already, as the reads show paths, and the one
   * they are about, which they never hand over. */
  given?: readonly string[];
  withheld?: string;
  /** A file or section read once answers as read after. */
  once?: boolean;
  /** Said after a search's matches. */
  afterSearch?: string;
}

/** What the reads did, for whoever started them: each file taken, each
 * search, and a message for each file cut and for what the model couldn't
 * have. */
export interface ReadTrace {
  files: string[];
  searches: string[];
  messages: ContextMessage[];
}

/** One of the reader's tools, as every surface offers it. */
export interface SpaceTool {
  name: string;
  title: string;
  description: string;
  input: z.ZodRawShape;
  run(input: Record<string, unknown>): Promise<string>;
}

/** A file's links among the files the reads may show, by space path. */
export interface FileLinks {
  path: string;
  linksTo: string[];
  linkedFrom: string[];
}

export interface SpaceReader {
  list(folder?: string): Promise<string>;
  search(query: string): Promise<string>;
  read(written: string, section?: string): Promise<string>;
  links(written: string): Promise<string>;
  /** The same links as data; undefined for a file the reads may not show. */
  linksOf(written: string): Promise<FileLinks | undefined>;
  tools: SpaceTool[];
  trace: ReadTrace;
  /** The text each read took, for an answer asked for after the reads. */
  taken(): ContextFile[];
  /** Whether the total is spent. */
  full(): boolean;
}

/** The answer once the total is spent. */
const FULL = "The context is full.";

const DESCRIPTION_CHARS = 200;

const shownCount = (count: number) => count.toLocaleString("en-US");

function oneLine(text: string, limit: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > limit ? `${cut(line, limit - 1)}…` : line;
}

/** The files in a tree, in its order; with `folders`, each folder ahead of
 * what it holds. */
export function entriesOf(nodes: readonly SpaceTreeNode[], folders = false): SpaceTreeNode[] {
  return nodes.flatMap((node) =>
    node.type === "file" ? [node] : [...(folders ? [node] : []), ...entriesOf(node.children ?? [], folders)],
  );
}

const unseen = (error: unknown) =>
  (error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof PathAccessError;

// A written path as a space path: "" for the space's own folder, undefined
// for one that climbs out of it.
function spacePathOf(written: string): string | undefined {
  if (aliasedOnWindows(written)) return undefined;
  const normal = path.posix.normalize(written.trim().replace(/^\/+/, "") || ".");
  if (normal === ".." || normal.startsWith("../")) return undefined;
  return normal === "." ? "" : normal.replace(/\/+$/, "");
}

export function createSpaceReader(options: SpaceReaderOptions): SpaceReader {
  const { spaceRoot, scope, where, limits } = options;
  const show = (spacePath: string, folder = false) =>
    options.rooted ? fromRoot(spacePath, folder) : folder && spacePath ? `${spacePath}/` : spacePath;
  const given = new Set(options.given ?? []);
  const trace: ReadTrace = { files: [], searches: [], messages: [] };
  const warn = (text: string) => trace.messages.push({ level: "warn", text });
  // What of each file was read, by line: a part inside one already read is
  // answered as read.
  const read = new Map<string, { start: number; end: number }[]>();
  const gathered: ContextFile[] = [];
  let room = limits.total ?? Number.POSITIVE_INFINITY;
  let full = false;

  let index: Promise<{ listing: RootPathsResponse; paths: PathIndex }> | undefined;
  const indexed = () => {
    index ??= (async () => {
      const listing = options.listing ?? (await listRootPaths(spaceRoot, "space"));
      return { listing, paths: createPathIndex(listing) };
    })();
    return index;
  };
  let listingOptions: ReturnType<typeof spaceListing> | undefined;
  const listed = (spacePath: string) => {
    listingOptions ??= spaceListing();
    const filePath = path.join(spaceRoot, ...spacePath.split("/"));
    if (isHiddenPath(spacePath) || hiddenBelow(spaceRoot, filePath)) return false;
    return isSpaceListedFile(path.basename(pathOnDisk(filePath)), listingOptions);
  };

  // A file written as it is on disk needs no listing; anything else is
  // matched as entry names match, so a link, which the listing never holds,
  // leads nowhere. One with no leading slash is tried from the scope's folder
  // first: a model often drops the part of the path it shares with every file
  // it was shown.
  async function find(written: string, want: EntryType): Promise<string | undefined> {
    const relative = spacePathOf(written);
    if (relative === undefined) return undefined;
    if (!options.listing && want === "file" && relative) {
      const entry = await lstat(path.join(spaceRoot, ...relative.split("/"))).catch(() => undefined);
      if (entry?.isFile()) return relative;
    }
    const { paths } = await indexed();
    const atRoot = findEntry(paths, relative, want)?.path;
    if (!scope || written.trim().startsWith("/")) return atRoot;
    return findEntry(paths, `${scope}/${relative}`, want)?.path ?? atRoot;
  }

  // A missing file and one the model may not see answer alike, so it can't
  // tell them apart.
  const noFile = (written: string) => `There's no file at ${written} in ${where}.`;
  const linkNote = (spacePath: string, folder = false) => {
    const link = options.linkTo?.(spacePath, folder);
    return link ? ` (link ${link})` : "";
  };
  const linked = (spacePath: string, folder = false) => `${show(spacePath, folder)}${linkNote(spacePath, folder)}`;

  async function isPrivate(spacePath: string): Promise<boolean> {
    return isPrivateFile(pathOnDisk(path.join(spaceRoot, ...spacePath.split("/"))));
  }

  // Paths the reads may show the model: inside the scope, listed where only
  // the listed are read, never private.
  async function visible(spacePaths: readonly string[]): Promise<string[]> {
    const shown: string[] = [];
    for (const spacePath of new Set(spacePaths)) {
      if (!isWithin(scope, spacePath) || (options.listedOnly && !listed(spacePath))) continue;
      if (!(await isPrivate(spacePath))) shown.push(spacePath);
    }
    return shown;
  }

  // An answer's lines, up to its share and what the total has left, with
  // `rest` said once a line doesn't fit. An answer with no room fills the
  // total, which ends the reads.
  function spendLines(lines: readonly string[], rest: string): string {
    const share = Math.min(limits.answer ?? Number.POSITIVE_INFINITY, room);
    let text = "";
    for (const line of lines) {
      const next = text ? `${text}\n${line}` : line;
      if (next.length > share) {
        if (text) text = `${text}\n${rest}`;
        break;
      }
      text = next;
    }
    if (!text) {
      if (limits.total === undefined) return `${cut(lines[0] ?? "", share - 1)}…`;
      full = true;
      return FULL;
    }
    room -= text.length;
    return text;
  }

  // A read fails for a file the model may not see, or one that isn't text:
  // only the second is worth saying to it. A path through a link is one the
  // listing never holds, so it reads as missing too.
  async function failedRead(error: unknown, written: string, spacePath: string): Promise<string> {
    if (await isPrivate(spacePath)) {
      warn(`Left out ${show(spacePath)}: it's private.`);
      return noFile(written);
    }
    return unseen(error) ? noFile(written) : (error as Error).message;
  }

  // A folder's description is its README's, which a private README keeps.
  async function descriptionOf(node: SpaceTreeNode): Promise<string | undefined> {
    if (node.description !== undefined) return node.description;
    const dir = path.join(spaceRoot, ...path.posix.dirname(node.path).split("/"));
    if (node.type === "file") return entryDescription(dir, node.name, "file");
    const readme = namedEntryPath(path.join(spaceRoot, ...node.path.split("/")), "README.md");
    return (await isPrivateFile(readme)) ? undefined : entryDescription(dir, node.name, "directory");
  }

  async function list(folder: string | undefined): Promise<string> {
    if (full) return FULL;
    let dir = scope;
    const wanted = folder === undefined ? "" : spacePathOf(folder);
    if (wanted === undefined) return `There's no folder at ${folder} in ${where}.`;
    if (wanted) {
      const found = await find(folder ?? "", "directory");
      if (found === undefined || !isWithin(scope, found) || isHiddenPath(found)) {
        return `There's no folder at ${folder} in ${where}.`;
      }
      dir = found;
    }
    // Descriptions are read only for lines that can still fit.
    const lines: string[] = [];
    let length = 0;
    for (const entry of entriesOf(await scopeTree(spaceRoot, dir), options.folders)) {
      if (length > Math.min(limits.answer ?? Number.POSITIVE_INFINITY, room)) break;
      const description = options.descriptions ? await descriptionOf(entry) : undefined;
      const name = linked(entry.path, entry.type === "directory");
      const line = description ? `${name}: ${oneLine(description, DESCRIPTION_CHARS)}` : name;
      lines.push(line);
      length += line.length + 1;
    }
    if (lines.length === 0) return `${show(dir, true) || where} holds no files.`;
    return spendLines(lines, "(The list stops here. List one of its folders to see the rest.)");
  }

  async function search(query: string): Promise<string> {
    if (full) return FULL;
    const wanted = query.trim();
    if (!wanted) return "Search for some text.";
    trace.searches.push(wanted);
    const matches = (await searchScope(spaceRoot, scope, wanted)).filter((match) => match.path !== options.withheld);
    if (matches.length === 0) return `Nothing in ${where} matches "${wanted}".`;
    const lines = matches
      .slice(0, limits.matches)
      .map(
        (match) =>
          `${show(match.path)}:${match.line}${linkNote(match.path)}: ` +
          (limits.line ? oneLine(match.text, limits.line) : match.text),
      );
    if (matches.length > limits.matches) lines.push("(There are more. Search for something narrower to see them.)");
    const text = spendLines(lines, "(The matches stop here. Search for something narrower to see the rest.)");
    return text === FULL || !options.afterSearch ? text : `${text}\n${options.afterSearch}`;
  }

  const readAlready = (spacePath: string, start: number, end: number) =>
    options.once && (read.get(spacePath) ?? []).some((part) => part.start <= start && end <= part.end);

  // A long note's headings, each with its size, for the model to choose
  // sections from: cheaper than an opening that may not hold what it needs.
  function outlineReply(shown: string, size: number, outline: MarkdownOutline, within?: MarkdownSection): string {
    const sections = outline.sections.filter(
      (section) => !within || (section.start > within.start && section.end <= within.end),
    );
    const lines = sections.map((section) => {
      const name = `${"#".repeat(section.level)} ${section.title}`;
      const asked = section.anchor === anchorKey(section.title) ? "" : `, read as "${section.anchor}"`;
      return `${name} (${shownCount(sectionText(outline, section).length)}${asked})`;
    });
    const whole = within ? `${within.title} in ${shown}` : shown;
    const head = `${whole} is ${shownCount(size)} characters. Read the sections you need by heading:`;
    return spendLines([head, ...lines], "(The headings stop here.)");
  }

  // Text read into the model's context: held to a read's limit and what the
  // total has left, then gathered for the answer.
  function take(found: string, text: string, part: { start: number; end: number; title?: string }): string {
    const shown = show(found);
    const named = part.title === undefined ? shown : `${shown} › ${part.title}`;
    const over = limits.file !== undefined && text.length > limits.file;
    const content = over ? cut(text, limits.file ?? text.length) : text;
    const limit = shownCount(limits.file ?? 0);
    const reply = over ? `${content}\n\n(Cut to its first ${limit} characters.)` : text;
    if (reply.length > room) {
      warn(`Left out ${named}: the context is full.`);
      full = true;
      return FULL;
    }
    room -= reply.length;
    read.set(found, [...(read.get(found) ?? []), { start: part.start, end: part.end }]);
    trace.files.push(named);
    gathered.push({ path: shown, ...(part.title === undefined ? {} : { section: part.title }), content });
    if (over) trace.messages.push({ level: "info", text: `Cut ${named} to its first ${limit} characters.` });
    return reply;
  }

  async function readFile(written: string, section: string | undefined): Promise<string> {
    if (full) return FULL;
    const found = await find(written, "file");
    if (found === undefined || (options.listedOnly && !listed(found))) return noFile(written);
    const shown = show(found);
    if (!isWithin(scope, found)) {
      warn(`Left out ${shown}: it's outside ${show(scope, true)}.`);
      return noFile(written);
    }
    if (found === options.withheld) return "That's the file the context is for, which it never holds.";
    // One that came cut may still be read by section, past its cut.
    if (given.has(shown) && section === undefined) return "That file came with the instruction.";
    let content: string;
    try {
      content = await readInScope(spaceRoot, scope, found);
    } catch (error) {
      return failedRead(error, written, found);
    }
    const outline = isMarkdownFile(found) ? outlineOf(content) : undefined;
    const long = (text: string) => limits.file !== undefined && text.length > limits.file;
    if (section === undefined) {
      if (readAlready(found, 0, Number.POSITIVE_INFINITY)) return "You've read that file already.";
      if (long(content) && outline?.sections.length) return outlineReply(shown, content.length, outline);
      return take(found, content, { start: 0, end: Number.POSITIVE_INFINITY });
    }
    if (!outline?.sections.length) return `${shown} has no headings to read it by. Read it whole.`;
    const part = findSection(outline, section);
    if (!part) return `${shown} has no section "${section}". ${outlineReply(shown, content.length, outline)}`;
    if (readAlready(found, part.start, part.end)) return "You've read that section already.";
    const text = sectionText(outline, part);
    const inside = outline.sections.some((other) => other.start > part.start && other.end <= part.end);
    if (long(text) && inside) return outlineReply(shown, text.length, outline, part);
    return take(found, text, { start: part.start, end: part.end, title: part.title });
  }

  // A file that isn't text links to nothing, though a note may link to it.
  async function linksOf(written: string): Promise<FileLinks | undefined> {
    const found = await find(written, "file");
    if (found === undefined || !isWithin(scope, found) || (options.listedOnly && !listed(found))) return undefined;
    let source = "";
    try {
      source = await readInScope(spaceRoot, scope, found);
    } catch (error) {
      if (await isPrivate(found)) {
        warn(`Left out ${show(found)}: it's private.`);
        return undefined;
      }
      if (unseen(error)) return undefined;
    }
    const { listing, paths } = await indexed();
    const linksTo = source ? await visible(filesNamedBy(listing, paths, found, source)) : [];
    const space = { dir: spaceRoot, root: "space" as const };
    const backlinks = await documentIndex().backlinks(formatRootedPath({ root: "space", path: found }), [space]);
    const linkedFrom = await visible(backlinks.map((link) => parseRootedPath(link.path).path));
    return { path: found, linksTo, linkedFrom };
  }

  async function links(written: string): Promise<string> {
    if (full) return FULL;
    const found = await linksOf(written);
    if (!found) return noFile(written);
    const { linksTo, linkedFrom } = found;
    if (linksTo.length === 0 && linkedFrom.length === 0) {
      return `${show(found.path)} links to nothing in ${where}, and nothing there links to it.`;
    }
    const lines = [
      ...(linksTo.length > 0 ? ["Links to:", ...linksTo.map((spacePath) => linked(spacePath))] : []),
      ...(linkedFrom.length > 0 ? ["Linked from:", ...linkedFrom.map((spacePath) => linked(spacePath))] : []),
    ];
    return spendLines(lines, "(The links stop here.)");
  }

  const pathIs = options.rooted ? "from the root" : "relative to the space";
  const pathInput = z.string().describe(`The file's path ${pathIs}, as the list and the search give it`);
  const each = [options.linkTo && "the link to name it by", options.descriptions && "its description when it has one"];
  const extras = each.filter(Boolean).join(" and ");
  const tools: SpaceTool[] = [
    {
      name: "list_space_files",
      title: "List space files",
      description:
        `List the ${options.folders ? "files and folders" : "files"} in ${where}, or in one folder of it, in ` +
        `the writer's order${extras ? `, each with ${extras}` : ""}.`,
      input: {
        folder: z.string().optional().describe(`A folder inside it, ${pathIs}; leave it out for the whole`),
      },
      run: ({ folder }) => list(folder as string | undefined),
    },
    {
      name: "search_space_files",
      title: "Search the space",
      description:
        `Search the text of the files in ${where} for a word or phrase, ignoring case, to find where ` +
        `something is mentioned. Gives each matching line with its file${options.linkTo ? ", that file's link" : ""} ` +
        "and line number.",
      input: { query: z.string().describe("The text to look for") },
      run: ({ query }) => search(String(query)),
    },
    {
      name: "read_space_file",
      title: "Read a space file",
      description:
        limits.file === undefined
          ? `Read a file in ${where} by its path ${pathIs}: whole, or one section of a note, passing its heading ` +
            "as section. A section holds its subsections."
          : `Read a file in ${where} by its path ${pathIs}. A long note comes back as its headings, each with its ` +
            "size: then read the sections you need, passing one as section.",
      input: {
        path: pathInput,
        section: z
          .string()
          .optional()
          .describe("One of the note's headings, as its list of headings gives it; leave it out for the whole file"),
      },
      run: ({ path: written, section }) => readFile(String(written), section as string | undefined),
    },
    {
      name: "list_space_file_links",
      title: "List a file's links",
      description:
        `For a note or screenplay in ${where}: the files it links to, a screenplay's world names included, and ` +
        "the notes that link to it.",
      input: { path: pathInput },
      run: ({ path: written }) => links(String(written)),
    },
  ];

  return {
    list,
    search,
    read: readFile,
    links,
    linksOf,
    tools,
    trace,
    taken: () => [...gathered],
    full: () => full,
  };
}

/** The reader's tools as a model call takes them. */
export function toolSet(tools: readonly SpaceTool[]): ToolSet {
  return Object.fromEntries(
    tools.map((each) => [
      each.name,
      tool({
        description: each.description,
        inputSchema: z.object(each.input),
        execute: (input: Record<string, unknown>) => each.run(input),
      }),
    ]),
  );
}
