// The canvas's wires: a path for each wire whose two nodes are drawn, a loose
// end for a wire naming a node the Flow doesn't have, so the wire can be seen
// and fixed where it is (docs/architecture.md, Feedback and interaction), and the
// line a connection drag draws.
//
// A wire into a node of a type this build doesn't know draws nothing: that
// node is in the file, just not drawn, and the wire isn't loose.
import {
  type ConnectionState,
  getBezierPath,
  getStraightPath,
  type Handle,
  type InternalNodeBase,
  Position,
  type Transform,
  type HandleType as XYHandleType,
} from "@xyflow/system";
import { nodesLeftOut } from "../../src/protocol/flowNodes.ts";
import type { FlowEdgeInstance, FlowGraph, FlowPortType } from "../../src/protocol/types.ts";

const SVG_NS = "http://www.w3.org/2000/svg";
// How far a loose end reaches from its pin, and how far it drops below one it
// would cover, whichever pin that one hangs from.
const LOOSE_REACH = 80;
const LOOSE_STEP = 24;
// A loose end's hollow pin and the gap before its label (canvas.css), and a
// generous width per label character, so two labels judged apart never touch.
// Estimated, not measured: measuring would lay the page out on every frame of
// a node drag.
const LOOSE_PIN = 12;
const LOOSE_GAP = 6;
const LABEL_CHAR = 7;

type Point = { x: number; y: number };
type Box = { left: number; right: number; top: number; bottom: number };

function overlaps(a: Box, b: Box): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

export interface WiresDeps {
  edgeGroup: SVGGElement;
  // The panned and zoomed layer the cards sit in; a loose end sits with them.
  viewport: HTMLElement;
  graph(): FlowGraph;
  nodeLookup: ReadonlyMap<string, InternalNodeBase>;
  findHandle(nodeId: string, handleId: string | null, type: XYHandleType): Handle | null;
  portTypeOf(nodeId: string, handleId: string | null, type: XYHandleType): FlowPortType | null;
  // A drag from the pin a loose end hangs from; connecting replaces `loose`.
  startConnection(
    event: MouseEvent,
    nodeId: string,
    handleId: string,
    type: XYHandleType,
    handleEl: Element,
    loose: FlowEdgeInstance,
  ): void;
  openHandleMenu(clientX: number, clientY: number, portType: FlowPortType | null, edges: FlowEdgeInstance[]): void;
  // The line a connection drag draws, in pane coordinates.
  connectionPath: SVGPathElement;
  // A locked Flow takes no edits, so its loose ends offer none.
  locked(): boolean;
}

export interface Wires {
  // Draws every wire, a wire touching a node a run leaves out dashed, and
  // hands back those nodes (nodesLeftOut), for the cards to show them too.
  render(): Map<string, string>;
  // The line from the dragged pin to the pointer, and none once the drag ends.
  drawConnection(state: ConnectionState, transform: Transform): void;
  // The wire a loose end's drag is moving, left undrawn while the drag line
  // stands in for it.
  lift(edge: FlowEdgeInstance | undefined): void;
}

export function createWires(deps: WiresDeps): Wires {
  let lifted: FlowEdgeInstance | undefined;

  function pinAt(nodeId: string, handleId: string, type: XYHandleType): Point | null {
    const node = deps.nodeLookup.get(nodeId);
    const handle = deps.findHandle(nodeId, handleId, type);
    if (!node || !handle) return null;
    return { x: node.position.x + handle.x + handle.width / 2, y: node.position.y + handle.y + handle.height / 2 };
  }

  function drawPath(from: Point, to: Point, className: string): void {
    const [path] = getBezierPath({
      sourceX: from.x,
      sourceY: from.y,
      sourcePosition: Position.Right,
      targetX: to.x,
      targetY: to.y,
      targetPosition: Position.Left,
    });
    const pathEl = document.createElementNS(SVG_NS, "path");
    pathEl.setAttribute("class", className);
    pathEl.setAttribute("d", path);
    deps.edgeGroup.appendChild(pathEl);
  }

  // `type` is the end that is drawn: "source" hangs the loose end right of an
  // output, "target" left of an input.
  function drawLooseEnd(edge: FlowEdgeInstance, type: XYHandleType, pin: Point, end: Point, text: string): void {
    const [nodeId, handleId, missingId] =
      type === "source" ? [edge.source, edge.sourcePort, edge.target] : [edge.target, edge.targetPort, edge.source];
    if (type === "source") drawPath(pin, end, "edge-path missing");
    else drawPath(end, pin, "edge-path missing");

    const portType = deps.portTypeOf(nodeId, handleId, type);
    const locked = deps.locked();
    const el = document.createElement("div");
    el.className = `flow-loose-end nopan ${type}${locked ? " inert" : portType ? "" : " disconnect-only"}`;
    el.style.transform = `translate(${end.x}px, ${end.y}px)`;
    const missing = `This Flow has no node "${missingId}".`;
    el.dataset.tooltip = locked
      ? missing
      : portType
        ? `${missing} Drag this end onto a pin to reconnect the wire, or right-click it to disconnect.`
        : `${missing} Right-click this end to disconnect the wire.`;
    const ring = document.createElement("span");
    ring.className = "flow-loose-end-pin";
    const label = document.createElement("span");
    label.className = "flow-loose-end-label";
    label.textContent = text;
    el.append(ring, label);
    // A wire from a pin its node lacks has no type to carry to a new pin, so
    // it only disconnects.
    el.addEventListener("mousedown", (event) => {
      if (event.button !== 0 || !portType) return;
      deps.startConnection(event, nodeId, handleId, type, el, edge);
    });
    // Stopped, or the pane's own handler would take it for empty canvas and
    // offer to add a node.
    el.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      event.stopPropagation();
      deps.openHandleMenu(event.clientX, event.clientY, portType, [edge]);
    });
    deps.viewport.append(el);
  }

  // What a loose end's pin and label cover with its pin at `end`: the label
  // runs right of an output's end, left of an input's.
  function looseBox(type: XYHandleType, end: Point, text: string): Box {
    const reach = LOOSE_PIN / 2 + LOOSE_GAP + text.length * LABEL_CHAR;
    const [left, right] =
      type === "source" ? [end.x - LOOSE_PIN / 2, end.x + reach] : [end.x - reach, end.x + LOOSE_PIN / 2];
    return { left, right, top: end.y - LOOSE_STEP / 2, bottom: end.y + LOOSE_STEP / 2 };
  }

  function render(): Map<string, string> {
    for (const el of Array.from(deps.edgeGroup.querySelectorAll(".edge-path"))) el.remove();
    for (const el of Array.from(deps.viewport.querySelectorAll(":scope > .flow-loose-end"))) el.remove();
    const { nodes, edges } = deps.graph();
    const nodeIds = new Set(nodes.map((node) => node.id));
    const leftOut = nodesLeftOut(deps.graph());
    // Each loose end drops a step at a time until it covers none drawn before
    // it, whichever pin that one hangs from: two facing each other across a
    // gap would otherwise run their labels together.
    const taken: Box[] = [];
    for (const edge of edges) {
      if (edge === lifted) continue;
      const source = pinAt(edge.source, edge.sourcePort, "source");
      const target = pinAt(edge.target, edge.targetPort, "target");
      if (source && target) {
        const pinType = deps.portTypeOf(edge.source, edge.sourcePort, "source");
        const missing = !pinType || !deps.portTypeOf(edge.target, edge.targetPort, "target");
        const idle = leftOut.has(edge.source) || leftOut.has(edge.target);
        drawPath(
          source,
          target,
          `edge-path type-${pinType ?? "text"}${missing ? " missing" : ""}${idle ? " left-out" : ""}`,
        );
        continue;
      }
      const type =
        source && !nodeIds.has(edge.target) ? "source" : target && !nodeIds.has(edge.source) ? "target" : null;
      const pin = type === "source" ? source : target;
      if (!type || !pin) continue;
      const text = `${type === "source" ? edge.target : edge.source} (missing)`;
      const end = { x: pin.x + (type === "source" ? LOOSE_REACH : -LOOSE_REACH), y: pin.y };
      while (taken.some((box) => overlaps(box, looseBox(type, end, text)))) end.y += LOOSE_STEP;
      taken.push(looseBox(type, end, text));
      drawLooseEnd(edge, type, pin, end, text);
    }
    return leftOut;
  }

  function drawConnection(state: ConnectionState, transform: Transform): void {
    const path = deps.connectionPath;
    if (!state.inProgress) {
      path.setAttribute("d", "");
      path.setAttribute("class", "flow-connection-path");
      return;
    }
    const from = {
      x: transform[0] + state.from.x * transform[2],
      y: transform[1] + state.from.y * transform[2],
    };
    const [d] = getStraightPath({
      sourceX: from.x,
      sourceY: from.y,
      targetX: state.to.x,
      targetY: state.to.y,
    });
    path.setAttribute("d", d);
    const draggedPin = deps.portTypeOf(state.fromHandle.nodeId, state.fromHandle.id ?? null, state.fromHandle.type);
    // Both classes, never the type alone: the base one carries the stroke that makes the line visible at all.
    path.setAttribute("class", `flow-connection-path${draggedPin ? ` type-${draggedPin}` : ""}`);
    path.classList.toggle("invalid", state.isValid === false);
  }

  return {
    render,
    drawConnection,
    lift(edge) {
      if (edge === lifted) return;
      lifted = edge;
      render();
    },
  };
}
