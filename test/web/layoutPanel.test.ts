// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { SmallCardTile, TableColumn, TableLayout } from "../../src/protocol/types.ts";
import { createLayoutPanel, type LayoutPanelDeps } from "../../web/layoutPanel.ts";

beforeAll(() => {
  globalThis.ResizeObserver = class {
    constructor(private readonly measure: ResizeObserverCallback) {}
    observe() {
      this.measure([], this as unknown as ResizeObserver);
    }
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

afterEach(() => document.body.replaceChildren());

const columns: TableColumn[] = [
  { id: "frame", type: "media", label: "Frame" },
  { id: "shot", type: "text", label: "Shot" },
  { id: "size", type: "select", label: "Size", options: ["Wide", "Close"] },
  { id: "lens", type: "integer", label: "Lens" },
];

// A Table's panel: Frame is the picture, Shot the title, Size the badge.
function panel(start?: SmallCardTile[]) {
  let card = start;
  const deps = {
    layout: vi.fn((): TableLayout => "cards"),
    setLayout: vi.fn(),
    fields: () => columns,
    parts: () => ({ picture: columns[0], title: columns[1], badge: columns[2] }),
    ownTitle: false,
    card: () => card,
    arrange: vi.fn((tiles: SmallCardTile[]) => {
      card = tiles;
    }),
    count: () => 2,
    title: (index: number) => ["12A", "12B"][index] ?? "",
    content: (tile: { part: string; field?: TableColumn }, index: number) =>
      Object.assign(document.createElement("span"), { textContent: `${tile.field?.id ?? tile.part}:${index}` }),
    contextMenu: { open: vi.fn(), close: vi.fn(), isOpen: () => false },
  } satisfies LayoutPanelDeps;
  const made = createLayoutPanel(deps);
  document.body.append(made.element);
  const button = (label: string) =>
    [...made.element.querySelectorAll<HTMLButtonElement>("button")].find((each) => each.textContent === label);
  return { made, deps, button };
}

describe("createLayoutPanel", () => {
  it("starts from the card the cards view composes, and offers what is off it, never the title's column", () => {
    const { made, deps, button } = panel();
    const shown = () => [...made.element.querySelectorAll(".small-card-tile")].map((tile) => tile.textContent);
    expect(shown()).toEqual(["frame:0", "shot:0", "size:0", "Lenslens:0"]);
    expect(deps.arrange).not.toHaveBeenCalled();

    const remove = (index: number) =>
      (made.element.querySelectorAll(".tile-grid-remove")[index] as HTMLElement).click();
    remove(3);
    expect(deps.arrange).toHaveBeenLastCalledWith([{ field: "frame" }, { title: true }, { field: "size" }]);
    remove(1);
    button("+ Field")?.click();
    const offered = deps.contextMenu.open.mock.calls.at(-1)?.[0] as { items: { label: string }[] };
    expect(offered.items.map((item) => item.label)).toEqual(["Title", "Lens"]);
  });

  it("sizes a tile from its keys, and adds a heading at the end, named in place", () => {
    const { made, deps, button } = panel([{ field: "lens" }]);
    const handle = made.element.querySelector(".small-card-tile > .data-cards-tile") as HTMLElement;
    handle.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowLeft", altKey: true, shiftKey: true, bubbles: true, cancelable: true }),
    );
    expect(deps.arrange).toHaveBeenLastCalledWith([{ field: "lens", columns: 3, rows: 1 }]);
    button("+ Heading")?.click();
    expect(deps.arrange).toHaveBeenLastCalledWith([{ field: "lens", columns: 3, rows: 1 }, { heading: "Heading" }]);
    expect(made.element.querySelector(".small-card-tile.is-heading input")).not.toBeNull();
  });

  it("steps through the rows, and hands a layout picked back to the pane", () => {
    const { made, deps, button } = panel();
    (made.element.querySelector('[aria-label="Next row"]') as HTMLButtonElement).click();
    expect(made.element.querySelector(".small-card-tile")?.textContent).toBe("frame:1");
    expect(made.element.querySelector(".layout-panel-step-name")?.textContent).toBe("12B");
    expect(button("Cards")?.getAttribute("aria-pressed")).toBe("true");
    button("List")?.click();
    expect(deps.setLayout).toHaveBeenCalledWith("list");
  });
});
