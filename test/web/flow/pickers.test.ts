// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { RootedPath } from "../../../src/protocol/rootedPath.ts";
import type { FlowNodeInstance } from "../../../src/protocol/types.ts";
import { ApiError, type SandboxReadResult, type SpaceTreeNode } from "../../../web/core/apiClient.ts";
import { DRAGGED_ENTRY_TYPE, noteDragInFlight } from "../../../web/core/paths.ts";
import type { WritePathOptions } from "../../../web/core/spaceTree.ts";
import { createPickers, describeClip, type PickerDeps, type Pickers } from "../../../web/flow/pickers.ts";
import { fakeDrag } from "../support/drag.ts";
import { fakeContextMenu } from "../support/fakeContextMenu.ts";

// The folders the space's scopes open over, as the tree's listing has them.
const listing = vi.hoisted(() => ({ scopes: new Set<string>() }));
vi.mock("../../../web/core/spaceTree.ts", async (importOriginal) => {
  const { formatWrittenPath } = await import("../../../src/protocol/relativeReference.ts");
  return {
    ...(await importOriginal<typeof import("../../../web/core/spaceTree.ts")>()),
    scopesOf: () => listing.scopes,
    writePathFrom: (docDir: string, target: RootedPath, options: WritePathOptions = {}) =>
      formatWrittenPath(docDir, target, {
        form: options.form ?? "markdown",
        folder: options.folder,
        scopes: options.scopes ?? listing.scopes,
      }),
  };
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function node(type: string, config: Record<string, unknown> = {}): FlowNodeInstance {
  return { id: `${type}-1`, type, position: { x: 0, y: 0 }, config } as FlowNodeInstance;
}

const table: SandboxReadResult = {
  kind: "table",
  columns: [
    { id: "name", label: "Name", type: "text" },
    { id: "weight", label: "Weight", type: "integer" },
  ],
  rows: [{ values: { name: "A", weight: "1" } }, { values: { name: "B", weight: "2" } }],
};

function file(path: string): SpaceTreeNode {
  return { name: path, path, type: "file" } as SpaceTreeNode;
}

function setup(overrides: Partial<PickerDeps> = {}) {
  const deps: PickerDeps = {
    persistGraph: vi.fn(),
    saveGraphNow: vi.fn(async () => true),
    ensureCapability: vi.fn(async () => true),
    read: vi.fn(async () => table),
    pickedImages: new Map(),
    directoryChildren: vi.fn((dirPath: string) =>
      dirPath === "notes" ? [file("notes/a.md"), file("notes/b.md"), file("notes/pic.png")] : undefined,
    ),
    flowPath: () => "story.flow.html",
    bindExposeToggle: vi.fn(),
    sourceOf: vi.fn(() => undefined),
    sourceLoaded: vi.fn(),
    openChipMenu: vi.fn(),
    fileMissing: vi.fn(),
    layoutChanged: vi.fn(),
    remount: vi.fn(),
    previewResult: vi.fn(),
    contextMenu: fakeContextMenu(),
    ...overrides,
  };
  return { deps, pickers: createPickers(deps) };
}

// A drop of an entry dragged from Pragma's own tree, whose row notes the path
// in flight until the drag ends. `foreign` drops the same text with no such
// drag, as a link dragged out of a note or another app's drag does.
function drop(zone: Element, path: string, foreign = false): void {
  const event = new Event("drop", { bubbles: true, cancelable: true }) as DragEvent;
  Object.defineProperty(event, "dataTransfer", { value: { getData: () => path, files: [] } });
  if (!foreign) noteDragInFlight(path);
  zone.dispatchEvent(event);
  noteDragInFlight(undefined);
}

const zoneOf = (el: HTMLElement) => el.querySelector(".flow-dropzone") as HTMLElement;
// Load Image's picture zone, under its chip.
const pictureOf = (el: HTMLElement) => el.querySelector(".flow-dropzone:not(.flow-space-drop)") as HTMLElement;
const chipOf = (el: HTMLElement) => el.querySelector(".flow-space-drop") as HTMLElement;
const selectOf = (el: HTMLElement) => el.querySelector("select") as HTMLSelectElement;

describe("pickers", () => {
  it("the table picker fills its dropdown from the table's first column, through the capability gate", async () => {
    const { deps, pickers } = setup();
    const flowNode = node("loadRow", { tablePath: "t.table.html" });
    const selectedLabel = document.createElement("span");
    const el = pickers.createLoadTablePicker(flowNode, selectedLabel).el;
    await tick();
    await tick();

    // Mounted from a path the saved file already carried, not a live drag —
    // so this one still asks.
    expect(deps.ensureCapability).toHaveBeenCalledWith({ type: "readFile", path: "t.table.html" }, false);
    expect(deps.read).toHaveBeenCalledWith("t.table.html");
    expect([...selectOf(el).options].map((o) => o.value)).toEqual(["A", "B"]);
    expect(selectOf(el).disabled).toBe(false);
    // Whatever reads fields off this row re-reads them now the table loaded.
    expect(deps.sourceLoaded).toHaveBeenCalledWith("loadRow-1");
    expect(selectedLabel.textContent).toBe("Name");
    expect(el.querySelector(".flow-config-label")?.textContent).toBe("Select Name");
    // No stored value: the first row is picked and persisted.
    expect(flowNode.config.selectedValue).toBe("A");
    expect(deps.persistGraph).toHaveBeenCalled();
    expect(deps.bindExposeToggle).toHaveBeenCalledWith(
      flowNode,
      "selectedValue",
      "text",
      expect.anything(),
      expect.anything(),
    );

    selectOf(el).value = "B";
    selectOf(el).dispatchEvent(new Event("change"));
    expect(flowNode.config.selectedValue).toBe("B");
  });

  it("a denied or missing read leaves the dropdown disabled and the labels generic", async () => {
    const { deps, pickers } = setup({ ensureCapability: vi.fn(async () => false) });
    const selectedLabel = document.createElement("span");
    const el = pickers.createLoadTablePicker(node("loadRow", { tablePath: "t.table.html" }), selectedLabel).el;
    await tick();
    expect(selectOf(el).disabled).toBe(true);
    expect(selectedLabel.textContent).toBe("selected");
    expect(deps.sourceLoaded).not.toHaveBeenCalled();
  });

  it("a dropped path must be a table; anything else is refused in place", async () => {
    const { deps, pickers } = setup();
    const flowNode = node("loadRow");
    const el = pickers.createLoadTablePicker(flowNode, document.createElement("span")).el;
    drop(zoneOf(el), "notes/a.md");
    expect(zoneOf(el).textContent).toBe("Not a table: notes/a.md");
    expect(flowNode.config.tablePath).toBeUndefined();

    drop(zoneOf(el), "t.table.html");
    expect(flowNode.config.tablePath).toBe("t.table.html");
    expect(zoneOf(el).classList.contains("loaded")).toBe(true);
    expect(zoneOf(el).querySelector(".path-label-name")?.textContent).toBe("t.table.html");
    await tick();
    expect(deps.read).toHaveBeenCalledWith("t.table.html");
  });

  it("a loaded drop target keeps its path over the note's title, and a refusal shows only briefly over it", async () => {
    vi.useFakeTimers();
    try {
      const { pickers } = setup({
        read: vi.fn(
          async () =>
            ({
              kind: "text",
              content: "---\nstatus: draft\n---\n# The *Opening*\n\nOne two three.",
            }) as SandboxReadResult,
        ),
      });
      const el = pickers.createLoadNotePicker(node("loadNote", { notePath: "scenes/act-1/opening.md" })).el;
      const zone = zoneOf(el);
      expect(zone.querySelector(".path-label-name")?.textContent).toBe("opening.md");
      await vi.runAllTimersAsync();
      expect(zone.querySelector(".path-label-name")?.textContent).toBe("opening.md");
      expect(el.querySelector(".flow-node-detail")?.textContent).toMatch(/^\d+ words · /);

      drop(zone, "t.table.html");
      expect(zone.classList.contains("loaded")).toBe(false);
      expect(zone.textContent).toMatch(/Use a Load Row node/);
      vi.advanceTimersByTime(5000);
      expect(zone.classList.contains("loaded")).toBe(true);
      expect(zone.querySelector(".path-label-name")?.textContent).toBe("opening.md");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a chip is its path, drawn as a path label, with no separate path field", () => {
    const { pickers } = setup();
    const applet = (appletPath: string) =>
      zoneOf(pickers.createAppletPicker(node("applet", { appletPath }), vi.fn()).el);
    const zone = applet("projects/studio/stage.applet.html");
    expect(zone.querySelector(".path-label")?.textContent).toBe("projects/studio/stage.applet.html");
    expect(zone.querySelector(".path-label-name")?.textContent).toBe("stage.applet.html");
    expect(zone.dataset.tooltip).toBe("projects/studio/stage.applet.html");
    expect(zone.parentElement?.querySelector(".flow-node-path-field")).toBeNull();
    expect(applet("stage.applet.html").querySelector(".path-label")?.textContent).toBe("stage.applet.html");
    expect(applet("projects/studio/sets/stage.applet.html").querySelector(".path-label")?.textContent).toBe(
      "projects/studio/sets/stage.applet.html",
    );

    const row = zoneOf(
      pickers.createLoadTablePicker(
        node("loadRow", { tablePath: "cast/people.table.html" }),
        document.createElement("span"),
      ).el,
    );
    expect(row.querySelector(".path-label")?.textContent).toBe("cast/people.table.html");
    expect(row.querySelector(".path-label-name")?.textContent).toBe("people.table.html");
    expect(row.parentElement?.querySelector(".flow-node-path-field")).toBeNull();
  });

  // A Flow reads a path from its own folder, so a dragged entry is written
  // from there: relative within the Flow's closest scope, from the root
  // otherwise, encoded as a link is.
  it("writes a dragged entry from the Flow's folder by the scope rule", () => {
    const { pickers } = setup({ flowPath: () => "projects/log/shots.flow.html" });
    const flowNode = node("addRow");
    const el = pickers.createAddRowPicker(flowNode, vi.fn()).el;
    drop(zoneOf(el), "tags.table.html");
    expect(flowNode.config.tablePath).toBe("../../tags.table.html");
    // The card is rebuilt on a new Table; its chip shows the path as the tree does.
    const chip = zoneOf(pickers.createAddRowPicker(flowNode, vi.fn()).el);
    expect(chip.querySelector(".path-label")?.textContent).toBe("tags.table.html");
    expect(chip.dataset.tooltip).toBe("tags.table.html");

    drop(zoneOf(el), "projects/log/my shots.table.html");
    expect(flowNode.config.tablePath).toBe("my%20shots.table.html");
    try {
      listing.scopes = new Set(["projects/log"]);
      drop(zoneOf(el), "tags.table.html");
      expect(flowNode.config.tablePath).toBe("/tags.table.html");
    } finally {
      listing.scopes = new Set();
    }
  });

  it("a chip's right-click offers what it names, spelled as the tree spells it", () => {
    const { deps, pickers } = setup();
    const contextMenuOn = (el: Element) =>
      el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 6 }));

    contextMenuOn(chipOf(pickers.createLoadNotePicker(node("loadNote", { notePath: "space:notes/a.md" })).el));
    expect(deps.openChipMenu).toHaveBeenLastCalledWith(5, 6, { file: "notes/a.md" }, expect.any(Function));
    contextMenuOn(chipOf(pickers.createDropzone(node("loadImage", { imagePath: "lib:footage/sunset.png" })).el));
    expect(deps.openChipMenu).toHaveBeenLastCalledWith(5, 6, { file: "lib:footage/sunset.png" }, expect.any(Function));
    contextMenuOn(chipOf(pickers.createLoadFolderNotePicker(node("loadFolderNote", { folderPath: "notes" })).el));
    expect(deps.openChipMenu).toHaveBeenLastCalledWith(5, 6, { folder: "notes" }, expect.any(Function));

    // An empty target names nothing, so the canvas's own handling stands.
    const empty = chipOf(pickers.createLoadTableRowsPicker(node("loadTableRows")).el);
    expect(contextMenuOn(empty)).toBe(true);
    expect(deps.openChipMenu).toHaveBeenCalledTimes(3);
  });

  // The Clear a chip hands its menu, as a right-click on the chip would.
  function chipClear(deps: PickerDeps, chip: Element): () => void {
    chip.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    const clear = vi.mocked(deps.openChipMenu).mock.lastCall?.[3];
    if (!clear) throw new Error("no Clear");
    return clear;
  }

  // A node forgets its path and what came with it, and the card is drawn
  // again from what is left, a missing file's report taken back first.
  it("a chip's Clear empties the node's path and what came with it", async () => {
    const { deps, pickers } = setup();
    const row = node("loadRow", { tablePath: "space:t.table.html", selectedValue: "B" });
    chipClear(deps, chipOf(pickers.createLoadTablePicker(row, document.createElement("span")).el))();
    expect(row.config).toEqual({});
    expect(deps.persistGraph).toHaveBeenCalled();
    expect(deps.remount).toHaveBeenLastCalledWith("loadRow-1");

    const folder = node("loadFolderNote", { folderPath: "notes", notePath: "notes/a.md" });
    chipClear(deps, chipOf(pickers.createLoadFolderNotePicker(folder).el))();
    expect(folder.config).toEqual({});

    const applet = node("applet", { appletPath: "space:a.applet.html", state: { x: 1 } });
    chipClear(deps, chipOf(pickers.createAppletPicker(applet, vi.fn()).el))();
    expect(applet.config).toEqual({});

    const read = vi.fn(async (): Promise<SandboxReadResult> => {
      throw new ApiError('No file at "gone.md"', 404);
    });
    const gone = setup({ read });
    const note = node("loadNote", { notePath: "gone.md" });
    const el = gone.pickers.createLoadNotePicker(note).el;
    await tick();
    await tick();
    expect(gone.deps.fileMissing).toHaveBeenLastCalledWith("loadNote-1", 'No file at "gone.md"');
    chipClear(gone.deps, chipOf(el))();
    expect(gone.deps.fileMissing).toHaveBeenLastCalledWith("loadNote-1", undefined);
    expect(note.config.notePath).toBeUndefined();
  });

  // The results folder is read only by the next run, so the card keeps its
  // last result; Load Image's chip clears the picture too.
  it("a results folder's Clear keeps the card, and Load Image's clears its picture", async () => {
    const { deps, pickers } = setup();
    const generate = node("generateImage", { outputFolderPath: "renders" });
    const chip = chipOf(pickers.createGenerationPicker(generate, vi.fn()).el);
    chipClear(deps, chip)();
    expect(generate.config.outputFolderPath).toBeUndefined();
    expect(deps.remount).not.toHaveBeenCalled();
    expect(chip.classList.contains("loaded")).toBe(false);

    const image: SandboxReadResult = { kind: "image", mediaType: "image/png", data: "AAAA" };
    const loaded = setup({ read: vi.fn(async () => image) });
    const picture = node("loadImage", { imagePath: "art/a.png" });
    const el = loaded.pickers.createDropzone(picture).el;
    await tick();
    await tick();
    chipClear(loaded.deps, chipOf(el))();
    expect(picture.config.imagePath).toBeUndefined();
    expect(chipOf(el).hidden).toBe(true);
    expect(pictureOf(el).querySelector("img")).toBeNull();
  });

  it("an empty drop target prompts for a drag", () => {
    const { pickers } = setup();
    const zone = zoneOf(pickers.createLoadTableRowsPicker(node("loadTableRows")).el);
    expect(zone.classList.contains("loaded")).toBe(false);
    expect(zone.textContent).toBe("Drag a Table from your space here");
  });

  // Run fails on the path with this same 404, so the card says so first, in
  // the same words and the same place.
  it("every loader that reads its file reports a path with nothing at it in its error line", async () => {
    const loaders = (pickers: Pickers) => {
      const span = document.createElement("span");
      return [
        pickers.createLoadNotePicker(node("loadNote", { notePath: "gone.md" })).el,
        pickers.createLoadTableRowsPicker(node("loadTableRows", { tablePath: "gone.table.html" })).el,
        pickers.createLoadRandomRowPicker(node("loadRandomRow", { tablePath: "gone.table.html" }), span).el,
        pickers.createLoadTablePicker(node("loadRow", { tablePath: "gone.table.html" }), span).el,
      ];
    };
    const ids = ["loadNote-1", "loadTableRows-1", "loadRandomRow-1", "loadRow-1"];

    const gone = setup({ read: vi.fn(async () => Promise.reject(new ApiError('No table at "gone"', 404))) });
    const goneEls = loaders(gone.pickers);
    await tick();
    await tick();
    for (const [index, el] of goneEls.entries()) {
      expect(chipOf(el).classList.contains("missing"), ids[index]).toBe(true);
      expect(gone.deps.fileMissing).toHaveBeenCalledWith(ids[index], 'No table at "gone"');
      expect(el.querySelector(".flow-node-detail:not([hidden])"), ids[index]).toBeNull();
      // The chip keeps naming the path: it is what the fix starts from.
      expect(chipOf(el).querySelector(".path-label-name")?.textContent).toMatch(/^gone\./);
    }

    // Any other failure says nothing, and a chip that was never missing
    // leaves the error line, and whatever a run wrote there, alone.
    const unreadable = setup({ read: vi.fn(async () => Promise.reject(new ApiError("Malformed table", 400))) });
    const unreadableEls = loaders(unreadable.pickers);
    await tick();
    await tick();
    for (const el of unreadableEls) expect(chipOf(el).classList.contains("missing")).toBe(false);
    expect(unreadable.deps.fileMissing).not.toHaveBeenCalled();
  });

  it("a missing chip goes back to normal, and its error line clears, once a file is dropped on it", async () => {
    const read = vi.fn(
      async (): Promise<SandboxReadResult> => Promise.reject(new ApiError('No file at "notes/gone.md"', 404)),
    );
    const { deps, pickers } = setup({ read });
    const el = pickers.createLoadNotePicker(node("loadNote", { notePath: "notes/gone.md" })).el;
    await tick();
    await tick();
    expect(chipOf(el).classList.contains("missing")).toBe(true);
    expect(deps.fileMissing).toHaveBeenLastCalledWith("loadNote-1", 'No file at "notes/gone.md"');

    read.mockResolvedValue({ kind: "text", content: "One two." });
    drop(zoneOf(el), "notes/a.md");
    expect(chipOf(el).classList.contains("missing")).toBe(false);
    expect(deps.fileMissing).toHaveBeenLastCalledWith("loadNote-1", undefined);
    await tick();
    await tick();
    expect(el.querySelector(".flow-node-detail")?.textContent).toBe("2 words · 8 chars");
    expect(deps.fileMissing).toHaveBeenCalledTimes(2);
  });

  it("the random-row picker offers only integer columns to weight by, and hides the field otherwise", async () => {
    const { pickers } = setup();
    const el = pickers.createLoadRandomRowPicker(
      node("loadRandomRow", { tablePath: "t.table.html" }),
      document.createElement("span"),
    ).el;
    await tick();
    await tick();
    const field = el.querySelector(".flow-config-field") as HTMLElement;
    expect(field.hidden).toBe(false);
    expect([...selectOf(el).options].map((o) => o.textContent)).toEqual(["None (uniform)", "Weight"]);

    const textOnly = setup({
      read: vi.fn(async () => ({ ...table, columns: [table.columns[0]] }) as SandboxReadResult),
    });
    const el2 = textOnly.pickers.createLoadRandomRowPicker(
      node("loadRandomRow", { tablePath: "t.table.html", weightColumn: "weight" }),
      document.createElement("span"),
    ).el;
    await tick();
    await tick();
    expect((el2.querySelector(".flow-config-field") as HTMLElement).hidden).toBe(true);
  });

  it("the note picker redirects a table or image drop and accepts a note", () => {
    const { deps, pickers } = setup();
    const noteNode = node("loadNote");
    const noteEl = pickers.createLoadNotePicker(noteNode).el;
    drop(zoneOf(noteEl), "t.table.html");
    expect(zoneOf(noteEl).textContent).toMatch(/Use a Load Row node/);
    drop(zoneOf(noteEl), "pic.png");
    expect(zoneOf(noteEl).textContent).toMatch(/Use a Load Image node/);
    drop(zoneOf(noteEl), "notes/a.md");
    expect(noteNode.config.notePath).toBe("notes/a.md");
    expect(deps.persistGraph).toHaveBeenCalledTimes(1);
  });

  it("the folder pickers list a folder's direct notes or images from the tree, no read needed", () => {
    const { deps, pickers } = setup();
    const noteNode = node("loadFolderNote", { folderPath: "notes" });
    const noteEl = pickers.createLoadFolderNotePicker(noteNode).el;
    expect([...selectOf(noteEl).options].map((o) => [o.value, o.textContent])).toEqual([
      ["notes/a.md", "a"],
      ["notes/b.md", "b"],
    ]);
    expect(noteNode.config.notePath).toBe("notes/a.md");
    expect(zoneOf(noteEl).querySelector(".path-label-name")?.textContent).toBe("notes");
    expect(noteEl.querySelector(".flow-node-detail")?.textContent).toBe("2 notes");

    // A folder, dropped, is written with its `/`; the pick inside it is
    // written as a drop of that file would be.
    const imageNode = node("loadFolderImage");
    const imageEl = pickers.createLoadFolderImagePicker(imageNode).el;
    drop(zoneOf(imageEl), "notes/a.md");
    expect(zoneOf(imageEl).textContent).toBe("Not a folder: notes/a.md");
    drop(zoneOf(imageEl), "notes");
    expect(imageNode.config.folderPath).toBe("notes/");
    expect([...selectOf(imageEl).options].map((o) => [o.value, o.textContent])).toEqual([["notes/pic.png", "pic"]]);
    expect(imageNode.config.imagePath).toBe("notes/pic.png");
    expect(zoneOf(imageEl).querySelector(".path-label-name")?.textContent).toBe("notes");
    expect(deps.read).not.toHaveBeenCalled();
  });

  it("the Write Folder Note picker takes a space folder by a drag, which grants nothing", () => {
    const { deps, pickers } = setup();
    const folderNode = node("writeFolderNote");
    const zone = zoneOf(pickers.createWriteFolderNotePicker(folderNode).el);
    drop(zone, "notes/a.md");
    expect(zone.textContent).toBe("Not a folder: notes/a.md");
    drop(zone, "lib:footage");
    expect(zone.textContent).toBe("A library file can only go in a note, a media field or a Load Image node.");
    expect(folderNode.config.folderPath).toBeUndefined();

    drop(zone, "notes");
    expect(folderNode.config.folderPath).toBe("notes/");
    expect(zone.querySelector(".path-label-name")?.textContent).toBe("notes");
    expect(deps.persistGraph).toHaveBeenCalledTimes(1);
    expect(deps.ensureCapability).not.toHaveBeenCalled();
  });

  it("a pick its folder or table no longer has stays, shown missing, and nothing is saved", async () => {
    const { deps, pickers } = setup();
    const noteNode = node("loadFolderNote", { folderPath: "notes", notePath: "notes/gone.md" });
    const noteEl = pickers.createLoadFolderNotePicker(noteNode).el;
    expect([...selectOf(noteEl).options].map((o) => [o.value, o.textContent, o.disabled])).toEqual([
      ["notes/gone.md", "gone (missing)", true],
      ["notes/a.md", "a", false],
      ["notes/b.md", "b", false],
    ]);
    expect(selectOf(noteEl).value).toBe("notes/gone.md");

    const imageNode = node("loadFolderImage", { folderPath: "notes", imagePath: "notes/gone.png" });
    const imageEl = pickers.createLoadFolderImagePicker(imageNode).el;
    expect(selectOf(imageEl).value).toBe("notes/gone.png");
    expect(selectOf(imageEl).options[0].textContent).toBe("gone (missing)");

    const rowNode = node("loadRow", { tablePath: "t.table.html", selectedValue: "C" });
    const rowEl = pickers.createLoadTablePicker(rowNode, document.createElement("span")).el;
    await tick();
    await tick();
    expect([...selectOf(rowEl).options].map((o) => o.textContent)).toEqual(["C (missing)", "A", "B"]);
    expect(selectOf(rowEl).value).toBe("C");

    expect([noteNode.config.notePath, imageNode.config.imagePath, rowNode.config.selectedValue]).toEqual([
      "notes/gone.md",
      "notes/gone.png",
      "C",
    ]);
    expect(deps.persistGraph).not.toHaveBeenCalled();

    selectOf(noteEl).value = "notes/b.md";
    selectOf(noteEl).dispatchEvent(new Event("change"));
    expect(noteNode.config.notePath).toBe("notes/b.md");
  });

  it("dropping a different folder or table drops the old pick for the new one's first", async () => {
    const { pickers } = setup({
      directoryChildren: vi.fn((dirPath: string) =>
        dirPath === "notes" ? [file("notes/a.md")] : dirPath === "other" ? [file("other/c.md")] : undefined,
      ),
    });
    // The same folder, however it was written, keeps its pick as written.
    const noteNode = node("loadFolderNote", { folderPath: "space:notes", notePath: "space:notes/a.md" });
    const noteEl = pickers.createLoadFolderNotePicker(noteNode).el;
    drop(zoneOf(noteEl), "notes");
    expect(noteNode.config.notePath).toBe("space:notes/a.md");
    drop(zoneOf(noteEl), "other");
    expect(noteNode.config.notePath).toBe("other/c.md");

    const rowNode = node("loadRow", { tablePath: "space:t.table.html", selectedValue: "B" });
    const rowEl = pickers.createLoadTablePicker(rowNode, document.createElement("span")).el;
    drop(zoneOf(rowEl), "u.table.html");
    await tick();
    await tick();
    expect(rowNode.config.selectedValue).toBe("A");
  });

  // A folder loader's pick, with its `path` output beside it, sits under the
  // chip and its stat line, so a placed card is measured again when they
  // change. A card being built is measured once it is placed.
  it("asks for its card to be measured again when a placed chip changes", () => {
    const { deps, pickers } = setup();
    const picker = pickers.createLoadFolderNotePicker(node("loadFolderNote"));
    expect(deps.layoutChanged).not.toHaveBeenCalled();
    document.body.append(picker.el);
    try {
      drop(zoneOf(picker.el), "notes");
      expect(deps.layoutChanged).toHaveBeenCalledWith("loadFolderNote-1");
      expect(picker.target).toBe(selectOf(picker.el));
    } finally {
      picker.el.remove();
    }
  });

  it("the image dropzone loads a space image through a checked save and the gate, and takes a dropped file", async () => {
    const image: SandboxReadResult = { kind: "image", mediaType: "image/png", data: "AAAA" };
    const { deps, pickers } = setup({ read: vi.fn(async () => image) });
    const flowNode = node("loadImage");
    const el = pickers.createDropzone(flowNode).el;
    const zone = pictureOf(el);

    drop(zone, "notes/a.md");
    expect(zone.textContent).toBe("Not a raster image: notes/a.md");

    expect(chipOf(el).hidden).toBe(true);
    drop(zone, "pic.png");
    expect(flowNode.config.imagePath).toBe("pic.png");
    expect([chipOf(el).hidden, chipOf(el).textContent, chipOf(el).dataset.tooltip]).toEqual([
      false,
      "pic.png",
      "pic.png",
    ]);
    await tick();
    await tick();
    expect(deps.saveGraphNow).toHaveBeenCalled();
    // Dragged in, so the grant is recorded without a prompt.
    expect(deps.ensureCapability).toHaveBeenCalledWith({ type: "readFile", path: "pic.png" }, true);
    expect(zone.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,AAAA");
    const bars = [...el.querySelectorAll(".media-hud-bar:last-child > span")].map((cell) => cell.textContent);
    expect(bars).toEqual(["pic.png", "3 B"]);

    const png = new File([new Uint8Array([1, 2, 3])], "shot.png", { type: "image/png" });
    zone.dispatchEvent(fakeDrag("drop", { files: [png] }).event);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(deps.pickedImages.get(flowNode.id)?.name).toBe("shot.png");
    expect(flowNode.config.imagePath).toBeUndefined(); // a file pick replaces the space path
    expect(chipOf(el).textContent).toBe("shot.pngnot stored");
    // The hover bars carry its dimensions, so the card has no line for them.
    expect(el.querySelector(".flow-node-detail:not([hidden])")).toBeNull();
  });

  // A picture dragged from Pragma brings a copy of its bytes beside its file.
  it("the image dropzone links a picture dragged from Pragma, never its copy", async () => {
    const { deps, pickers } = setup();
    const flowNode = node("loadImage");
    const copy = new File([new Uint8Array([1, 2, 3])], "raw.png", { type: "image/png" });
    const data = { "text/plain": "pic.png", [DRAGGED_ENTRY_TYPE]: "file" };
    pictureOf(pickers.createDropzone(flowNode).el).dispatchEvent(fakeDrag("drop", { data, files: [copy] }).event);
    expect(flowNode.config.imagePath).toBe("pic.png");
    expect(deps.pickedImages.has(flowNode.id)).toBe(false);
    await tick();
    await tick();
  });

  // Refused on a drop, left out of a folder's list, and a saved path to one
  // says so before any run, in the run's words, asking for nothing.
  it("the image pickers take no vector image", async () => {
    const { deps, pickers } = setup({ directoryChildren: vi.fn(() => [file("art/logo.svg"), file("art/cover.png")]) });
    const dropped = node("loadImage");
    const el = pickers.createDropzone(dropped).el;
    drop(pictureOf(el), "art/logo.svg");
    expect(pictureOf(el).textContent).toBe("Not a raster image: art/logo.svg");
    expect(dropped.config.imagePath).toBeUndefined();

    const saved = pickers.createDropzone(node("loadImage", { imagePath: "space:art/logo.svg" })).el;
    await tick();
    expect(pictureOf(saved).textContent).toBe('"space:art/logo.svg" is a vector image, not a raster image');
    expect(deps.ensureCapability).not.toHaveBeenCalled();
    expect(deps.read).not.toHaveBeenCalled();

    const folderEl = pickers.createLoadFolderImagePicker(node("loadFolderImage", { folderPath: "art" })).el;
    expect([...selectOf(folderEl).options].map((o) => o.value)).toEqual(["art/cover.png"]);
  });

  // What the image zone's right-click adds after Expose, as it would open now.
  function zoneActions(deps: PickerDeps) {
    const call = vi.mocked(deps.bindExposeToggle).mock.calls.find(([, id]) => id === "imagePath");
    return call?.[5]?.() ?? [];
  }
  const zoneAction = (deps: PickerDeps, label: string) => zoneActions(deps).find((item) => item.label === label);

  // The card has no buttons: the prompt opens the computer's picker, and the
  // picture's right-click chooses another or clears an optional image that
  // would otherwise go with every run.
  it("the image zone's right-click offers Choose image… and Clear while it shows a picture", async () => {
    const image: SandboxReadResult = { kind: "image", mediaType: "image/png", data: "AAAA" };
    const { deps, pickers } = setup({ read: vi.fn(async () => image) });
    const flowNode = node("loadImage", { imagePath: "pic.png" });
    const el = pickers.createDropzone(flowNode).el;
    expect(el.querySelector("button")).toBeNull();
    expect(el.firstElementChild).toBe(chipOf(el));
    expect(zoneActions(deps)).toEqual([]);
    await tick();
    await tick();
    expect(zoneActions(deps).map((item) => item.label)).toEqual(["Choose image…", "Clear"]);
    const clear = zoneAction(deps, "Clear");

    deps.pickedImages.set(flowNode.id, { mediaType: "image/png", data: "AAAA", name: "x.png" });
    clear?.run?.({} as never, undefined);
    expect(flowNode.config.imagePath).toBeUndefined();
    expect(deps.pickedImages.has(flowNode.id)).toBe(false);
    expect(pictureOf(el).textContent).toBe("Click or drop an image");
    expect(chipOf(el).hidden).toBe(true);
    expect(zoneActions(deps)).toEqual([]);
    expect(deps.persistGraph).toHaveBeenCalled();
  });

  it("the image's chip takes a drop as the zone does, refusing one on the chip and keeping the picture", async () => {
    const image: SandboxReadResult = { kind: "image", mediaType: "image/png", data: "AAAA" };
    const { pickers } = setup({ read: vi.fn(async () => image) });
    const flowNode = node("loadImage", { imagePath: "refs/pic.png" });
    const el = pickers.createDropzone(flowNode).el;
    await tick();
    await tick();
    expect(chipOf(el).textContent).toBe("refs/pic.png");

    drop(chipOf(el), "notes/a.md");
    expect(chipOf(el).textContent).toBe("Not a raster image: notes/a.md");
    expect(pictureOf(el).querySelector("img")).not.toBeNull();

    drop(chipOf(el), "art/other.png");
    expect(flowNode.config.imagePath).toBe("art/other.png");
    expect(chipOf(el).textContent).toBe("art/other.png");
  });

  it("the image's chip reports a path with nothing at it as the other loaders do, dropping the old picture", async () => {
    const image: SandboxReadResult = { kind: "image", mediaType: "image/png", data: "AAAA" };
    const read = vi.fn(async (): Promise<SandboxReadResult> => image);
    const { deps, pickers } = setup({ read });
    const el = pickers.createDropzone(node("loadImage", { imagePath: "refs/pic.png" })).el;
    await tick();
    await tick();
    expect(pictureOf(el).querySelector("img")).not.toBeNull();

    read.mockRejectedValue(new ApiError('No file at "art/gone.png"', 404));
    drop(pictureOf(el), "art/gone.png");
    await tick();
    await tick();
    expect(pictureOf(el).querySelector("img")).toBeNull();
    expect(pictureOf(el).textContent).toBe("Click or drop an image");
    expect(chipOf(el).classList.contains("missing")).toBe(true);
    expect(deps.fileMissing).toHaveBeenLastCalledWith("loadImage-1", 'No file at "art/gone.png"');

    // Any other failure keeps the server's own words, in the zone.
    read.mockRejectedValue(new ApiError("Couldn't decode that image", 400));
    drop(pictureOf(el), "art/other.png");
    await tick();
    await tick();
    expect(pictureOf(el).textContent).toBe("Couldn't decode that image");
    expect(chipOf(el).classList.contains("missing")).toBe(false);
    expect(deps.fileMissing).toHaveBeenLastCalledWith("loadImage-1", undefined);
  });

  // The dragged path is unused while a wire brings the node's, so reading it
  // to describe it would only ask for a file no run touches.
  it("reads nothing for a loader whose path pin has a wire into it", async () => {
    const wired = (_nodeId: string, port: string) =>
      port === "path" ? { node: node("resolvePath"), portId: "path" } : undefined;
    for (const [type, key, create] of [
      ["loadNote", "notePath", "createLoadNotePicker"],
      ["loadTableRows", "tablePath", "createLoadTableRowsPicker"],
      ["loadImage", "imagePath", "createDropzone"],
    ] as const) {
      const { deps, pickers } = setup({ sourceOf: vi.fn(wired) });
      pickers[create](node(type, { [key]: "space:notes/a.md" }));
      await tick();
      expect(deps.ensureCapability, type).not.toHaveBeenCalled();
      expect(deps.read, type).not.toHaveBeenCalled();
    }
    const { deps, pickers } = setup({ sourceOf: vi.fn(wired) });
    pickers.createLoadRandomRowPicker(
      node("loadRandomRow", { tablePath: "space:t.table.html" }),
      document.createElement("span"),
    );
    await tick();
    expect(deps.read).not.toHaveBeenCalled();
  });

  // The card sets the path pin beside this, so it must be what names the
  // file: the drop target itself, not the stat line under it, and Load
  // Image's chip, not its picture.
  it("hands the card the drop target a wire into the path pin stands in for", () => {
    const { pickers } = setup();
    for (const picker of [
      pickers.createLoadNotePicker(node("loadNote")),
      pickers.createWriteNotePicker(node("writeNote")),
      pickers.createLoadTableRowsPicker(node("loadTableRows")),
      pickers.createLoadRandomRowPicker(node("loadRandomRow"), document.createElement("span")),
    ]) {
      expect(picker.target).toBe(zoneOf(picker.el));
    }
    const image = pickers.createDropzone(node("loadImage"));
    expect(image.target).toBe(chipOf(image.el));
  });

  // The picture previews the file its chip names, a library's too; the
  // prompt, and the right-click's Choose image…, open the computer's picker.
  // A picture from the computer has no file, so its click does nothing.
  it("the image zone's click previews its picture's file, or opens the picker from the prompt", async () => {
    const image: SandboxReadResult = { kind: "image", mediaType: "image/png", data: "AAAA" };
    const { deps, pickers } = setup({ read: vi.fn(async () => image) });
    const el = pickers.createDropzone(node("loadImage", { imagePath: "lib:footage/sunset.png" })).el;
    const input = el.querySelector<HTMLInputElement>("input[type=file]") as HTMLInputElement;
    const picker = vi.spyOn(input, "click").mockImplementation(() => undefined);
    pictureOf(el).click();
    expect(picker).toHaveBeenCalledOnce();
    expect(deps.previewResult).not.toHaveBeenCalled();

    await tick();
    await tick();
    pictureOf(el).querySelector("img")?.click();
    expect(deps.previewResult).toHaveBeenCalledWith("lib:footage/sunset.png");
    expect(picker).toHaveBeenCalledOnce();
    zoneAction(deps, "Choose image…")?.run?.({} as never, undefined);
    expect(picker).toHaveBeenCalledTimes(2);
    // The picker's own click bubbles through the zone, and previews nothing.
    input.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(deps.previewResult).toHaveBeenCalledOnce();

    const computer = setup();
    const picked = computer.pickers.createDropzone(node("loadImage")).el;
    const png = new File([new Uint8Array([1, 2, 3])], "shot.png", { type: "image/png" });
    pictureOf(picked).dispatchEvent(fakeDrag("drop", { files: [png] }).event);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(pictureOf(picked).querySelector(".flow-picture.unstored")).not.toBeNull();
    const pickerToo = vi.spyOn(picked.querySelector("input[type=file]") as HTMLInputElement, "click");
    pictureOf(picked).click();
    expect(computer.deps.previewResult).not.toHaveBeenCalled();
    expect(pickerToo).not.toHaveBeenCalled();
  });

  // Load Image's path pins sit on its chip, so its card is measured once the
  // chip has shown or gone, never while it is about to.
  it("has the image card measured with its chip in place", async () => {
    const image: SandboxReadResult = { kind: "image", mediaType: "image/png", data: "AAAA" };
    const { deps, pickers } = setup({ read: vi.fn(async () => image) });
    const picker = pickers.createDropzone(node("loadImage"));
    const chip = chipOf(picker.el);
    const shown: boolean[] = [];
    vi.mocked(deps.layoutChanged).mockImplementation(() => void shown.push(!chip.hidden));
    document.body.append(picker.el);
    try {
      drop(pictureOf(picker.el), "pic.png");
      expect(shown.at(-1)).toBe(true);
      await tick();
      await tick();
      zoneAction(deps, "Clear")?.run?.({} as never, undefined);
      expect(shown.at(-1)).toBe(false);
    } finally {
      picker.el.remove();
    }
  });

  it("the Write Note target takes a markdown note without reading it or asking for anything", () => {
    const { deps, pickers } = setup();
    const writeNode = node("writeNote");
    const el = pickers.createWriteNotePicker(writeNode).el;
    drop(zoneOf(el), "t.table.html");
    expect(zoneOf(el).textContent).toBe("Not a markdown note: t.table.html");
    expect(writeNode.config.notePath).toBeUndefined();

    drop(zoneOf(el), "notes/a.md");
    expect(writeNode.config.notePath).toBe("notes/a.md");
    expect(deps.persistGraph).toHaveBeenCalled();
    expect(deps.read).not.toHaveBeenCalled();
    expect(deps.ensureCapability).not.toHaveBeenCalled();
  });

  it("the image dropzone asks before reading an image that only text named, not Pragma's own drag", async () => {
    const image: SandboxReadResult = { kind: "image", mediaType: "image/png", data: "AAAA" };
    const { deps, pickers } = setup({ read: vi.fn(async () => image) });
    const zone = pictureOf(pickers.createDropzone(node("loadImage")).el);
    drop(zone, "journal/private.png", true);
    await tick();
    await tick();
    expect(deps.ensureCapability).toHaveBeenCalledWith({ type: "readFile", path: "journal/private.png" }, false);
  });

  // A link dragged out of a note reads as a path too, but nobody picked it
  // from what Pragma shows: only Pragma's own drag skips the prompt.
  it("the note picker takes a dropped note as consent only when Pragma's own drag brought it", async () => {
    const { deps, pickers } = setup();
    const chip = chipOf(pickers.createLoadNotePicker(node("loadNote")).el);
    const consent = async (foreign: boolean) => {
      vi.mocked(deps.ensureCapability).mockClear();
      drop(chip, "journal/private.md", foreign);
      await vi.waitFor(() => expect(deps.ensureCapability).toHaveBeenCalled());
      return vi.mocked(deps.ensureCapability).mock.calls.at(-1)?.[1];
    };
    expect(await consent(true)).toBe(false);
    expect(await consent(false)).toBe(true);
  });

  it("the image dropzone takes a library image, storing the rooted path and asking to read that address", async () => {
    const image: SandboxReadResult = { kind: "image", mediaType: "image/png", data: "AAAA" };
    const { deps, pickers } = setup({ read: vi.fn(async () => image) });
    const flowNode = node("loadImage");
    const zone = pictureOf(pickers.createDropzone(flowNode).el);

    drop(zone, "lib:footage/sunset.png");
    // The prefix is kept: it is what tells this apart from a space file of
    // the same name, both on disk and in the grant key.
    expect(flowNode.config.imagePath).toBe("lib:footage/sunset.png");
    await tick();
    await tick();
    expect(deps.ensureCapability).toHaveBeenCalledWith({ type: "readFile", path: "lib:footage/sunset.png" }, true);
    expect(deps.read).toHaveBeenCalledWith("lib:footage/sunset.png");
    expect(zone.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,AAAA");
  });

  it("every other picker refuses a library path instead of resolving it against the space", () => {
    const { deps, pickers } = setup();

    const tableNode = node("loadRow");
    const tableZone = zoneOf(pickers.createLoadTablePicker(tableNode, document.createElement("span")).el);
    drop(tableZone, "lib:footage/rows.table.html");
    expect(tableZone.textContent).toBe("A library file can only go in a note, a media field or a Load Image node.");
    expect(tableNode.config.tablePath).toBeUndefined();

    const noteNode = node("loadNote");
    const noteZone = zoneOf(pickers.createLoadNotePicker(noteNode).el);
    drop(noteZone, "lib:footage/notes.md");
    expect(noteZone.textContent).toBe("A library file can only go in a note, a media field or a Load Image node.");
    expect(noteNode.config.notePath).toBeUndefined();

    // The folder pickers would otherwise have said "Not a folder", which is
    // true of the space tree they search and beside the point.
    const folderNode = node("loadFolderImage");
    const folderZone = zoneOf(pickers.createLoadFolderImagePicker(folderNode).el);
    drop(folderZone, "lib:footage");
    expect(folderZone.textContent).toBe("A library file can only go in a note, a media field or a Load Image node.");
    expect(folderNode.config.folderPath).toBeUndefined();
    expect(deps.persistGraph).not.toHaveBeenCalled();
  });

  it("the Get Field picker lists a wired row's column labels per slot, keeping a stored key the table lost", async () => {
    const loadRow = node("loadRow", { tablePath: "t.table.html" });
    const { deps, pickers } = setup({ sourceOf: vi.fn(() => ({ node: loadRow, portId: "row" })) });
    const flowNode = node("getField", { field1Key: "Voice", field2Key: "Weight" });
    const picker = pickers.createGetFieldPicker(flowNode);
    const first = picker.control(1);
    const second = picker.control(2);
    await tick();

    // Listing fields never prompts: the loader owns that grant.
    expect(deps.ensureCapability).not.toHaveBeenCalled();
    expect(deps.read).toHaveBeenCalledWith("t.table.html");
    expect((first.querySelector("input") as HTMLInputElement).hidden).toBe(true);
    expect([...selectOf(first).options].map((o) => o.textContent)).toEqual(["Voice (missing)", "Name", "Weight"]);
    expect(selectOf(first).value).toBe("Voice");
    expect(selectOf(second).value).toBe("Weight");

    selectOf(second).value = "Name";
    selectOf(second).dispatchEvent(new Event("change"));
    expect(flowNode.config.field2Key).toBe("Name");
    expect(deps.persistGraph).toHaveBeenCalled();

    // A slot added later fills from the list already read.
    const third = picker.control(3);
    expect([...selectOf(third).options].map((o) => o.textContent)).toEqual(["Choose a field", "Name", "Weight"]);
    expect(deps.read).toHaveBeenCalledTimes(1);
  });

  it("the Get Field picker is a text box for a source whose keys aren't known until it runs", async () => {
    const sourceOf = vi.fn((): ReturnType<PickerDeps["sourceOf"]> => undefined);
    const { deps, pickers } = setup({ sourceOf });
    const flowNode = node("getField", { field1Key: "title" });
    const picker = pickers.createGetFieldPicker(flowNode);
    const control = picker.control(1);
    await tick();
    const input = control.querySelector("input") as HTMLInputElement;
    expect(input.hidden).toBe(false);
    expect(selectOf(control).hidden).toBe(true);
    expect(input.value).toBe("title");
    input.value = "tags";
    input.dispatchEvent(new Event("input"));
    expect(flowNode.config.field1Key).toBe("tags");

    // Wired to a Load Table: its column labels, once the edge change refreshes it.
    sourceOf.mockReturnValue({ node: node("loadTableRows", { tablePath: "t.table.html" }), portId: "rows" });
    picker.refresh();
    await tick();
    expect(input.hidden).toBe(true);
    expect([...selectOf(control).options].map((o) => o.value)).toEqual(["tags", "Name", "Weight"]);

    // A failed read falls back to typing rather than an empty dropdown.
    vi.mocked(deps.read).mockRejectedValueOnce(new Error("denied"));
    picker.refresh();
    await tick();
    expect(input.hidden).toBe(false);
  });
});

describe("a Load Video card's facts line", () => {
  it("gives the size, length and frame rate, marking a rate that varies as its average", () => {
    const facts = { width: 1080, height: 1920, duration: 10.5 };
    expect(describeClip({ ...facts, frameRate: 24000 / 1001, variableFrameRate: false })).toBe(
      "1080 × 1920 (9:16) · 0:10 · 23.976 fps",
    );
    expect(describeClip({ ...facts, frameRate: 29.97, variableFrameRate: true })).toBe(
      "1080 × 1920 (9:16) · 0:10 · 30 fps (variable)",
    );
  });

  it("leaves out what the header doesn't give", () => {
    const none = { width: null, height: null, duration: null, frameRate: null, variableFrameRate: false };
    expect(describeClip({ ...none, duration: 4 })).toBe("0:04");
  });
});
