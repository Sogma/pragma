// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { metadataText } from "../../../../src/protocol/metadata.ts";
import { parseTableFile } from "../../../../src/protocol/tableFile.ts";
import type { TableLayout } from "../../../../src/protocol/types.ts";
import type { FileResponse, TableFileResponse } from "../../../../web/core/apiClient.ts";
import { createDialogService } from "../../../../web/services/dialog.ts";
import type { EditorPane } from "../../../../web/services/editorPanes.ts";
import { createFormats } from "../../../../web/services/formats.ts";
import { MEDIA_MENU } from "../../../../web/services/videoMenu.ts";
import { createTablePane, tablePane } from "../../../../web/view/panes/tablePane.ts";
import { polyfillRangeRects } from "../../support/codemirrorJsdom.ts";
import { memoryViews } from "../../support/editorLayout.ts";
import { testMetadataProperties } from "../../support/metadataProperties.ts";
import { testPreviewSources } from "../../support/previewSources.ts";
import { listSpace, unlistSpace } from "../../support/spaceListing.ts";
import { testContextMenu } from "../../support/testContextMenu.ts";

// Find measures its matches, which jsdom's Range can't.
polyfillRangeRects();

function file(overrides: Partial<TableFileResponse> = {}): TableFileResponse {
  return {
    kind: "table",
    path: "models.table.html",
    revision: "rev-1",
    id: "tbl_1",
    version: "1.0",
    name: "Models",
    columns: [{ id: "value", label: "Model", type: "text" }],
    rows: [{ values: { value: "one" } }],
    ...overrides,
  } as TableFileResponse;
}

function setup(loaded: FileResponse = file(), held = memoryViews()) {
  const loadFile = vi.fn(async () => loaded);
  const onRendered = vi.fn();
  const scheduleSave = vi.fn<(path: string, content: string) => void>();
  const saveLayout = vi.fn<(path: string, layout: TableLayout) => Promise<void>>(async () => {});
  const openPath = vi.fn<(path: string) => void>();
  const contextMenu = testContextMenu();
  let reading = false;
  const pane = createTablePane({
    loadFile,
    noteRevision: vi.fn(),
    dialog: createDialogService(),
    contextMenu,
    isReadingView: () => reading,
    scheduleSave,
    onRendered,
    openPath,
    previewSources: testPreviewSources(held),
    formats: createFormats(),
    dialogHost: document.body,
    metadataProperties: testMetadataProperties(),
    saveLayout,
  });
  document.body.append(pane.element);
  const setReadingView = (on: boolean) => {
    reading = on;
    pane.refresh?.();
  };
  return { pane, loadFile, onRendered, scheduleSave, saveLayout, openPath, contextMenu, setReadingView };
}

const current = { isCurrent: () => true };
const DESCRIPTION = { key: "description", values: ["Local models"] };
const CREATED = { key: "created", values: ["2026-01-02"] };

describe("tablePane", () => {
  it("describes a table pane", () => {
    expect(tablePane(setup().pane as never).kind).toBe("table");
  });

  it("loads the tab's file and renders it into the box it scrolls in, inside the pane's own", async () => {
    const { pane, loadFile, onRendered } = setup();
    await pane.setInput({ kind: "table", path: "models.table.html" }, current);

    expect(loadFile).toHaveBeenCalledWith("models.table.html");
    const scroller = pane.element.querySelector(".editor-table") as HTMLElement;
    expect(pane.element.classList.contains("editor-table-pane")).toBe(true);
    expect(scroller.querySelector("table")).not.toBeNull();
    expect(pane.title()).toBe("Models");
    expect(pane.titleHost?.()).toBe(scroller);
    expect(onRendered).toHaveBeenCalled();
  });

  it("uses a prefetched file without loading", async () => {
    const { pane, loadFile } = setup();
    await pane.setInput({ kind: "table", path: "models.table.html" }, current, file({ name: "Prefetched" }));

    expect(loadFile).not.toHaveBeenCalled();
    expect(pane.title()).toBe("Prefetched");
  });

  it("renders nothing when the open went stale while loading", async () => {
    const { pane } = setup();
    await pane.setInput({ kind: "table", path: "models.table.html" }, { isCurrent: () => false });

    expect(pane.element.querySelector("table")).toBeNull();
    expect(pane.title()).toBeUndefined();
  });

  it("refuses a file of another kind", async () => {
    const { pane } = setup({
      kind: "text",
      path: "x.md",
      revision: "rev-1",
      content: "",
      documentType: "note",
      toolkits: [],
      classLinks: [],
    });
    await expect(pane.setInput({ kind: "table", path: "x.md" }, current)).rejects.toThrow(/not a table/);
  });

  it("puts all of the table's metadata in its Properties-tab section, and nothing in Info", async () => {
    const { pane } = setup(file({ metadata: [DESCRIPTION, CREATED] }));
    await pane.setInput({ kind: "table", path: "models.table.html" }, current);

    expect(pane.element.querySelector(".property-editor")).toBeNull();
    expect(pane.inspector).toBeUndefined();
    const rows = [...(pane.properties?.querySelectorAll<HTMLElement>(".property-editor-row") ?? [])];
    expect(rows.map((row) => row.dataset.key)).toEqual(["description", "created"]);
  });

  it("edits the description there, saving it with the table, and shows its dates read-only", async () => {
    const { pane, scheduleSave } = setup(file({ metadata: [DESCRIPTION, CREATED] }));
    await pane.setInput({ kind: "table", path: "models.table.html" }, current);
    expect(pane.properties?.querySelector('[data-key="created"] textarea, [data-key="created"] input')).toBeNull();
    expect(pane.properties?.querySelector('[data-key="created"]')?.textContent).toContain("2026-01-02");
    const field = pane.properties?.querySelector<HTMLTextAreaElement>('[data-key="description"] textarea');
    if (!field) throw new Error("no description field");
    expect(field.value).toBe("Local models");

    field.value = "Every model on this machine.";
    field.dispatchEvent(new Event("input"));

    const saved = parseTableFile(scheduleSave.mock.calls.at(-1)?.[1] ?? "");
    expect(metadataText(saved?.metadata, "description")).toBe("Every model on this machine.");
    expect(metadataText(saved?.metadata, "created")).toBe("2026-01-02");
    expect(metadataText(saved?.metadata, "modified")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(saved?.rows).toEqual([{ values: { value: "one" } }]);
  });

  it("saves an edit to any other key with the table, every key in its place", async () => {
    const tags = { key: "tags", values: ["studio"] };
    const { pane, scheduleSave } = setup(file({ metadata: [DESCRIPTION, tags, CREATED] }));
    await pane.setInput({ kind: "table", path: "models.table.html" }, current);
    expect(pane.properties?.hidden).toBe(false);
    expect(pane.properties?.hasAttribute("data-empty")).toBe(false);

    const input = pane.properties?.querySelector<HTMLInputElement>(".property-editor-tag-input");
    if (!input) throw new Error("no tag input");
    input.value = "reference";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));

    const saved = parseTableFile(scheduleSave.mock.calls.at(-1)?.[1] ?? "");
    expect(saved?.metadata?.map((entry) => entry.key)).toEqual(["description", "tags", "created", "modified"]);
    expect(saved?.metadata?.[1]).toEqual({ key: "tags", values: ["studio", "reference"] });
    expect(saved?.rows).toEqual([{ values: { value: "one" } }]);
  });

  it("shows properties read-only in reading view, and marks the section empty with none", async () => {
    const { pane, setReadingView } = setup(file({ metadata: [DESCRIPTION, { key: "status", values: ["draft"] }] }));
    await pane.setInput({ kind: "table", path: "models.table.html" }, current);
    setReadingView(true);
    expect(pane.properties?.querySelector("input, textarea")).toBeNull();
    const rows = [...(pane.properties?.querySelectorAll(".meta-row") ?? [])].map((row) => row.textContent);
    expect(rows).toEqual(["descriptionLocal models", "statusdraft"]);

    await pane.setInput({ kind: "table", path: "models.table.html" }, current, file({ metadata: [] }));
    expect(pane.properties?.hasAttribute("data-empty")).toBe(true);
    expect(pane.properties?.textContent).toBe("No properties.");
  });

  it("offers a property to add to a table with none", async () => {
    const { pane, scheduleSave } = setup();
    await pane.setInput({ kind: "table", path: "models.table.html" }, current);
    expect(pane.properties?.hasAttribute("data-empty")).toBe(true);

    pane.properties?.querySelector<HTMLButtonElement>(".data-table-add-row")?.click();
    const saved = parseTableFile(scheduleSave.mock.calls.at(-1)?.[1] ?? "");
    expect(saved?.metadata?.map((entry) => entry.key)).toEqual(["property", "created", "modified"]);
  });

  it("clearInput empties the pane", async () => {
    const { pane } = setup(file({ metadata: [DESCRIPTION] }));
    await pane.setInput({ kind: "table", path: "models.table.html" }, current);
    pane.clearInput();

    expect(pane.title()).toBeUndefined();
    expect(pane.properties?.hidden).toBe(true);
  });

  it("draws a picked layout at once and keeps it for the table's next open, never in the file", async () => {
    const { pane, loadFile, saveLayout, scheduleSave } = setup();
    await pane.setInput({ kind: "table", path: "models.table.html" }, current);
    pane.layout?.set("list");
    expect(saveLayout).not.toHaveBeenCalled();

    pane.layout?.set("cards");
    expect(pane.layout?.current()).toBe("cards");
    expect(pane.element.querySelector(".data-cards-card")).not.toBeNull();
    expect(saveLayout).toHaveBeenCalledWith("models.table.html", "cards");
    expect(scheduleSave).not.toHaveBeenCalled();

    pane.clearInput();
    loadFile.mockResolvedValueOnce(file({ localLayout: "cards" }));
    await pane.setInput({ kind: "table", path: "models.table.html" }, current);
    expect(pane.layout?.current()).toBe("cards");
  });

  it("says when a pick could not be kept, and still shows it", async () => {
    const { pane, saveLayout } = setup();
    saveLayout.mockRejectedValueOnce(new Error("Changing the layout failed"));
    const alert = vi.spyOn(window, "alert").mockImplementation(() => {});
    try {
      await pane.setInput({ kind: "table", path: "models.table.html" }, current);
      pane.layout?.set("cards");
      await vi.waitFor(() => expect(alert).toHaveBeenCalledWith("Changing the layout failed"));
      expect(pane.layout?.current()).toBe("cards");
    } finally {
      alert.mockRestore();
    }
  });
});

// A media cell's picture shows over the table, as a gallery's tile does.
describe("a media cell's preview", () => {
  // A close or an open by click leaves the window taking the rest of its
  // double-click until a press starts a new run.
  afterEach(() => {
    window.dispatchEvent(new MouseEvent("mousedown", { detail: 1 }));
  });

  const shots = () =>
    file({
      columns: [
        { id: "take", label: "Take", type: "text" },
        { id: "shot", label: "Shot", type: "media" },
      ],
      rows: [
        { values: { take: "one", shot: "stills/a.png" } },
        { values: { take: "two", shot: "" } },
        { values: { take: "three", shot: "stills/b.mp4" } },
        { values: { take: "four", shot: "stills/sheet.pdf" } },
        { values: { take: "five", shot: "stills/c.png" } },
      ],
    });
  const thumbs = (pane: EditorPane) => [...pane.element.querySelectorAll<HTMLButtonElement>(".media-field-thumb")];
  const previewOf = (pane: EditorPane) => pane.element.querySelector(".file-preview") as HTMLElement;
  const shown = (pane: EditorPane) =>
    previewOf(pane).querySelector(".file-preview-frame > :is(img, video)")?.getAttribute("src");
  const press = (pane: EditorPane, key: string) =>
    pane.element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  const fire = (target: Element, type: string, detail: number) =>
    target.dispatchEvent(new MouseEvent(type, { bubbles: true, detail }));

  it("shows the file over the table, its arrows stepping down the column past cells with nothing to show", async () => {
    const { pane } = setup(shots());
    await pane.setInput({ kind: "table", path: "models.table.html" }, current);
    thumbs(pane)[0].click();
    expect(previewOf(pane).hidden).toBe(false);
    expect(shown(pane)).toBe("/raw?path=stills/a.png");
    expect(document.activeElement).toBe(pane.element);
    expect(pane.hasTransient?.()).toBe(true);
    // A cell holds only a path, which names the file along the bottom, by its ⋮.
    const bottom = [...previewOf(pane).querySelectorAll(".media-hud-bar:last-child > *")];
    expect(bottom.map((cell) => cell.className)).toEqual(["media-hud-name", "icon-button media-hud-more"]);
    expect(bottom[0].textContent).toBe("a.png");

    press(pane, "ArrowRight");
    expect(shown(pane)).toBe("/raw?path=stills/b.mp4");
    press(pane, "ArrowRight");
    expect(shown(pane)).toBe("/raw?path=stills/c.png");
    expect(previewOf(pane).querySelector(".file-preview-nav.is-next")?.getAttribute("aria-disabled")).toBe("true");

    // Closed, focus is on the cell the preview ended on.
    pane.dismissTransient?.();
    expect(previewOf(pane).hidden).toBe(true);
    expect(document.activeElement).toBe(thumbs(pane)[4]);
  });

  // A project's Table showing a library's stills: they are seen in the
  // project's context, taking its look and guides, never the library's.
  it("previews a library's still in the context of the Table's project", async () => {
    await listSpace({
      files: ["projects/film/models.table.html"],
      folders: ["projects", "projects/film"],
      scopes: ["projects/film"],
    });
    try {
      const held = memoryViews();
      held.of("projects/film").look.set({ lut: "panchromatic", on: true });
      const loaded = file({
        columns: [{ id: "shot", label: "Shot", type: "media" }],
        rows: [{ values: { shot: "lib:footage/a.png" } }],
      });
      const { pane, contextMenu } = setup(loaded, held);
      await pane.setInput({ kind: "table", path: "projects/film/models.table.html" }, current);
      thumbs(pane)[0].click();
      const badge = previewOf(pane).querySelector(".media-hud-badge");
      expect([badge?.textContent, badge?.getAttribute("aria-pressed")]).toEqual(["LOOK", "true"]);

      const open = vi.spyOn(contextMenu, "open");
      (previewOf(pane).querySelector(".media-hud-more") as HTMLButtonElement).click();
      expect(open.mock.lastCall?.[0].arg).toMatchObject({ file: "lib:footage/a.png", context: "projects/film" });
    } finally {
      await unlistSpace();
    }
  });

  it("points the copilot at the file its preview shows, and at nothing once it closes", async () => {
    const { pane } = setup(shots());
    await pane.setInput({ kind: "table", path: "models.table.html" }, current);
    expect(pane.selectedFile?.()).toBeUndefined();

    thumbs(pane)[0].click();
    expect(pane.selectedFile?.()).toEqual({ path: "stills/a.png", previewing: true });
    press(pane, "ArrowRight");
    expect(pane.selectedFile?.()).toEqual({ path: "stills/b.mp4", previewing: true });

    pane.dismissTransient?.();
    expect(pane.selectedFile?.()).toBeUndefined();
  });

  it("opens the file in place on a double-click begun on the cell, and offers the other ways from its ⋮", async () => {
    const { pane, openPath, contextMenu } = setup(shots());
    await pane.setInput({ kind: "table", path: "models.table.html" }, current);
    const thumb = thumbs(pane)[0];
    fire(thumb, "mousedown", 1);
    thumb.click();
    const preview = previewOf(pane);
    fire(preview, "mousedown", 2);
    fire(preview, "click", 2);
    expect(preview.hidden).toBe(false);
    fire(preview, "dblclick", 2);
    expect(openPath).toHaveBeenCalledWith("stills/a.png");

    const open = vi.spyOn(contextMenu, "open");
    (preview.querySelector(".media-hud-more") as HTMLButtonElement).click();
    expect(open).toHaveBeenCalledWith(
      expect.objectContaining({
        menu: MEDIA_MENU,
        arg: { file: "stills/a.png", bookmark: "stills/a.png", context: "" },
      }),
    );
  });

  it("opens a file it has no preview of in place, as a click did", async () => {
    const { pane, openPath } = setup(shots());
    await pane.setInput({ kind: "table", path: "models.table.html" }, current);
    thumbs(pane)[3].click();
    expect(openPath).toHaveBeenLastCalledWith("stills/sheet.pdf");
    expect(previewOf(pane).hidden).toBe(true);
  });

  // The cell says what became of a file that has gone, in a modal of its own.
  it("opens neither the preview nor the path of a file that has gone", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("Not found", { status: 404 })),
    );
    try {
      const { pane, openPath } = setup(shots());
      await pane.setInput({ kind: "table", path: "models.table.html" }, current);
      thumbs(pane)[0].querySelector("img")?.dispatchEvent(new Event("error"));
      thumbs(pane)[0].click();
      const title = () => document.querySelector(".dialog-panel .dialog-title")?.textContent;
      await vi.waitFor(() => expect(title()).toBe("Media offline"));
      expect(openPath).not.toHaveBeenCalled();
      expect(previewOf(pane).hidden).toBe(true);
      (document.querySelector(".dialog-panel .dialog-actions button") as HTMLButtonElement).click();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("steps through the cards' pictures as through the column", async () => {
    const { pane } = setup(shots());
    await pane.setInput({ kind: "table", path: "models.table.html" }, current);
    pane.layout?.set("cards");
    thumbs(pane)[0].click();
    expect(shown(pane)).toBe("/raw?path=stills/a.png");
    press(pane, "ArrowRight");
    expect(shown(pane)).toBe("/raw?path=stills/b.mp4");
  });

  it("closes when the pane shows another table, and stays over a reload of this one", async () => {
    const { pane } = setup(shots());
    await pane.setInput({ kind: "table", path: "models.table.html" }, current);
    thumbs(pane)[0].click();
    await pane.setInput({ kind: "table", path: "models.table.html" }, current, shots());
    expect(previewOf(pane).hidden).toBe(false);
    await pane.setInput({ kind: "table", path: "other.table.html" }, current, file({ path: "other.table.html" }));
    expect(previewOf(pane).hidden).toBe(true);
  });
});

// Find over a Table's values: the editor's card with Find alone.
describe("tablePane find", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  const takes = () =>
    file({
      columns: [
        { id: "take", label: "Take", type: "text" },
        { id: "status", label: "Status", type: "select", options: ["draft", "approved"] },
      ],
      rows: [{ values: { take: "wide take", status: "draft" } }, { values: { take: "close", status: "approved" } }],
    });

  async function opened() {
    const context = setup(takes());
    await context.pane.setInput({ kind: "table", path: "models.table.html" }, current);
    const aside = context.pane.toolbarAside;
    if (!aside) throw new Error("the Table pane has no toolbar aside");
    document.body.append(aside);
    const field = () => aside.querySelector(".find-card:not(.is-closing) .find-card-input") as HTMLInputElement;
    const count = () => aside.querySelector(".find-card:not(.is-closing) .find-card-count")?.textContent;
    const type = (value: string) => {
      field().value = value;
      field().dispatchEvent(new Event("input"));
    };
    return { ...context, aside, count, type };
  }

  it("finds the values in every mode, never a column's name, with Find alone", async () => {
    const { pane, aside, type, count, setReadingView } = await opened();
    expect(pane.findable?.()).toBe("find");
    pane.openFind?.(false);
    expect(aside.querySelector<HTMLElement>(".find-card-reveal")?.hidden).toBe(true);

    type("take");
    expect(count()).toBe("1 of 1");
    // Editing, the value is in a field, which is filled whole.
    expect(pane.element.querySelector<HTMLInputElement>("input.data-table-cell-text")?.dataset.find).toBe("current");

    type("approved");
    expect(count()).toBe("1 of 1");

    setReadingView(true);
    await Promise.resolve();
    expect(count()).toBe("1 of 1");
    expect(pane.element.querySelector("[data-find]")).toBeNull();
  });

  it("closes its card from Escape in the pane", async () => {
    const { pane } = await opened();
    pane.openFind?.(false);
    expect(pane.hasTransient?.()).toBe(true);
    pane.dismissTransient?.();
    expect(pane.hasTransient?.()).toBe(false);
  });
});
