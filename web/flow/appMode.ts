// App mode: the published-form view of a Flow (see docs/protocol.md's App
// Mode section) — a plain form of exactly the exposed fields plus a
// draggable Run item.
//
// It reuses the graph card's field CSS and markup, and its pickers through an
// instance over App mode's own deps, but never the card's DOM-building
// helpers: those register elements in the view's per-node maps keyed by node
// id alone, so an App mode copy would silently overwrite the card's entry and
// break its widget visibility on the next edge change.

import { APPLET_NODE_TYPE } from "../../src/protocol/appletNode.ts";
import type { PortValue } from "../../src/protocol/flowExecutors.ts";
import {
  blankAsDefault,
  choiceOptions,
  FLOW_NODE_REGISTRY,
  type FlowNodeConfigField,
  type FlowNodeInputWidget,
  isFieldOutput,
  nodePorts,
  nodesLeftOut,
} from "../../src/protocol/flowNodes.ts";
import type { SetupNeed } from "../../src/protocol/setupNeed.ts";
import type {
  FlowCapabilityDeclaration,
  FlowGraph,
  FlowNodeInstance,
  FlowPort,
  FlowPortType,
} from "../../src/protocol/types.ts";
import { type AppletManifest, chartSpecFrom } from "../../src/protocol/types.ts";
import { type ChartView, createChartView } from "../chart/chartView.ts";
import type { AppletImportSource, FileResponse, SandboxReadResult, SpaceTreeNode } from "../core/apiClient.ts";
import { buildCopyButton, buildRunCount, setRunCount } from "../lib/dom.ts";
import { createInlineError } from "../lib/inlineError.ts";
import type { TileGrid, TileSize } from "../lib/tileGrid.ts";
import { createSwitch } from "../lib/toggleRow.ts";
import type { ContextMenuService } from "../services/menus.ts";
import { type AppletFrame, createAppletFrame, runInputs } from "./appletFrame.ts";
import { combinedTileSize, createAppModeGrid, TILE_SIZES } from "./appModeGrid.ts";
import { createIntStepper, createSelectControl, createSelectPicker, formLabel, regenerateHint } from "./controls.ts";
import type { FlowElements } from "./flowElements.ts";
import { flowTreePath } from "./flowPaths.ts";
import { effortFieldOf, type ModelFields, modelKindOf } from "./modelOptions.ts";
import { createPickers, folderPickKey, type PathPicker, type PickerDeps, type Pickers, sourceIn } from "./pickers.ts";
import { createResultClip, type ResultClip } from "./resultClip.ts";

const SVG_NS = "http://www.w3.org/2000/svg";

// One entry in App mode's own draggable list — either an exposed node's
// card, or the single Run item. A discriminated union rather than two
// parallel lists so reordering and rendering both walk one combined,
// already-sorted sequence instead of interleaving two sources by hand.
type AppModeItem = { kind: "node"; node: FlowNodeInstance } | { kind: "run" };

// One exposed field's control, and what it shows, which picks its default
// tile.
interface AppModeField {
  el: HTMLElement;
  kind: keyof typeof TILE_SIZES;
}

// A result's tile by its port type; any other result is text's.
const RESULT_TILES: Partial<Record<FlowPortType, AppModeField["kind"]>> = { image: "imageResult", number: "line" };

// Lowest-first; a missing order sorts last, and the stable sort keeps those
// in graph order with Run after them — "fields, then submit". A node whose
// type isn't registered is left out: the canvas doesn't mount it either, so
// here it could only be an empty card nobody can find to unexpose.
function appModeItems(graph: FlowGraph): AppModeItem[] {
  const order = (item: AppModeItem) =>
    (item.kind === "run" ? graph.runAppModeOrder : item.node.appModeOrder) ?? Number.MAX_SAFE_INTEGER;
  const items: AppModeItem[] = graph.nodes
    .filter((node) => FLOW_NODE_REGISTRY[node.type] && (node.exposed ?? []).length > 0)
    .map((node) => ({ kind: "node", node }));
  items.push({ kind: "run" });
  return items.sort((a, b) => order(a) - order(b));
}

// A plain 0-based sequence over the whole list rather than gapped
// numbering — App mode holds a handful of items, so rewriting every one is
// cheap and never needs renormalizing.
function writeAppModeOrder(graph: FlowGraph, items: AppModeItem[]): void {
  items.forEach((item, index) => {
    if (item.kind === "run") graph.runAppModeOrder = index;
    else item.node.appModeOrder = index;
  });
}

/** Gives a node whose first field was just exposed its App mode position:
 * just before Run when it exposes an input, last when it exposes only
 * outputs. Without this, once anything has been ordered, a newly exposed
 * card sorts after all of it — below Run and the results. A graph nobody
 * has ordered is left alone, so graph order still applies. */
export function placeExposedNode(graph: FlowGraph, node: FlowNodeInstance): void {
  // A stale position and tile size from an earlier Expose: the tile comes
  // back at its default size.
  delete node.appModeOrder;
  delete node.appModeSize;
  const items = appModeItems(graph).filter((item) => item.kind === "run" || item.node !== node);
  const ordered =
    graph.runAppModeOrder !== undefined ||
    items.some((item) => item.kind === "node" && item.node.appModeOrder !== undefined);
  if (!ordered) return;
  const outputs = nodePorts(node).outputs;
  const onlyOutputs = (node.exposed ?? []).every(
    (id) => outputs.some((port) => port.id === id) && !isFieldOutput(node, id),
  );
  const at = onlyOutputs ? items.length : items.findIndex((item) => item.kind === "run");
  items.splice(at, 0, { kind: "node", node });
  writeAppModeOrder(graph, items);
}

export interface AppModeDeps {
  elements: Pick<FlowElements, "pane" | "hud" | "canvasToolbar" | "appModePane">;
  // The live graph — read fresh, since the view replaces it on clear.
  graph(): FlowGraph;
  persistGraph(): void;
  saveGraphNow(): Promise<boolean>;
  // `consented` as the node card's pickers take it: only a drag from Pragma's
  // own tree is consent, never the same text dropped from another app.
  ensureCapability(capability: FlowCapabilityDeclaration, consented?: boolean): Promise<boolean>;
  read(targetPath: string): Promise<SandboxReadResult | undefined>;
  pickedImages: Map<string, { mediaType: string; data: string; name: string }>;
  directoryChildren(dirPath: string): SpaceTreeNode[] | undefined;
  // The open Flow's path, which every path a node stores is read from.
  flowPath(): string;
  modelFields: ModelFields;
  // The menu a select widget's picker opens.
  contextMenu: ContextMenuService;
  // A loaded chip's right-click, the card's own menu.
  openChipMenu: PickerDeps["openChipMenu"];
  run(): Promise<void>;
  // Regenerate: the node alone, with a new seed, on its last inputs.
  regenerate(nodeId: string): void;
  // An Applet node's file, read from the Flow's folder, and its frame's
  // markup with the node client.
  loadFile(stored: string): Promise<FileResponse>;
  injectAppletRuntime(
    html: string,
    manifest: AppletManifest,
    imports: readonly AppletImportSource[],
    state: unknown,
  ): string;
  // What the count beside Run shows: the Flow's runs, in the inspector.
  showRuns(): void;
  // Rebuilds the graph cards of nodes an App mode control edited, so they
  // show the current config instead of what they mounted with.
  remountNodes(nodeIds: string[]): void;
  // A Generate node's result file, by tree path, previewed over the pane.
  previewResult(path: string): void;
  // The context the Flow's tab is seen in.
  viewContext(): string;
}

export interface RunOutcome {
  outputs: Map<string, Record<string, PortValue | undefined>>;
  errors: Map<string, string>;
  needs?: Map<string, SetupNeed>;
}

export interface AppMode {
  isActive(): boolean;
  // Shows or hides the form; entering rebuilds it, leaving remounts the
  // cards it edited.
  setActive(active: boolean): void;
  // How many runs the count beside Run says are going.
  setRunCount(count: number): void;
  // Before a run: output fields back to their placeholder, so the form never
  // shows one run's values beside another's. Every node's, or only these.
  clearResults(only?: readonly string[]): void;
  // Populates output fields from a run's results, or its errors — whether or
  // not the form is currently showing. Every node's, or only these nodes'.
  showResults(outcome: RunOutcome, only?: readonly string[]): void;
  // Shows these nodes' fields from their config again, once a run has moved
  // a value on.
  showConfig(nodeIds: readonly string[]): void;
  // Design mode: the form's tiles arrange, its fields lock and Run waits.
  // Only while the form shows; leaving App mode ends it.
  isDesigning(): boolean;
  setDesigning(on: boolean): void;
}

export function createAppMode(deps: AppModeDeps): AppMode {
  let appModeActive = false;
  let designing = false;
  // The count beside the form's Run, while the form shows; the count is
  // kept meanwhile, for the form built next.
  let appModeRunCountEl: HTMLButtonElement | null = null;
  let runCount = 0;
  // Output fields awaiting a run's results, keyed `${nodeId}:${portId}` —
  // populated fresh every time the mode is entered.
  const appModeOutputEls = new Map<
    string,
    { el: HTMLElement; nodeId: string; portId: string; portType: FlowPortType }
  >();
  // A Chart's exposed rows, drawn, keyed by node id — rebuilt with the form
  // like appModeOutputEls.
  const appModeChartViews = new Map<string, ChartView>();
  // An exposed clip, keyed by node id, with the port it comes on: a `video`
  // output, or a Generate Video's `path`, which is what a caller outside the
  // app receives while the clip is how it reads here.
  const appModeClipViews = new Map<string, { value: HTMLElement; clip: ResultClip; port: string }>();
  const appModeAppletFrames = new Map<string, AppletFrame>();
  // Each Load picker's clean-up, a clip's player among them, run with the
  // form's.
  const appModePickers = new Set<() => void>();
  // Each reusing node's Regenerate, by node id. It shows only beside a result
  // its field shows, since it asks for another, and on a node that holds on
  // request only while it holds, so a switch edit here updates it in place.
  const appModeRegenerates = new Map<string, { button: HTMLButtonElement; node: FlowNodeInstance; shown: boolean }>();
  // How each exposed field that a run can move on shows its config again, by
  // node id: an Int's value, a Generate node's seed.
  const appModeFieldShows = new Map<string, (() => void)[]>();
  // Node ids edited via an App mode control since the mode was entered —
  // remounted on leaving, so a graph card never shows a stale value after a
  // round trip through App mode.
  const appModeDirtyNodeIds = new Set<string>();
  // The form's tiles, while it shows, and the node each tile shows.
  let appModeGrid: TileGrid | null = null;
  const appModeTileNodes = new WeakMap<HTMLElement, FlowNodeInstance>();

  // An unnamed Chart is titled by what it draws, so two charts in one form
  // don't both read "Chart". A label set on the node always wins.
  function nodeDisplayLabel(node: FlowNodeInstance): string {
    if (node.label) return node.label;
    if (node.type === "chart") {
      const { x, y } = chartSpecFrom(node.config);
      if (x && y) return `${y} by ${x}`;
    }
    return FLOW_NODE_REGISTRY[node.type]?.label || node.type;
  }

  // Every App mode field edit goes through this rather than saving
  // directly: the controls here are independent elements from the graph
  // card's, so the node is also marked for a remount on leaving — otherwise
  // its card keeps showing the value it mounted with, though config and the
  // file are right.
  function persistAppModeEdit(nodeId: string): void {
    appModeDirtyNodeIds.add(nodeId);
    deps.persistGraph();
    syncAppModeRegenerate(nodeId);
  }

  // Every checkbox-shaped App mode field is the app's switch, not the graph
  // card's cramped inline checkbox: App mode has the room for a real one.
  function buildAppModeSwitchField(
    node: FlowNodeInstance,
    key: string,
    label: string,
    description: string | undefined,
    checked: boolean,
  ): HTMLDivElement {
    const wrap = document.createElement("div");
    wrap.className = "flow-config-field checkbox";
    if (description) wrap.dataset.tooltip = description;
    const title = document.createElement("label");
    title.className = "flow-config-label";
    title.textContent = label;
    const toggle = createSwitch(label, checked, (on) => {
      node.config[key] = on ? "true" : "false";
      persistAppModeEdit(node.id);
    });
    wrap.append(title, toggle);
    return wrap;
  }

  // One output field — an output port's produced value, read-only until
  // Run populates it (appModeOutputEls, read back by run()'s own result
  // loop below). Registered under `${nodeId}:${port.id}`, the same keying
  // convention resultEls/textboxEls/outputHandleEls already use for a
  // node-scoped field.
  function buildAppModeOutputField(node: FlowNodeInstance, port: FlowPort): HTMLDivElement {
    const wrap = document.createElement("div");
    wrap.className = "flow-app-field flow-app-output";
    const label = document.createElement("label");
    label.className = "flow-config-label";
    label.textContent = formLabel(port.label);
    const value = document.createElement("div");
    value.className = "flow-app-output-value empty";
    value.textContent = "Not run yet";
    if (port.type === "image") {
      wrap.append(label, value);
    } else {
      // Same copy button as showText's graph card; the stylesheet hides it
      // while the value is still the "Not run yet" placeholder.
      const header = document.createElement("div");
      header.className = "flow-app-output-header";
      header.append(
        label,
        buildCopyButton("flow-node-textbox-copy", () => value.textContent ?? ""),
      );
      wrap.append(header, value);
    }
    const regenerate = buildAppModeRegenerate(node, port);
    if (regenerate) wrap.append(regenerate);
    appModeOutputEls.set(`${node.id}:${port.id}`, { el: value, nodeId: node.id, portId: port.id, portType: port.type });
    return wrap;
  }

  // `shown`, when given, is whether the node's result field now shows one.
  function syncAppModeRegenerate(nodeId: string, shown?: boolean): void {
    const entry = appModeRegenerates.get(nodeId);
    if (!entry) return;
    if (shown !== undefined) entry.shown = shown;
    const holds = FLOW_NODE_REGISTRY[entry.node.type]?.reuse !== "optional" || entry.node.config.reuse === "true";
    entry.button.hidden = !entry.shown || !holds;
  }

  // Regenerate sits on a reusing type's result, its first output.
  function buildAppModeRegenerate(node: FlowNodeInstance, port: FlowPort): HTMLButtonElement | undefined {
    const reuse = FLOW_NODE_REGISTRY[node.type]?.reuse;
    if (!reuse || port.id !== nodePorts(node).outputs[0]?.id) return undefined;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "btn";
    button.textContent = "Regenerate";
    button.dataset.tooltip = regenerateHint(node.type);
    button.addEventListener("click", () => deps.regenerate(node.id));
    appModeRegenerates.set(node.id, { button, node, shown: false });
    syncAppModeRegenerate(node.id);
    return button;
  }

  // A Chart's exposed rows as its drawing rather than as JSON: the rows are
  // what a caller outside the app receives, the drawing is how they read here.
  // No label, since the section's title already names the chart.
  function buildAppModeChartField(node: FlowNodeInstance): HTMLDivElement {
    const wrap = document.createElement("div");
    wrap.className = "flow-app-field flow-app-output";
    const view = createChartView(
      "flow-app-output-value flow-app-chart",
      () => chartSpecFrom(node.config),
      "Not run yet",
      { fill: true },
    );
    appModeChartViews.set(node.id, view);
    wrap.appendChild(view.el);
    return wrap;
  }

  // No label, as a chart has none: the section's title names the node.
  function buildAppModeClipField(node: FlowNodeInstance, port: FlowPort): HTMLDivElement {
    const wrap = document.createElement("div");
    wrap.className = "flow-app-field flow-app-output";
    const value = document.createElement("div");
    appModeClipViews.set(node.id, {
      value,
      clip: createResultClip("flow-app-clip", deps.previewResult, deps.contextMenu, deps.viewContext),
      port: port.id,
    });
    showAppModeClip(node.id, undefined);
    wrap.appendChild(value);
    const regenerate = buildAppModeRegenerate(node, port);
    if (regenerate) wrap.append(regenerate);
    return wrap;
  }

  // The clip at a run's `path`, or the placeholder or error in its place.
  function showAppModeClip(nodeId: string, path: string | undefined, error?: string, need?: SetupNeed): void {
    const view = appModeClipViews.get(nodeId);
    if (!view) return;
    view.clip.show(path && flowTreePath(deps.flowPath(), path));
    if (path) {
      view.value.className = "flow-app-output-value has-clip";
      view.value.replaceChildren(view.clip.el);
      return;
    }
    view.value.className = `flow-app-output-value ${error ? "error" : "empty"}`;
    view.value.replaceChildren(error ? createInlineError({ message: error, need }) : "Not run yet");
  }

  // Everything the form built that outlives its elements.
  function disposeAppModeForm(): void {
    appModeGrid?.dispose();
    appModeGrid = null;
    appModeOutputEls.clear();
    appModeRegenerates.clear();
    appModeFieldShows.clear();
    for (const view of appModeChartViews.values()) view.dispose();
    appModeChartViews.clear();
    for (const view of appModeClipViews.values()) view.clip.dispose();
    appModeClipViews.clear();
    for (const frame of appModeAppletFrames.values()) frame.dispose();
    appModeAppletFrames.clear();
    for (const dispose of appModePickers) dispose();
    appModePickers.clear();
  }

  // The Applet itself, a second instance over the same node: what it reports
  // here is saved as the card's is, and the card remounts on leaving.
  function buildAppModeAppletField(node: FlowNodeInstance): HTMLDivElement {
    const wrap = document.createElement("div");
    wrap.className = "flow-app-field flow-app-applet";
    const frame = createAppletFrame(node, {
      loadFile: deps.loadFile,
      injectRuntime: deps.injectAppletRuntime,
      persist: () => persistAppModeEdit(node.id),
      fillsTile: true,
    });
    appModeAppletFrames.set(node.id, frame);
    wrap.appendChild(frame.el);
    return wrap;
  }

  // A widget input's App mode control — the counterpart to the graph card's
  // inline widget, with the same config[port.id] storage and the same
  // widget types. A port also wired from upstream still renders and stays
  // editable here, as its card control does behind the wire —
  // config[port.id] is the one place its value lives either way.
  function buildAppModeWidgetField(
    node: FlowNodeInstance,
    port: FlowPort,
    widget: FlowNodeInputWidget,
  ): HTMLDivElement {
    const currentValue = () =>
      blankAsDefault(
        node.type,
        port.id,
        typeof node.config[port.id] === "string" ? (node.config[port.id] as string) : "",
      );

    // An input's description, as on the card. An output's stays on the card:
    // it says how the pin is wired, which App mode hides.
    if (widget.type === "checkbox") {
      return buildAppModeSwitchField(node, port.id, formLabel(port.label), port.description, currentValue() === "true");
    }

    const wrap = document.createElement("div");
    wrap.className = "flow-config-field";
    if (port.description) wrap.dataset.tooltip = port.description;
    const label = document.createElement("label");
    label.className = "flow-config-label";
    label.textContent = formLabel(port.label);
    wrap.appendChild(label);

    if (widget.type === "select") {
      const picker = createSelectPicker(deps.contextMenu, widget, currentValue(), (value) => {
        node.config[port.id] = value;
        persistAppModeEdit(node.id);
      });
      wrap.appendChild(picker);
      return wrap;
    }

    const kind = modelKindOf(widget.type);
    if (kind) {
      const persist = () => persistAppModeEdit(node.id);
      const picker = deps.modelFields.create(
        kind,
        currentValue,
        (ref) => {
          node.config[port.id] = ref;
          persist();
        },
        { effort: effortFieldOf(node, persist) },
      );
      wrap.appendChild(picker);
      return wrap;
    }

    const input = document.createElement("input");
    input.type = "text";
    input.className = "form-input";
    input.value = currentValue();
    input.placeholder = widget.placeholder ?? "";
    input.addEventListener("input", () => {
      node.config[port.id] = input.value;
      persistAppModeEdit(node.id);
    });
    wrap.appendChild(input);
    return wrap;
  }

  // A plain config field's App mode control — the counterpart to the graph
  // card's config field. Built-in nodes route their inline config through
  // widget inputs or bespoke pickers instead, but the registry shape
  // supports config fields, so App mode renders them rather than silently
  // dropping one.
  function buildAppModeConfigField(node: FlowNodeInstance, field: FlowNodeConfigField): HTMLDivElement {
    const stored = () => (typeof node.config[field.key] === "string" ? (node.config[field.key] as string) : "");
    const currentValue = stored();
    const save = (value: string) => {
      node.config[field.key] = value;
      persistAppModeEdit(node.id);
    };
    const showsAgain = (show: () => void) =>
      appModeFieldShows.set(node.id, [...(appModeFieldShows.get(node.id) ?? []), show]);

    if (field.type === "checkbox") {
      return buildAppModeSwitchField(node, field.key, field.label, field.description, currentValue === "true");
    }

    const wrap = document.createElement("div");
    wrap.className = "flow-config-field";
    if (field.description) wrap.dataset.tooltip = field.description;
    const label = document.createElement("label");
    label.className = "flow-config-label";
    label.textContent = field.label;
    wrap.appendChild(label);

    if (field.type === "integer") {
      const stepper = createIntStepper(field, stored, save);
      showsAgain(stepper.show);
      wrap.appendChild(stepper.el);
      return wrap;
    }
    if (field.type === "select") {
      wrap.appendChild(createSelectPicker(deps.contextMenu, field, currentValue, save));
      return wrap;
    }

    const control = document.createElement("input");
    control.className = "form-input";
    control.type = "text";
    control.value = currentValue;
    control.addEventListener("input", () => save(control.value));
    showsAgain(() => {
      control.value = stored();
    });
    wrap.appendChild(control);
    return wrap;
  }

  // A Prompt's text or a Choice's pick: the value the node passes on is the
  // one typed or picked here. No label, since the section's title names it.
  function buildAppModeFieldOutput(node: FlowNodeInstance): HTMLDivElement {
    const wrap = document.createElement("div");
    wrap.className = "flow-config-field";
    const current = () => (typeof node.config.text === "string" ? node.config.text : "");

    if (node.type === "choice") {
      const options = choiceOptions(node.config);
      const select = createSelectControl(
        "",
        options.map((option) => ({ value: option, label: option })),
        (value) => {
          node.config.text = value;
          persistAppModeEdit(node.id);
        },
      );
      select.value = options.includes(current()) ? current() : (options[0] ?? "");
      select.disabled = options.length === 0;
      wrap.appendChild(select);
      return wrap;
    }

    const textarea = document.createElement("textarea");
    textarea.className = "form-input";
    textarea.rows = 3;
    textarea.value = current();
    textarea.addEventListener("input", () => {
      node.config.text = textarea.value;
      persistAppModeEdit(node.id);
    });
    wrap.appendChild(textarea);
    return wrap;
  }

  // The card's own pickers over App mode's deps, so they register in none of
  // the card's maps. An edit through one marks its card for a remount on
  // leaving. A right-click offers the field's own actions, never Expose,
  // which is the canvas's: every field here is exposed already.
  function pickersFor(node: FlowNodeInstance, remount: () => void = () => {}): Pickers {
    return createPickers({
      persistGraph: () => persistAppModeEdit(node.id),
      saveGraphNow: deps.saveGraphNow,
      ensureCapability: deps.ensureCapability,
      read: deps.read,
      pickedImages: deps.pickedImages,
      directoryChildren: deps.directoryChildren,
      flowPath: deps.flowPath,
      bindExposeToggle: (_node, _id, _portType, labelEl, contextTarget = labelEl, actions = () => []) =>
        contextTarget.addEventListener("contextmenu", (event) => {
          const items = actions();
          if (items.length === 0) return;
          event.preventDefault();
          event.stopPropagation();
          deps.contextMenu.open({ at: { x: event.clientX, y: event.clientY }, ariaLabel: "Field", items });
        }),
      sourceOf: (nodeId, portId) => sourceIn(deps.graph(), nodeId, portId),
      sourceLoaded: () => {},
      openChipMenu: deps.openChipMenu,
      remount,
      // The chip says so, and the card counts it.
      fileMissing: () => {},
      layoutChanged: () => {},
      previewResult: deps.previewResult,
      contextMenu: deps.contextMenu,
      viewContext: deps.viewContext,
      showPinValues: () => {},
    });
  }

  // A Load node's file pick: the card's picker under the field's label. A
  // Clear that draws the card again draws the picker again, in place.
  function buildAppModePickerField(
    node: FlowNodeInstance,
    label: string,
    build: (pickers: Pickers) => PathPicker & { dispose?(): void },
  ): HTMLDivElement {
    const wrap = document.createElement("div");
    wrap.className = "flow-app-field";
    const labelEl = document.createElement("label");
    labelEl.className = "flow-config-label";
    labelEl.textContent = label;
    let picker = build(pickersFor(node, redraw));
    function redraw(): void {
      const next = build(pickersFor(node, redraw));
      picker.el.replaceWith(next.el);
      picker.dispose?.();
      picker = next;
    }
    appModePickers.add(() => picker.dispose?.());
    wrap.append(labelEl, picker.el);
    return wrap;
  }

  // Dispatches one exposed id to its control builder — the registry-driven
  // kinds (output port / input widget / config field), the bespoke pickers
  // Expose covers but the registry doesn't declare (see pickers.ts),
  // and a Chart's rows, drawn. Node types and keys must mirror nodeCard.ts's
  // picker dispatch exactly.
  function buildAppModeField(node: FlowNodeInstance, id: string): AppModeField | undefined {
    const definition = FLOW_NODE_REGISTRY[node.type];
    if (!definition) return undefined;
    const field = (el: HTMLElement, kind: AppModeField["kind"]): AppModeField => ({ el, kind });

    if (node.type === APPLET_NODE_TYPE && id === "state") return field(buildAppModeAppletField(node), "applet");
    if (isFieldOutput(node, id)) {
      return field(buildAppModeFieldOutput(node), node.type === "choice" ? "line" : "textBox");
    }
    const outputPort = nodePorts(node).outputs.find((p) => p.id === id);
    if (node.type === "chart" && id === "rows") return field(buildAppModeChartField(node), "chart");
    if ((node.type === "generateVideo" && outputPort?.id === "path") || outputPort?.type === "video") {
      return field(buildAppModeClipField(node, outputPort), "videoResult");
    }
    if (outputPort) {
      return field(buildAppModeOutputField(node, outputPort), RESULT_TILES[outputPort.type] ?? "textResult");
    }

    const inputPort = definition.inputs.find((p) => p.id === id);
    const widget = definition.inputWidgets?.find((w) => w.portId === id);
    if (inputPort && widget) {
      return field(buildAppModeWidgetField(node, inputPort, widget), widget.type === "checkbox" ? "toggle" : "line");
    }

    const configField = definition.configFields.find((f) => f.key === id);
    if (configField) {
      const kind = configField.type === "checkbox" ? "toggle" : "line";
      return field(buildAppModeConfigField(node, configField), kind);
    }

    if (node.type === "loadImage" && id === "imagePath") {
      return field(
        buildAppModePickerField(node, "Image", (pickers) => pickers.createDropzone(node)),
        "imagePicker",
      );
    }
    if (node.type === "loadVideo" && id === "videoPath") {
      return field(
        buildAppModePickerField(node, "Video", (pickers) => pickers.createVideoPicker(node)),
        "videoResult",
      );
    }
    // A Load Row's or a folder loader's pick is the card's dropdown alone:
    // the table or folder it picks from stays the graph's.
    if (node.type === "loadRow" && id === "selectedValue")
      return field(pickersFor(node).createRowSelect(node).el, "line");
    if (folderPickKey(node.type) === id) return field(pickersFor(node).createFolderSelect(node).el, "line");

    return undefined;
  }

  // Never a real node id (those are always `${type}-${suffix}`) — just a
  // stable, distinct key for finding the Run item in the combined list.
  const APP_MODE_RUN_ITEM_ID = "__app-mode-run__";

  function appModeItemId(item: AppModeItem): string {
    return item.kind === "run" ? APP_MODE_RUN_ITEM_ID : item.node.id;
  }

  // Moves `draggedId`'s item to just before/after `targetId`'s, rewriting
  // appModeOrder/runAppModeOrder across the whole combined list.
  function reorderAppModeItem(draggedId: string, targetId: string, zone: "before" | "after"): void {
    if (draggedId === targetId) return;
    const ordered = appModeItems(deps.graph());
    const dragged = ordered.find((item) => appModeItemId(item) === draggedId);
    if (!dragged) return;
    const rest = ordered.filter((item) => appModeItemId(item) !== draggedId);
    const targetIndex = rest.findIndex((item) => appModeItemId(item) === targetId);
    if (targetIndex === -1) return;
    rest.splice(zone === "before" ? targetIndex : targetIndex + 1, 0, dragged);
    writeAppModeOrder(deps.graph(), rest);
    deps.persistGraph();
    appModeMoveDraggedElement(draggedId, targetId, zone);
  }

  // Moves the dragged item's existing DOM node instead of rebuilding the
  // form: a rebuild empties the pane (resetting its scroll), refetches the
  // pickers' live options, drops focus and in-progress typing, and blanks
  // populated outputs back to "Not run yet". The order was already written
  // and persisted, so the DOM and the model can't drift.
  function appModeMoveDraggedElement(draggedId: string, targetId: string, zone: "before" | "after"): void {
    let draggedEl: Element | undefined;
    let targetEl: Element | undefined;
    for (const child of appModeTiles()) {
      const itemId = appModeChildItemId(child);
      if (itemId === draggedId) draggedEl = child;
      else if (itemId === targetId) targetEl = child;
    }
    if (!draggedEl || !targetEl) return; // shouldn't happen — both ids came from elements currently in this same pane
    if (zone === "before") targetEl.before(draggedEl);
    else targetEl.after(draggedEl);
  }

  function appModeTiles(): Element[] {
    return appModeGrid?.tiles() ?? [];
  }

  function appModeChildItemId(child: Element): string | undefined {
    if (!(child instanceof HTMLElement)) return undefined;
    if (child.classList.contains("flow-app-run-item")) return APP_MODE_RUN_ITEM_ID;
    if (child.classList.contains("flow-app-node")) return child.dataset.nodeId;
    return undefined;
  }

  // The inline, draggable Run tile, the only Run control while App mode is
  // active (the toolbar's hides), styled the same so it reads as the same
  // action, with the count of runs going over its foot.
  function buildAppModeRunItem(): HTMLElement {
    const tile = document.createElement("div");
    tile.className = "flow-app-run-item";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "toolbar-action primary-fill flow-run-button flow-app-run-button";
    const playIcon = document.createElementNS(SVG_NS, "svg");
    playIcon.setAttribute("viewBox", "0 0 24 24");
    playIcon.setAttribute("width", "14");
    playIcon.setAttribute("height", "14");
    playIcon.setAttribute("fill", "currentColor");
    playIcon.setAttribute("stroke", "none");
    const playPath = document.createElementNS(SVG_NS, "path");
    playPath.setAttribute("d", "M8.3 5.76Q7 5 7 6.5L7 17.5Q7 19 8.3 18.24L17.7 12.76Q19 12 17.7 11.24Z");
    playIcon.appendChild(playPath);
    const label = document.createElement("span");
    label.textContent = "Run";
    button.append(playIcon, label);
    button.addEventListener("click", () => {
      if (!designing) void deps.run();
    });
    const count = buildRunCount(deps.showRuns);
    setRunCount(count, runCount);
    appModeRunCountEl = count;
    tile.append(button, count);
    return tile;
  }

  // Only for a fresh entry into App mode — a reorder moves DOM nodes
  // instead. That keeps the replaceChildren() below safe: the group's title
  // bar moves into the pane only after the toggle returns, so on a fresh
  // entry it isn't a child yet. Rebuilding while the form is showing would
  // wipe the title bar.
  function buildAppModeForm(): void {
    // Re-entering App mode (toggle out, back in) should land back where
    // you left it, not snap to the top — replaceChildren() below empties
    // the pane for a moment, collapsing scrollHeight to ~0 and clamping
    // scrollTop down with it, so this needs restoring after.
    const scrollTop = deps.elements.appModePane.scrollTop;
    deps.elements.appModePane.replaceChildren();
    disposeAppModeForm();

    // A node a run leaves out shows no tile, yet keeps its place in the
    // order, so enabling it again brings the tile back where it was.
    const items = appModeItems(deps.graph());
    const leftOut = nodesLeftOut(deps.graph());
    const tiles = new Map<FlowNodeInstance, { el: HTMLElement; size: TileSize }>();
    for (const item of items) {
      if (item.kind !== "node" || leftOut.has(item.node.id)) continue;
      const tile = buildAppModeTile(item.node);
      if (tile) tiles.set(item.node, tile);
    }
    if (tiles.size === 0) {
      const empty = document.createElement("div");
      empty.className = "flow-app-empty";
      empty.textContent = items.some((item) => item.kind === "node")
        ? "Everything exposed is left out of a run: disabled, or fed by a disabled node."
        : "Nothing exposed yet. Right-click a port, config field, or picker in the graph and choose Expose to add it here.";
      deps.elements.appModePane.appendChild(empty);
      deps.elements.appModePane.scrollTop = scrollTop;
      return;
    }

    const grid = createAppModeGrid({
      arrangeable: designing,
      onMove: (tile, target, zone) => {
        const draggedId = appModeChildItemId(tile);
        const targetId = appModeChildItemId(target);
        if (draggedId && targetId) reorderAppModeItem(draggedId, targetId, zone);
      },
      onResize: (tile, size) => {
        const node = appModeTileNodes.get(tile);
        if (node) node.appModeSize = size;
        else deps.graph().runAppModeSize = size;
        deps.persistGraph();
      },
    });
    appModeGrid = grid;
    deps.elements.appModePane.appendChild(grid.el);
    for (const item of items) {
      const tile =
        item.kind === "run"
          ? { el: buildAppModeRunItem(), size: deps.graph().runAppModeSize ?? TILE_SIZES.run }
          : tiles.get(item.node);
      if (tile) grid.add(tile.el, tile.size);
    }
    grid.layout();
    applyDesigning();
    deps.elements.appModePane.scrollTop = scrollTop;
  }

  // Design mode is applied to the form shown, in place: building it again
  // would reload its Applets and take the group's title bar with it.
  function applyDesigning(): void {
    appModeGrid?.setArrangeable(designing);
    appModeGrid?.setGuides(designing);
    const pane = deps.elements.appModePane;
    for (const locked of pane.querySelectorAll<HTMLElement>(".flow-app-node-fields, .flow-app-toggle .toggle-switch")) {
      locked.inert = designing;
    }
    for (const run of pane.querySelectorAll<HTMLElement>(".flow-app-run-button")) {
      if (designing) run.setAttribute("aria-disabled", "true");
      else run.removeAttribute("aria-disabled");
    }
  }

  // One exposed node's tile, or nothing when none of its exposed ids builds
  // a field (a port or config key the node type no longer has) — a title
  // with nothing under it only reads as a broken form.
  function buildAppModeTile(node: FlowNodeInstance): { el: HTMLElement; size: TileSize } | undefined {
    const fields = (node.exposed ?? []).flatMap((id) => buildAppModeField(node, id) ?? []);
    if (fields.length === 0) return undefined;

    const section = document.createElement("section");
    section.className = "flow-app-node";
    section.dataset.nodeId = node.id; // same convention as .flow-node's own data-node-id
    section.dataset.nodeType = node.type; // picks the graph card's glyph
    // The graph card's color, or its type's default, read fresh on
    // every build so a colour set in the graph shows the next time App mode
    // opens.
    const color = node.color ?? FLOW_NODE_REGISTRY[node.type]?.defaultColor;
    if (color) section.style.setProperty("--node-color", color);
    const heading = document.createElement("h3");
    heading.className = "flow-app-node-title";
    const glyph = document.createElement("span");
    glyph.className = "flow-node-dot";
    const name = document.createElement("span");
    name.className = "flow-app-node-name";
    name.textContent = nodeDisplayLabel(node);
    heading.append(glyph, name);
    section.appendChild(heading);

    const only = fields.length === 1 ? fields[0] : undefined;
    const toggle = only?.kind === "toggle" ? only.el.querySelector<HTMLButtonElement>(".toggle-switch") : null;
    if (toggle) {
      bindToggleTile(section, toggle);
    } else {
      const fieldsEl = document.createElement("div");
      fieldsEl.className = "flow-app-node-fields";
      fieldsEl.append(...fields.map((field) => field.el));
      section.appendChild(fieldsEl);
      // A lone result's copy button joins the title, which names the result.
      const copy = only?.el.querySelector(".flow-node-textbox-copy");
      if (copy) heading.appendChild(copy);
    }
    appModeTileNodes.set(section, node);
    const size = node.appModeSize ?? combinedTileSize(fields.map((field) => TILE_SIZES[field.kind]));
    return { el: section, size };
  }

  // A node whose one field is a boolean is that switch: pressing anywhere on
  // the tile flips it, and the tile stays lit while it's on. A press on the
  // switch itself flips it once, through its own handler.
  function bindToggleTile(section: HTMLElement, toggle: HTMLButtonElement): void {
    section.classList.add("flow-app-toggle");
    section.querySelector(".flow-app-node-title")?.appendChild(toggle);
    const light = () => section.classList.toggle("on", toggle.getAttribute("aria-checked") === "true");
    light();
    section.addEventListener("click", (event) => {
      if (designing) return;
      if (!toggle.contains(event.target as Node)) toggle.click();
      light();
    });
  }

  function setAppModeActive(active: boolean): void {
    appModeActive = active;
    designing = false;
    // Never copied into the graph: its `appModeActive` is the Flow's default
    // view, which only setting the default writes (docs/protocol.md, Graph
    // shape). Which view shows is this install's.
    deps.elements.pane.hidden = active;
    deps.elements.hud.hidden = active;
    deps.elements.canvasToolbar.hidden = active;
    deps.elements.appModePane.hidden = !active;
    if (active) {
      buildAppModeForm();
      return;
    }
    deps.elements.appModePane.replaceChildren();
    disposeAppModeForm();
    appModeRunCountEl = null;
    // Remount every node an App mode control edited, so its graph card
    // reflects the current config rather than what it mounted with.
    if (appModeDirtyNodeIds.size > 0) {
      deps.remountNodes([...appModeDirtyNodeIds]);
      appModeDirtyNodeIds.clear();
    }
  }

  // Formats one PortValue into an output field's display, or restores its
  // "hasn't run yet" placeholder for `undefined` (a node that failed
  // upstream, or was never reached at all, e.g. an unconnected branch).
  // A picture saved as `file` previews that file on a click.
  function renderAppModeOutputValue(
    entry: { el: HTMLElement; portType: FlowPortType },
    value: PortValue | undefined,
    file?: string,
  ): void {
    const { el, portType } = entry;
    if (!value) {
      el.className = "flow-app-output-value empty";
      el.textContent = "Not run yet";
      return;
    }
    el.className = "flow-app-output-value";
    if (value.type === "video") {
      el.textContent = value.path;
      return;
    }
    if (value.type === "image") {
      el.replaceChildren();
      const img = document.createElement("img");
      img.src = `data:${value.mediaType};base64,${value.data}`;
      if (file) {
        img.classList.add("is-previewable");
        img.addEventListener("click", () => deps.previewResult(file));
      }
      el.appendChild(img);
      return;
    }
    if (portType === "object") {
      el.textContent = JSON.stringify(value.value, null, 2);
      return;
    }
    el.textContent = String(value.value);
  }

  return {
    isActive: () => appModeActive,
    setActive: setAppModeActive,
    isDesigning: () => designing,
    setDesigning(on) {
      if (!appModeActive || on === designing) return;
      designing = on;
      applyDesigning();
    },
    setRunCount(count) {
      runCount = count;
      if (appModeRunCountEl) setRunCount(appModeRunCountEl, count);
    },
    clearResults(only) {
      const included = (id: string) => !only || only.includes(id);
      for (const entry of appModeOutputEls.values()) {
        if (included(entry.nodeId)) renderAppModeOutputValue(entry, undefined);
      }
      for (const nodeId of appModeRegenerates.keys()) if (included(nodeId)) syncAppModeRegenerate(nodeId, false);
      for (const [nodeId, view] of appModeChartViews) if (included(nodeId)) view.show(undefined);
      for (const nodeId of appModeClipViews.keys()) if (included(nodeId)) showAppModeClip(nodeId, undefined);
    },
    showResults(outcome, only) {
      const included = (id: string) => !only || only.includes(id);
      for (const entry of appModeOutputEls.values()) {
        if (!included(entry.nodeId)) continue;
        const error = outcome.errors.get(entry.nodeId);
        if (error) {
          entry.el.className = "flow-app-output-value error";
          entry.el.replaceChildren(createInlineError({ message: error, need: outcome.needs?.get(entry.nodeId) }));
          continue;
        }
        // A node's `path` names the file its image is: a Generate node's
        // result, or the file a Load node read.
        const outputs = outcome.outputs.get(entry.nodeId);
        const saved = outputs?.path?.type === "text" && outputs.path.value ? outputs.path.value : undefined;
        renderAppModeOutputValue(entry, outputs?.[entry.portId], saved && flowTreePath(deps.flowPath(), saved));
      }
      for (const [nodeId, { node }] of appModeRegenerates) {
        if (!included(nodeId)) continue;
        const result = outcome.outputs.get(nodeId)?.[nodePorts(node).outputs[0]?.id ?? ""];
        syncAppModeRegenerate(nodeId, !outcome.errors.has(nodeId) && result !== undefined);
      }
      for (const [nodeId, view] of appModeChartViews) {
        if (!included(nodeId)) continue;
        const error = outcome.errors.get(nodeId);
        const rows = outcome.outputs.get(nodeId)?.rows;
        if (error) view.showError(error);
        else view.show(rows?.type === "object" && Array.isArray(rows.value) ? rows.value : undefined);
      }
      for (const [nodeId, view] of appModeClipViews) {
        if (!included(nodeId)) continue;
        const value = outcome.outputs.get(nodeId)?.[view.port];
        const path = value?.type === "video" ? value.path : value?.type === "text" ? value.value : "";
        showAppModeClip(nodeId, path || undefined, outcome.errors.get(nodeId), outcome.needs?.get(nodeId));
      }
      for (const [nodeId, frame] of appModeAppletFrames) {
        if (!included(nodeId)) continue;
        const inputs = runInputs(deps.graph(), outcome, nodeId);
        if (Object.keys(inputs).length > 0) frame.deliverInputs(inputs);
      }
    },
    showConfig(nodeIds) {
      for (const nodeId of nodeIds) for (const show of appModeFieldShows.get(nodeId) ?? []) show();
    },
  };
}
