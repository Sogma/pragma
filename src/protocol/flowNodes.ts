import { ADD_ROW_NODE_TYPE, ADD_ROW_PATH_PORT, addRowPorts } from "./addRowNode.ts";
import type { ModelSettingValue } from "./api.ts";
import { APPLET_NODE_TYPE, appletNodeConfig } from "./appletNode.ts";
import { isDeclaredAddress, isHiddenPath, resolveDeclaredPath } from "./relativeReference.ts";
import { dirnameOf, formatDeclaredPath, parseRootedPath } from "./rootedPath.ts";
import type {
  FlowCapabilityDeclaration,
  FlowGraph,
  FlowNodeInstance,
  FlowPort,
  FlowPortType,
  FlowReadFileCapability,
  FlowSearchContextCapability,
  FlowWriteDocumentCapability,
} from "./types.ts";
import { flowCapabilityKey } from "./types.ts";

/** Whether a node reads or writes the file its path names. */
export type WiredAccess = "read" | "write";

/** What a wired pin may ask for: a read or a write of the file its path
 * names, or the context of the scope its path sits in. */
export type WiredPin = WiredAccess | "context";

/** What a node does with the file its path names: reads or writes it, or
 * only shows it to the person who started the run, which asks for nothing. */
export type PathUse = WiredAccess | "show";

/** Where a node puts the text it adds: before what it adds it to, or after. */
export type AffixMode = "prepend" | "append";

/** The input a wire brings a node's path on, in place of the path its config
 * holds from a drag. The pin is the config key in snake_case, as a built-in
 * port's id is. */
export interface FlowNodePathInput {
  portId: string;
  configKey: string;
  access: PathUse;
  // Whether the path may name a library's file; every other node takes the
  // space's alone.
  library?: true;
}

// Config-field metadata only — enough for the editor to render a plain
// inline control per field, not a full JSON-schema
// validator. "checkbox" fields store "true"/"false" text in config, same
// convention TableColumn's checkbox type already uses for cell values; an
// "integer" field stores a whole number as text too, as `intValue` reads it.
export type FlowNodeConfigFieldType = "text" | "textarea" | "path" | "checkbox" | "integer" | "select";

export interface FlowNodeConfigField {
  key: string;
  label: string;
  type: FlowNodeConfigFieldType;
  // One line for what the label leaves out, shown over the field.
  description?: string;
  // A select field's values in menu order. A blank one shows the first.
  options?: readonly string[];
}

// An input port that's also editable inline when nothing's wired into it —
// see docs/protocol.md's "Ports and types" section. `portId` must name one of
// the type's own `inputs`; the fallback lives in `config[portId]`. The model
// pickers' lists come from the editor's model routes, never from here: this
// file stays isomorphic, no fetch().
export type FlowNodeInputWidgetType = "text" | "select" | "textModel" | "imageModel" | "videoModel" | "checkbox";

export interface FlowNodeInputWidget {
  portId: string;
  type: FlowNodeInputWidgetType;
  // Seeded into a new node's config[portId] when the editor creates it; a
  // widget without one falls back to "", like an unconnected port with no
  // widget.
  defaultValue?: string;
  // A text widget's hint for what an empty field means.
  placeholder?: string;
  // A select widget's values in menu order, "" for the blank one. They
  // guide the pick without limiting it: a wire may bring any other value.
  options?: readonly string[];
}

/** A node's `modelSettings` as a run sends them: each named value a setting
 * can hold, a string, number or switch, and nothing else. */
export function modelSettingValues(raw: unknown): Record<string, ModelSettingValue> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return Object.fromEntries(
    Object.entries(raw).filter(
      ([name, value]) =>
        /^[A-Za-z0-9_]+$/.test(name) &&
        (typeof value === "string" ||
          typeof value === "boolean" ||
          (typeof value === "number" && Number.isFinite(value))),
    ),
  ) as Record<string, ModelSettingValue>;
}

/** What a widget input reads for `value`, stored or wired: a select whose
 * options hold no blank reads a blank as its new-node value, so an older
 * file's blank, or a wire's, still names one of them. */
export function blankAsDefault(type: string, portId: string, value: string): string {
  if (value !== "") return value;
  const widget = FLOW_NODE_REGISTRY[type]?.inputWidgets?.find((each) => each.portId === portId);
  return widget?.type === "select" && !widget.options?.includes("") ? (widget.defaultValue ?? "") : "";
}

// The add-node menu's category order: dataflow, not alphabetical — the kinds
// of value a Flow reads and shapes, then generation, then the open document,
// and the Applet container last, where node editors put groups. A list rather
// than the registry's key order, so declaring a type never moves a category.
export const FLOW_NODE_CATEGORIES = ["Text", "Image", "Video", "Data", "AI", "Editor", "Applets"] as const;

export type FlowNodeCategory = (typeof FLOW_NODE_CATEGORIES)[number];

/** One built-in node type's metadata — pure data; running it is
 * flowExecutors.ts's job. `capabilityFor` is what lets a Flow's capability
 * set be *derived* rather than hand-authored; most node types return
 * undefined. */
export interface FlowNodeTypeDefinition {
  type: string;
  label: string;
  // One line on what the node gives, shown over its title and its add-node
  // row. It is the first line of the type's docs/flow-nodes.md entry, which
  // flowNodeDocs.test.ts holds it to.
  description: string;
  // Groups the type in the editor's add-node menu — display-only, never
  // serialized (a node instance stores only `type`).
  category: FlowNodeCategory;
  // Shown in the node's Properties popover; bump it when the type's behavior
  // changes in a way worth surfacing. No compatibility check reads it.
  version: string;
  inputs: FlowPort[];
  outputs: FlowPort[];
  // Ports a file gives rather than the type — an Applet's manifest, a
  // Table's columns — taken from what the node's config keeps of that file,
  // so a run and the canvas type edges without reading it. Such a type
  // leaves `inputs` and `outputs` empty.
  portsFrom?: (config: Record<string, unknown>) => { inputs: FlowPort[]; outputs: FlowPort[] };
  // Reference image pins among `inputs`, which an editor shows one at a
  // time, as many as the picked model takes. A run reads every one wired.
  referenceSlots?: SlotSpec;
  // Reference clip pins, shown and read as the image ones are.
  videoReferenceSlots?: SlotSpec;
  // Frame pins among `inputs`, by frame. An editor shows one while the picked
  // model takes that frame and the node hasn't removed it, which
  // `config.removedFrames` lists; a wired one always shows, and a run reads it.
  framePorts?: Record<FrameKind, string>;
  configFields: FlowNodeConfigField[];
  // Every key the type's config can hold but its widget inputs' fallbacks,
  // which sit under their port ids: configFields' keys, and those a picker,
  // a drag or the card writes. A key is a wire identifier, as a port id is,
  // and docs/flow-nodes.md's Config lines are checked against this list.
  configKeys: string[];
  inputWidgets?: FlowNodeInputWidget[];
  // `wired` is the node's outputs that have a wire, where the caller knows
  // the graph: a type whose need depends on what it hands on reads it.
  // Without it, the most the node may need is derived.
  capabilityFor?: (
    config: Record<string, unknown>,
    wired?: ReadonlySet<string>,
  ) => FlowCapabilityDeclaration | undefined;
  // The node's path may also arrive on a wire: `inputs` holds the pin, and
  // a wired value wins over `config[configKey]`. The capability it asks for
  // is not derived from config but asked at run time, per resolved path.
  pathInput?: FlowNodePathInput;
  // An input whose wired path sends the files around it with the node's
  // model call (docs/protocol.md, Context of a path), asked for per scope at
  // run time. While it has a wire the node never reuses a result.
  contextPort?: string;
  // A Prepend/Append menu in this input's row, kept as `config.affixMode`.
  // `fallback` is what a blank or unknown one means, to a run and an editor
  // alike; `whileWired` shows the menu only while the input has a wire.
  affix?: { portId: string; fallback: AffixMode; whileWired?: true };
  // A toolkit button: each instance is one when the flow is a toolkit, and a
  // click starts there (flowActions.ts). Part of the type, never the
  // instance, so no saved graph can promote a node to a button.
  action?: boolean;
  // A run may hand back the node's earlier result instead of running it
  // again. "always": the type finds its own earlier results by its inputs,
  // so Regenerate changes `regenerate.key` to ask for another. "optional": a
  // host that remembers runs keeps the last result, and the node's `reuse`
  // turns reuse on. A host offers Regenerate by this flag, never by type name.
  reuse?: "always" | "optional";
  // An "always" type's input that Regenerate moves on, and its next value.
  regenerate?: { key: string; next: (current: string) => string };
  // A config value an editor moves on once a run it started has run the
  // node, to what `next` gives; undefined leaves it. A run started anywhere
  // else moves nothing (docs/protocol.md, Execution).
  afterRun?: { key: string; next: (config: Record<string, unknown>) => string | undefined };
  // Extra add-node search terms beyond the label and type string, which
  // always match — for words someone would search that the label lacks
  // (e.g. "ai"/"llm" for generateText). Display-only, like `category`.
  keywords?: string[];
  // Fallback color for a node of this type, in FlowNodeInstance.color's hex
  // format; an instance's own color always wins. Absent means an uncolored
  // node. The Color menu's "No color" can't remove it — only picking another
  // color overrides it.
  defaultColor?: string;
  // The output that passes on the node's own `config[id]` unchanged, the
  // value a person types or picks. Exposing it makes a form field and a run
  // input, not a result: shown as a result it could only echo the form.
  fieldOutput?: string;
}

// A built-in port is named once: its id, lowercase snake_case, is also the
// label its pin shows, so the two never drift apart. A description goes only
// where the pin's name, its node and its field leave out something a person
// wiring it would get wrong. A tooltip on every pin is one nobody reads.
function builtInPort(id: string, type: FlowPortType, description?: string): FlowPort {
  return { id, type, label: id, ...(description ? { description } : {}) };
}

function textPort(id: string, description?: string): FlowPort {
  return builtInPort(id, "text", description);
}

function imagePort(id: string, description?: string): FlowPort {
  return builtInPort(id, "image", description);
}

function booleanPort(id: string, description?: string): FlowPort {
  return builtInPort(id, "boolean", description);
}

function objectPort(id: string, description?: string): FlowPort {
  return builtInPort(id, "object", description);
}

function numberPort(id: string, description?: string): FlowPort {
  return builtInPort(id, "number", description);
}

function videoPort(id: string, description?: string): FlowPort {
  return builtInPort(id, "video", description);
}

function configString(config: Record<string, unknown>, key: string): string {
  const value = config[key];
  return typeof value === "string" ? value : "";
}

// A path pin is optional and comes first: the node's target, ahead of the
// values it takes. It is `path` on every node that takes one but Add Row,
// whose other pins are its Table's column ids, so a column named `path`
// would lose its pin to it.
const PATH_PORT = "path";

function withPathInput(
  definition: FlowNodeTypeDefinition,
  configKey: string,
  access: PathUse,
  pathDescription?: string,
  library?: true,
): FlowNodeTypeDefinition {
  return {
    ...definition,
    inputs: [{ ...textPort(PATH_PORT, pathDescription), required: false }, ...definition.inputs],
    pathInput: { portId: PATH_PORT, configKey, access, ...(library ? { library } : {}) },
  };
}

/** A type whose numbered ports an editor shows one at a time: Template
 * Variables' inputs, Get Field's outputs and the Generate nodes' reference
 * images. `slotsKey` lists the slots past the `floor` it always shows (the
 * first, or none at 0); `configKey`, where there is one, is a slot's own value. */
export interface SlotSpec {
  slotsKey: string;
  max: number;
  floor?: 0 | 1;
  portId(slot: number): string;
  configKey?(slot: number): string;
}

function slotKeys(spec: SlotSpec): string[] {
  const { configKey } = spec;
  return configKey ? Array.from({ length: spec.max }, (_, index) => configKey(index + 1)) : [];
}

// The frames a video model may take, first and last, by the words the
// model support file and a node's config use for them.
export const FRAME_KINDS = ["start", "end"] as const;
export type FrameKind = (typeof FRAME_KINDS)[number];

// The Generate nodes' reference images: real ports up to the most any model
// takes in the host's model support file, shown one "+" at a time and none
// at first. A port's id is also the mention a prompt names it by, `@image_2`.
export const IMAGE_REFERENCES_MAX = 30;

export const IMAGE_REFERENCE_SLOTS: SlotSpec = {
  slotsKey: "imageSlots",
  max: IMAGE_REFERENCES_MAX,
  floor: 0,
  portId: (slot) => `image_${slot}`,
};

function imageReferencePorts(): FlowPort[] {
  return Array.from({ length: IMAGE_REFERENCES_MAX }, (_, index) => {
    const id = IMAGE_REFERENCE_SLOTS.portId(index + 1);
    return { ...imagePort(id, `The prompt can name it as @${id}.`), required: false };
  });
}

// Generate Video's reference clips, as its reference images are: up to the
// most any model takes in the model support file, one "+" at a time and none
// at first, each named in a prompt by its id, `@video_2`.
export const VIDEO_REFERENCES_MAX = 10;

export const VIDEO_REFERENCE_SLOTS: SlotSpec = {
  slotsKey: "videoSlots",
  max: VIDEO_REFERENCES_MAX,
  floor: 0,
  portId: (slot) => `video_${slot}`,
};

function videoReferencePorts(): FlowPort[] {
  return Array.from({ length: VIDEO_REFERENCES_MAX }, (_, index) => {
    const id = VIDEO_REFERENCE_SLOTS.portId(index + 1);
    return { ...videoPort(id, `The prompt can name it as @${id}.`), required: false };
  });
}

// Shared by loadRow and loadRandomRow, so a graph can swap one for the other.
const ROW_OUTPUTS: FlowPort[] = [
  textPort("selected", "The row's first-column value."),
  objectPort("row", "The whole row, keyed by column label."),
  textPort("path"),
];

/** Reads a table and exposes one selected row — outputs in
 * docs/flow-nodes.md's "loadRow" section. `tablePath` and `selectedValue`
 * are deliberately not `configFields`: the editor renders them as one picker,
 * since changing the table repopulates the row dropdown.
 *
 * The editor relabels `selected` live to the table's first-column name; only
 * the pin's text changes, never the id saved edges reference. */
const loadRow: FlowNodeTypeDefinition = {
  type: "loadRow",
  // "Load" as for every loader here: a persisted space path behind a readFile
  // grant, re-read on every Run, not a one-time read. No "Table": beside
  // "Load Random Row", "Random" is what tells the two apart.
  label: "Load Row",
  description: "One row of a Table, picked on the node.",
  category: "Data",
  keywords: ["csv", "spreadsheet", "row"],
  version: "1.0",
  inputs: [],
  outputs: ROW_OUTPUTS,
  configFields: [],
  configKeys: ["tablePath", "selectedValue"],
  capabilityFor: (config) => {
    const path = configString(config, "tablePath");
    return path ? { type: "readFile", path } : undefined;
  },
};

/** `loadRow` with the row picked at random every Run, weighted by an
 * optional `integer` column — weighting and the uniform fallback are in
 * docs/flow-nodes.md's "loadRandomRow" section. The weight picker lists
 * only `integer` columns. Outputs match `loadRow`'s exactly, so a graph can
 * swap one node for the other without touching anything downstream. */
const loadRandomRow = withPathInput(
  {
    type: "loadRandomRow",
    label: "Load Random Row",
    description: "A row of a Table, picked at random on every run.",
    category: "Data",
    keywords: ["csv", "spreadsheet", "row", "random", "weight", "weighted", "shuffle"],
    version: "1.0",
    inputs: [],
    // The editor relabels "selected" live to the table's first-column name,
    // as it does for loadRow.
    outputs: ROW_OUTPUTS,
    configFields: [],
    configKeys: ["tablePath", "weightColumn"],
    capabilityFor: (config) => {
      const path = configString(config, "tablePath");
      return path ? { type: "readFile", path } : undefined;
    },
  },
  "tablePath",
  "read",
);

/** Every row of a table as one `object` output: a list of records keyed by
 * column label, the shape Load Row's `row` has, so one Get Field reads either. */
const loadTableRows = withPathInput(
  {
    type: "loadTableRows",
    label: "Load Table",
    description: "Every row of a Table.",
    category: "Data",
    keywords: ["csv", "spreadsheet", "rows", "all", "data"],
    version: "1.0",
    inputs: [],
    outputs: [objectPort("rows", "Every row, each keyed by column label."), textPort("path")],
    configFields: [],
    configKeys: ["tablePath"],
    capabilityFor: (config) => {
      const path = configString(config, "tablePath");
      return path ? { type: "readFile", path } : undefined;
    },
  },
  "tablePath",
  "read",
);

/** Draws its rows as a chart, and passes them through as the Show nodes do.
 * Its config is a ChartSpec (types.ts); the editor renders it as pickers over
 * the wired rows' columns rather than as configFields. */
const chart: FlowNodeTypeDefinition = {
  type: "chart",
  label: "Chart",
  description: "Rows, drawn as a chart.",
  category: "Data",
  keywords: ["plot", "graph", "bar", "line", "visualize", "visualise", "display"],
  version: "1.0",
  inputs: [objectPort("rows", "A list of rows, such as Load Table's.")],
  outputs: [objectPort("rows")],
  configFields: [],
  configKeys: ["chartType", "x", "y"],
};

/** An Applet from the space, run in a sandboxed frame on the canvas. Its
 * ports are its file's, so they live in its config, not here; it declares
 * no capability, since everything it gives a run is what it last reported,
 * saved in that same config (appletNode.ts). A placed node shows its
 * Applet's own description in place of this type's. */
const applet: FlowNodeTypeDefinition = {
  type: APPLET_NODE_TYPE,
  label: "Applet",
  description: "An Applet from the space, running in the node.",
  category: "Applets",
  keywords: ["html", "custom", "widget", "view", "3d", "stage"],
  version: "1.0",
  inputs: [],
  outputs: [],
  portsFrom: (config) => appletNodeConfig(config).ports ?? { inputs: [], outputs: [] },
  configFields: [],
  configKeys: ["appletPath", "appletHash", "ports", "state", "outputs"],
};

/** Adds a row to a Table, an input per column (addRowNode.ts). The Table
 * dragged in from the tree gives the columns; a path wired into `table_path`
 * writes the row to another Table with the same column ids. Its pin comes
 * from `portsFrom`, since the rest are the Table's. */
const addRow: FlowNodeTypeDefinition = {
  type: ADD_ROW_NODE_TYPE,
  label: "Add Row",
  description: "One row, added to a Table.",
  category: "Data",
  keywords: ["append", "insert", "log", "record", "save", "store", "write", "csv", "spreadsheet"],
  version: "1.0",
  inputs: [],
  outputs: [],
  portsFrom: addRowPorts,
  pathInput: { portId: ADD_ROW_PATH_PORT, configKey: "tablePath", access: "write" },
  configFields: [],
  configKeys: ["tablePath", "columns", "values"],
  capabilityFor: (config) => {
    const path = configString(config, "tablePath");
    return path ? { type: "writeDocument", path } : undefined;
  },
};

// Write Note's and Add to Note's: a write of the note dragged in.
function noteWriteCapability(config: Record<string, unknown>): FlowCapabilityDeclaration | undefined {
  const path = configString(config, "notePath");
  return path ? { type: "writeDocument", path } : undefined;
}

/** Writes its `text` over a Markdown note — the whole file, frontmatter
 * included, as an Applet's `writeNote` did. The note is dragged in from the
 * tree or named by a path on a wire, which is asked for per file at run
 * time (`wiredCapability`). Its `path` output is what lets a Button, or a
 * node that reads the note back, depend on the write. */
const writeNote = withPathInput(
  {
    type: "writeNote",
    label: "Write Note",
    description: "A text, written over a Markdown note.",
    category: "Text",
    keywords: ["save", "store", "markdown", "md", "file", "output"],
    version: "1.0",
    inputs: [textPort("text", "The note's whole new text, frontmatter included.")],
    outputs: [textPort("path", "A node wired from it runs after the write.")],
    configFields: [],
    configKeys: ["notePath"],
    capabilityFor: noteWriteCapability,
  },
  "notePath",
  "write",
);

/** Adds its `text` to a Markdown note, at the end or where the body starts,
 * as `affixMode` says. The host finds the place and writes under one lock,
 * so the grant is the write alone: the Flow never reads the note. */
const addToNote = withPathInput(
  {
    type: "addToNote",
    label: "Add to Note",
    description: "A text, added to a Markdown note.",
    category: "Text",
    keywords: ["append", "prepend", "insert", "log", "journal", "markdown", "md", "file"],
    version: "1.0",
    inputs: [textPort("text", "Starts on a new line and is added as it is, so a list item brings its own dash.")],
    outputs: [textPort("path", "A node wired from it runs after the write.")],
    configFields: [],
    configKeys: ["notePath", "affixMode"],
    affix: { portId: "text", fallback: "append" },
    capabilityFor: noteWriteCapability,
  },
  "notePath",
  "write",
);

/** Writes its `text` as the note `name` names in a folder: over a note of
 * that name, or a new one. The folder is dragged in or named by a wire, and
 * either way its grant is the folder, which covers every note written
 * directly in it, so a toolkit writing a note per scene is asked once. */
const writeFolderNote = withPathInput(
  {
    type: "writeFolderNote",
    label: "Write Folder Note",
    description: "A text, written as a note in a folder.",
    category: "Text",
    keywords: ["save", "store", "new", "create", "markdown", "md", "file", "output", "folder"],
    version: "1.0",
    inputs: [
      textPort("name", "One file name, never a path, so the note stays in the folder. .md is added."),
      textPort("text", "The note's whole new text, frontmatter included."),
    ],
    outputs: [textPort("path", "The note written. A node wired from it runs after the write.")],
    configFields: [],
    configKeys: ["folderPath"],
    inputWidgets: [{ portId: "name", type: "text" }],
    capabilityFor: (config) => {
      const path = configString(config, "folderPath");
      return path ? { type: "writeDocument", path } : undefined;
    },
  },
  "folderPath",
  "write",
);

// Shared by loadNote, loadFolderNote and currentDocument.
const NOTE_OUTPUTS: FlowPort[] = [
  textPort("title"),
  objectPort("properties", "The frontmatter, parsed: {} when it is missing or invalid."),
  textPort("body", "The text, without the frontmatter or title heading."),
  textPort("raw", "The whole file, as written."),
];

/** Reads a markdown note — outputs in docs/flow-nodes.md's "loadNote"
 * section. Scoped to `.md` although `/api/sandbox/read` returns any file's
 * raw text, since an applet's source is rarely what a prompt wants. The drop
 * target rejects anything else, and the executor re-checks at Run time in
 * case the path changed since. */
const loadNote = withPathInput(
  {
    type: "loadNote",
    label: "Load Note",
    description: "A Markdown note.",
    category: "Text",
    keywords: ["markdown", "md", "file"],
    version: "1.0",
    inputs: [],
    outputs: [...NOTE_OUTPUTS, textPort("path")],
    configFields: [],
    configKeys: ["notePath"],
    capabilityFor: (config) => {
      const path = configString(config, "notePath");
      return path ? { type: "readFile", path } : undefined;
    },
  },
  "notePath",
  "read",
);

/** `loadNote` with the note picked from a dropped folder's dropdown. The
 * capability is the folder, deliberately not `notePath`: keying on the
 * selected note would re-prompt on every pick. One grant covers every child,
 * present or future (docs/protocol.md's "Capabilities and grants" section).
 *
 * Listing the folder needs no grant, since the tree is already visible. Has
 * its own executor: the capability checked is the folder, the file read is
 * `notePath`. */
const loadFolderNote: FlowNodeTypeDefinition = {
  type: "loadFolderNote",
  label: "Load Folder Note",
  description: "A note, picked from a folder.",
  category: "Text",
  keywords: ["markdown", "pick", "dropdown", "scene", "folder"],
  version: "1.0",
  inputs: [],
  outputs: [...NOTE_OUTPUTS, textPort("path", "The picked note, not its folder.")],
  configFields: [],
  configKeys: ["folderPath", "notePath"],
  capabilityFor: (config) => {
    const path = configString(config, "folderPath");
    return path ? { type: "readFile", path } : undefined;
  },
};

// Shared by loadImage and loadFolderImage.
const IMAGE_OUTPUTS: FlowPort[] = [
  imagePort("image"),
  textPort("name", "The file name, without its extension."),
  numberPort("width"),
  numberPort("height"),
  textPort("aspect_ratio", "The nearest common ratio, such as 16:9 or 9:16."),
];

/** Loads one image. An OS pick or drop needs no capability and persists
 * nothing; a tree drag stores `imagePath`, read fresh every Run behind a
 * grant (docs/flow-nodes.md's "loadImage" section). That path may name a
 * library's file, read under the same `readFile` as a space path.
 *
 * Every other picker but Load Video's refuses a non-space path: what sits
 * below its read (a Table's parse, a folder listing, a note's privacy check)
 * resolves space paths only. */
const loadImage = withPathInput(
  {
    type: "loadImage",
    // Renaming a type breaks saved graphs: one naming a type the registry
    // lacks drops that node and its edges silently, and no migration step
    // exists to catch it.
    label: "Load Image",
    description: "One raster image.",
    category: "Image",
    keywords: ["photo", "picture", "upload", "file"],
    version: "1.0",
    inputs: [],
    outputs: [...IMAGE_OUTPUTS, textPort("path", "Blank for an image picked from the computer.")],
    // Optional gives nothing at all when no image is picked, rather than
    // failing, so a Generate it feeds sends no image on that port.
    configFields: [
      {
        key: "optional",
        label: "Optional",
        type: "checkbox",
        description: "With nothing picked, gives no outputs instead of failing.",
      },
    ],
    configKeys: ["imagePath", "optional"],
    capabilityFor: (config) => {
      const path = configString(config, "imagePath");
      return path ? { type: "readFile", path } : undefined;
    },
  },
  "imagePath",
  "read",
  "The image's path in the space or library.",
  true,
);

/** `loadImage` with the image picked from a dropped folder's dropdown —
 * space-only, no OS pick, since "pick from this folder" is the point. Like
 * `loadFolderNote`, it declares the folder rather than `imagePath`, so a new
 * pick never re-prompts, and has its own executor for the same reason. The
 * server's folder-containment check is generic over any folder `readFile`. */
const loadFolderImage: FlowNodeTypeDefinition = {
  type: "loadFolderImage",
  label: "Load Folder Image",
  description: "A raster image, picked from a folder.",
  category: "Image",
  keywords: ["photo", "picture", "pick", "dropdown", "reference", "folder"],
  version: "1.0",
  inputs: [],
  outputs: [...IMAGE_OUTPUTS, textPort("path", "The picked image, not its folder.")],
  configFields: [],
  configKeys: ["folderPath", "imagePath"],
  capabilityFor: (config) => {
    const path = configString(config, "folderPath");
    return path ? { type: "readFile", path } : undefined;
  },
};

/** Loads one clip by reference: its facts and digest, never its bytes, which
 * the host reads only when a node sends the clip on (docs/flow-nodes.md's
 * "loadVideo" section). A tree drag stores `videoPath`, which may name a
 * library's clip as Load Image's may. No pick from the computer: a run's clip
 * has to be a file the host can read. */
const loadVideo = withPathInput(
  {
    type: "loadVideo",
    label: "Load Video",
    description: "One video clip.",
    category: "Video",
    keywords: ["clip", "movie", "footage", "reference", "file"],
    version: "1.0",
    inputs: [],
    outputs: [
      videoPort("video", "The clip, for a node that takes one, such as a video reference."),
      textPort("name", "The file name, without its extension."),
      numberPort("width"),
      numberPort("height"),
      textPort("aspect_ratio", "The nearest common ratio, such as 16:9 or 9:16."),
      numberPort("duration", "In seconds."),
      numberPort("fps", "Frames per second; a variable rate's average."),
      textPort("path"),
    ],
    configFields: [
      {
        key: "optional",
        label: "Optional",
        type: "checkbox",
        description: "With nothing picked, gives no outputs instead of failing.",
      },
    ],
    configKeys: ["videoPath", "optional"],
    capabilityFor: (config) => {
      const path = configString(config, "videoPath");
      return path ? { type: "readFile", path } : undefined;
    },
  },
  "videoPath",
  "read",
  "The clip's path in the space or library.",
  true,
);

// The pin whose wired path sends the files around it with a generation.
const CONTEXT_PORT = "context";

/** The config key of a Generate node's effort, set from its model menu. */
export const EFFORT_KEY = "effort";

// Generate Text's and Generate Options' switch. Its description says inputs
// and settings, never parameters: a value arriving on a wire counts too, and
// an edited note upstream changes it with no setting touched.
const reuseField: FlowNodeConfigField = {
  key: "reuse",
  label: "Reuse result on repeat",
  type: "checkbox",
  description: "Reuse the last result generated when its inputs and settings repeat.",
};

/** Calls the model through the host's generation call
 * (docs/flow-nodes.md's "generateText" section). Each image port's id
 * (`image_1`…) is also the mention text inserted before that image in the
 * model call, so a prompt can name one as `@image_2`.
 *
 * Renaming a port id orphans every saved edge naming it; the run fails such
 * a node rather than dropping the wire unseen. */
const generateText: FlowNodeTypeDefinition = {
  type: "generateText",
  label: "Generate Text (AI)",
  description: "A model's reply to a prompt.",
  category: "AI",
  keywords: ["ai", "llm", "model", "claude"],
  // --color-violet's light-theme value (web/styles/tokens.css): the closest
  // thing pragma's palette has to the industry's de facto "AI" color, reused
  // rather than minted fresh.
  defaultColor: "#7c3aed",
  version: "1.0",
  reuse: "optional",
  inputs: [
    textPort("prompt", "It can name an image as @image_1."),
    {
      ...textPort(CONTEXT_PORT, "A path, such as a Button's: the files around it go with the prompt."),
      required: false,
    },
    ...imageReferencePorts(),
    textPort("model"),
  ],
  outputs: [textPort("text")],
  referenceSlots: IMAGE_REFERENCE_SLOTS,
  configFields: [reuseField],
  configKeys: ["reuse", IMAGE_REFERENCE_SLOTS.slotsKey, EFFORT_KEY],
  inputWidgets: [{ portId: "model", type: "textModel" }],
  capabilityFor: () => ({ type: "generateText" }),
  contextPort: CONTEXT_PORT,
};

// The ten ratios Gemini's image models take, a set most image models share.
// One a model lacks is changed or ignored and the node says so, so the list
// needn't follow the model.
const ASPECT_RATIOS = ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "5:4", "4:5", "21:9"];

// Generate Image's next seed and Int's randomize. Under 2^31, since many
// models take a seed as a signed 32-bit number.
function randomSeed(): string {
  return String(1 + Math.floor(Math.random() * 2_147_483_646));
}

/** Generates an image into a folder dragged onto the node
 * (docs/flow-nodes.md's "generateImage" section). The folder is
 * `config.outputFolderPath`, set by the picker, never a port: a folder on a
 * wire would be a write nothing granted. `prefix` may arrive on a wire
 * because it only starts a file name inside that folder, never a path.
 *
 * A result's name ends in a digest of its inputs, so an unchanged Run finds
 * it instead of paying again; `seed` is how Regenerate changes the inputs.
 * A random id there would pay on every Run. */
const generateImage: FlowNodeTypeDefinition = {
  type: "generateImage",
  label: "Generate Image (AI)",
  description: "An image from an image model, saved into a folder.",
  category: "AI",
  keywords: ["ai", "image", "picture", "illustration", "higgsfield", "art"],
  defaultColor: "#7c3aed",
  version: "1.0",
  reuse: "always",
  inputs: [
    textPort("prompt", "It can name a reference as @image_1."),
    ...imageReferencePorts(),
    textPort("model"),
    textPort("aspect_ratio"),
    textPort("prefix", "The start of the result's file name. Never a path, so it stays in the folder."),
  ],
  outputs: [imagePort("image"), textPort("path"), textPort("file_name", "Without its extension.")],
  referenceSlots: IMAGE_REFERENCE_SLOTS,
  configFields: [
    {
      key: "seed",
      label: "Seed",
      type: "text",
      description: "A number the model draws from. Regenerate picks a new one.",
    },
  ],
  configKeys: ["outputFolderPath", "seed", IMAGE_REFERENCE_SLOTS.slotsKey],
  regenerate: { key: "seed", next: randomSeed },
  inputWidgets: [
    { portId: "model", type: "imageModel" },
    { portId: "aspect_ratio", type: "select", options: ASPECT_RATIOS, defaultValue: "1:1" },
    { portId: "prefix", type: "text", defaultValue: "{{$number}}_{{$date:%y%m%d}}" },
  ],
  capabilityFor: (config) => {
    const path = configString(config, "outputFolderPath");
    return path ? { type: "generateImage", path } : undefined;
  },
};

// The ratios most video models take; one a model lacks is snapped and said.
const VIDEO_ASPECT_RATIOS = ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"];
// The sizes most models name; one a model lacks goes to the nearest it
// lists, and is said.
const VIDEO_RESOLUTIONS = ["480p", "720p", "1080p", "4K"];
// Lengths most models offer, in seconds; another goes to the nearest one.
const VIDEO_DURATIONS = ["3", "4", "5", "6", "8", "10", "12", "15"];

/** Generates a clip into a folder dragged onto the node, as generateImage
 * does an image (docs/flow-nodes.md's "generateVideo" section). The clip
 * leaves by its `path`. No video model takes a seed, so a `take` that never
 * reaches the model names each new result. */
const generateVideo: FlowNodeTypeDefinition = {
  type: "generateVideo",
  label: "Generate Video (AI)",
  description: "A clip from a video model, saved into a folder.",
  category: "AI",
  keywords: ["ai", "video", "clip", "movie", "animation", "higgsfield"],
  defaultColor: "#7c3aed",
  version: "1.0",
  reuse: "always",
  inputs: [
    textPort("prompt", "It can name a reference as @image_1 or @video_1."),
    { ...imagePort("start_frame"), required: false },
    { ...imagePort("end_frame"), required: false },
    ...imageReferencePorts(),
    ...videoReferencePorts(),
    textPort("model"),
    textPort("aspect_ratio"),
    textPort("resolution", "The clip's short side."),
    textPort("duration", "In whole seconds."),
    textPort("prefix", "The start of the clip's file name. Never a path, so it stays in the folder."),
  ],
  outputs: [textPort("path"), textPort("file_name", "Without its extension.")],
  referenceSlots: IMAGE_REFERENCE_SLOTS,
  videoReferenceSlots: VIDEO_REFERENCE_SLOTS,
  framePorts: { start: "start_frame", end: "end_frame" },
  configFields: [
    {
      key: "take",
      label: "Take",
      type: "text",
      description: "Which take of the clip, never sent to the model. Regenerate moves it on.",
    },
  ],
  configKeys: [
    "outputFolderPath",
    "take",
    IMAGE_REFERENCE_SLOTS.slotsKey,
    VIDEO_REFERENCE_SLOTS.slotsKey,
    "removedFrames",
    "modelSettings",
  ],
  regenerate: {
    key: "take",
    next: (current) => String((/^\d+$/.test(current) ? Math.max(1, Number(current)) : 1) + 1),
  },
  inputWidgets: [
    { portId: "model", type: "videoModel" },
    { portId: "aspect_ratio", type: "select", options: VIDEO_ASPECT_RATIOS, defaultValue: "1:1" },
    { portId: "resolution", type: "select", options: VIDEO_RESOLUTIONS, defaultValue: "480p" },
    { portId: "duration", type: "select", options: VIDEO_DURATIONS, defaultValue: "3" },
    { portId: "prefix", type: "text", defaultValue: "{{$number}}_{{$date:%y%m%d}}" },
  ],
  capabilityFor: (config) => {
    const path = configString(config, "outputFolderPath");
    return path ? { type: "generateVideo", path } : undefined;
  },
};

/** A static text source. `configFields` is deliberately empty: `config.text`
 * gets the editor's dedicated card-sized textarea, special-cased on
 * `type === "prompt"`, rather than the generic cramped config textarea. */
const prompt: FlowNodeTypeDefinition = {
  type: "prompt",
  label: "Prompt",
  description: "A fixed text, typed on the node.",
  category: "Text",
  keywords: ["static", "text", "field", "input"],
  version: "1.0",
  inputs: [],
  outputs: [textPort("text")],
  configFields: [],
  configKeys: ["text"],
  fieldOutput: "text",
};

/** One of a fixed list typed into the card, a line each: what a `<select>`
 * with hand-written options gives a form. `config.text` is the pick, and an
 * empty one is the first option, as a dropdown shows with nothing chosen. */
const choice: FlowNodeTypeDefinition = {
  type: "choice",
  label: "Choice",
  description: "One pick from a fixed list.",
  category: "Text",
  keywords: ["select", "dropdown", "options", "pick", "list", "menu", "field", "input"],
  version: "1.0",
  inputs: [],
  outputs: [textPort("text")],
  configFields: [],
  configKeys: ["options", "text"],
  fieldOutput: "text",
};

/** Int's value as a number: blank is 0. Anything but a whole number a
 * JavaScript number holds exactly is none, so a run fails on it rather than
 * rounding it. */
export function intValue(text: string): number | undefined {
  if (text === "") return 0;
  if (!/^-?\d+$/.test(text)) return undefined;
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : undefined;
}

/** `value` moved by `by`, held inside the range `intValue` reads. */
export function stepInt(value: number, by: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, Math.max(Number.MIN_SAFE_INTEGER, value + by));
}

// Int's `control` values, in menu order; blank or any other value is "fixed".
const INT_CONTROLS = ["fixed", "increment", "decrement", "randomize"];

function intAfterRun(config: Record<string, unknown>): string | undefined {
  const value = intValue(configString(config, "value"));
  if (value === undefined) return undefined;
  const control = configString(config, "control");
  if (control === "increment") return String(stepInt(value, 1));
  if (control === "decrement") return String(stepInt(value, -1));
  if (control === "randomize") return randomSeed();
  return undefined;
}

/** A whole number set on the node. A run gives `value` as it finds it, and
 * `afterRun` moves it on afterwards, so the card then shows the value the
 * next run gives. */
const int: FlowNodeTypeDefinition = {
  type: "int",
  label: "Int",
  description: "A whole number, set on the node.",
  category: "Data",
  keywords: ["integer", "number", "whole", "counter", "index", "seed", "random", "increment"],
  version: "1.0",
  inputs: [],
  outputs: [numberPort("int", "The value as the run found it, before it moves on.")],
  configFields: [
    { key: "value", label: "Value", type: "integer" },
    {
      key: "control",
      label: "Control after run",
      type: "select",
      options: INT_CONTROLS,
      description: "How a run from the canvas or App Mode changes the value once it has used it.",
    },
  ],
  configKeys: ["value", "control"],
  afterRun: { key: "value", next: intAfterRun },
};

/** The count of digits Number to Text pads a whole number to: a whole number
 * from 1 to 20, written as text. Blank or anything else pads nothing. */
export function numberToTextDigits(config: Record<string, unknown>): number {
  const text = configString(config, "digits").trim();
  const digits = /^\d+$/.test(text) ? Number(text) : 0;
  return digits >= 1 && digits <= 20 ? digits : 0;
}

/** A number on a text wire, so an Int can count inside a file name or a
 * prompt: edges never convert a type themselves (protocol.md, Ports and
 * types). */
const numberToText: FlowNodeTypeDefinition = {
  type: "numberToText",
  label: "Number to Text",
  description: "A number, written as text.",
  category: "Text",
  keywords: ["convert", "string", "pad", "zeros", "digits", "counter", "int"],
  version: "1.0",
  inputs: [numberPort("number")],
  outputs: [textPort("text")],
  configFields: [
    {
      key: "digits",
      label: "Digits",
      type: "integer",
      description: "Pads a whole number with leading zeros to at least this many digits.",
    },
  ],
  configKeys: ["digits"],
};

/** A canvas annotation: `prompt`'s editable textbox (special-cased on
 * `type === "comment"`, same `config.text`) with no ports. Its executor is a
 * no-op, but it must exist — a run fails any node type without one. */
const comment: FlowNodeTypeDefinition = {
  type: "comment",
  label: "Comment",
  description: "An annotation on the canvas.",
  category: "Text",
  keywords: ["note", "annotation"],
  version: "1.0",
  inputs: [],
  outputs: [],
  configFields: [],
  configKeys: ["text"],
};

/** Picks `on_true` or `on_false` by `true`, then affixes `text` to the pick
 * when it's wired: "Prepend" puts it in front, "Append" behind
 * (docs/flow-nodes.md's "toggleText" section). One node rather than a toggle
 * feeding an affix node, because the two were never used apart.
 *
 * The position select sits in `text`'s port row, shown only while `text` is
 * wired. `true` is a widget input, not a checkbox config field, so a
 * boolean-producing node can drive it. */
const toggleText: FlowNodeTypeDefinition = {
  type: "toggleText",
  label: "Toggle",
  description: "One of two texts, picked by a boolean.",
  category: "Text",
  keywords: ["boolean", "condition", "if", "switch"],
  version: "1.0",
  inputs: [
    booleanPort("true"),
    textPort("on_true"),
    textPort("on_false"),
    textPort("text", "Wired, it goes before or after the pick, as the menu beside it says."),
  ],
  outputs: [textPort("text")],
  configFields: [],
  configKeys: ["affixMode"],
  affix: { portId: "text", fallback: "prepend", whileWired: true },
  inputWidgets: [
    { portId: "true", type: "checkbox" },
    { portId: "on_true", type: "text" },
    { portId: "on_false", type: "text" },
  ],
};

/** Displays its input in a read-only, card-sized textarea with a Copy
 * button, rather than the small result box other nodes get, and passes it
 * through so it can sit mid-chain. */
const showText: FlowNodeTypeDefinition = {
  type: "showText",
  label: "Show Text",
  description: "A text, shown and passed on.",
  category: "Text",
  keywords: ["display", "output", "preview", "result"],
  version: "1.0",
  inputs: [textPort("text")],
  outputs: [textPort("text")],
  configFields: [],
  configKeys: [],
};

/** `showText`'s counterpart for an `object` port — the inspector for what
 * `loadRow`/`loadNote` emit, pretty-printed in the same read-only textbox,
 * with the same passthrough output. */
const showObject: FlowNodeTypeDefinition = {
  type: "showObject",
  label: "Show Object",
  description: "An object, shown and passed on.",
  category: "Data",
  keywords: ["display", "inspect", "debug", "json", "preview"],
  version: "1.0",
  inputs: [objectPort("object")],
  outputs: [objectPort("object")],
  configFields: [],
  configKeys: [],
};

// Get Field's slot ceiling, declared as real ports the way Template
// Variables' are; the editor reveals them one "+" at a time.
export const GET_FIELD_MAX = 10;

export const GET_FIELD_SLOTS: SlotSpec = {
  slotsKey: "fieldSlots",
  max: GET_FIELD_MAX,
  portId: (slot) => `field_${slot}`,
  configKey: (slot) => `field${slot}Key`,
};

function getFieldPorts(): FlowPort[] {
  const ports: FlowPort[] = [];
  for (let i = 1; i <= GET_FIELD_MAX; i++) {
    ports.push(textPort(GET_FIELD_SLOTS.portId(i)));
  }
  return ports;
}

/** Reads top-level fields of an object as text, one per slot — a Load Row's
 * columns by label, a Load Note's properties by key. Slot N's key lives in
 * `config.field{N}Key`, which is what makes numbered ports safe here:
 * renaming a column marks that slot missing and rewires nothing.
 *
 * A missing field fails the node instead of reading as `""`, or a renamed key
 * would feed a blank on unnoticed. */
const getField: FlowNodeTypeDefinition = {
  type: "getField",
  label: "Get Field",
  description: "An object's top-level fields, as text.",
  category: "Data",
  keywords: ["key", "column", "property", "value", "extract", "pick", "row", "record", "fields"],
  version: "1.0",
  inputs: [objectPort("object", "A record, such as Load Row's row or Load Note's properties.")],
  outputs: getFieldPorts(),
  configFields: [],
  configKeys: [...slotKeys(GET_FIELD_SLOTS), GET_FIELD_SLOTS.slotsKey],
};

/** Joins `text_1`…`text_3` with `separator`, literally — an empty slot still
 * contributes an empty segment, never filtered out. Every port is a widget
 * input, so the node works typed-in or wired; `separator`'s non-empty
 * default is seeded into a new node's config, unlike the others' "". */
const joinText: FlowNodeTypeDefinition = {
  type: "joinText",
  label: "Join Text",
  description: "Three texts, joined by a separator.",
  category: "Text",
  keywords: ["concat", "combine", "merge"],
  version: "1.0",
  inputs: [
    textPort("text_1"),
    textPort("text_2"),
    textPort("text_3"),
    textPort("separator", "Goes between each two texts, empty ones included."),
  ],
  outputs: [textPort("text")],
  configFields: [],
  configKeys: [],
  inputWidgets: [
    { portId: "text_1", type: "text" },
    { portId: "text_2", type: "text" },
    { portId: "text_3", type: "text" },
    { portId: "separator", type: "text", defaultValue: ", " },
  ],
};

/** `path` read from the folder of the document `base` names, this Flow when
 * blank: from the root, so what a wire carries names one entry wherever it
 * lands, or with `as_link` as a link inside `base` would write it. It reads
 * nothing, so it declares no capability: the node the path is wired into
 * asks for the file. */
const resolvePath: FlowNodeTypeDefinition = {
  type: "resolvePath",
  label: "Resolve Path",
  description: "A path, read from one document's folder.",
  category: "Text",
  keywords: ["relative", "folder", "beside", "link", "embed", "base", "file", "location", "project"],
  version: "1.0",
  inputs: [
    textPort(
      "base",
      "The document whose folder the path is read from. Blank is this Flow; one ending in / is that folder.",
    ),
    textPort("path", "Read as a link in base would be: a.md beside it, ../a.md above it."),
    booleanPort("as_link", "Gives the path as a link in base would write it, not from the root."),
  ],
  outputs: [textPort("path", "The same entry, from the root, or as a link with as_link.")],
  configFields: [],
  configKeys: [],
  inputWidgets: [
    { portId: "base", type: "text", placeholder: "this Flow" },
    { portId: "path", type: "text", placeholder: "such as ../world/places.md" },
    { portId: "as_link", type: "checkbox" },
  ],
};

// Template Variables' slot ceiling: real ports declared once on the type,
// since the graph model has no per-instance ports. The editor reveals them
// one "+" at a time and can walk them back; an unrevealed slot just sits
// unconnected and unnamed.
export const TEMPLATE_VARIABLES_MAX = 10;

export const TEMPLATE_VARIABLE_SLOTS: SlotSpec = {
  slotsKey: "varSlots",
  max: TEMPLATE_VARIABLES_MAX,
  portId: (slot) => `var_${slot}`,
  configKey: (slot) => `var${slot}Name`,
};

function templateVariablePorts(): FlowPort[] {
  const ports: FlowPort[] = [];
  for (let i = 1; i <= TEMPLATE_VARIABLES_MAX; i++) {
    ports.push(
      textPort(TEMPLATE_VARIABLE_SLOTS.portId(i), "The value for each {{name}} placeholder of this row's name."),
    );
  }
  return ports;
}

/** Splices slot values into `source`'s `{{name}}` placeholders — rules in
 * docs/flow-nodes.md's "templateVariables" section. `source` has no
 * fallback widget, so a graph's static text is authored in one place, a
 * `prompt` upstream.
 *
 * A slot's `config.var{N}Name` labels its pin rather than standing in for its
 * value, so it renders unboxed, in place of the port's own `label`. Names are
 * held to `\w` while typing, the placeholder pattern's name class
 * (datePlaceholders.ts): a wider name would match no placeholder. */
const templateVariables: FlowNodeTypeDefinition = {
  type: "templateVariables",
  label: "Template Variables",
  description: "A text with its {{name}} placeholders filled in.",
  category: "Text",
  keywords: ["substitute", "replace", "mustache", "variable"],
  version: "1.0",
  inputs: [textPort("source"), ...templateVariablePorts()],
  outputs: [textPort("text")],
  configFields: [],
  configKeys: [...slotKeys(TEMPLATE_VARIABLE_SLOTS), TEMPLATE_VARIABLE_SLOTS.slotsKey],
};

/** The document the flow was run from, as it stood when the run began: the
 * same four outputs `loadNote` gives, plus its address and what was
 * selected. Which document is never in the graph — a toolkit button binds it
 * — so the capability carries no path, and a run with no document bound
 * fails here.
 *
 * With `requireSelection` it also fails when nothing was selected; being a
 * source, it fails before anything downstream runs, so a button that needs a
 * selection costs no model call without one. */
const currentDocument: FlowNodeTypeDefinition = {
  type: "currentDocument",
  label: "Current Document",
  description: "The document the run is bound to.",
  category: "Editor",
  keywords: ["selection", "open", "active", "editor", "toolkit"],
  version: "1.0",
  inputs: [],
  outputs: [...NOTE_OUTPUTS, textPort("path"), textPort("selection"), booleanPort("has_selection")],
  configFields: [
    {
      key: "requireSelection",
      label: "Require a selection",
      type: "checkbox",
      description: "Fail the run when nothing is selected, before anything else runs.",
    },
  ],
  configKeys: ["requireSelection"],
  capabilityFor: () => ({ type: "readCurrentDocument" }),
};

/** Proposes its input in place of the selection the run started with, drawn
 * over the document for the writer to accept or reject; given `options`, the
 * writer steps through them and accepts one. Declares nothing: the writer's
 * accept is the consent, as a pick in a host-rendered picker is. An ending:
 * where a click's text goes. */
const replaceSelection: FlowNodeTypeDefinition = {
  type: "replaceSelection",
  label: "Replace Selection",
  description: "A text, proposed in place of the selection.",
  category: "Editor",
  keywords: ["write", "edit", "rewrite", "toolkit", "button", "action", "alternatives"],
  version: "1.0",
  inputs: [
    { ...textPort("text"), required: false },
    { ...objectPort("options", "Alternatives to step through, keeping one. Wins over text."), required: false },
  ],
  outputs: [],
  configFields: [],
  configKeys: [],
};

/** Shows its input where the run started: under the button when a toolkit
 * started it, on its card on the canvas. Passes it on as `text`, so a run
 * from outside the app gets it as an exposed output. An ending. */
const showResult: FlowNodeTypeDefinition = {
  type: "showResult",
  label: "Show Result",
  description: "A text, shown where the run started.",
  category: "Editor",
  keywords: ["display", "output", "result", "summary", "toolkit", "button", "action"],
  version: "1.0",
  inputs: [
    { ...textPort("text"), required: false },
    { ...objectPort("options", "A list, shown a line each. Wins over text."), required: false },
  ],
  outputs: [textPort("text", "What it showed, its lines joined by blank lines.")],
  configFields: [],
  configKeys: [],
};

/** Where a toolkit click starts: each instance is a button, and a click runs
 * it before anything else, then what its wires reach and what those need.
 * It hands on the document the click was made in. Only `selection` and
 * `raw` read it, so a Button that passes on just its path asks for nothing. */
const button: FlowNodeTypeDefinition = {
  type: "button",
  label: "Button",
  description: "Where a toolkit click starts, in the document it was clicked in.",
  category: "Editor",
  keywords: ["trigger", "run", "click", "press", "action", "toolkit", "start", "selection"],
  version: "2.0",
  inputs: [],
  outputs: [textPort("selection"), ...NOTE_OUTPUTS.filter((port) => port.id === "raw"), textPort("path")],
  configFields: [
    {
      key: "requireSelection",
      label: "Require a selection",
      type: "checkbox",
      description: "Stop the click when nothing is selected, before anything else runs.",
    },
  ],
  configKeys: ["requireSelection"],
  capabilityFor: (_config, wired) =>
    !wired || wired.has("selection") || wired.has("raw") ? { type: "readCurrentDocument" } : undefined,
  action: true,
};

/** Opens a file in the editor group beside the document the run is bound
 * to, never in its place and without taking focus, so the run goes on. It
 * only shows the file and nothing reaches the Flow, so its path, wired or
 * dragged, asks for no grant. An ending. */
const openToSide = withPathInput(
  {
    type: "openToSide",
    label: "Open to the Side",
    description: "A file, opened beside the document the run is bound to.",
    category: "Editor",
    keywords: ["open", "show", "beside", "side", "split", "group", "tab", "view"],
    version: "1.0",
    inputs: [],
    outputs: [],
    configFields: [],
    configKeys: ["documentPath"],
  },
  "documentPath",
  "show",
);

/** `generateText`'s list form: the host's options call, which asks the
 * model for a JSON array and parses it, so `options` is a list of text,
 * never free text split apart. `count` is how many to ask for. */
const generateOptions: FlowNodeTypeDefinition = {
  type: "generateOptions",
  label: "Generate Options (AI)",
  description: "A list of alternatives from a model.",
  category: "AI",
  keywords: ["ai", "llm", "model", "claude", "alternatives", "list", "choices", "variations"],
  defaultColor: "#7c3aed",
  version: "1.0",
  reuse: "optional",
  inputs: generateText.inputs,
  outputs: [objectPort("options")],
  referenceSlots: IMAGE_REFERENCE_SLOTS,
  configFields: [
    { key: "count", label: "How many", type: "text", description: "How many to ask for: 10 by default, at most 20." },
    reuseField,
  ],
  configKeys: ["count", "reuse", IMAGE_REFERENCE_SLOTS.slotsKey, EFFORT_KEY],
  inputWidgets: [{ portId: "model", type: "textModel" }],
  capabilityFor: () => ({ type: "generateText" }),
  contextPort: CONTEXT_PORT,
};

export const FLOW_NODE_REGISTRY: Record<string, FlowNodeTypeDefinition> = {
  loadRow,
  loadRandomRow,
  loadTableRows,
  addRow,
  chart,
  loadNote,
  loadFolderNote,
  loadImage,
  loadFolderImage,
  loadVideo,
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

/** Where a node with an affix menu puts its text: its stored `affixMode`, or
 * its type's fallback for a blank or unknown one. */
export function affixModeOf(node: FlowNodeInstance): AffixMode {
  const stored = node.config.affixMode;
  if (stored === "prepend" || stored === "append") return stored;
  return FLOW_NODE_REGISTRY[node.type]?.affix?.fallback ?? "prepend";
}

/** Moves a node's regenerate input on, so its next run asks for a new result
 * rather than finding the last one; false for a type that has none. */
export function moveOnForRegenerate(node: FlowNodeInstance): boolean {
  const moveOn = FLOW_NODE_REGISTRY[node.type]?.regenerate;
  if (!moveOn) return false;
  node.config[moveOn.key] = moveOn.next(configString(node.config, moveOn.key));
  return true;
}

/** Moves a node's value on once a run an editor started has run it, as its
 * type's `afterRun` says; false when the value stays. */
export function moveOnAfterRun(node: FlowNodeInstance): boolean {
  const afterRun = FLOW_NODE_REGISTRY[node.type]?.afterRun;
  const next = afterRun?.next(node.config);
  if (!afterRun || next === undefined || next === node.config[afterRun.key]) return false;
  node.config[afterRun.key] = next;
  return true;
}

/** Whether exposing `portId` on this node makes a form field rather than a
 * result (FlowNodeTypeDefinition.fieldOutput). */
export function isFieldOutput(node: FlowNodeInstance, portId: string): boolean {
  return FLOW_NODE_REGISTRY[node.type]?.fieldOutput === portId;
}

/** A Choice node's options: its lines, trimmed, blank and repeated ones
 * dropped, since a dropdown can't tell two equal values apart. */
export function choiceOptions(config: Record<string, unknown>): string[] {
  const lines = configString(config, "options")
    .split("\n")
    .map((line) => line.trim());
  return [...new Set(lines.filter((line) => line !== ""))];
}

/** A node's ports: its type's, or those its config keeps of the file it
 * names, as the editor last read them. */
export function nodePorts(node: FlowNodeInstance): { inputs: FlowPort[]; outputs: FlowPort[] } {
  const definition = FLOW_NODE_REGISTRY[node.type];
  if (definition?.portsFrom) return definition.portsFrom(node.config);
  return { inputs: definition?.inputs ?? [], outputs: definition?.outputs ?? [] };
}

/** A capability as it is granted and shown: its path, if it has one,
 * resolved from the folder of the Flow at `flowPath` to the address it
 * names, so every spelling of one path asks once. Throws, naming why, for a
 * path that names nothing. */
export function resolveFlowCapability(
  capability: FlowCapabilityDeclaration,
  flowPath: string,
): FlowCapabilityDeclaration {
  if (!("path" in capability)) return capability;
  return { ...capability, path: formatDeclaredPath(resolveDeclaredPath(dirnameOf(flowPath), capability.path)) };
}

/** The nodes a run leaves out (docs/protocol.md, Execution): each disabled
 * node, and every node wired downstream of one however far, each mapped to
 * the disabled node it traces back to, a disabled node to itself. */
export function nodesLeftOut(graph: FlowGraph): Map<string, string> {
  const nodeIds = new Set(graph.nodes.map((node) => node.id));
  const leftOut = new Map<string, string>();
  const pending: string[] = [];
  for (const node of graph.nodes) {
    if (node.mode !== "disabled") continue;
    leftOut.set(node.id, node.id);
    pending.push(node.id);
  }
  for (let id = pending.shift(); id !== undefined; id = pending.shift()) {
    const root = leftOut.get(id) ?? id;
    for (const edge of graph.edges) {
      if (edge.source !== id || leftOut.has(edge.target) || !nodeIds.has(edge.target)) continue;
      leftOut.set(edge.target, root);
      pending.push(edge.target);
    }
  }
  return leftOut;
}

/** Whether a wire from `source` into `target` would close a loop: `target`
 * already feeds `source`, however far, or is `source` itself. A run never
 * starts a node in a loop (docs/protocol.md, Run order and failure), so an
 * editor refuses the wire. */
export function closesLoop(graph: FlowGraph, source: string, target: string): boolean {
  const reached = new Set([target]);
  const pending = [target];
  for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
    if (id === source) return true;
    for (const edge of graph.edges) {
      if (edge.source !== id || reached.has(edge.target)) continue;
      reached.add(edge.target);
      pending.push(edge.target);
    }
  }
  return false;
}

/** Derives a Flow graph's capability set from its nodes' config, resolved
 * and deduped by key — a Flow never declares one (docs/protocol.md's
 * "Capabilities and grants" section). A path that names nothing asks for
 * nothing: its node fails with why when it runs. A node a run leaves out
 * asks for nothing either. */
export function computeFlowCapabilities(graph: FlowGraph, flowPath: string): FlowCapabilityDeclaration[] {
  const byKey = new Map<string, FlowCapabilityDeclaration>();
  const leftOut = nodesLeftOut(graph);
  const wired = wiredOutputs(graph);
  for (const node of graph.nodes) {
    if (leftOut.has(node.id)) continue;
    const declared = FLOW_NODE_REGISTRY[node.type]?.capabilityFor?.(node.config, wired.get(node.id) ?? new Set());
    if (!declared) continue;
    let capability: FlowCapabilityDeclaration;
    try {
      capability = resolveFlowCapability(declared, flowPath);
    } catch {
      continue;
    }
    byKey.set(flowCapabilityKey(capability), capability);
  }
  return Array.from(byKey.values());
}

/** What the graph's wired path pins may ask for: a read, a write, a
 * context, or several. Only a pin with a wire into it counts, so a Flow that
 * wires nothing can't be asked for a path no one chose, and only on a node a
 * run doesn't leave out. */
export function wiredPathAccess(graph: FlowGraph): Set<WiredPin> {
  const access = new Set<WiredPin>();
  const leftOut = nodesLeftOut(graph);
  const wiredInto = (nodeId: string, portId: string) =>
    graph.edges.some((edge) => edge.target === nodeId && edge.targetPort === portId);
  for (const node of graph.nodes) {
    if (leftOut.has(node.id)) continue;
    const definition = FLOW_NODE_REGISTRY[node.type];
    const spec = definition?.pathInput;
    if (spec && spec.access !== "show" && wiredInto(node.id, spec.portId)) access.add(spec.access);
    if (definition?.contextPort && wiredInto(node.id, definition.contextPort)) access.add("context");
  }
  return access;
}

/** Each node's outputs that have a wire, by node id. */
export function wiredOutputs(graph: FlowGraph): Map<string, Set<string>> {
  const wired = new Map<string, Set<string>>();
  for (const edge of graph.edges) {
    const ports = wired.get(edge.source) ?? new Set<string>();
    ports.add(edge.sourcePort);
    wired.set(edge.source, ports);
  }
  return wired;
}

type WiredCapability = FlowReadFileCapability | FlowWriteDocumentCapability | FlowSearchContextCapability;

const WIRED_KEY_TYPES: Record<string, WiredPin> = {
  readFile: "read",
  writeDocument: "write",
  searchContext: "context",
};

/** The capability a wire's path asks for, or undefined when a wire may not
 * ask for it: the graph wires no such pin, or the path isn't an address in
 * its one spelling (a run resolves a wire's text before it asks), or it
 * names a hidden entry. Each path is its own key, so a grant for one file
 * says nothing about another.
 *
 * A context's path is its scope's folder, which is always in the space. */
export function wiredCapability(
  access: ReadonlySet<WiredPin>,
  kind: WiredPin,
  path: string,
): WiredCapability | undefined {
  if (!access.has(kind) || !isDeclaredAddress(path)) return undefined;
  const rooted = parseRootedPath(path);
  if (isHiddenPath(rooted.path)) return undefined;
  if (kind === "context") return rooted.root === "space" ? { type: "searchContext", path } : undefined;
  if (kind === "write") return { type: "writeDocument", path };
  return { type: "readFile", path };
}

/** `wiredCapability` for a key as it is granted: `readFile:<address>`,
 * `writeDocument:<address>` or `searchContext:<address>`. */
export function wiredCapabilityOfKey(access: ReadonlySet<WiredPin>, key: string): WiredCapability | undefined {
  const colon = key.indexOf(":");
  if (colon === -1) return undefined;
  const type = key.slice(0, colon);
  const kind = Object.hasOwn(WIRED_KEY_TYPES, type) ? WIRED_KEY_TYPES[type] : undefined;
  const capability = kind && wiredCapability(access, kind, key.slice(colon + 1));
  return capability && flowCapabilityKey(capability) === key ? capability : undefined;
}

/** What a Flow's Permissions lists: the capabilities its config derives,
 * then the wired paths a person has allowed that its wires could use now.
 * A wired grant is no declaration, so without these rows it could be neither
 * seen nor revoked. */
export function flowPermissionRows(
  graph: FlowGraph,
  granted: Iterable<string>,
  flowPath: string,
): FlowCapabilityDeclaration[] {
  const rows = computeFlowCapabilities(graph, flowPath);
  const listed = new Set(rows.map(flowCapabilityKey));
  const access = wiredPathAccess(graph);
  for (const key of granted) {
    const capability = listed.has(key) ? undefined : wiredCapabilityOfKey(access, key);
    if (capability) rows.push(capability.type === "searchContext" ? capability : { ...capability, wired: true });
  }
  return rows;
}
