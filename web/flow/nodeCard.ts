// A node's card on the canvas — everything inside the card element. The
// canvas (xyflowAdapter.ts) positions, drags, measures, and connects the
// cards, and supplies through deps the few things a card needs from it.
// The per-node registrations a run and an edge change consult live here
// too, keyed by node id (and port id where a node has several).
import { Compartment, EditorState, RangeSetBuilder } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, placeholder, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import type { HandleType as XYHandleType } from "@xyflow/system";
import { minimalSetup } from "codemirror";
import {
  ADD_ROW_NODE_TYPE,
  ADD_ROW_PATH_PORT,
  addRowColumns,
  addRowNodeConfig,
} from "../../src/protocol/addRowNode.ts";
import { APPLET_NODE_TYPE } from "../../src/protocol/appletNode.ts";
import { placeholderPattern } from "../../src/protocol/datePlaceholders.ts";
import type { PortValue } from "../../src/protocol/flowExecutors.ts";
import {
  affixModeOf,
  choiceOptions,
  FLOW_NODE_REGISTRY,
  type FlowNodeConfigField,
  type FlowNodeInputWidget,
  FRAME_KINDS,
  type FrameKind,
  GET_FIELD_SLOTS,
  nodePorts,
  type SlotSpec,
  TEMPLATE_VARIABLE_SLOTS,
} from "../../src/protocol/flowNodes.ts";
import { missingPortIds } from "../../src/protocol/flowProblems.ts";
import { referenceMentions } from "../../src/protocol/referenceMentions.ts";
import type { SetupNeed } from "../../src/protocol/setupNeed.ts";
import {
  type AppletManifest,
  chartSpecFrom,
  type FlowCapabilityDeclaration,
  type FlowEdgeInstance,
  type FlowGraph,
  type FlowNodeInstance,
  type FlowPort,
  type FlowPortType,
  holdsPath,
  noFileAt,
  type TableColumn,
} from "../../src/protocol/types.ts";
import { type ChartView, createChartView } from "../chart/chartView.ts";
import { openColorPicker } from "../colorPicker.ts";
import type {
  AppletFileResponse,
  AppletImportSource,
  FileResponse,
  SandboxReadResult,
  SpaceTreeNode,
} from "../core/apiClient.ts";
import { type Disposable, toDisposable } from "../lib/disposable.ts";
import { buildCopyButton } from "../lib/dom.ts";
import { createInlineError } from "../lib/inlineError.ts";
import type { ModelKind } from "../lib/modelPicker.ts";
import { selectedTextMark } from "../lib/selection.ts";
import { checkSpelling } from "../lib/spellcheck.ts";
import { createWrappingField } from "../lib/wrappingField.ts";
import type { ContextMenuService, MenuItem } from "../services/menus.ts";
import { spellcheck } from "../services/settings.ts";
import { type AppletFrame, createAppletFrame, runInputs } from "./appletFrame.ts";
import { placeExposedNode } from "./appMode.ts";
import {
  appendSelectOptions,
  applyNodeColor,
  createIntStepper,
  createSelectControl,
  createSelectPicker,
  skippedText,
} from "./controls.ts";
import type { FlowMenus } from "./flowMenus.ts";
import { effortFieldOf, type ModelFields, modelKindOf } from "./modelOptions.ts";
import {
  type AddRowPicker,
  type ClipPicker,
  createPickers,
  type FieldPicker,
  type GenerationView,
  type PathPicker,
} from "./pickers.ts";
import {
  attachPlaceholderSuggestions,
  dateChoices,
  promptChoices,
  promptPins,
  promptSuggestions,
} from "./placeholderSuggestions.ts";

export const NODE_WIDTH = 240;
// An Applet brings its own interface, which needs the room.
const APPLET_NODE_WIDTH = 720;

function defaultWidth(flowNode: FlowNodeInstance): number {
  return flowNode.type === APPLET_NODE_TYPE ? APPLET_NODE_WIDTH : NODE_WIDTH;
}

// The nodes whose `path` output, the file they read, sits beside that file
// on the card. A writer's `path` stays among its outputs.
const LOADER_TYPES = new Set([
  "loadRow",
  "loadRandomRow",
  "loadTableRows",
  "loadNote",
  "loadFolderNote",
  "loadImage",
  "loadFolderImage",
  "loadVideo",
]);

// A pin's row, built among the ports, and its port, for moving it beside
// the file the node names.
interface PlacedPin {
  port: FlowPort;
  row: HTMLDivElement;
}

// A slotted node's wire identifiers are the registry's, revealed one "+" at
// a time; a removal clears the slot's `configKey`, where it has one. The card
// adds the noun its buttons call a slot.
interface SlotView extends SlotSpec {
  noun: string;
  // The dataset key a row carries its slot under: two kinds of slot share
  // one container on a Generate Video, and each counts only its own rows.
  rowKey?: "slot" | "videoSlot";
}

// One thing a slotted node's "+" can add, as its menu would name it.
interface AddChoice {
  label: string;
  frame?: boolean;
  add(): void;
}

const FRAME_LABELS: Record<FrameKind, string> = { start: "Start frame", end: "End frame" };

const TEMPLATE_VARIABLE_VIEW: SlotView = { ...TEMPLATE_VARIABLE_SLOTS, noun: "variable" };
const GET_FIELD_VIEW: SlotView = { ...GET_FIELD_SLOTS, noun: "field" };
export const MIN_NODE_WIDTH = 160;

// The `.collapsed` class does the hiding in CSS; this handles what CSS
// can't. An explicit inline width/height would keep a collapsed card at its
// full footprint with nothing inside, so collapsing clears both (the card
// shrinks to a pill of its title bar) and expanding restores the persisted
// size, mirroring how the card is sized at build.
//
// The open width stays on as a property for the caption (nodes.css).
function applyCollapsedState(flowNode: FlowNodeInstance, el: HTMLDivElement, toggleEl: HTMLElement): void {
  el.classList.toggle("collapsed", !!flowNode.collapsed);
  toggleEl.dataset.tooltip = flowNode.collapsed ? "Expand" : "Collapse";
  if (flowNode.collapsed) {
    el.style.setProperty("--flow-node-open-width", `${flowNode.size?.width ?? defaultWidth(flowNode)}px`);
    el.style.width = "";
    setCardHeight(el, undefined);
  } else {
    el.style.removeProperty("--flow-node-open-width");
    el.style.width = `${flowNode.size?.width ?? defaultWidth(flowNode)}px`;
    if (flowNode.size) setCardHeight(el, flowNode.size.height);
  }
}

// A card's own height is a floor, not its exact height. Set exactly, a card
// shorter than its content (dragged there, or saved before its type gained a
// pin) spills its pin rows out below its border.
//
// is-sized says the card has one: the image picker fits its picture inside
// it, where a card hugging its content grows to the picture instead.
function setCardHeight(el: HTMLDivElement, height: number | undefined): void {
  el.style.minHeight = height === undefined ? "" : `${height}px`;
  el.classList.toggle("is-sized", height !== undefined);
}

// Two mention vocabularies a Prompt's or Comment's text can reference, each
// highlighted as a live chip. A mention, `@image_2`, takes the scan a run
// reads it with (referenceMentions.ts), so a chip marks exactly the pins a
// Generate node would read.
//
// A placeholder, `{{name}}` or `{{$date:%B %-d}}`, takes the pattern that
// fills it (datePlaceholders.ts), so a chip marks exactly what a run or a
// Template Variables could fill and never less.
const TEMPLATE_VARIABLE_PATTERN = placeholderPattern();

function buildMentionDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const { from, to } of view.visibleRanges) {
    const text = view.state.doc.sliceString(from, to);
    // Two independent scans over the same range, merged and sorted before
    // adding — RangeSetBuilder requires strictly increasing positions, which
    // one matchAll pass gets for free but combining two doesn't.
    const matches: { start: number; end: number; className: string }[] = [];
    for (const kind of ["image", "video"] as const) {
      for (const mention of referenceMentions(text, kind)) {
        const className = kind === "image" ? "cm-image-mention" : "cm-video-mention";
        matches.push({ start: from + mention.start, end: from + mention.end, className });
      }
    }
    for (const match of text.matchAll(TEMPLATE_VARIABLE_PATTERN)) {
      const start = from + (match.index ?? 0);
      matches.push({ start, end: start + match[0].length, className: "cm-variable-mention" });
    }
    matches.sort((a, b) => a.start - b.start);
    // A mention or a variable names something, so the spellchecker skips it.
    for (const { start, end, className } of matches) {
      builder.add(start, end, Decoration.mark({ class: className, attributes: { spellcheck: "false" } }));
    }
  }
  return builder.finish();
}

const mentionHighlighter = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildMentionDecorations(view);
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = buildMentionDecorations(update.view);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

export interface NodeCardDeps {
  // The live graph — read fresh, since the view replaces it on clear.
  graph(): FlowGraph;
  persistGraph(): void;
  saveGraphNow(): Promise<boolean>;
  ensureCapability(capability: FlowCapabilityDeclaration): Promise<boolean>;
  read(targetPath: string): Promise<SandboxReadResult | undefined>;
  pickedImages: Map<string, { mediaType: string; data: string; name: string }>;
  directoryChildren(dirPath: string): SpaceTreeNode[] | undefined;
  // The open Flow's path, which every path a node stores is read from.
  flowPath(): string;
  modelFields: ModelFields;
  // The menu a select widget's picker opens.
  contextMenu: ContextMenuService;
  // Regenerate: the node alone, on its last inputs.
  regenerate(nodeId: string): void;
  zoom(): number;
  // A left-drag from a pin starts drawing a connection on the canvas.
  startConnection(event: MouseEvent, nodeId: string, handleId: string, type: XYHandleType, el: HTMLElement): void;
  // The card's size changed (collapse, resize, a row added or removed):
  // re-measure it and redraw its edges.
  onLayoutChange(nodeId: string): void;
  // A card's right-click menus: its title bar, a pin, a field, a Load chip.
  menus: Pick<FlowMenus, "openNodeMenu" | "openHandleMenu" | "openExposeMenu" | "openChipMenu">;
  // A locked Flow takes no edits, so a missing pin offers none.
  locked(): boolean;
  // A file a node names, read from the Flow's folder: an Applet node's, an
  // Add Row's Table. Then an Applet frame's markup with the node client.
  loadFile(stored: string): Promise<FileResponse>;
  injectAppletRuntime(
    html: string,
    manifest: AppletManifest,
    imports: readonly AppletImportSource[],
    state: unknown,
  ): string;
  // Rebuilds a node's card, as when its ports change.
  remount(nodeId: string): void;
  // A file the node names that its card found gone, in the run's words, or
  // found again: counted with the Flow's problems.
  fileMissing(nodeId: string, message: string | undefined): void;
  // A Generate node's result file, by tree path, previewed over the pane.
  previewResult(path: string): void;
}

/** Marks each card with what a run does with it (nodesLeftOut): a disabled
 * one greyed with its tag, one a disabled node feeds dimmed (nodes.css). */
export function markLeftOut(cards: ReadonlyMap<string, HTMLElement>, leftOut: ReadonlyMap<string, string>): void {
  for (const [id, el] of cards) {
    const disabledBy = leftOut.get(id);
    el.classList.toggle("disabled", disabledBy === id);
    el.classList.toggle("skipped", disabledBy !== undefined && disabledBy !== id);
  }
}

export interface NodeRunOutcome {
  outputs: Map<string, Record<string, PortValue | undefined>>;
  errors: Map<string, string>;
  // What a failed node needs set up (RunResult.needs).
  needs?: Map<string, SetupNeed>;
  // Nodes left out for a disabled node, by that node (RunResult.skipped).
  skipped?: Map<string, string>;
  // What a node reported that isn't an output (NodeExecutionContext.report).
  reports?: Map<string, string[]>;
}

// A reusing node's held result on its card.
interface HeldView {
  // Shows or hides it as the node's `reuse` now reads.
  sync(): void;
  show(outputs: Record<string, PortValue | undefined> | undefined, lines: string[]): void;
}

// A held result as a card shows it: the reply, or a list one entry a line.
function heldText(node: FlowNodeInstance, outputs: Record<string, PortValue | undefined> | undefined): string {
  const value = outputs?.[nodePorts(node).outputs[0]?.id ?? ""];
  if (value?.type === "text") return value.value;
  if (value?.type === "object" && Array.isArray(value.value)) return value.value.join("\n");
  return value?.type === "object" ? JSON.stringify(value.value, null, 2) : "";
}

export interface NodeCards {
  // The card for a node, sized and collapsed as persisted, not yet placed.
  build(flowNode: FlowNodeInstance): HTMLDivElement;
  // A card is built as if unwired — every widget input showing, every
  // source-dependent field hidden — so a node with edges needs this once
  // mounted.
  syncWiring(flowNode: FlowNodeInstance): void;
  updateInputWidgetVisibility(nodeId: string, portId: string): void;
  updateOutputHandleVisibility(nodeId: string, portId: string): void;
  updateSourceDependents(nodeId: string): void;
  // Before a run: every result box hidden, every result textbox emptied.
  // Every node's run state, or only these nodes'.
  clearRunState(only?: readonly string[]): void;
  // Each result textbox from its one output, each chart from its rows, each
  // error box from its node's failure. Every node's, or only these nodes'.
  showRunResult(outcome: NodeRunOutcome, only?: readonly string[]): void;
  // Drops a removed node's registrations.
  forget(nodeId: string): void;
  clear(): void;
}

export function createNodeCards(deps: NodeCardDeps): NodeCards {
  const resultEls = new Map<string, HTMLDivElement>();
  // The dedicated textbox area on a prompt (editable) or showText
  // (read-only) card, keyed by node id — populated on Run for showText
  // (run()'s result loop writes into it instead of the generic resultEl
  // above), populated at mount time from config.text for prompt.
  const textboxEls = new Map<string, HTMLTextAreaElement>();
  // Widget inputs' fallback controls (see FlowNodeInputWidget in
  // flowNodes.ts), keyed by `${nodeId}:${portId}` — a node can have more
  // than one (toggleText has two), so nodeId alone isn't enough. Hidden
  // once something is wired into the port it backs.
  const inputWidgetEls = new Map<string, HTMLElement>();
  // The picker holding a path pin, keyed as inputWidgetEls, marked `wired`
  // while a wire brings the path, when it shows only the pin. A class, not
  // [hidden]: the picker hides and shows its own parts, and a wire must not
  // undo that.
  const pathPickerEls = new Map<string, HTMLElement>();
  // The pin for each *optional* input — a widget input (same keying as
  // inputWidgetEls) or a plain port marked `required: false` (e.g.
  // generate's image_1-image_5; see FlowPort in types.ts). Faded while
  // unconnected, in step with inputWidgetEls' hidden state; a required plain
  // port has no entry and never fades. Hover un-fades it in CSS alone.
  const optionalHandleEls = new Map<string, HTMLElement>();
  // The pin for each output port, keyed by `${nodeId}:${portId}`. Not
  // folded into optionalHandleEls: a node can have an input and an output
  // with the same port id (toggleText's "text"/"text"), which would collide.
  // Faded while no edge leaves the port; every output gets an entry, since
  // outputs have no `required` flag.
  const outputHandleEls = new Map<string, HTMLElement>();
  // A `whileWired` affix menu (Toggle's) and the input it places, keyed by
  // node id: the opposite polarity from inputWidgetEls above, shown only once
  // something IS wired into that input, since with nothing wired there is
  // nothing to place.
  const sourceDependentEls = new Map<string, { el: HTMLElement; portId: string }>();
  // getField's field list and chart's column lists, re-read whenever an edge
  // into the node changes.
  const sourceRefreshers = new Map<string, () => void>();
  // Per node, what sets its title's tooltip to its Applet's description.
  const titleDescribers = new Map<string, (appletDescription: string | undefined) => void>();
  const chartViews = new Map<string, ChartView>();
  const appletFrames = new Map<string, AppletFrame>();
  // Prompt's and Note's editors, each ended with its card, which also ends
  // its hold on the Spellcheck setting.
  const textEditors = new Map<string, Disposable>();
  const generationViews = new Map<string, GenerationView>();
  // Each Load Video's clip, by node id, so its player goes with the card.
  const clipPickers = new Map<string, ClipPicker>();
  // Per slotted node, what shows or hides its "+" for what's revealed and
  // what the picked model takes.
  const slotAddRefreshers = new Map<string, () => void>();
  // Per Generate Video node, its frame rows, and what shows each one for the
  // picked model, the node's removals and its wires.
  const frameRows = new Map<string, Map<FrameKind, HTMLDivElement>>();
  const frameSyncers = new Map<string, () => void>();
  const heldViews = new Map<string, HeldView>();
  // Under a generation with a `context` pin, what its last run sent.
  const contextReports = new Map<string, HTMLParagraphElement>();
  // Pins drawn for wires naming a port their node lacks, keyed
  // `${nodeId}:${type}:${portId}`.
  const missingPinEls = new Map<string, HTMLElement>();

  const pickers = createPickers({
    persistGraph: deps.persistGraph,
    saveGraphNow: deps.saveGraphNow,
    ensureCapability: deps.ensureCapability,
    read: deps.read,
    pickedImages: deps.pickedImages,
    directoryChildren: deps.directoryChildren,
    flowPath: deps.flowPath,
    bindExposeToggle,
    sourceOf: (nodeId, portId) => {
      const graph = deps.graph();
      const edge = graph.edges.find((e) => e.target === nodeId && e.targetPort === portId);
      const node = edge && graph.nodes.find((n) => n.id === edge.source);
      return edge && node ? { node, portId: edge.sourcePort } : undefined;
    },
    sourceLoaded: (nodeId) => {
      for (const edge of deps.graph().edges) if (edge.source === nodeId) sourceRefreshers.get(edge.target)?.();
    },
    openChipMenu: deps.menus.openChipMenu,
    remount: deps.remount,
    // Shown where the run's failure would be, and counted where it can't be missed.
    fileMissing: (nodeId, message) => {
      showError(nodeId, message);
      deps.fileMissing(nodeId, message);
    },
    layoutChanged: deps.onLayoutChange,
    previewResult: deps.previewResult,
    contextMenu: deps.contextMenu,
  });

  // A node's error line: a run's failure, or a loader's missing file before
  // any run. One writer, so the two never look different.
  // A failure as an inline error, or, `skipped`, why a disabled node left this
  // one out, which is no failure.
  function showError(nodeId: string, message: string | undefined, skipped = false, need?: SetupNeed): void {
    const el = resultEls.get(nodeId);
    if (!el) return;
    el.hidden = message === undefined;
    el.className =
      message === undefined ? "flow-node-result" : skipped ? "flow-node-skipped nodrag" : "flow-node-error nodrag";
    el.replaceChildren(message === undefined || skipped ? (message ?? "") : createInlineError({ message, need }));
  }

  // isValidHandle (called during the connection drag) hit-tests via
  // doc.elementFromPoint and requires the element under the pointer to
  // carry the `${lib}-flow__handle` class plus `connectable`/
  // `connectableend` — only discoverable by reading the compiled bundle
  // (dist/esm/index.js), not the public types.
  function createHandleEl(
    nodeId: string,
    handleId: string,
    type: XYHandleType,
    portType: FlowPortType,
  ): HTMLDivElement {
    const el = document.createElement("div");
    el.className = `handle nodrag connectable connectableend system-flow__handle ${type} type-${portType}`;
    el.dataset.handleid = handleId;
    el.dataset.handlepos = type === "source" ? "right" : "left";
    el.dataset.nodeid = nodeId;
    el.dataset.id = `null-${nodeId}-${handleId}-${type}`;
    // Left-click-drag always draws a connection, even from an already-
    // connected handle: Disconnect lives on right-click instead, below.
    el.addEventListener("mousedown", (event) => {
      if (event.button !== 0) return;
      deps.startConnection(event, nodeId, handleId, type, el);
    });
    el.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      event.stopPropagation(); // the pane's own contextmenu handler already no-ops inside a .flow-node; this just skips the redundant work
      deps.menus.openHandleMenu(event.clientX, event.clientY, portType, wiresAt(nodeId, handleId, type));
    });
    return el;
  }

  function wiresAt(nodeId: string, portId: string, type: XYHandleType): FlowEdgeInstance[] {
    return deps
      .graph()
      .edges.filter((e) =>
        type === "target"
          ? e.target === nodeId && e.targetPort === portId
          : e.source === nodeId && e.sourcePort === portId,
      );
  }

  // A wire naming a port its node lacks, as after a port is renamed, fails
  // the run, so the card draws it a pin to be seen and disconnected from.
  // Nothing may connect to that pin: it isn't `connectable`, and a drag
  // never starts from it.
  function createMissingPinRows(node: FlowNodeInstance, type: XYHandleType): HTMLDivElement[] {
    for (const key of Array.from(missingPinEls.keys())) {
      if (key.startsWith(`${node.id}:${type}:`)) missingPinEls.delete(key);
    }
    return missingPortIds(node, deps.graph().edges, type).map((portId) => {
      const row = document.createElement("div");
      row.className = `flow-port-row ${type === "target" ? "input" : "output"} missing`;
      row.dataset.tooltip = deps.locked()
        ? `This node has no "${portId}" pin.`
        : `This node has no "${portId}" pin. Right-click the pin to disconnect its wire.`;
      const label = document.createElement("span");
      label.className = "flow-port-label";
      label.textContent = `${portId} (missing)`;
      const handle = document.createElement("div");
      handle.className = `handle nodrag missing ${type}`;
      handle.dataset.handleid = portId;
      handle.dataset.handlepos = type === "source" ? "right" : "left";
      handle.dataset.nodeid = node.id;
      handle.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const wires = wiresAt(node.id, portId, type);
        deps.menus.openHandleMenu(event.clientX, event.clientY, wireType(wires[0], type), wires);
      });
      if (type === "target") row.append(handle, label);
      else row.append(label, handle);
      missingPinEls.set(`${node.id}:${type}:${portId}`, row);
      return row;
    });
  }

  // A missing pin's type is the one its wire's other end declares, if any.
  function wireType(edge: FlowEdgeInstance | undefined, type: XYHandleType): FlowPortType | null {
    if (!edge) return null;
    const graph = deps.graph();
    if (type === "target") {
      const source = graph.nodes.find((n) => n.id === edge.source);
      return (source && nodePorts(source).outputs.find((p) => p.id === edge.sourcePort)?.type) ?? null;
    }
    const target = graph.nodes.find((n) => n.id === edge.target);
    return (target && nodePorts(target).inputs.find((p) => p.id === edge.targetPort)?.type) ?? null;
  }

  function dropMissingPin(nodeId: string, portId: string, type: XYHandleType): void {
    const key = `${nodeId}:${type}:${portId}`;
    const row = missingPinEls.get(key);
    if (!row || wiresAt(nodeId, portId, type).length > 0) return;
    row.remove();
    missingPinEls.delete(key);
    deps.onLayoutChange(nodeId);
  }

  // A pin's description is the tooltip of its pin, its name and its field,
  // never of its row: a path pin's row also holds the drop target, and a
  // model field keeps its own tooltip, the model's full name.
  function describePin(port: FlowPort | undefined, ...els: HTMLElement[]): void {
    if (!port?.description) return;
    for (const el of els) el.dataset.tooltip = port.description;
  }

  function createPortRow(node: FlowNodeInstance, port: FlowPort, type: XYHandleType): HTMLDivElement {
    const nodeId = node.id;
    const row = document.createElement("div");
    row.className = `flow-port-row ${type === "target" ? "input" : "output"}`;
    const label = document.createElement("span");
    label.className = "flow-port-label";
    label.textContent = port.label;
    const handle = createHandleEl(nodeId, port.id, type, port.type);
    describePin(port, handle, label);
    // A plain input marked optional (FlowPort.required === false, e.g.
    // generate's image_1-image_5) fades like a widget input's unconnected pin.
    // Always starts unconnected: the canvas's correction pass and live edge
    // events sync it from there.
    if (type === "target" && port.required === false) {
      handle.classList.add("unconnected");
      optionalHandleEls.set(`${nodeId}:${port.id}`, handle);
    }
    // Every output starts faded too, safe for the same reason as the
    // optional-input case above.
    if (type === "source") {
      handle.classList.add("unconnected");
      outputHandleEls.set(`${nodeId}:${port.id}`, handle);
      // Outputs are always meaningfully exposable (a produced value an
      // app-mode form could display) — unlike a plain input socket, which
      // deliberately gets no toggle.
      bindExposeToggle(node, port.id, port.type, label, row);
    }
    if (type === "target") row.append(handle, label);
    else row.append(label, handle);
    return row;
  }

  // A pin beside the file goes unnamed while the file shows, so its tooltip
  // carries its name, ahead of any description that doesn't already say it.
  function nameInTooltip({ port, row }: PlacedPin): void {
    const handle = row.querySelector<HTMLElement>(":scope > .handle");
    if (!handle) return;
    const { label, description } = port;
    const named = description && new RegExp(`\\b${label}\\b`, "i").test(description);
    handle.dataset.tooltip = !description ? label : named ? description : `${label}\n${description}`;
  }

  // A path pin's row, moved from the inputs to the left of the drop target
  // its wire stands in for. Its name shows only while wired, with the target
  // gone: unwired, the target already says what the pin takes.
  function placePathPin(nodeId: string, pin: PlacedPin, picker: PathPicker): void {
    pin.row.classList.add("flow-path-row");
    picker.target.replaceWith(pin.row);
    pin.row.appendChild(picker.target);
    picker.el.classList.add("flow-path-picker");
    pathPickerEls.set(`${nodeId}:${pin.port.id}`, picker.el);
    nameInTooltip(pin);
  }

  // A loader's `path` output row, moved from the outputs to the right of the
  // file it hands on, into the path pin's row where there is one. It is
  // named only while that pin's wire stands in for the file.
  function placePathOutput(pin: PlacedPin, picker: PathPicker): void {
    let fileRow = picker.target.parentElement;
    if (!fileRow?.classList.contains("flow-path-row")) {
      fileRow = document.createElement("div");
      fileRow.className = "flow-port-row flow-path-row";
      picker.target.replaceWith(fileRow);
      fileRow.appendChild(picker.target);
    }
    fileRow.appendChild(pin.row);
    nameInTooltip(pin);
  }

  function createConfigField(node: FlowNodeInstance, field: FlowNodeConfigField): HTMLDivElement {
    const currentValue = typeof node.config[field.key] === "string" ? (node.config[field.key] as string) : "";

    if (field.type === "checkbox") {
      const wrap = document.createElement("div");
      wrap.className = "flow-config-field checkbox";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.className = "nodrag";
      input.checked = currentValue === "true";
      const label = document.createElement("label");
      label.className = "flow-config-label";
      label.textContent = field.label;
      input.addEventListener("change", () => {
        node.config[field.key] = input.checked ? "true" : "false";
        deps.persistGraph();
        heldViews.get(node.id)?.sync();
      });
      wrap.append(input, label);
      if (field.description) wrap.dataset.tooltip = field.description;
      bindExposeToggle(node, field.key, "boolean", label, wrap);
      return wrap;
    }

    const wrap = document.createElement("div");
    wrap.className = "flow-config-field";
    if (field.description) wrap.dataset.tooltip = field.description;
    const label = document.createElement("label");
    label.className = "flow-config-label";
    label.textContent = field.label;
    wrap.appendChild(label);
    const save = (value: string) => {
      node.config[field.key] = value;
      deps.persistGraph();
    };

    if (field.type === "integer") {
      const stored = () => (typeof node.config[field.key] === "string" ? (node.config[field.key] as string) : "");
      wrap.appendChild(createIntStepper(field, stored, save).el);
      bindExposeToggle(node, field.key, "number", label, wrap);
      return wrap;
    }
    if (field.type === "select") {
      wrap.appendChild(createSelectPicker(deps.contextMenu, field, currentValue, save));
      bindExposeToggle(node, field.key, "text", label, wrap);
      return wrap;
    }

    const control: HTMLInputElement | HTMLTextAreaElement =
      field.type === "textarea" ? document.createElement("textarea") : document.createElement("input");
    control.className = "form-input nodrag";
    if (control instanceof HTMLInputElement) control.type = "text";
    control.value = currentValue;
    control.addEventListener("input", () => save(control.value));
    wrap.appendChild(control);
    bindExposeToggle(node, field.key, "text", label, wrap);
    return wrap;
  }

  // Hides a widget input's fallback control and un-fades any optional pin
  // once something is wired into the port; rerun on every edge change
  // touching it. Each lookup is a no-op for a port not in that map (a
  // required plain port is in neither; image_1-image_5 have a pin but no
  // fallback), so it's safe to call on any port.
  //
  // A wired path pin leaves its picker showing only itself, so the pin moves
  // and the card is measured again, or its wire would end where it was.
  function updateInputWidgetVisibility(nodeId: string, portId: string): void {
    dropMissingPin(nodeId, portId, "target");
    const key = `${nodeId}:${portId}`;
    const connected = deps.graph().edges.some((e) => e.target === nodeId && e.targetPort === portId);
    const control = inputWidgetEls.get(key);
    if (control) control.hidden = connected;
    optionalHandleEls.get(key)?.classList.toggle("unconnected", !connected);
    const picker = pathPickerEls.get(key);
    if (picker && picker.classList.contains("wired") !== connected) {
      picker.classList.toggle("wired", connected);
      deps.onLayoutChange(nodeId);
    }
    // A wired model is unknown until the run, so the "+" stops at the ceiling,
    // and a frame wired or unwired shows or hides with it.
    if (portId === "model" || frameRows.get(nodeId)) followModel(nodeId);
  }

  // What on a card follows its model: its frame pins, then its "+".
  function followModel(nodeId: string): void {
    const sync = frameSyncers.get(nodeId) ?? slotAddRefreshers.get(nodeId);
    sync?.();
  }

  // Output-pin counterpart to the input version above — an output fades
  // once no outgoing edge is left; a source can fan out, so "connected"
  // means at least one. Same call sites as the input version.
  function updateOutputHandleVisibility(nodeId: string, portId: string): void {
    dropMissingPin(nodeId, portId, "source");
    const key = `${nodeId}:${portId}`;
    const connected = deps.graph().edges.some((e) => e.source === nodeId && e.sourcePort === portId);
    outputHandleEls.get(key)?.classList.toggle("unconnected", !connected);
  }

  // Whether a wire goes into the node's `context` pin, which turns reuse off.
  function contextWired(node: FlowNodeInstance): boolean {
    const port = FLOW_NODE_REGISTRY[node.type]?.contextPort;
    return port !== undefined && deps.graph().edges.some((e) => e.target === node.id && e.targetPort === port);
  }

  // What changes with what's wired into a node: getField's field list, and
  // a `whileWired` affix menu, shown only once its input has an edge, the
  // inverse of a widget fallback (hidden once its port connects). A no-op
  // for any node without either registered, so safe to call unconditionally.
  function updateSourceDependents(nodeId: string): void {
    sourceRefreshers.get(nodeId)?.();
    const dependent = sourceDependentEls.get(nodeId);
    if (!dependent) return;
    dependent.el.hidden = !deps.graph().edges.some((e) => e.target === nodeId && e.targetPort === dependent.portId);
  }

  function isExposed(node: FlowNodeInstance, id: string): boolean {
    return (node.exposed ?? []).includes(id);
  }

  // Applies/removes the exposed tint on whatever element represents a field
  // (a `.flow-port-label`/`.flow-config-label` span, or the control itself
  // for a label-less one like a dropzone): the type-<port type> class its pin
  // carries (web/styles/value-types.css) plus a bare `exposed` flag, so the
  // two stay visually consistent. Idempotent in both directions.
  function setExposedClass(el: HTMLElement, portType: FlowPortType, exposed: boolean): void {
    el.classList.toggle("exposed", exposed);
    el.classList.toggle(`type-${portType}`, exposed);
  }

  // Right-click a widget fallback, an output, a config field, or a bespoke
  // picker to mark it exposed for Flow's App Mode form (docs/protocol.md's
  // App Mode section). Callers may pass the whole row as `contextTarget` so
  // right-clicking anywhere on it works, and `actions` for what the field
  // itself offers there, read as the menu opens.
  //
  // Deliberately never bound on a connect-only socket (a plain input,
  // toggleText's text row, a template-variable row) — it has no value of
  // its own to show in a form.
  function bindExposeToggle(
    node: FlowNodeInstance,
    id: string,
    portType: FlowPortType,
    labelEl: HTMLElement,
    contextTarget: HTMLElement = labelEl,
    actions: () => MenuItem[] = () => [],
  ): void {
    setExposedClass(labelEl, portType, isExposed(node, id));
    contextTarget.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      event.stopPropagation(); // same reasoning as createHandleEl's own contextmenu listener above
      const toggle = () => {
        const exposed = new Set(node.exposed ?? []);
        const firstExposed = exposed.size === 0;
        if (exposed.has(id)) exposed.delete(id);
        else exposed.add(id);
        node.exposed = exposed.size > 0 ? Array.from(exposed) : undefined;
        if (firstExposed) placeExposedNode(deps.graph(), node);
        setExposedClass(labelEl, portType, isExposed(node, id));
        deps.persistGraph();
      };
      deps.menus.openExposeMenu(event.clientX, event.clientY, portType, isExposed(node, id), toggle, actions());
    });
  }

  // A widget input's port row (see FlowNodeInputWidget in flowNodes.ts):
  // pin and label, plus an inline fallback control that hides once an edge
  // lands on the port. The fallback's value stays in `config[port.id]`
  // either way, so it's remembered if the edge is later removed. A model
  // input's control is the model picker, over the lists the view shares.
  function createWidgetPortRow(node: FlowNodeInstance, port: FlowPort, widget: FlowNodeInputWidget): HTMLDivElement {
    const row = document.createElement("div");
    row.className = "flow-port-row input has-widget";
    const handle = createHandleEl(node.id, port.id, "target", port.type);
    const label = document.createElement("span");
    label.className = "flow-port-label";
    label.textContent = port.label;

    const currentValue = () =>
      typeof node.config[port.id] === "string" ? (node.config[port.id] as string) : (widget.defaultValue ?? "");

    let control: HTMLElement;
    const modelKind = modelKindOf(widget.type);
    if (modelKind) {
      control = deps.modelFields.create(
        modelKind,
        currentValue,
        (ref) => {
          node.config[port.id] = ref;
          deps.persistGraph();
        },
        { onRedraw: () => followModel(node.id), effort: effortFieldOf(node, deps.persistGraph) },
      );
    } else if (widget.type === "select") {
      control = createSelectPicker(deps.contextMenu, widget, currentValue(), (value) => {
        node.config[port.id] = value;
        deps.persistGraph();
      });
    } else if (widget.type === "checkbox") {
      const input = document.createElement("input");
      input.type = "checkbox";
      input.checked = currentValue() === "true";
      input.addEventListener("change", () => {
        node.config[port.id] = input.checked ? "true" : "false";
        deps.persistGraph();
      });
      control = input;
    } else {
      const input = document.createElement("input");
      input.type = "text";
      input.className = "form-input";
      input.value = currentValue();
      input.placeholder = widget.placeholder ?? "";
      input.addEventListener("input", () => {
        node.config[port.id] = input.value;
        deps.persistGraph();
      });
      attachPlaceholderSuggestions(input, () => dateChoices(new Date()));
      control = input;
    }
    control.classList.add("nodrag");
    describePin(port, handle, label, ...(modelKind ? [] : [control]));
    const key = `${node.id}:${port.id}`;
    inputWidgetEls.set(key, control);
    optionalHandleEls.set(key, handle);
    // Always starts unconnected — safe at creation time for the same reason
    // as the plain optional-port case above.
    handle.classList.add("unconnected");
    // A widget's own fallback control holds a real value by itself
    // (unlike a plain socket), so it's always exposable — e.g. toggleText's
    // "true" checkbox, the example this feature was built around.
    bindExposeToggle(node, port.id, port.type, label, row);

    row.append(handle, label, control);
    return row;
  }

  // One of an Add Row node's column inputs: pin and the column's label, plus
  // what the cell gets when nothing is wired, hidden once something is.
  //
  // No Expose: App Mode and a run's inputs set a field by its config key,
  // and these values live under `values`, apart from the node's own keys.
  function createColumnPortRow(node: FlowNodeInstance, column: TableColumn, port: FlowPort): HTMLDivElement {
    const row = document.createElement("div");
    row.className = "flow-port-row input";
    const handle = createHandleEl(node.id, port.id, "target", port.type);
    // Always starts unconnected, as every optional pin does at creation.
    handle.classList.add("unconnected");
    const label = document.createElement("span");
    label.className = "flow-port-label";
    label.textContent = port.label;
    describePin(port, handle, label);
    row.append(handle, label);
    const key = `${node.id}:${port.id}`;
    optionalHandleEls.set(key, handle);

    const control = createColumnControl(node, column);
    if (control) {
      row.classList.add("has-widget");
      inputWidgetEls.set(key, control);
      row.appendChild(control);
    }
    return row;
  }

  // The control for a column's unwired value, by its type. A media or path
  // column has none: it takes a path from a wire. A timestamp says what the
  // Table fills in, which is the Table's to decide, not the node's.
  function createColumnControl(node: FlowNodeInstance, column: TableColumn): HTMLElement | undefined {
    const stored = addRowNodeConfig(node.config).values[column.id];
    const save = (value: string) => {
      node.config.values = { ...addRowNodeConfig(node.config).values, [column.id]: value };
      deps.persistGraph();
    };

    if (holdsPath(column.type)) return undefined;
    if (column.type === "timestamp") {
      if (column.default !== "now") return undefined;
      const hint = document.createElement("span");
      hint.className = "flow-port-hint";
      hint.textContent = "time added";
      return hint;
    }
    if (column.type === "checkbox") {
      const input = document.createElement("input");
      input.type = "checkbox";
      input.className = "nodrag";
      input.checked = stored === "true";
      input.addEventListener("change", () => save(input.checked ? "true" : "false"));
      return input;
    }
    if (column.type === "select") {
      const options = column.options ?? [];
      return createSelectControl(
        stored ?? options[0] ?? "",
        options.map((option) => ({ value: option, label: option })),
        save,
      );
    }
    const input = document.createElement("input");
    input.type = "text";
    input.className = "form-input nodrag";
    if (column.type === "integer") input.inputMode = "numeric";
    input.value = stored ?? "";
    input.addEventListener("input", () => save(input.value));
    if (column.type === "text") attachPlaceholderSuggestions(input, () => dateChoices(new Date()));
    return input;
  }

  // An Add Row node's Table. Read again on every build, so the pins follow
  // the Table's columns as they are now — one added, renamed or deleted.
  function createAddRowContent(node: FlowNodeInstance): HTMLDivElement {
    const picker = pickers.createAddRowPicker(node, () => deps.remount(node.id));
    void syncAddRowNode(node, picker);
    return picker.el;
  }

  // Records the Table's columns, and rebuilds the card when they changed;
  // the rebuild's own read then finds nothing to change. A deleted column
  // takes its wires with it: a column's id survives a rename, so its wires
  // could only ever be disconnected from a missing pin.
  async function syncAddRowNode(node: FlowNodeInstance, picker: AddRowPicker): Promise<void> {
    const { tablePath, columns: saved } = addRowNodeConfig(node.config);
    if (!tablePath) return;
    let file: FileResponse;
    try {
      file = await deps.loadFile(tablePath);
    } catch {
      picker.setDetail("Can't read this Table");
      return;
    }
    if (file.kind !== "table" || file.locked === "unreadable") {
      picker.setDetail("Not a Table Pragma can read");
      return;
    }
    // A gone Table reads as an empty one, which would pass for a Table whose
    // columns all went and take the node's wires: the node keeps both. Only
    // an unwired node's run would fail on it; a wired one adds elsewhere.
    if (file.missing) {
      const { edges } = deps.graph();
      const wired = edges.some((edge) => edge.target === node.id && edge.targetPort === ADD_ROW_PATH_PORT);
      if (!wired) picker.setMissing(noFileAt(file.path));
      return;
    }
    picker.describe(file.columns.length, file.rows.length);
    const columns = addRowColumns(file.columns);
    if (JSON.stringify(columns) === JSON.stringify(saved)) return;
    node.config.columns = columns;
    const kept = new Set(columns.map((column) => column.id));
    const graph = deps.graph();
    const dropped = graph.edges.filter((edge) => edge.target === node.id && !kept.has(edge.targetPort));
    graph.edges = graph.edges.filter((edge) => !dropped.includes(edge));
    deps.persistGraph();
    deps.remount(node.id);
    for (const edge of dropped) updateOutputHandleVisibility(edge.source, edge.sourcePort);
  }

  // The row of the input a type's `affix` names: pin and label, plus the
  // Prepend/Append menu placing that input's text, around Toggle's pick or
  // in Add to Note's note. Not a labeled config field, since the port label
  // already says what is placed, and not a widget fallback: a `whileWired`
  // menu shows once connected rather than hiding.
  function createAffixPortRow(node: FlowNodeInstance, port: FlowPort, whileWired: boolean): HTMLDivElement {
    const row = document.createElement("div");
    row.className = "flow-port-row input has-widget";
    const handle = createHandleEl(node.id, port.id, "target", port.type);
    const label = document.createElement("span");
    label.className = "flow-port-label";
    label.textContent = port.label;
    describePin(port, handle, label);

    const select = createSelectControl(
      affixModeOf(node),
      [
        { value: "prepend", label: "Prepend" },
        { value: "append", label: "Append" },
      ],
      (value) => {
        node.config.affixMode = value;
        deps.persistGraph();
      },
    );
    if (whileWired) sourceDependentEls.set(node.id, { el: select, portId: port.id });

    row.append(handle, label, select);
    return row;
  }

  // Which of a slotted node's slots are revealed, as an ordered list rather
  // than a count: removing a middle slot leaves a gap in the numbering
  // instead of renumbering what's after it, which would rewrite later slots'
  // edges and config keys. The floor's slot is never stored, only those past
  // it live in `config[spec.slotsKey]`.
  //
  // A wired slot shows whatever the list says, so a Flow that never stored
  // its slots, saved before its pins came one at a time, opens as it was.
  function revealedSlots(node: FlowNodeInstance, spec: SlotSpec): number[] {
    const floor = spec.floor ?? 1;
    const raw = node.config[spec.slotsKey];
    const stored = Array.isArray(raw)
      ? raw.filter((n): n is number => typeof n === "number" && n > floor && n <= spec.max)
      : [];
    const edges = deps.graph().edges;
    const wired: number[] = [];
    for (let slot = 1; slot <= spec.max; slot++) {
      const port = spec.portId(slot);
      const touches = (e: FlowEdgeInstance) =>
        (e.target === node.id && e.targetPort === port) || (e.source === node.id && e.sourcePort === port);
      if (edges.some(touches)) wired.push(slot);
    }
    return [...new Set([...(floor ? [1] : []), ...stored, ...wired])].sort((a, b) => a - b);
  }

  // The slots a slotted node shows: those revealed, and any row the card has
  // drawn since, such as a wired one whose wire has gone.
  function shownSlots(node: FlowNodeInstance, spec: SlotView, container: HTMLElement): number[] {
    const key = spec.rowKey ?? "slot";
    const drawn = [...container.children].flatMap((child) =>
      child instanceof HTMLElement && child.dataset[key] ? [Number(child.dataset[key])] : [],
    );
    return [...new Set([...revealedSlots(node, spec), ...drawn])].sort((a, b) => a - b);
  }

  // The lowest slot not revealed, reusing a gap before extending past the
  // highest, so removing a slot always frees real capacity. undefined once
  // every slot is in use.
  function nextSlot(slots: number[], spec: SlotSpec): number | undefined {
    for (let i = 1; i <= spec.max; i++) {
      if (!slots.includes(i)) return i;
    }
    return undefined;
  }

  // Template Variables' per-slot row: a plain pin (no fallback — the value
  // comes from upstream) plus an editable name, written as the {{name}}
  // placeholder it fills in `source`, so a named pin reads apart from a
  // built-in one.
  //
  // Styled unboxed (.has-label, see web/styles/flow/ports.css), not
  // .has-widget's boxed fallback: the name describes the pin, never a value
  // that could stand in for it.
  function createVariablePortRow(node: FlowNodeInstance, index: number, inputsEl: HTMLDivElement): HTMLDivElement {
    const portId = `var_${index}`;
    const row = document.createElement("div");
    row.className = "flow-port-row input has-label";
    const handle = createHandleEl(node.id, portId, "target", "text");
    const nameKey = `var${index}Name`;
    const input = document.createElement("input");
    input.type = "text";
    input.className = "flow-variable-name-input";
    input.placeholder = "name";
    input.value = typeof node.config[nameKey] === "string" ? (node.config[nameKey] as string) : "";
    // The field is as wide as data-text (ports.css), so it follows every
    // change to the name, or the closing braces stop following the name.
    const field = document.createElement("span");
    field.className = "flow-variable-name-field";
    const sizeToName = () => {
      field.dataset.text = input.value || input.placeholder;
    };
    sizeToName();
    field.append(input);
    const brace = (text: string) => {
      const span = document.createElement("span");
      span.className = "flow-variable-name-brace";
      span.setAttribute("aria-hidden", "true");
      span.textContent = text;
      return span;
    };
    const name = document.createElement("label");
    name.className = "flow-variable-name nodrag";
    name.append(brace("{{"), field, brace("}}"));
    input.addEventListener("input", () => {
      // Constrained to \w, exactly the placeholder pattern's name class — a
      // wider allowance (e.g. hyphen) would name a slot no placeholder can
      // reach. Stripped in place rather than rejected so a paste still
      // lands usably, with the cursor shifted back by the characters removed
      // before it instead of jumping to the end.
      const cursor = input.selectionStart ?? input.value.length;
      const before = input.value.slice(0, cursor);
      const sanitized = input.value.replace(/[^\w]/g, "");
      if (sanitized !== input.value) {
        const removedBeforeCursor = before.length - before.replace(/[^\w]/g, "").length;
        input.value = sanitized;
        const newCursor = cursor - removedBeforeCursor;
        input.setSelectionRange(newCursor, newCursor);
      }
      sizeToName();
      node.config[nameKey] = input.value;
      deps.persistGraph();
    });
    describePin(
      nodePorts(node).inputs.find((port) => port.id === portId),
      handle,
      input,
    );
    row.append(handle, name);

    // Slot 1 is permanent so the card can never shrink to zero rows.
    if (index !== 1) row.appendChild(createRemoveSlotButton(node, TEMPLATE_VARIABLE_VIEW, index, row, inputsEl));

    return row;
  }

  // Every slot but the first gets one, so a card never shrinks to zero rows.
  // Removing a slot drops its edges, in or out, and its config value.
  function createRemoveSlotButton(
    node: FlowNodeInstance,
    spec: SlotView,
    index: number,
    row: HTMLDivElement,
    container: HTMLDivElement,
    onRemove?: () => void,
  ): HTMLButtonElement {
    const portId = spec.portId(index);
    const button = createTrashButton(`Remove ${spec.noun}`);
    button.addEventListener("click", () => {
      const graph = deps.graph();
      const touches = (e: FlowEdgeInstance) =>
        (e.target === node.id && e.targetPort === portId) || (e.source === node.id && e.sourcePort === portId);
      const removedEdges = graph.edges.filter(touches);
      graph.edges = graph.edges.filter((e) => !touches(e));
      if (spec.configKey) delete node.config[spec.configKey(index)];
      const floor = spec.floor ?? 1;
      node.config[spec.slotsKey] = shownSlots(node, spec, container).filter((n) => n > floor && n !== index);
      row.remove();
      onRemove?.();
      slotAddRefreshers.get(node.id)?.();
      deps.onLayoutChange(node.id);
      deps.persistGraph();
      for (const edge of removedEdges) {
        if (edge.target === node.id) {
          updateOutputHandleVisibility(edge.source, edge.sourcePort);
        } else {
          updateInputWidgetVisibility(edge.target, edge.targetPort);
          updateSourceDependents(edge.target);
        }
      }
    });
    return button;
  }

  function createTrashButton(label: string): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "icon-button flow-remove-variable-button nodrag";
    button.setAttribute("aria-label", label);
    const icon = document.createElement("span");
    icon.className = "flow-remove-variable-icon";
    button.appendChild(icon);
    return button;
  }

  // The "+" control below a slotted node's rows — inserts one more slot's row
  // into the live DOM rather than re-mounting the node, which has no redraw
  // path. A new row goes before the first one numbered past it. Hides itself
  // once every slot is revealed, or `limit` of them, when it gives one.
  //
  // `choices` adds what else the "+" can bring back, a Generate Video's frames:
  // with more than one thing to add it opens a menu of them, never guessing.
  function createAddSlotRow(
    node: FlowNodeInstance,
    spec: SlotView,
    container: HTMLDivElement,
    buildRow: (index: number) => HTMLDivElement,
    limit?: () => number | undefined,
    choices?: {
      slotLabel: string;
      menuLabel: string;
      word: (options: AddChoice[]) => string;
      others: () => AddChoice[];
      // What else it can add, listed after its own slot: a Generate Video's clips.
      after?: () => AddChoice[];
      // Where a new row goes when none is numbered past it, if not just
      // above the "+".
      endsBefore?: () => Element | undefined;
    },
  ): HTMLDivElement {
    const row = document.createElement("div");
    row.className = "flow-add-variable-row";
    const button = document.createElement("button");
    button.type = "button";
    const icon = document.createElement("span");
    // A Generate node's "+" reads as one more pin, its name where a pin's
    // goes; a variable's or a field's stays a bare icon.
    const word = choices ? document.createElement("span") : undefined;
    if (word) {
      button.className = "flow-add-reference nodrag";
      icon.className = "flow-add-reference-icon";
      word.className = "flow-add-reference-label";
      button.append(icon, word);
    } else {
      button.className = "icon-button flow-add-variable-button nodrag";
      icon.className = "flow-add-variable-icon";
      button.appendChild(icon);
    }
    const full = (slots: number[]) => {
      const most = limit?.();
      return nextSlot(slots, spec) === undefined || (most !== undefined && slots.length >= most);
    };
    const addSlot = () => {
      const slots = shownSlots(node, spec, container);
      const next = nextSlot(slots, spec);
      if (next === undefined || full(slots)) return;
      const floor = spec.floor ?? 1;
      node.config[spec.slotsKey] = [...slots.filter((n) => n > floor), next];
      const added = buildRow(next);
      const key = spec.rowKey ?? "slot";
      added.dataset[key] = String(next);
      const after = [...container.children].find(
        (child) => child instanceof HTMLElement && Number(child.dataset[key]) > next,
      );
      container.insertBefore(added, after ?? choices?.endsBefore?.() ?? row);
      refresh();
      deps.onLayoutChange(node.id);
      deps.persistGraph();
    };
    const available = (): AddChoice[] => [
      ...(choices?.others() ?? []),
      ...(full(shownSlots(node, spec, container)) ? [] : [{ label: choices?.slotLabel ?? spec.noun, add: addSlot }]),
      ...(choices?.after?.() ?? []),
    ];
    const label = (options: AddChoice[]) =>
      options.length === 1 ? `Add ${options[0].label.toLowerCase()}` : (choices?.menuLabel ?? `Add ${spec.noun}`);
    const refresh = () => {
      const options = available();
      button.setAttribute("aria-label", label(options));
      if (word && choices) word.textContent = choices.word(options);
      const hidden = options.length === 0;
      if (row.hidden === hidden) return;
      row.hidden = hidden;
      deps.onLayoutChange(node.id);
    };
    button.addEventListener("click", () => {
      const options = available();
      if (options.length === 1) options[0].add();
      if (options.length < 2) return;
      deps.contextMenu.open({
        items: options.map((option) => ({ label: option.label, run: () => option.add() })),
        anchor: button,
        ariaLabel: label(options),
      });
    });
    row.appendChild(button);
    const options = available();
    button.setAttribute("aria-label", label(options));
    if (word && choices) word.textContent = choices.word(options);
    row.hidden = options.length === 0;
    slotAddRefreshers.set(node.id, refresh);
    return row;
  }

  // The model a card's "+" and frames follow: the one picked on the node, or
  // the default it falls back to. Undefined while the model comes on a wire,
  // which no card can know before the run.
  function pickedModel(node: FlowNodeInstance): { kind: ModelKind; ref: string } | undefined {
    const widget = FLOW_NODE_REGISTRY[node.type]?.inputWidgets?.find((candidate) => candidate.portId === "model");
    const kind = widget ? modelKindOf(widget.type) : undefined;
    if (!kind || deps.graph().edges.some((e) => e.target === node.id && e.targetPort === "model")) return undefined;
    return { kind, ref: typeof node.config.model === "string" ? node.config.model : "" };
  }

  // A Generate node's reference pins: each revealed one a plain optional pin
  // with its Remove, the images first and then a Generate Video's clips, then
  // the "+". Each kind stops at the number the picked model takes, or at the
  // ceiling while the model comes on a wire or nobody says. On a node with
  // frames the "+" also brings back a frame the model takes.
  function createReferenceRows(node: FlowNodeInstance, view: SlotView, container: HTMLDivElement): HTMLDivElement[] {
    const ports = nodePorts(node).inputs;
    const builder =
      (kind: SlotView) =>
      (slot: number): HTMLDivElement => {
        const port = ports.find((candidate) => candidate.id === kind.portId(slot));
        const row = port ? createPortRow(node, port, "target") : document.createElement("div");
        row.classList.add("flow-reference-row");
        row.dataset[kind.rowKey ?? "slot"] = String(slot);
        row.appendChild(createRemoveSlotButton(node, kind, slot, row, container));
        return row;
      };
    const build = builder(view);
    const limitOf = (count: (kind: ModelKind, ref: string) => number | undefined) => () => {
      const picked = pickedModel(node);
      return picked ? count(picked.kind, picked.ref) : undefined;
    };
    const videoSpec = FLOW_NODE_REGISTRY[node.type]?.videoReferenceSlots;
    const videoView: SlotView | undefined = videoSpec && { ...videoSpec, noun: "video reference", rowKey: "videoSlot" };
    const buildVideo = videoView && builder(videoView);
    const videoLimit = limitOf(deps.modelFields.videoReferences);
    let addRow: HTMLDivElement | undefined;
    const videoRows = (): HTMLElement[] =>
      [...container.children].filter(
        (child): child is HTMLElement => child instanceof HTMLElement && child.dataset.videoSlot !== undefined,
      );
    // The next clip's row, placed among the clips, which sit below the images.
    const videoChoices = (): AddChoice[] => {
      if (!videoView || !buildVideo) return [];
      const slots = shownSlots(node, videoView, container);
      const next = nextSlot(slots, videoView);
      const most = videoLimit();
      if (next === undefined || (most !== undefined && slots.length >= most)) return [];
      const add = () => {
        node.config[videoView.slotsKey] = [...slots, next];
        const added = buildVideo(next);
        const after = videoRows().find((child) => Number(child.dataset.videoSlot) > next);
        container.insertBefore(added, after ?? addRow ?? null);
        slotAddRefreshers.get(node.id)?.();
        deps.onLayoutChange(node.id);
        deps.persistGraph();
      };
      return [{ label: "Video reference", add }];
    };
    const framed = FLOW_NODE_REGISTRY[node.type]?.framePorts !== undefined;
    const choices = {
      slotLabel: "Image reference",
      menuLabel: "Add frame or reference",
      word: (options: AddChoice[]) => (options.some((option) => option.frame) ? "Frame or reference" : "Reference"),
      others: () => (framed ? frameChoices(node) : []),
      after: videoChoices,
      endsBefore: () => videoRows()[0],
    };
    addRow = createAddSlotRow(node, view, container, build, limitOf(deps.modelFields.imageReferences), choices);
    const clips = videoView && buildVideo ? revealedSlots(node, videoView).map(buildVideo) : [];
    return [...revealedSlots(node, view).map(build), ...clips, addRow];
  }

  function takenFrames(node: FlowNodeInstance): readonly FrameKind[] {
    const picked = pickedModel(node);
    return (picked && deps.modelFields.frames(picked.kind, picked.ref)) ?? FRAME_KINDS;
  }

  function removedFrames(node: FlowNodeInstance): FrameKind[] {
    const raw = node.config.removedFrames;
    return Array.isArray(raw) ? raw.filter((kind): kind is FrameKind => FRAME_KINDS.includes(kind)) : [];
  }

  // The frames a Generate Video's card shows: each the model takes and the
  // node hasn't removed, and any with a wire, whatever the rest says.
  function shownFrames(node: FlowNodeInstance): FrameKind[] {
    const ports = FLOW_NODE_REGISTRY[node.type]?.framePorts;
    if (!ports) return [];
    const taken = takenFrames(node);
    const removed = removedFrames(node);
    const edges = deps.graph().edges;
    return FRAME_KINDS.filter(
      (kind) =>
        edges.some((e) => e.target === node.id && e.targetPort === ports[kind]) ||
        (taken.includes(kind) && !removed.includes(kind)),
    );
  }

  // What the "+" can bring back: a frame the model takes that isn't showing.
  function frameChoices(node: FlowNodeInstance): AddChoice[] {
    const shown = shownFrames(node);
    return takenFrames(node)
      .filter((kind) => !shown.includes(kind))
      .map((kind) => ({
        label: FRAME_LABELS[kind],
        frame: true,
        add: () => {
          const removed = removedFrames(node).filter((other) => other !== kind);
          if (removed.length) node.config.removedFrames = removed;
          else delete node.config.removedFrames;
          frameSyncers.get(node.id)?.();
          deps.persistGraph();
        },
      }));
  }

  // A Generate Video's frame pin: a plain optional image pin with its Remove,
  // which takes its wire with it and leaves the frame out until the "+"
  // brings it back. Hidden, not dropped, so a model change can show it again.
  function createFrameRow(node: FlowNodeInstance, kind: FrameKind, port: FlowPort): HTMLDivElement {
    const row = createPortRow(node, port, "target");
    row.classList.add("flow-reference-row");
    const remove = createTrashButton(`Remove ${FRAME_LABELS[kind].toLowerCase()}`);
    remove.addEventListener("click", () => {
      const graph = deps.graph();
      const cut = graph.edges.filter((e) => e.target === node.id && e.targetPort === port.id);
      graph.edges = graph.edges.filter((e) => !cut.includes(e));
      node.config.removedFrames = [...new Set([...removedFrames(node), kind])];
      frameSyncers.get(node.id)?.();
      for (const edge of cut) updateOutputHandleVisibility(edge.source, edge.sourcePort);
      deps.persistGraph();
    });
    row.appendChild(remove);
    row.hidden = !shownFrames(node).includes(kind);
    const rows = frameRows.get(node.id) ?? new Map<FrameKind, HTMLDivElement>();
    rows.set(kind, row);
    frameRows.set(node.id, rows);
    frameSyncers.set(node.id, () => {
      const shown = shownFrames(node);
      let moved = false;
      for (const [each, eachRow] of frameRows.get(node.id) ?? []) {
        const hidden = !shown.includes(each);
        if (eachRow.hidden !== hidden) {
          eachRow.hidden = hidden;
          moved = true;
        }
      }
      if (moved) deps.onLayoutChange(node.id);
      slotAddRefreshers.get(node.id)?.();
    });
    return row;
  }

  // Get Field's per-slot row: that slot's field control with its output pin
  // beside it. No Expose: the control is the pin's only label.
  function createFieldPortRow(
    node: FlowNodeInstance,
    index: number,
    picker: FieldPicker,
    outputsEl: HTMLDivElement,
  ): HTMLDivElement {
    const portId = GET_FIELD_VIEW.portId(index);
    const key = `${node.id}:${portId}`;
    const row = document.createElement("div");
    row.className = "flow-port-row output has-widget";
    const handle = createHandleEl(node.id, portId, "source", "text");
    handle.classList.add("unconnected");
    outputHandleEls.set(key, handle);
    if (index !== 1) {
      row.appendChild(
        createRemoveSlotButton(node, GET_FIELD_VIEW, index, row, outputsEl, () => {
          picker.forget(index);
          outputHandleEls.delete(key);
        }),
      );
    }
    const control = picker.control(index);
    describePin(
      nodePorts(node).outputs.find((port) => port.id === portId),
      control,
      handle,
    );
    row.append(control, handle);
    return row;
  }

  // Prompt's only hint that the @image_N vocabulary does anything. Docked
  // in the input column, which Prompt otherwise leaves empty, so it sits
  // inline with the "text" output row instead of a dedicated row pushing
  // the textbox down.
  function createMentionInfoRow(): HTMLDivElement {
    const row = document.createElement("div");
    row.className = "flow-port-row flow-node-mention-info-row";
    const info = document.createElement("button");
    info.type = "button";
    info.className = "icon-button flow-node-textbox-info nodrag";
    info.dataset.tooltip = "Type @image_1 to reference the image connected to a Generate node's image_1";
    info.setAttribute("aria-label", "Mention syntax help");
    const infoIcon = document.createElement("span");
    infoIcon.className = "flow-node-textbox-info-icon";
    info.appendChild(infoIcon);
    row.appendChild(info);
    return row;
  }

  // Prompt's and Note's whole config: one flex:1 CodeMirror editor on the
  // "text" key, growing with a resized card. CodeMirror rather than a
  // <textarea> so the mention chips are real editable text — a colored
  // overlay on an invisible textarea drifts out of sync once a chip's
  // padding makes it wider than the characters beneath.
  function createEditableTextbox(node: FlowNodeInstance): HTMLDivElement {
    const wrap = document.createElement("div");
    wrap.className = "flow-node-textbox";

    const initialText = typeof node.config.text === "string" ? node.config.text : "";
    const spelling = new Compartment();
    const view = new EditorView({
      parent: wrap,
      state: EditorState.create({
        doc: initialText,
        extensions: [
          minimalSetup,
          EditorView.lineWrapping,
          placeholder("Text"),
          mentionHighlighter,
          selectedTextMark,
          spelling.of([]),
          node.type === "prompt"
            ? promptSuggestions(
                () => promptChoices(deps.graph(), node.id, new Date()),
                () => promptPins(deps.graph(), node.id),
              )
            : [],
          // Not view.dom.classList.add after construction — CM6 recomputes
          // .cm-editor's class attribute wholesale on its own update cycle
          // (the one that toggles cm-focused), wiping an imperatively added
          // class on the field's first click. editorAttributes merges with
          // CM6's managed classes instead, as web/formats/screenplay/language.ts does.
          EditorView.editorAttributes.of({ class: "form-input flow-node-textbox-area nodrag" }),
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) return;
            node.config.text = update.state.doc.toString();
            deps.persistGraph();
          }),
        ],
      }),
    });
    const unsubscribe = spellcheck.subscribe((on) =>
      view.dispatch({ effects: spelling.reconfigure(on ? checkSpelling : []) }),
    );
    textEditors.get(node.id)?.dispose();
    textEditors.set(
      node.id,
      toDisposable(() => {
        unsubscribe();
        view.destroy();
      }),
    );

    return wrap;
  }

  // Choice's pick over its options, and the options, a line each. Editing
  // the list drops a pick it no longer holds, so the dropdown and a run never
  // disagree about what is chosen. The pick shares the output pin's label,
  // as Chart's drawing does: exposing either tints the one label.
  function createChoiceContent(node: FlowNodeInstance, textLabelEl: HTMLElement): HTMLDivElement {
    const wrap = document.createElement("div");
    wrap.className = "flow-node-config";

    const pickField = document.createElement("div");
    pickField.className = "flow-config-field";
    const pickLabel = document.createElement("label");
    pickLabel.className = "flow-config-label";
    pickLabel.textContent = "Pick";
    const select = createSelectControl("", [], (value) => {
      node.config.text = value;
      deps.persistGraph();
    });
    pickField.append(pickLabel, select);

    const optionsField = document.createElement("div");
    optionsField.className = "flow-config-field";
    const optionsLabel = document.createElement("label");
    optionsLabel.className = "flow-config-label";
    optionsLabel.textContent = "Options, one per line";
    const textarea = document.createElement("textarea");
    textarea.className = "form-input nodrag";
    textarea.rows = 4;
    textarea.value = typeof node.config.options === "string" ? node.config.options : "";
    optionsField.append(optionsLabel, textarea);

    const picked = () => (typeof node.config.text === "string" ? node.config.text : "");
    function renderPick(): void {
      const options = choiceOptions(node.config);
      select.replaceChildren();
      appendSelectOptions(
        select,
        options.map((option) => ({ value: option, label: option })),
      );
      select.value = options.includes(picked()) ? picked() : (options[0] ?? "");
      select.disabled = options.length === 0;
    }

    textarea.addEventListener("input", () => {
      node.config.options = textarea.value;
      if (picked() && !choiceOptions(node.config).includes(picked())) delete node.config.text;
      renderPick();
      deps.persistGraph();
    });
    attachPlaceholderSuggestions(textarea, () => dateChoices(new Date()));

    renderPick();
    bindExposeToggle(node, "text", "text", textLabelEl, pickField);
    wrap.append(pickField, optionsField);
    return wrap;
  }

  // An Applet node: its frame, then its file below it, so the Applet sits
  // right under the pins it drives. Exposing the node puts the Applet itself
  // in App Mode; the field it holds a value in by itself is its state, so that
  // is the id Expose marks.
  function createAppletContent(node: FlowNodeInstance): HTMLDivElement {
    const wrap = document.createElement("div");
    wrap.className = "flow-applet-content";
    const picker = pickers.createAppletPicker(node, () => deps.remount(node.id));
    bindExposeToggle(node, "state", "object", picker.target, picker.el);
    const frame = createAppletFrame(node, {
      loadFile: deps.loadFile,
      injectRuntime: deps.injectAppletRuntime,
      persist: deps.persistGraph,
      onLoaded: (file) => syncAppletNode(node, file),
    });
    appletFrames.get(node.id)?.dispose();
    appletFrames.set(node.id, frame);
    wrap.append(frame.el, picker.el);
    return wrap;
  }

  // Records what the file is now: its hash (which the save rule compares),
  // its ports, and its name for an untitled node. New ports or a new title
  // rebuild the card; the second load finds nothing to change.
  function syncAppletNode(node: FlowNodeInstance, file: AppletFileResponse): void {
    titleDescribers.get(node.id)?.(file.manifest.meta?.description?.trim() || undefined);
    const ports = file.manifest.ports ?? { inputs: [], outputs: [] };
    const portsChanged = JSON.stringify(ports) !== JSON.stringify(node.config.ports);
    const title = !node.label ? file.manifest.meta?.name?.trim() : undefined;
    if (node.config.appletHash === file.contentHash && !portsChanged && !title) return;
    node.config.appletHash = file.contentHash;
    node.config.ports = ports;
    if (title) node.label = title;
    deps.persistGraph();
    if (portsChanged || title) deps.remount(node.id);
  }

  // The drawing exposes the node's `rows` output, so it shares that pin's
  // label: exposing from either place tints the one label, and App Mode and
  // a caller outside the app both read the same exposed output.
  function createChartDrawing(node: FlowNodeInstance, rowsLabelEl: HTMLElement): HTMLDivElement {
    const view = createChartView("flow-chart", () => chartSpecFrom(node.config), "Run the flow to draw the chart");
    chartViews.get(node.id)?.dispose();
    chartViews.set(node.id, view);
    bindExposeToggle(node, "rows", "object", rowsLabelEl, view.el);
    return view.el;
  }

  // showText's display — a read-only flex:1 textarea (so a resized card
  // gives more room to actually read a long reply, not just more empty
  // padding) plus a Copy button reading straight off the textarea's own
  // value at click time. Populated on Run (run()'s result loop writes into
  // textboxEls, not this function) — starts empty, nothing to copy yet.
  function createReadOnlyTextbox(node: FlowNodeInstance): HTMLDivElement {
    const wrap = document.createElement("div");
    wrap.className = "flow-node-textbox";

    const header = document.createElement("div");
    header.className = "flow-node-textbox-header";
    header.appendChild(buildCopyButton("flow-node-textbox-copy nodrag", () => textarea.value));

    const textarea = document.createElement("textarea");
    textarea.className = "form-input flow-node-textbox-area nodrag";
    textarea.readOnly = true;
    textboxEls.set(node.id, textarea);

    wrap.append(header, textarea);
    return wrap;
  }

  // Under a reusing node's switch, once a run gives the node a result: that
  // result, a note when a Run held it, and Regenerate, which asks for another
  // and so needs a first. Every run fills it and the switch only shows it, so
  // turning Reuse result on repeat on shows the result already there.
  function createHeldView(node: FlowNodeInstance): HTMLDivElement {
    const wrap = document.createElement("div");
    wrap.className = "flow-node-held";
    const result = document.createElement("div");
    result.className = "flow-config-field";
    const label = document.createElement("label");
    label.className = "flow-config-label";
    label.textContent = "Last result";
    const textarea = document.createElement("textarea");
    textarea.className = "form-input nodrag";
    textarea.readOnly = true;
    const report = document.createElement("p");
    report.className = "flow-node-report nodrag";
    report.hidden = true;
    result.append(label, textarea, report);
    const regenerate = document.createElement("button");
    regenerate.type = "button";
    regenerate.className = "btn nodrag";
    regenerate.textContent = "Regenerate";
    regenerate.dataset.tooltip = "A new result, run on this node's last inputs";
    regenerate.addEventListener("click", () => deps.regenerate(node.id));
    wrap.append(result, regenerate);
    let held = false;
    const refresh = () => {
      wrap.hidden = node.config.reuse !== "true" || !held || contextWired(node);
      deps.onLayoutChange(node.id);
    };
    wrap.hidden = true;
    heldViews.set(node.id, {
      sync: refresh,
      show(outputs, lines) {
        held = outputs !== undefined;
        textarea.value = heldText(node, outputs);
        report.hidden = lines.length === 0;
        report.textContent = lines.join("\n");
        refresh();
      },
    });
    return wrap;
  }

  // What the model couldn't have through the node's `context` pin, shown
  // while the pin is wired, where Reuse result on repeat goes: the files
  // aren't inputs, so no repeat of its inputs says the reply would repeat.
  function createContextReport(node: FlowNodeInstance, reuseEl: HTMLElement | undefined): HTMLParagraphElement {
    const report = document.createElement("p");
    report.className = "flow-node-report nodrag";
    report.hidden = true;
    contextReports.set(node.id, report);
    sourceRefreshers.set(node.id, () => {
      const wired = contextWired(node);
      if (reuseEl) reuseEl.hidden = wired;
      if (!wired) report.hidden = true;
      heldViews.get(node.id)?.sync();
    });
    return report;
  }

  // A corner grip that sets the card's width and its height's floor (see
  // FlowNodeInstance.size in types.ts). Plain mouse events, not XYDrag: this
  // drags the card's dimensions, not its position. Carries `nodrag` so XYDrag
  // doesn't take the mousedown as a node move.
  //
  // Release saves the height the card shows, not the pointer's: dragged past
  // its content the card stops there, and a lower saved floor would let it
  // shrink on its own once the content does.
  function createResizeHandle(flowNode: FlowNodeInstance, el: HTMLDivElement): HTMLDivElement {
    const handle = document.createElement("div");
    handle.className = "corner-grip flow-node-resize-handle nodrag";
    handle.addEventListener("mousedown", (event: MouseEvent) => {
      event.stopPropagation();
      const startX = event.clientX;
      const startY = event.clientY;
      const zoom = deps.zoom();
      const startRect = el.getBoundingClientRect();
      let width = startRect.width / zoom;

      function onMove(moveEvent: MouseEvent): void {
        width = Math.max(MIN_NODE_WIDTH, startRect.width / zoom + (moveEvent.clientX - startX) / zoom);
        el.style.width = `${width}px`;
        setCardHeight(el, Math.max(0, startRect.height / zoom + (moveEvent.clientY - startY) / zoom));
        deps.onLayoutChange(flowNode.id);
      }

      function onUp(): void {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        flowNode.size = { width, height: el.offsetHeight };
        deps.persistGraph();
      }

      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
    return handle;
  }

  // Builds the DOM card from the built-in registry's port/config metadata.
  function build(flowNode: FlowNodeInstance): HTMLDivElement {
    const definition = FLOW_NODE_REGISTRY[flowNode.type];
    if (!definition) throw new Error(`Unknown node type "${flowNode.type}"`);

    const el = document.createElement("div");
    el.className = "flow-node nopan";
    el.classList.toggle("disabled", flowNode.mode === "disabled");
    el.dataset.nodeId = flowNode.id;
    el.dataset.nodeType = flowNode.type;
    if (flowNode.size) {
      el.style.width = `${flowNode.size.width}px`;
      setCardHeight(el, flowNode.size.height);
    } else {
      el.style.width = `${defaultWidth(flowNode)}px`;
    }

    const titleEl = document.createElement("div");
    titleEl.className = "flow-node-title";
    const collapseEl = document.createElement("span");
    collapseEl.className = "flow-node-collapse nodrag";
    const dotEl = document.createElement("span");
    dotEl.className = "flow-node-dot";
    collapseEl.appendChild(dotEl);
    collapseEl.addEventListener("click", (event) => {
      event.stopPropagation();
      flowNode.collapsed = !flowNode.collapsed;
      applyCollapsedState(flowNode, el, collapseEl);
      deps.onLayoutChange(flowNode.id);
      deps.persistGraph();
    });
    const nameEl = document.createElement("span");
    nameEl.className = "flow-node-name";
    nameEl.textContent = flowNode.label || definition.label;
    // Shown only on a disabled card (nodes.css), so Disable and Enable need
    // no rebuild.
    const disabledTag = document.createElement("span");
    disabledTag.className = "flow-node-disabled-tag";
    disabledTag.textContent = "Disabled";
    titleEl.append(collapseEl, nameEl, disabledTag);
    applyNodeColor(el, titleEl, flowNode.color ?? definition.defaultColor);

    // The title's tooltip says what the node gives: its type's description,
    // or its Applet's once the file is read. A renamed title no longer names
    // the type, so the tooltip leads with it.
    let appletDescription: string | undefined;
    const describeTitle = () => {
      const description = appletDescription ?? definition.description;
      const renamed = !!flowNode.label && flowNode.label !== definition.label;
      titleEl.dataset.tooltip = renamed ? `${definition.label}\n${description}` : description;
    };
    describeTitle();
    titleDescribers.set(flowNode.id, (description) => {
      appletDescription = description;
      describeTitle();
    });

    function commitRename(rawValue: string): void {
      const trimmed = rawValue.trim();
      flowNode.label = trimmed && trimmed !== definition.label ? trimmed : undefined;
      nameEl.textContent = flowNode.label || definition.label;
      describeTitle();
      deps.persistGraph();
    }

    function startRename(): void {
      const input = document.createElement("input");
      input.type = "text";
      input.className = "flow-node-name-input nodrag";
      input.value = flowNode.label || definition.label;
      nameEl.replaceWith(input);
      input.focus();
      input.select();

      let settled = false;
      const finish = (commit: boolean): void => {
        if (settled) return;
        settled = true;
        if (commit) commitRename(input.value);
        input.replaceWith(nameEl);
      };
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          finish(true);
        } else if (event.key === "Escape") {
          event.preventDefault();
          finish(false);
        }
      });
      input.addEventListener("blur", () => finish(true));
    }

    function startColor(): void {
      openColorPicker({
        anchor: titleEl,
        value: flowNode.color ?? "",
        onPick: (hex) => {
          flowNode.color = hex || undefined;
          applyNodeColor(el, titleEl, flowNode.color ?? definition.defaultColor);
          deps.persistGraph();
        },
      });
    }

    // The comment is a caption under the card (nodes.css). Its editor takes
    // the caption's place until the edit ends.
    const commentEl = document.createElement("div");
    commentEl.className = "flow-node-comment";
    const refreshComment = () => {
      commentEl.textContent = flowNode.comment ?? "";
      commentEl.hidden = !flowNode.comment;
    };
    refreshComment();

    function startComment(): void {
      const field = createWrappingField({
        value: flowNode.comment ?? "",
        label: "Comment",
        placeholder: "Say what this node is for",
        saves: "end",
        save: (text) => {
          flowNode.comment = text || undefined;
          deps.persistGraph();
        },
      });
      field.classList.add("flow-node-comment-field", "nodrag");
      const input = field.querySelector("textarea") as HTMLTextAreaElement;
      // Added after the field's own blur listener, which saves the edit.
      input.addEventListener("blur", () => {
        field.remove();
        refreshComment();
      });
      commentEl.hidden = true;
      el.append(field);
      input.focus();
      input.select();
    }

    // The node menu opens from the title only, not the whole card:
    // right-clicking a pin already means Disconnect, and the rest of the
    // card is reserved.
    titleEl.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      event.stopPropagation(); // the pane's own contextmenu handler already no-ops inside a .flow-node; this just skips the redundant work
      deps.menus.openNodeMenu(event.clientX, event.clientY, flowNode.id, startRename, startColor, startComment);
    });

    // Port rows stay outside the scrollable region below: each handle
    // deliberately bleeds a few px past its row's edge (`.handle.target`/
    // `.handle.source`, web/styles/flow/ports.css) so the connector dot sits
    // half on the card's border, and an `overflow` container would clip it.
    // Only config/result content, which never bleeds, scrolls.
    //
    // Setting only `overflow-y` doesn't escape this: it forces `overflow-x`
    // to `auto`, which also grows a spurious horizontal scrollbar.
    const bodyEl = document.createElement("div");
    bodyEl.className = "flow-node-body";
    const inputsEl = document.createElement("div");
    inputsEl.className = "flow-node-inputs";
    if (flowNode.type === "prompt") inputsEl.appendChild(createMentionInfoRow());
    const ports = nodePorts(flowNode);
    const columns = flowNode.type === ADD_ROW_NODE_TYPE ? addRowNodeConfig(flowNode.config).columns : [];
    const referenceSlots = definition.referenceSlots;
    const slotPorts = (spec: SlotSpec | undefined) =>
      spec ? Array.from({ length: spec.max }, (_, i) => spec.portId(i + 1)) : [];
    const referencePorts = new Set([...slotPorts(referenceSlots), ...slotPorts(definition.videoReferenceSlots)]);
    let pathPin: PlacedPin | undefined;
    for (const port of ports.inputs) {
      const column = columns.find((candidate) => candidate.id === port.id);
      if (column) {
        inputsEl.appendChild(createColumnPortRow(flowNode, column, port));
        continue;
      }
      if (definition.affix?.portId === port.id) {
        inputsEl.appendChild(createAffixPortRow(flowNode, port, definition.affix.whileWired === true));
        continue;
      }
      const frame = FRAME_KINDS.find((kind) => definition.framePorts?.[kind] === port.id);
      if (frame) {
        inputsEl.appendChild(createFrameRow(flowNode, frame, port));
        continue;
      }
      // A Generate node's reference pins go in as one block where the first
      // stands, only those revealed.
      if (referenceSlots && referencePorts.has(port.id)) {
        if (port.id === referenceSlots.portId(1)) {
          inputsEl.append(...createReferenceRows(flowNode, { ...referenceSlots, noun: "reference" }, inputsEl));
        }
        continue;
      }
      // templateVariables' var1-var10 are rendered separately below, only up
      // to however many slots are currently revealed — not by this generic
      // loop, which would otherwise render all TEMPLATE_VARIABLES_MAX at once.
      if (flowNode.type === "templateVariables" && port.id.startsWith("var")) continue;
      const widget = definition.inputWidgets?.find((w) => w.portId === port.id);
      const row = widget ? createWidgetPortRow(flowNode, port, widget) : createPortRow(flowNode, port, "target");
      if (port.id === definition.pathInput?.portId) pathPin = { port, row };
      inputsEl.appendChild(row);
    }
    if (flowNode.type === "templateVariables") {
      for (const i of revealedSlots(flowNode, TEMPLATE_VARIABLE_VIEW)) {
        inputsEl.appendChild(createVariablePortRow(flowNode, i, inputsEl));
      }
      inputsEl.appendChild(
        createAddSlotRow(flowNode, TEMPLATE_VARIABLE_VIEW, inputsEl, (i) =>
          createVariablePortRow(flowNode, i, inputsEl),
        ),
      );
    }
    inputsEl.append(...createMissingPinRows(flowNode, "target"));
    const outputsEl = document.createElement("div");
    outputsEl.className = "flow-node-outputs";
    // loadRow/loadRandomRow's "selected" port label, handed to their
    // pickers below so a refresh can replace the registry's generic
    // "Selected" with the loaded table's real first-column name.
    let selectedPortLabelEl: HTMLElement | undefined;
    let rowsPortLabelEl: HTMLElement | undefined;
    let textPortLabelEl: HTMLElement | undefined;
    let pathOutput: PlacedPin | undefined;
    for (const port of ports.outputs) {
      // Get Field's field1-field10 are its slot rows, rendered below.
      if (flowNode.type === "getField") continue;
      const row = createPortRow(flowNode, port, "source");
      if (port.id === "selected") selectedPortLabelEl = row.querySelector(".flow-port-label") as HTMLElement;
      if (port.id === "rows") rowsPortLabelEl = row.querySelector(".flow-port-label") as HTMLElement;
      if (port.id === "text") textPortLabelEl = row.querySelector(".flow-port-label") as HTMLElement;
      if (port.id === "path" && LOADER_TYPES.has(flowNode.type)) pathOutput = { port, row };
      outputsEl.appendChild(row);
    }
    if (flowNode.type === "getField") {
      const picker = pickers.createGetFieldPicker(flowNode);
      sourceRefreshers.set(flowNode.id, picker.refresh);
      const buildRow = (i: number) => createFieldPortRow(flowNode, i, picker, outputsEl);
      for (const i of revealedSlots(flowNode, GET_FIELD_VIEW)) outputsEl.appendChild(buildRow(i));
      outputsEl.appendChild(createAddSlotRow(flowNode, GET_FIELD_VIEW, outputsEl, buildRow));
    }
    outputsEl.append(...createMissingPinRows(flowNode, "source"));
    bodyEl.append(inputsEl, outputsEl);

    const contentEl = document.createElement("div");
    contentEl.className = "flow-node-content";

    // The file a node names, which its path pin moves beside, and a loader's
    // `path` output. Not Add Row's: the dragged Table still gives the node
    // its columns, so a wire leaves it showing and the pin stays an input.
    let pathPicker: PathPicker | undefined;
    if (flowNode.type === "loadImage") {
      pathPicker = pickers.createDropzone(flowNode);
      contentEl.appendChild(pathPicker.el);
    } else if (flowNode.type === "loadVideo") {
      // A remount builds the card again without forgetting the node first.
      clipPickers.get(flowNode.id)?.dispose();
      const clipPicker = pickers.createVideoPicker(flowNode);
      clipPickers.set(flowNode.id, clipPicker);
      pathPicker = clipPicker;
      contentEl.appendChild(clipPicker.el);
    }

    if (flowNode.type === "loadRow" && selectedPortLabelEl) {
      pathPicker = pickers.createLoadTablePicker(flowNode, selectedPortLabelEl);
      contentEl.appendChild(pathPicker.el);
    } else if (flowNode.type === "loadRandomRow" && selectedPortLabelEl) {
      pathPicker = pickers.createLoadRandomRowPicker(flowNode, selectedPortLabelEl);
      contentEl.appendChild(pathPicker.el);
    } else if (flowNode.type === "loadNote") {
      pathPicker = pickers.createLoadNotePicker(flowNode);
      contentEl.appendChild(pathPicker.el);
    } else if (flowNode.type === "writeNote" || flowNode.type === "addToNote") {
      pathPicker = pickers.createWriteNotePicker(flowNode);
      contentEl.appendChild(pathPicker.el);
    } else if (flowNode.type === "writeFolderNote") {
      pathPicker = pickers.createWriteFolderNotePicker(flowNode);
      contentEl.appendChild(pathPicker.el);
    } else if (flowNode.type === "openToSide") {
      pathPicker = pickers.createOpenToSidePicker(flowNode);
      contentEl.appendChild(pathPicker.el);
    } else if (flowNode.type === "generateImage" || flowNode.type === "generateVideo") {
      const view = pickers.createGenerationPicker(flowNode, () => deps.regenerate(flowNode.id));
      generationViews.set(flowNode.id, view);
      contentEl.appendChild(view.el);
    } else if (flowNode.type === "choice" && textPortLabelEl) {
      contentEl.appendChild(createChoiceContent(flowNode, textPortLabelEl));
    } else if (flowNode.type === "loadFolderNote") {
      pathPicker = pickers.createLoadFolderNotePicker(flowNode);
      contentEl.appendChild(pathPicker.el);
    } else if (flowNode.type === "loadFolderImage") {
      pathPicker = pickers.createLoadFolderImagePicker(flowNode);
      contentEl.appendChild(pathPicker.el);
    } else if (flowNode.type === "loadTableRows") {
      pathPicker = pickers.createLoadTableRowsPicker(flowNode);
      contentEl.appendChild(pathPicker.el);
    } else if (flowNode.type === ADD_ROW_NODE_TYPE) {
      contentEl.appendChild(createAddRowContent(flowNode));
    } else if (flowNode.type === APPLET_NODE_TYPE) {
      contentEl.appendChild(createAppletContent(flowNode));
    } else if (flowNode.type === "chart") {
      const picker = pickers.createChartPicker(flowNode);
      sourceRefreshers.set(flowNode.id, picker.refresh);
      contentEl.appendChild(picker.el);
    } else if (flowNode.type === "prompt" || flowNode.type === "comment") {
      contentEl.appendChild(createEditableTextbox(flowNode));
    } else if (definition.configFields.length > 0) {
      const configEl = document.createElement("div");
      configEl.className = "flow-node-config";
      const fieldEls = definition.configFields.map((field) => configEl.appendChild(createConfigField(flowNode, field)));
      if (definition.reuse === "optional") configEl.appendChild(createHeldView(flowNode));
      if (definition.contextPort) {
        const reuseEl = fieldEls[definition.configFields.findIndex((field) => field.key === "reuse")];
        configEl.appendChild(createContextReport(flowNode, reuseEl));
      }
      contentEl.appendChild(configEl);
    }

    if (pathPicker && pathPin) placePathPin(flowNode.id, pathPin, pathPicker);
    if (pathPicker && pathOutput) placePathOutput(pathOutput, pathPicker);

    if (flowNode.type === "showText" || flowNode.type === "showObject" || flowNode.type === "showResult") {
      contentEl.appendChild(createReadOnlyTextbox(flowNode));
    }
    if (flowNode.type === "chart" && rowsPortLabelEl)
      contentEl.appendChild(createChartDrawing(flowNode, rowsPortLabelEl));

    // Error display only: the show nodes' results live in the
    // read-only textbox above. prompt/note get no result box at all —
    // neither has inputs to inherit an upstream failure from, and neither
    // executor throws, so there is no error it could ever show.
    if (flowNode.type !== "prompt" && flowNode.type !== "comment") {
      const resultEl = document.createElement("div");
      resultEl.className = "flow-node-result";
      resultEl.hidden = true;
      contentEl.appendChild(resultEl);
      resultEls.set(flowNode.id, resultEl);
    }

    el.append(titleEl, bodyEl, contentEl, createResizeHandle(flowNode, el), commentEl);
    applyCollapsedState(flowNode, el, collapseEl);
    return el;
  }

  return {
    build,
    syncWiring(flowNode) {
      for (const port of nodePorts(flowNode).inputs) updateInputWidgetVisibility(flowNode.id, port.id);
      for (const port of nodePorts(flowNode).outputs) updateOutputHandleVisibility(flowNode.id, port.id);
      updateSourceDependents(flowNode.id);
    },
    updateInputWidgetVisibility,
    updateOutputHandleVisibility,
    updateSourceDependents,
    clearRunState(only) {
      const included = (id: string) => !only || only.includes(id);
      for (const id of resultEls.keys()) if (included(id)) showError(id, undefined);
      for (const [id, textbox] of textboxEls) if (included(id)) textbox.value = "";
      for (const [id, view] of chartViews) if (included(id)) view.show(undefined);
      for (const [id, view] of generationViews) if (included(id)) view.show(undefined, []);
      // Not the held views: emptied here, a held result would vanish and come
      // back on every Run, resizing its card each time. A run replaces it.
    },
    showRunResult(outcome, only) {
      const included = (id: string) => !only || only.includes(id);
      // Each read-only textbox shows its node's one output, by port name:
      // showText's `text` verbatim, showObject's `object` pretty-printed.
      // The indentation is the whole reason showObject exists — an object
      // wired into showText arrives as the runtime's single-line
      // JSON.stringify coercion.
      for (const [id, outputs] of outcome.outputs) {
        const textbox = textboxEls.get(id);
        if (!textbox || !included(id)) continue;
        const text = outputs.text;
        const object = outputs.object;
        if (text?.type === "text") textbox.value = text.value;
        else if (object?.type === "object") textbox.value = JSON.stringify(object.value, null, 2);
        else textbox.value = "";
      }
      for (const [id, view] of chartViews) {
        if (!included(id)) continue;
        const rows = outcome.outputs.get(id)?.rows;
        if (rows?.type === "object" && Array.isArray(rows.value)) view.show(rows.value);
      }
      for (const [id, view] of generationViews) {
        if (!included(id) || (!outcome.outputs.has(id) && !outcome.errors.has(id))) continue;
        view.show(outcome.outputs.get(id), outcome.reports?.get(id) ?? []);
      }
      for (const [id, view] of heldViews) {
        if (!included(id) || (!outcome.outputs.has(id) && !outcome.errors.has(id))) continue;
        view.show(outcome.outputs.get(id), outcome.reports?.get(id) ?? []);
      }
      for (const [id, report] of contextReports) {
        if (!included(id) || (!outcome.outputs.has(id) && !outcome.errors.has(id))) continue;
        const node = deps.graph().nodes.find((each) => each.id === id);
        const lines = node && contextWired(node) ? (outcome.reports?.get(id) ?? []) : [];
        report.hidden = lines.length === 0;
        report.textContent = lines.join("\n");
        deps.onLayoutChange(id);
      }
      for (const [id, frame] of appletFrames) {
        if (!included(id)) continue;
        const inputs = runInputs(deps.graph(), outcome, id);
        if (Object.keys(inputs).length > 0) frame.deliverInputs(inputs);
      }
      for (const [id, message] of outcome.errors)
        if (included(id)) showError(id, message, false, outcome.needs?.get(id));
      for (const [id, disabled] of outcome.skipped ?? []) {
        if (included(id)) showError(id, skippedText(deps.graph(), disabled), true);
      }
    },
    forget(nodeId) {
      chartViews.get(nodeId)?.dispose();
      chartViews.delete(nodeId);
      appletFrames.get(nodeId)?.dispose();
      appletFrames.delete(nodeId);
      textEditors.get(nodeId)?.dispose();
      textEditors.delete(nodeId);
      generationViews.get(nodeId)?.dispose();
      generationViews.delete(nodeId);
      clipPickers.get(nodeId)?.dispose();
      clipPickers.delete(nodeId);
      heldViews.delete(nodeId);
      contextReports.delete(nodeId);
      resultEls.delete(nodeId);
      textboxEls.delete(nodeId);
      sourceDependentEls.delete(nodeId);
      sourceRefreshers.delete(nodeId);
      slotAddRefreshers.delete(nodeId);
      frameRows.delete(nodeId);
      frameSyncers.delete(nodeId);
      titleDescribers.delete(nodeId);
      for (const map of [inputWidgetEls, pathPickerEls, optionalHandleEls, outputHandleEls, missingPinEls]) {
        for (const key of Array.from(map.keys())) {
          if (key.startsWith(`${nodeId}:`)) map.delete(key);
        }
      }
    },
    clear() {
      for (const view of chartViews.values()) view.dispose();
      chartViews.clear();
      for (const frame of appletFrames.values()) frame.dispose();
      appletFrames.clear();
      for (const editor of textEditors.values()) editor.dispose();
      textEditors.clear();
      for (const map of [
        resultEls,
        textboxEls,
        inputWidgetEls,
        pathPickerEls,
        optionalHandleEls,
        outputHandleEls,
        missingPinEls,
        sourceDependentEls,
        sourceRefreshers,
        slotAddRefreshers,
        frameRows,
        frameSyncers,
        titleDescribers,
        heldViews,
        contextReports,
      ]) {
        map.clear();
      }
    },
  };
}
