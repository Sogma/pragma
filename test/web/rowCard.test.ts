// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { CardTile, TableColumn } from "../../src/protocol/types.ts";
import { createRowCard, ROW_CARD_MENU, type RowCardDeps } from "../../web/rowCard.ts";
import type { MenuOpenOptions } from "../../web/services/menus.ts";

// The tile grid measures itself as it is observed; here every grid is six
// columns wide, so a tile shows the span it was given.
beforeAll(() => {
  globalThis.ResizeObserver = class {
    constructor(private readonly measure: ResizeObserverCallback) {}
    observe() {
      this.measure([], this as unknown as ResizeObserver);
    }
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 900 });
});

afterEach(() => document.body.replaceChildren());

const FIELDS: TableColumn[] = [
  { id: "frame", label: "Frame", type: "media" },
  { id: "shot", label: "Shot", type: "text" },
  { id: "size", label: "Size", type: "select", options: ["Wide", "Close"] },
  { id: "lens", label: "Lens", type: "integer" },
];

const ROWS = [
  { shot: "12A", size: "Wide", lens: "24" },
  { shot: "12B", size: "Close", lens: "85" },
  { shot: "12C", size: "Wide", lens: "35" },
];

// A card over three shots. Each control is a quiet field holding the row's
// value, so a test reads which row a tile was drawn for.
function card(overrides: Partial<RowCardDeps> = {}, tiles?: CardTile[]) {
  const host = document.createElement("div");
  host.tabIndex = -1;
  const preview = document.createElement("div");
  host.append(preview);
  document.body.append(host);
  let arranged = tiles;
  let arrangeable = true;
  let rows = ROWS;
  const menu = {
    open: vi.fn((_options: MenuOpenOptions) => {}),
    close: vi.fn(),
    isOpen: vi.fn((_anchor?: HTMLElement) => false),
  };
  const deps = {
    host,
    count: () => rows.length,
    fields: () => FIELDS,
    card: () => arranged,
    cell: vi.fn((field: TableColumn, index: number, { multiline }: { multiline: boolean }) => {
      const control = document.createElement(multiline ? "textarea" : "input");
      control.className = "form-input form-input-quiet";
      control.value = rows[index]?.[field.id as keyof (typeof ROWS)[number]] ?? "";
      return control;
    }),
    title: (index: number) => rows[index]?.shot ?? "",
    source: () => "Scene 12",
    arrangeable: () => arrangeable,
    arrange: vi.fn((next: CardTile[]) => {
      arranged = next;
    }),
    closed: vi.fn(),
    contextMenu: menu,
    ...overrides,
  };
  const rowCard = createRowCard(deps);
  const lock = (on: boolean) => {
    arrangeable = !on;
  };
  const drop = (count: number) => {
    rows = ROWS.slice(0, count);
  };
  return { host, preview, deps, menu, rowCard, lock, drop };
}

const page = () => document.querySelector(".row-card-page") as HTMLElement;
const title = () => document.querySelector(".row-card-title")?.textContent;
const labels = () => [...document.querySelectorAll(".row-card-grid > *")].map((tile) => tile.textContent);
const tileOf = (label: string) =>
  [...document.querySelectorAll<HTMLElement>(".row-card-grid > *")].find((tile) => tile.textContent === label) ??
  [...document.querySelectorAll<HTMLElement>(".row-card-tile")].find(
    (tile) => tile.querySelector(".row-card-label")?.textContent === label,
  );
const span = (tile: HTMLElement | undefined) => [
  tile?.style.getPropertyValue("--tile-columns"),
  tile?.style.getPropertyValue("--tile-rows"),
];
const key = (target: Element, key: string, init: KeyboardEventInit = {}) =>
  target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));

describe("createRowCard", () => {
  it("lies beneath whatever else the pane lays over itself, hidden until a row opens", () => {
    const { host, preview, rowCard } = card();
    expect(host.firstElementChild?.className).toBe("pane-overlay row-card");
    expect(host.lastElementChild).toBe(preview);
    expect((host.firstElementChild as HTMLElement).hidden).toBe(true);
    expect(rowCard.isOpen()).toBe(false);
  });

  it("shows the row whole: its title, every field in order when the file arranges none, and its place", () => {
    const { host, rowCard } = card();
    rowCard.open(1);
    expect(rowCard.isOpen()).toBe(true);
    expect(rowCard.shown()).toBe(1);
    expect(title()).toBe("12B");
    expect([...document.querySelectorAll(".row-card-label")].map((label) => label.textContent)).toEqual([
      "Frame",
      "Shot",
      "Size",
      "Lens",
    ]);
    expect(document.querySelector(".row-card-facts-text")?.textContent).toBe("Row 2 of 3 · Scene 12");
    expect(document.activeElement).toBe(host);
  });

  it("sizes a field's tile by what it shows until it is sized, and a heading across the row", () => {
    const { rowCard } = card({}, [{ heading: "Camera" }, { field: "lens", columns: 2, rows: 2 }, { field: "frame" }]);
    rowCard.open(0);
    expect(labels()).toEqual(["Camera", "Lens", "Frame"]);
    expect(span(tileOf("Camera"))).toEqual(["6", "1"]);
    expect(span(tileOf("Lens"))).toEqual(["2", "2"]);
    expect(span(tileOf("Frame"))).toEqual(["3", "3"]);
  });

  it("leaves out a tile naming a field the file doesn't have", () => {
    const { rowCard } = card({}, [{ field: "gone" }, { field: "shot" }]);
    rowCard.open(0);
    expect(labels()).toEqual(["Shot"]);
  });

  it("holds the pane's own control for each field, in its own box, and many lines in a tall tile", () => {
    const { deps, rowCard } = card({}, [{ field: "shot", rows: 3 }, { field: "lens" }]);
    rowCard.open(2);
    expect(deps.cell).toHaveBeenCalledWith(FIELDS[1], 2, { multiline: true });
    expect(deps.cell).toHaveBeenCalledWith(FIELDS[3], 2, { multiline: false });
    const shot = tileOf("Shot")?.querySelector("textarea");
    expect(shot?.value).toBe("12C");
    expect(shot?.className).toBe("form-input");
    expect(tileOf("Lens")?.querySelector(".row-card-value")?.getAttribute("data-type")).toBe("integer");
  });

  it("steps through the rows by its arrows and the pane's arrow keys, never a field's", () => {
    const { host, rowCard } = card();
    rowCard.open(0);
    key(host, "ArrowRight");
    expect(title()).toBe("12B");
    key(host, "ArrowDown");
    expect(title()).toBe("12C");
    key(host, "ArrowDown");
    expect(title()).toBe("12C");
    key(host, "ArrowUp");
    key(host, "ArrowLeft");
    expect(title()).toBe("12A");
    (document.querySelector(".row-card-nav.is-next") as HTMLButtonElement).click();
    expect(title()).toBe("12B");

    key(document.querySelector(".row-card-value input") as Element, "ArrowRight");
    key(host, "ArrowRight", { altKey: true });
    expect(title()).toBe("12B");
  });

  it("closes on Space, and on a click on the backdrop, handing its row back to the pane", () => {
    const { host, deps, rowCard } = card();
    rowCard.open(1);
    key(host, " ");
    expect(rowCard.isOpen()).toBe(false);
    expect(deps.closed).toHaveBeenLastCalledWith(1);

    rowCard.open(2);
    const backdrop = host.firstElementChild as HTMLElement;
    backdrop.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    expect(rowCard.isOpen()).toBe(false);
    expect(deps.closed).toHaveBeenLastCalledWith(2);
  });

  it("hands nothing back when the pane closes it to show something else", () => {
    const { deps, rowCard } = card();
    rowCard.open(1);
    rowCard.close(false);
    expect(rowCard.isOpen()).toBe(false);
    expect(deps.closed).not.toHaveBeenCalled();
  });

  it("opens a row that is a file in a new tab, and offers nothing for one that isn't", () => {
    const openBeside = vi.fn();
    const { rowCard } = card({ pathOf: (index) => (index === 0 ? "shots/12a.md" : undefined), openBeside });
    rowCard.open(0);
    const open = document.querySelector(".row-card-open") as HTMLButtonElement;
    expect(open.getAttribute("aria-label")).toBe("Open in new tab");
    open.click();
    expect(openBeside).toHaveBeenCalledWith("shots/12a.md");
    rowCard.open(1);
    expect(document.querySelector(".row-card-open")).toBeNull();
  });

  it("moves a tile by its label, handing every tile back in its new order", () => {
    const { deps, rowCard } = card();
    rowCard.open(0);
    expect(page().classList.contains("is-arrangeable")).toBe(true);
    key(tileOf("Frame")?.querySelector(".row-card-label") as Element, "ArrowRight", { altKey: true });
    expect(deps.arrange).toHaveBeenLastCalledWith([
      { field: "shot" },
      { field: "frame" },
      { field: "size" },
      { field: "lens" },
    ]);
    expect([...document.querySelectorAll(".row-card-label")].map((label) => label.textContent)).toEqual([
      "Shot",
      "Frame",
      "Size",
      "Lens",
    ]);
  });

  it("sizes a tile from its keys, giving a field that gains lines the control for them", () => {
    const { deps, rowCard } = card();
    rowCard.open(1);
    key(tileOf("Shot")?.querySelector(".row-card-label") as Element, "ArrowDown", { altKey: true, shiftKey: true });
    expect(deps.arrange).toHaveBeenLastCalledWith([
      { field: "frame" },
      { field: "shot", columns: 3, rows: 2 },
      { field: "size" },
      { field: "lens" },
    ]);
    expect(span(tileOf("Shot"))).toEqual(["3", "2"]);
    expect(tileOf("Shot")?.querySelector("textarea")?.value).toBe("12B");
  });

  it("arranges nothing while it can't be arranged, its labels no stop for Tab", () => {
    const { deps, rowCard, lock } = card();
    lock(true);
    rowCard.open(0);
    expect(page().classList.contains("is-arrangeable")).toBe(false);
    const label = tileOf("Frame")?.querySelector(".row-card-label") as HTMLElement;
    expect([label.hasAttribute("tabindex"), label.hasAttribute("aria-keyshortcuts")]).toEqual([false, false]);
    key(label, "ArrowRight", { altKey: true });
    expect(deps.arrange).not.toHaveBeenCalled();

    lock(false);
    rowCard.refresh();
    const arrangeable = tileOf("Frame")?.querySelector(".row-card-label") as HTMLElement;
    expect(arrangeable.tabIndex).toBe(0);
  });

  it("opens its own menu from the ⋮ along its foot, and closes it from there", () => {
    const { menu, rowCard } = card();
    rowCard.open(0);
    const more = document.querySelector(".row-card-facts .row-card-more") as HTMLButtonElement;
    expect(more.getAttribute("aria-label")).toBe("More options");
    more.click();
    expect(menu.open).toHaveBeenCalledWith(
      expect.objectContaining({ menu: ROW_CARD_MENU, anchor: more, align: "end" }),
    );
    menu.isOpen.mockReturnValue(true);
    more.click();
    expect(menu.close).toHaveBeenCalled();
  });

  it("offers on its ⋮ what the pane gives for the row shown now, after the card's own items", () => {
    const items = [{ label: "Delete entry" }];
    const menuOf = vi.fn((index: number) => ({ items, arg: { file: `shots/${index}.md` } }));
    const { menu, rowCard } = card({ menuOf });
    rowCard.open(0);
    rowCard.moved(2);
    (document.querySelector(".row-card-more") as HTMLButtonElement).click();
    expect(menuOf).toHaveBeenLastCalledWith(2);
    expect(menu.open).toHaveBeenCalledWith(
      expect.objectContaining({ menu: ROW_CARD_MENU, arg: { file: "shots/2.md" }, itemsAfter: items }),
    );
  });

  it("follows its row to a new place without drawing it again, and hands that place back", () => {
    const { host, deps, rowCard } = card();
    rowCard.open(0);
    const control = document.querySelector(".row-card-value input");
    rowCard.moved(2);
    expect(rowCard.shown()).toBe(2);
    expect(document.querySelector(".row-card-value input")).toBe(control);
    expect(document.querySelector(".row-card-facts-text")?.textContent).toBe("Row 3 of 3 · Scene 12");
    key(host, " ");
    expect(deps.closed).toHaveBeenLastCalledWith(2);
  });

  it("draws its row again on a refresh, and closes once the row is gone", () => {
    const { deps, rowCard, drop } = card();
    rowCard.open(2);
    const control = document.querySelector(".row-card-value input");
    rowCard.refresh();
    expect(document.querySelector(".row-card-value input")).not.toBe(control);
    expect(title()).toBe("12C");
    drop(2);
    rowCard.refresh();
    expect(rowCard.isOpen()).toBe(false);
    expect(deps.closed).not.toHaveBeenCalled();
  });

  it("leaves the pane once disposed", () => {
    const { host, rowCard } = card();
    rowCard.open(0);
    rowCard.dispose();
    expect(host.querySelector(".row-card")).toBeNull();
  });
});

describe("createRowCard: designing", () => {
  const tools = () => [...document.querySelectorAll(".row-card-design > button")].map((each) => each.textContent);
  const tool = (label: string) =>
    [...document.querySelectorAll<HTMLButtonElement>(".row-card-design > button")].find(
      (each) => each.textContent === label,
    ) as HTMLButtonElement;
  const board = () => document.querySelector(".row-card-board") as HTMLElement;
  const ALL = [{ field: "frame" }, { field: "shot" }, { field: "size" }, { field: "lens" }];

  it("shows Design mode's tools and each tile's x while it can be arranged, and none otherwise", () => {
    const { rowCard, lock } = card();
    rowCard.open(0);
    expect(tools()).toEqual(["+ Heading", "+ Field", "Grid"]);
    expect(document.querySelectorAll(".row-card-grid .tile-grid-remove")).toHaveLength(4);
    lock(true);
    rowCard.refresh();
    expect(tools()).toEqual([]);
    expect(document.querySelector(".tile-grid-remove")).toBeNull();
  });

  it("adds a heading last and names it in its box, writing the arrangement", async () => {
    const { deps, rowCard } = card();
    rowCard.open(0);
    tool("+ Heading").click();
    expect(deps.arrange).toHaveBeenLastCalledWith([...ALL, { heading: "Heading" }]);
    const input = document.querySelector(".row-card-heading input") as HTMLInputElement;
    expect(document.activeElement).toBe(input);
    input.value = "Camera";
    key(input, "Enter");
    expect(deps.arrange).toHaveBeenLastCalledWith([...ALL, { heading: "Camera" }]);
    await Promise.resolve();
    expect(document.activeElement).toBe(document.querySelector(".row-card-heading"));
  });

  it("renames a heading from a double-click or Enter, keeps it on Escape, and never outside Design mode", () => {
    const { deps, rowCard, lock } = card({}, [{ heading: "Story" }, { field: "shot" }]);
    rowCard.open(0);
    const heading = () => document.querySelector(".row-card-heading") as HTMLElement;
    heading().dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    const first = heading().querySelector("input") as HTMLInputElement;
    first.value = "Notes";
    key(first, "Escape");
    expect(heading().textContent).toBe("Story");
    expect(deps.arrange).not.toHaveBeenCalled();

    key(heading(), "Enter");
    const second = heading().querySelector("input") as HTMLInputElement;
    second.value = "Notes";
    key(second, "Enter");
    expect(deps.arrange).toHaveBeenLastCalledWith([{ heading: "Notes" }, { field: "shot" }]);

    lock(true);
    rowCard.refresh();
    heading().dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(heading().querySelector("input")).toBeNull();
  });

  it("takes a field off the card by its x, and puts it back last from + Field", () => {
    const { deps, menu, rowCard } = card();
    rowCard.open(0);
    const remove = tileOf("Frame")?.querySelector<HTMLButtonElement>(".tile-grid-remove");
    if (!remove) throw new Error("Frame has no x");
    remove.click();
    expect(deps.arrange).toHaveBeenLastCalledWith([{ field: "shot" }, { field: "size" }, { field: "lens" }]);
    expect(labels()).toEqual(["Shot", "Size", "Lens"]);

    tool("+ Field").click();
    const opened = menu.open.mock.calls.at(-1)?.[0];
    expect(opened?.items?.map((item) => item.label)).toEqual(["Frame"]);
    opened?.items?.[0].run?.({ tab: { kind: "empty" }, pane: undefined }, undefined);
    expect(deps.arrange).toHaveBeenLastCalledWith([
      { field: "shot" },
      { field: "size" },
      { field: "lens" },
      { field: "frame" },
    ]);
    expect(labels()).toEqual(["Shot", "Size", "Lens", "Frame"]);
  });

  it("offers no field back while every field is on the card", () => {
    const { menu, rowCard } = card();
    rowCard.open(0);
    tool("+ Field").click();
    expect(menu.open).toHaveBeenLastCalledWith(
      expect.objectContaining({ items: [], empty: "Every field is on the card" }),
    );
  });

  it("keeps the cell guides on from row to row once Grid is pressed", () => {
    const { host, rowCard } = card();
    rowCard.open(0);
    expect(board().classList.contains("arranging")).toBe(false);
    tool("Grid").click();
    expect(tool("Grid").getAttribute("aria-pressed")).toBe("true");
    expect(board().classList.contains("arranging")).toBe(true);
    key(host, "ArrowRight");
    expect(title()).toBe("12B");
    expect(tool("Grid").getAttribute("aria-pressed")).toBe("true");
    expect(board().classList.contains("arranging")).toBe(true);
  });

  it("says when nothing is on the card, and where fields are added", () => {
    const { rowCard, lock } = card({}, []);
    rowCard.open(0);
    expect(document.querySelector(".row-card-empty")?.textContent).toBe("Nothing on this card yet.");
    lock(true);
    rowCard.refresh();
    expect(document.querySelector(".row-card-empty")?.textContent).toBe(
      "Nothing on this card. Add fields in Design mode.",
    );
  });
});
