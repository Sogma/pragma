// The space pickers a node card's config renders: loadImage's dropzone and
// the drop target of every node that loads or writes a space path, each
// with the live dropdown its node needs, plus getField's field dropdown and
// chart's column dropdowns, read from their source's document.
//
// A picker edits its node's config and asks the view, through deps, to
// persist, to read a space document (the same capability-gated read the
// executor makes at Run time), and to wire a field's Expose toggle;
// everything else is its own DOM.

import type { ClipFacts } from "../../src/protocol/api.ts";
import { formatAspectRatio } from "../../src/protocol/aspectRatio.ts";
import { type PortValue, rootPathOf } from "../../src/protocol/flowExecutors.ts";
import { FLOW_NODE_REGISTRY } from "../../src/protocol/flowNodes.ts";
import { basenameOf, formatRootedPath, isLibraryRoot, type RootedPath } from "../../src/protocol/rootedPath.ts";
import {
  CHART_TYPES,
  chartSpecFrom,
  type FlowCapabilityDeclaration,
  type FlowGraph,
  type FlowNodeInstance,
  type FlowPortType,
  isAppletFile,
  isMarkdownFile,
  isTableFile,
  notARasterImage,
  notAVideo,
  RASTER_IMAGE_MEDIA_TYPES,
  rasterImageMediaTypeForPath,
  videoMediaTypeForPath,
} from "../../src/protocol/types.ts";
import { ApiError, type SandboxReadResult, type SpaceTreeNode } from "../core/apiClient.ts";
import {
  desktopFiles,
  isEntryDrop,
  readDraggedPath,
  readDraggedSpacePath,
  stripExtension,
  tableContentsLabel,
} from "../core/paths.ts";
import { pathNames } from "../core/spaceTree.ts";
import { countText, formatFrameRate } from "../lib/dom.ts";
import { createPathLabel } from "../lib/pathLabel.ts";
import type { ContextMenuService, MenuItem } from "../services/menus.ts";
import { appendSelectOptions, createSelectControl, fillPickSelect, regenerateHint } from "./controls.ts";
import type { ChipTarget } from "./flowMenus.ts";
import { flowPickPath, flowStoredPath, flowTreePath } from "./flowPaths.ts";
import { createPickedPicture, type PickedFile, storedFile } from "./pickerHud.ts";
import { createResultClip } from "./resultClip.ts";

export interface PickerDeps {
  persistGraph(): void;
  // A checked, immediate save — needed before a read whose grant the
  // server checks against the graph as it is on disk.
  saveGraphNow(): Promise<boolean>;
  // `consented` skips the prompt for a path the writer just dragged in — the
  // drag is the consent (docs/protocol.md, Permission model). Never pass it
  // for a path that came from the saved file rather than a live gesture.
  ensureCapability(capability: FlowCapabilityDeclaration, consented?: boolean): Promise<boolean>;
  // Reads a space document for the mounted flow; undefined when none is.
  // Rejects with the server's ApiError, a 404 when nothing is at the path.
  read(targetPath: string): Promise<SandboxReadResult | undefined>;
  // loadImage's picked bytes plus the File's own name, keyed by node id —
  // ephemeral, shared with the executor.
  pickedImages: Map<string, { mediaType: string; data: string; name: string }>;
  // The space tree's direct children of a folder, or undefined for a path
  // that isn't a folder.
  directoryChildren(dirPath: string): SpaceTreeNode[] | undefined;
  // The open Flow's path: every path a node stores is read from its folder,
  // and a dropped one written from it by the scope rule.
  flowPath(): string;
  bindExposeToggle(
    node: FlowNodeInstance,
    id: string,
    portType: FlowPortType,
    labelEl: HTMLElement,
    contextTarget?: HTMLElement,
    actions?: () => MenuItem[],
  ): void;
  // The node and output port wired into one of a node's inputs.
  sourceOf(nodeId: string, portId: string): { node: FlowNodeInstance; portId: string } | undefined;
  // A loader read its document, so the nodes it feeds re-read their field
  // lists — after a first grant, or a drop of a new table.
  sourceLoaded(nodeId: string): void;
  // A loaded chip's right-click, with what its Clear does.
  openChipMenu(clientX: number, clientY: number, target: ChipTarget, clear?: () => void): void;
  // The card drawn again from its node's config, as after a Clear.
  remount(nodeId: string): void;
  // A loader's file found gone, with the read's message, which is the run's,
  // or found again (undefined). The card shows it before any run.
  fileMissing(nodeId: string, message: string | undefined): void;
  // A loader's chip or stat line changed height, moving the pins beside and
  // below it: the card is measured again, or a wire ends where its pin was.
  layoutChanged(nodeId: string): void;
  // A Generate node's result file, by tree path, previewed over the pane.
  previewResult(path: string): void;
  // Where a result clip's More options menu opens, and the context the
  // Flow's tab is seen in, which Save frame there offers its folder for.
  contextMenu: ContextMenuService;
  viewContext(): string;
  // What a loader's output dots show on hover: the facts of the file it read,
  // by output port; a port left out shows nothing.
  showPinValues(node: FlowNodeInstance, values: Record<string, string | undefined>): void;
}

// What a folder loader picks from its folder: the key it stores the pick
// under, the noun the pick goes by, its output's type, and the files it takes.
const FOLDER_PICKS: Record<
  string,
  { key: string; noun: string; portType: FlowPortType; takes(path: string): boolean }
> = {
  loadFolderNote: { key: "notePath", noun: "note", portType: "text", takes: isMarkdownFile },
  loadFolderImage: {
    key: "imagePath",
    noun: "image",
    portType: "image",
    takes: (path) => rasterImageMediaTypeForPath(path) !== undefined,
  },
};

/** The key a folder loader of `type` stores its pick under, the one Expose
 * shows; undefined for any other node type. */
export function folderPickKey(type: string): string | undefined {
  return Object.hasOwn(FOLDER_PICKS, type) ? FOLDER_PICKS[type].key : undefined;
}

/** A loader's dropdown of what it picks, and its refresh for when what it
 * picks from changes. */
export interface LoaderSelect extends PathPicker {
  refresh(consented?: boolean): void | Promise<void>;
}

/** The node and output port wired into `nodeId`'s input `portId`, as every
 * surface that builds pickers answers PickerDeps' `sourceOf`. */
export function sourceIn(
  graph: FlowGraph,
  nodeId: string,
  portId: string,
): { node: FlowNodeInstance; portId: string } | undefined {
  const edge = graph.edges.find((e) => e.target === nodeId && e.targetPort === portId);
  const node = edge && graph.nodes.find((n) => n.id === edge.source);
  return edge && node ? { node, portId: edge.sourcePort } : undefined;
}

export interface Pickers {
  createDropzone(node: FlowNodeInstance): PathPicker;
  createVideoPicker(node: FlowNodeInstance): ClipPicker;
  createLoadTablePicker(node: FlowNodeInstance, selectedLabelEl: HTMLElement): PathPicker;
  createLoadRandomRowPicker(node: FlowNodeInstance, selectedLabelEl: HTMLElement): PathPicker;
  createLoadNotePicker(node: FlowNodeInstance): PathPicker;
  createWriteNotePicker(node: FlowNodeInstance): PathPicker;
  createWriteFolderNotePicker(node: FlowNodeInstance): PathPicker;
  createOpenToSidePicker(node: FlowNodeInstance): PathPicker;
  createLoadTableRowsPicker(node: FlowNodeInstance): PathPicker;
  createAddRowPicker(node: FlowNodeInstance, onChosen: () => void): AddRowPicker;
  createFolderPicker(node: FlowNodeInstance): PathPicker;
  // The dropdown alone of the value a Load Row or a folder loader exposes,
  // as App Mode shows it, with no chip naming the table or folder.
  createRowSelect(node: FlowNodeInstance): LoaderSelect;
  createFolderSelect(node: FlowNodeInstance): LoaderSelect;
  createGenerationPicker(node: FlowNodeInstance, onRegenerate: () => void): GenerationView;
  createGetFieldPicker(node: FlowNodeInstance): FieldPicker;
  createChartPicker(node: FlowNodeInstance): ChartPicker;
  createAppletPicker(node: FlowNodeInstance, onChosen: () => void): AppletPicker;
}

/** A Generate Image or Generate Video node's results folder, its last
 * result, and Regenerate. */
export interface GenerationView {
  el: HTMLDivElement;
  // A run's outputs, or none, and the lines the run reported under them.
  show(outputs: Record<string, PortValue | undefined> | undefined, lines: readonly string[]): void;
  dispose(): void;
}

/** A Load Video node's clip: the file it names, and the player it plays in,
 * which `dispose` lets go of when the card goes. */
export interface ClipPicker extends PathPicker {
  dispose(): void;
}

/** The file a node names: the wrapper to mount, and the element showing the
 * file, its drop target or a folder loader's pick. A path pin sits left of
 * it, its wire standing in for the target, and a loader's `path` output
 * right of it. */
export interface PathPicker {
  el: HTMLDivElement;
  target: HTMLElement;
}

/** An Add Row node's Table: the drop target, and the stat line beneath it
 * that the card fills once it has read the Table. */
export interface AddRowPicker {
  el: HTMLDivElement;
  describe(columns: number, rows: number): void;
  setDetail(text: string): void;
  // A Table with nothing at its path, as a loader's chip shows one.
  setMissing(message: string): void;
}

/** An Applet node's file: the wrapper to mount, and the drop target itself,
 * the element Expose tints. */
export interface AppletPicker {
  el: HTMLDivElement;
  target: HTMLElement;
}

/** getField's per-slot key controls over one shared field list. */
export interface FieldPicker {
  // Slot N's control, filled from the last-read list at once.
  control(slot: number): HTMLElement;
  forget(slot: number): void;
  // Re-reads the list; the card calls it whenever an edge into the node changes.
  refresh(): void;
}

/** chart's type and column controls, over its rows' column list. */
export interface ChartPicker {
  el: HTMLDivElement;
  // Re-reads the columns; the card calls it whenever an edge into the node changes.
  refresh(): void;
}

/** One key picked from a source's keys: a dropdown when they're known, a text
 * box when they aren't. A stored key the source no longer has stays selected
 * and marked, never repointed, since another key would read a wrong value
 * silently. */
interface KeyControl {
  el: HTMLElement;
  render(value: string, keys: string[] | undefined): void;
}

function createKeyControl(save: (value: string) => void, placeholder: string, emptyLabel: string): KeyControl {
  const el = document.createElement("span");
  el.className = "flow-field-key";
  const select = createSelectControl("", [], save);
  const input = document.createElement("input");
  input.type = "text";
  input.className = "form-input nodrag";
  input.placeholder = placeholder;
  input.addEventListener("input", () => save(input.value));
  el.append(select, input);
  // What the select was last filled with: rebuilding an open dropdown's
  // options closes it, so an unchanged list is left alone.
  let shownOptions = "";
  return {
    el,
    render(value, keys) {
      select.hidden = keys === undefined;
      input.hidden = keys !== undefined;
      if (keys === undefined) {
        input.value = value;
        return;
      }
      const options = keys.map((key) => ({ value: key, label: key }));
      if (value === "") options.unshift({ value: "", label: emptyLabel });
      else if (!keys.includes(value)) options.unshift({ value, label: `${value} (missing)` });
      const signature = JSON.stringify(options);
      if (signature !== shownOptions) {
        shownOptions = signature;
        select.replaceChildren();
        appendSelectOptions(select, options);
      }
      select.value = value;
    },
  };
}

/** The one muted stat line a picker shows under its drop zone to say what it
 * actually loaded — a table's rows and columns, a note's word/character count.
 * One element and one class (`.flow-node-detail`, web/styles/flow/widgets.css)
 * so pickers never drift into per-picker type scales.
 *
 * Starts hidden and re-hides on `clear()`: every failure path (no path yet,
 * grant refused, unreadable file, a fresh drop replacing an old preview)
 * goes through it, so a stale number can't outlive what it described. */
function createDetailLine(): { el: HTMLDivElement; set: (text: string) => void; clear: () => void } {
  const el = document.createElement("div");
  el.className = "flow-node-detail";
  el.hidden = true;
  return {
    el,
    set: (text) => {
      el.textContent = text;
      el.hidden = text === "";
    },
    clear: () => {
      el.hidden = true;
    },
  };
}

type DropTargetKind = "markdown" | "table" | "folder" | "applet" | "image" | "file";

interface SpaceDropTarget {
  // The drop target, then the stat line beneath it.
  elements: HTMLElement[];
  // Shows the chip for `path`; an empty path goes back to the empty prompt.
  setPath(path: string): void;
  // Shows the chip for a file picked from outside the space, by its name.
  setUnstored(name: string): void;
  setDetail(text: string): void;
  // Marks the chip red and hands on `message`, the read's own, until a new
  // path or stat line takes both back.
  setMissing(message: string): void;
  // A refusal or error, shown in place of the chip for a few seconds.
  showMessage(message: string): void;
  onDrop(handler: (event: DragEvent) => void): void;
  // Lets `area` take the chip's drops too: a drag over it marks it and has
  // the chip say what a drop does, and a drop runs the chip's handler.
  addDropArea(area: HTMLElement): void;
  // The chip menu's Clear: what the node forgets with its path.
  onClear(handler: () => void): void;
}

const MESSAGE_MS = 4000;

/** The drop target of every node that loads one space path: an empty prompt
 * until a path is set, then a solid chip showing that path, so a loaded node
 * doesn't read as empty. Dropping onto the chip replaces it, and the chip
 * itself says so while a drag is over it.
 *
 * The path, never the document's own title or name: two documents can share
 * one, and the path is what the node stores and Run reads. It is drawn as
 * every path in running text is, the whole of it in the chip's tooltip.
 *
 * A loader's target is told where to hand on a path it reads and finds
 * nothing at, and when it changes height. */
function createSpaceDropTarget(
  kind: DropTargetKind,
  emptyText: string,
  deps: Pick<PickerDeps, "openChipMenu" | "flowPath">,
  loader?: { fileMissing(message: string | undefined): void; layoutChanged(): void },
): SpaceDropTarget {
  const el = document.createElement("div");
  el.className = "flow-dropzone flow-space-drop nodrag";

  // A card is measured once it is placed, so only a placed one is told.
  function relayout(): void {
    if (el.isConnected) loader?.layoutChanged();
  }

  let pathEl = document.createElement("span");
  const unstoredNote = document.createElement("span");
  unstoredNote.className = "flow-space-drop-note";
  unstoredNote.textContent = "not stored";

  const detail = createDetailLine();

  let path = "";
  let unstored = "";
  let missing = false;
  let messageTimer: ReturnType<typeof setTimeout> | undefined;

  function render(): void {
    clearTimeout(messageTimer);
    el.classList.toggle("loaded", path !== "" || unstored !== "");
    if (path !== "") {
      el.dataset.tooltip = flowTreePath(deps.flowPath(), path);
      el.replaceChildren(pathEl);
    } else if (unstored !== "") {
      el.dataset.tooltip = "Picked from this computer, not stored in the space";
      el.replaceChildren(pathEl, unstoredNote);
    } else {
      el.removeAttribute("title");
      el.replaceChildren(emptyText);
    }
    relayout();
  }

  // Takes back only a message it handed on: the card shows that message in
  // the line a run's failure takes, and a run's own failure stays there until
  // the next run, as it does on any card.
  function markMissing(message: string | undefined): void {
    if (message === undefined && !missing) return;
    missing = message !== undefined;
    el.classList.toggle("missing", missing);
    loader?.fileMissing(message);
  }

  // An area keeps its children's pointer events, as a player's controls
  // need, so a drag crossing one fires dragleave on the area: only leaving
  // the area ends its drag-over state.
  let dropHandler: ((event: DragEvent) => void) | undefined;
  function takeDrops(area: HTMLElement): void {
    const mark = (over: boolean) => {
      el.classList.toggle("drag-over", over);
      area.classList.toggle("drag-over", over);
    };
    area.addEventListener("dragover", (event) => {
      event.preventDefault();
      mark(true);
    });
    area.addEventListener("dragleave", (event) => {
      if (!area.contains(event.relatedTarget as Node | null)) mark(false);
    });
    area.addEventListener("drop", (event) => {
      event.preventDefault();
      mark(false);
      dropHandler?.(event);
    });
  }
  takeDrops(el);
  // The empty prompt and a file picked from the computer name nothing in
  // the space to open, so they get no menu.
  let clear: (() => void) | undefined;
  el.addEventListener("contextmenu", (event) => {
    if (path === "") return;
    event.preventDefault();
    event.stopPropagation();
    const shown = flowTreePath(deps.flowPath(), path);
    deps.openChipMenu(event.clientX, event.clientY, kind === "folder" ? { folder: shown } : { file: shown }, clear);
  });

  return {
    elements: [el, detail.el],
    setPath: (next) => {
      path = next;
      unstored = "";
      const type = kind === "folder" ? "directory" : "file";
      pathEl = createPathLabel(flowTreePath(deps.flowPath(), next), pathNames, { type });
      markMissing(undefined);
      detail.clear();
      render();
    },
    setUnstored: (fileName) => {
      path = "";
      unstored = fileName;
      pathEl = createPathLabel(fileName, pathNames, { type: "file" });
      markMissing(undefined);
      detail.clear();
      render();
    },
    setDetail: (text) => {
      markMissing(undefined);
      detail.set(text);
      relayout();
    },
    setMissing: (message) => {
      detail.clear();
      markMissing(message);
      relayout();
    },
    showMessage: (message) => {
      clearTimeout(messageTimer);
      el.classList.remove("loaded");
      el.replaceChildren(message);
      relayout();
      messageTimer = setTimeout(render, MESSAGE_MS);
    },
    onDrop: (handler) => {
      dropHandler = handler;
    },
    addDropArea: takeDrops,
    onClear: (handler) => {
      clear = handler;
    },
  };
}

// A read's 404: nothing at the path, as after its file moved or went. Its
// message is the one a run reports for the same path.
// A length in seconds, or a size in pixels, to at most three decimals.
const measure = (value: number | null, unit: string): string | undefined =>
  value === null ? undefined : `${Number(value.toFixed(3))} ${unit}`;

/** What a Load Video's output dots show for the clip it read, by port. The
 * `video` dot shows nothing: it hands on a clip, never text. */
function clipPinValues(clip: ClipFacts, name: string, path: string): Record<string, string | undefined> {
  const { width, height, duration, frameRate, variableFrameRate } = clip;
  return {
    name,
    width: measure(width, "px"),
    height: measure(height, "px"),
    aspect_ratio: width !== null && height !== null ? formatAspectRatio(width, height) : undefined,
    duration: measure(duration, "s"),
    fps: formatFrameRate({ codec: null, frameRate, variableFrameRate }),
    path,
  };
}

/** What a Load Image's output dots show for the picture it read, by port;
 * `path` is blank for a picture picked from the computer. The `image` dot
 * shows nothing: it hands on a picture, never text. */
function picturePinValues(
  picture: { width: number; height: number },
  name: string,
  path: string,
): Record<string, string | undefined> {
  const { width, height } = picture;
  return {
    name,
    width: `${width} px`,
    height: `${height} px`,
    aspect_ratio: formatAspectRatio(width, height),
    path: path || undefined,
  };
}

function isMissingFile(error: unknown): error is ApiError {
  return error instanceof ApiError && error.status === 404;
}

/** "1,972 words · 14,042 chars" for a note's raw content — raw on purpose,
 * frontmatter included, because that is exactly the string loadNote's `raw`
 * output sends downstream. "chars" rather than "characters" so the line
 * fits a default-width node card without wrapping. */
function describeNoteContent(content: string): string {
  const trimmed = content.trim();
  const words = trimmed === "" ? 0 : trimmed.split(/\s+/).length;
  return `${countText(words, "word")} · ${content.length.toLocaleString()} chars`;
}

export function createPickers(deps: PickerDeps): Pickers {
  // While a wire brings the node's path, the dragged one goes unused, so a
  // picker doesn't read it to describe it: that read would ask for a file
  // no run touches.
  function pathWired(node: FlowNodeInstance): boolean {
    const portId = FLOW_NODE_REGISTRY[node.type]?.pathInput?.portId;
    return portId !== undefined && deps.sourceOf(node.id, portId) !== undefined;
  }

  // A stored path as the tree spells it, read from the Flow's folder.
  const shown = (stored: string): string => flowTreePath(deps.flowPath(), stored);
  // Whether a node's stored path names the entry `next` does, however each
  // is written.
  const samePath = (stored: unknown, next: string): boolean =>
    typeof stored === "string" && shown(stored) === shown(next);

  // An entry dropped on a node as the node stores it: written from the
  // Flow's folder by the scope rule.
  function dropPath(target: RootedPath, folder = false): string {
    return flowStoredPath(deps.flowPath(), target, folder);
  }

  // A space entry dropped on a node, as it stores it; undefined after
  // refusing a library's.
  function readDrop(event: DragEvent, refuse: (message: string) => void, folder = false): string | undefined {
    const path = readDraggedSpacePath(event, refuse);
    return path === undefined ? undefined : dropPath({ root: "space", path }, folder);
  }

  // A dropped folder, as the node stores it; undefined after refusing a
  // file, or a library's folder where the node takes only the space's. With
  // `library`, a library folder is let through unchecked: the tree the
  // check reads holds the space alone, so the server checks one at run time.
  function readFolderDrop(event: DragEvent, target: SpaceDropTarget, library = false): string | undefined {
    const dragged = library ? readDraggedPath(event) : undefined;
    if (dragged && isLibraryRoot(dragged.root)) return dropPath(dragged, true);
    const path = readDrop(event, target.showMessage, true);
    if (path === undefined) return undefined;
    if (!deps.directoryChildren(shown(path))) {
      target.showMessage(`Not a folder: ${shown(path)}`);
      return undefined;
    }
    return path;
  }

  function loaderTarget(node: FlowNodeInstance, kind: DropTargetKind, emptyText: string): SpaceDropTarget {
    return createSpaceDropTarget(kind, emptyText, deps, {
      fileMissing: (message) => deps.fileMissing(node.id, message),
      layoutChanged: () => deps.layoutChanged(node.id),
    });
  }

  // A chip's Clear: the chip goes back to its prompt, which takes back a
  // missing file's report, and the node forgets its path and what came with
  // it. Drawing the card again resets whatever was read from that file.
  function clearsTo(node: FlowNodeInstance, target: SpaceDropTarget, forget: () => void, redraw = true): void {
    target.onClear(() => {
      target.setPath("");
      forget();
      deps.persistGraph();
      if (redraw) deps.remount(node.id);
    });
  }

  // loadImage's card. Only a tree drag fills the path box and persists
  // `config.imagePath`, read through the gated broker for the preview and
  // again at Run; an OS pick or drop stays ephemeral and clears any stored
  // path, or the card would preview the new image while Run read the old.
  //
  // The tree can be a library's too — the only picker that takes a library
  // path (see flowNodes.ts's loadImage entry), declaring the same read for
  // either root.
  function createDropzone(node: FlowNodeInstance): PathPicker {
    const wrap = document.createElement("div");
    wrap.className = "flow-node-image-picker";

    const zone = document.createElement("div");
    zone.className = "flow-dropzone nodrag";
    zone.textContent = "Click or drop an image";

    const input = document.createElement("input");
    input.type = "file";
    input.accept = RASTER_IMAGE_MEDIA_TYPES.join(",");
    input.hidden = true;
    zone.appendChild(input);

    // The file the node holds, named by every Load node's chip. Hidden while
    // nothing is picked: the zone under it says so already.
    //
    // The path pins sit on the chip's row, so it shows or hides before it
    // renders: rendering is what has the card measure the pins again.
    const location = loaderTarget(node, "image", "");
    const [chip] = location.elements;
    function showLocation(storedPath: string, unstoredName = ""): void {
      chip.hidden = !storedPath && !unstoredName;
      if (unstoredName) location.setUnstored(unstoredName);
      else location.setPath(storedPath);
    }

    // Offered while a picture shows: an optional image left set would
    // otherwise go with every run.
    function clear(): void {
      deps.pickedImages.delete(node.id);
      zone.replaceChildren("Click or drop an image", input);
      deps.showPinValues(node, {});
      showLocation("");
      if (node.config.imagePath !== undefined) {
        node.config.imagePath = undefined;
        deps.persistGraph();
      }
    }

    // A picture from the computer has no file to preview, so it says so to
    // the pointer (widgets.css). The output dots take its size once decoded.
    function showPreview(dataUrl: string, file: PickedFile, pins: { name: string; path: string }, stored = true): void {
      const { el, img } = createPickedPicture(dataUrl, file);
      el.classList.toggle("unstored", !stored);
      zone.replaceChildren(el, input);
      deps.showPinValues(node, {});
      img.addEventListener("load", () => {
        const { naturalWidth: width, naturalHeight: height } = img;
        if (!width || !height) return;
        deps.showPinValues(node, picturePinValues({ width, height }, pins.name, pins.path));
      });
    }

    // The zone and the chip take the same drops, and the chip says why one is
    // refused while it names a file: in the zone the message would take the
    // place of a picture the node still holds and Run still reads. With
    // nothing picked the chip is hidden, so the zone's prompt says it.
    function refuse(message: string): void {
      if (chip.hidden) zone.replaceChildren(message, input);
      else location.showMessage(message);
    }

    function handleFile(file: File): void {
      if (!(RASTER_IMAGE_MEDIA_TYPES as readonly string[]).includes(file.type)) {
        refuse(`Unsupported type: ${file.type || "unknown"}`);
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = typeof reader.result === "string" ? reader.result : "";
        const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
        deps.pickedImages.set(node.id, { mediaType: file.type, data: base64, name: file.name });
        const pins = { name: stripExtension(file.name), path: "" };
        showPreview(dataUrl, { name: file.name, size: file.size }, pins, false);
        showLocation("", file.name);
        if (node.config.imagePath !== undefined) {
          node.config.imagePath = undefined;
          deps.persistGraph();
        }
      };
      reader.readAsDataURL(file);
    }

    // Reads a persisted or freshly dragged path through the gated broker the
    // executor uses. The declaration comes from the shared flowNodes.ts
    // helper so the key requested here is the one the saved graph derives;
    // deriving it locally would let the two disagree, which reads as an
    // Allow that changes nothing.
    async function loadFromPath(storedPath: string, consented = false): Promise<void> {
      // Shown before any run, in the words the run fails with.
      if (!rasterImageMediaTypeForPath(storedPath)) {
        zone.textContent = notARasterImage(storedPath);
        return;
      }
      const granted = await deps.ensureCapability({ type: "readFile", path: storedPath }, consented);
      if (!granted) return;
      try {
        const result = await deps.read(storedPath);
        if (result?.kind !== "image") return;
        deps.pickedImages.delete(node.id);
        const pins = { name: stripExtension(basenameOf(storedPath)), path: rootPathOf(deps.flowPath(), storedPath) };
        showPreview(`data:${result.mediaType};base64,${result.data}`, storedFile(shown(storedPath), result.data), pins);
      } catch (error) {
        if (isMissingFile(error)) {
          // An earlier picture would stand for a file Run can't read.
          zone.replaceChildren("Click or drop an image", input);
          deps.showPinValues(node, {});
          location.setMissing(error.message);
        } else {
          zone.textContent = error instanceof Error ? error.message : "Couldn't load that image.";
        }
      }
    }

    function pickStoredPath(storedPath: string, consented: boolean): void {
      node.config.imagePath = storedPath;
      showLocation(storedPath);
      deps.persistGraph();
      void (async () => {
        // Recording the grant right after this edit needs the on-disk
        // graph to already declare it.
        if (!(await deps.saveGraphNow())) {
          zone.textContent = "Couldn't save before requesting permission.";
          return;
        }
        // A drag from Pragma's own tree named this exact file; any other
        // drop asks first.
        await loadFromPath(storedPath, consented);
      })();
    }

    function takeDrop(event: DragEvent): void {
      const [file] = desktopFiles(event);
      if (file) {
        handleFile(file);
        return;
      }
      // The whole rooted string, not just its path half: `config.imagePath`
      // has to keep naming the root it came from, or the same filename in a
      // library and in the space would store identically and read back as
      // whichever one the resolver happened to find.
      const dragged = readDraggedPath(event);
      if (!dragged) return;
      if (!rasterImageMediaTypeForPath(dragged.path)) {
        refuse(`Not a raster image: ${formatRootedPath(dragged)}`);
        return;
      }
      pickStoredPath(dropPath(dragged), isEntryDrop(event));
    }

    // A click on the picture previews the file the chip names, and one on
    // the prompt opens the computer's picker, which the picture's right-click
    // offers too. The picker's own click bubbles here and is no one's.
    zone.addEventListener("click", (event) => {
      if (event.target === input) return;
      if (!zone.querySelector(".flow-picture")) {
        input.click();
        return;
      }
      const storedPath = typeof node.config.imagePath === "string" ? node.config.imagePath : "";
      if (storedPath) deps.previewResult(shown(storedPath));
    });
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (file) handleFile(file);
    });
    location.onDrop(takeDrop);
    location.addDropArea(zone);

    const storedPath = typeof node.config.imagePath === "string" ? node.config.imagePath : "";
    showLocation(storedPath);
    if (storedPath && !pathWired(node)) void loadFromPath(storedPath);

    // No separate label here (unlike the pickers above) — the dropzone box
    // itself is the field, so the exposed tint lands on its own border
    // instead of a label's text color (`.flow-dropzone.exposed.*`,
    // web/styles/flow/config.css). The "Load Image drop" case this feature was built around.
    location.onClear(clear);
    deps.bindExposeToggle(node, "imagePath", "image", zone, zone, () =>
      zone.querySelector(".flow-picture")
        ? [
            { label: "Choose image…", run: () => input.click() },
            { label: "Clear", run: clear },
          ]
        : [],
    );

    wrap.append(chip, zone);
    return { el: wrap, target: chip };
  }

  // loadVideo's card: a drag from the tree, the space's or a library's,
  // stores `config.videoPath`, and the clip plays under it. Nothing from the
  // computer: a run hands a clip on by reference, so it has to be a file the
  // host can read.
  function createVideoPicker(node: FlowNodeInstance): ClipPicker {
    const wrap = document.createElement("div");
    wrap.className = "flow-node-config";
    const target = loaderTarget(node, "file", "Drag a clip from your space here");
    const clip = createResultClip("flow-node-video-result", deps.previewResult, deps.contextMenu, deps.viewContext);
    const stored = () => (typeof node.config.videoPath === "string" ? node.config.videoPath : "");
    target.setPath(stored());
    clearsTo(node, target, () => delete node.config.videoPath);

    // Reads the clip's facts only to describe it, or to say it's gone, under
    // the capability the run checks. A drag from the tree is its own consent,
    // so only a clip named by the saved file, or one whose grant was revoked,
    // prompts.
    async function refresh(consented = false): Promise<void> {
      const path = stored();
      clip.show(path ? shown(path) : undefined);
      clip.showFacts(undefined);
      deps.showPinValues(node, {});
      if (!path || pathWired(node)) return;
      if (!(await deps.ensureCapability({ type: "readFile", path }, consented))) return;
      try {
        const result = await deps.read(path);
        if (result?.kind !== "video") return;
        clip.showFacts(result);
        const name = stripExtension(basenameOf(path));
        deps.showPinValues(node, clipPinValues(result, name, rootPathOf(deps.flowPath(), path)));
      } catch (error) {
        if (!isMissingFile(error)) {
          target.showMessage(error instanceof Error ? error.message : "Couldn't read that clip.");
          return;
        }
        clip.show(undefined);
        target.setMissing(error.message);
      }
    }

    target.onDrop((event) => {
      if (desktopFiles(event).length > 0) {
        target.showMessage("Add the clip to your space first, then drag it from the tree");
        return;
      }
      // The whole rooted string, so a library's clip keeps naming its library.
      const dragged = readDraggedPath(event);
      if (!dragged) return;
      if (!videoMediaTypeForPath(dragged.path)) {
        target.showMessage(notAVideo(formatRootedPath(dragged)));
        return;
      }
      const consented = isEntryDrop(event);
      const path = dropPath(dragged);
      node.config.videoPath = path;
      target.setPath(path);
      deps.persistGraph();
      void (async () => {
        // The grant is checked against the graph on disk, so this edit has to
        // land there first.
        if (await deps.saveGraphNow()) await refresh(consented);
      })();
    });
    // The clip is most of the card, so it takes the chip's drops too. Here and
    // not in the shared player: a Generate Video result plays in that player,
    // and a result is never a pick.
    target.addDropArea(clip.el);
    deps.bindExposeToggle(node, "videoPath", "video", target.elements[0], target.elements[0]);
    void refresh();

    // The clip's facts are on its hover bar, so the chip takes no stat line.
    const [chip] = target.elements;
    wrap.append(chip, clip.el);
    return { el: wrap, target: chip, dispose: clip.dispose };
  }

  // A Load Row's "Select <column>" dropdown over its table's first column,
  // the value Expose shows: App Mode builds it alone, the card under the chip
  // naming the table. Neither `tablePath` nor `selectedValue` is in
  // configFields, and editing one refreshes the other.
  //
  // `card` hears what the read found: the chip says what the table holds or
  // that it's gone, and `renamed` hands the first column's label to the
  // "selected" output port. Only the label changes, the port id stays
  // "selected", so no edge's `sourcePort` breaks.
  function createRowSelect(
    node: FlowNodeInstance,
    card?: { chip: SpaceDropTarget; renamed(label: string): void },
  ): LoaderSelect {
    const selectField = document.createElement("div");
    selectField.className = "flow-config-field";
    const selectLabel = document.createElement("label");
    selectLabel.className = "flow-config-label";
    // "Select" alone until the loaded table's first column is known, then
    // "Select <column>", a verb, since this label sits over the dropdown
    // that does the picking rather than naming a value already picked.
    selectLabel.textContent = "Select";
    const select = createSelectControl("", [], (value) => {
      node.config.selectedValue = value;
      deps.persistGraph();
    });
    select.disabled = true;
    selectField.append(selectLabel, select);
    // The picked row's own display value is a real value by itself, unlike
    // tablePath, just a pointer to which table to read.
    deps.bindExposeToggle(node, "selectedValue", "text", selectLabel, selectField);

    // Re-reads the table at tablePath and refills the dropdown from its
    // first column. The editor's own read goes through the capability the
    // executor checks at Run (the server can't tell an editing read from a
    // running one), so picking a table can prompt right away.
    async function refresh(consented = false): Promise<void> {
      const path = typeof node.config.tablePath === "string" ? node.config.tablePath : "";
      select.replaceChildren();
      select.disabled = true;
      // Every early return below leaves both labels at their generic
      // fallback rather than a stale column name from an earlier table.
      card?.renamed("selected");
      selectLabel.textContent = "Select";
      if (!path) return;
      const granted = await deps.ensureCapability({ type: "readFile", path }, consented);
      if (!granted) return;
      try {
        const result = await deps.read(path);
        if (result?.kind !== "table") return;
        card?.chip.setDetail(tableContentsLabel(result.columns.length, result.rows.length));
        deps.sourceLoaded(node.id);
        if (result.columns.length === 0 || result.rows.length === 0) return;
        const columnId = result.columns[0].id;
        card?.renamed(result.columns[0].label || "selected");
        selectLabel.textContent = `Select ${result.columns[0].label || "row"}`;
        const stored = typeof node.config.selectedValue === "string" ? node.config.selectedValue : "";
        const options = result.rows.map((row) => {
          const value = row.values[columnId] ?? "";
          return { value, label: value || "(empty)" };
        });
        const picked = fillPickSelect(select, options, stored, stored);
        select.disabled = false;
        if (picked !== undefined) {
          node.config.selectedValue = picked;
          deps.persistGraph();
        }
      } catch (error) {
        // Unreadable, malformed, or not actually a table: left disabled with
        // no options; dragging a different table in is the only fix.
        if (isMissingFile(error)) card?.chip.setMissing(error.message);
      }
    }

    void refresh();
    return { el: selectField, target: select, refresh };
  }

  // loadRow's card: a drag-only drop target naming the table, over its
  // "Select <column>" dropdown. `selectedLabelEl` is the "selected" output
  // port's label, already built by the caller.
  function createLoadTablePicker(node: FlowNodeInstance, selectedLabelEl: HTMLElement): PathPicker {
    const wrap = document.createElement("div");
    wrap.className = "flow-node-config";

    const target = loaderTarget(node, "table", "Drag a Table from your space here");
    target.setPath(typeof node.config.tablePath === "string" ? node.config.tablePath : "");
    clearsTo(node, target, () => {
      delete node.config.tablePath;
      delete node.config.selectedValue;
    });
    const rows = createRowSelect(node, {
      chip: target,
      renamed: (label) => {
        selectedLabelEl.textContent = label;
      },
    });

    target.onDrop((event) => {
      const consented = isEntryDrop(event);
      const path = readDrop(event, target.showMessage);
      if (path === undefined) return;
      if (!isTableFile(path)) {
        target.showMessage(`Not a table: ${shown(path)}`);
        return;
      }
      if (!samePath(node.config.tablePath, path)) delete node.config.selectedValue;
      node.config.tablePath = path;
      target.setPath(path);
      deps.persistGraph();
      // A drag from Pragma's own tree named this exact table, so its read
      // needs no prompt, and any other drop asks; the grant is checked
      // against the graph on disk, so save first.
      void (async () => {
        if (await deps.saveGraphNow()) await rows.refresh(consented);
      })();
    });

    wrap.append(...target.elements, rows.el);
    return { el: wrap, target: target.elements[0] };
  }

  // loadRandomRow's config: the same table drop target, with an optional
  // "Weight column" dropdown in place of "Selected row" (the row is picked
  // fresh each Run). The dropdown is hidden, not disabled, when the table
  // has no `integer` column; its "None (uniform)" first option keeps
  // weighting opt-in. `selectedLabelEl` gets loadRow's first-column rename.
  function createLoadRandomRowPicker(node: FlowNodeInstance, selectedLabelEl: HTMLElement): PathPicker {
    const wrap = document.createElement("div");
    wrap.className = "flow-node-config";

    const target = loaderTarget(node, "table", "Drag a Table from your space here");
    target.setPath(typeof node.config.tablePath === "string" ? node.config.tablePath : "");
    clearsTo(node, target, () => {
      delete node.config.tablePath;
      delete node.config.weightColumn;
    });

    const weightField = document.createElement("div");
    weightField.className = "flow-config-field";
    weightField.hidden = true;
    const weightLabel = document.createElement("label");
    weightLabel.className = "flow-config-label";
    weightLabel.textContent = "Weight column";
    const weightSelect = createSelectControl("", [], (value) => {
      node.config.weightColumn = value;
      deps.persistGraph();
    });
    weightField.append(weightLabel, weightSelect);
    // Not exposable, like tablePath: a design-time schema choice, not a
    // per-run value an App Mode user would pick.

    // Re-reads the table at tablePath and refills the weight dropdown from
    // its integer columns, through the same capability as loadRow's read.
    async function refresh(consented = false): Promise<void> {
      const path = typeof node.config.tablePath === "string" ? node.config.tablePath : "";
      weightField.hidden = true;
      weightSelect.replaceChildren();
      // Reset up front, so every early return below leaves the generic
      // fallback rather than a stale column name.
      selectedLabelEl.textContent = "selected";
      if (!path || pathWired(node)) return;
      const granted = await deps.ensureCapability({ type: "readFile", path }, consented);
      if (!granted) return;
      try {
        const result = await deps.read(path);
        if (result?.kind !== "table") return;
        target.setDetail(tableContentsLabel(result.columns.length, result.rows.length));
        deps.sourceLoaded(node.id);
        if (result.columns.length > 0) selectedLabelEl.textContent = result.columns[0].label || "selected";
        const integerColumns = result.columns.filter((column) => column.type === "integer");
        if (integerColumns.length === 0) {
          if (node.config.weightColumn) {
            node.config.weightColumn = "";
            deps.persistGraph();
          }
          return;
        }
        appendSelectOptions(weightSelect, [
          { value: "", label: "None (uniform)" },
          ...integerColumns.map((column) => ({ value: column.id, label: column.label })),
        ]);
        const stored = typeof node.config.weightColumn === "string" ? node.config.weightColumn : "";
        const matches = stored === "" || Array.from(weightSelect.options).some((o) => o.value === stored);
        weightSelect.value = matches ? stored : "";
        if (!matches) {
          node.config.weightColumn = "";
          deps.persistGraph();
        }
        weightField.hidden = false;
      } catch (error) {
        // Unreadable, malformed, or not actually a table — left hidden;
        // dragging a different table in is the only fix.
        if (isMissingFile(error)) target.setMissing(error.message);
      }
    }

    target.onDrop((event) => {
      const consented = isEntryDrop(event);
      const path = readDrop(event, target.showMessage);
      if (path === undefined) return;
      if (!isTableFile(path)) {
        target.showMessage(`Not a table: ${shown(path)}`);
        return;
      }
      node.config.tablePath = path;
      target.setPath(path);
      deps.persistGraph();
      // A drag from Pragma's own tree named this exact table, so its read
      // needs no prompt, and any other drop asks; the grant is checked
      // against the graph on disk, so save first.
      void (async () => {
        if (await deps.saveGraphNow()) await refresh(consented);
      })();
    });

    void refresh();

    wrap.append(...target.elements, weightField);
    return { el: wrap, target: target.elements[0] };
  }

  // loadNote's config: the drag-only drop target, accepting only `.md` —
  // narrower than /api/sandbox/read's "text" fallback, which would also
  // return an applet or flow file's source (see flowNodes.ts's loadNote
  // entry). A table or image drop is pointed at its dedicated node.
  function createLoadNotePicker(node: FlowNodeInstance): PathPicker {
    const wrap = document.createElement("div");
    wrap.className = "flow-node-config";

    const target = loaderTarget(node, "markdown", "Drag a note from your space here");
    target.setPath(typeof node.config.notePath === "string" ? node.config.notePath : "");
    clearsTo(node, target, () => delete node.config.notePath);

    // Reads the note only to describe it, or to say it's gone: the node
    // needs no design-time read to work. Same capability the executor checks
    // at Run, since the server can't tell an editor read from a running one;
    // a drag supplies its own consent, so only a note named by the saved
    // file, or one whose grant was revoked, prompts.
    async function refresh(consented = false): Promise<void> {
      const path = typeof node.config.notePath === "string" ? node.config.notePath : "";
      if (!path || pathWired(node)) return;
      if (!(await deps.ensureCapability({ type: "readFile", path }, consented))) return;
      try {
        const result = await deps.read(path);
        if (result?.kind !== "text") return;
        target.setDetail(describeNoteContent(result.content));
      } catch (error) {
        // Unreadable, the chip still names it with no count: none is better
        // than a wrong one.
        if (isMissingFile(error)) target.setMissing(error.message);
      }
    }

    target.onDrop((event) => {
      const consented = isEntryDrop(event);
      const path = readDrop(event, target.showMessage);
      if (path === undefined) return;
      if (isTableFile(path)) {
        target.showMessage(`That's a table. Use a Load Row node instead: ${shown(path)}`);
        return;
      }
      if (rasterImageMediaTypeForPath(path)) {
        target.showMessage(`That's an image. Use a Load Image node instead: ${shown(path)}`);
        return;
      }
      if (!isMarkdownFile(path)) {
        target.showMessage(`Not a markdown note: ${shown(path)}`);
        return;
      }
      node.config.notePath = path;
      target.setPath(path);
      deps.persistGraph();
      void (async () => {
        // The grant is checked against the graph on disk, so this edit has to
        // land there first. A drag from Pragma's own tree named this exact
        // note, so recording it needs no prompt; any other drop asks.
        if (await deps.saveGraphNow()) await refresh(consented);
      })();
    });

    void refresh();

    wrap.append(...target.elements);
    return { el: wrap, target: target.elements[0] };
  }

  // writeNote's and addToNote's config: loadNote's drop target, without its
  // read. Writing needs no look at what's there, and the drag isn't consent
  // to write: the run asks, naming the note, the first time it would.
  function createWriteNotePicker(node: FlowNodeInstance): PathPicker {
    const wrap = document.createElement("div");
    wrap.className = "flow-node-config";

    const target = createSpaceDropTarget("markdown", "Drag the note to write into here", deps);
    target.setPath(typeof node.config.notePath === "string" ? node.config.notePath : "");
    clearsTo(node, target, () => delete node.config.notePath);

    target.onDrop((event) => {
      const path = readDrop(event, target.showMessage);
      if (path === undefined) return;
      if (!isMarkdownFile(path)) {
        target.showMessage(`Not a markdown note: ${shown(path)}`);
        return;
      }
      node.config.notePath = path;
      target.setPath(path);
      deps.persistGraph();
    });

    wrap.append(...target.elements);
    return { el: wrap, target: target.elements[0] };
  }

  // writeFolderNote's config: the folder its notes go into, by a drag of a
  // space folder. The drag isn't consent to write: the run asks, naming the
  // folder, the first time it would.
  function createWriteFolderNotePicker(node: FlowNodeInstance): PathPicker {
    const wrap = document.createElement("div");
    wrap.className = "flow-node-config";

    const target = createSpaceDropTarget("folder", "Drag the folder to write into here", deps);
    target.setPath(typeof node.config.folderPath === "string" ? node.config.folderPath : "");
    clearsTo(node, target, () => delete node.config.folderPath);

    target.onDrop((event) => {
      const path = readFolderDrop(event, target);
      if (path === undefined) return;
      node.config.folderPath = path;
      target.setPath(path);
      deps.persistGraph();
    });

    wrap.append(...target.elements);
    return { el: wrap, target: target.elements[0] };
  }

  // openToSide's config: any file in the space, by a drag. Opening one reads
  // nothing into the Flow, so the drag records no grant and there is no read
  // to describe it with.
  function createOpenToSidePicker(node: FlowNodeInstance): PathPicker {
    const wrap = document.createElement("div");
    wrap.className = "flow-node-config";

    const target = createSpaceDropTarget("file", "Drag the file to open here", deps);
    target.setPath(typeof node.config.documentPath === "string" ? node.config.documentPath : "");
    clearsTo(node, target, () => delete node.config.documentPath);

    target.onDrop((event) => {
      const path = readDrop(event, target.showMessage);
      if (path === undefined) return;
      if (deps.directoryChildren(shown(path))) {
        target.showMessage(`That's a folder. Drag a file: ${shown(path)}`);
        return;
      }
      node.config.documentPath = path;
      target.setPath(path);
      deps.persistGraph();
    });

    wrap.append(...target.elements);
    return { el: wrap, target: target.elements[0] };
  }

  // An Applet node's file. A different Applet brings different ports, state
  // and outputs, so nothing of the last one's config is kept and the card is
  // rebuilt rather than patched.
  function createAppletPicker(node: FlowNodeInstance, onChosen: () => void): AppletPicker {
    const wrap = document.createElement("div");
    wrap.className = "flow-node-config";
    const target = createSpaceDropTarget("applet", "Drag an Applet from your space here", deps);
    target.setPath(typeof node.config.appletPath === "string" ? node.config.appletPath : "");
    clearsTo(node, target, () => {
      node.config = {};
    });
    target.onDrop((event) => {
      const path = readDrop(event, target.showMessage);
      if (path === undefined) return;
      if (!isAppletFile(path)) {
        target.showMessage(`Not an Applet: ${shown(path)}`);
        return;
      }
      node.config = { appletPath: path };
      deps.persistGraph();
      onChosen();
    });
    wrap.append(...target.elements);
    return { el: wrap, target: target.elements[0] };
  }

  // addRow's config: writeNote's drop target, for a Table. A different Table
  // brings different columns, so what was typed for the last one's goes with
  // it, and the card is rebuilt rather than patched. The drag isn't consent
  // to write: the run asks, naming the Table, the first time it would.
  function createAddRowPicker(node: FlowNodeInstance, onChosen: () => void): AddRowPicker {
    const wrap = document.createElement("div");
    wrap.className = "flow-node-config";

    const target = loaderTarget(node, "table", "Drag the Table to add rows to here");
    target.setPath(typeof node.config.tablePath === "string" ? node.config.tablePath : "");
    clearsTo(node, target, () => {
      node.config = {};
    });

    target.onDrop((event) => {
      const path = readDrop(event, target.showMessage);
      if (path === undefined) return;
      if (!isTableFile(path)) {
        target.showMessage(`Not a table: ${shown(path)}`);
        return;
      }
      // The same Table, dropped again, is only read again, as after it is put
      // back where it was: what was typed for its columns stays.
      if (!samePath(node.config.tablePath, path)) {
        node.config = { tablePath: path };
        deps.persistGraph();
      }
      onChosen();
    });

    wrap.append(...target.elements);
    return {
      el: wrap,
      describe: (columns, rows) => target.setDetail(tableContentsLabel(columns, rows)),
      setDetail: target.setDetail,
      setMissing: target.setMissing,
    };
  }

  // loadTableRows' config: the table drop target alone, its size as the stat
  // line. The whole table is the output, so there is no row to pick.
  function createLoadTableRowsPicker(node: FlowNodeInstance): PathPicker {
    const wrap = document.createElement("div");
    wrap.className = "flow-node-config";

    const target = loaderTarget(node, "table", "Drag a Table from your space here");
    target.setPath(typeof node.config.tablePath === "string" ? node.config.tablePath : "");
    clearsTo(node, target, () => delete node.config.tablePath);

    async function refresh(consented = false): Promise<void> {
      const path = typeof node.config.tablePath === "string" ? node.config.tablePath : "";
      if (!path || pathWired(node)) return;
      if (!(await deps.ensureCapability({ type: "readFile", path }, consented))) return;
      try {
        const result = await deps.read(path);
        if (result?.kind !== "table") return;
        target.setDetail(tableContentsLabel(result.columns.length, result.rows.length));
        deps.sourceLoaded(node.id);
      } catch (error) {
        // Unreadable: the chip still names the table.
        if (isMissingFile(error)) target.setMissing(error.message);
      }
    }

    target.onDrop((event) => {
      const consented = isEntryDrop(event);
      const path = readDrop(event, target.showMessage);
      if (path === undefined) return;
      if (!isTableFile(path)) {
        target.showMessage(`Not a table: ${shown(path)}`);
        return;
      }
      node.config.tablePath = path;
      target.setPath(path);
      deps.persistGraph();
      void (async () => {
        // Save before the grant; only Pragma's own drag is consent, as for loadRow.
        if (await deps.saveGraphNow()) await refresh(consented);
      })();
    });

    void refresh();

    wrap.append(...target.elements);
    return { el: wrap, target: target.elements[0] };
  }

  // A folder loader's "Selected …" dropdown of its folder's direct children
  // the node takes (no recursion), the value Expose shows: App Mode builds it
  // alone, the card under the chip naming the folder, which hears how many
  // there are.
  //
  // Listing needs no capability check: the space tree is already visible in
  // the sidebar, ungated, so it reads synchronously, and only the picked
  // file's read needs a readFile grant. An image gets no thumbnail, which
  // would need its own gated read just to render.
  function createFolderSelect(node: FlowNodeInstance, chip?: SpaceDropTarget): LoaderSelect {
    const pick = FOLDER_PICKS[node.type];
    const selectField = document.createElement("div");
    selectField.className = "flow-config-field";
    const selectLabel = document.createElement("label");
    selectLabel.className = "flow-config-label";
    selectLabel.textContent = `Selected ${pick.noun}`;
    const select = createSelectControl("", [], (value) => {
      node.config[pick.key] = value;
      deps.persistGraph();
    });
    select.disabled = true;
    selectField.append(selectLabel, select);
    deps.bindExposeToggle(node, pick.key, pick.portType, selectLabel, selectField);

    function refresh(): void {
      const folderPath = typeof node.config.folderPath === "string" ? node.config.folderPath : "";
      select.replaceChildren();
      select.disabled = true;
      if (!folderPath) return;
      const children = deps.directoryChildren(shown(folderPath));
      if (!children) return;
      const files = children.filter((child) => child.type === "file" && pick.takes(child.path));
      chip?.setDetail(countText(files.length, pick.noun));
      if (files.length === 0) return;
      const held = node.config[pick.key];
      const stored = typeof held === "string" ? held : "";
      const options = files.map((file) => ({
        value: flowPickPath(deps.flowPath(), file.path, stored),
        label: stripExtension(basenameOf(file.path)),
      }));
      const picked = fillPickSelect(select, options, stored, stripExtension(basenameOf(shown(stored))));
      select.disabled = false;
      if (picked !== undefined) {
        node.config[pick.key] = picked;
        deps.persistGraph();
      }
    }

    refresh();
    return { el: selectField, target: select, refresh };
  }

  // A folder loader's card: a drop-only folder over its "Selected …"
  // dropdown.
  function createFolderPicker(node: FlowNodeInstance): PathPicker {
    const wrap = document.createElement("div");
    wrap.className = "flow-node-config";

    const target = loaderTarget(node, "folder", "Drag a folder from your space here");
    target.setPath(typeof node.config.folderPath === "string" ? node.config.folderPath : "");
    const files = createFolderSelect(node, target);
    clearsTo(node, target, () => {
      delete node.config.folderPath;
      delete node.config[FOLDER_PICKS[node.type].key];
    });

    target.onDrop((event) => {
      const path = readFolderDrop(event, target);
      if (path === undefined) return;
      if (!samePath(node.config.folderPath, path)) delete node.config[FOLDER_PICKS[node.type].key];
      node.config.folderPath = path;
      target.setPath(path);
      deps.persistGraph();
      files.refresh();
    });

    wrap.append(...target.elements, files.el);
    return { el: wrap, target: files.target };
  }

  // The keys a source's object will carry, read from the document its
  // executor reads: a Load Row's or Load Table's column labels. undefined for
  // any other source, whose keys exist only once it runs. No ensureCapability:
  // a grant the loader was refused isn't asked for again from a node that only
  // lists its fields.
  async function sourceKeys(source: { node: FlowNodeInstance; portId: string } | undefined) {
    if (!source) return undefined;
    const { node, portId } = source;
    const isRow =
      ((node.type === "loadRow" || node.type === "loadRandomRow") && portId === "row") ||
      (node.type === "loadTableRows" && portId === "rows");
    const path = isRow ? node.config.tablePath : undefined;
    if (typeof path !== "string" || !path) return undefined;
    try {
      const result = await deps.read(path);
      if (result?.kind === "table") {
        return [...new Set(result.columns.map((column) => column.label).filter((label) => label !== ""))];
      }
    } catch {
      // Unreadable or not granted: fall back to typing the key.
    }
    return undefined;
  }

  // getField's keys: one key control per slot, over one shared key list.
  function createGetFieldPicker(node: FlowNodeInstance): FieldPicker {
    const controls = new Map<number, KeyControl>();
    let keys: string[] | undefined;
    let latest = 0;

    const configKey = (slot: number) => `field${slot}Key`;
    const stored = (slot: number) => {
      const value = node.config[configKey(slot)];
      return typeof value === "string" ? value : "";
    };

    function control(slot: number): HTMLElement {
      const keyControl = createKeyControl(
        (value) => {
          node.config[configKey(slot)] = value;
          deps.persistGraph();
        },
        "Field name",
        "Choose a field",
      );
      controls.set(slot, keyControl);
      keyControl.render(stored(slot), keys);
      return keyControl.el;
    }

    // `latest` drops a slower read a newer one overtook.
    async function refresh(): Promise<void> {
      const call = ++latest;
      const read = await sourceKeys(deps.sourceOf(node.id, "object"));
      if (call !== latest) return;
      keys = read;
      for (const [slot, keyControl] of controls) keyControl.render(stored(slot), keys);
    }

    void refresh();
    return { control, forget: (slot) => controls.delete(slot), refresh: () => void refresh() };
  }

  // chart's config: its type, then the x and y columns, each picked the way
  // Get Field picks a key, from the columns of the rows wired into it.
  function createChartPicker(node: FlowNodeInstance): ChartPicker {
    const wrap = document.createElement("div");
    wrap.className = "flow-node-config flow-chart-config";
    const row = document.createElement("div");
    row.className = "flow-chart-fields";
    wrap.append(row);
    const save = (key: string, value: string) => {
      node.config[key] = value;
      deps.persistGraph();
    };
    const stored = (key: string) => (typeof node.config[key] === "string" ? (node.config[key] as string) : "");
    const field = (label: string, control: HTMLElement) => {
      const el = document.createElement("div");
      el.className = "flow-config-field";
      const labelEl = document.createElement("label");
      labelEl.className = "flow-config-label";
      labelEl.textContent = label;
      el.append(labelEl, control);
      return el;
    };

    const typeSelect = createSelectControl(
      chartSpecFrom(node.config).type,
      CHART_TYPES.map((type) => ({ value: type, label: type === "bar" ? "Bar" : "Line" })),
      (value) => save("chartType", value),
    );
    const axes = [
      {
        key: "x",
        label: "X axis",
        control: createKeyControl((value) => save("x", value), "Column", "Choose"),
      },
      {
        key: "y",
        label: "Y axis",
        control: createKeyControl((value) => save("y", value), "Column", "Choose"),
      },
    ];
    row.append(field("Chart", typeSelect), ...axes.map((axis) => field(axis.label, axis.control.el)));

    let keys: string[] | undefined;
    let latest = 0;
    const render = () => {
      for (const axis of axes) axis.control.render(stored(axis.key), keys);
    };

    // `latest` drops a slower read a newer one overtook.
    async function refresh(): Promise<void> {
      const call = ++latest;
      const read = await sourceKeys(deps.sourceOf(node.id, "rows"));
      if (call !== latest) return;
      keys = read;
      render();
    }

    render();
    void refresh();
    return { el: wrap, refresh: () => void refresh() };
  }

  // generateImage's and generateVideo's config: the folder results go to, a
  // space folder or a library one (a read-write library keeps big binaries
  // out of a space's git history). The drag isn't consent: the first run
  // asks. Below it, the last result, what the run reported, and Regenerate;
  // a click on the result previews its file.
  function createGenerationPicker(node: FlowNodeInstance, onRegenerate: () => void): GenerationView {
    const wrap = document.createElement("div");
    wrap.className = "flow-node-config";

    const target = createSpaceDropTarget("folder", "Drag the folder for results here", deps);
    target.setPath(typeof node.config.outputFolderPath === "string" ? node.config.outputFolderPath : "");
    // The card keeps its last result: only the next run reads the folder.
    clearsTo(node, target, () => delete node.config.outputFolderPath, false);
    target.onDrop((event) => {
      const path = readFolderDrop(event, target, true);
      if (path === undefined) return;
      node.config.outputFolderPath = path;
      target.setPath(path);
      deps.persistGraph();
    });

    // No port carries a video, so a clip is shown from the file its `path` names.
    const clip =
      node.type === "generateVideo"
        ? createResultClip("flow-node-video-result", deps.previewResult, deps.contextMenu, deps.viewContext)
        : undefined;
    const picture = document.createElement("img");
    picture.className = "flow-node-image-result";
    picture.alt = "The generated image";
    picture.hidden = true;
    // The picture is the run's copy; the preview shows the file it was saved
    // as. A press that drags the node is no click: the canvas swallows it.
    let file: string | undefined;
    picture.addEventListener("click", () => {
      if (file) deps.previewResult(file);
    });
    const report = document.createElement("p");
    report.className = "flow-node-report nodrag";
    report.hidden = true;
    const regenerate = document.createElement("button");
    regenerate.type = "button";
    regenerate.className = "btn nodrag";
    regenerate.textContent = "Regenerate";
    regenerate.dataset.tooltip = regenerateHint(node.type);
    regenerate.addEventListener("click", onRegenerate);
    // Regenerate asks for another result, so it shows only beside one.
    regenerate.hidden = true;

    wrap.append(...target.elements, clip?.el ?? picture, report, regenerate);
    return {
      el: wrap,
      show(outputs, lines) {
        const image = outputs?.image?.type === "image" ? outputs.image : undefined;
        const path = outputs?.path?.type === "text" && outputs.path.value ? outputs.path.value : undefined;
        file = path && flowTreePath(deps.flowPath(), path);
        if (clip) clip.show(file);
        picture.hidden = !image;
        if (image) picture.src = `data:${image.mediaType};base64,${image.data}`;
        else picture.removeAttribute("src");
        regenerate.hidden = !(clip ? path : image);
        report.hidden = lines.length === 0;
        report.textContent = lines.join("\n");
      },
      dispose: () => clip?.dispose(),
    };
  }

  return {
    createDropzone,
    createVideoPicker,
    createLoadTablePicker,
    createLoadRandomRowPicker,
    createLoadNotePicker,
    createWriteNotePicker,
    createOpenToSidePicker,
    createLoadTableRowsPicker,
    createAddRowPicker,
    createFolderPicker,
    createRowSelect: (node) => createRowSelect(node),
    createFolderSelect: (node) => createFolderSelect(node),
    createWriteFolderNotePicker,
    createGenerationPicker,
    createGetFieldPicker,
    createChartPicker,
    createAppletPicker,
  };
}
