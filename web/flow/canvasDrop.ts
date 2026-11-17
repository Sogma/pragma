// Dropping a space document onto empty canvas, and the pane-coordinate math
// every canvas gesture that places something needs. The canvas itself
// (xyflowAdapter) owns the graph; this owns only "where in flow space did
// that pointer land" and "what does dropping this file mean."

import { APPLET_NODE_TYPE } from "../../src/protocol/appletNode.ts";
import { isLibraryRoot, type RootedPath } from "../../src/protocol/rootedPath.ts";
import { isAppletFile, isMarkdownFile, isTableFile, rasterImageMediaTypeForPath } from "../../src/protocol/types.ts";
import { draggedPathInFlight, readDraggedPath } from "../core/paths.ts";
import { flowStoredPath } from "./flowPaths.ts";

// [x offset, y offset, zoom] — @xyflow/system's Transform, taken structurally
// so this module doesn't depend on the canvas library for three numbers.
type PaneTransform = readonly [number, number, number];

/** Where a pointer event over the pane lands in flow coordinates — the
 * inverse of the viewport transform the nodes' own translate uses. */
export function paneFlowPosition(
  pane: HTMLElement,
  transform: PaneTransform,
  event: MouseEvent,
): { x: number; y: number } {
  const rect = pane.getBoundingClientRect();
  return {
    x: (event.clientX - rect.left - transform[0]) / transform[2],
    y: (event.clientY - rect.top - transform[1]) / transform[2],
  };
}

/** Which node a file dragged out of the space tree becomes, and the config
 * key its path goes in. Only kinds with one obvious answer: a `.table.html`
 * could as well mean loadRandomRow and a folder either folder loader, and
 * a silent guess is worse than the palette. Only `imagePath` can name a
 * library file. */
function loadNodeForDroppedFile(dragged: RootedPath): { type: string; configKey: string } | undefined {
  const { path } = dragged;
  if (rasterImageMediaTypeForPath(path)) return { type: "loadImage", configKey: "imagePath" };
  // Every node below resolves its path against the space and nothing else,
  // so a library path has no meaning in one — the same refusal every
  // space-only drop target already makes (LIBRARY_DROP_REFUSAL, paths.ts).
  if (isLibraryRoot(dragged.root)) return undefined;
  if (isTableFile(path)) return { type: "loadRow", configKey: "tablePath" };
  if (isMarkdownFile(path)) return { type: "loadNote", configKey: "notePath" };
  if (isAppletFile(path)) return { type: APPLET_NODE_TYPE, configKey: "appletPath" };
  return undefined;
}

/** A node's config bag, as node creation seeds it and a picker later edits it. */
export type NodeConfig = Record<string, unknown>;

export interface CanvasDropDeps {
  // Read per-event, not captured: the viewport moves under these listeners.
  transform(): PaneTransform;
  // The open Flow's path, which the dropped path is written from, as a
  // picker writes one (pickers.ts).
  flowPath(): string;
  // `seed` has to be in place before the node's card is built, so the picker
  // it lands in initializes from the path exactly as it does for a node
  // restored from file with one already set — hence seeding at creation
  // rather than assigning the config onto the node afterward.
  createNode(type: string, x: number, y: number, seed: NodeConfig): void;
}

/** Dragging a document out of the space tree onto empty canvas drops in the
 * Load node for its kind with the path filled; over a card, its own picker
 * stays the target.
 *
 * `dragover` accepts from the drag in flight (paths.ts), since browsers keep
 * the payload unreadable until the drop — that is what gives an unsupported
 * file a "no drop" cursor. The drop reads the real payload, so a stale
 * in-flight value can only cost a wrong cursor. */
export function wireCanvasDrop(pane: HTMLElement, deps: CanvasDropDeps): void {
  pane.addEventListener("dragover", (event) => {
    if ((event.target as HTMLElement).closest(".flow-node")) return;
    const dragged = draggedPathInFlight();
    if (!dragged || !loadNodeForDroppedFile(dragged)) return;
    // preventDefault alone, deliberately: dropEffect is left at whatever the
    // browser derived from the source's own effectAllowed (a writable tree
    // row advertises "move"), and setting one outside that set resolves the
    // operation to "none" — a forbidden cursor and no drop event at all.
    // Every picker dropzone accepts a tree drag the same way.
    event.preventDefault();
  });
  pane.addEventListener("drop", (event) => {
    if ((event.target as HTMLElement).closest(".flow-node")) return;
    const dragged = readDraggedPath(event);
    if (!dragged) return;
    const target = loadNodeForDroppedFile(dragged);
    if (!target) return;
    event.preventDefault();
    const position = paneFlowPosition(pane, deps.transform(), event);
    const value = flowStoredPath(deps.flowPath(), dragged);
    deps.createNode(target.type, position.x, position.y, { [target.configKey]: value });
  });
}
