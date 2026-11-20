// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type CommandContext, createCommands } from "../../../web/services/commands.ts";
import { createKeybindings } from "../../../web/services/keybindings.ts";
import { createMenus } from "../../../web/services/menus.ts";
import { createContextMenu } from "../../../web/view/contextMenu.ts";
import { asStyled } from "../support/styled.ts";

const context: CommandContext = { tab: { kind: "empty" }, pane: undefined };
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  document.body.replaceChildren();
});

function setup() {
  const commands = createCommands();
  const ran: [string, unknown][] = [];
  for (const id of ["new", "rename", "delete", "check", "table"]) {
    commands.register({ id, label: id, run: (_, arg) => void ran.push([id, arg]) });
  }
  const keybindings = createKeybindings(commands, { mac: false });
  keybindings.attach(document, () => context);
  const menus = createMenus(commands);
  menus.register("tree", [
    { command: "new", group: "create" },
    { label: "New", group: "new", submenu: [{ command: "table", label: "Table" }] },
    { command: "rename", group: "danger" },
    { command: "delete", group: "danger", danger: true },
    { command: "check", label: "Reading view", checked: () => true },
    { label: "Just a note" },
  ]);
  const contextMenu = createContextMenu({ commands, menus, keybindings, context: () => context });
  return { contextMenu, ran, keybindings };
}

const menu = () => document.querySelector<HTMLElement>(".context-menu");

describe("contextMenu", () => {
  it("renders the resolved items: buttons, a flyout, separators between groups, a checked item, a static row", () => {
    const { contextMenu } = setup();
    contextMenu.open({ menu: "tree", arg: { node: "a" }, at: { x: 10, y: 20 }, ariaLabel: "Tree" });
    const element = menu();
    if (!element) throw new Error("no menu");
    expect(element.getAttribute("role")).toBe("menu");
    expect(element.getAttribute("aria-label")).toBe("Tree");
    expect(element.style.left).toBe("10px");

    const rows = [...element.children] as HTMLElement[];
    expect(rows.map((row) => row.textContent)).toEqual([
      "new",
      "NewTable",
      "rename",
      "delete",
      "Reading view",
      "Just a note",
    ]);
    // A separator only where the group changes; the last two rows are both groupless.
    expect(rows.map((row) => row.classList.contains("menu-item-separated"))).toEqual([
      false,
      true,
      true,
      false,
      true,
      false,
    ]);
    expect(rows[1].classList.contains("has-submenu")).toBe(true);
    expect(rows[1].querySelector(".context-submenu button")?.textContent).toBe("Table");
    expect(rows[3].classList.contains("danger")).toBe(true);
    expect(rows[4].getAttribute("role")).toBe("menuitemcheckbox");
    expect(rows[4].getAttribute("aria-checked")).toBe("true");
    expect(rows[4].querySelector(".menu-item-check")).not.toBeNull();
    expect(rows[5].tagName).toBe("DIV");
    expect(rows[5].classList.contains("context-menu-label")).toBe(true);
  });

  it("a picked item closes the menu and runs its command with the context and argument", async () => {
    const { contextMenu, ran } = setup();
    contextMenu.open({ menu: "tree", arg: { node: "a" }, at: { x: 0, y: 0 } });
    const leaf = (menu() as HTMLElement).querySelector<HTMLButtonElement>(".context-submenu button");
    leaf?.click();
    await tick();
    expect(menu()).toBeNull();
    expect(ran).toEqual([["table", { node: "a" }]]);
    expect(contextMenu.isOpen()).toBe(false);
  });

  // jsdom lays nothing out: the menu is 0 wide and its first row sits at
  // its top, so beside an anchor it opens 4px left of it, level with it.
  it("opens beside an anchor that asks for it, and under it where its left has no room", () => {
    const { contextMenu } = setup();
    const anchor = document.createElement("button");
    document.body.append(anchor);
    anchor.getBoundingClientRect = () => new DOMRect(600, 120, 28, 28);
    contextMenu.open({ menu: "tree", anchor, beside: true });
    expect([menu()?.style.left, menu()?.style.top]).toEqual(["596px", "120px"]);

    contextMenu.close();
    anchor.getBoundingClientRect = () => new DOMRect(2, 120, 28, 28);
    contextMenu.open({ menu: "tree", anchor, beside: true });
    expect([menu()?.style.left, menu()?.style.top]).toEqual(["4px", "152px"]);
  });

  it("closes on a pointerdown elsewhere, on Escape, and on resize — but not on its anchor", async () => {
    const { contextMenu } = setup();
    const anchor = document.createElement("button");
    document.body.append(anchor);
    contextMenu.open({ menu: "tree", anchor, align: "end" });
    expect(anchor.getAttribute("aria-expanded")).toBe("true");
    expect(contextMenu.isOpen(anchor)).toBe(true);
    expect(contextMenu.isOpen(document.createElement("button"))).toBe(false);
    await tick(); // the dismiss listener arms after the opening click's turn

    anchor.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    expect(contextMenu.isOpen()).toBe(true);
    menu()?.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    expect(contextMenu.isOpen()).toBe(true);
    document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    expect(contextMenu.isOpen()).toBe(false);
    expect(anchor.getAttribute("aria-expanded")).toBe("false");

    contextMenu.open({ menu: "tree", at: { x: 0, y: 0 } });
    const escapeKey = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    document.body.dispatchEvent(escapeKey);
    await tick();
    expect(contextMenu.isOpen()).toBe(false);
    expect(escapeKey.defaultPrevented).toBe(true);

    // With no menu open, Escape isn't claimed.
    const idle = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    document.body.dispatchEvent(idle);
    expect(idle.defaultPrevented).toBe(false);

    contextMenu.open({ menu: "tree", at: { x: 0, y: 0 } });
    window.dispatchEvent(new Event("resize"));
    expect(contextMenu.isOpen()).toBe(false);
  });

  it("a disabled item is drawn but cannot be picked", async () => {
    const { contextMenu } = setup();
    const run = vi.fn();
    contextMenu.open({
      items: [
        { label: "Locked", run, disabled: () => true },
        { label: "Open", run, disabled: () => false },
      ],
      at: { x: 0, y: 0 },
    });
    const buttons = Array.from((menu() as HTMLElement).querySelectorAll("button"));
    expect(buttons.map((b) => [b.textContent, b.disabled])).toEqual([
      ["Locked", true],
      ["Open", false],
    ]);
    buttons[0].click();
    await tick();
    expect(run).not.toHaveBeenCalled();
    expect(menu()).not.toBeNull();
  });

  it("shows a row's tooltip beside it, after the delay, and gives a row without one none", () => {
    const { contextMenu } = setup();
    contextMenu.open({
      items: [
        { label: "Load Row", tooltip: "One row of a Table, picked on the node.", run: vi.fn() },
        { label: "Plain", run: vi.fn() },
      ],
      at: { x: 0, y: 0 },
    });
    const [described, plain] = Array.from((menu() as HTMLElement).querySelectorAll<HTMLElement>("button"));
    expect(described.dataset.tooltip).toBe("One row of a Table, picked on the node.");
    expect(described.dataset.tooltipSide).toBe("right");
    expect(described.dataset.tooltipWait).toBe("");
    expect(plain.dataset.tooltip).toBeUndefined();
    expect(plain.dataset.tooltipWait).toBeUndefined();
  });

  it("shows a placeholder for a menu with nothing in it, and only one menu at a time", () => {
    const { contextMenu } = setup();
    contextMenu.open({ menu: "tree", at: { x: 0, y: 0 } });
    contextMenu.open({ menu: "listItem", at: { x: 0, y: 0 }, empty: "No actions yet" });
    expect(document.querySelectorAll(".context-menu")).toHaveLength(1);
    expect(menu()?.querySelector(".context-menu-empty")?.textContent).toBe("No actions yet");
    contextMenu.dispose();
    expect(menu()).toBeNull();
  });

  it("draws inline items, then the menu's, then the items after it", () => {
    const { contextMenu } = setup();
    contextMenu.open({
      items: [{ label: "teh → the", group: "spelling" }],
      menu: "tree",
      itemsAfter: [{ label: "Copy", group: "clipboard" }],
      at: { x: 0, y: 0 },
    });
    const rows = [...(menu() as HTMLElement).children].map((row) => row.textContent);
    expect(rows[0]).toBe("teh → the");
    expect(rows.slice(1, -1)).toEqual(["new", "NewTable", "rename", "delete", "Reading view", "Just a note"]);
    expect(rows.at(-1)).toBe("Copy");
  });

  it("inline items run their own action; icon, data, detail, and style decorate a row", async () => {
    const { contextMenu } = setup();
    const run = vi.fn();
    contextMenu.open({
      at: { x: 0, y: 0 },
      items: [
        { label: "TEXT", className: "pin-type-label text" },
        { label: "Load Row", icon: true, data: { nodeType: "loadRow" }, run },
        { label: "Version", detail: "1.0" },
        { label: "Colored", style: { color: "rgb(1, 2, 3)" } },
        { label: "Go Back", shortcut: "Ctrl + Alt + ←" },
        { label: "Viewing", description: "Reads and answers.", run },
      ],
    });
    const rows = [...(menu() as HTMLElement).children] as HTMLElement[];
    expect(rows[0].className).toBe("context-menu-item context-menu-label pin-type-label text");
    expect(rows[1].tagName).toBe("BUTTON");
    expect(rows[1].dataset.nodeType).toBe("loadRow");
    expect(rows[1].firstElementChild?.className).toBe("context-menu-icon");
    expect(rows[2].querySelector(".context-menu-detail")?.textContent).toBe("1.0");
    expect(rows[3].style.color).toBe("rgb(1, 2, 3)");
    // A shortcut's arrow key is drawn as an icon, named for a screen reader.
    const shortcut = rows[4].querySelector(".context-menu-detail .key-label");
    expect(shortcut?.textContent).toBe("Ctrl + Alt + ");
    expect(shortcut?.querySelector(".key-arrow-left")?.getAttribute("aria-label")).toBe("Left arrow");
    // A description is a second line under the label, inside the row's text.
    expect(rows[5].classList.contains("has-description")).toBe(true);
    expect(rows[5].querySelector(".context-menu-text")?.firstChild?.textContent).toBe("Viewing");
    expect(rows[5].querySelector(".context-menu-text .context-menu-description")?.textContent).toBe(
      "Reads and answers.",
    );

    rows[1].click();
    await tick();
    expect(run).toHaveBeenCalledWith(context, undefined);
    expect(menu()).toBeNull();
  });

  it("a searchable menu filters to a flat list the keyboard can walk and pick from", async () => {
    const { contextMenu } = setup();
    const picked: string[] = [];
    const leaf = (name: string) => ({ label: name, run: () => void picked.push(name) });
    contextMenu.open({
      at: { x: 0, y: 0 },
      items: [{ label: "Sources", submenu: [leaf("Load Row"), leaf("Load Note")] }],
      search: {
        placeholder: "Search nodes…",
        filter: (query) =>
          ["Load Row", "Load Note", "Generate"].filter((n) => n.toLowerCase().includes(query)).map(leaf),
      },
    });
    const input = menu()?.querySelector<HTMLInputElement>(".context-menu-search");
    if (!input) throw new Error("no search box");
    expect(document.activeElement).toBe(input);
    expect(menu()?.querySelector(".has-submenu")).not.toBeNull();

    input.value = "load";
    input.dispatchEvent(new Event("input"));
    const results = () =>
      [...(menu() as HTMLElement).querySelectorAll(".context-menu-results button")] as HTMLElement[];
    expect(results().map((row) => row.textContent)).toEqual(["Load Row", "Load Note"]);
    expect((menu() as HTMLElement).querySelector<HTMLElement>(".context-menu-items")?.hidden).toBe(true);
    expect(results()[0].classList.contains("highlighted")).toBe(true);

    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
    expect(results()[1].classList.contains("highlighted")).toBe(true);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await tick();
    expect(picked).toEqual(["Load Note"]);
    expect(menu()).toBeNull();
  });

  it("a searchable menu walks its own top-level rows before a query, and opens on a given query", async () => {
    const { contextMenu } = setup();
    const picked: string[] = [];
    const leaf = (name: string) => ({ label: name, run: () => void picked.push(name) });
    contextMenu.open({
      at: "top",
      className: "wide",
      items: [leaf("Recent A"), leaf("Recent B"), { label: "Group", submenu: [leaf("Nested")] }],
      search: { placeholder: "", filter: (query) => [leaf(`match ${query}`)] },
    });
    const element = menu() as HTMLElement;
    expect(element.classList.contains("wide")).toBe(true);
    const input = element.querySelector<HTMLInputElement>(".context-menu-search") as HTMLInputElement;
    const body = () => [...element.querySelectorAll<HTMLElement>(".context-menu-items > button")];
    expect(body()[0].classList.contains("highlighted")).toBe(true);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
    // The flyout parent is skipped: the walk wraps from B back to A.
    expect(body()[0].classList.contains("highlighted")).toBe(true);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await tick();
    expect(picked).toEqual(["Recent A"]);

    contextMenu.open({
      at: "top",
      search: { placeholder: "", query: ">", filter: (query) => [leaf(`match ${query}`)] },
    });
    expect(menu()?.querySelector<HTMLInputElement>(".context-menu-search")?.value).toBe(">");
    expect(menu()?.querySelector(".context-menu-results button")?.textContent).toBe("match >");
  });

  it("centres a menu opened at the top", () => {
    const { contextMenu } = setup();
    vi.spyOn(window, "innerWidth", "get").mockReturnValue(1000);
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(500);
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(400);
    contextMenu.open({ menu: "tree", at: "top" });
    const element = menu() as HTMLElement;
    expect(element.style.left).toBe("300px");
    expect(element.style.top).toBe("60px");
  });

  it("keeps a menu inside the viewport", () => {
    const { contextMenu } = setup();
    vi.spyOn(window, "innerWidth", "get").mockReturnValue(300);
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(200);
    contextMenu.open({ menu: "tree", at: { x: 290, y: 195 } });
    const element = menu() as HTMLElement;
    expect(Number.parseFloat(element.style.left)).toBeLessThanOrEqual(296);
    expect(Number.parseFloat(element.style.top)).toBeLessThanOrEqual(196);
  });

  // The check ends every row of a list that has a checkable one, so trailing
  // values keep one column; a flyout's row has none, its arrow in its place.
  it("keeps the check's place at the end of every row of a checkable list", () => {
    const { contextMenu } = setup();
    contextMenu.open({ menu: "tree", at: { x: 0, y: 0 } });
    const rows = [...(menu()?.children ?? [])] as HTMLElement[];
    expect(rows.map((row) => row.lastElementChild?.className)).toEqual([
      "menu-item-check",
      "context-submenu",
      "menu-item-check",
      "menu-item-check",
      "menu-item-check",
      "menu-item-check",
    ]);
    expect(rows[1].querySelector(":scope > .menu-item-check")).toBeNull();
    // The flyout's own list has nothing checkable, so no place for a check.
    expect(rows[1].querySelector(".context-submenu .menu-item-check")).toBeNull();
  });

  it("draws a sort's direction after its label, then its trailing detail and the check", () => {
    const { contextMenu } = setup();
    contextMenu.open({
      items: [
        { label: "Date modified", run: vi.fn(), checked: () => true, direction: "descending", detail: "Default" },
        { label: "Name", run: vi.fn(), checked: () => false, direction: "ascending" },
      ],
      at: { x: 0, y: 0 },
    });
    const [modified, name] = [...(menu()?.children ?? [])] as HTMLElement[];
    expect([...modified.childNodes].map((node) => (node as Element).className ?? node.textContent)).toEqual([
      "Date modified",
      "context-menu-direction is-descending",
      "context-menu-detail",
      "menu-item-check",
    ]);
    expect(name.querySelector(".context-menu-direction")?.className).toBe("context-menu-direction is-ascending");
  });

  describe("a flyout of tiles", () => {
    function openWithTiles() {
      const { contextMenu } = setup();
      let frame = "wide";
      let marked = false;
      const frameTile = (id: string, label: string) => ({
        label,
        glyph: `var(--icon-${id})`,
        radio: true,
        checked: () => frame === id,
        pick: () => {
          frame = id;
        },
      });
      contextMenu.open({
        at: { x: 0, y: 0 },
        items: [
          {
            label: "Guides",
            tiles: () => [
              { label: "Frames", tiles: [frameTile("wide", "Wide"), frameTile("tall", "Tall")] },
              {
                label: "Marks",
                tiles: [
                  {
                    label: "Center",
                    glyph: "var(--icon-plus)",
                    tooltip: "The frame's center",
                    checked: () => marked,
                    pick: () => {
                      marked = !marked;
                    },
                  },
                ],
              },
            ],
          },
          { label: "Bookmark", run() {} },
        ],
      });
      const element = menu() as HTMLElement;
      const tiles = () => [...element.querySelectorAll<HTMLButtonElement>(".context-menu-tile")];
      const checked = () => tiles().map((tile) => tile.getAttribute("aria-checked"));
      return { element, tiles, checked, state: () => ({ frame, marked }) };
    }

    it("hangs off its row like any flyout, its tiles under their headings, glyphs from their tokens", () => {
      const { element, tiles, checked } = openWithTiles();
      const row = element.querySelector(".has-submenu") as HTMLElement;
      expect(row.firstChild?.textContent).toBe("Guides");
      const flyout = row.querySelector(".context-submenu") as HTMLElement;
      expect(flyout.classList.contains("is-tiles")).toBe(true);
      const groups = [...flyout.querySelectorAll(".context-menu-tiles")];
      expect(groups.map((group) => group.getAttribute("aria-label"))).toEqual(["Frames", "Marks"]);
      expect(groups.map((group) => group.querySelector(".context-menu-tiles-heading")?.textContent)).toEqual([
        "Frames",
        "Marks",
      ]);
      expect(tiles().map((tile) => tile.textContent)).toEqual(["Wide", "Tall", "Center"]);
      expect(tiles().map((tile) => tile.getAttribute("role"))).toEqual([
        "menuitemradio",
        "menuitemradio",
        "menuitemcheckbox",
      ]);
      expect(checked()).toEqual(["true", "false", "false"]);
      const glyph = tiles()[1].querySelector<HTMLElement>(".context-menu-tile-glyph");
      expect(glyph?.style.getPropertyValue("--glyph")).toBe("var(--icon-tall)");
      expect(tiles()[2].dataset.tooltip).toBe("The frame's center");
      // Hovered, not picked: the keys walk the list's own rows.
      expect(row.querySelector(".menu-item-check")).toBeNull();
    });

    it("applies a tile at once, leaves the menu open, and redraws every tile whether it is on", () => {
      const { tiles, checked, state } = openWithTiles();
      tiles()[1].click();
      expect(state()).toEqual({ frame: "tall", marked: false });
      expect(checked()).toEqual(["false", "true", "false"]);
      expect(menu()).not.toBeNull();
      tiles()[2].click();
      expect(state()).toEqual({ frame: "tall", marked: true });
      expect(checked()).toEqual(["false", "true", "true"]);
      expect(menu()).not.toBeNull();
    });
  });

  it("lifts a flyout that would run past the bottom of the viewport to end at it", () => {
    const { contextMenu } = setup();
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(400);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const box = this.classList.contains("context-submenu") ? { top: 300, bottom: 500 } : { top: 0, bottom: 0 };
      return { ...box, left: 0, right: 0, width: 0, height: box.bottom - box.top, x: 0, y: box.top } as DOMRect;
    });
    contextMenu.open({ menu: "tree", at: { x: 0, y: 0 } });
    // 104px past the 4px margin; jsdom puts the flyout's own top at 0.
    expect(menu()?.querySelector<HTMLElement>(".context-submenu")?.style.top).toBe("-104px");
  });

  // jsdom lays nothing out, so widths come from the stub: a 160-wide menu
  // and a 140-wide flyout in a 400-wide viewport.
  it("a flyout opens to the left only when there is no room for it on the right", () => {
    const { contextMenu } = setup();
    vi.spyOn(window, "innerWidth", "get").mockReturnValue(400);
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("context-submenu") ? 140 : 160;
    });
    const flyoutRow = () => menu()?.querySelector(".has-submenu");

    contextMenu.open({ menu: "tree", at: { x: 0, y: 0 } });
    expect(flyoutRow()?.classList.contains("opens-left")).toBe(false);
    expect(flyoutRow()?.querySelector<HTMLElement>(".context-submenu")?.style.display).toBe("");

    contextMenu.open({ menu: "tree", at: { x: 120, y: 0 } });
    expect(flyoutRow()?.classList.contains("opens-left")).toBe(true);
  });

  // A 160-by-100 menu, its anchor's top 30px above the bottom of a 400-tall
  // viewport.
  it("opens above an anchor with no room below it, a searchable one keeping the size it opened at", () => {
    const { contextMenu } = setup();
    vi.spyOn(window, "innerWidth", "get").mockReturnValue(800);
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(400);
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(160);
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(100);
    const anchor = document.createElement("button");
    document.body.append(anchor);
    const rect = (top: number) => ({ top, bottom: top + 26, left: 20, right: 100 }) as DOMRect;
    const anchorRect = vi.spyOn(anchor, "getBoundingClientRect").mockReturnValue(rect(370));
    const search = { placeholder: "", filter: () => [] };

    contextMenu.open({ menu: "tree", anchor });
    expect(menu()?.style.top).toBe("266px");
    expect(menu()?.style.minHeight).toBe("");

    contextMenu.open({ menu: "tree", anchor, search });
    expect(menu()?.style.top).toBe("266px");
    expect([menu()?.style.minWidth, menu()?.style.minHeight]).toEqual(["160px", "100px"]);

    anchorRect.mockReturnValue(rect(40));
    contextMenu.open({ menu: "tree", anchor, search });
    expect(menu()?.style.top).toBe("70px");
    expect(menu()?.style.minHeight).toBe("");
    vi.restoreAllMocks();
  });

  it("fits a picker's list on the roomier side of its anchor, shortened, rather than over it", () => {
    const { contextMenu } = setup();
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(400);
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.style.maxHeight ? Number.parseFloat(this.style.maxHeight) : 300;
    });
    const anchor = document.createElement("button");
    document.body.append(anchor);
    const rect = (top: number) => ({ top, bottom: top + 26, left: 20, right: 100, width: 80 }) as DOMRect;
    const anchorRect = vi.spyOn(anchor, "getBoundingClientRect").mockReturnValue(rect(150));

    contextMenu.open({ items: [{ label: "A", run() {} }], anchor, picker: true });
    expect([menu()?.style.top, menu()?.style.maxHeight]).toEqual(["180px", "216px"]);

    anchorRect.mockReturnValue(rect(300));
    contextMenu.open({ items: [{ label: "A", run() {} }], anchor, picker: true });
    expect([menu()?.style.top, menu()?.style.maxHeight]).toEqual(["4px", "292px"]);
    vi.restoreAllMocks();
  });

  // A dialog's Escape outranks a menu's in the keybinding chain; a menu
  // opened inside one must still close first.
  it("a search box takes its own Escape ahead of a heavier binding, and focus goes back to the anchor", () => {
    const { contextMenu, ran, keybindings } = setup();
    keybindings.register({ key: "Escape", command: "check", weight: 200 });
    const anchor = document.createElement("button");
    document.body.append(anchor);
    contextMenu.open({ menu: "tree", anchor, search: { placeholder: "", filter: () => [] } });
    const input = menu()?.querySelector<HTMLInputElement>(".context-menu-search") as HTMLInputElement;
    expect(document.activeElement).toBe(input);

    const escapeKey = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    input.dispatchEvent(escapeKey);
    expect(escapeKey.defaultPrevented).toBe(true);
    expect(menu()).toBeNull();
    expect(ran).toEqual([]);
    expect(document.activeElement).toBe(anchor);
  });

  // A right-click menu has no anchor: a pick from it hands the keyboard back
  // to the surface it was opened over, such as a Flow canvas for its Undo.
  it("a menu opened at a point gives focus back to what had it before", () => {
    const { contextMenu, ran } = setup();
    const canvas = document.createElement("div");
    canvas.tabIndex = -1;
    document.body.append(canvas);
    canvas.focus();
    contextMenu.open({ menu: "tree", at: { x: 0, y: 0 } });
    const row = [...(menu()?.querySelectorAll("button") ?? [])].find((button) => button.textContent === "rename");
    row?.focus();
    row?.click();
    expect(ran).toEqual([["rename", undefined]]);
    expect(document.activeElement).toBe(canvas);
  });

  // A click selecting a static row's value for copying focuses it, where a
  // plain span would drop focus to the page and leave nothing to hand back.
  it("a static row's value takes focus, and closing still hands focus back", () => {
    const { contextMenu } = setup();
    const canvas = document.createElement("div");
    canvas.tabIndex = -1;
    document.body.append(canvas);
    canvas.focus();
    contextMenu.open({
      items: [
        { label: "Id", detail: "generateImage-3" },
        { label: "Pick", detail: "a hint", run() {} },
      ],
      at: { x: 0, y: 0 },
    });
    const [value, hint] = [...(menu()?.querySelectorAll<HTMLElement>(".context-menu-detail") ?? [])];
    expect(value.getAttribute("tabindex")).toBe("-1");
    expect(hint.hasAttribute("tabindex")).toBe(false);
    value.focus();
    expect(document.activeElement).toBe(value);
    contextMenu.close();
    expect(document.activeElement).toBe(canvas);
  });

  // Full screen shows its own element alone: a menu on the page would be
  // unseen there, as a video player's More options would.
  it("opens inside the full-screen element while one is up", () => {
    const { contextMenu } = setup();
    const frame = document.createElement("div");
    document.body.append(frame);
    Object.defineProperty(document, "fullscreenElement", { value: frame, configurable: true });
    try {
      contextMenu.open({ menu: "tree", at: { x: 0, y: 0 } });
      expect(menu()?.parentElement).toBe(frame);
      contextMenu.close();
    } finally {
      Object.defineProperty(document, "fullscreenElement", { value: null, configurable: true });
    }
    contextMenu.open({ menu: "tree", at: { x: 0, y: 0 } });
    expect(menu()?.parentElement).toBe(document.body);
  });

  it("a searchable menu's highlight starts on its checked row, and a query's on its first match", () => {
    const { contextMenu } = setup();
    const row = (label: string, checked = false) => ({ label, run() {}, checked: () => checked });
    contextMenu.open({
      at: { x: 0, y: 0 },
      items: [row("A"), row("B", true), row("C")],
      search: { placeholder: "", filter: () => [row("C"), row("B", true)] },
    });
    const highlighted = (list: string) => menu()?.querySelector(`${list} .highlighted`)?.textContent;
    expect(highlighted(".context-menu-items")).toBe("B");
    const input = menu()?.querySelector<HTMLInputElement>(".context-menu-search") as HTMLInputElement;
    input.value = "x";
    input.dispatchEvent(new Event("input"));
    expect(highlighted(".context-menu-results")).toBe("C");
  });

  describe("a slider under the list", () => {
    const stops = [
      { value: "", label: "Default", ring: true },
      { value: "low", label: "Low" },
      { value: "high", label: "High" },
    ];

    function openWithSlider(value: string) {
      const { contextMenu } = setup();
      const changes: string[] = [];
      const row = (label: string) => ({ label, run() {} });
      contextMenu.open({
        at: { x: 0, y: 0 },
        items: [row("A"), row("B")],
        search: { placeholder: "", filter: (query) => (query === "none" ? [] : [row("A")]) },
        slider: { label: "Effort", stops, value, change: (picked) => void changes.push(picked) },
      });
      const element = menu() as HTMLElement;
      const search = element.querySelector<HTMLInputElement>(".context-menu-search") as HTMLInputElement;
      const slider = element.querySelector<HTMLInputElement>(".context-menu-slider-input") as HTMLInputElement;
      const current = () => element.querySelector(".context-menu-slider-name.current")?.textContent;
      const key = (target: HTMLElement, name: string) =>
        target.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }));
      return { element, search, slider, current, key, changes };
    }

    it("sits last, outside the list, its stops drawn and the current one named after its label", () => {
      const { element, slider, current } = openWithSlider("low");
      expect(element.lastElementChild?.classList.contains("context-menu-slider")).toBe(true);
      expect(element.querySelector(".context-menu-items .context-menu-slider")).toBeNull();
      const marks = [...element.querySelectorAll(".context-menu-slider-stop")];
      expect(marks.map((mark) => mark.classList.contains("ring"))).toEqual([true, false, false]);
      expect(slider.max).toBe("2");
      expect(slider.value).toBe("1");
      expect(slider.getAttribute("aria-label")).toBe("Effort");
      expect(slider.getAttribute("aria-valuetext")).toBe("Low");
      expect(current()).toBe("(Low)");
    });

    it("applies each move at once and leaves the menu open", () => {
      const { slider, current, changes } = openWithSlider("");
      slider.value = "2";
      slider.dispatchEvent(new Event("input"));
      expect(changes).toEqual(["high"]);
      expect(current()).toBe("(High)");
      expect(slider.getAttribute("aria-valuetext")).toBe("High");
      expect(menu()).not.toBeNull();
    });

    it("is one more stop for ↑/↓ past either end of the rows, and Enter or Escape there closes the menu", () => {
      const { element, search, slider, key } = openWithSlider("");
      const rows = () => [...element.querySelectorAll<HTMLElement>(".context-menu-items > button")];
      const row = element.querySelector(".context-menu-slider-row") as HTMLElement;
      key(search, "ArrowDown");
      expect(rows()[1].classList.contains("highlighted")).toBe(true);
      key(search, "ArrowDown");
      expect(document.activeElement).toBe(slider);
      expect(row.classList.contains("highlighted")).toBe(true);
      expect(rows().some((button) => button.classList.contains("highlighted"))).toBe(false);

      key(slider, "ArrowDown");
      expect(document.activeElement).toBe(search);
      expect(row.classList.contains("highlighted")).toBe(false);
      expect(rows()[0].classList.contains("highlighted")).toBe(true);
      key(search, "ArrowUp");
      expect(document.activeElement).toBe(slider);
      key(slider, "ArrowUp");
      expect(rows()[1].classList.contains("highlighted")).toBe(true);

      key(search, "ArrowDown");
      key(slider, "Enter");
      expect(menu()).toBeNull();

      const reopened = openWithSlider("");
      reopened.key(reopened.slider, "Escape");
      expect(menu()).toBeNull();
    });

    it("stays while a search filters the list, and is reached from a search with no matches", () => {
      const { element, search, slider, key } = openWithSlider("");
      search.value = "none";
      search.dispatchEvent(new Event("input"));
      expect(element.querySelector(".context-menu-slider")).not.toBeNull();
      key(search, "ArrowDown");
      expect(document.activeElement).toBe(slider);
    });
  });

  it("draws a row's label alone in the font it names", () => {
    const { contextMenu } = setup();
    contextMenu.open({
      at: { x: 0, y: 0 },
      items: [{ label: "Courier New", font: '"Courier New"', detail: "Not monospaced" }],
    });
    const row = menu()?.querySelector(".context-menu-label") as HTMLElement;
    const label = row.querySelector<HTMLElement>(".context-menu-font");
    expect([label?.textContent, label?.style.fontFamily]).toEqual([
      "Courier New",
      asStyled("font-family", '"Courier New"'),
    ]);
    expect(row.querySelector(".context-menu-detail")?.parentElement).toBe(row);
  });

  it("draws a row's mark as a dot after its label, its tooltip and the row's name saying what it marks", () => {
    const { contextMenu } = setup();
    contextMenu.open({ at: { x: 0, y: 0 }, items: [{ label: "Courier Prime", mark: "Default", run() {} }] });
    const row = menu()?.querySelector("button") as HTMLButtonElement;
    const mark = row.querySelector<HTMLElement>(".context-menu-mark");
    expect(mark?.previousSibling?.textContent).toBe("Courier Prime");
    expect([mark?.dataset.tooltip, mark?.getAttribute("aria-hidden")]).toEqual(["Default", "true"]);
    expect(row.getAttribute("aria-label")).toBe("Courier Prime, Default");
  });

  it("keeps a sort's direction against its label, the mark after it", () => {
    const { contextMenu } = setup();
    contextMenu.open({
      at: { x: 0, y: 0 },
      items: [{ label: "Name", direction: "ascending", mark: "Default", run() {} }],
    });
    const row = menu()?.querySelector("button") as HTMLButtonElement;
    expect(row.querySelector(".context-menu-direction")?.nextElementSibling?.className).toBe("context-menu-mark");
  });

  // A select's keys, for a picker's list with no search box to take them.
  describe("a picker's menu", () => {
    function openPicker(labels = ["Light", "Dark", "System"]) {
      const { contextMenu, ran, keybindings } = setup();
      const anchor = document.createElement("button");
      document.body.append(anchor);
      const rect = { x: 0, y: 0, top: 0, left: 0, width: 300, height: 20, right: 300, bottom: 20 };
      anchor.getBoundingClientRect = () => ({ ...rect, toJSON: () => rect });
      const picked: string[] = [];
      const row = (label: string, checked = false) => ({
        label,
        run: () => void picked.push(label),
        checked: () => checked,
      });
      contextMenu.open({ items: labels.map((label) => row(label, label === "Dark")), anchor, picker: true });
      const element = menu() as HTMLElement;
      const rows = () => [...element.querySelectorAll<HTMLElement>("button")];
      const highlighted = () => element.querySelector(".highlighted")?.textContent;
      const key = (name: string, init: KeyboardEventInit = {}) => {
        const event = new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...init });
        (document.activeElement ?? document.body).dispatchEvent(event);
        return event;
      };
      return { contextMenu, ran, keybindings, anchor, element, rows, highlighted, key, picked };
    }

    it("takes focus, its highlight on the checked row, named to a screen reader", () => {
      const { element, rows, highlighted } = openPicker();
      expect(document.activeElement).toBe(element);
      expect(highlighted()).toBe("Dark");
      expect(element.getAttribute("aria-activedescendant")).toBe(rows()[1].id);
    });

    it("is at least as wide as its anchor", () => {
      const { element } = openPicker();
      expect(element.style.minWidth).toBe("300px");
    });

    it("walks its rows with the arrow keys and picks with Enter or Space", () => {
      const { key, highlighted, picked, element, rows } = openPicker();
      key("ArrowDown");
      expect(highlighted()).toBe("System");
      expect(element.getAttribute("aria-activedescendant")).toBe(rows()[2].id);
      key("ArrowDown");
      expect(highlighted()).toBe("Light");
      key("ArrowUp");
      expect(highlighted()).toBe("System");
      expect(key("Enter").defaultPrevented).toBe(true);
      expect(picked).toEqual(["System"]);
      expect(menu()).toBeNull();

      const again = openPicker();
      again.key(" ");
      expect(again.picked).toEqual(["Dark"]);
    });

    it("calls its checkable rows radio items, a choice of one value, not checkboxes", () => {
      const { rows } = openPicker();
      expect(rows().map((row) => row.getAttribute("role"))).toEqual([
        "menuitemradio",
        "menuitemradio",
        "menuitemradio",
      ]);
      expect(rows()[1].getAttribute("aria-checked")).toBe("true");
    });

    it("calls a toggle among its rows a checkbox, on or off by itself", () => {
      const { contextMenu } = setup();
      const anchor = document.createElement("button");
      document.body.append(anchor);
      const items = [
        { label: "Text", run: () => {}, checked: () => true },
        { label: "Bold", run: () => {}, checked: () => false, toggle: true },
      ];
      contextMenu.open({ items, anchor, picker: true });
      const rows = [...(menu() as HTMLElement).querySelectorAll("button")];
      expect(rows.map((row) => row.getAttribute("role"))).toEqual(["menuitemradio", "menuitemcheckbox"]);
    });

    it("jumps to its first and last rows with Home and End", () => {
      const { key, highlighted } = openPicker();
      expect(key("End").defaultPrevented).toBe(true);
      expect(highlighted()).toBe("System");
      key("Home");
      expect(highlighted()).toBe("Light");
    });

    it("jumps to the next row starting with what was typed within a second, a key again stepping on", () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        const { key, highlighted, picked } = openPicker(["Default", "1:1", "16:9", "9:16", "2:3", "21:9"]);
        const later = () => vi.setSystemTime(Date.now() + 1500);
        expect(key("1").defaultPrevented).toBe(true);
        expect(highlighted()).toBe("1:1");
        key("1");
        expect(highlighted()).toBe("16:9");
        key("1");
        expect(highlighted()).toBe("1:1");
        later();
        key("2");
        expect(highlighted()).toBe("2:3");
        key("1");
        expect(highlighted()).toBe("21:9");
        key("x");
        expect(highlighted()).toBe("21:9");
        later();
        key("D", { shiftKey: true });
        expect(highlighted()).toBe("Default");
        expect(key("9", { ctrlKey: true }).defaultPrevented).toBe(false);
        expect(highlighted()).toBe("Default");
        expect(picked).toEqual([]);
      } finally {
        vi.useRealTimers();
      }
    });

    it("leaves Home, End and typed keys to its search box", () => {
      const { contextMenu } = setup();
      const anchor = document.createElement("button");
      document.body.append(anchor);
      const items = [
        { label: "Light", run() {} },
        { label: "Dark", run() {} },
      ];
      contextMenu.open({ items, search: { placeholder: "Search", filter: () => [] }, anchor, picker: true });
      const input = document.activeElement as HTMLElement;
      expect(input.classList.contains("context-menu-search")).toBe(true);
      for (const name of ["End", "Home", "d"]) {
        const event = new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true });
        input.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(false);
      }
      expect(menu()?.querySelector(".highlighted")?.textContent).toBe("Light");
    });

    it("takes its own Escape ahead of a heavier binding, and gives focus back to its anchor", () => {
      const { keybindings, key, ran, anchor } = openPicker();
      keybindings.register({ key: "Escape", command: "check", weight: 200 });
      expect(key("Escape").defaultPrevented).toBe(true);
      expect(menu()).toBeNull();
      expect(ran).toEqual([]);
      expect(document.activeElement).toBe(anchor);
    });

    it("closes on Tab, leaving the key to move on from its anchor", () => {
      const { key, anchor } = openPicker();
      expect(key("Tab").defaultPrevented).toBe(false);
      expect(menu()).toBeNull();
      expect(document.activeElement).toBe(anchor);
    });

    it("leaves focus alone in a menu that isn't a picker's", () => {
      const { contextMenu } = setup();
      const anchor = document.createElement("button");
      document.body.append(anchor);
      anchor.focus();
      contextMenu.open({ menu: "tree", anchor });
      expect(document.activeElement).toBe(anchor);
      expect(menu()?.hasAttribute("tabindex")).toBe(false);
    });
  });
});

// A flyout led by a search box, as Looks and New ▸ Template draw it.
describe("a flyout's search box", () => {
  function searchSetup() {
    const commands = createCommands();
    const keybindings = createKeybindings(commands, { mac: false });
    keybindings.attach(document, () => context);
    const menus = createMenus(commands);
    const picked: string[] = [];
    const shown: (string | null)[] = [];
    const row = (label: string) => ({
      label,
      run: () => void picked.push(label),
      preview: { show: () => void shown.push(label), end: () => void shown.push(null) },
    });
    const contextMenu = createContextMenu({ commands, menus, keybindings, context: () => context });
    contextMenu.open({
      at: { x: 0, y: 0 },
      items: [
        { label: "Open", run: () => undefined },
        {
          label: "Looks",
          submenu: [row("Warm"), row("Cool")],
          search: {
            placeholder: "Search looks",
            filter: (query) => ["Warm", "Cool", "Warmer"].filter((name) => name.toLowerCase().includes(query)).map(row),
          },
        },
      ],
    });
    const flyout = document.querySelector<HTMLElement>(".context-submenu.has-search");
    const input = flyout?.querySelector<HTMLInputElement>(":scope > .context-menu-search");
    if (!flyout || !input) throw new Error("no search flyout");
    const matches = () =>
      [...flyout.querySelectorAll<HTMLElement>(".context-menu-results > button")].map((button) => button.textContent);
    return { flyout, input, matches, picked, shown, contextMenu };
  }

  it("swaps the rows for the matches as typed, previews the first, and Enter picks it", () => {
    const { input, matches, picked, shown } = searchSetup();
    expect(input.placeholder).toBe("Search looks");
    input.value = "warm";
    input.dispatchEvent(new Event("input"));
    expect(matches()).toEqual(["Warm", "Warmer"]);
    input.focus();
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(shown.at(-1)).toBe("Warmer");
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(picked).toEqual(["Warmer"]);
    expect(menu()).toBeNull();
    expect(shown.at(-1)).toBeNull();
  });

  it("clears a query at Escape before it closes the menu", () => {
    const { input, matches } = searchSetup();
    input.value = "cool";
    input.dispatchEvent(new Event("input"));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(input.value).toBe("");
    expect(matches()).toEqual([]);
    expect(menu()).not.toBeNull();
  });

  it("takes a key typed while the flyout shows, wherever focus was", () => {
    const { flyout, input, matches } = searchSetup();
    flyout.style.display = "flex";
    const editor = document.createElement("div");
    editor.contentEditable = "true";
    document.body.append(editor);
    editor.focus();
    editor.dispatchEvent(new KeyboardEvent("keydown", { key: "c", bubbles: true, cancelable: true }));
    expect(input.value).toBe("c");
    expect(matches()).toEqual(["Cool"]);
  });

  it("previews a row while it is pointed at, and ends it as the pointer moves on or leaves", () => {
    const { flyout, shown } = searchSetup();
    const [warm] = flyout.querySelectorAll<HTMLElement>(".context-menu-items > button");
    warm.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    expect(shown).toEqual(["Warm"]);
    menu()
      ?.querySelector<HTMLElement>("button")
      ?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    expect(shown).toEqual(["Warm", null]);
  });
});
