import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { APICallError, generateText, isStepCount, type ModelMessage, type ToolSet, tool } from "ai";
import { z } from "zod";
import { loadGlobalConfig, type ResolvedMcpServer, resolveMcpServers } from "../config/loadConfig.ts";
import type { ChatMessage, ChatMode, ChatResponse, EffortLevel, SelectedRange } from "../protocol/api.ts";
import { parseFlowFile } from "../protocol/flowFile.ts";
import { FLOW_NODE_REGISTRY } from "../protocol/flowNodes.ts";
import {
  credentialRefusal,
  noTextModelError,
  openModel,
  type ProviderLanguageModel,
  resolveModel,
} from "../protocol/modelProvider.ts";
import { isLibraryPath, parseRootedPath } from "../protocol/rootedPath.ts";
import type { ScopeFolders } from "../protocol/scopes.ts";
import { formatSelectedRange } from "../protocol/selectedRange.ts";
import {
  type FlowEdgeInstance,
  type FlowGraph,
  imageMediaTypeForPath,
  pdfMediaTypeForPath,
  rasterImageMediaTypeForPath,
  videoMediaTypeForPath,
} from "../protocol/types.ts";
import { wikilinkFromRoot } from "../protocol/wikilink.ts";
import { checkProposal } from "./checkProposal.ts";
import type { ContextSourceRegistry } from "./copilotContext.ts";
import { collectMcpTools, type McpConnector } from "./mcpTools.ts";
import { loadProtocolSpec, noSuchSection, specSectionInput, specToolDescription } from "./protocolSpec.ts";
import { resolveRootedPath } from "./rootedFiles.ts";
import {
  findNearestReadme,
  readRasterImage,
  readRevision,
  readSpaceFile,
  readSpaceRulesFile,
  resolveWithinSpace,
} from "./spaceFiles.ts";
import { createSpaceReader, toolSet } from "./spaceReader.ts";
import { readStructure } from "./structure.ts";
import { buildTree, filterPrivateNodes, isPrivateFile, scopesOnDisk, spaceListing } from "./tree.ts";

/** The link the copilot copies to name an entry, a folder ending in `/`;
 * undefined for a path no root of the space holds. */
type LinkTo = (rootedPath: string, folder?: boolean) => string | undefined;

// Written as a document at the space root writes it, the way chat reads a
// reply's paths (chat.ts): change one and the other breaks. The model is
// handed links to copy, never the rule, so a change to the rule reaches the
// links it writes too. A folder's scope is looked up once a turn.
function linksFrom(spaceRoot: string): LinkTo {
  const onDisk = scopesOnDisk(spaceRoot);
  const known = new Map<string, boolean>();
  const scopes: ScopeFolders = {
    has(folder) {
      const opens = known.get(folder) ?? onDisk.has(folder);
      known.set(folder, opens);
      return opens;
    },
  };
  return (rootedPath, folder = false) => {
    try {
      return wikilinkFromRoot(parseRootedPath(rootedPath), scopes, folder);
    } catch {
      return undefined;
    }
  };
}

// The sentence handing the model an entry's link, after the one naming it;
// nothing for the space itself or a path outside it.
function itsLink(linkTo: LinkTo, rootedPath: string, folder = false): string {
  const link = rootedPath === "" ? undefined : linkTo(rootedPath, folder);
  return link ? ` Its link is ${link}.` : "";
}

// A turn asked its model for an effort level the model doesn't take.
// Refused rather than sent without one: the reply would read as made at the
// effort the writer picked.
export class EffortLevelError extends Error {
  constructor(model: string, level: string) {
    super(`Model "${model}" takes no "${level}" effort level.`);
    this.name = "EffortLevelError";
  }
}

// A proposal with problems records nothing, so the model can fix the file and
// propose it again within the turn, rather than the writer accepting a file
// that won't open as it says.
function unproposed(target: string, problems: readonly string[], mode: ChatMode): string {
  return [
    `Nothing was ${mode === "editing" ? "changed" : "proposed"}: \`${target}\` has problems. Fix them, then call this again.`,
    ...problems.map((problem) => `- ${problem}`),
  ].join("\n");
}

// Said when the writer sees other text than the model sent, so it doesn't
// take what's shown for its own words.
function filledIn(proposed: string, shown: string): string {
  return shown === proposed
    ? ""
    : " Pragma filled in what it derives from the space and wrote the Flow as its editor would.";
}

// How the model sees an image on screen: a raster image by asking for it, a
// vector image as the source it is.
function howToSee(image: ImageView): string {
  if (!rasterImageMediaTypeForPath(image.filePath)) return "It's a vector image: read_space_file reads its source.";
  return (
    "You know its name and folder, not what it depicts: call look_at_image only when the answer " +
    "depends on what it depicts, and then without asking first." +
    (isLibraryPath(image.path) ? " It's in a library, which your other tools can't reach." : "")
  );
}

// A model that takes no images, or none this large, refuses the request that
// carries one; a rate limit or an outage says nothing about the image.
function refusedRequest(error: unknown): error is APICallError {
  return APICallError.isInstance(error) && [400, 413, 415, 422].includes(error.statusCode ?? 0);
}

// The ceiling on model ↔ tool round-trips in one turn. A turn rarely
// exceeds a handful of steps (read, search, read, edit); the ceiling exists
// so a model that loops on a tool can't spend the writer's budget
// indefinitely. Hitting it ends the turn with whatever text the last step
// produced, not an error.
const MAX_CHAT_STEPS = 20;

// What one list, search or file's links may hold, in characters, and how
// many lines a search shows, each held to a line. A read is never cut: the
// copilot proposes a file's whole new text, so it reads the whole of one.
const CHAT_ANSWER_LIMIT = 20_000;
const CHAT_SEARCH_MATCHES = 50;
const CHAT_LINE_CHARS = 200;

/** An image is the one view a library's file comes in, so it also carries the
 * path it's named by: bare in the space, `lib:<id>/…` in a library. */
type ImageView = { view: "image"; filePath: string; path: string };

/** A file the focused pane points at apart from its own: the one its preview
 * shows, or a gallery's selected tile. Named by its path as an image is, since
 * a library's raster image can be one. */
export type SelectedFile = { filePath: string; path: string; previewing: boolean };

/** What the editor's center pane is showing, down to no file at all. The
 * copilot's context and tools key off this rather than a bare file path, so
 * a stale `filePath` can't make `edit_current_document` overwrite an open
 * image's bytes with text, or rewrite a file under the pane that renders it. */
export type EditorContext =
  | { view: "document"; filePath: string; selection?: SelectedRange }
  | { view: "folder"; dirPath: string }
  | ImageView
  | { view: "video"; filePath: string }
  | { view: "pdf"; filePath: string }
  | { view: "applet"; filePath: string }
  | { view: "flow"; filePath: string; node?: string }
  | { view: "table"; filePath: string }
  | { view: "none" };

// A Flow or Table pane holds its file in memory and writes the whole
// of it back on its next save, so a rewrite accepted from chat while one is
// open would be silently overwritten.
function isPaneBackedView(context: EditorContext): context is Extract<EditorContext, { view: "flow" | "table" }> {
  return context.view === "flow" || context.view === "table";
}

// How much of a selection is quoted into the prompt before only its range
// is named. A writer who selects a whole chapter shouldn't spend the turn's
// budget re-sending it: the model can pull back exactly those lines through
// read_current_document once it knows the selection matters.
const MAX_INLINE_SELECTION_CHARS = 2000;

/** A file's lines, split the way CodeMirror splits them (see
 * web/services/documents.ts), so a CRLF file numbers here exactly as it
 * does in the editor a line number came from. */
function fileLines(content: string): string[] {
  return content.split(/\r\n?|\n/);
}

/** One inclusive, 1-based line range of a file's text. */
function sliceLines(content: string, startLine: number, endLine: number): string {
  return fileLines(content)
    .slice(startLine - 1, endLine)
    .join("\n");
}

/** The text a selected range covers and the whole lines it spans, or
 * undefined when the range doesn't fit the file. */
function sliceRange(content: string, range: SelectedRange): { text: string; lines: string[] } | undefined {
  const lines = fileLines(content).slice(range.startLine - 1, range.endLine);
  const last = lines.at(-1);
  if (last === undefined || lines.length !== range.endLine - range.startLine + 1) return undefined;
  if (range.startColumn > lines[0].length + 1 || range.endColumn > last.length + 1) return undefined;
  const spanned = lines.join("\n");
  return { text: spanned.slice(range.startColumn - 1, spanned.length - last.length + range.endColumn - 1), lines };
}

/** What the writer has highlighted, named by its `path:line:column` range
 * and quoted while it's short. A part of one line comes with that whole
 * line while both fit, so the model sees the words in place. The quote is
 * what tells it which words: a model can't count its way to a column.
 *
 * The hedge at the end is load-bearing: a selection is often left over from
 * reading, and without it a model treats every stray highlight as the thing
 * being asked about.
 *
 * Undefined when the range no longer matches the file — it was measured in
 * the browser, against a save that has since landed. */
async function describeSelection(
  spaceRoot: string,
  relativePath: string,
  range: SelectedRange,
): Promise<string | undefined> {
  let selected: { text: string; lines: string[] } | undefined;
  try {
    selected = sliceRange(await readSpaceFile(spaceRoot, relativePath), range);
  } catch {
    return undefined;
  }
  if (!selected || selected.text.trim() === "") return undefined;

  const { text, lines } = selected;
  const reference = `\`${relativePath}:${formatSelectedRange(range)}\``;
  const hedge = "This may or may not be what they're asking about.";
  if (text.length > MAX_INLINE_SELECTION_CHARS) {
    return (
      `The writer has ${reference} selected, too much to quote here. Call read_current_document with ` +
      `startLine ${range.startLine} and endLine ${range.endLine} to read the lines it spans. ${hedge}`
    );
  }
  const parts = [`The writer has ${reference} selected:\n\n\`\`\`\n${text}\n\`\`\``];
  const [line] = lines;
  if (lines.length === 1 && line !== text && line.length + text.length <= MAX_INLINE_SELECTION_CHARS) {
    parts.push(`It's part of line ${range.startLine}:\n\n\`\`\`\n${line}\n\`\`\``);
  }
  return [...parts, hedge].join("\n\n");
}

// An Applet node's rules sit in protocol.md's Applet nodes, the one type the
// node catalog leaves out; every other type's sit under its own id.
function specSectionOf(type: string): string {
  return type === "applet" ? "applet-nodes" : type;
}

/** The wires into and out of one node, each named by the ports it joins. */
function describeWires(edges: readonly FlowEdgeInstance[], nodeId: string): string {
  const into = edges
    .filter((edge) => edge.target === nodeId)
    .map((edge) => `\`${edge.source}.${edge.sourcePort}\` → \`${edge.targetPort}\``);
  const out = edges
    .filter((edge) => edge.source === nodeId)
    .map((edge) => `\`${edge.sourcePort}\` → \`${edge.target}.${edge.targetPort}\``);
  if (into.length === 0 && out.length === 0) return "It has no wires.";
  return [
    into.length > 0 ? `Wired in: ${into.join(", ")}.` : "Nothing is wired in.",
    out.length > 0 ? `Wired out: ${out.join(", ")}.` : "Nothing is wired out.",
  ].join(" ");
}

/** The node the writer has selected on a Flow's canvas, quoted from the
 * saved file with its wires and hedged as a text selection is. Its layout
 * (position, size, colour, collapsed, App Mode's order and tile) is left out.
 *
 * Undefined when the saved Flow has no such node: the save that added it
 * failed, or the file isn't a Flow that reads. */
async function describeSelectedNode(
  spaceRoot: string,
  relativePath: string,
  nodeId: string,
): Promise<string | undefined> {
  let graph: FlowGraph | undefined;
  try {
    graph = parseFlowFile(await readSpaceFile(spaceRoot, relativePath))?.graph;
  } catch {
    return undefined;
  }
  const node = graph?.nodes.find((each) => each.id === nodeId);
  if (!graph || !node) return undefined;

  const { position, size, color, collapsed, appModeOrder, appModeSize, ...kept } = node;
  const definition = FLOW_NODE_REGISTRY[node.type];
  const named = definition
    ? `The writer has selected the ${definition.label} node \`${node.id}\` on the canvas` +
      (node.label ? `, labelled "${node.label}"` : "")
    : `The writer has selected the node \`${node.id}\` on the canvas, of type \`${node.type}\`, which this ` +
      "version of Pragma doesn't have";
  const quoted = JSON.stringify(kept);
  const parts = [
    quoted.length > MAX_INLINE_SELECTION_CHARS
      ? `${named}. It's too long to quote here: read it in the Flow's file with read_space_file when the ` +
        "answer needs it."
      : `${named}:\n\n\`\`\`json\n${quoted}\n\`\`\``,
    describeWires(graph.edges, node.id),
  ];
  if (definition) parts.push(`Its type's rules are in the spec section \`${specSectionOf(node.type)}\`.`);
  return [...parts, "This may or may not be what they're asking about."].join("\n\n");
}

/** Describes the folder a gallery shows, for the copilot: its entries in
 * the folder's own order, each with its description where the folder keeps
 * a manual order, so the copilot's picture of "what's showing" matches what
 * the writer is looking at. A private document is left out, as it is from
 * every tree a model is handed. */
async function describeFolder(spaceRoot: string, dirPath: string): Promise<string> {
  const entries = await filterPrivateNodes(
    spaceRoot,
    await buildTree(dirPath, spaceRoot, "space", { depth: 1, ...spaceListing() }),
  );
  if (entries.length === 0) return "The folder is empty.";
  if (readStructure(dirPath)) {
    const listed = entries
      .map((node, index) => `${index + 1}. \`${node.name}\`${node.description ? `: ${node.description}` : ""}`)
      .join("\n");
    return `It keeps a manual order (\`_structure.json\`); its entries, in order, are:\n${listed}`;
  }
  const names = entries.map((node) => node.name).join(", ");
  return `It has no \`_structure.json\`, so its entries come in the folder's own order: ${names}.`;
}

/** The tab the writer's other editor group shows. Named, never quoted: the
 * model reads it when a question needs it, as it reads the focused document,
 * so a private one is named as private and never read. */
async function describeBeside(spaceRoot: string, beside: EditorContext, linkTo: LinkTo): Promise<string | undefined> {
  if (beside.view === "none") return undefined;
  const target = beside.view === "folder" ? beside.dirPath : beside.filePath;
  const relative = beside.view === "image" ? beside.path : path.relative(spaceRoot, target).split(path.sep).join("/");
  const named = `\`${relative || "."}\``;
  const surface = {
    document: `the document ${named}`,
    folder: `the folder ${named} in the gallery`,
    image: `the image ${named}`,
    video: `the video ${named}, which you can't read`,
    pdf: `the PDF ${named}, which you can't read`,
    applet: `the applet ${named}, running`,
    flow: `the Flow ${named} on its node canvas`,
    table: `the Table ${named} as rows and columns`,
  }[beside.view];
  const sentences = [
    `The writer's other editor group shows ${surface}.${itsLink(linkTo, relative, beside.view === "folder")}`,
  ];
  if (beside.view === "image") sentences.push(howToSee(beside));
  if (beside.view === "document" || beside.view === "applet" || isPaneBackedView(beside)) {
    sentences.push(
      (await isPrivateFile(beside.filePath))
        ? "It's marked `visibility: private`, so its content must never reach you, and read_space_file refuses it."
        : "Read it with read_space_file when answering needs what it contains.",
    );
  }
  if (isPaneBackedView(beside)) sentences.push("It can't be changed from chat while it's open.");
  return sentences.join(" ");
}

/** The file the focused pane points at, named as the tab beside is and
 * hedged as a selection is: one left selected a while ago may not be what a
 * question means by "this". */
async function describeSelectedFile(selected: SelectedFile & { folder: boolean }, linkTo: LinkTo): Promise<string> {
  const { filePath, folder } = selected;
  const named = `\`${selected.path}\``;
  const image = !folder && imageMediaTypeForPath(filePath) !== undefined;
  const unreadable = videoMediaTypeForPath(filePath) ? "video" : pdfMediaTypeForPath(filePath) ? "PDF" : undefined;
  const surface = folder
    ? `the folder ${named}`
    : image
      ? `the image ${named}`
      : unreadable
        ? `the ${unreadable} ${named}, which you can't read`
        : `the file ${named}`;
  const sentences = [
    `${selected.previewing ? "The writer is previewing" : "The writer has selected"} ${surface}.` +
      itsLink(linkTo, selected.path, folder),
  ];
  if (image) sentences.push(howToSee({ view: "image", filePath, path: selected.path }));
  else if (!folder && !unreadable) {
    sentences.push(
      (await isPrivateFile(filePath))
        ? "It's marked `visibility: private`, so its content must never reach you, and read_space_file refuses it."
        : "Read it with read_space_file when answering needs what it contains.",
    );
  }
  sentences.push("This may or may not be what they're asking about.");
  return sentences.join(" ");
}

/** Assembles the copilot's orientation: what's open in the editor, the
 * space's own operating rules (an AGENTS.md or CLAUDE.md — the "loads every
 * session" convention those filenames carry), and the nearest project
 * README. This lets the copilot answer "what project is this" without first
 * guessing it should go looking — the tools cover everything this doesn't.
 *
 * Each module's context source adds its own section after the README. */
async function buildSpaceContext(
  spaceRoot: string,
  context: EditorContext,
  openDocumentIsPrivate: boolean,
  beside: EditorContext | undefined,
  selected: (SelectedFile & { folder: boolean }) | undefined,
  contextSources: ContextSourceRegistry | undefined,
  linkTo: LinkTo,
): Promise<string> {
  const sections: string[] = [];
  let startDir: string;

  if (context.view === "document") {
    const relativePath = path.relative(spaceRoot, context.filePath).split(path.sep).join("/");
    sections.push(`The currently open document is \`${relativePath}\`.${itsLink(linkTo, relativePath)}`);
    // Through the same gate that withholds the document tools: a private
    // document's text must not reach the model, and a selection is its text.
    if (context.selection && !openDocumentIsPrivate) {
      const selection = await describeSelection(spaceRoot, relativePath, context.selection);
      if (selection) sections.push(selection);
    }
    startDir = path.dirname(context.filePath);
  } else if (context.view === "folder") {
    const relativeDir = path.relative(spaceRoot, context.dirPath).split(path.sep).join("/");
    const description = await describeFolder(spaceRoot, context.dirPath);
    sections.push(
      `The writer is currently viewing the folder \`${relativeDir || "."}\` in the gallery, as tiles or cards, ` +
        `not a single document — there is no "current document" open, so read_current_document and ` +
        `edit_current_document aren't available this turn.${itsLink(linkTo, relativeDir, true)} ${description}`,
    );
    startDir = context.dirPath;
  } else if (context.view === "image" || context.view === "video" || context.view === "pdf") {
    const relativePath =
      context.view === "image" ? context.path : path.relative(spaceRoot, context.filePath).split(path.sep).join("/");
    const surface =
      context.view === "image"
        ? `the image \`${relativePath}\` open in a read-only preview`
        : context.view === "video"
          ? `the video \`${relativePath}\` open in a player`
          : `the PDF \`${relativePath}\` open in a read-only viewer, whose text you can't read`;
    sections.push(
      `The writer currently has ${surface}, not a text ` +
        `document — there is no "current document" open, so read_current_document and ` +
        `edit_current_document aren't available this turn.${itsLink(linkTo, relativePath)}` +
        (context.view === "image" ? ` ${howToSee(context)}` : ""),
    );
    // A library's image places the turn nowhere in the space.
    startDir = context.view === "image" && isLibraryPath(context.path) ? spaceRoot : path.dirname(context.filePath);
  } else if (isPaneBackedView(context)) {
    const relativePath = path.relative(spaceRoot, context.filePath).split(path.sep).join("/");
    const surface =
      context.view === "flow"
        ? `the Flow \`${relativePath}\` open on its node canvas`
        : `the Table \`${relativePath}\` open as rows and columns`;
    const read = openDocumentIsPrivate
      ? "It's marked `visibility: private`, so its content must never reach you, and read_space_file refuses it."
      : "Read its file with read_space_file when answering needs what it contains.";
    sections.push(
      `The writer currently has ${surface} — not a text document — so there is no "current document" ` +
        `open, and read_current_document and edit_current_document aren't available this turn.` +
        `${itsLink(linkTo, relativePath)} ${read} ` +
        `It can't be changed from chat while it's open: describe any change for the writer to make in the ` +
        `pane instead.`,
    );
    // A private Flow's node is its content, which must not reach the model.
    if (context.view === "flow" && context.node !== undefined && !openDocumentIsPrivate) {
      const node = await describeSelectedNode(spaceRoot, relativePath, context.node);
      if (node) sections.push(node);
    }
    startDir = path.dirname(context.filePath);
  } else if (context.view === "applet") {
    const relativePath = path.relative(spaceRoot, context.filePath).split(path.sep).join("/");
    sections.push(
      `The writer currently has the applet \`${relativePath}\` open, running in its own sandboxed pane — not ` +
        `a text document — there is no "current document" open, so read_current_document and ` +
        `edit_current_document aren't available this turn.${itsLink(linkTo, relativePath)}`,
    );
    startDir = path.dirname(context.filePath);
  } else {
    sections.push(
      `The writer has no file open in the editor right now — there is no "current document", so ` +
        `read_current_document and edit_current_document aren't available this turn.`,
    );
    startDir = spaceRoot;
  }

  if (selected) sections.push(await describeSelectedFile(selected, linkTo));

  const besideDescription = beside && (await describeBeside(spaceRoot, beside, linkTo));
  if (besideDescription) sections.push(besideDescription);

  const rules = await readSpaceRulesFile(spaceRoot);
  if (rules) {
    sections.push(`## This space's operating rules (${rules.name})\n\n${rules.content}`);
  }

  const readme = await findNearestReadme(spaceRoot, startDir);
  if (readme) {
    sections.push(`## Project context (${readme.path})\n\n${readme.content}`);
  }

  for (const section of (await contextSources?.sections(spaceRoot, startDir)) ?? []) {
    sections.push(`## ${section.title}\n\n${section.body}`);
  }

  return sections.join("\n\n");
}

// What the model is told about tools that aren't pragma's own: which
// server each came from, that they act outside the space with that server's
// access (so nothing about them is propose-then-confirm), and which
// configured servers are missing this turn. Empty when nothing is
// configured, so the base prompt is byte-identical to the no-MCP case.
function describeExternalTools(
  described: Array<{ name: string; server: string; description?: string }>,
  failures: Array<{ server: string; message: string }>,
  readOnly: boolean,
): string {
  if (described.length === 0 && failures.length === 0) return "";
  const lines = [
    "",
    "",
    "## External tools (MCP servers the writer connected)",
    "",
    "Tools named `mcp_<server>_<tool>` come from MCP servers the writer configured, not from Pragma. " +
      "They run outside the space with whatever access that server has, and their effects are immediate — " +
      "there is no confirm card — so say what you're about to do with one before calling it, and never " +
      "pass the contents of a space file to one unless the writer asked for exactly that." +
      (readOnly ? " In Viewing mode only the tools that say they change nothing are offered." : ""),
  ];
  const byServer = new Map<string, string[]>();
  for (const tool of described) {
    const entry = `- \`${tool.name}\`${tool.description ? `: ${tool.description}` : ""}`;
    byServer.set(tool.server, [...(byServer.get(tool.server) ?? []), entry]);
  }
  for (const [server, entries] of byServer) lines.push("", `Server \`${server}\`:`, ...entries);
  for (const failure of failures) {
    lines.push(
      "",
      `Server \`${failure.server}\` couldn't be reached this turn (${failure.message}); its tools are unavailable.`,
    );
  }
  return lines.join("\n");
}

/** The copilot's external tool sources for one turn: every MCP server
 * switched on for the copilot, plus an injectable connector so the loop's
 * handling of them is testable without a server. */
export interface ExternalTools {
  servers: ResolvedMcpServer[];
  connect?: McpConnector;
}

/** How one turn runs: the model's effort, what the copilot may change
 * (absent is "suggesting"), what the writer's other editor group shows, and
 * the file the focused pane points at. */
export interface ChatTurn {
  effort?: EffortLevel;
  mode?: ChatMode;
  beside?: EditorContext;
  selected?: SelectedFile;
}

/** Read/write scoped to the open document, plus read-only navigation across
 * the rest of the space — never a direct write outside the open file (see
 * architecture.md). With no open document (a gallery, say) the
 * current-document tools are left out rather than present but meaningless.
 * Reads share tree.ts/spaceFiles.ts with the MCP surface, never a copy. */
export async function runChat(
  spaceRoot: string,
  context: EditorContext,
  history: ChatMessage[],
  message: string,
  modelRef: string | undefined,
  turn: ChatTurn & { contextSources?: ContextSourceRegistry } = {},
): Promise<ChatResponse> {
  if (!modelRef) throw noTextModelError();
  // Opened up front, before any space reads, so a missing or unusable key
  // fails fast with the provider named rather than after the context has been
  // built.
  const model = await openModel(resolveModel(modelRef));
  if (turn.effort !== undefined && !model.effortLevels.includes(turn.effort)) {
    throw new EffortLevelError(model.wireModel, turn.effort);
  }
  const servers = resolveMcpServers(loadGlobalConfig()).filter((server) => server.copilot);
  // A refused key or lapsed sign-in is named here, where the provider is known.
  return runChatOn(model.languageModel, spaceRoot, context, history, message, {
    ...turn,
    external: { servers },
    imagesInToolResults: model.imagesInToolResults,
  }).catch((error: unknown) => {
    throw credentialRefusal(error, model.providerId, modelRef) ?? error;
  });
}

/** The loop itself, on an already-resolved model — split from the entry
 * point above so the tool surface and the propose-then-confirm recording can
 * be exercised against `ai/test`'s mock model without a provider config. */
export async function runChatOn(
  languageModel: ProviderLanguageModel,
  spaceRoot: string,
  context: EditorContext,
  history: ChatMessage[],
  message: string,
  {
    external = { servers: [] },
    effort,
    mode = "suggesting",
    beside,
    selected,
    contextSources,
    imagesInToolResults = false,
  }: ChatTurn & {
    external?: ExternalTools;
    contextSources?: ContextSourceRegistry;
    imagesInToolResults?: boolean;
  } = {},
): Promise<ChatResponse> {
  // Viewing hands the model no tool that changes a file; Editing words the
  // same tools as changes already made, since the client applies them as the
  // reply arrives.
  const changes = mode !== "viewing";
  const editing = mode === "editing";
  // In either group, a Flow or Table pane would save its copy over a rewrite.
  const heldByPanes = [context, ...(beside ? [beside] : [])].filter(isPaneBackedView).map((view) => view.filePath);
  let currentDocumentEdit: ChatResponse["currentDocumentEdit"];
  let proposedDocument: ChatResponse["proposedDocument"];
  let proposedEdit: ChatResponse["proposedEdit"];

  // Checked up front (not just inside read_current_document's own run
  // callback) because it also decides whether edit_current_document and the
  // system prompt's framing below are even offered — see docs/architecture.md's
  // Privacy section: a private open document must never reach this remote
  // model, not just refuse a read once asked.
  const openDocumentIsPrivate =
    context.view === "document" || isPaneBackedView(context) ? await isPrivateFile(context.filePath) : false;

  const documentTools: ToolSet = {};
  if (context.view === "document" && !openDocumentIsPrivate) {
    const filePath = context.filePath;
    const relativePath = path.relative(spaceRoot, filePath).split(path.sep).join("/");
    // The text the model last read in full: what its rewrite is based on.
    // Its revision is read before the text, so a change landing between the
    // two leaves a write based on it refused rather than written over.
    let lastRead: { content: string; revision: string } | undefined;
    documentTools.read_current_document = tool({
      description:
        "Read the current text of the document the writer has open. Omit both line numbers for " +
        "the whole document, or pass them to read just that range — 1-based and inclusive, " +
        "counting from the file's first line, the same numbers a selection is reported in.",
      inputSchema: z.object({
        startLine: z.number().int().min(1).optional().describe("First line to read, 1-based and inclusive"),
        endLine: z.number().int().min(1).optional().describe("Last line to read, 1-based and inclusive"),
      }),
      // Goes through the shared space reader — the same doorway
      // search_space_files/read_space_file and actions use — rather than a raw
      // fs read, so this stays safe even if the tool-omission gate above this
      // block ever changes; see docs/architecture.md's Privacy section.
      execute: async ({ startLine, endLine }) => {
        const revision = await readRevision(filePath);
        const content = await readSpaceFile(spaceRoot, relativePath);
        if (startLine === undefined && endLine === undefined) {
          lastRead = { content, revision };
          return content;
        }
        // Named rather than returned empty: a range past the end of a file
        // the writer has since shortened would otherwise read as an empty
        // document, which the model would happily "restore".
        return (
          sliceLines(content, startLine ?? 1, endLine ?? Number.MAX_SAFE_INTEGER) ||
          "That line range is past the end of the document."
        );
      },
    });
    if (changes) {
      documentTools.edit_current_document = tool({
        description:
          (editing
            ? "Replace the text of the whole document the writer has open. The changes are applied in " +
              "the writer's editor as soon as you call this, and they can undo them."
            : "Propose new text for the whole document the writer has open. This writes nothing: the " +
              "changes are shown in the writer's editor, where they accept or reject each one, and " +
              "read_current_document returns the old text until they do.") +
          " Always read the whole " +
          "document first — read_current_document with no line numbers — so your edit is based on " +
          "its current contents: what you pass here replaces the entire file, so a reply built from " +
          "only a line range would delete everything outside it. A Flow, Table, Class or Applet is " +
          `checked first: if this answers with problems, nothing was ${editing ? "changed" : "proposed"}, so fix them and call it ` +
          "again. Otherwise call it once per turn, with every change in it.",
        inputSchema: z.object({
          newContent: z.string().describe("The complete new text of the document"),
        }),
        // Recorded, never written here: the client draws it over the open
        // document, where a change reaches the buffer once the writer accepts
        // it, or at once in Editing. The base is the model's own last full read
        // rather than a fresh one, so what the writer typed meanwhile doesn't
        // read as the model deleting it.
        execute: async (input) => {
          const read = lastRead ?? {
            revision: await readRevision(filePath),
            content: await readSpaceFile(spaceRoot, relativePath),
          };
          const before = read.content;
          const checked = await checkProposal(spaceRoot, relativePath, input.newContent, before);
          if (checked.problems.length > 0) return unproposed(relativePath, checked.problems, mode);
          currentDocumentEdit = { path: relativePath, before, newContent: checked.content, revision: read.revision };
          return (
            (editing
              ? "Changes applied to the document; the writer can undo them. Don't call this again this turn."
              : "Changes shown to the writer for review; nothing is applied until they accept. Don't call this again this turn.") +
            filledIn(input.newContent, checked.content)
          );
        },
      });
    }
  }

  // A file the pane points at that has gone since is neither named nor seen.
  const selectedOnDisk =
    selected &&
    (await stat(selected.filePath).then(
      (entry) => ({ ...selected, folder: entry.isDirectory() }),
      () => undefined,
    ));

  // An image reaches the model only through this tool: one the writer has on
  // screen, for the turn that asks, since history carries text alone. A
  // provider whose tool results carry text only gets it in a message after.
  const onScreenImages: ImageView[] = [context, ...(beside ? [beside] : [])].flatMap((view) =>
    view.view === "image" && rasterImageMediaTypeForPath(view.filePath) ? [view] : [],
  );
  if (selectedOnDisk && !selectedOnDisk.folder && rasterImageMediaTypeForPath(selectedOnDisk.filePath)) {
    onScreenImages.push({ view: "image", filePath: selectedOnDisk.filePath, path: selectedOnDisk.path });
  }
  const lookedAt: string[] = [];
  let imagesForNextStep: Array<{ path: string; mediaType: string; data: Uint8Array }> = [];
  const imageTools: ToolSet = {};
  if (onScreenImages.length > 0) {
    imageTools.look_at_image = tool({
      description:
        "See an image the writer has on screen, by the path it's named by above. Each call " +
        "sends you the whole image, so call it only when the answer depends on what the image depicts: " +
        "never for what you're already told, such as its name or folder, nor for a task its content " +
        "doesn't change. You see it for this turn alone: for a later question about what it depicts, " +
        "look again.",
      inputSchema: z.object({
        path: z.string().describe("Path of an image the writer has on screen, as it's named above"),
      }),
      execute: async (input) => {
        const { filePath } = resolveRootedPath(spaceRoot, input.path, "read");
        const shown = onScreenImages.find((view) => view.filePath === filePath);
        if (!shown) throw new Error(`\`${input.path}\` isn't an image the writer has on screen.`);
        const image = await readRasterImage(spaceRoot, shown.path);
        if (!lookedAt.includes(shown.path)) lookedAt.push(shown.path);
        if (!imagesInToolResults) imagesForNextStep.push({ path: shown.path, ...image });
        return { path: shown.path, ...image };
      },
      toModelOutput: ({ output }) =>
        imagesInToolResults
          ? {
              type: "content",
              value: [
                { type: "text", text: `The image \`${output.path}\`:` },
                { type: "file", data: { type: "data", data: output.data }, mediaType: output.mediaType },
              ],
            }
          : { type: "text", value: `The image \`${output.path}\` follows, in the next message.` },
    });
  }

  const linkTo = linksFrom(spaceRoot);
  const reader = createSpaceReader({
    spaceRoot,
    scope: "",
    where: "the space",
    limits: { answer: CHAT_ANSWER_LIMIT, matches: CHAT_SEARCH_MATCHES, line: CHAT_LINE_CHARS },
    folders: true,
    descriptions: true,
    linkTo,
  });

  const spec = await loadProtocolSpec();
  const specTools: ToolSet = {};
  if (spec) {
    specTools.read_pragma_spec = tool({
      description: specToolDescription(spec),
      inputSchema: z.object({ section: specSectionInput }),
      execute: async ({ section }) => spec.read(section) ?? noSuchSection(spec, section),
    });
  }

  // Never writes anything itself — it only records the proposal so the
  // caller can render an Accept/Reject card, and the write goes through the
  // same /api/space/create the file tree's "New note" uses, once the writer
  // clicks Accept, or as the reply arrives in the Editing mode they picked.
  // Either way the model can only ask; the writer's client commits it.
  const proposeCreateDocumentTool = tool({
    description: editing
      ? "Create a new file or directory in the space. It's created as soon as you call this, and " +
        "the writer can undo it, which moves it to the Trash. Pass `content` when the new file " +
        "should start with text (scaffolding an `.applet.html`, say). A Flow, Table, Class or " +
        "Applet is checked first: if this answers with problems, nothing was created, so fix them " +
        "and call it again. Once it's created, don't call this again this turn: wrap up your reply " +
        "saying what you created and why."
      : "Propose creating a new file or directory in the space. This does not create anything by " +
        "itself — it shows the writer an Accept/Reject card in the chat panel, and the entry is only " +
        "actually created if they accept. Pass `content` when the new file should start with text " +
        "(scaffolding an `.applet.html`, say) so the writer sees the code in the card. A Flow, " +
        "Table, Class or Applet is checked first: if this answers with problems, nothing was " +
        "proposed, so fix them and call it again. Once a proposal is shown, don't call this again " +
        "this turn: wrap up your reply explaining what you're proposing and why. Never tell the " +
        "writer something was created until they've accepted it.",
    inputSchema: z.object({
      parentPath: z.string().describe('Space-relative directory the new entry goes in ("" for the space root)'),
      name: z.string().describe('File or directory name, e.g. "aria.md" or "characters"'),
      type: z.enum(["file", "directory"]),
      content: z.string().optional().describe("Initial file contents. Omit for an empty file or a directory."),
    }),
    execute: async (input) => {
      let { content } = input;
      if (input.type === "file" && content !== undefined) {
        const target = path.posix.join(input.parentPath, input.name);
        const checked = await checkProposal(spaceRoot, target, content);
        if (checked.problems.length > 0) return unproposed(target, checked.problems, mode);
        content = checked.content;
      }
      proposedDocument = content === input.content ? input : { ...input, content };
      return (
        (editing
          ? "Created; the writer can undo it. Don't call this again this turn."
          : "Proposal shown to the writer for confirmation. Don't call this again this turn.") +
        filledIn(input.content ?? "", content ?? "")
      );
    },
  });

  // The edit counterpart to propose_create_document, and the one place the
  // copilot can touch a file that ISN'T the open document — but only as a
  // proposal: the client draws it over the file when the other group shows
  // it, else as a diff card whose Apply, or in Editing the reply's arrival,
  // writes it through the PUT an ordinary save uses, on the revision read here.
  //
  // Reads go through the shared space reader, the same doorway
  // read_space_file uses, so a `visibility: private` .md or an image is
  // refused here too rather than reaching the diff.
  const proposeEditFileTool = tool({
    description: editing
      ? "Replace the entire contents of an existing space file that ISN'T the one the writer " +
        "currently has open (for that one, use edit_current_document). The new text is written as " +
        "soon as you call this, and the writer can undo it. Read the whole file first (read_space_file, " +
        "no section) so your replacement is a complete, correct new version. A Flow, Table, Class or Applet is " +
        "checked first: if this answers with problems, nothing was changed, so fix them and call it " +
        "again. Once it's written, don't call this again this turn: say what you changed."
      : "Propose replacing the entire contents of an existing space file that ISN'T the one the " +
        "writer currently has open (for that one, use edit_current_document). This writes nothing by " +
        "itself — it shows the writer the change, over the file in their editor when it's open " +
        "beside, as a diff card otherwise — and the file changes only if they accept. Read the whole " +
        "file first (read_space_file, no section) so your replacement is a complete, correct new version. " +
        "A Flow, Table, Class or Applet is checked first: if this answers with problems, nothing was " +
        "proposed, so fix them and call it again. Once a diff is shown, don't call this again this " +
        "turn: explain what you're proposing. Never tell the writer the file was changed until " +
        "they've accepted it.",
    inputSchema: z.object({
      path: z.string().describe("Space-relative path of the existing file to edit"),
      newContent: z.string().describe("The complete new text of the file"),
    }),
    execute: async (input) => {
      let resolved: string;
      try {
        resolved = resolveWithinSpace(spaceRoot, input.path);
      } catch {
        return `\`${input.path}\` is outside the space.`;
      }
      if (context.view === "document" && resolved === context.filePath) {
        return (
          "That's the document the writer currently has open — use edit_current_document for it, " +
          "not propose_edit_file."
        );
      }
      if (heldByPanes.includes(resolved)) {
        return (
          "That file is open in the writer's editor, which saves over it, so it can't be changed from " +
          "chat while it's open. Describe the change for the writer to make there instead."
        );
      }
      if (!existsSync(resolved)) {
        return `No file exists at \`${input.path}\`. Use propose_create_document to create a new file.`;
      }
      let before: string;
      // Read before the text, as read_current_document does.
      const revision = await readRevision(resolved);
      try {
        before = await readSpaceFile(spaceRoot, input.path);
      } catch (error) {
        return error instanceof Error ? error.message : `Can't read \`${input.path}\`.`;
      }
      const relative = path.relative(spaceRoot, resolved).split(path.sep).join("/");
      const checked = await checkProposal(spaceRoot, relative, input.newContent, before);
      if (checked.problems.length > 0) return unproposed(relative, checked.problems, mode);
      proposedEdit = { path: relative, before, newContent: checked.content, revision };
      return (
        (editing
          ? "Written; the writer can undo it. Don't call this again this turn."
          : "Diff shown to the writer for confirmation. Don't call this again this turn.") +
        filledIn(input.newContent, checked.content)
      );
    },
  });

  const messages: ModelMessage[] = [...history, { role: "user", content: message }];
  const spaceContext = await buildSpaceContext(
    spaceRoot,
    context,
    openDocumentIsPrivate,
    beside,
    selectedOnDisk,
    contextSources,
    linkTo,
  );

  const systemForView =
    context.view === "document"
      ? openDocumentIsPrivate
        ? "You are a writing collaborator embedded in a text editor. The writer currently has a " +
          "document open that's marked `visibility: private` in its frontmatter, so its content " +
          "must never reach you — read_current_document and edit_current_document aren't available " +
          "this turn, and you have no way to see what the document contains. Say so plainly if asked " +
          "about it. Use list_space_files, search_space_files, and read_space_file to help with " +
          "anything else in the space (private files are already excluded from those too)."
        : "You are a writing collaborator embedded in a text editor, scoped to a single open " +
          (!changes
            ? "document, which you can read with read_current_document."
            : editing
              ? "document. Call read_current_document before editing so your changes build on the latest " +
                "text, and use edit_current_document to make the changes the writer asks for: they're " +
                "applied to the document at once, and the writer can undo them."
              : "document. Call read_current_document before editing so your changes build on the latest " +
                "text, and use edit_current_document to propose changes the writer asks for — they review " +
                "each change in the editor, so treat it as not yet made until they accept.") +
          " You may also " +
          "consult the rest of the space — with list_space_files, search_space_files, and " +
          "read_space_file — when answering needs information beyond the open document (e.g. a " +
          "character's backstory living in a sibling file, or a related project's notes)." +
          (changes ? " You can only ever edit the currently open document, never any other file." : "")
      : context.view === "folder"
        ? "You are a writing collaborator embedded in a text editor. The writer currently has a " +
          "folder open in the gallery rather than a single document — there is nothing open to " +
          "edit right now. Use list_space_files, search_space_files, and read_space_file to look " +
          "at its entries (or anything else in the space) when answering needs more than the " +
          "entries and descriptions already given to you below."
        : "You are a writing collaborator embedded in a text editor. The writer doesn't have a text " +
          "document open right now — what they're looking at is described below — so there is " +
          "nothing open to edit. Use list_space_files, search_space_files, and read_space_file to " +
          "look at files in the space when answering needs more than what's already given to you " +
          "below (read_space_file reads text only, never a raster image, video, or PDF).";

  const systemCreation = !changes
    ? ""
    : " If the writer wants a new file or directory added to the space, call propose_create_document " +
      "(pass `content` when the new file should start with text, e.g. scaffolding an Applet) " +
      "rather than trying to create one through edit_current_document. To change an existing file " +
      "that isn't the one currently open, call propose_edit_file." +
      (editing
        ? " Both apply at once, and the writer can undo them."
        : " Both show the writer a confirm card instead of writing immediately, so treat the change " +
          "as not yet made until they accept.");

  // Names no link syntax: the links given are the format's only source.
  const systemLinks =
    " When your reply names a file or folder in the space, write its link so the writer can open it " +
    "from the chat: copy it exactly as a tool result gives it after `link`, or as this prompt gives it, " +
    "and never write a link yourself. Name anything you have no link for by its path in backticks.";

  // The mode the writer picked, stated once so a refusal or an applied change
  // doesn't surprise them.
  const systemMode =
    mode === "viewing"
      ? " The writer has you in Viewing mode: you can read and answer, but nothing you can call " +
        "changes a file. If they ask for a change, write it out in your reply and tell them that " +
        "switching the composer to Suggesting or Editing lets you make it."
      : editing
        ? " The writer has you in Editing mode: your changes land without a confirm step, so make " +
          "only the ones they asked for, and say what you changed."
        : "";

  const systemSpec = spec
    ? " Flows, Tables and Applets have exact file formats: read the kind's section with " +
      "read_pragma_spec, and for a Flow the section of each node type it uses, before proposing or " +
      "describing a change to one, rather than inferring the format from an existing file."
    : "";

  // External (MCP) tools are connected per turn and closed after it, on
  // every path — see mcpTools.ts. A server that can't be reached is dropped
  // for the turn with a note in the prompt, never a failed chat.
  const mcp = await collectMcpTools(external.servers, external.connect, { readOnly: !changes });
  const systemExternal = describeExternalTools(mcp.described, mcp.failures, !changes);

  // The tool loop: the SDK re-prompts with each step's tool results until
  // the model answers in text or MAX_CHAT_STEPS is reached. Scoping is
  // structural — only the tools handed in here can run — and `result.text`
  // is the final step's text, the reply the writer sees.
  const result = await (async () => {
    try {
      return await generateText({
        model: languageModel,
        // Claude's thinking spends this cap before the reply does, so it
        // leaves room for a high effort level and an answer after it.
        maxOutputTokens: 16384,
        reasoning: effort,
        system: `${systemForView}${systemLinks}${systemCreation}${systemMode}${systemSpec}${systemExternal}\n\n${spaceContext}`,
        tools: {
          ...documentTools,
          ...imageTools,
          ...toolSet(reader.tools),
          ...specTools,
          ...(changes && {
            propose_create_document: proposeCreateDocumentTool,
            propose_edit_file: proposeEditFileTool,
          }),
          ...mcp.tools,
        },
        stopWhen: isStepCount(MAX_CHAT_STEPS),
        messages,
        // An override carries forward, so each image is added once.
        prepareStep: ({ messages: stepMessages }) => {
          if (imagesForNextStep.length === 0) return undefined;
          const images = imagesForNextStep;
          imagesForNextStep = [];
          const content = images.flatMap((image) => [
            { type: "text" as const, text: `The image \`${image.path}\` you asked to look at:` },
            { type: "file" as const, mediaType: image.mediaType, data: image.data },
          ]);
          return { messages: [...stepMessages, { role: "user", content }] };
        },
      });
    } catch (error) {
      if (lookedAt.length > 0 && refusedRequest(error)) {
        const named = lookedAt.map((looked) => `"${looked}"`).join(" and ");
        throw new Error(
          `This model couldn't take ${lookedAt.length === 1 ? "the image" : "the images"} ${named}: ${error.message}`,
          { cause: error },
        );
      }
      throw error;
    } finally {
      await mcp.close();
    }
  })();

  return {
    reply: result.text,
    currentDocumentEdit,
    proposedDocument,
    proposedEdit,
    lookedAt: lookedAt.length > 0 ? lookedAt : undefined,
  };
}
