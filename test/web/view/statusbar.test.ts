// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { LibraryRow } from "../../../web/core/apiClient.ts";
import { setLibraryPermissions } from "../../../web/core/libraries.ts";
import { must } from "../../../web/lib/dom.ts";
import { createAppIndicators, createStatusbar, PATH_FOLDER_MENU } from "../../../web/view/statusbar.ts";

vi.mock("../../../web/core/apiClient.ts", () => ({
  fetchLibraries: vi.fn(async () => ({ libraries: [{ id: "footage", label: "Footage" }] })),
}));

// jsdom lays nothing out: a test that resizes a bar calls its observer, and
// the frame the bar fits in comes at once.
const resized: (() => void)[] = [];
globalThis.ResizeObserver = class {
  constructor(callback: () => void) {
    resized.push(callback);
  }
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;
vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
  callback(0);
  return 0;
});
vi.stubGlobal("cancelAnimationFrame", () => {});

function setup() {
  const menu = { open: vi.fn(), close: vi.fn(), isOpen: vi.fn(() => false) };
  const deps = {
    go: vi.fn(),
    shortcutFor: () => undefined,
    showNotices: vi.fn(),
    openFolder: vi.fn(),
    contextMenu: menu,
  };
  const saves = { retrySaves: vi.fn(), reviewConflicts: vi.fn() };
  const indicators = createAppIndicators(saves);
  const statusbar = createStatusbar(deps, indicators);
  const part = (name: string) => must<HTMLElement>(`.editor-statusbar-${name}`, statusbar.element);
  return {
    statusbar,
    indicators,
    saves,
    path: part("path"),
    errors: part("errors"),
    problems: part("problems"),
    problemsLabel: part("problems-label"),
    notices: part("notices"),
    noticesLabel: part("notices-label"),
    count: part("wordcount"),
    menu,
    deps,
  };
}

const folders = (path: HTMLElement) => [...path.querySelectorAll("button")];

describe("the status bar's path", () => {
  // The spaces either side of each "/" come from the stylesheet, so the text,
  // which is what a selection copies, is the path as written.
  it("opens a folder above the file in the tab's place, and names the file as text", () => {
    const { statusbar, path, deps } = setup();
    statusbar.setPath("projects/forbidden/scene.fountain");
    expect(path.textContent).toBe("projects/forbidden/scene.fountain");
    expect(folders(path).map((button) => button.textContent)).toEqual(["projects", "forbidden"]);
    folders(path)[1].click();
    expect(deps.openFolder).toHaveBeenCalledWith("projects/forbidden");
  });

  // A drag across part of a folder's name ends in a click on that folder.
  it("opens a folder on a click, not on a press that travelled to select its name", () => {
    const { statusbar, path, deps } = setup();
    statusbar.setPath("projects/scene.fountain");
    const [folder] = folders(path);
    const press = (downX: number, upX: number) => {
      folder.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: downX, clientY: 5 }));
      folder.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1, clientX: upX, clientY: 5 }));
    };
    press(10, 30);
    expect(deps.openFolder).not.toHaveBeenCalled();

    // A keyboard's click has no press of its own to have travelled.
    folder.click();
    expect(deps.openFolder).toHaveBeenCalledTimes(1);
    press(10, 12);
    expect(deps.openFolder).toHaveBeenCalledTimes(2);
  });

  it("selects the whole path on a triple-click, and nothing past it", () => {
    const { statusbar, path } = setup();
    document.body.append(statusbar.element);
    statusbar.setPath("projects/scene.fountain");
    const press = new MouseEvent("mousedown", { bubbles: true, cancelable: true, detail: 3 });
    must(".editor-statusbar-path-name", path).dispatchEvent(press);
    expect(press.defaultPrevented).toBe(true);
    const range = document.getSelection()?.getRangeAt(0);
    expect([range?.startContainer, range?.endContainer]).toEqual([path, path]);
    expect(range?.toString()).toBe("projects/scene.fountain");
    statusbar.element.remove();
  });

  // Its menu opens the folder's gallery, as its click does, elsewhere.
  it("opens the folder's menu on a right-click", () => {
    const { statusbar, path, menu } = setup();
    statusbar.setPath("projects/scene.fountain");
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 3, clientY: 4 });
    folders(path)[0].dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(menu.open).toHaveBeenCalledWith({
      menu: PATH_FOLDER_MENU,
      arg: { folder: "projects" },
      at: { x: 3, y: 4 },
      ariaLabel: "Folder actions",
    });
  });

  it("opens a library's top folder from its name, and each folder below it under the library", async () => {
    const { statusbar, path, deps } = setup();
    statusbar.setPath("lib:footage/day 1/take.mp4");
    const [root, day] = folders(path);
    root.click();
    expect(deps.openFolder).toHaveBeenCalledWith("lib:footage");
    day.click();
    expect(deps.openFolder).toHaveBeenLastCalledWith("lib:footage/day 1");
    await vi.waitFor(() => expect(path.textContent).toBe("Footage/day 1/take.mp4"));
  });

  it("follows a library's rename", async () => {
    const { statusbar, path } = setup();
    statusbar.setPath("lib:footage/take.mp4");
    await vi.waitFor(() => expect(path.textContent).toBe("Footage/take.mp4"));
    setLibraryPermissions([{ id: "footage", label: "Archive" } as LibraryRow]);
    expect(path.textContent).toBe("Archive/take.mp4");
    setLibraryPermissions([{ id: "footage", label: "Footage" } as LibraryRow]);
  });

  it("ends at a library's name when the tab shows its top folder", async () => {
    const { statusbar, path } = setup();
    statusbar.setPath("lib:footage");
    expect(folders(path)).toHaveLength(1);
    await vi.waitFor(() => expect(path.textContent).toBe("Footage"));
  });

  it("shows a file at the top of the space with no folder to open", () => {
    const { statusbar, path } = setup();
    statusbar.setPath("todo.md");
    expect(folders(path)).toEqual([]);
    expect(path.textContent).toBe("todo.md");
  });

  it("shows a path it can't parse verbatim, with no folder to open", () => {
    const { statusbar, path } = setup();
    statusbar.setPath("foo:bar/baz.md");
    expect(folders(path)).toEqual([]);
    expect(path.textContent).toBe("foo:bar/baz.md");
  });
});

describe("the status bar's notices", () => {
  it("counts each level's notices about the path it names, and opens that level's on a click", () => {
    const { statusbar, errors, problems, problemsLabel, notices, noticesLabel, deps } = setup();
    statusbar.renderNotices(new Map([["a.flow.html", { error: 0, warn: 3, info: 2 }]]));
    statusbar.setPath("b.flow.html");
    expect([errors.hidden, problems.hidden, notices.hidden]).toEqual([true, true, true]);

    statusbar.setPath("a.flow.html");
    expect([errors.hidden, problems.hidden, notices.hidden]).toEqual([true, false, false]);
    expect([problemsLabel.textContent, noticesLabel.textContent]).toEqual(["3 problems", "2 notices"]);
    expect(notices.dataset.tooltip).toBe("This file has 2 notices. Click for the details in the Console.");
    problems.click();
    notices.click();
    expect(deps.showNotices.mock.calls).toEqual([
      ["a.flow.html", "warn"],
      ["a.flow.html", "info"],
    ]);

    statusbar.renderNotices(new Map([["a.flow.html", { error: 1, warn: 1, info: 0 }]]));
    expect(errors.textContent).toBe("1 error");
    expect(problemsLabel.textContent).toBe("1 problem");
    expect(notices.hidden).toBe(true);
    statusbar.renderNotices(new Map());
    expect([errors.hidden, problems.hidden]).toEqual([true, true]);
  });
});

// jsdom has no layout: each child of the path is given a width, laid out
// left to right, and the path its own.
function layOut(path: HTMLElement, width: () => number) {
  const widthOf = (element: Element) =>
    element.classList.contains("editor-statusbar-path-more")
      ? 20
      : element.classList.contains("editor-statusbar-path-step")
        ? 80
        : 60;
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    if (this === path) return new DOMRect(0, 0, width(), 20);
    let right = 0;
    for (const child of path.children) {
      if (!(child as HTMLElement).hidden) right += widthOf(child);
      if (child === this) break;
    }
    return new DOMRect(right - widthOf(this), 0, widthOf(this), 20);
  });
}

// The marker draws its "… / " from the stylesheet; here it reads as "…/".
const shown = (path: HTMLElement) =>
  [...path.children]
    .filter((child) => !(child as HTMLElement).hidden)
    .map((child) => (child.classList.contains("editor-statusbar-path-more") ? "…/" : child.textContent))
    .join("");

describe("the status bar's path in a narrow bar", () => {
  it("drops leading folders, whole, before the name loses a letter", () => {
    const { statusbar, path } = setup();
    let width = 200;
    layOut(path, () => width);
    statusbar.setPath("projects/forbidden/scenes/03.fountain");
    expect(shown(path)).toBe("…/scenes/03.fountain");
    // No text of its own, so a copy of what shows holds no ellipsis.
    expect(must(".editor-statusbar-path-more", path).textContent).toBe("");

    width = 50;
    resized.at(-1)?.();
    expect(shown(path)).toBe("…/03.fountain");

    width = 400;
    resized.at(-1)?.();
    expect(shown(path)).toBe("projects/forbidden/scenes/03.fountain");
    vi.restoreAllMocks();
  });

  it("drops the count's characters next, then shows as many folders as fit", () => {
    const { statusbar, path, count } = setup();
    // The path gets what the count leaves it.
    let room = { whole: 70, words: 180 };
    layOut(path, () => (count.textContent?.includes("character") ? room.whole : room.words));
    statusbar.setWordCount({ words: 3, chars: 12 });
    statusbar.setPath("projects/forbidden/scenes/03.fountain");
    expect(count.textContent).toBe("3 words");
    expect(shown(path)).toBe("…/scenes/03.fountain");

    room = { whole: 400, words: 500 };
    resized.at(-1)?.();
    expect(count.textContent).toBe("3 words · 12 characters");
    expect(shown(path)).toBe("projects/forbidden/scenes/03.fountain");
    vi.restoreAllMocks();
  });

  it("cuts an announcement's end once no folder is left to drop, saying it whole on hover", () => {
    const { statusbar, path, count } = setup();
    // The path gets what the announcement leaves it, more once it is cut.
    let room = { whole: 170, cut: 100 };
    layOut(path, () => (count.classList.contains("is-cut") ? room.cut : room.whole));
    statusbar.setPath("projects/forbidden/scenes/03.fountain");
    statusbar.announce("Saved as default view for everyone");
    expect(shown(path)).toBe("…/scenes/03.fountain");
    expect(count.classList.contains("is-cut")).toBe(false);
    expect(count.dataset.tooltip).toBeUndefined();

    room = { whole: 60, cut: 100 };
    resized.at(-1)?.();
    expect(shown(path)).toBe("…/03.fountain");
    expect(count.classList.contains("is-cut")).toBe(true);
    expect(count.dataset.tooltip).toBe("Saved as default view for everyone");

    // What replaces it is never cut, even with nothing resized.
    statusbar.setReadout("2 folders · 7 files");
    expect(count.classList.contains("is-cut")).toBe(false);
    expect(count.dataset.tooltip).toBeUndefined();
    vi.restoreAllMocks();
  });

  it("keeps a library's top folder, which names what the tab shows", () => {
    const { statusbar, path } = setup();
    layOut(path, () => 10);
    statusbar.setPath("lib:footage");
    expect(path.querySelector(".editor-statusbar-path-more")).toBeNull();
    vi.restoreAllMocks();
  });
});

describe("the status bar's count", () => {
  it("shows a pane's readout until a count arrives, then the count until cleared", () => {
    const { statusbar, count } = setup();
    statusbar.setReadout("2 folders · 7 files");
    expect(count.textContent).toBe("2 folders · 7 files");

    statusbar.setWordCount({ words: 3, chars: 12 });
    statusbar.setReadout("Saved Title in note.md");
    expect(count.textContent).toBe("3 words · 12 characters");

    statusbar.clearWordCount();
    expect(count.textContent).toBe("");
  });

  // A gallery reports its count again on every draw, the one its own action
  // caused among them, and that must not end the announcement.
  it("holds an announcement, flashed, until the pane reports something new or the tab changes", () => {
    const { statusbar, count } = setup();
    statusbar.setReadout("2 folders · 7 files");
    statusbar.announce("Saved as default view for everyone");
    expect(count.textContent).toBe("Saved as default view for everyone");
    expect(count.classList.contains("flash")).toBe(true);
    statusbar.setReadout("2 folders · 7 files");
    expect(count.textContent).toBe("Saved as default view for everyone");
    statusbar.setReadout("2 folders · 8 files");
    expect(count.textContent).toBe("2 folders · 8 files");

    statusbar.setWordCount({ words: 3, chars: 12 });
    statusbar.announce("Saved as default view for everyone");
    statusbar.setWordCount({ words: 3, chars: 12 });
    expect(count.textContent).toBe("Saved as default view for everyone");
    statusbar.setWordCount({ words: 4, chars: 17 });
    expect(count.textContent).toBe("4 words · 17 characters");

    statusbar.announce("Saved as default view for everyone");
    statusbar.clearWordCount();
    expect(count.textContent).toBe("");
  });

  it("takes an announcement back, flash and all, only while it is the one showing", () => {
    const { statusbar, count } = setup();
    statusbar.setReadout("2 folders · 7 files");
    const first = statusbar.announce("Saved as default view for everyone");
    first();
    expect(count.textContent).toBe("2 folders · 7 files");
    expect(count.classList.contains("flash")).toBe(false);

    const second = statusbar.announce("Saved as default view for everyone");
    statusbar.announce("Moved 3 files");
    second();
    expect(count.textContent).toBe("Moved 3 files");

    const third = statusbar.announce("Saved as default view for everyone");
    statusbar.setReadout("2 folders · 8 files");
    third();
    expect(count.textContent).toBe("2 folders · 8 files");
  });
});

describe("the status bar's navigation", () => {
  it("goes back and forward through the bar's own deps, disabled with nowhere to go", () => {
    const { statusbar, deps } = setup();
    const back = must<HTMLButtonElement>(".editor-statusbar-back", statusbar.element);
    const forward = must<HTMLButtonElement>(".editor-statusbar-forward", statusbar.element);
    expect([back.disabled, forward.disabled]).toEqual([true, true]);

    statusbar.setNavigation({ back: true, forward: false });
    expect([back.disabled, forward.disabled]).toEqual([false, true]);
    back.click();
    expect(deps.go).toHaveBeenCalledWith("back");
  });
});

describe("the app's indicators", () => {
  it("sit either side of the file's notices in the bar holding them, and move to the next holder", () => {
    const { statusbar, indicators, deps } = setup();
    const classes = (root: HTMLElement) => [...root.children].map((child) => child.classList[0]);
    statusbar.holdIndicators(true);
    expect(classes(statusbar.element)).toEqual([
      "editor-statusbar-nav",
      "editor-statusbar-path",
      "editor-statusbar-activity",
      "editor-statusbar-errors",
      "editor-statusbar-problems",
      "editor-statusbar-notices",
      "editor-statusbar-save",
      "editor-statusbar-wordcount",
    ]);

    const other = createStatusbar(deps, indicators);
    other.holdIndicators(true);
    statusbar.holdIndicators(false);
    expect(statusbar.element.contains(indicators.save)).toBe(false);
    expect(other.element.contains(indicators.save)).toBe(true);
    expect(other.element.contains(indicators.activity)).toBe(true);
  });

  it("shows the bar holding them while a save is failing, whatever its pane declares, and no other", () => {
    const { statusbar, indicators, deps } = setup();
    const other = createStatusbar(deps, indicators);
    statusbar.holdIndicators(true);
    other.holdIndicators(false);
    expect([statusbar.element.hidden, other.element.hidden]).toEqual([true, true]);

    indicators.renderSave({ failedPaths: ["a.md"], conflictPaths: [], message: "Disk full" });
    expect([statusbar.element.hidden, other.element.hidden]).toEqual([false, true]);

    indicators.renderSave({ failedPaths: [], conflictPaths: [] });
    expect(statusbar.element.hidden).toBe(true);
    other.setDeclared(true);
    expect(other.element.hidden).toBe(false);
  });

  it("names a conflict over a failure, which a click reviews rather than retries", () => {
    const { indicators, saves } = setup();
    indicators.renderSave({ failedPaths: ["a.md"], conflictPaths: [] });
    expect([indicators.save.hidden, indicators.save.textContent]).toEqual([false, "Not saved"]);
    indicators.save.click();
    expect(saves.retrySaves).toHaveBeenCalledTimes(1);

    indicators.renderSave({ failedPaths: ["a.md"], conflictPaths: ["b.md", "c.md"] });
    expect(indicators.save.textContent).toBe("2 save conflicts");
    indicators.save.click();
    expect(saves.reviewConflicts).toHaveBeenCalledTimes(1);
    expect(saves.retrySaves).toHaveBeenCalledTimes(1);
  });
});
