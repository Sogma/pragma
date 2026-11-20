// @vitest-environment jsdom
import { EditorView, ViewPlugin } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type { FileResponse, TableFileResponse, TextFileResponse } from "../../web/core/apiClient.ts";
import {
  installLinkPreview,
  type LinkPreview,
  type LinkPreviewDeps,
  PAGE_PREVIEW_SCALE,
  PREVIEW_OPEN_MENU,
  veilPath,
} from "../../web/notePreview.ts";
import { createDialogService } from "../../web/services/dialog.ts";
import { createFormats, type FormatRegistry } from "../../web/services/formats.ts";
import { polyfillRangeRects } from "./support/codemirrorJsdom.ts";
import { testFormats } from "./support/formats.ts";
import { asStyled } from "./support/styled.ts";

polyfillRangeRects();

// The editing area, at the box reading view's pane would have.
function areaAt(left: number, top: number, width: number, height: number): HTMLElement {
  const area = document.createElement("div");
  area.getBoundingClientRect = () => new DOMRect(left, top, width, height);
  document.body.append(area);
  return area;
}

function textFile(path: string, content: string): TextFileResponse {
  return { kind: "text", path, revision: "r1", content, documentType: "note", toolkits: [], classLinks: [] };
}

const settle = () => vi.advanceTimersByTimeAsync(0);
const pointer = (type: string, target: Element, init: PointerEventInit = {}) =>
  target.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerType: "mouse", ...init }));
// As a browser moves the pointer onto it: an over, then a move.
const over = (target: Element, init: PointerEventInit = {}) => {
  pointer("pointerover", target, init);
  pointer("pointermove", target, init);
};
const preview = () => document.querySelector<HTMLElement>(".link-preview");
const titleOf = () => preview()?.querySelector<HTMLInputElement>(".editor-title-input")?.value;

let container: HTMLElement;
let elsewhere: HTMLElement;
let installed: LinkPreview | undefined;
let deps: LinkPreviewDeps;

// Reading view's page: a link to a note, one to a Table in a library, one to
// a screenplay, one to a Flow, and plain text.
function install(overrides: Partial<LinkPreviewDeps> = {}): void {
  container = document.createElement("div");
  container.innerHTML =
    '<p>See <a href="notes/keeper.md" data-space-path="notes/keeper.md">the <b>keeper</b></a>, ' +
    '<a href="deck.table.html" data-space-path="lib:lab/deck.table.html">the deck</a>, ' +
    '<a href="act.fountain" data-space-path="story/act.fountain">the act</a>, ' +
    '<a href="story.flow.html" data-space-path="story.flow.html">the story</a> and more.</p>';
  elsewhere = document.createElement("div");
  document.body.append(container, elsewhere);
  deps = {
    loadFile: vi.fn(async (path: string): Promise<FileResponse> => textFile(path, "# Keeper\n\nSee [[lamp]].\n")),
    readingResolvers: vi.fn(() => ({
      image: () => undefined,
      link: () => undefined,
      wikilink: () => "notes/lamp.md",
      hint: () => undefined,
    })),
    formats: createFormats(),
    openPath: vi.fn(),
    openBeside: vi.fn(),
    area: areaAt(0, 0, window.innerWidth, window.innerHeight),
    runs: "right",
    contextMenu: { open: vi.fn(), close: vi.fn(), isOpen: () => false },
    dialog: createDialogService(),
    ...overrides,
  };
  installed = installLinkPreview(container, deps);
}

const link = () => container.querySelector('a[href$=".md"]') as HTMLElement;
const tableLink = () => container.querySelector('a[href$=".table.html"]') as HTMLElement;
const scriptLink = () => container.querySelector('a[href$=".fountain"]') as HTMLElement;
const flowLink = () => container.querySelector('a[href$=".flow.html"]') as HTMLElement;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});

afterEach(() => {
  installed?.dispose();
  installed = undefined;
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe("a link's preview", () => {
  it("shows the note once the pointer rests on its link, as reading view draws it", async () => {
    install();
    over(link().querySelector("b") as HTMLElement);
    await vi.advanceTimersByTimeAsync(299);
    expect(preview()).toBeNull();

    await vi.advanceTimersByTimeAsync(1);
    expect(deps.loadFile).toHaveBeenCalledWith("notes/keeper.md");
    expect(deps.readingResolvers).toHaveBeenCalledWith("notes/keeper.md");
    expect(titleOf()).toBe("Keeper");
    expect(preview()?.querySelector(".editor-reading-content a")?.textContent).toBe("lamp");
  });

  it("previews nothing for a file no page draws, a pointer that left first, or one pressed", async () => {
    install();
    over(flowLink());
    await vi.advanceTimersByTimeAsync(1000);
    over(link());
    await vi.advanceTimersByTimeAsync(200);
    over(container.querySelector("p") as HTMLElement);
    await vi.advanceTimersByTimeAsync(1000);
    over(link(), { buttons: 1 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(deps.loadFile).not.toHaveBeenCalled();
    expect(preview()).toBeNull();
  });

  it("leaves a link with a hint, a note not found, to its hint", async () => {
    install();
    link().dataset.tooltip = "Not found: keeper.md";
    over(link());
    await vi.advanceTimersByTimeAsync(1000);
    expect(deps.loadFile).not.toHaveBeenCalled();
    expect(preview()).toBeNull();
  });

  // A line redrawn under a pointer left resting while its text is typed, or
  // scrolled under it, gets an over and no move.
  it("waits on a pointer that moves, never on a link that came under a still one", async () => {
    install();
    pointer("pointerover", link());
    await vi.advanceTimersByTimeAsync(1000);
    expect(deps.loadFile).not.toHaveBeenCalled();

    pointer("pointermove", link());
    await vi.advanceTimersByTimeAsync(300);
    expect(titleOf()).toBe("Keeper");
  });

  // The read is slow: the pointer moves on before it lands.
  it("drops a note that arrives after the pointer moved on", async () => {
    let land: (file: FileResponse) => void = () => {};
    install({ loadFile: vi.fn(() => new Promise<FileResponse>((resolve) => (land = resolve))) });
    over(link());
    await vi.advanceTimersByTimeAsync(300);
    over(elsewhere);
    land(textFile("notes/keeper.md", "# Keeper\n"));
    await settle();
    expect(preview()).toBeNull();
  });

  it("stays while the pointer crosses onto the page, and goes once it has left both", async () => {
    install();
    over(link());
    await vi.advanceTimersByTimeAsync(300);
    over(container.querySelector("p") as HTMLElement);
    await vi.advanceTimersByTimeAsync(200);
    over(preview()?.querySelector(".editor-reading-content") as HTMLElement);
    await vi.advanceTimersByTimeAsync(1000);
    expect(preview()).not.toBeNull();

    over(elsewhere);
    await vi.advanceTimersByTimeAsync(299);
    expect(preview()).not.toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(preview()).toBeNull();
  });

  it("goes on Escape and on a press outside it, never on a press in it", async () => {
    install();
    over(link());
    await vi.advanceTimersByTimeAsync(300);
    preview()
      ?.querySelector("p")
      ?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    expect(preview()).not.toBeNull();
    const pressed = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    document.body.dispatchEvent(pressed);
    expect([preview(), pressed.defaultPrevented]).toEqual([null, true]);

    over(elsewhere);
    over(link());
    await vi.advanceTimersByTimeAsync(300);
    elsewhere.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    expect(preview()).toBeNull();
  });

  // A copy of text selected on the page is typed with the focus outside
  // the container.
  it("goes on a key typed where its link is, not on a modifier alone or a key typed elsewhere", async () => {
    install();
    over(link());
    await vi.advanceTimersByTimeAsync(300);
    const typed = (target: Element, init: KeyboardEventInit) =>
      target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
    const text = container.querySelector("p") as HTMLElement;
    typed(text, { key: "Shift", shiftKey: true });
    typed(document.body, { key: "c", ctrlKey: true });
    typed(elsewhere, { key: "a" });
    expect(preview()).not.toBeNull();

    typed(text, { key: "a" });
    expect(preview()).toBeNull();
  });

  // Only a scroll that moves the link takes it down: a chat writing an
  // answer scrolls too.
  it("goes when what holds the link scrolls, not when another scroller does", async () => {
    install();
    over(link());
    await vi.advanceTimersByTimeAsync(300);
    elsewhere.dispatchEvent(new Event("scroll"));
    expect(preview()).not.toBeNull();
    document.body.dispatchEvent(new Event("scroll"));
    expect(preview()).toBeNull();
  });

  it("opens a space link clicked on its page here, and previews nothing from there", async () => {
    install();
    over(link());
    await vi.advanceTimersByTimeAsync(300);
    const inPage = preview()?.querySelector("a[data-space-path]") as HTMLElement;
    over(inPage);
    await vi.advanceTimersByTimeAsync(1000);
    expect(deps.loadFile).toHaveBeenCalledTimes(1);

    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    inPage.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(deps.openPath).toHaveBeenCalledWith("notes/lamp.md");
    expect(preview()).toBeNull();
  });

  it("opens the note in a new tab from the control on its page, leaving this tab as it is", async () => {
    install();
    over(link());
    await vi.advanceTimersByTimeAsync(300);
    const open = preview()?.querySelector(".preview-open") as HTMLButtonElement;
    expect(open.getAttribute("aria-label")).toBe("Open in new tab");

    open.click();
    expect(deps.openBeside).toHaveBeenCalledWith("notes/keeper.md");
    expect(deps.openPath).not.toHaveBeenCalled();
    expect(preview()).toBeNull();
  });

  it("offers the control's menu for the note on a right-click, and stays while a menu is open", async () => {
    let menuOpen = false;
    const contextMenu = {
      open: vi.fn(() => {
        menuOpen = true;
      }),
      close: vi.fn(),
      isOpen: () => menuOpen,
    };
    install({ contextMenu });
    over(link());
    await vi.advanceTimersByTimeAsync(300);
    const open = preview()?.querySelector(".preview-open") as HTMLButtonElement;
    const click = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 60 });

    open.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(contextMenu.open).toHaveBeenCalledWith({
      menu: PREVIEW_OPEN_MENU,
      arg: { file: "notes/keeper.md" },
      at: { x: 40, y: 60 },
      ariaLabel: "Open in new tab",
    });
    expect(deps.openPath).not.toHaveBeenCalled();
    expect(deps.openBeside).not.toHaveBeenCalled();

    // Onto the menu, and its Escape, which the menu takes.
    over(elsewhere);
    await vi.advanceTimersByTimeAsync(300);
    const press = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    elsewhere.dispatchEvent(press);
    expect(press.defaultPrevented).toBe(false);
    expect(preview()).not.toBeNull();

    menuOpen = false;
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(preview()).toBeNull();
  });

  it("mutes the note behind a shown page, and lifts it as the page goes", async () => {
    install();
    const veil = deps.area.querySelector(".link-preview-veil") as HTMLElement;
    expect(veil.classList.contains("is-shown")).toBe(false);
    over(link());
    await vi.advanceTimersByTimeAsync(300);
    expect(veil.classList.contains("is-shown")).toBe(true);

    over(elsewhere);
    await vi.advanceTimersByTimeAsync(300);
    expect([preview(), veil.classList.contains("is-shown")]).toEqual([null, false]);
    installed?.dispose();
    expect(deps.area.querySelector(".link-preview-veil")).toBeNull();
  });

  describe("a Table's page", () => {
    // In a library, whose listing may not have landed: what its cells name is
    // taken on trust, so a path or a picture shows as there.
    const deck = (overrides: Partial<TableFileResponse> = {}): TableFileResponse => ({
      kind: "table",
      path: "lib:lab/deck.table.html",
      revision: "r1",
      version: "1.0",
      name: "Deck",
      columns: [
        { id: "still", label: "Still", type: "media" },
        { id: "shot", label: "Shot", type: "text" },
        { id: "status", label: "Status", type: "select", options: ["draft", "final"] },
        { id: "notes", label: "Notes", type: "text" },
        { id: "ref", label: "Ref", type: "path" },
      ],
      rows: [{ values: { still: "stills/wide.png", shot: "Wide", status: "final", notes: "", ref: "keeper.md" } }],
      ...overrides,
    });
    const shown = async (file: TableFileResponse) => {
      install({
        loadFile: vi.fn(
          async (path: string): Promise<FileResponse> =>
            path.endsWith(".table.html") ? file : textFile(path, "# Keeper\n"),
        ),
      });
      over(tableLink());
      await vi.advanceTimersByTimeAsync(300);
      return preview()?.querySelector(".table-page") as HTMLElement;
    };
    const pressOnPage = (selector: string) => {
      const button = preview()?.querySelector(selector) as HTMLButtonElement;
      button.click();
    };

    it("shows the Table as its tab's reading view does, nothing on it to change", async () => {
      const page = await shown(deck());
      expect(deps.loadFile).toHaveBeenCalledWith("lib:lab/deck.table.html");
      expect(titleOf()).toBe("Deck");
      expect(page.querySelector(".data-table-form")?.classList.contains("is-read-only")).toBe(true);
      expect([...page.querySelectorAll("th")].map((th) => th.textContent)).toEqual([
        "Still",
        "Shot",
        "Status",
        "Notes",
        "Ref",
      ]);
      expect(page.querySelector(".data-table-form :is(input, select), .data-table-add-row")).toBeNull();
    });

    it("draws the layout the Table opens in, a card leaving out a line with no value", async () => {
      const page = await shown(deck({ layout: "list", localLayout: "cards" }));
      expect(page.querySelector("table")).toBeNull();
      expect(page.querySelector(".data-cards-title")?.textContent).toBe("Wide");
      const labels = [...page.querySelectorAll(".data-cards-field-label")].map((label) => label.textContent);
      expect(labels).toEqual(["Ref"]);
    });

    it("titles a Table with no name by its file", async () => {
      await shown(deck({ name: undefined }));
      expect(titleOf()).toBe("deck");
    });

    it("opens what a path cell or a picture names, the page going first", async () => {
      await shown(deck());
      pressOnPage(".path-field-entry");
      expect(deps.openPath).toHaveBeenCalledWith("lib:lab/keeper.md");
      expect(preview()).toBeNull();

      over(elsewhere);
      over(tableLink());
      await vi.advanceTimersByTimeAsync(300);
      pressOnPage(".media-field-thumb");
      expect(deps.openPath).toHaveBeenLastCalledWith("lib:lab/stills/wide.png");
      expect(preview()).toBeNull();
    });

    it("opens the Table in a new tab from the control on its page", async () => {
      await shown(deck());
      pressOnPage(".preview-open");
      expect(deps.openBeside).toHaveBeenCalledWith("lib:lab/deck.table.html");
    });

    it("says in the page why the file couldn't be read as a Table", async () => {
      install({ loadFile: vi.fn(async (path: string): Promise<FileResponse> => textFile(path, "# Not one\n")) });
      over(tableLink());
      await vi.advanceTimersByTimeAsync(300);
      expect(preview()?.querySelector(".table-page")?.textContent).toBe("Failed to load file");
    });
  });

  describe("a screenplay's page", () => {
    const screenplay = (path: string, content: string): TextFileResponse => ({
      ...textFile(path, content),
      documentType: "screenplay",
    });
    const shownLines = () => [...(preview()?.querySelectorAll(".cm-line") ?? [])].map((line) => line.textContent);

    // A format whose editor says when it is destroyed.
    function watchedFormats(): { formats: FormatRegistry; asked: (string | undefined)[]; destroyed: Mock } {
      const asked: (string | undefined)[] = [];
      const destroyed = vi.fn();
      const formats = createFormats();
      formats.register("screenplay", {
        extensions: (context) => {
          asked.push(context.path());
          return ViewPlugin.define(() => ({ destroy: destroyed }));
        },
        links: () => ({ found: [], missing: [] }),
        embedsImages: false,
      });
      return { formats, asked, destroyed };
    }

    // A forced scene heading, a note and a centred line: marks Fountain never
    // prints, which reading view hides.
    it("shows the screenplay as its reading view does, in its format's locked editor", async () => {
      const script = ".THE CELLAR STAIRS\n\nBOOM. The door gives. [[louder?]]\n\n> THE END <";
      install({
        formats: testFormats(),
        loadFile: vi.fn(async (path: string): Promise<FileResponse> => screenplay(path, script)),
      });
      over(scriptLink());
      await vi.advanceTimersByTimeAsync(300);

      expect(deps.loadFile).toHaveBeenCalledWith("story/act.fountain");
      const editor = preview()?.querySelector<HTMLElement>(".editor-page > .cm-editor.fountain-editor");
      const view = editor ? EditorView.findFromDOM(editor) : null;
      expect([view?.state.readOnly, view?.contentDOM.getAttribute("contenteditable")]).toEqual([true, "false"]);
      expect(shownLines()).toEqual(["THE CELLAR STAIRS", "", "BOOM. The door gives.", "", "THE END"]);
      expect(preview()?.querySelector(".editor-title-bar")).toBeNull();
    });

    it("draws the page by the format its type registers, and destroys the editor as the page goes", async () => {
      const { formats, asked, destroyed } = watchedFormats();
      install({
        formats,
        loadFile: vi.fn(async (path: string): Promise<FileResponse> => screenplay(path, "FADE IN:")),
      });
      over(scriptLink());
      await vi.advanceTimersByTimeAsync(300);
      expect(asked).toEqual(["story/act.fountain"]);
      expect(shownLines()).toEqual(["FADE IN:"]);
      expect(destroyed).not.toHaveBeenCalled();

      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      expect(preview()).toBeNull();
      expect(destroyed).toHaveBeenCalledTimes(1);
    });

    it("destroys the editor of a page whose link went while the file was read", async () => {
      const { formats, destroyed } = watchedFormats();
      let land: (file: FileResponse) => void = () => {};
      install({ formats, loadFile: vi.fn(() => new Promise<FileResponse>((resolve) => (land = resolve))) });
      over(scriptLink());
      await vi.advanceTimersByTimeAsync(300);
      scriptLink().remove();
      land(screenplay("story/act.fountain", "FADE IN:"));
      await settle();
      expect(preview()).toBeNull();
      expect(destroyed).toHaveBeenCalledTimes(1);
    });
  });

  describe("its size and place", () => {
    // jsdom lays nothing out: the page gets the width the preview's measure
    // gives it, a shown preview a height, and the window a size.
    const width = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth");
    const rect = HTMLElement.prototype.getBoundingClientRect;
    beforeEach(() => {
      Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
        configurable: true,
        get(this: HTMLElement) {
          return this.classList.contains("note-page") ? 750 : 0;
        },
      });
      HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
        return this.classList.contains("link-preview") ? new DOMRect(0, 0, 675, 500) : rect.call(this);
      };
      window.innerHeight = 1000;
    });
    afterEach(() => {
      if (width) Object.defineProperty(HTMLElement.prototype, "offsetWidth", width);
      HTMLElement.prototype.getBoundingClientRect = rect;
      window.innerWidth = 1024;
      window.innerHeight = 768;
    });

    // The link's line, where reading view would draw it.
    const lineAt = (top: number, left = 300) =>
      Object.defineProperty(link(), "getClientRects", {
        configurable: true,
        value: () => [new DOMRect(left, top, 80, 20)],
      });

    const page = () => preview()?.querySelector<HTMLElement>(".note-page");

    it("shows at the preview's share of full size, laid out at its own measure", async () => {
      window.innerWidth = 1200;
      install();
      over(link());
      await vi.advanceTimersByTimeAsync(300);
      expect([page()?.style.zoom, page()?.style.width]).toEqual([String(PAGE_PREVIEW_SCALE), "750px"]);
    });

    it("shows smaller in a window too narrow for that share", async () => {
      window.innerWidth = 600;
      install();
      over(link());
      await vi.advanceTimersByTimeAsync(300);
      expect(page()?.style.zoom).toBe(asStyled("zoom", String(584 / 750)));
    });

    it("centres the page under the link, shifting it only to stay inside the window", async () => {
      window.innerWidth = 1200;
      install();
      lineAt(100, 500);
      over(link());
      await vi.advanceTimersByTimeAsync(300);
      expect(preview()?.style.left).toBe(`${540 - 675 / 2}px`);

      over(elsewhere);
      await vi.advanceTimersByTimeAsync(300);
      lineAt(100, 1100);
      over(link());
      await vi.advanceTimersByTimeAsync(300);
      expect(preview()?.style.left).toBe(`${1200 - 8 - 675}px`);
    });

    // The editing area binds the page on the left only: past its right
    // edge it may cover the side panel, out to the window's edge.
    it("stays right of the editing area's left edge, out to the window's right edge", async () => {
      window.innerWidth = 1200;
      install({ area: areaAt(700, 0, 500, 1000) });
      lineAt(100, 720);
      over(link());
      await vi.advanceTimersByTimeAsync(300);
      expect([preview()?.style.left, page()?.style.zoom]).toEqual(["708px", "0.75"]);
      expect(page()?.style.width).toBe(asStyled("width", `${(1200 - 8 - 708) / 0.75}px`));
    });

    // The chat's column, against the window's right edge: the page runs left
    // over what lies beside it, at its full share.
    it("runs left from the area's right edge for an area that runs that way", async () => {
      window.innerWidth = 1200;
      install({ area: areaAt(900, 0, 300, 1000), runs: "left" });
      lineAt(100, 1000);
      over(link());
      await vi.advanceTimersByTimeAsync(300);
      expect([preview()?.style.left, page()?.style.zoom]).toEqual([`${1200 - 8 - 675}px`, String(PAGE_PREVIEW_SCALE)]);
    });

    // Under the tabs and over the status bar: a link low in the area opens
    // its page above, never past the area's top.
    it("opens above a link low in the editing area, within its top", async () => {
      window.innerWidth = 1200;
      install({ area: areaAt(0, 40, 1200, 920) });
      lineAt(900);
      over(link());
      await vi.advanceTimersByTimeAsync(300);
      expect([preview()?.style.top, preview()?.style.bottom]).toEqual(["", `${1000 - 900 + 6}px`]);
      expect(page()?.style.maxHeight).toBe(`${(900 - 6 - 40 - 8) / (675 / 750)}px`);
    });

    it("opens below a link with room under it, within the area's bottom", async () => {
      window.innerWidth = 1200;
      install({ area: areaAt(0, 40, 1200, 920) });
      lineAt(100);
      over(link());
      await vi.advanceTimersByTimeAsync(300);
      expect([preview()?.style.top, preview()?.style.bottom]).toEqual([`${120 + 6}px`, ""]);
      expect(page()?.style.maxHeight).toBe(asStyled("max-height", `${(960 - 8 - 120 - 6) / (675 / 750)}px`));
    });
  });
});

// The link keeps a little room around its text, in rounded corners, and a
// link that wraps gets a hole per line.
describe("veilPath", () => {
  it("covers the area but for a rounded hole around each of the link's lines", () => {
    expect(veilPath(100, 50, [{ left: 10, top: 20, width: 30, height: 10 }])).toBe(
      'path(evenodd, "M0 0H100V50H0ZM11 17H39A4 4 0 0 1 43 21V29A4 4 0 0 1 39 33H11A4 4 0 0 1 7 29V21A4 4 0 0 1 11 17Z")',
    );
    const lines = [
      { left: 60, top: 10, width: 30, height: 18 },
      { left: 5, top: 30, width: 20, height: 18 },
    ];
    expect(veilPath(100, 50, lines).match(/M/g)).toHaveLength(3);
  });
});
