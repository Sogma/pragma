// @vitest-environment jsdom
import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  FileResponse,
  FolderEntry,
  FolderOrder,
  LibraryRow,
  TableFileResponse,
  TextFileResponse,
} from "../../../../web/core/apiClient.ts";
import { setLibraryPermissions } from "../../../../web/core/libraries.ts";
import { noteDragInFlight } from "../../../../web/core/paths.ts";
import { refresh as refreshSpaceTree } from "../../../../web/core/spaceTree.ts";
import { PREVIEW_PAGE_MENU } from "../../../../web/filePreview.ts";
import type { NamingSurface } from "../../../../web/lib/inlineEdit.ts";
import { PAGE_PREVIEW_SCALE, pageZoom } from "../../../../web/notePreview.ts";
import { type CommandContext, createCommands } from "../../../../web/services/commands.ts";
import { createDialogService } from "../../../../web/services/dialog.ts";
import { setLocalSort } from "../../../../web/services/folderSorts.ts";
import { createFormats } from "../../../../web/services/formats.ts";
import { createMenus } from "../../../../web/services/menus.ts";
import type { ThumbnailRenderer } from "../../../../web/services/thumbnails.ts";
import { MEDIA_MENU } from "../../../../web/services/videoMenu.ts";
import {
  createGalleryPane,
  type GalleryPane,
  type GalleryPaneDeps,
  galleryFolderOf,
  galleryMenu,
  galleryPane,
  gridLayout,
  isGalleryPane,
  parentFolder,
  parseGalleryTileSize,
  visibleRange,
} from "../../../../web/view/panes/galleryPane.ts";
import { polyfillRangeRects } from "../../support/codemirrorJsdom.ts";
import { memoryViews } from "../../support/editorLayout.ts";
import { testFormats } from "../../support/formats.ts";

polyfillRangeRects();

vi.mock("../../../../web/services/folderSorts.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../web/services/folderSorts.ts")>()),
  setLocalSort: vi.fn(async () => undefined),
}));

globalThis.ResizeObserver ??= class {
  observe() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;
// jsdom decodes nothing: a picture counts as decoded once it has loaded.
HTMLImageElement.prototype.decode ??= () => Promise.resolve();
// Nor plays anything: a clip's play answers as a browser's does, settled.
HTMLMediaElement.prototype.play = () => Promise.resolve();

function file(name: string, extra: Partial<FolderEntry> = {}): FolderEntry {
  return {
    name,
    path: `lib:footage/${name}`,
    type: "file",
    size: 100,
    modified: "2026-09-01T10:00:00.000Z",
    version: "1-100",
    thumbnail: false,
    ...extra,
  };
}

function folder(name: string): FolderEntry {
  return { ...file(name), type: "directory", size: 0 };
}

const BY_NAME: FolderOrder = { default: { by: "name", order: "asc" } };
const MANUAL: FolderOrder = { default: { by: "name", order: "asc" }, local: { by: "manual" } };

// A setting the test can change, firing on subscribe as the real ones do.
function setting<T>(initial: T) {
  let value = initial;
  const listeners = new Set<(value: T) => void>();
  return {
    get: () => value,
    set(next: T) {
      value = next;
      for (const listener of listeners) listener(next);
    },
    subscribe(listener: (value: T) => void) {
      listeners.add(listener);
      listener(value);
      return () => listeners.delete(listener);
    },
  };
}

function renderer(
  result = () =>
    Promise.resolve({ image: new Blob(["thumb"], { type: "image/webp" }), width: 4000, height: 3000, duration: 7 }),
) {
  const cancel = vi.fn<() => void>();
  const render = vi.fn<ThumbnailRenderer["render"]>(() => ({ result: result(), cancel }));
  return { cancel, render };
}

// A note as the document route sends it.
function textFile(path: string, content: string): TextFileResponse {
  return { kind: "text", path, revision: "r1", content, documentType: "note", toolkits: [], classLinks: [] };
}

// A ProRes clip's header, as the host reads it for a clip no browser here decodes.
const proresDetails = {
  codec: "ProRes 4444 XQ",
  frameRate: 30_000 / 1001,
  variableFrameRate: false,
  bitDepth: 12,
  hdr: null,
  alpha: false,
  audio: null,
  startTimecode: "01:00:00:00",
};

// jsdom lays nothing out: the scroll region gets the box a real one would.
function setup(listing: FolderEntry[], overrides: Partial<GalleryPaneDeps> = {}) {
  const deps: GalleryPaneDeps = {
    listFolder: vi.fn(async () => ({ entries: listing, order: BY_NAME })),
    thumbnailUrl: (path) => `/thumb?path=${path}`,
    rawFileUrl: (path) => `/raw?path=${path}`,
    fetchFile: vi.fn(
      async () =>
        new Response('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2412 1137.4"><path d="M0 0h1v1z"/></svg>'),
    ),
    videoFormat: vi.fn(async () => ({
      ...proresDetails,
      codec: "H.264",
      frameRate: 24_000 / 1001,
      bitDepth: 8,
      startTimecode: null,
      width: null,
      height: null,
      duration: null,
    })),
    pixelFormat: vi.fn(async () => ({ colorModel: "rgb" as const, alpha: true, bitDepth: 8, sourceType: null })),
    fileInfo: vi.fn(async (path: string) => ({ kind: "file" as const, name: path, size: 1, modified: "" })),
    clipFacts: vi.fn(async () => ({ width: 1188, height: 2112, duration: 26.8, clip: proresDetails })),
    loadFile: vi.fn(async (path: string) => textFile(path, "# A note\n\nIts text.\n")),
    readingResolvers: vi.fn(() => ({
      image: () => undefined,
      link: () => undefined,
      wikilink: () => undefined,
      wikilinkPending: () => false,
      hint: () => undefined,
    })),
    formats: createFormats(),
    renderer: renderer(),
    openEntry: vi.fn(),
    openPath: vi.fn(),
    openFolder: vi.fn(),
    openMenu: vi.fn(),
    contextMenu: { open: vi.fn(), close: vi.fn(), isOpen: () => false },
    dialog: createDialogService(),
    showExtensions: setting(false),
    readableLineLength: setting(true),
    videoLoop: setting(false),
    videoVolume: setting({ level: 1, muted: false }),
    views: memoryViews().views,
    tileSize: setting("medium"),
    setLayout: vi.fn(async () => undefined),
    onRendered: vi.fn(),
    reportReadout: vi.fn(),
    ...overrides,
  };
  const pane = createGalleryPane(deps);
  document.body.append(pane.element);
  const scroller = pane.element.querySelector(".gallery-scroll") as HTMLElement;
  Object.defineProperty(scroller, "clientWidth", { value: 600, configurable: true });
  Object.defineProperty(scroller, "clientHeight", { value: 400, configurable: true });
  return { pane, deps, scroller };
}

const current = { isCurrent: () => true };
const open = (pane: GalleryPane, path = "lib:footage") => pane.setInput({ kind: "gallery", path }, current);
const tiles = (pane: GalleryPane) => [...pane.element.querySelectorAll<HTMLElement>(".gallery-tile")];
const tileNamed = (pane: GalleryPane, name: string) =>
  tiles(pane).find((tile) => tile.querySelector(".gallery-tile-name")?.textContent === name) as HTMLElement;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const fieldOf = (pane: GalleryPane) => pane.element.querySelector<HTMLInputElement>(".gallery-tile-field");
const press = (target: HTMLElement, key: string) =>
  target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));

// The surface a tile's menu hands the tree's commands, as a right-click on
// that tile passes it.
function namingOf(pane: GalleryPane, deps: GalleryPaneDeps, name: string): NamingSurface {
  tileNamed(pane, name).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  const tile = vi.mocked(deps.openMenu).mock.lastCall?.[1];
  if (!tile) throw new Error(`no menu opened on ${name}`);
  return tile.naming;
}

beforeEach(() => {
  URL.createObjectURL = vi.fn(() => "blob:made");
  URL.revokeObjectURL = vi.fn();
});

// A close or an open by click leaves the window taking the rest of its
// double-click until a press starts a new run, which the next test would
// otherwise start in.
afterEach(() => {
  window.dispatchEvent(new MouseEvent("mousedown", { detail: 1 }));
  document.body.replaceChildren();
});

describe("layout", () => {
  it("reads an unknown stored tile size as the default", () => {
    expect(parseGalleryTileSize("huge")).toBe("medium");
    expect(parseGalleryTileSize("large")).toBe("large");
  });

  // The columns that fit at the narrowest tile are widened to fill the row.
  it("fits whole columns and widens them to the row", () => {
    const layout = gridLayout(600, 10, 168);
    expect(layout.columns).toBe(3);
    expect(layout.tile * 3 + 12 * 2).toBeLessThanOrEqual(568);
    expect(layout.tile).toBeGreaterThanOrEqual(168);
    expect(gridLayout(100, 10, 168).columns).toBe(1);
    expect(gridLayout(600, 0, 168).height).toBe(0);
  });

  it("draws the rows on screen and two more beyond each edge", () => {
    const layout = gridLayout(600, 300, 168);
    expect(visibleRange(layout, 0, 400, 300)).toEqual({ start: 0, end: 15 });
    // Scrolled so row 50's top meets the viewport's: rows 48 and 49 above it.
    const far = visibleRange(layout, 16 + layout.rowHeight * 50, 400, 300);
    expect(far.start).toBe(48 * 3);
    expect(visibleRange(layout, 0, 400, 4)).toEqual({ start: 0, end: 4 });
  });

  it("names the folder above, in the same root, up to the root itself", () => {
    expect(parentFolder("lib:footage/day 1/a")).toBe("lib:footage/day 1");
    expect(parentFolder("lib:footage/day 1")).toBe("lib:footage");
    expect(parentFolder("lib:footage")).toBeUndefined();
    expect(parentFolder("stills")).toBe("");
    expect(parentFolder("")).toBeUndefined();
  });
});

// Open as gallery is offered on a folder wherever one is listed or a Flow
// chip names one, and on a library's own row; never on a file, a missing
// library, or another list.
describe("what a menu opens as a gallery", () => {
  const directory = { type: "directory", path: "day 1" };
  it("reads a folder from each menu's argument", () => {
    expect(galleryFolderOf({ node: directory })).toBe("day 1");
    expect(galleryFolderOf({ node: null })).toBe("");
    expect(galleryFolderOf({ libraryId: "footage", node: directory, writable: false })).toBe("lib:footage/day 1");
    expect(galleryFolderOf({ kind: "library", id: "footage", missing: false })).toBe("lib:footage");
    expect(galleryFolderOf({ folder: "day 1" })).toBe("day 1");
    expect(galleryFolderOf({ folder: "" })).toBe("");
  });

  it("names nothing for a file, a missing library or another row", () => {
    expect(galleryFolderOf({ node: { type: "file", path: "a.png" } })).toBeUndefined();
    expect(galleryFolderOf({ file: "a.png" })).toBeUndefined();
    expect(galleryFolderOf({ kind: "library", id: "footage", missing: true })).toBeUndefined();
    expect(galleryFolderOf({ kind: "site", path: "site" })).toBeUndefined();
    expect(galleryFolderOf({ libraryId: "footage", node: null })).toBeUndefined();
    expect(galleryFolderOf(undefined)).toBeUndefined();
  });
});

// A folder's Open is its row's Open button, in the focused tab's place; the
// other two carry a file row's labels.
describe("a folder's open commands", () => {
  function wired() {
    const commands = createCommands();
    const menus = createMenus(commands);
    const tabs = {
      openEntry: vi.fn(),
      openFolder: vi.fn(),
      openFolderToSide: vi.fn(),
      openSpacePath: vi.fn(),
    };
    galleryPane({
      commands,
      menus,
      contextMenu: { open: vi.fn(), close: vi.fn(), isOpen: () => false },
      tabs: () => tabs,
      dialog: vi.fn(),
      formats: createFormats(),
    });
    menus.register("folder", [
      { command: "gallery.openFolder", group: "open" },
      { command: "gallery.openFolderInNewTab", group: "open" },
      { command: "gallery.openFolderToSide", group: "open" },
    ]);
    return { commands, menus, tabs };
  }
  const context: CommandContext = { tab: { kind: "empty" }, pane: undefined };
  const target = { libraryId: "footage", node: { type: "directory", path: "day 1" } };

  it("opens a gallery in place, in a new tab or to the side", async () => {
    const { commands, menus, tabs } = wired();
    expect(menus.resolve("folder", context, target).map((item) => item.label)).toEqual([
      "Open",
      "Open in new tab",
      "Open to the side",
    ]);
    await commands.run("gallery.openFolder", context, target);
    expect(tabs.openFolder).toHaveBeenLastCalledWith("lib:footage/day 1");
    await commands.run("gallery.openFolderInNewTab", context, target);
    expect(tabs.openFolder).toHaveBeenLastCalledWith("lib:footage/day 1", true);
    await commands.run("gallery.openFolderToSide", context, { node: null });
    expect(tabs.openFolderToSide).toHaveBeenCalledWith("");
  });

  it("offers none on a file", () => {
    const { menus } = wired();
    expect(menus.resolve("folder", context, { node: { type: "file", path: "a.png" } })).toEqual([]);
  });
});

// The folder's own Sort by, the one its tree row opens.
describe("the toolbar's Sort by", () => {
  it("checks the sort the folder shows, marks its own, and offers no default in a library", async () => {
    const commands = createCommands();
    const menus = createMenus(commands);
    const tabs = {
      openEntry: vi.fn(),
      openFolder: vi.fn(),
      openFolderToSide: vi.fn(),
      openSpacePath: vi.fn(),
    };
    galleryPane({
      commands,
      menus,
      contextMenu: { open: vi.fn(), close: vi.fn(), isOpen: () => false },
      tabs: () => tabs,
      dialog: vi.fn(),
      formats: createFormats(),
    });
    const order: FolderOrder = {
      default: { by: "name", order: "asc" },
      local: { by: "modified", order: "desc" },
    };
    const { pane } = setup([], { listFolder: vi.fn(async () => ({ entries: [file("a.png")], order })) });
    await open(pane);

    const context: CommandContext = { tab: { kind: "gallery", path: "lib:footage" }, pane };
    // Its layout and tile size are the chrome's Layout menu, from the pane.
    expect(menus.resolve("editor.toolbar", context).map((item) => item.label)).toEqual(["Sort by"]);
    const sortBy = menus.resolve("editor.toolbar", context).find((item) => item.label === "Sort by");
    expect(sortBy?.submenu?.map(({ label, checked, mark, direction }) => [label, checked, mark, direction])).toEqual([
      ["Name", false, "Default sort for this folder", undefined],
      ["Date created", false, undefined, undefined],
      ["Date modified", true, undefined, "descending"],
      ["Size", false, undefined, undefined],
      ["Manual order", false, undefined, undefined],
      ["Property…", false, undefined, undefined],
    ]);
  });
});

// A tile's menu is the one its tree row opens, under the argument that row
// passes, so each item answers for the entry exactly as in the tree.
describe("what a right-click opens", () => {
  const naming: NamingSurface = { rename: vi.fn(), create: vi.fn() };

  it("opens the toolbar's menu around the tiles", () => {
    expect(galleryMenu()).toEqual({ menu: "editor.toolbar", ariaLabel: "More options" });
  });

  it("opens a library row's menu on a library's tile, with the library's permission", () => {
    const entry = file("a.png", { path: "lib:footage/day 1/a.png" });
    expect(galleryMenu({ entry, naming })).toEqual({
      menu: "libraryTree",
      arg: {
        libraryId: "footage",
        node: { name: "a.png", path: "day 1/a.png", type: "file" },
        writable: false,
        naming,
      },
      ariaLabel: "Library actions",
    });
    setLibraryPermissions([{ id: "footage", label: "Footage", access: "read-write" } as LibraryRow]);
    expect(galleryMenu({ entry, naming }).arg).toMatchObject({ writable: true });
    setLibraryPermissions([]);
  });

  it("opens a space row's menu on a space tile", () => {
    const entry = folder("day 1");
    entry.path = "scenes/day 1";
    expect(galleryMenu({ entry, naming })).toEqual({
      menu: "tree",
      arg: { node: { name: "day 1", path: "scenes/day 1", type: "directory" }, naming },
      ariaLabel: "Tree actions",
    });
  });
});

// A folder's cards: the same grid and the same tiles' handling, an index card
// in place of each square.
describe("cards", () => {
  const cardsOf = (entries: FolderEntry[]) =>
    vi.fn(async () => ({ entries, order: BY_NAME, layout: "cards" as const }));

  it("draws a folder that shows cards as cards, each name over its description", async () => {
    const listing = [file("a.png"), file("Cold Open.fountain", { description: "A squall tears the shutters off." })];
    const { pane, deps } = setup([], { listFolder: cardsOf(listing) });
    await open(pane);
    expect(tiles(pane).map((tile) => tile.classList.contains("is-card"))).toEqual([true, true]);
    expect(tiles(pane).map((tile) => tile.querySelector(".gallery-card-description")?.textContent)).toEqual([
      undefined,
      "A squall tears the shutters off.",
    ]);
    expect(tileNamed(pane, "Cold Open").querySelector(".gallery-card-icon")?.getAttribute("data-entry-icon")).toBe(
      "fountain",
    );
    // A card is for what an entry says: no picture is made for it.
    expect(deps.renderer.render).not.toHaveBeenCalled();
  });

  it("shows a note's opening where it has no description, marked as an excerpt", async () => {
    const listing = [
      file("Cold Open.fountain", { description: "A squall tears the shutters off." }),
      file("Plan.md", { excerpt: "Open on the storm.\nThen the house." }),
    ];
    const { pane } = setup([], { listFolder: cardsOf(listing) });
    await open(pane);
    const texts = tiles(pane).map((tile) => tile.querySelector(".gallery-card-description"));
    expect(texts.map((text) => text?.textContent)).toEqual([
      "A squall tears the shutters off.",
      "Open on the storm.\nThen the house.",
    ]);
    expect(texts.map((text) => text?.classList.contains("is-excerpt"))).toEqual([false, true]);
  });

  it("names a card on the card, in its head", async () => {
    const { pane, deps } = setup([], { listFolder: cardsOf([file("Cold Open.fountain")]) });
    await open(pane);
    const submit = vi.fn();
    namingOf(pane, deps, "Cold Open").rename("lib:footage/Cold Open.fountain", submit);
    const field = fieldOf(pane);
    expect(field?.parentElement?.classList.contains("gallery-card-head")).toBe(true);
    press(field as HTMLElement, "Escape");
    expect(fieldOf(pane)).toBeNull();
    expect(tileNamed(pane, "Cold Open").querySelector(".gallery-card-head .gallery-tile-name")).not.toBeNull();
    expect(submit).not.toHaveBeenCalled();
  });

  it("offers each tile size and cards as the folder's layout, checking the one it shows", async () => {
    const tileSize = setting("large");
    const { pane } = setup([file("a.png")], { tileSize });
    await open(pane);
    expect(pane.layout?.available().map(({ label, group }) => [label, group])).toEqual([
      ["Small tiles", "tiles"],
      ["Medium tiles", "tiles"],
      ["Large tiles", "tiles"],
      ["Cards", "cards"],
    ]);
    expect(pane.layout?.current()).toBe("tiles-large");

    const cards = setup([], { listFolder: cardsOf([file("a.png")]), tileSize });
    await open(cards.pane);
    expect(cards.pane.layout?.current()).toBe("cards");
  });

  it("keeps cards with the folder and lists it again, and a tile size sets every folder's", async () => {
    const tileSize = setting("medium");
    const listFolder = cardsOf([file("a.png")]);
    const { pane, deps } = setup([], { listFolder, tileSize });
    await open(pane);

    pane.layout?.set("tiles-small");
    expect(tileSize.get()).toBe("small");
    expect(deps.setLayout).toHaveBeenCalledWith("lib:footage", "tiles");
    listFolder.mockResolvedValue({ entries: [file("a.png")], order: BY_NAME } as never);
    await settle();
    expect(tiles(pane).some((tile) => tile.classList.contains("is-card"))).toBe(false);

    vi.mocked(deps.setLayout).mockClear();
    pane.layout?.set("tiles-large");
    expect(deps.setLayout).not.toHaveBeenCalled();
    pane.layout?.set("cards");
    expect(deps.setLayout).toHaveBeenCalledWith("lib:footage", "cards");
  });
});

describe("the gallery pane", () => {
  it("is a gallery pane", () => {
    expect(isGalleryPane(setup([]).pane)).toBe(true);
  });

  it("lists the folder and draws only the tiles near the screen", async () => {
    const listing = Array.from({ length: 300 }, (_, index) => file(`still ${index}.png`));
    const { pane, deps } = setup(listing);
    await open(pane);

    expect(deps.listFolder).toHaveBeenCalledWith("lib:footage");
    expect(tiles(pane)).toHaveLength(15);
    expect(deps.reportReadout).toHaveBeenLastCalledWith("300 files");
    const canvas = pane.element.querySelector(".gallery-canvas") as HTMLElement;
    expect(Number.parseInt(canvas.style.height, 10)).toBe(gridLayout(600, 300, 168).height);
  });

  // The listing says which the host holds: those are asked for, the rest
  // made here at once, with no request that could only miss.
  it("asks the host for the thumbnails it holds and makes the rest", async () => {
    const { pane, deps } = setup([
      file("held.png", { version: "7-42", thumbnail: true }),
      file("new.png", { version: "8-1" }),
      file("take.mp4"),
      file("notes.md"),
    ]);
    await open(pane);
    await settle();

    const held = tileNamed(pane, "held").querySelector("img") as HTMLImageElement;
    expect(held.getAttribute("src")).toBe("/thumb?path=lib:footage/held.png&v=7-42");
    const made = tileNamed(pane, "new").querySelector("img") as HTMLImageElement;
    expect(made.getAttribute("src")).toBe("blob:made");
    expect(deps.renderer.render).toHaveBeenCalledWith({ path: "lib:footage/new.png", version: "8-1", kind: "image" });
    expect(deps.renderer.render).toHaveBeenCalledWith(expect.objectContaining({ kind: "video" }));
    expect(deps.renderer.render).not.toHaveBeenCalledWith(expect.objectContaining({ path: "lib:footage/held.png" }));

    // One the listing promised and the host has since lost is made too.
    held.dispatchEvent(new Event("error"));
    await settle();
    expect(deps.renderer.render).toHaveBeenCalledWith({ path: "lib:footage/held.png", version: "7-42", kind: "image" });
    expect(held.getAttribute("src")).toBe("blob:made");

    expect(tileNamed(pane, "take").querySelector(".gallery-tile-badge")).not.toBeNull();
    expect(tileNamed(pane, "notes").querySelector("img")).toBeNull();
    expect(tileNamed(pane, "notes").querySelector<HTMLElement>(".gallery-tile-icon")?.dataset.entryIcon).toBe(
      "markdown",
    );
  });

  // A clip the browser can't decode gets its facts from the host instead,
  // which fill its bars; a picture, or a clip listed with its facts, asks nothing.
  it("asks the host for a clip's header facts when its thumbnail can't be made", async () => {
    const failing = renderer(() => Promise.reject(new Error("This browser can't play this video's format")));
    const known = { clip: proresDetails, width: 1188, height: 2112, duration: 26.8 };
    const { pane, deps } = setup([file("take.mov"), file("still.png"), file("known.mov", known)], {
      renderer: failing,
    });
    await open(pane);
    await settle();

    expect(deps.clipFacts).toHaveBeenCalledOnce();
    expect(deps.clipFacts).toHaveBeenCalledWith("lib:footage/take.mov", "1-100");
    const take = tileNamed(pane, "take");
    expect(take.classList.contains("no-thumbnail")).toBe(true);
    await vi.waitFor(() => expect(take.textContent).toContain("1188 × 2112"));
    expect(take.textContent).toContain("29.97 fps");
    expect(tileNamed(pane, "still").textContent).not.toContain("×");
  });

  // The space tree is what knows a folder's site and scope, so it is listed
  // for real here, and emptied again after.
  it("draws a folder tile's icon as the tree does: a site's globe, a scope's folder", async () => {
    // The tree, and the path listing it comes with, whose scopes a tab's
    // context is read from.
    const listing = async (tree: unknown[]) => {
      const paths = { files: [], folders: [], scopes: [] };
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async (url: string) =>
            new Response(JSON.stringify(url.includes("/api/space/paths") ? paths : tree), { status: 200 }),
        ),
      );
      await refreshSpaceTree();
      vi.unstubAllGlobals();
    };
    await listing([
      { name: "blog", path: "blog", type: "directory", children: [], site: { name: "Blog" } },
      { name: "drafts", path: "drafts", type: "directory", children: [] },
      {
        name: "world",
        path: "world",
        type: "directory",
        children: [{ name: "README.md", path: "world/README.md", type: "file", opensScope: true }],
      },
    ]);
    try {
      const { pane } = setup(["blog", "drafts", "world"].map((name) => ({ ...folder(name), path: name })));
      await open(pane, "");
      await settle();

      const icons = tiles(pane).map((tile) => {
        const icon = tile.querySelector<HTMLElement>(".gallery-tile-icon");
        return [tile.dataset.tooltip, icon?.dataset.entryIcon, icon?.hasAttribute("data-scope")];
      });
      expect(icons).toEqual([
        ["blog", "site", false],
        ["drafts", "folder", false],
        ["world", "folder", true],
      ]);
    } finally {
      await listing([]);
    }
  });

  // The bars sit on the square's own edges; the top one waits for the
  // file's dimensions, which the host lists or this browser learns. A
  // still's scale waits for the pointer, as the square follows the pane.
  it("shows a file's dimensions, ratio and size, a clip's duration and frame rate, a still's scale", async () => {
    const { pane } = setup([
      file("held.png", { thumbnail: true, width: 3840, height: 2160, size: 4_404_019 }),
      file("take.mp4", { size: 2048 }),
      file("known.mov", {
        thumbnail: true,
        width: 1188,
        height: 2112,
        duration: 26.8,
        size: 2048,
        clip: proresDetails,
      }),
      file("notes.md"),
    ]);
    await open(pane);
    const bars = (name: string) =>
      [...tileNamed(pane, name).querySelectorAll<HTMLElement>(".thumbnail-hud-bar")].map((bar) =>
        bar.hidden ? "(hidden)" : [...bar.children].map((cell) => cell.textContent).join(" | "),
      );

    expect(bars("held")).toEqual(["3840 × 2160 (16:9) |  |  | 16:9", " | 4.2 MB"]);
    // jsdom lays nothing out: the square gets the inside a 194px tile's has.
    for (const name of ["held", "known"]) {
      const square = tileNamed(pane, name).querySelector(".gallery-tile-frame") as HTMLElement;
      Object.defineProperties(square, { clientWidth: { value: 192 }, clientHeight: { value: 192 } });
      tileNamed(pane, name).dispatchEvent(new Event("pointerenter"));
    }
    expect(bars("held")[0]).toBe("3840 × 2160 (16:9) |  | 5% | 16:9");
    expect(bars("known")).toEqual(["1188 × 2112 (9:16) | 29.97 fps |  | 9:16", "0:26 | 2.0 KB"]);
    await settle();
    expect(bars("take")).toEqual(["4000 × 3000 (4:3) |  |  | 4:3", "0:07 | 2.0 KB"]);
    expect(tileNamed(pane, "notes").querySelector(".thumbnail-hud")).toBeNull();

    tileNamed(pane, "take").click();
    expect(pane.inspector?.textContent).toContain("4000 × 3000px (4:3)");
    expect(pane.inspector?.textContent).toContain("0:07");
  });

  // The Info section's rows, by label, in order.
  const infoRows = (pane: GalleryPane) =>
    Object.fromEntries(
      [...(pane.inspector?.querySelectorAll(".meta-row") ?? [])].map((row) => [
        row.querySelector(".meta-key")?.textContent,
        row.querySelector(".meta-value")?.textContent,
      ]),
    );

  // What the host read of the header, listed with the entry, goes in the Info
  // tab as the video and image tabs word it.
  it("lists a clip's and a picture's header details in the Info tab", async () => {
    const { pane, deps } = setup([
      file("take.mov", { thumbnail: false, width: 1188, height: 2112, duration: 26.8, clip: proresDetails }),
      file("still.png", {
        thumbnail: true,
        width: 1024,
        height: 1024,
        picture: { sourceType: "trainedAlgorithmicMedia", pixels: { colorModel: "rgb", alpha: true, bitDepth: 16 } },
      }),
    ]);
    await open(pane);
    await settle();

    const title = () => pane.inspector?.querySelector(".inspector-section-title")?.textContent;
    tileNamed(pane, "take").click();
    expect(title()).toBe("Selected Video");
    const take = pane.inspector?.textContent ?? "";
    for (const text of ["29.97 fps", "ProRes 4444 XQ", "12 bits per channel", "SDR", "None", "01:00:00:00"]) {
      expect(take).toContain(text);
    }
    pane.dismissTransient?.();
    tileNamed(pane, "still").click();
    expect(title()).toBe("Selected Image");
    // In the image tab's order and words, from what the listing holds.
    expect(infoRows(pane)).toEqual({
      Name: "still.png",
      Dimensions: "1024 × 1024px (1:1)",
      "Color mode": "RGBA",
      "Bit depth": "16 bits per channel",
      Source: "Made by AI",
      Size: expect.any(String),
      Modified: expect.any(String),
    });
    expect(Object.keys(infoRows(pane))).toEqual([
      "Name",
      "Dimensions",
      "Color mode",
      "Bit depth",
      "Source",
      "Size",
      "Modified",
    ]);
    expect(deps.pixelFormat).not.toHaveBeenCalled();
    expect(deps.fileInfo).not.toHaveBeenCalled();
  });

  // A thumbnail this browser made leaves the listing without the header's
  // facts, so a still's are read when it is first selected.
  it("reads a still's color mode and bit depth once when its listing has none, and says Unknown where it can't", async () => {
    const pixelFormat = vi.fn(async (path: string) => {
      if (path.endsWith("bad.png")) throw new Error("The image's header gives no pixel format");
      return { colorModel: "indexed" as const, alpha: false, bitDepth: 4, sourceType: "digitalCapture" };
    });
    const { pane } = setup(
      [file("new.png", { thumbnail: true, width: 64, height: 64 }), file("bad.png", { thumbnail: true })],
      { pixelFormat },
    );
    await open(pane);
    await settle();

    tileNamed(pane, "new").click();
    expect(infoRows(pane)).toMatchObject({ "Color mode": "…", "Bit depth": "…" });
    await settle();
    expect(infoRows(pane)).toMatchObject({
      "Color mode": "Indexed",
      "Bit depth": "4 bits per pixel",
      Source: "Camera",
    });

    pane.dismissTransient?.();
    tileNamed(pane, "bad").click();
    await settle();
    expect(infoRows(pane)).toMatchObject({ "Color mode": "Unknown", "Bit depth": "Unknown" });

    pane.dismissTransient?.();
    tileNamed(pane, "new").click();
    expect(infoRows(pane)).toMatchObject({ "Color mode": "Indexed", "Bit depth": "4 bits per pixel" });
    expect(pixelFormat).toHaveBeenCalledTimes(2);
  });

  // As in the image tab: a vector image has no pixels to have a color mode.
  it("gives a vector image no color rows", async () => {
    const { pane, deps } = setup([file("logo.svg")]);
    await open(pane);
    await settle();
    tileNamed(pane, "logo").click();
    expect(Object.keys(infoRows(pane))).not.toContain("Color mode");
    expect(deps.pixelFormat).not.toHaveBeenCalled();
  });

  // The section names what is selected, by the name the tree's icon gives its kind.
  it("titles the Info section by the selected entry's kind", async () => {
    const { pane } = setup([folder("takes"), file("scene.md"), file("cut.pdf")]);
    await open(pane);
    await settle();
    const title = () => pane.inspector?.querySelector(".inspector-section-title")?.textContent;
    for (const [name, expected] of [
      ["takes", "Selected Folder"],
      ["scene", "Selected Note"],
      ["cut", "Selected PDF"],
    ]) {
      tileNamed(pane, name).click();
      pane.dismissTransient?.();
      expect(title(), name).toBe(expected);
    }
  });

  it("keeps a picture's top bar empty until its dimensions are known", async () => {
    const pending = renderer(() => new Promise(() => undefined));
    const { pane } = setup([file("new.png", { size: 10 })], { renderer: pending });
    await open(pane);
    const [top, bottom] = tileNamed(pane, "new").querySelectorAll<HTMLElement>(".thumbnail-hud-bar");
    expect(top.hidden).toBe(true);
    expect(bottom.textContent).toBe("10 B");
  });

  // What the bars hold at each width is the stylesheet's, read from the
  // square they lie on, so a tile of any size follows it.
  it("lays a picture's bars last on its square, the box their size rule reads", async () => {
    const { pane } = setup([file("a.png"), file("take.mp4")]);
    await open(pane);
    for (const name of ["a", "take"]) {
      const frame = tileNamed(pane, name).querySelector(".gallery-tile-frame") as HTMLElement;
      expect(frame.classList.contains("thumbnail-box")).toBe(true);
      expect(frame.lastElementChild?.classList.contains("thumbnail-hud")).toBe(true);
    }
  });

  it("draws an SVG from its own bytes, with nothing to render", async () => {
    const { pane, deps } = setup([file("logo.svg")]);
    await open(pane);
    const img = tileNamed(pane, "logo").querySelector("img") as HTMLImageElement;
    expect(img.getAttribute("src")).toBe("/raw?path=lib:footage/logo.svg");
    img.dispatchEvent(new Event("error"));
    expect(deps.renderer.render).not.toHaveBeenCalled();
  });

  // As in the image view: with no size of its own, it would preview at nothing.
  it("previews an SVG that sets no size at its viewBox's extent", async () => {
    const { pane, deps } = setup([file("logo.svg")]);
    await open(pane);
    tileNamed(pane, "logo").click();
    await settle();
    const preview = pane.element.querySelector(".file-preview") as HTMLElement;
    const img = preview.querySelector("img") as HTMLImageElement;
    expect(deps.fetchFile).toHaveBeenCalledWith("lib:footage/logo.svg");
    expect(img.classList.contains("is-unsized")).toBe(true);

    Object.defineProperty(img, "naturalWidth", { value: 300 });
    Object.defineProperty(img, "naturalHeight", { value: 141 });
    img.getBoundingClientRect = () => ({ left: 0, top: 0, width: 651.5, height: 307.25 }) as DOMRect;
    img.dispatchEvent(new Event("load"));
    await settle();
    const top = preview.querySelector(".media-hud-bar") as HTMLElement;
    // No LOOK, with no pixels to grade: the middle cell holds the guides
    // switch alone. The scale is against that extent.
    expect([...top.children].map((cell) => cell.textContent)).toEqual(["2412 × 1137 (2.12:1)", "", "27%"]);
  });

  // Drawn sooner, the board would flash in the picture's box before its
  // pixels.
  it("previews a decoded SVG or PNG on the checkerboard, and no other picture", async () => {
    const { pane } = setup([file("frame.png"), file("logo.svg"), file("still.jpg")]);
    await open(pane);
    const preview = pane.element.querySelector(".file-preview") as HTMLElement;
    for (const [name, checkered] of Object.entries({ frame: true, logo: true, still: false })) {
      tileNamed(pane, name).click();
      const img = preview.querySelector("img") as HTMLImageElement;
      expect(img.classList.contains("shows-transparency"), `${name} before it loads`).toBe(false);
      img.dispatchEvent(new Event("load"));
      await settle();
      expect(img.classList.contains("shows-transparency"), name).toBe(checkered);
      pane.dismissTransient?.();
    }
  });

  it("cancels a thumbnail still being made when its tile goes", async () => {
    const pending = renderer(() => new Promise(() => undefined));
    const { pane } = setup([file("frame.png")], { renderer: pending });
    await open(pane);
    pane.clearInput();
    expect(pending.cancel).toHaveBeenCalled();
  });

  it("previews a picture or video on a click, and selects anything else", async () => {
    const { pane, deps } = setup([folder("day 2"), file("frame.png"), file("take.mp4"), file("cues.txt")]);
    await open(pane);
    const preview = pane.element.querySelector(".file-preview") as HTMLElement;

    tileNamed(pane, "frame").click();
    expect(preview.hidden).toBe(false);
    expect(preview.querySelector("img")?.getAttribute("src")).toBe("/raw?path=lib:footage/frame.png");
    expect(preview.querySelector(".media-hud-name")?.textContent).toBe("frame.png");
    expect(pane.inspector?.textContent).toContain("frame.png");
    pane.dismissTransient?.();

    tileNamed(pane, "take").click();
    expect(preview.querySelector("video")?.getAttribute("src")).toBe("/raw?path=lib:footage/take.mp4");
    pane.dismissTransient?.();

    // A file Pragma can't open keeps its extension, with extensions hidden.
    for (const name of ["cues.txt", "day 2"]) {
      tileNamed(pane, name).click();
      expect(preview.hidden, name).toBe(true);
      expect(tileNamed(pane, name).classList.contains("is-selected"), name).toBe(true);
    }
    expect(deps.openEntry).not.toHaveBeenCalled();
    expect(deps.openFolder).not.toHaveBeenCalled();
  });

  it("opens a folder or a file on a double-click", async () => {
    const { pane, deps } = setup([folder("day 2"), file("notes.md")]);
    await open(pane);
    tileNamed(pane, "day 2").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(deps.openFolder).toHaveBeenCalledWith("lib:footage/day 2");
    tileNamed(pane, "notes").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(deps.openEntry).toHaveBeenCalledWith("lib:footage/notes.md", {
      anchor: expect.any(HTMLElement),
      marked: true,
    });
  });

  // A click opens the preview, so the preview is where a picture is opened
  // from: Enter, or a double-click whose second click landed on it — which
  // must not have closed it first.
  it("opens the previewed picture, and survives a double-click's second click", async () => {
    const { pane, deps } = setup([file("frame.png")]);
    await open(pane);
    const preview = pane.element.querySelector(".file-preview") as HTMLElement;

    tileNamed(pane, "frame").click();
    pane.element.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(deps.openEntry).toHaveBeenLastCalledWith("lib:footage/frame.png", {
      anchor: expect.any(HTMLElement),
      marked: true,
    });

    preview.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 2 }));
    expect(preview.hidden).toBe(false);
    preview.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(deps.openEntry).toHaveBeenCalledTimes(2);

    // A single click on the backdrop is a close.
    preview.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    expect(preview.hidden).toBe(true);
  });

  // A double-click on a previewed still at full size closes it with its first
  // click; the rest lands on the grid beneath and must not preview or open
  // the tile there.
  it("closes on a click on a still at full size, never on a player", async () => {
    const { pane, deps } = setup([file("frame.png"), file("take.mp4")]);
    await open(pane);
    const preview = pane.element.querySelector(".file-preview") as HTMLElement;
    const press = (target: Element, type: string, detail: number) =>
      target.dispatchEvent(new MouseEvent(type, { bubbles: true, detail }));

    tileNamed(pane, "take").click();
    press(preview.querySelector("video") as HTMLVideoElement, "click", 1);
    expect(preview.hidden).toBe(false);
    pane.dismissTransient?.();

    tileNamed(pane, "frame").click();
    const img = preview.querySelector("img") as HTMLImageElement;
    press(img, "mousedown", 1);
    press(img, "click", 1);
    expect(preview.hidden).toBe(true);

    const beneath = tileNamed(pane, "take");
    press(beneath, "mousedown", 2);
    press(beneath, "click", 2);
    press(beneath, "dblclick", 2);
    expect(preview.hidden).toBe(true);
    expect(deps.openEntry).not.toHaveBeenCalled();

    press(beneath, "mousedown", 1);
    press(beneath, "click", 1);
    expect(preview.querySelector("video")?.getAttribute("src")).toBe("/raw?path=lib:footage/take.mp4");
  });

  describe("a still shrunk to fit", () => {
    const press = (target: Element, type: string, detail: number) =>
      target.dispatchEvent(new MouseEvent(type, { bubbles: true, detail }));
    const pointer = (type: string, target: EventTarget, x: number, y: number) =>
      target.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          button: 0,
          pointerId: 1,
          pointerType: "mouse",
          clientX: x,
          clientY: y,
        }),
      );

    // Previews `name`, decoded at `full` and laid out at a quarter of it.
    function previewStill(pane: GalleryPane, name: string, full: [number, number] = [2400, 1600]) {
      tileNamed(pane, name).click();
      const preview = pane.element.querySelector(".file-preview") as HTMLElement;
      const img = preview.querySelector("img") as HTMLImageElement;
      const frame = img.parentElement as HTMLElement;
      Object.defineProperty(img, "naturalWidth", { value: full[0] });
      Object.defineProperty(img, "naturalHeight", { value: full[1] });
      img.getBoundingClientRect = () =>
        frame.classList.contains("is-zoomed")
          ? ({ left: 108, top: 58, width: full[0], height: full[1] } as DOMRect)
          : ({ left: 208, top: 158, width: Math.min(600, full[0]), height: Math.min(400, full[1]) } as DOMRect);
      img.dispatchEvent(new Event("load"));
      return { preview, img, frame };
    }

    it("zooms on a click, fits on the next, and hides its overlay while zoomed", async () => {
      const { pane } = setup([file("frame.png")]);
      await open(pane);
      const { preview, img, frame } = previewStill(pane, "frame");
      expect(frame.classList.contains("is-zoomable")).toBe(true);

      press(img, "mousedown", 1);
      press(img, "click", 1);
      expect(frame.classList.contains("is-zoomed")).toBe(true);
      expect(frame.classList.contains("is-zoomable")).toBe(false);
      // At full size it is the frame that takes the click, mat and all.
      press(frame, "mousedown", 1);
      press(frame, "click", 1);
      expect(frame.classList.contains("is-zoomed")).toBe(false);
      expect(frame.classList.contains("is-zoomable")).toBe(true);
      expect(preview.hidden).toBe(false);

      press(preview, "mousedown", 1);
      press(preview, "click", 1);
      expect(preview.hidden).toBe(true);
    });

    // Enter and a double-click on the tile open it in the gallery's place.
    it("opens the file's menu from its ⋮, without zooming", async () => {
      const { pane, deps } = setup([file("frame.png")]);
      await open(pane);
      const { preview, frame } = previewStill(pane, "frame");
      const button = preview.querySelector(".media-hud-more") as HTMLButtonElement;
      press(button, "mousedown", 1);
      press(button, "click", 1);
      expect(deps.contextMenu.open).toHaveBeenCalledWith(expect.objectContaining({ menu: MEDIA_MENU }));
      expect(deps.openEntry).not.toHaveBeenCalled();
      expect(frame.classList.contains("is-zoomed")).toBe(false);
      expect(preview.hidden).toBe(false);
    });

    it("leaves one already at full size closing on a click", async () => {
      const { pane } = setup([file("icon.png")]);
      await open(pane);
      const { preview, img, frame } = previewStill(pane, "icon", [300, 200]);
      expect(frame.classList.contains("is-zoomable")).toBe(false);
      press(img, "mousedown", 1);
      press(img, "click", 1);
      expect(preview.hidden).toBe(true);
    });

    // Released over the backdrop, the drag's click would close the preview.
    it("pans when zoomed by a drag, whose release closes nothing", async () => {
      const { pane } = setup([file("frame.png")]);
      await open(pane);
      const { preview, img, frame } = previewStill(pane, "frame");
      press(img, "mousedown", 1);
      press(img, "click", 1);
      frame.scrollLeft = 500;
      frame.scrollTop = 300;

      pointer("pointerdown", img, 400, 300);
      pointer("pointermove", window, 300, 250);
      pointer("pointerup", window, 300, 250);
      press(preview, "click", 1);
      expect([frame.scrollLeft, frame.scrollTop]).toEqual([600, 350]);
      expect(frame.classList.contains("is-zoomed")).toBe(true);
      expect(preview.hidden).toBe(false);

      // Only the release's own clicks: a click after it zooms out.
      await settle();
      press(img, "mousedown", 1);
      press(img, "click", 1);
      expect(frame.classList.contains("is-zoomed")).toBe(false);
    });

    it("zooms in and out on a double-click begun on it, and opens nothing", async () => {
      const { pane, deps } = setup([file("frame.png")]);
      await open(pane);
      const { preview, img, frame } = previewStill(pane, "frame");
      press(img, "mousedown", 1);
      press(img, "click", 1);
      press(img, "mousedown", 2);
      press(img, "click", 2);
      press(img, "dblclick", 2);
      expect(frame.classList.contains("is-zoomed")).toBe(false);
      expect(preview.hidden).toBe(false);
      expect(deps.openEntry).not.toHaveBeenCalled();
    });

    // The first click of a double-click on its tile opens the preview, and
    // the second lands on the picture.
    it("opens unzoomed on a double-click begun on its tile", async () => {
      const { pane, deps } = setup([file("frame.png")]);
      await open(pane);
      const tile = tileNamed(pane, "frame");
      press(tile, "mousedown", 1);
      const { img, frame } = previewStill(pane, "frame");
      press(img, "mousedown", 2);
      press(img, "click", 2);
      press(img, "dblclick", 2);
      expect(frame.classList.contains("is-zoomed")).toBe(false);
      expect(deps.openEntry).toHaveBeenCalledWith("lib:footage/frame.png", expect.anything());
    });

    it("steps to the next picture fitted", async () => {
      const { pane } = setup([file("a.png"), file("b.png")]);
      await open(pane);
      const { img } = previewStill(pane, "a");
      press(img, "mousedown", 1);
      press(img, "click", 1);
      pane.element.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
      const next = pane.element.querySelector(".file-preview-frame") as HTMLElement;
      expect(next.querySelector("img")?.getAttribute("src")).toBe("/raw?path=lib:footage/b.png");
      expect(next.classList.contains("is-zoomed")).toBe(false);
    });
  });

  // The status bar names the folders above; the pane names its own.
  it("titles the folder above the tiles, counts it in the status bar, and goes up on Backspace", async () => {
    const { pane, deps, scroller } = setup([folder("x"), folder("y"), file("z.png")]);
    await open(pane, "lib:footage/day 1/a");
    expect(pane.title()).toBe("a");
    expect(pane.titleHost?.()).toBe(scroller);
    expect(deps.onRendered).toHaveBeenCalled();
    expect(deps.reportReadout).toHaveBeenLastCalledWith("2 folders · 1 file");
    pane.element.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace" }));
    expect(deps.openFolder).toHaveBeenCalledWith("lib:footage/day 1");
  });

  it("says a folder is empty in the grid, leaving the status bar's count blank", async () => {
    const { pane, deps } = setup([]);
    await open(pane);
    expect(pane.element.querySelector(".gallery-status")?.textContent).toBe("Nothing in this folder to show.");
    expect(deps.reportReadout).toHaveBeenLastCalledWith("");
  });

  it("moves the selection by key, opens on Enter, and previews on Space until dismissed", async () => {
    const { pane, deps } = setup([file("a.png"), file("b.png"), file("c.txt"), file("d.png")]);
    await open(pane);
    const key = (name: string) => pane.element.dispatchEvent(new KeyboardEvent("keydown", { key: name }));

    key("ArrowRight");
    expect(tileNamed(pane, "a").classList.contains("is-selected")).toBe(true);
    key("ArrowRight");
    key(" ");
    expect(pane.hasTransient?.()).toBe(true);
    const preview = pane.element.querySelector(".file-preview") as HTMLElement;
    expect(preview.hidden).toBe(false);
    expect(preview.querySelector("img")?.getAttribute("src")).toBe("/raw?path=lib:footage/b.png");

    // Stepping skips what has nothing to preview.
    key("ArrowRight");
    expect(preview.querySelector("img")?.getAttribute("src")).toBe("/raw?path=lib:footage/d.png");
    pane.dismissTransient?.();
    expect(preview.hidden).toBe(true);
    expect(tileNamed(pane, "d").classList.contains("is-selected")).toBe(true);

    key("Enter");
    expect(deps.openEntry).toHaveBeenCalledWith("lib:footage/d.png", { anchor: expect.any(HTMLElement), marked: true });
  });

  it("points the copilot at the selected tile, saying while the preview shows it", async () => {
    const { pane } = setup([folder("day 2"), file("a.png"), file("b.png")]);
    await open(pane);
    expect(pane.selectedFile?.()).toBeUndefined();

    tileNamed(pane, "day 2").click();
    expect(pane.selectedFile?.()).toEqual({ path: "lib:footage/day 2", previewing: false });

    tileNamed(pane, "a").click();
    expect(pane.selectedFile?.()).toEqual({ path: "lib:footage/a.png", previewing: true });
    pane.element.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
    expect(pane.selectedFile?.()).toEqual({ path: "lib:footage/b.png", previewing: true });

    pane.dismissTransient?.();
    expect(pane.selectedFile?.()).toEqual({ path: "lib:footage/b.png", previewing: false });
    pane.clearInput();
    expect(pane.selectedFile?.()).toBeUndefined();
  });

  // A click on an arrow keeps focus on the pane, where the keys listen, and
  // a run of them is a double-click that must not open the picture — the
  // run past the last one included.
  it("steps the preview with its arrows, each inert with nowhere to go", async () => {
    const { pane, deps } = setup([file("a.png"), file("c.txt"), file("d.png")]);
    await open(pane);
    const preview = pane.element.querySelector(".file-preview") as HTMLElement;
    const prev = preview.querySelector(".file-preview-nav.is-prev") as HTMLButtonElement;
    const next = preview.querySelector(".file-preview-nav.is-next") as HTMLButtonElement;
    const shown = () => preview.querySelector("img")?.getAttribute("src");
    const inert = () => [prev, next].map((arrow) => arrow.getAttribute("aria-disabled"));

    tileNamed(pane, "a").click();
    expect(inert()).toEqual(["true", "false"]);

    const press = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    next.dispatchEvent(press);
    expect(press.defaultPrevented).toBe(true);
    next.click();
    expect(shown()).toBe("/raw?path=lib:footage/d.png");
    expect(inert()).toEqual(["false", "true"]);

    next.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 2 }));
    next.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(preview.hidden).toBe(false);
    expect(shown()).toBe("/raw?path=lib:footage/d.png");
    expect(deps.openEntry).not.toHaveBeenCalled();

    prev.click();
    expect(shown()).toBe("/raw?path=lib:footage/a.png");
  });

  it("comes back to a folder where this session left it", async () => {
    const { pane } = setup([file("a.png"), file("b.png")]);
    await open(pane, "lib:footage/day 1");
    tileNamed(pane, "b").click();
    await open(pane, "lib:footage/day 2");
    expect(pane.element.querySelector(".is-selected")).toBeNull();
    await open(pane, "lib:footage/day 1");
    expect(tileNamed(pane, "b").classList.contains("is-selected")).toBe(true);
  });

  it("keeps its tiles on a refresh that finds the folder unchanged", async () => {
    const listFolder = vi.fn(async () => ({ entries: [file("a.png"), file("b.png")], order: BY_NAME }));
    const { pane } = setup([], { listFolder });
    await open(pane);
    const before = tileNamed(pane, "b");
    pane.refresh();
    await settle();
    expect(tileNamed(pane, "b")).toBe(before);

    listFolder.mockResolvedValueOnce({ entries: [file("a.png"), file("b.png", { version: "2-120" })], order: BY_NAME });
    pane.refresh();
    await settle();
    expect(tileNamed(pane, "b")).not.toBe(before);
  });

  it("clears a failed listing's message once the folder lists", async () => {
    const listFolder = vi.fn(async (): Promise<{ entries: FolderEntry[]; order: FolderOrder }> => {
      throw new Error("Not found");
    });
    const { pane } = setup([], { listFolder });
    await open(pane);
    listFolder.mockResolvedValueOnce({ entries: [], order: BY_NAME });
    pane.refresh();
    await settle();
    expect(pane.element.querySelector(".gallery-status")?.textContent).toBe("Nothing in this folder to show.");
  });

  // The folder's order, or its Sort by here, is the server's to apply, so
  // the tree and the gallery never disagree.
  it("draws the tiles in the order the listing gives", async () => {
    const { pane } = setup([file("small.png"), file("large.png"), folder("mid")]);
    await open(pane);
    const names = () => tiles(pane).map((tile) => tile.querySelector(".gallery-tile-name")?.textContent);
    expect(names()).toEqual(["small", "large", "mid"]);
  });

  describe("a drop among the tiles", () => {
    const listing = [file("a.png"), file("b.png"), file("c.png")];
    // jsdom lays nothing out, so every tile's middle is at x 0: a drop at 1 is
    // past it, at 0 before it.
    function drop(pane: GalleryPane, dragged: string, target: string, after: boolean): boolean {
      noteDragInFlight(`lib:footage/${dragged}`);
      const tile = tileNamed(pane, target.replace(/\.png$/, ""));
      const over = new MouseEvent("dragover", { bubbles: true, cancelable: true, clientX: after ? 1 : 0 });
      tile.dispatchEvent(over);
      tile.dispatchEvent(new MouseEvent("drop", { bubbles: true, cancelable: true, clientX: after ? 1 : 0 }));
      noteDragInFlight(undefined);
      return over.defaultPrevented;
    }

    beforeEach(() => vi.mocked(setLocalSort).mockClear());

    it("arranges a folder shown in manual order, on this install", async () => {
      const { pane } = setup(listing, { listFolder: vi.fn(async () => ({ entries: listing, order: MANUAL })) });
      await open(pane);
      expect(drop(pane, "a.png", "c.png", true)).toBe(true);
      expect(setLocalSort).toHaveBeenLastCalledWith("lib:footage", { by: "manual" }, ["b.png", "c.png", "a.png"]);
      drop(pane, "c.png", "a.png", false);
      expect(setLocalSort).toHaveBeenLastCalledWith("lib:footage", { by: "manual" }, ["c.png", "a.png", "b.png"]);
    });

    // A folder the space lists for presets is a folder like any other.
    it("draws a tile for a folder holding templates, as for any folder", async () => {
      const root = [
        { ...folder("_templates"), path: "_templates" },
        { ...file("a.png"), path: "a.png" },
        { ...file("b.png"), path: "b.png" },
      ];
      const { pane } = setup(root, { listFolder: vi.fn(async () => ({ entries: root, order: MANUAL })) });
      await open(pane, "");
      expect(tiles(pane).map((tile) => tile.querySelector(".gallery-tile-name")?.textContent)).toEqual([
        "_templates",
        "a",
        "b",
      ]);
      noteDragInFlight("a.png");
      tileNamed(pane, "b").dispatchEvent(new MouseEvent("dragover", { bubbles: true, cancelable: true, clientX: 1 }));
      tileNamed(pane, "b").dispatchEvent(new MouseEvent("drop", { bubbles: true, cancelable: true, clientX: 1 }));
      noteDragInFlight(undefined);
      expect(setLocalSort).toHaveBeenLastCalledWith("", { by: "manual" }, ["_templates", "b.png", "a.png"]);
    });

    it("refuses one in any other order, and one from outside the folder", async () => {
      const { pane } = setup(listing);
      await open(pane);
      expect(drop(pane, "a.png", "c.png", true)).toBe(false);
      const manual = setup(listing, { listFolder: vi.fn(async () => ({ entries: listing, order: MANUAL })) });
      await open(manual.pane);
      expect(drop(manual.pane, "elsewhere/a.png", "c.png", true)).toBe(false);
      expect(setLocalSort).not.toHaveBeenCalled();
    });
  });

  it("says why a folder couldn't be listed", async () => {
    const { pane } = setup([], { listFolder: vi.fn(async () => Promise.reject(new Error("Not found"))) });
    await open(pane);
    expect(pane.element.querySelector(".gallery-status")?.textContent).toBe("Not found");
    expect(tiles(pane)).toHaveLength(0);
  });

  // A tile's menu is its tree row's, on the tile it selects; the browser's
  // own would save the thumbnail as if it were the file.
  it("opens a tile's menu on the tile it selects, and the toolbar's around the tiles", async () => {
    const { pane, deps } = setup([file("frame.png"), file("notes.md")]);
    await open(pane);
    const onTile = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 30, clientY: 40 });
    tileNamed(pane, "notes").dispatchEvent(onTile);
    expect(onTile.defaultPrevented).toBe(true);
    expect(tileNamed(pane, "notes").classList.contains("is-selected")).toBe(true);
    expect(deps.openMenu).toHaveBeenLastCalledWith(
      { x: 30, y: 40 },
      { entry: expect.objectContaining({ path: "lib:footage/notes.md" }), naming: expect.anything() },
    );
    expect(pane.element.querySelector(".file-preview")?.hasAttribute("hidden")).toBe(true);

    const around = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 6 });
    pane.element.querySelector(".gallery-canvas")?.dispatchEvent(around);
    expect(around.defaultPrevented).toBe(true);
    expect(deps.openMenu).toHaveBeenLastCalledWith({ x: 5, y: 6 });
  });

  // With extensions hidden, the field holds the name without one, and the
  // name handed back has it again.
  it("renames a tile in place, keeping the extension it hides", async () => {
    const { pane, deps } = setup([file("frame.png"), file("notes.md")]);
    await open(pane);
    const naming = namingOf(pane, deps, "frame");
    const submit = vi.fn();
    naming.rename("lib:footage/frame.png", submit);
    const field = fieldOf(pane) as HTMLInputElement;
    expect(field.value).toBe("frame");
    expect(document.activeElement).toBe(field);
    expect(field.closest<HTMLElement>(".gallery-tile")?.draggable).toBe(false);

    // A double-click in the field selects a word; it never opens the tile.
    field.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(deps.openEntry).not.toHaveBeenCalled();
    // The field keeps the browser's menu, for its text.
    const inField = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    field.dispatchEvent(inField);
    expect(inField.defaultPrevented).toBe(false);

    field.value = "still";
    press(field, "Enter");
    expect(submit).toHaveBeenCalledWith("still.png");
    expect(fieldOf(pane)).toBeNull();
    expect(tileNamed(pane, "frame").draggable).toBe(true);
    expect(document.activeElement).toBe(pane.element);

    naming.rename("lib:footage/notes.md", submit);
    press(fieldOf(pane) as HTMLInputElement, "Escape");
    expect(submit).toHaveBeenCalledTimes(1);
    expect(tileNamed(pane, "notes")).toBeDefined();
  });

  it("holds a refresh until the name being typed is in", async () => {
    const listFolder = vi.fn(async () => ({ entries: [file("a.png")], order: BY_NAME }));
    const { pane, deps } = setup([], { listFolder });
    await open(pane);
    namingOf(pane, deps, "a").rename("lib:footage/a.png", vi.fn());
    const field = fieldOf(pane) as HTMLInputElement;
    field.value = "b";

    listFolder.mockResolvedValue({ entries: [file("a.png"), file("c.png")], order: BY_NAME });
    pane.refresh();
    await settle();
    expect(fieldOf(pane)).toBe(field);
    expect(field.value).toBe("b");
    expect(tileNamed(pane, "c")).toBeUndefined();

    press(field, "Escape");
    await settle();
    expect(tileNamed(pane, "c")).toBeDefined();
  });

  // Folders lead, so a new file's stand-in follows the last folder and a new
  // folder's goes first. The count leaves it out until it is real.
  it("names a new entry on a stand-in tile among its kind", async () => {
    const { pane, deps } = setup([folder("day 1"), file("a.png")]);
    await open(pane);
    const naming = namingOf(pane, deps, "a");
    const submit = vi.fn();
    naming.create({ parentPath: "lib:footage", type: "file", kind: "table" }, submit);
    const field = fieldOf(pane) as HTMLInputElement;
    const standIn = field.closest<HTMLElement>(".gallery-tile");
    expect(field.placeholder).toBe("Table name");
    expect(standIn?.querySelector<HTMLElement>(".gallery-tile-icon")?.dataset.entryIcon).toBe("table");
    expect(standIn?.dataset.index).toBe("1");
    expect(deps.reportReadout).toHaveBeenLastCalledWith("1 folder · 1 file");

    // A press on the stand-in is no press on an entry.
    standIn?.click();
    expect(pane.element.querySelector(".is-selected")).toBeNull();

    field.value = "Shots";
    press(field, "Enter");
    expect(submit).toHaveBeenCalledWith("Shots");
    expect(fieldOf(pane)).toBeNull();
    expect(tiles(pane)).toHaveLength(2);

    naming.create({ parentPath: "lib:footage", type: "directory" }, submit);
    expect(fieldOf(pane)?.placeholder).toBe("Folder name");
    expect(fieldOf(pane)?.closest<HTMLElement>(".gallery-tile")?.dataset.index).toBe("0");
  });

  // As the tree opens a folder to show the row it adds there.
  it("steps into a folder tile to name what is made inside it", async () => {
    const { pane, deps } = setup([folder("day 1")]);
    await open(pane);
    const naming = namingOf(pane, deps, "day 1");
    naming.create({ parentPath: "lib:footage/day 1", type: "file", kind: "note" }, vi.fn());
    expect(deps.openFolder).toHaveBeenCalledWith("lib:footage/day 1");
    expect(fieldOf(pane)).toBeNull();

    await open(pane, "lib:footage/day 1");
    expect(fieldOf(pane)?.placeholder).toBe("Note name");

    // Asked for in a folder that never opens, it is dropped when another does.
    press(fieldOf(pane) as HTMLInputElement, "Escape");
    naming.create({ parentPath: "lib:footage/day 1/x", type: "file" }, vi.fn());
    await open(pane, "lib:footage/day 2");
    expect(fieldOf(pane)).toBeNull();
  });

  // A duplicate's copy is named the moment it exists, a moment before the
  // gallery's listing has it.
  it("lists again for a rename whose entry hasn't arrived, and drops one that never does", async () => {
    const listFolder = vi.fn(async () => ({ entries: [file("a.png")], order: BY_NAME }));
    const { pane, deps } = setup([], { listFolder });
    await open(pane);
    const naming = namingOf(pane, deps, "a");
    listFolder.mockResolvedValueOnce({ entries: [file("a.png"), file("a 2.png")], order: BY_NAME });
    naming.rename("lib:footage/a 2.png", vi.fn());
    await settle();
    expect(fieldOf(pane)?.value).toBe("a 2");
    expect(tileNamed(pane, "a").classList.contains("is-selected")).toBe(false);
    press(fieldOf(pane) as HTMLInputElement, "Escape");

    naming.rename("lib:footage/gone.png", vi.fn());
    await settle();
    expect(fieldOf(pane)).toBeNull();
  });

  it("commits the name being typed when the folder changes", async () => {
    const { pane, deps } = setup([file("a.png")]);
    await open(pane);
    const submit = vi.fn();
    namingOf(pane, deps, "a").rename("lib:footage/a.png", submit);
    (fieldOf(pane) as HTMLInputElement).value = "b";
    await open(pane, "lib:footage/day 2");
    expect(submit).toHaveBeenCalledWith("b.png");
  });

  // Every kind's ways to open sit in one ⋮ at its foot: a still's and a
  // page's ends its bottom bar, a clip's its player. Nothing lies over the
  // group's toolbar, which the backdrop dims.
  it("puts the previewed file's ⋮ at its foot, and nothing over the group's toolbar", async () => {
    const { pane } = setup([file("frame.png"), file("logo.svg"), file("take.mp4"), file("scene.md")]);
    await open(pane);
    const preview = pane.element.querySelector(".file-preview") as HTMLElement;
    for (const [name, place] of Object.entries({
      frame: ".file-preview-frame .media-hud-bar:last-child > .media-hud-more:last-child",
      logo: ".file-preview-frame .media-hud-bar:last-child > .media-hud-more:last-child",
      take: ".file-preview-frame .video-player-more",
      scene: ".file-preview-document .media-hud-bar > .media-hud-more:last-child",
    })) {
      tileNamed(pane, name).click();
      const mores = [...preview.querySelectorAll("[aria-label='More options']")];
      expect(
        mores.map((more) => more.matches(place)),
        name,
      ).toEqual([true]);
      expect(preview.querySelector(".floating-toolbar"), name).toBeNull();
      pane.dismissTransient?.();
    }
  });

  // The backdrop lies over the group's ⋮, which it dims: the rest of a
  // double-click on it presses nothing there, and a new run does.
  it("closes from the backdrop, the rest of its double-click pressing nothing beneath", async () => {
    const { pane } = setup([file("frame.png")]);
    await open(pane);
    const preview = pane.element.querySelector(".file-preview") as HTMLElement;
    const beneath = document.createElement("button");
    const pressed = vi.fn();
    beneath.addEventListener("click", pressed);
    document.body.append(beneath);
    const press = (target: Element, type: string, detail: number) =>
      target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, detail }));

    tileNamed(pane, "frame").click();
    press(preview, "mousedown", 1);
    press(preview, "click", 1);
    expect(preview.hidden).toBe(true);
    press(beneath, "mousedown", 2);
    press(beneath, "click", 2);
    press(beneath, "dblclick", 2);
    expect(pressed).not.toHaveBeenCalled();

    press(beneath, "mousedown", 1);
    press(beneath, "click", 1);
    expect(pressed).toHaveBeenCalledTimes(1);
  });

  // A tile can lie under the preview's ⋮: the rest of a double-click on it
  // lands on the ⋮, opening no menu, and opens the tile.
  it("opens on a double-click begun on its tile, the rest of it landing on the ⋮", async () => {
    const { pane, deps } = setup([file("frame.png")]);
    await open(pane);
    const preview = pane.element.querySelector(".file-preview") as HTMLElement;
    const press = (target: Element, type: string, detail: number) =>
      target.dispatchEvent(new MouseEvent(type, { bubbles: true, detail }));

    press(tileNamed(pane, "frame"), "mousedown", 1);
    tileNamed(pane, "frame").click();
    const more = preview.querySelector(".media-hud-more") as HTMLButtonElement;
    press(more, "mousedown", 2);
    press(more, "click", 2);
    press(more, "dblclick", 2);
    expect(preview.hidden).toBe(false);
    expect(deps.contextMenu.open).not.toHaveBeenCalled();
    expect(deps.openEntry).toHaveBeenCalledTimes(1);
    expect(deps.openEntry).toHaveBeenCalledWith("lib:footage/frame.png", expect.anything());
  });

  it("offers the previewed file's menu from its ⋮, keeping the preview", async () => {
    const { pane, deps } = setup([file("frame.png", { thumbnail: true })]);
    await open(pane);
    const preview = pane.element.querySelector(".file-preview") as HTMLElement;
    tileNamed(pane, "frame").click();
    const button = preview.querySelector(".media-hud-more") as HTMLButtonElement;

    button.click();
    expect(deps.contextMenu.open).toHaveBeenCalledWith({
      menu: MEDIA_MENU,
      arg: { file: "lib:footage/frame.png", bookmark: "lib:footage/frame.png", context: "lib:footage" },
      anchor: button,
      align: "end",
      ariaLabel: "More options",
    });
    expect(deps.openMenu).not.toHaveBeenCalled();
    expect(deps.openEntry).not.toHaveBeenCalled();
    expect(preview.hidden).toBe(false);
  });

  // The image view's overlay: a still on two bars, a clip on one. The
  // decoded picture has the last word on its size.
  it("lays the image view's overlay over the previewed picture", async () => {
    const { pane, deps } = setup([
      file("frame.png", { size: 4_404_019, thumbnail: true, width: 100, height: 100 }),
      file("take.mp4", { size: 2048, thumbnail: true, width: 1920, height: 1080, duration: 12 }),
    ]);
    await open(pane);
    const preview = pane.element.querySelector(".file-preview") as HTMLElement;
    const bars = () =>
      [...preview.querySelectorAll<HTMLElement>(".media-hud-bar")].map((bar) =>
        [...bar.children].map((cell) => cell.textContent).join(" | "),
      );

    tileNamed(pane, "frame").click();
    expect(bars()).toEqual(["100 × 100 (1:1) |  | ", "frame.png | "]);
    expect(preview.querySelector(".media-hud-bar:last-child > :last-child")?.matches(".media-hud-more")).toBe(true);
    // The scale it is shown at, at the right, once it is shown.
    const img = preview.querySelector("img") as HTMLImageElement;
    Object.defineProperty(img, "naturalWidth", { value: 3840 });
    Object.defineProperty(img, "naturalHeight", { value: 2160 });
    img.getBoundingClientRect = () => ({ left: 0, top: 0, width: 960, height: 540 }) as DOMRect;
    img.dispatchEvent(new Event("load"));
    expect(bars()).toEqual(["3840 × 2160 (16:9) |  | 25%", "frame.png | "]);

    pane.dismissTransient?.();
    tileNamed(pane, "take").click();
    // Dimensions and ratio as the video view writes them, the LOOK badge,
    // empty before any look is picked, then the frame rate the header read
    // gives; no name, and no length, which the pill shows.
    expect(deps.videoFormat).toHaveBeenCalledWith("lib:footage/take.mp4");
    await vi.waitFor(() => expect(bars()).toEqual(["1920 × 1080 (16:9) |  | 23.976 fps"]));
  });
});

describe("a previewed note", () => {
  // In the space, so a note's links and pictures resolve from its folder.
  const inFolder = (name: string) => file(name, { path: `notes/${name}` });
  const previewOf = (pane: GalleryPane) => pane.element.querySelector(".file-preview") as HTMLElement;
  const pageOf = (pane: GalleryPane) => pane.element.querySelector(".file-preview-page") as HTMLElement;
  const click = (target: Element) => {
    const event = new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 });
    target.dispatchEvent(event);
    return event;
  };
  // A note in a folder with a picture after it, clicked open.
  async function previewed(name: string, overrides: Partial<GalleryPaneDeps> = {}) {
    const shown = setup([inFolder(name), inFolder("z.png")], overrides);
    await open(shown.pane, "notes");
    tileNamed(shown.pane, name.replace(/\.md$/, "")).click();
    await settle();
    return shown;
  }

  // Laid out at the preview's measure, the page is zoomed to the size shown so
  // its lines break at the same words, down to a floor below which it
  // rewraps rather than shrink past reading.
  it("zooms its page to the size shown, between a legible floor and full size", () => {
    expect(pageZoom(606, 646)).toBeCloseTo(0.938, 3);
    expect(pageZoom(300, 646)).toBe(0.75);
    expect(pageZoom(900, 900)).toBe(1);
  });

  // A double-click begun on the ⋮ is two presses of it, and opens nothing in
  // the gallery's place.
  it("shows below full size, and offers the note's menu from the ⋮ ending its bar", async () => {
    const { pane, deps } = await previewed("scene.md");
    const note = previewOf(pane).querySelector(".file-preview-document") as HTMLElement;
    const control = note.querySelector(".media-hud-bar > .media-hud-more") as HTMLButtonElement;
    expect(note.style.getPropertyValue("--page-scale")).toBe(String(PAGE_PREVIEW_SCALE));
    expect(control.getAttribute("aria-label")).toBe("More options");

    for (const [type, detail] of [
      ["mousedown", 1],
      ["click", 1],
      ["mousedown", 2],
      ["click", 2],
      ["dblclick", 2],
    ] as const) {
      control.dispatchEvent(new MouseEvent(type, { bubbles: true, detail }));
    }
    expect(deps.contextMenu.open).toHaveBeenCalledTimes(2);
    expect(deps.contextMenu.open).toHaveBeenCalledWith(
      expect.objectContaining({
        menu: PREVIEW_PAGE_MENU,
        arg: { file: "notes/scene.md", bookmark: "notes/scene.md", context: "" },
      }),
    );
    expect(deps.openEntry).not.toHaveBeenCalled();
    expect(previewOf(pane).hidden).toBe(false);
  });

  // The count is over what the editor would hold, frontmatter and title
  // lifted out, in the status bar's words.
  it("shows its reading view, titled, with its name and the status bar's count", async () => {
    const content = "---\ntags: [ada]\n---\n# Night watch\n\nAda climbs the **stairs**.\n";
    const { pane, deps } = await previewed("scene.md", { loadFile: vi.fn(async (path) => textFile(path, content)) });

    expect(previewOf(pane).hidden).toBe(false);
    expect(deps.loadFile).toHaveBeenCalledWith("notes/scene.md");
    const title = pageOf(pane).querySelector<HTMLInputElement>(".editor-title-input");
    expect([title?.value, title?.readOnly]).toEqual(["Night watch", true]);
    expect(pageOf(pane).querySelector("h1")).toBeNull();
    expect(pageOf(pane).querySelector(".editor-reading-content p")?.textContent).toBe("Ada climbs the stairs.");
    const bar = [...previewOf(pane).querySelectorAll(".media-hud-bar > *")].map((cell) => cell.textContent);
    expect(bar).toEqual(["scene.md", "4 words · 27 characters", ""]);
    expect(pane.inspector?.textContent).toContain("scene.md");
  });

  it("stays open for a click in the note, a picture in it included, and opens a space link here", async () => {
    const content = "# Lamp room\n\nSee [[keeper]].\n\n![plan](plan.png)\n";
    const { pane, deps } = await previewed("scene.md", {
      loadFile: vi.fn(async (path) => textFile(path, content)),
      readingResolvers: vi.fn(() => ({
        image: (href: string) => `/raw?path=${href}`,
        link: () => undefined,
        wikilink: () => "notes/keeper.md",
        wikilinkPending: () => false,
        hint: () => undefined,
      })),
    });

    click(pageOf(pane).querySelector("p") as HTMLElement);
    click(pageOf(pane).querySelector("img") as HTMLImageElement);
    expect(previewOf(pane).hidden).toBe(false);

    const followed = click(pageOf(pane).querySelector("a[data-space-path]") as HTMLAnchorElement);
    expect(followed.defaultPrevented).toBe(true);
    expect(deps.readingResolvers).toHaveBeenCalledWith("notes/scene.md");
    expect(deps.openPath).toHaveBeenCalledWith("notes/keeper.md");
  });

  // A double-click on a tile opens it: its first click opened the preview,
  // and the rest lands on the page. One begun in the open note is the text's.
  it("opens on a double-click begun on its tile, not on one begun in the open note", async () => {
    const press = (target: Element, detail: number) =>
      target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, detail }));
    const shown = setup([inFolder("scene.md")]);
    await open(shown.pane, "notes");
    press(tileNamed(shown.pane, "scene"), 1);
    tileNamed(shown.pane, "scene").click();
    press(pageOf(shown.pane), 2);
    pageOf(shown.pane).dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(shown.deps.openEntry).toHaveBeenCalledTimes(1);

    const { pane, deps } = await previewed("scene.md");
    press(pageOf(pane), 1);
    press(pageOf(pane), 2);
    pageOf(pane).dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(deps.openEntry).not.toHaveBeenCalled();
    click(previewOf(pane));
    expect(previewOf(pane).hidden).toBe(true);
  });

  // Stepped past and back while its first read is slow, the page fills
  // from the read it is showing for, never the stale one.
  it("steps between notes and pictures, filling a note from its latest read only", async () => {
    const reads: ((file: FileResponse) => void)[] = [];
    const loadFile = vi.fn(() => new Promise<FileResponse>((resolve) => reads.push(resolve)));
    const { pane } = setup([inFolder("a.png"), inFolder("b.md"), inFolder("c.png")], { loadFile });
    await open(pane, "notes");
    const arrow = (side: string) => previewOf(pane).querySelector(`.file-preview-nav.is-${side}`) as HTMLElement;

    tileNamed(pane, "a").click();
    arrow("next").click();
    expect(pageOf(pane)).not.toBeNull();
    arrow("next").click();
    expect(previewOf(pane).querySelector("img")?.getAttribute("src")).toBe("/raw?path=notes/c.png");
    arrow("prev").click();
    reads[0](textFile("notes/b.md", "# Old\n"));
    await settle();
    expect(pageOf(pane).textContent).toBe("");
    reads[1](textFile("notes/b.md", "# New\n"));
    await settle();
    expect(pageOf(pane).querySelector<HTMLInputElement>(".editor-title-input")?.value).toBe("New");
  });

  it("scrolls the note by key, the arrows still stepping", async () => {
    const { pane } = await previewed("a.md");
    const page = pageOf(pane);
    Object.defineProperty(page, "clientHeight", { value: 300 });
    Object.defineProperty(page, "scrollHeight", { value: 2000 });
    Object.defineProperty(page, "scrollTop", { value: 0, writable: true });

    press(pane.element, "ArrowDown");
    expect(page.scrollTop).toBe(40);
    press(pane.element, "PageDown");
    expect(page.scrollTop).toBe(300);
    press(pane.element, "End");
    expect(page.scrollTop).toBe(2000);
    press(pane.element, "Home");
    expect(page.scrollTop).toBe(0);
    press(pane.element, "ArrowRight");
    expect(previewOf(pane).querySelector("img")?.getAttribute("src")).toBe("/raw?path=notes/z.png");
  });

  it("says in the page why the note couldn't be read", async () => {
    const { pane } = await previewed("a.md", {
      loadFile: vi.fn(async () => {
        throw new Error("No file at notes/a.md");
      }),
    });
    expect(pageOf(pane).textContent).toBe("No file at notes/a.md");
  });

  // A refresh may move the previewed entry or take it away. It is nobody's
  // keypress, so closing leaves focus where it was.
  it("follows its entry through a refresh, and closes without taking focus once it is gone", async () => {
    let listing = [inFolder("b.md")];
    const { pane, deps } = setup([], { listFolder: vi.fn(async () => ({ entries: listing, order: BY_NAME })) });
    await open(pane, "notes");
    tileNamed(pane, "b").click();
    await settle();

    listing = [inFolder("a.png"), inFolder("b.md")];
    pane.refresh();
    await settle();
    press(pane.element, "Enter");
    expect(deps.openEntry).toHaveBeenLastCalledWith("notes/b.md", { anchor: expect.any(HTMLElement), marked: true });

    const elsewhere = document.createElement("input");
    document.body.append(elsewhere);
    elsewhere.focus();
    listing = [inFolder("a.png")];
    pane.refresh();
    await settle();
    expect(previewOf(pane).hidden).toBe(true);
    expect(document.activeElement).toBe(elsewhere);
  });
});

describe("a previewed Table", () => {
  // In a library, so what its path cells name is taken on trust.
  const takes = (path: string): TableFileResponse => ({
    kind: "table",
    path,
    revision: "r1",
    version: "1.0",
    name: "Takes",
    columns: [
      { id: "take", label: "Take", type: "text" },
      { id: "ref", label: "Ref", type: "path" },
    ],
    rows: [{ values: { take: "one", ref: "z.png" } }, { values: { take: "two", ref: "" } }],
  });
  const previewOf = (pane: GalleryPane) => pane.element.querySelector(".file-preview") as HTMLElement;
  const pageOf = (pane: GalleryPane) => pane.element.querySelector(".file-preview-page") as HTMLElement;
  async function previewed() {
    const shown = setup([file("takes.table.html"), file("z.png")], {
      loadFile: vi.fn(async (path: string): Promise<FileResponse> => takes(path)),
    });
    await open(shown.pane);
    tileNamed(shown.pane, "takes").click();
    await settle();
    return shown;
  }

  it("shows the Table on a note's page as its tab reads it, with its name and size on the bar", async () => {
    const { pane, deps } = await previewed();
    expect(previewOf(pane).hidden).toBe(false);
    expect(deps.loadFile).toHaveBeenCalledWith("lib:footage/takes.table.html");
    const frame = previewOf(pane).querySelector(".file-preview-document") as HTMLElement;
    expect(frame.style.getPropertyValue("--page-scale")).toBe(String(PAGE_PREVIEW_SCALE));
    expect(pageOf(pane).classList.contains("table-page")).toBe(true);
    expect(pageOf(pane).querySelector<HTMLInputElement>(".editor-title-input")?.value).toBe("Takes");
    expect([...pageOf(pane).querySelectorAll("tbody tr")].map((row) => row.firstElementChild?.textContent)).toEqual([
      "one",
      "two",
    ]);
    const bar = [...previewOf(pane).querySelectorAll(".media-hud-bar > *")].map((cell) => cell.textContent);
    expect(bar).toEqual(["takes.table.html", "2 columns · 2 rows", ""]);
  });

  it("stays open for a click on its page, opens a path cell's entry here, and steps on", async () => {
    const { pane, deps } = await previewed();
    pageOf(pane)
      .querySelector("td")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    expect(previewOf(pane).hidden).toBe(false);

    (pageOf(pane).querySelector(".path-field-entry") as HTMLButtonElement).click();
    expect(deps.openPath).toHaveBeenCalledWith("lib:footage/z.png");

    press(pane.element, "ArrowRight");
    expect(previewOf(pane).querySelector("img")?.getAttribute("src")).toBe("/raw?path=lib:footage/z.png");
  });
});

describe("a previewed screenplay", () => {
  // A note, which Fountain never prints: reading view leaves it out.
  const script = "INT. CELLAR - NIGHT\n\nAda climbs. [[louder?]]";
  const previewOf = (pane: GalleryPane) => pane.element.querySelector(".file-preview") as HTMLElement;
  const pageOf = (pane: GalleryPane) => pane.element.querySelector(".file-preview-page") as HTMLElement;

  it("shows the screenplay as its reading view does, with the status bar's count, and lets its editor go", async () => {
    const { pane, deps } = setup([file("act.fountain"), file("z.png")], {
      formats: testFormats(),
      loadFile: vi.fn(
        async (path: string): Promise<FileResponse> => ({
          kind: "text",
          path,
          revision: "r1",
          content: script,
          documentType: "screenplay",
          toolkits: [],
          classLinks: [],
        }),
      ),
    });
    await open(pane);
    tileNamed(pane, "act").click();
    await settle();

    expect(deps.loadFile).toHaveBeenCalledWith("lib:footage/act.fountain");
    expect(pageOf(pane).classList.contains("editor-page")).toBe(true);
    const editor = pageOf(pane).querySelector(".cm-editor.fountain-editor") as HTMLElement;
    const view = EditorView.findFromDOM(editor) as EditorView;
    expect(view.state.readOnly).toBe(true);
    expect([...editor.querySelectorAll(".cm-line")].map((line) => line.textContent)).toEqual([
      "INT. CELLAR - NIGHT",
      "",
      "Ada climbs.",
    ]);
    const bar = [...previewOf(pane).querySelectorAll(".media-hud-bar > *")].map((cell) => cell.textContent);
    expect(bar).toEqual(["act.fountain", "7 words · 44 characters", ""]);

    const destroy = vi.spyOn(view, "destroy");
    press(pane.element, "ArrowRight");
    expect(previewOf(pane).querySelector("img")?.getAttribute("src")).toBe("/raw?path=lib:footage/z.png");
    expect(destroy).toHaveBeenCalledTimes(1);
  });
});
