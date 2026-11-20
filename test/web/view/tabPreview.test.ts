// @vitest-environment jsdom
import { ViewPlugin } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FileResponse, TableFileResponse, TextFileResponse } from "../../../web/core/apiClient.ts";
import type { Disposable } from "../../../web/lib/disposable.ts";
import { installTooltips } from "../../../web/lib/tooltip.ts";
import { PAGE_PREVIEW_SCALE } from "../../../web/notePreview.ts";
import { createDialogService } from "../../../web/services/dialog.ts";
import { createFormats } from "../../../web/services/formats.ts";
import { installTabPreview, type TabPreviewDeps } from "../../../web/view/tabPreview.ts";
import { polyfillRangeRects } from "../support/codemirrorJsdom.ts";
import { asStyled } from "../support/styled.ts";

polyfillRangeRects();

function textFile(path: string, content: string, documentType: "note" | "screenplay" = "note"): TextFileResponse {
  return { kind: "text", path, revision: "r1", content, documentType, toolkits: [], classLinks: [] };
}

const deck: TableFileResponse = {
  kind: "table",
  path: "shots/deck.table.html",
  revision: "r1",
  version: "1.0",
  name: "Deck",
  columns: [{ id: "shot", label: "Shot", type: "text" }],
  rows: [{ values: { shot: "Wide" } }],
};

// A pill as the group's view draws it: its label and its ×, and the path of
// the file it previews unless it is the tab shown.
function buildPill(label: string, path?: string): HTMLButtonElement {
  const pill = document.createElement("button");
  pill.className = "editor-tab";
  const name = document.createElement("span");
  name.className = "editor-tab-label";
  name.textContent = label;
  const close = document.createElement("button");
  close.className = "icon-button editor-tab-close";
  close.setAttribute("aria-label", "Close");
  pill.append(name, close);
  if (path) pill.dataset.spacePath = path;
  else pill.classList.add("active");
  return pill;
}

const pointer = (type: string, target: Element, init: PointerEventInit = {}) =>
  target.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerType: "mouse", ...init }));
// As a browser moves the pointer onto it: an over, then a move.
const over = (target: Element, init: PointerEventInit = {}) => {
  pointer("pointerover", target, init);
  pointer("pointermove", target, init);
};
const preview = () => document.querySelector<HTMLElement>(".tab-preview");
const titleOf = () => preview()?.querySelector<HTMLInputElement>(".editor-title-input")?.value;
const pathOf = () => preview()?.querySelector<HTMLElement>(".tab-preview-path .path-label")?.dataset.path;

let host: HTMLElement;
let area: HTMLElement;
let shownTab: HTMLButtonElement;
let keeper: HTMLButtonElement;
let lamp: HTMLButtonElement;
let table: HTMLButtonElement;
let script: HTMLButtonElement;
let deps: TabPreviewDeps;
let installed: Disposable | undefined;

const file = (path: string): FileResponse => {
  if (path.endsWith(".table.html")) return deck;
  if (path.endsWith(".fountain")) return textFile(path, "INT. CELLAR - NIGHT", "screenplay");
  return textFile(path, `# ${path.endsWith("lamp.md") ? "Lamp" : "Keeper"}\n\nText.\n`);
};

function install(overrides: Partial<TabPreviewDeps> = {}): void {
  host = document.createElement("div");
  const strip = document.createElement("div");
  shownTab = buildPill("open");
  keeper = buildPill("keeper", "notes/keeper.md");
  lamp = buildPill("lamp", "notes/lamp.md");
  table = buildPill("deck", "shots/deck.table.html");
  script = buildPill("act", "story/act.fountain");
  strip.append(shownTab, keeper, lamp, table, script);
  host.append(strip);
  area = document.createElement("div");
  document.body.append(host, area);
  deps = {
    loadFile: vi.fn(async (path: string) => file(path)),
    readingResolvers: () => ({
      image: () => undefined,
      link: () => undefined,
      wikilink: () => undefined,
      wikilinkPending: () => false,
      hint: () => undefined,
    }),
    formats: createFormats(),
    dialog: createDialogService(),
    contextMenu: { open: vi.fn(), close: vi.fn(), isOpen: () => false },
    pathNames: { libraryName: () => undefined, icon: () => ({}) },
    areaOf: () => area,
    ...overrides,
  };
  installed = installTabPreview(host, deps);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});

afterEach(() => {
  installed?.dispose();
  installed = undefined;
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe("a tab's preview", () => {
  it("shows a tab's note once the pointer rests on its pill, with its path over the page", async () => {
    install();
    over(keeper.querySelector(".editor-tab-label") as HTMLElement);
    await vi.advanceTimersByTimeAsync(299);
    expect(preview()).toBeNull();

    await vi.advanceTimersByTimeAsync(1);
    expect(deps.loadFile).toHaveBeenCalledWith("notes/keeper.md");
    expect([titleOf(), pathOf()]).toEqual(["Keeper", "notes/keeper.md"]);
    expect(preview()?.getAttribute("aria-hidden")).toBe("true");
  });

  it("shows a Table's and a screenplay's tab on their own pages", async () => {
    install({ formats: watched().formats });
    over(table);
    await vi.advanceTimersByTimeAsync(300);
    expect(preview()?.querySelector(".table-page .editor-title-input")).toHaveProperty("value", "Deck");

    over(script);
    await vi.advanceTimersByTimeAsync(0);
    expect(preview()?.querySelector(".editor-page .cm-editor")).not.toBeNull();
    expect(pathOf()).toBe("story/act.fountain");
  });

  it("shows nothing for the tab shown, a pill naming no file a page draws, a press, or a touch", async () => {
    install();
    const flow = buildPill("story", "story.flow.html");
    host.firstElementChild?.append(flow);
    for (const target of [shownTab, flow]) {
      over(target);
      await vi.advanceTimersByTimeAsync(1000);
    }
    over(keeper, { buttons: 1 });
    await vi.advanceTimersByTimeAsync(1000);
    over(lamp, { pointerType: "touch" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(deps.loadFile).not.toHaveBeenCalled();
    expect(preview()).toBeNull();
  });

  // A pill redrawn under a pointer left resting, or scrolled under it, gets
  // an over and no move.
  it("waits on a pointer that moves, never on a pill that came under a still one", async () => {
    install();
    pointer("pointerover", keeper);
    await vi.advanceTimersByTimeAsync(1000);
    expect(deps.loadFile).not.toHaveBeenCalled();
  });

  it("goes as the pointer leaves the strip, or moves onto a pill naming no file", async () => {
    install();
    over(keeper);
    await vi.advanceTimersByTimeAsync(300);
    pointer("pointerleave", host, { bubbles: false });
    expect(preview()).toBeNull();

    over(keeper);
    await vi.advanceTimersByTimeAsync(300);
    over(shownTab);
    expect(preview()).toBeNull();
  });

  // The page takes no pointer, so moving down onto it is moving onto what
  // lies under it.
  it("goes as the pointer arrives anywhere off the strip", async () => {
    install();
    over(keeper);
    await vi.advanceTimersByTimeAsync(300);
    over(area);
    expect(preview()).toBeNull();
  });

  it("shows the next pill's page at once while the pointer stays on the strip", async () => {
    let land: (file: FileResponse) => void = () => {};
    install();
    over(keeper);
    await vi.advanceTimersByTimeAsync(300);
    vi.mocked(deps.loadFile).mockImplementationOnce(() => new Promise<FileResponse>((resolve) => (land = resolve)));

    over(lamp);
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.loadFile).toHaveBeenLastCalledWith("notes/lamp.md");
    // The page shown stays until the next is read.
    expect(titleOf()).toBe("Keeper");
    land(file("notes/lamp.md"));
    await vi.advanceTimersByTimeAsync(0);
    expect([titleOf(), pathOf()]).toEqual(["Lamp", "notes/lamp.md"]);
    expect(document.querySelectorAll(".tab-preview")).toHaveLength(1);

    // Crossing the tab shown takes the page down, and the next shows at once.
    over(shownTab);
    over(keeper);
    await vi.advanceTimersByTimeAsync(0);
    expect(titleOf()).toBe("Keeper");
  });

  it("waits again once the pointer left the strip, or a press, a key or a wheel took the page down", async () => {
    install();
    const leave = () => pointer("pointerleave", host, { bubbles: false });
    const press = () => pointer("pointerdown", document.body);
    const key = () => document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
    const wheel = () => host.dispatchEvent(new WheelEvent("wheel", { bubbles: true }));
    for (const takeDown of [leave, press, key, wheel]) {
      over(keeper);
      await vi.advanceTimersByTimeAsync(300);
      takeDown();
      expect(preview()).toBeNull();

      over(lamp);
      await vi.advanceTimersByTimeAsync(299);
      expect(preview()).toBeNull();
      await vi.advanceTimersByTimeAsync(1);
      expect(titleOf()).toBe("Lamp");
      leave();
    }
  });

  it("drops a file read after the pointer moved on", async () => {
    let land: (file: FileResponse) => void = () => {};
    install({ loadFile: vi.fn(() => new Promise<FileResponse>((resolve) => (land = resolve))) });
    over(keeper);
    await vi.advanceTimersByTimeAsync(300);
    over(shownTab);
    land(file("notes/keeper.md"));
    await vi.advanceTimersByTimeAsync(0);
    expect(preview()).toBeNull();
  });

  // A switch that kept the pointer where it was: the tab is now on screen.
  it("goes when its tab becomes the one shown", async () => {
    install();
    over(keeper);
    await vi.advanceTimersByTimeAsync(300);
    keeper.classList.add("active");
    delete keeper.dataset.spacePath;
    await vi.advanceTimersByTimeAsync(0);
    expect(preview()).toBeNull();
  });

  it("lets go of a screenplay's editor when its page goes", async () => {
    const { formats, destroyed } = watched();
    install({ formats });
    over(script);
    await vi.advanceTimersByTimeAsync(300);
    pointer("pointerleave", host, { bubbles: false });
    expect(destroyed).toHaveBeenCalledTimes(1);
  });

  it("keeps the ×'s tooltip off a page that shows", async () => {
    const tooltips = installTooltips();
    try {
      install();
      over(keeper);
      await vi.advanceTimersByTimeAsync(300);
      over(keeper.querySelector(".editor-tab-close") as HTMLElement);
      await vi.advanceTimersByTimeAsync(1000);
      expect(preview()).not.toBeNull();
      expect(document.querySelector<HTMLElement>("#tooltip")?.hidden).toBe(true);
    } finally {
      tooltips.dispose();
    }
  });

  describe("its size and place", () => {
    // jsdom lays nothing out: the page gets the width the preview's measure
    // gives it, the box the room its path line takes, and the window a size.
    const sizes = ["offsetWidth", "offsetHeight"].map(
      (name) => [name, Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)] as const,
    );
    beforeEach(() => {
      Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
        configurable: true,
        get(this: HTMLElement) {
          return this.classList.contains("note-page") ? 750 : 0;
        },
      });
      Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
        configurable: true,
        get(this: HTMLElement) {
          if (this.classList.contains("tab-preview")) return 1030;
          return this.classList.contains("note-page") ? 1000 : 0;
        },
      });
      window.innerWidth = 1200;
      window.innerHeight = 800;
    });
    afterEach(() => {
      for (const [name, descriptor] of sizes)
        if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor);
      window.innerWidth = 1024;
      window.innerHeight = 768;
    });

    const at = (element: Element, left: number, top: number, width: number, height: number) => {
      element.getBoundingClientRect = () => new DOMRect(left, top, width, height);
    };
    const page = () => preview()?.querySelector<HTMLElement>(".note-page");

    it("centres the page under the pill at its share of full size, within its group's area", async () => {
      install();
      at(area, 0, 40, 1200, 760);
      at(keeper, 400, 0, 160, 40);
      over(keeper);
      await vi.advanceTimersByTimeAsync(300);
      expect([preview()?.style.left, preview()?.style.top]).toEqual([`${480 - 675 / 2}px`, "46px"]);
      expect([preview()?.style.width, page()?.style.zoom]).toEqual(["675px", String(PAGE_PREVIEW_SCALE)]);
      // The path line's 30px comes out of the room under the pill.
      expect(page()?.style.maxHeight).toBe(asStyled("max-height", `${(800 - 8 - 46 - 30) / PAGE_PREVIEW_SCALE}px`));
    });

    // The other group's pill: never left of its group, out to the window's
    // right edge.
    it("stays right of its group's left edge, shifting only to stay inside the window", async () => {
      install();
      at(area, 600, 40, 600, 760);
      at(keeper, 610, 0, 160, 40);
      over(keeper);
      await vi.advanceTimersByTimeAsync(300);
      expect([preview()?.style.left, preview()?.style.width]).toEqual(["608px", "584px"]);
      expect(page()?.style.zoom).toBe(asStyled("zoom", String(584 / 750)));
    });
  });
});

// A screenplay format whose editor says when it is destroyed.
function watched() {
  const destroyed = vi.fn();
  const formats = createFormats();
  formats.register("screenplay", {
    extensions: () => ViewPlugin.define(() => ({ destroy: destroyed })),
    links: () => ({ found: [], missing: [] }),
    embedsImages: false,
  });
  return { formats, destroyed };
}
