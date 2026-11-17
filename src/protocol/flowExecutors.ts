// The behavioural half of a built-in node — the registry in flowNodes.ts is
// pure metadata. Isomorphic: every environment-specific call goes through the
// context's ports, never a browser API client imported directly.
//
// Built-in nodes run trusted (docs/protocol.md's "Execution" section), so a
// port is a transport seam, not a permission boundary: server-side
// enforcement is what gates a capability.

import { addRowNodeConfig, cellText } from "./addRowNode.ts";
import type {
  AddRowResponse,
  EffortLevel,
  GenerateImageRequestBody,
  GenerateImageResponse,
  GenerateOptionsRequestBody,
  GenerateOptionsResponse,
  GenerateRequestBody,
  GenerateResponse,
  GenerateVideoRequestBody,
  GenerateVideoResponse,
  GenerationCost,
  ReferenceImagePayload,
  SandboxKind,
  SandboxReadResult,
} from "./api.ts";
import { appletNodeConfig } from "./appletNode.ts";
import { formatAspectRatio } from "./aspectRatio.ts";
import { type ClockReading, dateFill, fillDates, fillPlaceholders } from "./datePlaceholders.ts";
import { fileStemFor } from "./entryName.ts";
import {
  type AffixMode,
  affixModeOf,
  choiceOptions,
  EFFORT_KEY,
  FLOW_NODE_REGISTRY,
  GET_FIELD_MAX,
  IMAGE_REFERENCE_SLOTS,
  IMAGE_REFERENCES_MAX,
  intValue,
  numberToTextDigits,
  TEMPLATE_VARIABLES_MAX,
} from "./flowNodes.ts";
import { parseFrontmatter } from "./frontmatter.ts";
import { splitNoteTitle } from "./markdownTitle.ts";
import { mentionedImagePins } from "./referenceMentions.ts";
import { formatRootPath, formatWrittenPath, readWrittenPath, resolveDeclaredPath } from "./relativeReference.ts";
import {
  basenameOf,
  dirnameOf,
  formatDeclaredPath,
  formatRootedPath,
  isLibraryRoot,
  parseRootedPath,
} from "./rootedPath.ts";
import { type ScopeFolders, scopeOf } from "./scopes.ts";
import {
  type ContextSent,
  chartSpecFrom,
  type FieldValueType,
  type FlowCapabilityDeclaration,
  type FlowNodeInstance,
  holdsPath,
  isInlineImage,
  isMarkdownFile,
  isTableFile,
  notARasterImage,
  rasterImageMediaTypeForPath,
  splitDocumentName,
} from "./types.ts";
import { resolutionShortSide } from "./videoResolution.ts";

/** The capability calls an executor makes, as a port rather than an import.
 * The editor backs these with HTTP to /api/sandbox/*; a headless runner
 * backs them with a direct in-process call to the same handlers. */
export interface SandboxPort {
  read(kind: SandboxKind, path: string, targetPath: string): Promise<SandboxReadResult>;
  write(kind: SandboxKind, path: string, targetPath: string, content: string): Promise<void>;
  // One row onto a Table, its cells by column id; a column left out gets what
  // a new row gets.
  addRow(kind: SandboxKind, path: string, targetPath: string, values: Record<string, string>): Promise<AddRowResponse>;
  // A text onto a note, at its end or where its body starts.
  addToNote(kind: SandboxKind, path: string, targetPath: string, text: string, mode: AffixMode): Promise<void>;
  generate(kind: SandboxKind, path: string, body: GenerateRequestBody, signal?: AbortSignal): Promise<GenerateResponse>;
  generateOptions(
    kind: SandboxKind,
    path: string,
    body: GenerateOptionsRequestBody,
    signal?: AbortSignal,
  ): Promise<GenerateOptionsResponse>;
  generateImage(
    kind: SandboxKind,
    path: string,
    body: GenerateImageRequestBody,
    signal?: AbortSignal,
  ): Promise<GenerateImageResponse>;
  generateVideo(
    kind: SandboxKind,
    path: string,
    body: GenerateVideoRequestBody,
    signal?: AbortSignal,
  ): Promise<GenerateVideoResponse>;
}

/** The document a person started the run from, fixed at the moment they did:
 * a later edit neither changes what a node reads nor moves where a
 * replacement lands. Only a toolkit button binds one; a run from the canvas
 * or from outside the app has none. */
export interface DocumentPort {
  readonly path: string;
  /** Whether anything was selected — known without reading the document. */
  readonly hasSelection: boolean;
  /** The whole file, unsaved edits included, and what was selected ("" when
   * nothing was). Refuses a document that has since closed or is private. */
  read(): { content: string; selection: string };
  /** Proposes a replacement for that selection, for the writer to accept or
   * reject; with several, the writer steps through them and accepts one.
   * Nothing is written by the run itself. */
  replaceSelection(alternatives: readonly string[]): void;
  /** Shows lines under the button the run was started from. */
  showResult(lines: readonly string[]): void;
}

export type PortValue =
  | { type: "text"; value: string }
  | { type: "image"; mediaType: string; data: string }
  | { type: "boolean"; value: boolean }
  | { type: "object"; value: unknown }
  | { type: "number"; value: number };

/** Runtime-only state a node executor needs beyond the graph itself. */
export interface NodeExecutionContext {
  /** Which flow's grants apply — the `path` every /api/sandbox/* request
   * carries. */
  flowPath: string;
  sandbox: SandboxPort;
  /** Pixel dimensions read from the image bytes themselves, never from OS or
   * space file metadata, which could lack or lie about them. An environment
   * that can't decode an image refuses rather than guessing: a made-up size
   * would silently differ from the same graph's result elsewhere. */
  decodeImageDimensions(mediaType: string, data: string): Promise<{ width: number; height: number }>;
  /** A `loadImage` node's OS-picked bytes and file name, keyed by node id —
   * ephemeral, never persisted into `.flow.html`, and only the fallback for
   * a node with no `config.imagePath`. */
  pickedImages: Map<string, { mediaType: string; data: string; name: string }>;
  /** The first-use grant prompt, called before touching anything
   * capability-gated. Only UX: server-side enforcement is what gates. */
  ensureCapability: (capability: FlowCapabilityDeclaration) => Promise<boolean>;
  /** The status-bar model indicator. The generate executor wraps just its
   * own request, not the whole run, so it tracks only the in-flight call. */
  beginLlmActivity: (model: string) => void;
  endLlmActivity: (model: string) => void;
  /** Stops the run: no further node starts, and a model call in flight is
   * aborted rather than left to finish and bill. */
  signal?: AbortSignal;
  document?: DocumentPort;
  /** Lines worth showing under a node after its run that are not outputs:
   * a result found again rather than paid for, a setting the provider
   * changed. Absent where no one reads them. */
  report?: (nodeId: string, lines: string[]) => void;
  /** Each image or video generation as it settles, reused or paid for, for
   * the record a person reads afterwards: the canvas's Console, a headless
   * run's activity entry. */
  spent?: (nodeId: string, spend: GenerationSpend) => void;
  /** Each text generation as it settles, answered or failed, for the
   * person who started the run: its Console entry, and its warnings on the
   * node's card or under the button. A stopped run's is never reported. */
  generated?: (nodeId: string, generation: TextGeneration) => void;
  /** A document a node changed on disk, by its path from the space root, so
   * whatever shows it can read it again. Absent where nothing shows one. */
  wrote?: (path: string) => void;
  /** Opens a file, by its path from the space root, in the editor group
   * beside the one the run came from, without moving focus; rejects, naming
   * why, when there is nothing there to open. Absent where no one is looking. */
  openToSide?: (path: string) => Promise<void>;
  /** The folders a scope opens over in the space, which decide how a path is
   * written as a link. Asked for only by a node that writes one. */
  scopes: () => Promise<ScopeFolders>;
  /** The run's one clock reading, taken as it starts, which every date
   * placeholder it fills reads: a run across midnight names one day. */
  clock: ClockReading;
}

/** A text generation as it settled: the host's answer, or what it failed
 * with. */
export type TextGeneration =
  | { failed: false; result: GenerateResponse | GenerateOptionsResponse }
  | { failed: true; error: unknown };

/** One generation as it settles. A video's `cost` is the provider's quote,
 * which the charge can differ from; an image's is what its adapter reports.
 * `notes` is every note the provider gave, the node's warnings first. */
export interface GenerationSpend {
  media: "image" | "video";
  model: string;
  path: string;
  reused: boolean;
  cost?: GenerationCost;
  notes?: string[];
}

/** "0.12 credits", "1 credit". */
export function describeCost(cost: GenerationCost): string {
  const amount = Number(cost.amount.toFixed(4));
  return `${amount} ${amount === 1 ? cost.unit.replace(/s$/, "") : cost.unit}`;
}

/** One generation as the Console records it. */
export function describeSpend(spend: GenerationSpend): string {
  if (spend.reused) return `Reused, nothing spent · ${spend.path}`;
  const verb = spend.media === "video" ? "Quoted" : "Spent";
  return `${spend.cost ? `${verb} ${describeCost(spend.cost)}` : "The provider named no price"} · ${spend.path}`;
}

/** What a generation's `context` pin sent, as lines for a person: each file
 * from the root in the order it went, what the model searched for, then its
 * messages in the order they happened. */
export function describeContextSent(sent: ContextSent): string[] {
  const head = sent.files.length > 0 ? "Sent as context:" : `Nothing around ${sent.path} to send as context.`;
  const searched = sent.searches.map((query) => `"${query}"`).join(", ");
  const said = sent.messages.map((message) => message.text);
  return [head, ...sent.files, ...(searched ? [`Searched for ${searched}.`] : []), ...said];
}

/** A generation's Console entry: its kind, its title, what it spent, and
 * its notes, the ones its node leaves out too. */
export function spendEntry(spend: GenerationSpend): [kind: string, label: string, content: string] {
  const node = spend.media === "video" ? "Generate Video" : "Generate Image";
  const content = [describeSpend(spend), ...(spend.notes ?? [])].join("\n");
  return [spend.media.toUpperCase(), `${node} · ${spend.model}`, content];
}

// `wired` is the node's outputs a wire leaves, for a node that skips work no
// wire takes; without it, a node gives every output.
export type NodeExecutor = (
  node: FlowNodeInstance,
  inputs: Record<string, PortValue>,
  context: NodeExecutionContext,
  wired?: ReadonlySet<string>,
) => Promise<Record<string, PortValue>>;

// A stored path's file name, without the `space:` or `lib:` its root is
// written with: `space:notes.md` is a note named "notes".
function fileNameOf(storedPath: string): string {
  let within = storedPath;
  try {
    within = parseRootedPath(storedPath).path;
  } catch {
    // Named as stored: the read that follows is what refuses a bad path.
  }
  return basenameOf(within);
}

function configString(node: FlowNodeInstance, key: string): string {
  const value = node.config[key];
  return typeof value === "string" ? value : "";
}

/** The path a path-taking node works on: what is wired into its path pin,
 * else the one its config holds from a drag. A wire's text is read as a link
 * is, from the Flow's folder, and becomes an address, so the capability it
 * asks for names one file. A connected "" is no path, not a fall back to the
 * config's, as a connected widget input's "" is no value. */
function nodePath(
  node: FlowNodeInstance,
  inputs: Record<string, PortValue>,
  context: NodeExecutionContext,
): { path: string; wired: boolean } {
  const spec = FLOW_NODE_REGISTRY[node.type]?.pathInput;
  if (!spec) throw new Error(`A ${node.type} node takes no path`);
  const wire = inputs[spec.portId];
  if (wire?.type !== "text") return { path: configString(node, spec.configKey), wired: false };
  const text = wire.value.trim();
  if (!text) return { path: "", wired: true };
  const rooted = resolveDeclaredPath(dirnameOf(context.flowPath), text);
  if (isLibraryRoot(rooted.root) && !spec.library)
    throw new Error(`"${text}" is in a library, which this node can't reach`);
  return { path: formatDeclaredPath(rooted), wired: true };
}

// What a node hands on names its entry from the root, so the path means one
// entry wherever it is wired or written.
function outputPath(context: NodeExecutionContext, declared: string): PortValue {
  return { type: "text", value: formatRootPath(resolveDeclaredPath(dirnameOf(context.flowPath), declared)) };
}

// A loader's `path`, the file it read; "" when it read none.
function readPath(context: NodeExecutionContext, declared: string): PortValue {
  return declared ? outputPath(context, declared) : { type: "text", value: "" };
}

/** How a loader hands on the values of the document it read at `declared`:
 * a media or path value, written from that document's folder, from the root
 * as every path a node hands on is; one that names nothing as written. */
function documentValues(
  context: NodeExecutionContext,
  declared: string,
): (type: FieldValueType, value: string) => string {
  const docDir = dirnameOf(formatRootedPath(resolveDeclaredPath(dirnameOf(context.flowPath), declared)));
  return (type, value) => {
    const read = holdsPath(type) && value.trim() ? readWrittenPath(docDir, value.trim(), "markdown") : undefined;
    return read ? formatRootPath(read.target, read.folder) : value;
  };
}

function readCapability(path: string, wired: boolean): FlowCapabilityDeclaration {
  return { type: "readFile", path, ...(wired ? { wired: true as const } : {}) };
}

function writeCapability(path: string, wired: boolean): FlowCapabilityDeclaration {
  return { type: "writeDocument", path, ...(wired ? { wired: true as const } : {}) };
}

// Whole or decimal terms: Load Image writes 1.85:1 the way film does.
const ASPECT_RATIO = /^\d+(\.\d+)?:\d+(\.\d+)?$/;

// The images wired into a Generate node's reference pins, in pin order, each
// with its pin. The host spells the prompt's mentions of them for the model.
function wiredReferences(inputs: Record<string, PortValue>): ReferenceImagePayload[] {
  const references: ReferenceImagePayload[] = [];
  for (let pin = 1; pin <= IMAGE_REFERENCES_MAX; pin++) {
    const port = inputs[IMAGE_REFERENCE_SLOTS.portId(pin)];
    if (port?.type === "image") references.push({ pin, mediaType: port.mediaType, data: port.data });
  }
  return references;
}

// Fails a mention of an empty pin before anything is asked or spent.
function checkMentions(
  text: string,
  references: readonly ReferenceImagePayload[],
  field: "prompt" | "instruction" = "prompt",
): void {
  for (const pin of mentionedImagePins(text)) {
    if (!references.some((reference) => reference.pin === pin)) {
      throw new Error(`The ${field} names @image_${pin}, but no image is connected to image_${pin}`);
    }
  }
}

const generateImage: NodeExecutor = async (node, inputs, context) => {
  const folder = configString(node, "outputFolderPath");
  if (!folder) throw new Error("Drag the folder for results onto this node");
  const prompt = inputs.prompt?.type === "text" ? inputs.prompt.value : "";
  if (!prompt.trim()) throw new Error("Generate Image has no prompt connected");
  const aspectRatio = resolveTextInput(inputs, node, "aspect_ratio", context).trim();
  if (aspectRatio && !ASPECT_RATIO.test(aspectRatio)) {
    throw new Error(`Aspect ratio "${aspectRatio}" isn't width:height, such as 16:9`);
  }
  const references = wiredReferences(inputs);
  checkMentions(prompt, references);

  const granted = await context.ensureCapability({ type: "generateImage", path: folder });
  if (!granted) throw new Error(`Permission denied to generate images into "${folder}"`);

  const model = resolveTextInput(inputs, node, "model", context).trim() || undefined;
  const request: GenerateImageRequestBody = {
    folder,
    prompt,
    references,
    model,
    aspectRatio: aspectRatio || undefined,
    seed: configString(node, "seed").trim() || undefined,
    prefix: resolveTextInput(inputs, node, "prefix", context).trim() || undefined,
  };
  context.beginLlmActivity(model ?? "");
  try {
    const result = await context.sandbox.generateImage("flow", context.flowPath, request, context.signal);
    const notes = [...result.warnings, ...(result.notes ?? [])];
    context.spent?.(node.id, {
      media: "image",
      model: result.model,
      path: result.path,
      reused: result.reused,
      cost: result.cost,
      ...(notes.length ? { notes } : {}),
    });
    const lines = [
      ...(result.reused ? [`Reused ${result.path}: these inputs were generated before.`] : []),
      ...(result.cost ? [`Spent ${describeCost(result.cost)}.`] : []),
      ...result.warnings,
    ];
    if (lines.length) context.report?.(node.id, lines);
    return {
      image: { type: "image", mediaType: result.image.mediaType, data: result.image.data },
      path: outputPath(context, result.path),
      file_name: { type: "text", value: stripExtension(fileNameOf(result.path)) },
    };
  } finally {
    context.endLlmActivity(model ?? "");
  }
};

// Whole seconds; a model snaps a length it doesn't make to the nearest it does.
const WHOLE_NUMBER = /^\d+$/;

const generateVideo: NodeExecutor = async (node, inputs, context) => {
  const folder = configString(node, "outputFolderPath");
  if (!folder) throw new Error("Drag the folder for results onto this node");
  const prompt = inputs.prompt?.type === "text" ? inputs.prompt.value : "";
  if (!prompt.trim()) throw new Error("Generate Video has no prompt connected");
  const aspectRatio = resolveTextInput(inputs, node, "aspect_ratio", context).trim();
  if (aspectRatio && !ASPECT_RATIO.test(aspectRatio)) {
    throw new Error(`Aspect ratio "${aspectRatio}" isn't width:height, such as 16:9`);
  }
  const resolution = resolveTextInput(inputs, node, "resolution", context).trim();
  if (resolution && resolutionShortSide(resolution) === undefined) {
    throw new Error(`Resolution "${resolution}" isn't a video size, such as 720p`);
  }
  const duration = resolveTextInput(inputs, node, "duration", context).trim();
  if (duration && !(WHOLE_NUMBER.test(duration) && Number(duration) > 0)) {
    throw new Error(`Duration "${duration}" isn't a whole number of seconds, such as 5`);
  }
  const take = configString(node, "take").trim();
  if (take && !(WHOLE_NUMBER.test(take) && Number(take) > 0)) {
    throw new Error(`Take "${take}" isn't a whole number, such as 2`);
  }
  const frame = (portId: string) => {
    const port = inputs[portId];
    return port?.type === "image" ? { mediaType: port.mediaType, data: port.data } : undefined;
  };
  const startFrame = frame("start_frame");
  const endFrame = frame("end_frame");
  const references = wiredReferences(inputs);
  // A video model's call takes frames or references, never both, as a model
  // maker's docs split a first-frame task from a reference task.
  if ((startFrame || endFrame) && references.length) {
    throw new Error(
      'Generate Video sends frames or references, not both. Connect the frame to a reference pin instead, and say what it is in the prompt, such as "@image_1 is the first frame"',
    );
  }
  checkMentions(prompt, references);

  const granted = await context.ensureCapability({ type: "generateVideo", path: folder });
  if (!granted) throw new Error(`Permission denied to generate videos into "${folder}"`);

  const model = resolveTextInput(inputs, node, "model", context).trim() || undefined;
  const request: GenerateVideoRequestBody = {
    folder,
    prompt,
    startFrame,
    endFrame,
    ...(references.length ? { references } : {}),
    model,
    aspectRatio: aspectRatio || undefined,
    resolution: resolution || undefined,
    duration: duration || undefined,
    take: take || undefined,
    prefix: resolveTextInput(inputs, node, "prefix", context).trim() || undefined,
  };
  context.beginLlmActivity(model ?? "");
  try {
    const result = await context.sandbox.generateVideo("flow", context.flowPath, request, context.signal);
    const notes = [...result.warnings, ...(result.notes ?? [])];
    context.spent?.(node.id, {
      media: "video",
      model: result.model,
      path: result.path,
      reused: result.reused,
      cost: result.quote,
      ...(notes.length ? { notes } : {}),
    });
    const lines = [
      ...(result.reused ? [`Reused ${result.path}: these inputs were generated before.`] : []),
      ...(result.resumed ? ["Collected the clip an earlier run started."] : []),
      ...(result.quote ? [`Quoted ${describeCost(result.quote)}.`] : []),
      ...result.warnings,
    ];
    if (lines.length) context.report?.(node.id, lines);
    return {
      path: outputPath(context, result.path),
      file_name: { type: "text", value: stripExtension(fileNameOf(result.path)) },
    };
  } finally {
    context.endLlmActivity(model ?? "");
  }
};

function configBoolean(node: FlowNodeInstance, key: string): boolean {
  return node.config[key] === "true";
}

// A widget input (FlowNodeInputWidget in flowNodes.ts): a connected value
// wins even when it's "", a meaningful result for a text field, not "nothing
// here." Only an unconnected port, absent from `inputs`, falls back to the
// widget's stored value.
function resolveTextInput(
  inputs: Record<string, PortValue>,
  node: FlowNodeInstance,
  key: string,
  context: NodeExecutionContext,
): string {
  const input = inputs[key];
  if (input?.type === "text") return input.value;
  const typed = configString(node, key);
  return isTextBox(node, key) ? fillDates(typed, context.clock) : typed;
}

// Typed into a text box: a select's or a model picker's value is a pick, and
// a value that arrives on a wire is used as it arrives (protocol.md, Ports
// and types).
function isTextBox(node: FlowNodeInstance, key: string): boolean {
  return FLOW_NODE_REGISTRY[node.type]?.inputWidgets?.some((w) => w.portId === key && w.type === "text") ?? false;
}

// The same resolution for a "checkbox"-widget boolean port — the connected
// value wins whenever the port has an edge, even a connected `false`; only a
// genuinely unconnected port falls back to the checkbox's own stored state.
function resolveBooleanInput(inputs: Record<string, PortValue>, node: FlowNodeInstance, key: string): boolean {
  const input = inputs[key];
  return input?.type === "boolean" ? input.value : configBoolean(node, key);
}

// Both outputs describe the same author-picked row: `selected` is its
// first-column value, `row` the whole row keyed by column label, not id.
// No table configured, or no row picked, gives `row` as `{}`: empty, not an
// error. A picked row the table no longer has fails the node instead.
const loadRow: NodeExecutor = async (node, _inputs, context) => {
  const tablePath = configString(node, "tablePath");
  const selectedValue = configString(node, "selectedValue");
  let selected = selectedValue;
  let row: Record<string, string> = {};
  if (tablePath) {
    const granted = await context.ensureCapability({ type: "readFile", path: tablePath });
    if (!granted) throw new Error(`Permission denied to read "${tablePath}"`);
    const result = await context.sandbox.read("flow", context.flowPath, tablePath);
    const { columns, rows } = result.kind === "table" ? result : { columns: [], rows: [] };
    const value = documentValues(context, tablePath);
    const firstColumnId = columns[0]?.id;
    const match =
      firstColumnId === undefined
        ? undefined
        : rows.find((candidate) => (candidate.values[firstColumnId] ?? "") === selectedValue);
    if (match) {
      row = Object.fromEntries(
        columns.map((column) => [column.label, value(column.type, match.values[column.id] ?? "")]),
      );
      selected = value(columns[0].type, selectedValue);
    } else if (selectedValue) {
      throw new Error(`"${tablePath}" no longer has a row "${selectedValue}"`);
    }
  }
  return {
    selected: { type: "text", value: selected },
    row: { type: "object", value: row },
    path: readPath(context, tablePath),
  };
};

// Every row, keyed by column label as loadRow's `row` is. No table
// configured gives `[]`: empty, not an error, as loadRow's `{}` is.
const loadTableRows: NodeExecutor = async (node, inputs, context) => {
  const { path: tablePath, wired } = nodePath(node, inputs, context);
  let rows: Record<string, string>[] = [];
  if (tablePath) {
    const granted = await context.ensureCapability(readCapability(tablePath, wired));
    if (!granted) throw new Error(`Permission denied to read "${tablePath}"`);
    const result = await context.sandbox.read("flow", context.flowPath, tablePath);
    if (result.kind !== "table") throw new Error(`"${tablePath}" isn't a table`);
    const value = documentValues(context, tablePath);
    rows = result.rows.map((row) =>
      Object.fromEntries(
        result.columns.map((column) => [column.label, value(column.type, row.values[column.id] ?? "")]),
      ),
    );
  }
  return { rows: { type: "object", value: rows }, path: readPath(context, tablePath) };
};

// Drawing is the editor's; what can be checked without drawing fails here,
// so a run with no canvas fails the same way one with a canvas does. A column
// the rows lack names the ones they have, as Get Field does.
const chart: NodeExecutor = async (node, inputs) => {
  const input = inputs.rows;
  const rows = input?.type === "object" ? input.value : undefined;
  const isRecord = (row: unknown) => typeof row === "object" && row !== null && !Array.isArray(row);
  if (!Array.isArray(rows) || !rows.every(isRecord)) {
    throw new Error("Chart needs a list of rows. Wire a Load Table into it.");
  }
  const spec = chartSpecFrom(node.config);
  if (!spec.x || !spec.y) throw new Error("Choose the columns to chart");
  const first = rows[0] as Record<string, unknown> | undefined;
  for (const column of [spec.x, spec.y]) {
    if (first && !Object.hasOwn(first, column)) {
      throw new Error(`No column "${column}" (it has ${Object.keys(first).join(", ")})`);
    }
  }
  return { rows: { type: "object", value: rows } };
};

// What the Applet last reported, saved in the node's config. A run never
// executes an Applet, so a run with no browser behind it gives the same
// values, and they are exactly what the Flow's grant hash covers.
const applet: NodeExecutor = async (node) => {
  const config = appletNodeConfig(node.config);
  if (!config.appletPath) throw new Error("Drag an Applet from your space onto this node");
  const declared = config.ports?.outputs ?? [];
  const outputs: Record<string, PortValue> = {};
  for (const port of declared) {
    const value = config.outputs?.[port.id];
    // A saved image meets the check a reported one does: the Flow file is
    // anyone's to write, and what it holds here goes on to a model.
    if (value?.type !== port.type) continue;
    if (value.type !== "image" || isInlineImage(value.mediaType, value.data)) outputs[port.id] = value;
  }
  if (declared.length > 0 && Object.keys(outputs).length === 0) {
    throw new Error("This Applet hasn't reported its outputs yet: open the Flow so it can");
  }
  return outputs;
};

// loadRow with a weighted-random pick. A row's weight is its integer cell
// in `weightColumn`; blank, non-numeric, or <= 0 opts the row out rather than
// counting as 1, as the picker's dropdown documents. If that excludes every
// row, or no weightColumn is set, the pick is uniform across all rows.
const loadRandomRow: NodeExecutor = async (node, inputs, context) => {
  const { path: tablePath, wired } = nodePath(node, inputs, context);
  const weightColumn = configString(node, "weightColumn");
  let row: Record<string, string> = {};
  let selected = "";
  if (tablePath) {
    const granted = await context.ensureCapability(readCapability(tablePath, wired));
    if (!granted) throw new Error(`Permission denied to read "${tablePath}"`);
    const result = await context.sandbox.read("flow", context.flowPath, tablePath);
    if (result.kind === "table" && result.columns.length > 0 && result.rows.length > 0) {
      const weighted = weightColumn
        ? result.rows
            .map((candidate) => ({ candidate, weight: Number.parseInt(candidate.values[weightColumn] ?? "", 10) }))
            .filter(({ weight }) => Number.isFinite(weight) && weight > 0)
        : [];
      const pool = weighted.length > 0 ? weighted : result.rows.map((candidate) => ({ candidate, weight: 1 }));
      const totalWeight = pool.reduce((sum, { weight }) => sum + weight, 0);
      let pick = Math.random() * totalWeight;
      let match = pool[pool.length - 1].candidate;
      for (const { candidate, weight } of pool) {
        if (pick < weight) {
          match = candidate;
          break;
        }
        pick -= weight;
      }
      const value = documentValues(context, tablePath);
      const [first] = result.columns;
      row = Object.fromEntries(
        result.columns.map((column) => [column.label, value(column.type, match.values[column.id] ?? "")]),
      );
      selected = value(first.type, match.values[first.id] ?? "");
    }
  }
  return {
    selected: { type: "text", value: selected },
    row: { type: "object", value: row },
    path: readPath(context, tablePath),
  };
};

// The four outputs a note read produces. Malformed YAML gives an empty
// `properties` rather than failing the node: a graph that only reads `raw`
// must not start failing over a block it never uses.
function noteOutputs(notePath: string, content: string): Record<string, PortValue> {
  let properties: Record<string, unknown> = {};
  try {
    properties = parseFrontmatter(content).data;
  } catch {}
  const { title, body } = splitNoteTitle(content);
  return {
    title: { type: "text", value: title ?? splitDocumentName(fileNameOf(notePath)).stem },
    properties: { type: "object", value: properties },
    body: { type: "text", value: body },
    raw: { type: "text", value: content },
  };
}

const EMPTY_NOTE_OUTPUTS: Record<string, PortValue> = {
  title: { type: "text", value: "" },
  properties: { type: "object", value: {} },
  body: { type: "text", value: "" },
  raw: { type: "text", value: "" },
  path: { type: "text", value: "" },
};

// Reads the configured markdown note via the capability-gated broker — see
// FLOW_NODE_REGISTRY's loadNote entry. The markdown check repeats the drop
// target's, in case the file at this path was renamed or replaced since it
// was dropped in.
const loadNote: NodeExecutor = async (node, inputs, context) => {
  const { path: notePath, wired } = nodePath(node, inputs, context);
  if (!notePath) return EMPTY_NOTE_OUTPUTS;
  if (!isMarkdownFile(notePath)) throw new Error(`"${notePath}" is no longer a markdown note`);
  const granted = await context.ensureCapability(readCapability(notePath, wired));
  if (!granted) throw new Error(`Permission denied to read "${notePath}"`);
  const result = await context.sandbox.read("flow", context.flowPath, notePath);
  if (result.kind !== "text") throw new Error(`"${notePath}" is no longer readable as text`);
  return { ...noteOutputs(notePath, result.content), path: outputPath(context, notePath) };
};

// loadNote's read, but the capability checked is the *folder*, not the
// selected note, so one grant covers every note in it (see the registry
// entry). What's read and what's granted differ, which is why this can't
// reuse loadNote's executor.
const loadFolderNote: NodeExecutor = async (node, _inputs, context) => {
  const folderPath = configString(node, "folderPath");
  const notePath = configString(node, "notePath");
  if (!folderPath || !notePath) return EMPTY_NOTE_OUTPUTS;
  if (!isMarkdownFile(notePath)) throw new Error(`"${notePath}" is no longer a markdown note`);
  const granted = await context.ensureCapability({ type: "readFile", path: folderPath });
  if (!granted) throw new Error(`Permission denied to read notes in "${folderPath}"`);
  const result = await context.sandbox.read("flow", context.flowPath, notePath);
  if (result.kind !== "text") throw new Error(`"${notePath}" is no longer readable as text`);
  return { ...noteOutputs(notePath, result.content), path: outputPath(context, notePath) };
};

// Load Image's "name" and a Generate node's "file_name": the file's name
// without its extension, so a text chain built off it (e.g. feeding a
// prompt) doesn't carry a stray ".png" along. Not a claim the file actually
// has an extension; a dot-less name passes through unchanged.
function stripExtension(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot > 0 ? filename.slice(0, dot) : filename;
}

// A tree drag persists `imagePath`, re-read on every Run. Its declaration
// comes from the shared helper in flowNodes.ts, never spelled out here:
// `imagePath` may name a library, and the pickers and this executor must ask
// for the identical key.
//
// An OS browse/drop persists no path, so it falls back to
// `context.pickedImages` — that session's pick, gone once the flow reopens.
//
// An optional node with nothing picked gives no outputs at all, so every
// port it feeds goes without, as an unwired one would.
const loadImage: NodeExecutor = async (node, inputs, context): Promise<Record<string, PortValue>> => {
  const { path: imagePath, wired } = nodePath(node, inputs, context);
  // A wire speaks for the node: a computer's pick doesn't stand in for it.
  const picked = wired ? undefined : context.pickedImages.get(node.id);
  if (!imagePath && !picked && configBoolean(node, "optional")) return {};
  let mediaType: string;
  let data: string;
  let name: string;
  if (imagePath) {
    // Before anything is asked: a grant to read what the node refuses is no use.
    if (!rasterImageMediaTypeForPath(imagePath)) throw new Error(notARasterImage(imagePath));
    const granted = await context.ensureCapability(readCapability(imagePath, wired));
    if (!granted) throw new Error(`Permission denied to read "${imagePath}"`);
    const result = await context.sandbox.read("flow", context.flowPath, imagePath);
    if (result.kind !== "image") throw new Error(`"${imagePath}" is no longer an image`);
    mediaType = result.mediaType;
    data = result.data;
    name = stripExtension(fileNameOf(imagePath));
  } else {
    if (!picked) throw new Error(wired ? "Nothing reached its path input" : `No image picked for node "${node.id}"`);
    mediaType = picked.mediaType;
    data = picked.data;
    name = stripExtension(picked.name);
  }
  const { width, height } = await context.decodeImageDimensions(mediaType, data);
  return {
    image: { type: "image", mediaType, data },
    name: { type: "text", value: name },
    width: { type: "number", value: width },
    height: { type: "number", value: height },
    aspect_ratio: { type: "text", value: formatAspectRatio(width, height) },
    path: readPath(context, imagePath),
  };
};

// loadImage's read with the *folder* as the capability, as in loadFolderNote.
// No OS-pick fallback: this node is always space-sourced, so an unset
// selection is an error, not an ephemeral-pick lookup.
const loadFolderImage: NodeExecutor = async (node, _inputs, context) => {
  const folderPath = configString(node, "folderPath");
  const imagePath = configString(node, "imagePath");
  if (!folderPath || !imagePath) throw new Error(`No image selected for node "${node.id}"`);
  if (!rasterImageMediaTypeForPath(imagePath)) throw new Error(notARasterImage(imagePath));
  const granted = await context.ensureCapability({ type: "readFile", path: folderPath });
  if (!granted) throw new Error(`Permission denied to read images in "${folderPath}"`);
  const result = await context.sandbox.read("flow", context.flowPath, imagePath);
  if (result.kind !== "image") throw new Error(`"${imagePath}" is no longer an image`);
  const { width, height } = await context.decodeImageDimensions(result.mediaType, result.data);
  const name = stripExtension(fileNameOf(imagePath));
  return {
    image: { type: "image", mediaType: result.mediaType, data: result.data },
    name: { type: "text", value: name },
    width: { type: "number", value: width },
    height: { type: "number", value: height },
    aspect_ratio: { type: "text", value: formatAspectRatio(width, height) },
    path: outputPath(context, imagePath),
  };
};

// What both generation nodes send through the host's generation call, with
// no envelope of Flow's own: the instruction, the connected images, and the
// node's model. Granted before anything is sent.
async function generationRequest(
  node: FlowNodeInstance,
  inputs: Record<string, PortValue>,
  context: NodeExecutionContext,
): Promise<GenerateRequestBody> {
  const instruction = inputs.instruction?.type === "text" ? inputs.instruction.value : "";
  if (!instruction.trim()) throw new Error(`${node.type} node has no instruction connected`);
  const references = wiredReferences(inputs);
  checkMentions(instruction, references, "instruction");

  const granted = await context.ensureCapability({ type: "generateText" });
  if (!granted) throw new Error("Permission denied to run an AI generation");

  // Keyed by port id: dispatchAction.ts inserts the key as the `@image_1`
  // mention right before the image, the name an instruction types.
  const images: Record<string, { mediaType: string; data: string }> = {};
  for (const { pin, mediaType, data } of references) images[IMAGE_REFERENCE_SLOTS.portId(pin)] = { mediaType, data };

  const model = resolveTextInput(inputs, node, "model", context) || undefined;
  const contextAddress = await wiredContext(node, inputs, context);
  // Sent as written: the host refuses one that names no level.
  const effort = configString(node, EFFORT_KEY) as EffortLevel;
  return {
    instruction,
    values: {},
    images,
    model,
    ...(contextAddress ? { context: contextAddress } : {}),
    ...(effort ? { effort } : {}),
  };
}

/** The address a generation's `context` pin brings, once the scope it sits
 * in is granted; undefined while nothing is wired into it. A connected "" is
 * no path, and a library has no scope to send from. */
async function wiredContext(
  node: FlowNodeInstance,
  inputs: Record<string, PortValue>,
  context: NodeExecutionContext,
): Promise<string | undefined> {
  const port = FLOW_NODE_REGISTRY[node.type]?.contextPort;
  const wire = port ? inputs[port] : undefined;
  if (wire?.type !== "text") return undefined;
  const text = wire.value.trim();
  if (!text) throw new Error(`${node.type} node has a context wired that carries no path`);
  const rooted = resolveDeclaredPath(dirnameOf(context.flowPath), text);
  if (isLibraryRoot(rooted.root)) throw new Error(`"${text}" is in a library, which has no context to send`);
  const scope = { root: "space" as const, path: scopeOf(await context.scopes(), rooted.path) };
  const granted = await context.ensureCapability({ type: "searchContext", path: formatDeclaredPath(scope) });
  if (!granted) throw new Error(`Permission denied to send files from "${formatRootPath(scope, true)}"`);
  return formatDeclaredPath(rooted);
}

// The indicator is lit for the call alone. A call the run stopped isn't
// reported: the person stopped it, so it failed no one.
async function reported<T extends GenerateResponse | GenerateOptionsResponse>(
  node: FlowNodeInstance,
  context: NodeExecutionContext,
  model: string | undefined,
  call: () => Promise<T>,
): Promise<T> {
  context.beginLlmActivity(model ?? "");
  try {
    const result = await call();
    context.generated?.(node.id, { failed: false, result });
    return result;
  } catch (error) {
    if (!context.signal?.aborted) context.generated?.(node.id, { failed: true, error });
    throw error;
  } finally {
    context.endLlmActivity(model ?? "");
  }
}

const generateText: NodeExecutor = async (node, inputs, context) => {
  const request = await generationRequest(node, inputs, context);
  const result = await reported(node, context, request.model, () =>
    context.sandbox.generate("flow", context.flowPath, request, context.signal),
  );
  return { text: { type: "text", value: result.reply } };
};

// A count the config can't read as a whole number falls back to the
// default rather than failing: the node still does what it says.
export const GENERATE_OPTIONS_DEFAULT = 10;
export const GENERATE_OPTIONS_MAX = 20;

function optionCount(node: FlowNodeInstance): number {
  const count = Number.parseInt(configString(node, "count"), 10);
  if (!Number.isFinite(count) || count < 1) return GENERATE_OPTIONS_DEFAULT;
  return Math.min(count, GENERATE_OPTIONS_MAX);
}

// The host's options call: the list comes back parsed, never split out of
// free text here.
const generateOptions: NodeExecutor = async (node, inputs, context) => {
  const request = await generationRequest(node, inputs, context);
  const body = { ...request, numOptions: optionCount(node) };
  const result = await reported(node, context, request.model, () =>
    context.sandbox.generateOptions("flow", context.flowPath, body, context.signal),
  );
  return { options: { type: "object", value: result.options } };
};

// A pure static text source — no upstream inputs at all, just the typed-in
// config value, its dates filled. See FLOW_NODE_REGISTRY's prompt entry.
const prompt: NodeExecutor = async (node, _inputs, context) => {
  return { text: { type: "text", value: fillDates(configString(node, "text"), context.clock) } };
};

// The card and App Mode only ever store one of the options, so a pick that
// isn't one came from a caller outside the app, or a hand edit. Refused
// rather than passed on: it's a value the form could never have given.
//
// Dates are filled after that check, which compares the text as typed.
const choice: NodeExecutor = async (node, _inputs, context) => {
  const options = choiceOptions(node.config);
  const picked = configString(node, "text");
  if (picked && !options.includes(picked)) {
    throw new Error(`"${picked}" isn't one of this Choice's options: ${options.join(", ") || "it has none"}`);
  }
  return { text: { type: "text", value: fillDates(picked || (options[0] ?? ""), context.clock) } };
};

// The value as stored, never stepped here: an editor moves it on after the
// run, so the run gives the value the card showed when it began.
const int: NodeExecutor = async (node) => {
  const text = configString(node, "value");
  const value = intValue(text);
  if (value === undefined) {
    throw new Error(`"${text}" isn't a whole number from ${Number.MIN_SAFE_INTEGER} to ${Number.MAX_SAFE_INTEGER}`);
  }
  return { int: { type: "number", value } };
};

// The sign stays in front of the zeros, so -7 at three digits is -007. Only a
// whole number pads: a fraction's digits have no count to pad to.
const numberToText: NodeExecutor = async (node, inputs) => {
  const input = inputs.number;
  if (input?.type !== "number") throw new Error("Number to Text has no number connected");
  const digits = numberToTextDigits(node.config);
  if (!Number.isInteger(input.value) || digits === 0) return { text: { type: "text", value: String(input.value) } };
  const sign = input.value < 0 ? "-" : "";
  return { text: { type: "text", value: sign + String(Math.abs(input.value)).padStart(digits, "0") } };
};

// What Write Note and Add to Note check before writing: the note, its text,
// the grant. The markdown check repeats the drop target's, in case the file
// at this path was renamed or replaced since it was dropped in.
async function noteToWrite(
  node: FlowNodeInstance,
  inputs: Record<string, PortValue>,
  context: NodeExecutionContext,
): Promise<{ notePath: string; text: string }> {
  const { path: notePath, wired } = nodePath(node, inputs, context);
  if (!notePath)
    throw new Error(wired ? "Nothing reached its path input" : "Drag the note to write into onto this node");
  if (!isMarkdownFile(notePath)) throw new Error(`"${notePath}" is no longer a markdown note`);
  const text = inputs.text?.type === "text" ? inputs.text.value : undefined;
  if (text === undefined) throw new Error(`${FLOW_NODE_REGISTRY[node.type]?.label} has no text connected`);
  const granted = await context.ensureCapability(writeCapability(notePath, wired));
  if (!granted) throw new Error(`Permission denied to write "${notePath}"`);
  return { notePath, text };
}

const writeNote: NodeExecutor = async (node, inputs, context) => {
  const { notePath, text } = await noteToWrite(node, inputs, context);
  await context.sandbox.write("flow", context.flowPath, notePath, text);
  return { path: outputPath(context, notePath) };
};

// Write Note's write, into a folder under a name. The grant asked is the
// folder's, which covers every note written directly in it; the name is
// repaired into one file name, so a wired one never reaches outside it.
const writeFolderNote: NodeExecutor = async (node, inputs, context) => {
  const { path: folderPath, wired } = nodePath(node, inputs, context);
  if (!folderPath)
    throw new Error(wired ? "Nothing reached its path input" : "Drag the folder to write into onto this node");
  const typed = resolveTextInput(inputs, node, "name", context);
  if (!typed.trim()) throw new Error("Write Folder Note has no name for the note");
  const stem = fileStemFor(typed, /\.md$/i);
  if (!stem) throw new Error(`"${typed}" can't name a note`);
  const text = inputs.text?.type === "text" ? inputs.text.value : undefined;
  if (text === undefined) throw new Error("Write Folder Note has no text connected");
  const granted = await context.ensureCapability(writeCapability(folderPath, wired));
  if (!granted) throw new Error(`Permission denied to write in "${folderPath}"`);
  const folder = resolveDeclaredPath(dirnameOf(context.flowPath), folderPath);
  const name = `${stem}.md`;
  const notePath = formatDeclaredPath({ root: folder.root, path: folder.path ? `${folder.path}/${name}` : name });
  await context.sandbox.write("flow", context.flowPath, notePath, text);
  return { path: outputPath(context, notePath) };
};

const addToNote: NodeExecutor = async (node, inputs, context) => {
  const { notePath, text } = await noteToWrite(node, inputs, context);
  await context.sandbox.addToNote("flow", context.flowPath, notePath, text, affixModeOf(node));
  return { path: outputPath(context, notePath) };
};

// A wired input wins, then what the card's own control holds; a column given
// neither is left out, so the host fills in what a new row gets from the
// Table as it is on disk, not as the canvas last saw it.
const addRow: NodeExecutor = async (node, inputs, context) => {
  const { columns, values } = addRowNodeConfig(node.config);
  const { path: tablePath, wired } = nodePath(node, inputs, context);
  if (!tablePath)
    throw new Error(wired ? "Nothing reached its table_path input" : "Drag the table to add rows to onto this node");
  if (!isTableFile(tablePath)) throw new Error(`"${tablePath}" is no longer a table`);
  const row: Record<string, string> = {};
  for (const column of columns) {
    const input = inputs[column.id];
    if (input) row[column.id] = cellText(input);
    else if (values[column.id]) row[column.id] = fillDates(values[column.id], context.clock);
  }
  const granted = await context.ensureCapability(writeCapability(tablePath, wired));
  if (!granted) throw new Error(`Permission denied to write "${tablePath}"`);
  const { path } = await context.sandbox.addRow("flow", context.flowPath, tablePath, row);
  context.wrote?.(path);
  return { path: outputPath(context, tablePath) };
};

// A canvas annotation, not a computation — no ports, so nothing to read and
// nowhere for a result to go. Still needs an entry here (the runner errors
// on any node type missing one), just one that does nothing. See
// FLOW_NODE_REGISTRY's comment entry.
const comment: NodeExecutor = async () => {
  return {};
};

// `true` resolves connected-or-fallback like the text widgets. Only a wired
// `text` (a plain port, no widget fallback) is affixed to the pick: "Prepend"
// gives text + pick, "Append" pick + text — the position describes what
// happens to `text`, not to the pick.
const toggleText: NodeExecutor = async (node, inputs, context) => {
  const condition = resolveBooleanInput(inputs, node, "true");
  const picked = resolveTextInput(inputs, node, condition ? "on_true" : "on_false", context);
  const source = inputs.text;
  if (source?.type !== "text") return { text: { type: "text", value: picked } };
  const value = affixModeOf(node) === "append" ? picked + source.value : source.value + picked;
  return { text: { type: "text", value } };
};

// Pure passthrough — see FLOW_NODE_REGISTRY's showText entry for why it
// still has an output instead of being a dead-end sink.
const showText: NodeExecutor = async (_node, inputs) => {
  return { text: inputs.text ?? { type: "text", value: "" } };
};

// Same pure passthrough as showText above, for an object port. An
// unconnected input shows `{}` rather than nothing, so the node reads as
// "an empty record" instead of looking like it failed.
const showObject: NodeExecutor = async (_node, inputs) => {
  return { object: inputs.object ?? { type: "object", value: {} } };
};

// Top-level fields only, and a nested one fails rather than being written
// out as JSON: that dump is the object-to-text conversion FlowPortType's
// exact-match rule keeps out of the graph. A missing key names the ones the
// record does have, so a typo takes one read to fix. A slot with no key
// outputs nothing, so a freshly added row can't fail the rest.
const getField: NodeExecutor = async (node, inputs) => {
  const input = inputs.object;
  if (input?.type !== "object") throw new Error("Nothing is connected to its object input");
  const record = input.value;
  if (typeof record !== "object" || record === null || Array.isArray(record)) {
    throw new Error("Its object input isn't a record of fields");
  }
  const outputs: Record<string, PortValue> = {};
  for (let i = 1; i <= GET_FIELD_MAX; i++) {
    const key = configString(node, `field${i}Key`);
    if (!key.trim()) continue;
    if (!Object.hasOwn(record, key)) {
      const keys = Object.keys(record);
      throw new Error(
        keys.length > 0 ? `No field "${key}" (it has ${keys.join(", ")})` : `No field "${key}" (its input is empty)`,
      );
    }
    const value = (record as Record<string, unknown>)[key];
    if (Array.isArray(value)) throw new Error(`Field "${key}" is a list, not a single value`);
    if (typeof value === "object" && value !== null) {
      throw new Error(`Field "${key}" is a group of fields, not a single value`);
    }
    outputs[`field_${i}`] = { type: "text", value: value == null ? "" : String(value) };
  }
  if (Object.keys(outputs).length === 0) throw new Error("Choose a field to read");
  return outputs;
};

// Literal join, no empty-slot filtering — see FLOW_NODE_REGISTRY's
// joinText entry.
const joinText: NodeExecutor = async (node, inputs, context) => {
  const a = resolveTextInput(inputs, node, "text_1", context);
  const b = resolveTextInput(inputs, node, "text_2", context);
  const c = resolveTextInput(inputs, node, "text_3", context);
  const separator = resolveTextInput(inputs, node, "separator", context);
  return { text: { type: "text", value: [a, b, c].join(separator) } };
};

// One pass over `source`, so a slot's value is never read for placeholders:
// a wired note that mentions `{{$date}}` keeps it. A slot fills only with a
// name of word characters and a connected value, the first of a repeated
// name winning, so no slot can take a value the host fills.
const templateVariables: NodeExecutor = async (node, inputs, context) => {
  const source = inputs.source?.type === "text" ? inputs.source.value : "";
  const slots = new Map<string, string>();
  for (let i = 1; i <= TEMPLATE_VARIABLES_MAX; i++) {
    const name = configString(node, `var${i}Name`).trim();
    const value = inputs[`var_${i}`];
    if (/^\w+$/.test(name) && value?.type === "text" && !slots.has(name)) slots.set(name, value.value);
  }
  const dates = dateFill(context.clock);
  const fill = (name: string, format: string | undefined) =>
    (format === undefined ? slots.get(name) : undefined) ?? dates(name, format);
  return { text: { type: "text", value: fillPlaceholders(source, fill) } };
};

// Path math, so it reads nothing and asks for nothing. `base` names a
// document whose folder the path is read from, as a link in it would be, or
// with a trailing `/` that folder itself; a link is written for that folder.
const resolvePath: NodeExecutor = async (node, inputs, context) => {
  const reference = resolveTextInput(inputs, node, "path", context).trim();
  if (!reference) throw new Error("Resolve Path has no path to resolve");
  const baseText = resolveTextInput(inputs, node, "base", context).trim();
  const base = baseText
    ? formatRootedPath(resolveDeclaredPath(dirnameOf(context.flowPath), baseText))
    : context.flowPath;
  const baseDir = baseText.endsWith("/") ? base : dirnameOf(base);
  const target = resolveDeclaredPath(baseDir, reference);
  const folder = reference.endsWith("/");
  if (!resolveBooleanInput(inputs, node, "as_link")) {
    return { path: { type: "text", value: formatRootPath(target, folder) } };
  }
  const link = formatWrittenPath(baseDir, target, { form: "markdown", scopes: await context.scopes(), folder });
  if (link === undefined) throw new Error(`A document in a library can only link inside it, not to "${reference}"`);
  return { path: { type: "text", value: link } };
};

// Named rather than an empty read: a graph run without its document would
// otherwise compute from nothing and look like it worked.
function boundDocument(context: NodeExecutionContext): DocumentPort {
  if (!context.document) {
    throw new Error("No document to act on. Run this flow from a document's Tools tab.");
  }
  return context.document;
}

const currentDocument: NodeExecutor = async (node, _inputs, context) => {
  const document = boundDocument(context);
  // Before the grant: a run about to fail shouldn't ask for anything.
  if (configBoolean(node, "requireSelection") && !document.hasSelection) throw new Error("Select some text first");
  if (!(await context.ensureCapability({ type: "readCurrentDocument" }))) {
    throw new Error("Permission denied to read the open document");
  }
  const { content, selection } = document.read();
  return {
    ...noteOutputs(document.path, content),
    path: { type: "text", value: formatRootPath(parseRootedPath(document.path)) },
    selection: { type: "text", value: selection },
    has_selection: { type: "boolean", value: selection !== "" },
  };
};

// A list wins over a single text when both are wired. Nothing wired is
// refused rather than read as "": replacing with nothing would propose
// deleting the writer's selection.
function replacementsFrom(inputs: Record<string, PortValue>): string[] {
  const options = inputs.options;
  if (options?.type === "object") {
    const list = options.value;
    if (!Array.isArray(list) || !list.length || !list.every((entry) => typeof entry === "string")) {
      throw new Error("Its options input isn't a list of text");
    }
    return list;
  }
  if (inputs.text?.type === "text") return [inputs.text.value];
  throw new Error("Nothing is connected to its text or options input");
}

const replaceSelection: NodeExecutor = async (_node, inputs, context) => {
  const document = boundDocument(context);
  document.replaceSelection(replacementsFrom(inputs));
  return {};
};

// A list shows a line per entry, as Replace Selection steps through one. With
// no button behind the run, the text it passes on is all there is to show.
const showResult: NodeExecutor = async (_node, inputs, context) => {
  const lines = replacementsFrom(inputs);
  context.document?.showResult(lines);
  return { text: { type: "text", value: lines.join("\n\n") } };
};

// The document is read only when a wire takes its selection or text, so a
// Button that hands on just its path asks for nothing. The selection check
// comes before any grant: a click about to stop shouldn't ask.
const button: NodeExecutor = async (node, _inputs, context, wired) => {
  const document = boundDocument(context);
  // Refused rather than run as a no-op: a click that runs nothing would look
  // as if it had worked.
  if (wired?.size === 0) throw new Error("Nothing is wired from it, so a click would run nothing");
  if (configBoolean(node, "requireSelection") && !document.hasSelection) throw new Error("Select some text first");
  const outputs: Record<string, PortValue> = {
    path: { type: "text", value: formatRootPath(parseRootedPath(document.path)) },
  };
  if (wired && !wired.has("selection") && !wired.has("raw")) return outputs;
  if (!(await context.ensureCapability({ type: "readCurrentDocument" }))) {
    throw new Error("Permission denied to read the open document");
  }
  const { content, selection } = document.read();
  outputs.selection = { type: "text", value: selection };
  outputs.raw = { type: "text", value: content };
  return outputs;
};

// With no one looking, as in a run from outside the app, it opens nothing
// and fails nothing: there is nowhere to show the file.
const openToSide: NodeExecutor = async (node, inputs, context) => {
  if (!context.openToSide) return {};
  const { path } = nodePath(node, inputs, context);
  if (!path) throw new Error("Nothing to open: wire a path into it, or drag a file onto it");
  const rooted = resolveDeclaredPath(dirnameOf(context.flowPath), path);
  if (isLibraryRoot(rooted.root)) throw new Error(`"${path}" is in a library, which this node can't reach`);
  await context.openToSide(formatRootedPath(rooted));
  return {};
};

export const NODE_EXECUTORS: Record<string, NodeExecutor> = {
  loadRow,
  loadRandomRow,
  loadTableRows,
  addRow,
  chart,
  loadNote,
  loadFolderNote,
  loadImage,
  loadFolderImage,
  generateText,
  prompt,
  choice,
  int,
  numberToText,
  comment,
  writeNote,
  addToNote,
  writeFolderNote,
  toggleText,
  showText,
  showObject,
  getField,
  joinText,
  resolvePath,
  templateVariables,
  currentDocument,
  replaceSelection,
  showResult,
  button,
  openToSide,
  generateOptions,
  generateImage,
  generateVideo,
  applet,
};
