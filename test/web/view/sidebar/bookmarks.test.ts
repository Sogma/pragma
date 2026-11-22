// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  SpaceBookmark,
  SpaceBookmarkChangeRequestBody,
  SpaceBookmarksResponse,
} from "../../../../src/protocol/api.ts";
import { DRAGGED_ENTRY_TYPE, draggedPathInFlight } from "../../../../web/core/paths.ts";
import type { Bookmarks } from "../../../../web/services/bookmarks.ts";
import { type CommandContext, createCommands } from "../../../../web/services/commands.ts";
import { COMMAND_PALETTE, type ContextMenuService, createMenus } from "../../../../web/services/menus.ts";
import { createBookmarksView, dropPlace } from "../../../../web/view/sidebar/bookmarks.ts";

// A list the test answers, as the server would, once it chooses to.
function list(initial: SpaceBookmarksResponse) {
  let answer: SpaceBookmarksResponse = { bookmarks: [] };
  let answered = false;
  const listeners = new Set<(answer: SpaceBookmarksResponse) => void>();
  const settle = (next: SpaceBookmarksResponse = initial) => {
    answer = next;
    answered = true;
    for (const listener of listeners) listener(answer);
  };
  const change = vi.fn(async (_request: SpaceBookmarkChangeRequestBody) => {});
  const bookmarks: Bookmarks = {
    list: () => answer.bookmarks,
    problem: () => answer.problem,
    has: (path) => answer.bookmarks.some((bookmark) => bookmark.path.toLowerCase() === path.toLowerCase()),
    loaded: () => answered,
    read: vi.fn(async () => {}),
    change,
    subscribe: (listener) => {
      listeners.add(listener);
      listener(answer);
      return () => listeners.delete(listener);
    },
  };
  return { bookmarks, change, settle };
}

function setup(initial: SpaceBookmarksResponse) {
  const { bookmarks, change, settle } = list(initial);
  const commands = createCommands();
  const menus = createMenus(commands);
  const contextMenu: ContextMenuService = { open: vi.fn(), close: vi.fn(), isOpen: () => false };
  let moveHighlight: ((path: string | undefined) => void) | undefined;
  const open = vi.fn();
  const revealFolder = vi.fn();
  const view = createBookmarksView({
    bookmarks,
    commands,
    menus,
    contextMenu,
    active: {
      subscribe: (listener) => {
        moveHighlight = listener;
        return () => undefined;
      },
    },
    open,
    revealFolder,
    showExtensions: () => false,
  });
  document.body.append(view.panel);
  const rows = () => [...view.panel.querySelectorAll<HTMLElement>(".bookmark-row .node-label")];
  const message = () => view.panel.querySelector(".sidebar-panel-empty") as HTMLElement;
  return {
    view,
    bookmarks,
    change,
    settle,
    commands,
    menus,
    contextMenu,
    open,
    revealFolder,
    rows,
    message,
    highlight: (path?: string) => moveHighlight?.(path),
  };
}

const file = (path: string): SpaceBookmark => ({ path, type: "file" });
const folder = (path: string): SpaceBookmark => ({ path, type: "directory" });
const none: CommandContext = { tab: { kind: "empty" }, pane: undefined };

afterEach(() => {
  document.body.replaceChildren();
});

describe("the Bookmarks view", () => {
  it("is a rail view, titled and hidden until shown", () => {
    const { view, bookmarks } = setup({ bookmarks: [] });
    expect([view.id, view.label]).toEqual(["bookmarks", "Bookmarks"]);
    expect(view.panel.hidden).toBe(true);
    expect(view.panel.querySelector(".sidebar-title")?.textContent).toBe("Bookmarks");
    view.onShow?.();
    expect(bookmarks.read).toHaveBeenCalledOnce();
  });

  it("shows nothing until the list's first answer, then says it is empty", () => {
    const { message, settle } = setup({ bookmarks: [] });
    expect(message().hidden).toBe(true);
    settle();
    expect(message().hidden).toBe(false);
    expect(message().textContent).toBe("No bookmarks in this space yet.");
  });

  it("draws a row per bookmark as the tree names its entry", () => {
    const { rows, settle } = setup({
      bookmarks: [file("notes/Plan.md"), folder("projects"), { path: "notes/gone.md" }, file("refs/archive.zip")],
    });
    settle();
    expect(rows().map((row) => row.querySelector(".node-name")?.textContent)).toEqual([
      "Plan",
      "projects",
      "gone",
      "archive.zip",
    ]);
    expect(rows()[0].dataset.tooltip).toBe("notes/Plan.md");
    expect(rows()[2].dataset.tooltip).toBe("Not found: notes/gone.md");
    expect(rows()[2].parentElement?.classList.contains("missing")).toBe(true);
  });

  it("names the folder of two bookmarks that share a name", () => {
    const { rows, settle } = setup({
      bookmarks: [
        file("projects/one/README.md"),
        file("projects/two/readme.md"),
        file("lib:refs/README.md"),
        file("a.md"),
      ],
    });
    settle();
    expect(rows().map((row) => row.querySelector(".bookmark-folder")?.textContent ?? "")).toEqual([
      "one",
      "two",
      "refs",
      "",
    ]);
  });

  it("says why when the file doesn't read", () => {
    const { rows, message, settle } = setup({ bookmarks: [], problem: ".pragma/bookmarks.json doesn't parse" });
    settle();
    expect(message().textContent).toBe(".pragma/bookmarks.json doesn't parse");
    expect(rows()).toEqual([]);
  });

  it("opens a file, reveals a folder and leaves a missing entry be", () => {
    const { rows, settle, open, revealFolder } = setup({
      bookmarks: [file("notes/a.md"), folder("projects"), { path: "gone.md" }],
    });
    settle();
    rows()[0].click();
    expect(open).toHaveBeenCalledWith("notes/a.md", { anchor: rows()[0] });
    rows()[1].dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(revealFolder).toHaveBeenCalledWith("projects");
    rows()[2].click();
    expect(open).toHaveBeenCalledTimes(1);
    expect(revealFolder).toHaveBeenCalledTimes(1);
  });

  it("marks the open file's row, as the tree does", () => {
    const { rows, highlight, settle } = setup({ bookmarks: [file("a.md"), file("b.md")] });
    highlight("b.md");
    settle();
    expect(rows().map((row) => row.classList.contains("active"))).toEqual([false, true]);
  });

  it("hands its menu the entry to open and the bookmark to remove", () => {
    const { rows, settle, contextMenu } = setup({
      bookmarks: [file("a.md"), folder("projects"), { path: "gone.md" }],
    });
    settle();
    for (const row of rows()) {
      row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 5, clientY: 5 }));
    }
    expect(vi.mocked(contextMenu.open).mock.calls.map(([options]) => [options.menu, options.arg])).toEqual([
      ["bookmark", { bookmark: "a.md", file: "a.md" }],
      ["bookmark", { bookmark: "projects", folder: "projects" }],
      ["bookmark", { bookmark: "gone.md" }],
    ]);
  });
});

describe("Bookmark and Remove from Bookmarks", () => {
  it("offers whichever applies to the row a menu was opened on", () => {
    const { settle, menus } = setup({ bookmarks: [file("notes/a.md")] });
    settle();
    menus.register("tree", [
      { command: "bookmarks.add", group: "bookmark" },
      { command: "bookmarks.remove", group: "bookmark" },
    ]);
    const labels = (arg: unknown) => menus.resolve("tree", none, arg).map((item) => item.label);
    expect(labels({ node: { type: "file", path: "notes/a.md" } })).toEqual(["Remove from Bookmarks"]);
    expect(labels({ node: { type: "file", path: "notes/b.md" } })).toEqual(["Bookmark"]);
    expect(labels({ node: null })).toEqual([]);
  });

  it("asks the list for the change", async () => {
    const { settle, commands, change } = setup({ bookmarks: [file("notes/a.md")] });
    settle();
    await commands.run("bookmarks.add", none, { node: { type: "directory", path: "stills" }, libraryId: "refs" });
    await commands.run("bookmarks.remove", none, { bookmark: "notes/a.md", file: "notes/a.md" });
    expect(change.mock.calls).toEqual([[{ add: "lib:refs/stills" }], [{ remove: "notes/a.md" }]]);
  });

  it("adds nothing while the file doesn't read", () => {
    const { settle, commands } = setup({ bookmarks: [], problem: "broken" });
    settle();
    expect(commands.isEnabled("bookmarks.add", none, { node: { type: "file", path: "a.md" } })).toBe(false);
  });

  it("acts on the focused tab from the palette, under fixed names", () => {
    const { menus } = setup({ bookmarks: [] });
    expect(menus.commandsIn(COMMAND_PALETTE, none)).toEqual([
      { command: "bookmarks.add", label: "Bookmark" },
      { command: "bookmarks.remove", label: "Remove from Bookmarks" },
    ]);
  });
});

describe("dragging a bookmark", () => {
  const paths = ["a", "b", "c", "d"];

  it("lands before the row under it, or after it from its lower half", () => {
    expect(dropPlace(paths, "b", "a", false)).toBe("a");
    expect(dropPlace(paths, "b", "c", true)).toBe("d");
    expect(dropPlace(paths, "a", "d", false)).toBe("d");
    expect(dropPlace(paths, "b", "d", true)).toBeUndefined();
  });

  it("stays put when the drop is where it already is", () => {
    expect(dropPlace(paths, "b", "a", true)).toBeNull();
    expect(dropPlace(paths, "b", "b", false)).toBeNull();
    expect(dropPlace(paths, "b", "b", true)).toBeNull();
    expect(dropPlace(paths, "b", "c", false)).toBeNull();
    expect(dropPlace(paths, "d", "d", true)).toBeNull();
  });

  // jsdom draws no boxes, so every row's middle is at 0: a drop at 0 is its
  // upper half, one below it the lower.
  function drag(type: string, target: HTMLElement, clientY = 0, types = ["application/x-pragma-bookmark"]) {
    const event = new Event(type, { bubbles: true, cancelable: true });
    const data = new Map<string, string>();
    const setData = (format: string, value: string) => data.set(format, value);
    Object.defineProperty(event, "clientY", { value: clientY });
    Object.defineProperty(event, "dataTransfer", { value: { types, setData, effectAllowed: "" } });
    target.dispatchEvent(event);
    return Object.assign(event, { data });
  }

  it("moves the row it carries to where it is dropped", () => {
    const { rows, settle, change } = setup({ bookmarks: [file("a.md"), file("b.md"), file("c.md")] });
    settle();
    drag("dragstart", rows()[2]);
    expect(drag("dragover", rows()[0]).defaultPrevented).toBe(true);
    expect(rows()[0].classList.contains("drag-over-top")).toBe(true);
    drag("drop", rows()[0]);
    expect(change).toHaveBeenCalledWith({ move: "c.md", before: "a.md" });
    expect(rows()[0].classList.contains("drag-over-top")).toBe(false);
  });

  it("moves a row dropped on the room under the last to the end", () => {
    const { view, rows, settle, change } = setup({ bookmarks: [file("a.md"), file("b.md"), file("c.md")] });
    settle();
    drag("dragstart", rows()[0]);
    drag("drop", view.panel.querySelector(".bookmarks-list") as HTMLElement);
    expect(change).toHaveBeenCalledWith({ move: "a.md" });
  });

  it("takes no drag that isn't a bookmark's", () => {
    const { rows, settle, change } = setup({ bookmarks: [file("a.md"), file("b.md")] });
    settle();
    expect(drag("dragover", rows()[0], 0, ["text/plain"]).defaultPrevented).toBe(false);
    drag("drop", rows()[0], 0, ["text/plain"]);
    expect(change).not.toHaveBeenCalled();
  });

  // A redraw would detach the row the browser is carrying.
  it("redraws only once the drop lands", () => {
    const { rows, settle } = setup({ bookmarks: [file("a.md"), file("b.md")] });
    settle();
    const carried = rows()[1];
    drag("dragstart", carried);
    settle({ bookmarks: [file("a.md"), file("b.md"), file("c.md")] });
    expect(rows()).toHaveLength(2);
    expect(carried.isConnected).toBe(true);
    document.dispatchEvent(new Event("dragend"));
    expect(rows()).toHaveLength(3);
  });

  // What a note, a Flow or a field reads off a tree row's drag.
  it("carries its entry as the tree row's drag does", () => {
    const { rows, settle } = setup({ bookmarks: [file("lib:refs/cat.png"), folder("projects")] });
    settle();
    expect(Object.fromEntries(drag("dragstart", rows()[0]).data)).toEqual({
      "application/x-pragma-bookmark": "lib:refs/cat.png",
      "text/plain": "lib:refs/cat.png",
      [DRAGGED_ENTRY_TYPE]: "file",
    });
    expect(draggedPathInFlight()).toEqual({ root: { library: "refs" }, path: "cat.png" });
    document.dispatchEvent(new Event("dragend"));
    expect(draggedPathInFlight()).toBeUndefined();
    expect(drag("dragstart", rows()[1]).data.get(DRAGGED_ENTRY_TYPE)).toBe("directory");
    document.dispatchEvent(new Event("dragend"));
  });

  it("carries only its place in the list when its entry is missing", () => {
    const { rows, settle } = setup({ bookmarks: [{ path: "gone.md" }] });
    settle();
    expect([...drag("dragstart", rows()[0]).data.keys()]).toEqual(["application/x-pragma-bookmark"]);
    expect(draggedPathInFlight()).toBeUndefined();
    document.dispatchEvent(new Event("dragend"));
  });
});
