import {
  type Connection,
  ConnectionMode,
  type ConnectionState,
  getHandleBounds,
  type Handle,
  type InternalNodeBase,
  infiniteExtent,
  initialConnection,
  type NodeBase,
  type NodeHandleBounds,
  Position,
  type Viewport,
  XYDrag,
  type XYDragInstance,
  XYHandle,
  type HandleType as XYHandleType,
} from "@xyflow/system";
import type { GenerationSpend } from "../../src/protocol/flowExecutors.ts";
import { FLOW_NODE_REGISTRY, nodePorts } from "../../src/protocol/flowNodes.ts";
import {
  type FlowCapabilityDeclaration,
  type FlowEdgeInstance,
  type FlowGraph,
  type FlowNodeInstance,
  type FlowPortType,
  flowPortTypesCompatible,
} from "../../src/protocol/types.ts";
import {
  type FlowFileResponse,
  fetchFile,
  type SandboxReadResult,
  sandboxGrant,
  sandboxRead,
  sandboxRevoke,
} from "../core/apiClient.ts";
import { findDirectoryChildren } from "../core/spaceTree.ts";
import { lockMessage, takesTyping } from "../lib/dom.ts";
import { type BrokerSubject, createCapabilityBroker } from "../services/capabilityBroker.ts";
import type { DialogService } from "../services/dialog.ts";
import type { ContextMenuService } from "../services/menus.ts";
import type { ModelConsole } from "../services/modelConsole.ts";
import type { ModelLists } from "../services/modelLists.ts";
import { injectAppletNodeRuntime } from "../services/sandboxHost.ts";
import { createAppMode } from "./appMode.ts";
import { type NodeConfig, paneFlowPosition, wireCanvasDrop } from "./canvasDrop.ts";
import { type CanvasRunHost, type CanvasRunInfo, createCanvasRun } from "./canvasRun.ts";
import { createCanvasView } from "./canvasView.ts";
import { createCanvasZoom } from "./canvasZoom.ts";
import type { FlowElements } from "./flowElements.ts";
import { createFlowHistory, planRestore, type RecordedGraph } from "./flowHistory.ts";
import { createFlowMenus } from "./flowMenus.ts";
import { flowTreePath } from "./flowPaths.ts";
import { brokerCapability, flowBrokerCapabilities, flowUnattendedGrant } from "./flowPermissions.ts";
import { createFlowSaves, type FlowSaves, type FlowSavesDeps } from "./flowSaves.ts";
import { createModelFields } from "./modelOptions.ts";
import { createNodeCards, markLeftOut, NODE_WIDTH, type NodeCardDeps } from "./nodeCard.ts";
import { createNodeSelection } from "./nodeSelection.ts";
import { createWires } from "./wires.ts";

export type CanvasEdit = "undo" | "redo" | "remove" | "disable";

export interface FlowViewDeps {
  dialog: DialogService;
  // Draws the canvas's menus (services/menus.ts).
  contextMenu: ContextMenuService;
  modelLists: ModelLists;
  scheduleSave: (path: string, content: string) => void;
  // Writes now and resolves whether the content is on disk. Same queue as
  // scheduleSave, so the write names its base like every other save.
  saveNow: (path: string, content: string) => Promise<boolean>;
  // A document a run changed on disk, by space path, for its view to reload.
  documentWritten: (path: string) => void;
  // Called after every (re-)render, once the flow's name (if any) is in
  // hand, so the group re-places its title bar, same as the table pane.
  onRendered: () => void;
  // Where a pan or zoom left the canvas, and the App Mode switch: your view,
  // reported for this install to keep, never saved to the file.
  onViewportChange: (viewport: Viewport) => void;
  onAppModeChange: (appMode: boolean) => void;
  // The pane's problem report: the live graph after every change, locked or not, and cards' missing files.
  problems: Pick<FlowSavesDeps, "onGraphChange"> & Pick<NodeCardDeps, "fileMissing">;
  // The status bar's indicator while a run's model call goes, and the
  // Console entry each text generation gets, as every Flow's does.
  modelConsole: Pick<ModelConsole, "beginLlmActivity" | "endLlmActivity" | "logLlmCall">;
  // A run's paid generation, with the path of the Flow that ran it: the
  // Console records each, while the card shows only the last run's.
  spent: (flowPath: string, spend: GenerationSpend) => void;
  // Every Flow's runs going, as each changes, and App Mode's count showing them.
  onRunsChange: (runs: readonly CanvasRunInfo[]) => void;
  showRuns: () => void;
  // A Generate node's result file, by tree path, previewed over the pane.
  previewResult: (path: string) => void;
}

export interface FlowView {
  // `local` is your view of the file, where its tab left the canvas and the
  // App Mode this install keeps, each shown over the file's own.
  render(file: FlowFileResponse, local?: { viewport?: Viewport; appMode?: boolean }): void;
  clear(): void;
  isActive(): boolean;
  getFileName(): string | undefined;
  // Renames the flow itself — its `<title>`, the name read back above (tab,
  // title bar, heading atop the canvas) — not the space file path, which is
  // the tree's own Rename. An immediate, awaited save, not the debounced
  // autosave, so the caller can show success/failure inline; resolves false
  // on failure (network error, or no flow rendered).
  setDisplayName(name: string): Promise<boolean>;
  // Replaces the metadata block, description included, through the autosave.
  setMetadata: FlowSaves["setMetadata"];
  run(): Promise<void>;
  setRunCount(count: number): void;
  showPermissionsPanel(): void;
  // App Mode — the published-form counterpart to the graph canvas (see
  // docs/protocol.md's App Mode section): renders exactly the fields marked
  // Expose as a plain form, inputs editable, output pins read-only until Run
  // populates them. main.ts owns the toggle button's chrome
  // (aria-pressed/title), reading the state back after every toggle.
  toggleAppMode(): void;
  isAppModeActive(): boolean;
  // The view shown against the Flow's default view, its file's `viewport`
  // and `appModeActive`: whether they differ where the file takes a write,
  // and making the shown one the default with an awaited save.
  defaultViewDiffers(): boolean;
  setDefaultView(): Promise<boolean>;
  // The pane's transient for Escape (EditorPane): the zoom popover, else
  // the node selection.
  hasTransient(): boolean;
  dismissTransient(): void;
  // The node selected on the canvas, which the copilot is told of. None
  // while App Mode hides the canvas.
  selectedNode(): string | undefined;
  // The canvas's keys (flowKeys.ts): Undo, Redo, and removing or disabling the
  // selected node. Each applies only while focus is on the canvas, not a field.
  canEdit(edit: CanvasEdit): boolean;
  edit(edit: CanvasEdit): void;
}

// Owns the open `.flow.html` file's live graph, the interactive xyflow
// canvas rendering it, and the capability-grant/prompt cycle Run depends
// on — the flow pane's counterpart to web/view/panes/tablePane.ts.
//
// Every graph mutation (add node, connect edge, edit config, drag a node)
// re-serializes and schedules the same debounced PUT a table edit uses —
// there is no explicit Save.
export function createFlowView(elements: FlowElements, deps: FlowViewDeps & CanvasRunHost): FlowView {
  let graph: FlowGraph = { nodes: [], edges: [] };
  let activeFlow: { file: FlowFileResponse; grantedCapabilities: Set<string> } | undefined;
  const flowPath = (): string => activeFlow?.file.path ?? "";
  // A flow from a format major this build doesn't write, or whose markup
  // couldn't be read, must not be saved over (docs/protocol.md's
  // "Reading and write protection"). Gates both halves of every edit — the interaction that starts
  // one (drag, the three context menus, dragging out a connection) and the
  // write that would land it, including the run's own pre-flight save.
  const locked = (): boolean => activeFlow?.file.locked !== undefined;

  const flowNodeById = new Map<string, FlowNodeInstance>();
  const nodeLookup = new Map<string, InternalNodeBase>();
  const nodeEls = new Map<string, HTMLDivElement>();
  const selection = createNodeSelection(elements.pane, (nodeId) => nodeEls.get(nodeId));
  const dragInstances = new Map<string, XYDragInstance>();
  // loadImage's picked bytes plus the File's own name — ephemeral, never
  // persisted (see flowExecutors.ts's NodeExecutionContext).
  const pickedImages = new Map<string, { mediaType: string; data: string; name: string }>();
  const history = createFlowHistory(elements.root);

  let connectionState: ConnectionState = initialConnection;
  let fromHandle: Handle | null = null;
  let nextNodeSuffix = 1;
  // The flow's consent prompt, permissions panel, and dialog chain
  // (services/capabilityBroker.ts), scoped to the canvas host while a flow
  // is mounted.
  //
  // Overlapping first-use prompts serialize, as in the applet pane: a second
  // capability request queues behind the one showing instead of stacking
  // dialogs. Whichever dialog is open closes with the flow it belongs to.
  const broker = createCapabilityBroker({ ...deps, grant: sandboxGrant, revoke: sandboxRevoke });

  // Every save goes through the check against dropped nodes (flowSaves.ts).
  const saves = createFlowSaves({
    graph: () => graph,
    file: () => activeFlow?.file,
    locked,
    scheduleSave: deps.scheduleSave,
    saveNow: deps.saveNow,
    onGraphChange: deps.problems.onGraphChange,
    notice: elements.lockNotice,
  });
  // Every change also goes to the Flow's undo history (flowHistory.ts).
  const persistGraph = (): void => {
    saves.persist();
    if (!locked()) history.changed(graph);
  };
  const saveGraphNow = saves.saveNow;

  function portTypeOf(nodeId: string, handleId: string | null, handleType: XYHandleType): FlowPortType | null {
    const node = flowNodeById.get(nodeId);
    if (!node || !handleId) return null;
    const ports = handleType === "target" ? nodePorts(node).inputs : nodePorts(node).outputs;
    return ports.find((p) => p.id === handleId)?.type ?? null;
  }

  function findHandle(nodeId: string, handleId: string | null, type: XYHandleType): Handle | null {
    const bounds = nodeLookup.get(nodeId)?.internals.handleBounds?.[type];
    // Only a collapsed node's id-less stand-in takes any id: on an open card
    // a wire naming a missing port would land on the wrong pin.
    return bounds?.find((h) => h.id === handleId) ?? bounds?.find((h) => h.id === null) ?? null;
  }

  function getStoreItems() {
    return {
      nodes: Array.from(nodeLookup.values()),
      nodeLookup,
      edges: graph.edges,
      nodeExtent: infiniteExtent,
      snapGrid: [1, 1] as [number, number],
      snapToGrid: false,
      nodeOrigin: [0, 0] as [number, number],
      multiSelectionActive: false,
      domNode: elements.pane,
      transform: canvasView.transform(),
      autoPanOnNodeDrag: false,
      nodesDraggable: !locked(),
      selectNodesOnDrag: false,
      nodeDragThreshold: 1,
      panBy: async () => false,
      unselectNodesAndEdges: () => {},
      updateNodePositions: (
        dragItems: Map<
          string,
          { position: { x: number; y: number }; internals: { positionAbsolute: { x: number; y: number } } }
        >,
      ) => {
        for (const [id, item] of dragItems) {
          const internal = nodeLookup.get(id);
          if (!internal) continue;
          internal.position = item.position;
          internal.internals.positionAbsolute = item.internals.positionAbsolute;
          const flowNode = flowNodeById.get(id);
          if (flowNode) flowNode.position = item.position;
          renderNodePosition(id);
        }
        renderEdges();
        persistGraph();
      },
    };
  }

  const canvasView = createCanvasView(elements, (viewport) => deps.onViewportChange(viewport));
  const zoom = createCanvasZoom({ elements, panZoom: canvasView.panZoom, nodeLookup, transform: canvasView.transform });
  wireCanvasDrop(elements.pane, { transform: canvasView.transform, flowPath, createNode });

  function renderNodePosition(id: string): void {
    const internal = nodeLookup.get(id);
    const el = nodeEls.get(id);
    if (!internal || !el) return;
    el.style.transform = `translate(${internal.position.x}px, ${internal.position.y}px)`;
  }

  // Recomputes a node's measured size and handle-hit-test bounds from its
  // current rendered rect — needed after mount and after every resize-drag
  // step, since XYHandle and the edge drawing below place endpoints off
  // `internal.internals.handleBounds`, not off live DOM measurement.
  function measureNode(id: string): void {
    const internal = nodeLookup.get(id);
    const el = nodeEls.get(id);
    if (!internal || !el) return;
    const rect = el.getBoundingClientRect();
    const scale = canvasView.transform()[2];
    internal.measured = { width: rect.width / scale, height: rect.height / scale };
    if (flowNodeById.get(id)?.collapsed) {
      // Collapsed: every real port is display:none and would measure as an
      // all-zero rect, so every edge touching this node converges on one
      // synthetic point per side, centered on the title bar. The handle
      // lookup's fallback (exact port id, else an id-less entry) resolves any
      // port id to this single entry.
      const titleHeight = el.querySelector(".flow-node-title")?.getBoundingClientRect().height ?? rect.height;
      const y = titleHeight / 2 / scale;
      const width = rect.width / scale;
      internal.internals.handleBounds = {
        target: [{ id: null, nodeId: id, type: "target", position: Position.Left, x: 0, y, width: 0, height: 0 }],
        source: [{ id: null, nodeId: id, type: "source", position: Position.Right, x: width, y, width: 0, height: 0 }],
      };
      return;
    }
    const handleBounds: NodeHandleBounds = {
      source: getHandleBounds("source", el, rect, scale, id),
      target: getHandleBounds("target", el, rect, scale, id),
    };
    internal.internals.handleBounds = handleBounds;
  }

  // `from` needs manual conversion into screen space here: XYHandle's
  // ConnectionState mixes coordinate spaces (`from` flow-space, `to` already
  // screen-space), and this path's layer sits outside the pan/zoom transform.
  // The drawn wires (wires.ts): a loose end for each naming a missing node,
  // and the line a connection drag draws.
  const wires = createWires({
    edgeGroup: elements.edgeGroup,
    viewport: elements.viewport,
    graph: () => graph,
    nodeLookup,
    findHandle,
    portTypeOf,
    startConnection,
    openHandleMenu: (...args) => menus.openHandleMenu(...args),
    connectionPath: elements.connectionPath,
    locked,
  });
  const renderEdges = (): void => markLeftOut(nodeEls, wires.render());
  const renderConnectionLine = (): void => wires.drawConnection(connectionState, canvasView.transform());

  function addEdge(connection: Connection): void {
    const id = `e-${connection.source}-${connection.sourceHandle}-${connection.target}-${connection.targetHandle}`;
    if (graph.edges.some((e) => e.id === id)) return;
    if (!connection.sourceHandle || !connection.targetHandle) return;
    // xyflow calls a pin a handle; the saved graph keeps Pragma's own names (protocol.md, Storage).
    const edge: FlowEdgeInstance = {
      id,
      source: connection.source,
      sourcePort: connection.sourceHandle,
      target: connection.target,
      targetPort: connection.targetHandle,
    };
    // An input port takes at most one edge — connecting a new one replaces
    // whatever was already wired into this exact (target, targetPort),
    // the way dragging onto an already-filled config field overwrites.
    //
    // The replaced edge's source may have just lost its last connection, so
    // it needs the visibility correction a manual disconnect gets —
    // collected before the filter drops it.
    const replaced = graph.edges.filter(
      (e) => e.target === connection.target && e.targetPort === connection.targetHandle,
    );
    graph.edges = graph.edges.filter((e) => e.target !== connection.target || e.targetPort !== connection.targetHandle);
    graph.edges.push(edge);
    renderEdges();
    persistGraph();
    cards.updateInputWidgetVisibility(edge.target, edge.targetPort);
    cards.updateSourceDependents(edge.target);
    cards.updateOutputHandleVisibility(edge.source, edge.sourcePort);
    for (const old of replaced) cards.updateOutputHandleVisibility(old.source, old.sourcePort);
  }

  function startConnection(
    event: MouseEvent,
    nodeId: string,
    handleId: string,
    type: XYHandleType,
    handleEl: Element,
    loose?: FlowEdgeInstance,
  ): void {
    if (locked()) return;
    fromHandle = findHandle(nodeId, handleId, type);
    XYHandle.onPointerDown(event, {
      autoPanOnConnect: false,
      connectionMode: ConnectionMode.Strict,
      connectionRadius: 20,
      domNode: elements.pane,
      handleId,
      nodeId,
      isTarget: type === "target",
      nodeLookup,
      lib: "system",
      flowId: null,
      handleDomNode: handleEl,
      updateConnection: (state) => {
        connectionState = state;
        renderConnectionLine();
      },
      panBy: async () => false,
      cancelConnection: () => {
        connectionState = initialConnection;
        renderConnectionLine();
        wires.lift(undefined);
      },
      onConnectStart: () => wires.lift(loose),
      // A loose end's wire moves to the pin it's dropped on, so the one
      // naming the missing node goes, persisted even if addEdge finds the
      // new wire already there.
      onConnect: (connection) => {
        if (loose) {
          graph.edges = graph.edges.filter((edge) => edge !== loose);
          persistGraph();
        }
        addEdge(connection);
      },
      onConnectEnd: () => {
        connectionState = initialConnection;
        renderConnectionLine();
      },
      isValidConnection: (edgeOrConnection) => {
        const sourceType = portTypeOf(edgeOrConnection.source, edgeOrConnection.sourceHandle ?? null, "source");
        const targetType = portTypeOf(edgeOrConnection.target, edgeOrConnection.targetHandle ?? null, "target");
        return sourceType !== null && targetType !== null && flowPortTypesCompatible(sourceType, targetType);
      },
      getTransform: canvasView.transform,
      getFromHandle: () => fromHandle,
    });
  }

  // A space read for the mounted flow — the capability-gated read the
  // executor makes at Run time, here for the editor's own pickers.
  const readForFlow = (targetPath: string): Promise<SandboxReadResult | undefined> =>
    activeFlow ? sandboxRead("flow", activeFlow.file.path, targetPath) : Promise.resolve(undefined);
  // The canvas's right-click menus (flowMenus.ts), over this view's graph,
  // node map and persistence. `cards` is a getter because the node cards,
  // created below, take these menus as their own deps.
  const menus = createFlowMenus({
    contextMenu: deps.contextMenu,
    locked,
    graph: () => graph,
    cards: () => cards,
    flowNodeById,
    renderEdges,
    persistGraph,
    createNode,
    cloneNode,
    removeNode,
  });

  // What the node cards and App Mode both work through: this view's
  // persistence and reads, and the open Flow's path, which every path a node
  // stores is read from.
  const nodeDeps = {
    graph: () => graph,
    persistGraph,
    saveGraphNow,
    ensureCapability: ensureFlowCapability,
    read: readForFlow,
    pickedImages,
    directoryChildren: findDirectoryChildren,
    flowPath,
    modelFields: createModelFields(deps),
    contextMenu: deps.contextMenu,
    regenerate: (nodeId: string) => void canvasRun.run(nodeId),
    loadFile: (stored: string) => fetchFile(flowTreePath(flowPath(), stored)),
    injectAppletRuntime: injectAppletNodeRuntime,
    previewResult: deps.previewResult,
  };

  // The node cards (nodeCard.ts), over those and the canvas and its menus;
  // the canvas places and connects what they build.
  const cards = createNodeCards({
    ...nodeDeps,
    zoom: () => canvasView.transform()[2],
    startConnection,
    onLayoutChange: (nodeId) => {
      measureNode(nodeId);
      renderEdges();
    },
    menus,
    locked,
    remount: (nodeId) => remountNodes([nodeId]),
    fileMissing: deps.problems.fileMissing,
  });

  // The published-form counterpart to the canvas (appMode.ts), over the
  // same, plus the graph run and a card remount.
  const appMode = createAppMode({
    ...nodeDeps,
    elements,
    run: () => canvasRun.run(),
    showRuns: deps.showRuns,
    remountNodes,
  });

  // Run (canvasRun.ts), over the open Flow, its cards and form, and its saves.
  const canvasRun = createCanvasRun({
    ...deps,
    flow: () => activeFlow,
    locked,
    graph: () => graph,
    node: (nodeId) => flowNodeById.get(nodeId),
    nodeEls,
    cards,
    appMode,
    saves,
    history,
    remountNodes,
    pickedImages,
    ensureCapability: (capability) => ensureFlowCapability(capability),
  });

  function remountNodes(nodeIds: readonly string[]): void {
    for (const nodeId of nodeIds) {
      const flowNode = flowNodeById.get(nodeId);
      nodeEls.get(nodeId)?.remove();
      dragInstances.get(nodeId)?.destroy();
      if (!flowNode) continue;
      mountNode(flowNode);
      cards.syncWiring(flowNode);
    }
    renderEdges();
  }

  // Mounts an already-constructed FlowNodeInstance (fresh or loaded from
  // disk): the card itself comes from nodeCard.ts; this places it, records
  // it for xyflow, measures it, and wires XYDrag.
  function mountNode(flowNode: FlowNodeInstance): void {
    if (!FLOW_NODE_REGISTRY[flowNode.type]) return;
    flowNodeById.set(flowNode.id, flowNode);

    const internal: InternalNodeBase = {
      id: flowNode.id,
      position: flowNode.position,
      data: {},
      measured: { width: NODE_WIDTH, height: 0 },
      internals: {
        positionAbsolute: { ...flowNode.position },
        z: 0,
        userNode: { id: flowNode.id, position: flowNode.position, data: {} } as NodeBase,
      },
    };
    nodeLookup.set(flowNode.id, internal);

    const el = cards.build(flowNode);
    el.style.transform = `translate(${flowNode.position.x}px, ${flowNode.position.y}px)`;
    elements.viewport.appendChild(el);
    nodeEls.set(flowNode.id, el);
    canvasRun.restyle(flowNode.id);
    measureNode(flowNode.id);

    const dragInstance = XYDrag({ getStoreItems });
    dragInstance.update({ domNode: el, nodeId: flowNode.id, isSelectable: true, noDragClassName: "nodrag" });
    dragInstances.set(flowNode.id, dragInstance);
  }

  async function createNode(type: string, x: number, y: number, seed?: NodeConfig): Promise<void> {
    const definition = FLOW_NODE_REGISTRY[type];
    if (!definition) return;
    const id = `${type}-${nextNodeSuffix++}`;
    const config: NodeConfig = { ...seed };
    for (const widget of definition.inputWidgets ?? []) {
      if (widget.defaultValue !== undefined) config[widget.portId] ??= widget.defaultValue;
    }
    const flowNode: FlowNodeInstance = { id, type, typeVersion: definition.version, position: { x, y }, config };
    graph.nodes.push(flowNode);
    // A seeded path is a file the writer just dragged in. The grant and the
    // picker's first read are both checked against the graph on disk, so the
    // file must name this node first; the drag is the consent (protocol.md).
    const dragged = seed !== undefined && (await saveGraphNow()) ? definition.capabilityFor?.(config) : undefined;
    if (dragged) await ensureFlowCapability(dragged, true);
    mountNode(flowNode);
    persistGraph();
  }

  // Duplicates a node's type/config/label/color/size/collapsed state at an
  // offset, deliberately without edges: a fresh, unconnected copy of the
  // widget values. One node at a time; there is no multi-select.
  function cloneNode(nodeId: string): void {
    const source = flowNodeById.get(nodeId);
    if (!source) return;
    // Every field, typeVersion too rather than the registry's current one: a
    // clone of an old node is still a copy of that old node, not a fresh
    // instance authored against the current shape.
    const flowNode: FlowNodeInstance = {
      ...structuredClone(source),
      id: `${source.type}-${nextNodeSuffix++}`,
      position: { x: source.position.x + 30, y: source.position.y + 30 },
    };
    graph.nodes.push(flowNode);
    mountNode(flowNode);
    persistGraph();
  }

  function clearGraph(): void {
    elements.lockNotice.hidden = true;
    selection.select(null);
    for (const el of nodeEls.values()) el.remove();
    for (const instance of dragInstances.values()) instance.destroy();
    nodeLookup.clear();
    nodeEls.clear();
    dragInstances.clear();
    flowNodeById.clear();
    cards.clear();
    pickedImages.clear();
    graph = { nodes: [], edges: [] };
    renderEdges();
    // Resets to Graph Mode as a neutral baseline for closing the flow. A file
    // load clears first too but then restores that file's remembered mode,
    // so this reset is never the last word for an actual open.
    appMode.setActive(false);
  }

  // Takes a node's card off the canvas with every per-node map entry (the
  // nodeId:portId-keyed ones need a prefix scan, not a single delete), and
  // tells the save check the node is gone.
  function unmountNode(nodeId: string): void {
    selection.forget(nodeId);
    nodeEls.get(nodeId)?.remove();
    nodeEls.delete(nodeId);
    dragInstances.get(nodeId)?.destroy();
    dragInstances.delete(nodeId);
    nodeLookup.delete(nodeId);
    flowNodeById.delete(nodeId);
    cards.forget(nodeId);
    pickedImages.delete(nodeId);
    saves.removed(nodeId);
  }

  // Tears a node out of the graph with every edge touching it in either
  // direction. A surviving node whose widget input just lost its only edge
  // gets its fallback control back, as flowMenus.ts's Disconnect does for a
  // single edge.
  function removeNode(nodeId: string): void {
    unmountNode(nodeId);
    graph.nodes = graph.nodes.filter((n) => n.id !== nodeId);
    const removedEdges = graph.edges.filter((e) => e.source === nodeId || e.target === nodeId);
    graph.edges = graph.edges.filter((e) => e.source !== nodeId && e.target !== nodeId);
    renderEdges();
    persistGraph();
    for (const edge of removedEdges) {
      if (edge.target === nodeId) {
        // The removed node was this edge's target — its own port entries are
        // already gone above, but the edge's *source* is a surviving node
        // whose output pin may have just lost its last connection.
        cards.updateOutputHandleVisibility(edge.source, edge.sourcePort);
        continue;
      }
      cards.updateInputWidgetVisibility(edge.target, edge.targetPort);
      cards.updateSourceDependents(edge.target);
    }
  }

  // Undo and Redo: the canvas brought to a recorded graph, building again
  // only the cards whose node changed (flowHistory.ts).
  function restore(target: RecordedGraph | undefined): void {
    if (!target) return;
    const plan = planRestore(graph, target);
    const selected = selection.id;
    for (const id of plan.removed) unmountNode(id);
    graph = { ...target, nodes: plan.nodes, viewport: graph.viewport, appModeActive: graph.appModeActive };
    for (const { id, position } of plan.moved) {
      const [flowNode, internal] = [flowNodeById.get(id), nodeLookup.get(id)];
      if (!flowNode || !internal) continue;
      flowNode.position = position;
      internal.position = position;
      internal.internals.positionAbsolute = { ...position };
      renderNodePosition(id);
    }
    for (const node of plan.nodes) if (plan.rebuilt.includes(node.id)) flowNodeById.set(node.id, node);
    remountNodes(plan.rebuilt);
    for (const id of plan.rewired) {
      const flowNode = flowNodeById.get(id);
      if (flowNode) cards.syncWiring(flowNode);
    }
    selection.select(null);
    if (selected && flowNodeById.has(selected)) selection.select(selected);
    persistGraph();
  }

  // Keys are the canvas's while focus is on it or on a card's control that
  // takes no typing: a text field keeps its own Undo and Delete.
  function canvasHasKeys(): boolean {
    const focused = document.activeElement;
    return !locked() && !appMode.isActive() && !!focused && elements.pane.contains(focused) && !takesTyping(focused);
  }

  elements.pane.addEventListener("contextmenu", (event) => {
    // Text that selects, a config field's or a Prompt/Note box's, is left to
    // the text menu (lib/textMenu.ts) rather than suppressed below.
    if ((event.target as HTMLElement).closest("input, textarea, .cm-content")) return;
    // Suppress the browser's own menu everywhere else in the pane, node
    // cards included — a native menu over a card reads as a bug.
    event.preventDefault();
    // The title bar and pins have their own menus and the rest of a card
    // has none; this pane-level listener only ever handles empty canvas.
    if ((event.target as HTMLElement).closest(".flow-node")) return;
    const position = paneFlowPosition(elements.pane, canvasView.transform(), event);
    menus.openContextMenu(event.clientX, event.clientY, position.x, position.y);
  });

  // ---- Capabilities ----
  // Derived from the graph as it is now, never stored; the server digests it.
  function subjectFor(flow: NonNullable<typeof activeFlow>): BrokerSubject {
    return {
      kind: "flow",
      path: flow.file.path,
      name: flow.file.name ?? "",
      capabilities: () => flowBrokerCapabilities(graph, flow.grantedCapabilities, flow.file.path),
      grantedCapabilities: flow.grantedCapabilities,
      unattended: flowUnattendedGrant(flow.file),
    };
  }

  // Lazy, first-use; resolves false on Deny or a flow replaced while the
  // prompt waited, and rejects, naming why, on a path that names nothing.
  async function ensureFlowCapability(capability: FlowCapabilityDeclaration, consented?: boolean): Promise<boolean> {
    return !!activeFlow && broker.ensure(brokerCapability(capability, activeFlow.file.path), undefined, consented);
  }

  return {
    render(file: FlowFileResponse, local?: { viewport?: Viewport; appMode?: boolean }): void {
      clearGraph();
      activeFlow = { file, grantedCapabilities: new Set(file.grantedCapabilities) };
      elements.lockNotice.textContent = file.locked ? lockMessage(file.locked, file.version) : "";
      elements.lockNotice.hidden = !locked();
      broker.mount(subjectFor(activeFlow), elements.host);
      // Every graph-level field the file has, never a list of them: one left
      // off a list shows all session and is dropped by the next save.
      //
      // And every node and wire before any card is built: a card draws a pin
      // for a wire naming a port its node lacks, and a card may save while
      // it's built, so a graph filled in as cards mount would save only the
      // nodes before it.
      graph = { ...file.graph, nodes: [...file.graph.nodes], edges: [...file.graph.edges] };
      saves.opened(graph);
      history.opened(file.path, graph);
      for (const node of file.graph.nodes) mountNode(node);
      for (const node of file.graph.nodes) cards.syncWiring(node);
      canvasView.show(local?.viewport ?? file.graph.viewport);
      // nextNodeSuffix always starts at 1 per view construction — bump it
      // past any trailing "-N" already present in a loaded id, otherwise
      // the "add node" menu can mint an id that collides with one already
      // on the canvas (Map.set on collision silently overwrites, orphaning
      // the earlier node's DOM).
      for (const node of file.graph.nodes) {
        const match = /-(\d+)$/.exec(node.id);
        if (match) nextNodeSuffix = Math.max(nextNodeSuffix, Number(match[1]) + 1);
      }
      renderEdges();
      // After every node has mounted and the edges are drawn: building the
      // App Mode form reads the live graph's nodes and edges, not file.graph.
      appMode.setActive(local?.appMode ?? file.graph.appModeActive === true);
      deps.onRendered();
    },
    clear(): void {
      clearGraph();
      activeFlow = undefined;
      broker.unmount();
      history.closed();
    },
    isActive: () => activeFlow !== undefined,
    getFileName: () => activeFlow?.file.name,
    setDisplayName: (name) => saves.rename(name),
    setMetadata: (metadata) => saves.setMetadata(metadata),
    run: () => canvasRun.run(),
    setRunCount: (count) => appMode.setRunCount(count),
    showPermissionsPanel: () => broker.showPermissions(),
    hasTransient: () => zoom.isOpen() || selection.id !== null,
    dismissTransient() {
      if (zoom.isOpen()) zoom.dismiss();
      else selection.select(null);
    },
    selectedNode: () => (appMode.isActive() ? undefined : (selection.id ?? undefined)),
    canEdit(edit) {
      if (!canvasHasKeys()) return false;
      if (edit === "remove" || edit === "disable") return selection.id !== null;
      return edit === "undo" ? history.canUndo() : history.canRedo();
    },
    edit(edit) {
      if (edit === "undo" || edit === "redo") restore(edit === "undo" ? history.undo() : history.redo());
      else if (selection.id) (edit === "remove" ? removeNode : menus.toggleDisabled)(selection.id);
    },
    toggleAppMode(): void {
      if (!activeFlow) return;
      appMode.setActive(!appMode.isActive());
      deps.onAppModeChange(appMode.isActive());
    },
    isAppModeActive: () => appMode.isActive(),
    defaultViewDiffers: () =>
      activeFlow !== undefined &&
      !locked() &&
      (canvasView.differsFrom(graph.viewport) || appMode.isActive() !== (graph.appModeActive === true)),
    setDefaultView() {
      if (!activeFlow || locked()) return Promise.resolve(false);
      if (canvasView.differsFrom(graph.viewport)) graph.viewport = canvasView.current();
      // Only a change of meaning is written: an absent flag already means the canvas.
      if (appMode.isActive() !== (graph.appModeActive === true)) {
        if (appMode.isActive()) graph.appModeActive = true;
        else delete graph.appModeActive;
      }
      return saveGraphNow();
    },
  };
}
