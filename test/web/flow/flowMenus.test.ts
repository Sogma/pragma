// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FlowEdgeInstance, FlowGraph, FlowNodeInstance } from "../../../src/protocol/types.ts";
import { CHIP_MENU, createFlowMenus, type FlowMenuDeps } from "../../../web/flow/flowMenus.ts";
import type { MenuItem, MenuOpenOptions } from "../../../web/services/menus.ts";

function edge(source: string, sourcePort: string, target: string, targetPort: string): FlowEdgeInstance {
  return { id: `e-${source}-${sourcePort}-${target}-${targetPort}`, source, sourcePort, target, targetPort };
}

function setup(overrides: Partial<FlowMenuDeps> = {}) {
  const opened: MenuOpenOptions[] = [];
  const graph: FlowGraph = { nodes: [], edges: [] };
  const flowNodeById = new Map<string, FlowNodeInstance>();
  const cards = {
    updateInputWidgetVisibility: vi.fn(),
    updateOutputHandleVisibility: vi.fn(),
    updateSourceDependents: vi.fn(),
  };
  const deps: FlowMenuDeps = {
    contextMenu: {
      open: (options) => {
        opened.push(options);
      },
      close: vi.fn(),
      isOpen: () => false,
    },
    locked: () => false,
    graph: () => graph,
    cards: () => cards,
    flowNodeById,
    renderEdges: vi.fn(),
    persistGraph: vi.fn(),
    createNode: vi.fn(async () => {}),
    cloneNode: vi.fn(),
    removeNode: vi.fn(),
    ...overrides,
  };
  return { menus: createFlowMenus(deps), deps, cards, graph, flowNodeById, opened };
}

const labels = (items: MenuItem[] = []): (string | undefined)[] =>
  items.map((item) => (typeof item.label === "string" ? item.label : undefined));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("flowMenus: node menu", () => {
  it("leads with the type's own name, not a custom label, and offers the node actions in order", () => {
    const { menus, flowNodeById, opened } = setup();
    flowNodeById.set("toggleText-1", {
      id: "toggleText-1",
      type: "toggleText",
      position: { x: 0, y: 0 },
      config: {},
      label: "My Renamed Node",
    } as FlowNodeInstance);

    menus.openNodeMenu(5, 6, "toggleText-1", vi.fn(), vi.fn(), vi.fn());

    expect(opened).toHaveLength(1);
    expect(opened[0].ariaLabel).toBe("Node");
    expect(labels(opened[0].items)).toEqual([
      "TOGGLE",
      "Color…",
      "Rename…",
      "Comment…",
      "Info",
      "Disable",
      "Clone",
      "Remove",
    ]);
    expect(opened[0].items?.[0].data).toEqual({ nodeType: "toggleText" });
  });

  // Named for where it goes, and an edit like any other: saved, and the
  // wires redrawn, which mark the cards a run leaves out.
  it("disables a node from Disable and enables it again from Enable", () => {
    const { menus, deps, flowNodeById, opened } = setup();
    const node = { id: "showText-1", type: "showText", position: { x: 0, y: 0 }, config: {} } as FlowNodeInstance;
    flowNodeById.set(node.id, node);
    const pick = (label: string) =>
      opened
        .at(-1)
        ?.items?.find((item) => item.label === label)
        ?.run?.({} as never, undefined);

    menus.openNodeMenu(0, 0, node.id, vi.fn(), vi.fn(), vi.fn());
    pick("Disable");
    expect(node.mode).toBe("disabled");
    menus.openNodeMenu(0, 0, node.id, vi.fn(), vi.fn(), vi.fn());
    expect(labels(opened.at(-1)?.items)).toContain("Enable");
    pick("Enable");
    expect(node).not.toHaveProperty("mode");
    expect(deps.renderEdges).toHaveBeenCalledTimes(2);
    expect(deps.persistGraph).toHaveBeenCalledTimes(2);
  });

  it("disables nothing in a locked Flow", () => {
    const { menus, deps, flowNodeById } = setup({ locked: () => true });
    const node = { id: "showText-1", type: "showText", position: { x: 0, y: 0 }, config: {} } as FlowNodeInstance;
    flowNodeById.set(node.id, node);
    menus.toggleDisabled(node.id);
    expect(node.mode).toBeUndefined();
    expect(deps.persistGraph).not.toHaveBeenCalled();
  });

  it("starts the card's comment edit from Comment…", () => {
    const { menus, flowNodeById, opened } = setup();
    flowNodeById.set("toggleText-1", {
      id: "toggleText-1",
      type: "toggleText",
      position: { x: 0, y: 0 },
      config: {},
    } as FlowNodeInstance);
    const onComment = vi.fn();

    menus.openNodeMenu(0, 0, "toggleText-1", vi.fn(), vi.fn(), onComment);
    opened[0].items?.find((item) => item.label === "Comment…")?.run?.({} as never, undefined);

    expect(onComment).toHaveBeenCalledTimes(1);
  });

  // contextMenu.ts draws a separator wherever the group changes.
  it("sets Info apart from the edits above it and from Disable, Clone and Remove below it", () => {
    const { menus, flowNodeById, opened } = setup();
    flowNodeById.set("toggleText-1", {
      id: "toggleText-1",
      type: "toggleText",
      position: { x: 0, y: 0 },
      config: {},
    } as FlowNodeInstance);

    menus.openNodeMenu(0, 0, "toggleText-1", vi.fn(), vi.fn(), vi.fn());

    expect(opened[0].items?.map((item) => [item.label, item.group])).toEqual([
      ["TOGGLE", undefined],
      ["Color…", undefined],
      ["Rename…", undefined],
      ["Comment…", undefined],
      ["Info", "info"],
      ["Disable", "graph"],
      ["Clone", "graph"],
      ["Remove", "graph"],
    ]);
  });

  it("names the node's id first under Info", () => {
    const { menus, flowNodeById, opened } = setup();
    flowNodeById.set("toggleText-1", {
      id: "toggleText-1",
      type: "toggleText",
      position: { x: 0, y: 0 },
      config: {},
    } as FlowNodeInstance);

    menus.openNodeMenu(0, 0, "toggleText-1", vi.fn(), vi.fn(), vi.fn());
    const info = opened[0].items?.find((item) => item.label === "Info")?.submenu;
    if (!Array.isArray(info)) throw new Error("Info has no flyout");

    expect(labels(info)).toEqual(["Id", "Current version", "Saved version"]);
    expect(info[0].detail).toBe("toggleText-1");
  });

  // No confirmation: Undo brings the node back.
  it("removes the node on the click", () => {
    const { menus, deps, flowNodeById, opened } = setup();
    flowNodeById.set("n1", { id: "n1", type: "toggleText", position: { x: 0, y: 0 }, config: {} } as FlowNodeInstance);

    menus.openNodeMenu(0, 0, "n1", vi.fn(), vi.fn(), vi.fn());
    const remove = opened[0].items?.find((item) => item.label === "Remove");
    expect(remove?.danger).toBe(true);

    remove?.run?.({} as never, undefined);
    expect(deps.removeNode).toHaveBeenCalledWith("n1");
  });
});

describe("flowMenus: pin menu", () => {
  it("offers only the type row when the handle has no edges", () => {
    const { menus, opened } = setup();

    menus.openHandleMenu(1, 2, "text", []);

    expect(opened[0].ariaLabel).toBe("Pin");
    expect(labels(opened[0].items)).toEqual(["TEXT"]);
    expect(opened[0].items?.[0].className).toBe("pin-type-label type-text");
  });

  it("leaves the type row out for a pin whose type isn't known", () => {
    const { menus, opened } = setup();
    menus.openHandleMenu(0, 0, null, [edge("showText-1", "renamed", "gone-1", "text")]);
    expect(labels(opened[0].items)).toEqual(["Disconnect"]);
  });

  it("drops every edge on the clicked handle and corrects both ends' visibility", async () => {
    const { menus, deps, cards, graph, opened } = setup();
    const a = edge("src", "out", "dst", "in");
    const b = edge("src", "out", "other", "in");
    const unrelated = edge("x", "out", "y", "in");
    graph.edges = [a, b, unrelated];

    menus.openHandleMenu(1, 2, "image", [a, b]);
    expect(labels(opened[0].items)).toEqual(["IMAGE", "Disconnect"]);

    await opened[0].items?.[1].run?.({} as never, undefined);

    expect(graph.edges).toEqual([unrelated]);
    expect(deps.renderEdges).toHaveBeenCalledOnce();
    expect(deps.persistGraph).toHaveBeenCalledOnce();
    // A source fanning out loses one connection per edge; each edge's target
    // gets its fallback widget back.
    expect(cards.updateInputWidgetVisibility.mock.calls).toEqual([
      ["dst", "in"],
      ["other", "in"],
    ]);
    expect(cards.updateOutputHandleVisibility.mock.calls).toEqual([
      ["src", "out"],
      ["src", "out"],
    ]);
  });
});

describe("flowMenus: field menu", () => {
  it("names the direction the toggle is about to go", () => {
    const { menus, opened } = setup();

    menus.openExposeMenu(0, 0, "text", false, vi.fn());
    menus.openExposeMenu(0, 0, "text", true, vi.fn());

    expect(labels(opened[0].items)).toEqual(["TEXT", "Expose"]);
    expect(labels(opened[1].items)).toEqual(["TEXT", "Unexpose"]);
  });

  it("ends with what the field itself offers", () => {
    const { menus, opened } = setup();

    menus.openExposeMenu(0, 0, "image", false, vi.fn(), [{ label: "Clear", run: vi.fn() }]);

    expect(labels(opened[0].items)).toEqual(["IMAGE", "Expose", "Clear"]);
  });
});

// A flow whose format this build can't write must not offer an edit it
// would then refuse to save (docs/protocol.md's Versioning rule).
describe("flowMenus: chip menu", () => {
  it("opens the registered chip menu on the chip's path, even in a locked flow", () => {
    const { menus, opened } = setup({ locked: () => true });
    menus.openChipMenu(3, 4, { file: "notes/a.md" });
    menus.openChipMenu(3, 4, { folder: "notes" });

    expect(opened.map(({ menu, arg, at, ariaLabel }) => ({ menu, arg, at, ariaLabel }))).toEqual([
      { menu: CHIP_MENU, arg: { file: "notes/a.md" }, at: { x: 3, y: 4 }, ariaLabel: "File" },
      { menu: CHIP_MENU, arg: { folder: "notes" }, at: { x: 3, y: 4 }, ariaLabel: "Folder" },
    ]);
  });

  // Clear edits the Flow, so a locked one's chip doesn't hand it over.
  it("hands the menu the chip's Clear, but not in a locked flow", () => {
    const clear = vi.fn();
    const open = setup();
    open.menus.openChipMenu(3, 4, { file: "notes/a.md" }, clear);
    expect(open.opened[0].arg).toEqual({ file: "notes/a.md", clear });

    const locked = setup({ locked: () => true });
    locked.menus.openChipMenu(3, 4, { file: "notes/a.md" }, clear);
    expect(locked.opened[0].arg).toEqual({ file: "notes/a.md" });
  });
});

describe("flowMenus: a locked flow", () => {
  it("opens no menu that would start an edit", () => {
    const { menus, deps, opened } = setup({ locked: () => true });

    menus.openContextMenu(0, 0, 10, 20);
    menus.openNodeMenu(0, 0, "n1", vi.fn(), vi.fn(), vi.fn());
    menus.openHandleMenu(0, 0, "text", [edge("a", "out", "b", "in")]);

    expect(opened).toEqual([]);
    expect(deps.createNode).not.toHaveBeenCalled();
  });

  it("still opens the field menu, whose toggle the caller has already gated", () => {
    const { menus, opened } = setup({ locked: () => true });

    menus.openExposeMenu(0, 0, "text", false, vi.fn());

    expect(labels(opened[0].items)).toEqual(["TEXT", "Expose"]);
  });
});
