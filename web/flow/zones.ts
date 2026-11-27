// For Each zones on the canvas (docs/protocol.md, For Each zones): each zone
// drawn behind its nodes, from its For Each's card to its End's, with a label
// on its top edge carrying what a run of it shows, its stepper and its ask.
//
// The layer sits inside the viewport, under the cards, and takes no pointer:
// a zone's area stays the canvas's to pan and right-click, and the wires
// under it stay grabbable. Only the label's controls take clicks.
import type { InternalNodeBase } from "@xyflow/system";
import { FLOW_NODE_REGISTRY } from "../../src/protocol/flowNodes.ts";
import {
  type FlowZone,
  FOR_EACH_END_TYPE,
  FOR_EACH_PAIR_KEY,
  FOR_EACH_TYPE,
  flowZones,
  itemWord,
  zonePartners,
} from "../../src/protocol/flowZones.ts";
import type { FlowGraph, FlowNodeInstance } from "../../src/protocol/types.ts";

/** What a run shows on a zone's label: its items, the one the zone's cards
 * show and how many have settled, the failed ones, and, while it waits, the
 * ask after the first generation. */
export interface ZoneView {
  total: number;
  shown: number | undefined;
  settled: number;
  failed: readonly number[];
  running: boolean;
  ask?: { rest: number; answer(go: boolean): void };
  step(index: number): void;
}

export interface ZonesDeps {
  viewport: HTMLElement;
  graph(): FlowGraph;
  nodeLookup: ReadonlyMap<string, InternalNodeBase>;
  flowPath(): string;
}

export interface Zones {
  render(): void;
  // A run's view of one zone of the Flow at `flowPath`; undefined clears it.
  show(flowPath: string, forEach: string, view: ZoneView | undefined): void;
}

// How far a zone reaches past its nodes: over the label at the top, a little
// below, and into its For Each's and End's cards, which sit on its edges.
const ABOVE = 44;
const BELOW = 28;
const INTO = 12;
const BESIDE = 24;

/** A new For Each's End, beside it to the right: the pair an editor adds as
 * one. Any other node comes alone. */
export function withEnd(node: FlowNodeInstance, endId: () => string): FlowNodeInstance[] {
  if (node.type !== FOR_EACH_TYPE) return [node];
  const end: FlowNodeInstance = {
    id: endId(),
    type: FOR_EACH_END_TYPE,
    typeVersion: FLOW_NODE_REGISTRY[FOR_EACH_END_TYPE]?.version,
    position: { x: node.position.x + 520, y: node.position.y },
    config: { [FOR_EACH_PAIR_KEY]: node.id },
  };
  return [node, end];
}

/** The nodes an editor removes together: a For Each and its End, any other
 * node alone. */
export function pairOf(graph: FlowGraph, nodeId: string): Set<string> {
  return new Set([nodeId, ...zonePartners(graph, nodeId)]);
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function labelButton(className: string, text: string, label: string, onClick: () => void): HTMLButtonElement {
  const button = el("button", className, text);
  button.type = "button";
  button.setAttribute("aria-label", label);
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    onClick();
  });
  return button;
}

// The label's words and controls for a zone's view, "For each row" first.
function drawLabel(label: HTMLElement, word: "row" | "item", view: ZoneView | undefined): void {
  const Word = word === "row" ? "Row" : "Item";
  label.replaceChildren(el("span", "flow-zone-title", `For each ${word}`));
  if (!view) return;
  if (view.ask) {
    const { answer, rest } = view.ask;
    label.append(
      el("span", "flow-zone-status", `${Word} ${(view.shown ?? 0) + 1} done`),
      labelButton("flow-zone-ask is-primary", `Continue with ${rest} more`, `Continue with ${rest} more`, () =>
        answer(true),
      ),
      labelButton("flow-zone-ask", "Stop", "Stop", () => answer(false)),
    );
    return;
  }
  if (view.total === 0) {
    label.append(el("span", "flow-zone-status", `No ${word}s`));
    return;
  }
  const shown = view.shown ?? 0;
  label.append(el("span", "flow-zone-status", `${Word} ${shown + 1} of ${view.total}`));
  if (view.running) {
    const bar = el("span", "flow-zone-progress");
    const fill = el("span", "flow-zone-progress-fill");
    fill.style.width = `${Math.round((view.settled / view.total) * 100)}%`;
    bar.append(fill);
    label.append(bar);
  }
  if (view.failed.length > 0) {
    // Steps to the next failed item after the one shown, round and round.
    const next = view.failed.find((index) => index > shown) ?? view.failed[0];
    label.append(
      labelButton("flow-zone-failed", `${view.failed.length} failed`, `Show ${word} ${next + 1}, which failed`, () =>
        view.step(next),
      ),
    );
  }
  const previous = labelButton("flow-zone-step is-previous", "", `Previous ${word}`, () => view.step(shown - 1));
  const after = labelButton("flow-zone-step is-next", "", `Next ${word}`, () => view.step(shown + 1));
  previous.disabled = shown <= 0;
  after.disabled = shown >= view.total - 1;
  label.append(previous, after);
}

export function createZones(deps: ZonesDeps): Zones {
  const layer = el("div", "flow-zone-layer");
  deps.viewport.prepend(layer);
  const views = new Map<string, ZoneView>();
  const drawn = new Map<string, { zone: HTMLDivElement; label: HTMLDivElement; key: unknown }>();
  const keyOf = (flowPath: string, forEach: string) => `${flowPath}\n${forEach}`;

  function boxOf(id: string): { x: number; y: number; right: number; bottom: number } | undefined {
    const node = deps.nodeLookup.get(id);
    if (!node) return undefined;
    const { x, y } = node.position;
    return { x, y, right: x + (node.measured.width ?? 0), bottom: y + (node.measured.height ?? 0) };
  }

  function rectOf(zone: FlowZone): { left: number; top: number; width: number; height: number } | undefined {
    const forEach = boxOf(zone.forEach);
    if (!forEach) return undefined;
    const end = zone.end ? boxOf(zone.end) : undefined;
    const members = [...zone.members].flatMap((id) => boxOf(id) ?? []);
    const all = [forEach, ...members, ...(end ? [end] : [])];
    const left = Math.min(forEach.x + INTO, ...members.map((box) => box.x - BESIDE));
    const right = Math.max(
      end ? end.right - INTO : forEach.right + BESIDE,
      ...members.map((box) => box.right + BESIDE),
    );
    const top = Math.min(...all.map((box) => box.y)) - ABOVE;
    const bottom = Math.max(...all.map((box) => box.bottom)) + BELOW;
    return { left, top, width: Math.max(right - left, 2 * BESIDE), height: bottom - top };
  }

  function render(): void {
    const graph = deps.graph();
    const flowPath = deps.flowPath();
    const zones = flowZones(graph);
    for (const [id, { zone }] of drawn) {
      if (zones.has(id)) continue;
      zone.remove();
      drawn.delete(id);
    }
    for (const zone of zones.values()) {
      const rect = rectOf(zone);
      let shape = drawn.get(zone.forEach);
      if (!rect) {
        shape?.zone.remove();
        drawn.delete(zone.forEach);
        continue;
      }
      if (!shape) {
        const box = el("div", "flow-zone");
        const label = el("div", "flow-zone-label nopan nodrag nowheel");
        box.append(label);
        layer.append(box);
        shape = { zone: box, label, key: undefined };
        drawn.set(zone.forEach, shape);
      }
      shape.zone.style.transform = `translate(${rect.left}px, ${rect.top}px)`;
      shape.zone.style.width = `${rect.width}px`;
      shape.zone.style.height = `${rect.height}px`;
      // The label is drawn again only when what it says changes, not on every
      // drag frame, so a control under the pointer stays the one clicked.
      const view = views.get(keyOf(flowPath, zone.forEach));
      const word = itemWord(graph, zone.forEach);
      if (shape.key !== view || shape.label.dataset.word !== word) {
        shape.key = view;
        shape.label.dataset.word = word;
        drawLabel(shape.label, word, view);
      }
    }
  }

  return {
    render,
    show(flowPath, forEach, view) {
      const key = keyOf(flowPath, forEach);
      if (view) views.set(key, view);
      else views.delete(key);
      if (flowPath === deps.flowPath()) render();
    },
  };
}
