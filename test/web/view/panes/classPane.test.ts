// @vitest-environment jsdom
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { ClassRow } from "../../../../src/protocol/class.ts";
import { parseClassFile } from "../../../../src/protocol/classFile.ts";
import { metadataText } from "../../../../src/protocol/metadata.ts";
import type { TagDefinition } from "../../../../src/protocol/tags.ts";
import { ApiError, type ClassFileResponse, type FileResponse } from "../../../../web/core/apiClient.ts";
import { setPresets } from "../../../../web/core/presets.ts";
import { ROW_MENU } from "../../../../web/lib/dataGrid.ts";
import { installTextMenu } from "../../../../web/lib/textMenu.ts";
import { ROW_CARD_MENU } from "../../../../web/rowCard.ts";
import { createCommands } from "../../../../web/services/commands.ts";
import { createDialogService } from "../../../../web/services/dialog.ts";
import type { EditorPane } from "../../../../web/services/editorPanes.ts";
import { createMenus, type MenuOpenOptions } from "../../../../web/services/menus.ts";
import { classPane, createClassPane } from "../../../../web/view/panes/classPane.ts";
import { polyfillRangeRects } from "../../support/codemirrorJsdom.ts";
import { testFormats } from "../../support/formats.ts";
import { testMetadataProperties } from "../../support/metadataProperties.ts";
import { testPreviewSources } from "../../support/previewSources.ts";
import { testContextMenu } from "../../support/testContextMenu.ts";

// The space lists `_templates/` for templates, for this test alone.
function listTemplates(): void {
  setPresets({ folders: [{ kind: "templates", written: "_templates/", path: "_templates" }] });
  onTestFinished(() => setPresets({ folders: [] }));
}

// Find measures its matches, which jsdom's Range can't.
polyfillRangeRects();

// A row's card lays its tiles on a grid that measures itself.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const opened: EditorPane[] = [];

afterEach(() => {
  for (const pane of opened.splice(0)) pane.dispose();
  document.body.replaceChildren();
});

function menuItem(label: string): HTMLButtonElement {
  const item = [...document.querySelectorAll<HTMLButtonElement>(".context-menu button")].find(
    (button) => button.textContent?.trim() === label,
  );
  if (!item) throw new Error(`no "${label}" in the open menu`);
  return item;
}

function classFile(overrides: Partial<ClassFileResponse> = {}): ClassFileResponse {
  return {
    kind: "class",
    path: "shots/shots.class.html",
    revision: "rev-1",
    version: "1.0",
    name: "Shots",
    // Its own folder alone, as one made there reads it.
    filter: [{ property: "file.folder", test: "is", values: ["shots"] }],
    fields: [
      { id: "status", type: "select", label: "Status", options: ["draft", "approved"] },
      { id: "take", type: "integer", label: "Take" },
      { id: "tags", type: "text", label: "Tags" },
    ],
    views: [
      { name: "All", layout: "list", filter: [] },
      { name: "Board", layout: "cards", groupBy: "status", filter: [] },
      { name: "Approved", layout: "list", filter: [{ property: "status", test: "is", values: ["approved"] }] },
    ],
    links: [],
    ...overrides,
  };
}

// A note's row, with the facts its file has.
const note = (name: string, title: string, properties: Record<string, unknown>): ClassRow => ({
  path: `shots/${name}`,
  name,
  title,
  kind: "note",
  size: 64,
  modified: "2026-10-12T09:30:00Z",
  folder: "shots",
  properties,
});

// The space's tags, as a read finds them.
const TAGS: TagDefinition[] = [{ name: "night", color: "#1F3A93" }];

const rows: ClassRow[] = [
  note("wide.md", "Wide", { status: "approved", take: 2, tags: ["night"] }),
  note("close.md", "Close", { status: "wip", take: "two" }),
  note("insert.md", "Insert", {}),
];

async function setup(
  file: ClassFileResponse = classFile(),
  loaded: ClassRow[] = rows,
  { reading = false, arrangement }: { reading?: boolean; arrangement?: string[] } = {},
) {
  let hearSort: ((folder: string) => void) | undefined;
  // Its right-click listener goes with the test, so none left by an earlier
  // test answers a later one's right-click.
  const contextMenu = testContextMenu();
  onTestFinished(() => contextMenu.dispose());
  // The page's writes: counted as each response lands, told after.
  let writes = 0;
  const hearWrites = new Set<(paths: readonly string[], through: number) => void>();
  // None are known until the pane reads them.
  let knownTags: readonly TagDefinition[] = [];
  const deps = {
    loadFile: vi.fn(async (): Promise<FileResponse> => file),
    formats: testFormats(),
    // A copy each time: the pane shows an edit in its rows at once.
    loadRows: vi.fn(async () => structuredClone(loaded)),
    openPath: vi.fn(),
    openBeside: vi.fn(),
    previewSources: testPreviewSources(),
    dialog: createDialogService(),
    contextMenu,
    noteRevision: vi.fn(),
    scheduleSave: vi.fn<(path: string, content: string, onWritten?: () => void) => void>(),
    isReadingView: () => reading,
    onRendered: vi.fn(),
    dialogHost: document.body,
    editProperties: vi.fn(async (_path: string, edit: (properties: Record<string, unknown>) => void) => {
      edit(edited);
    }),
    createFile: vi.fn(async (folder: string, name: string, _content: string) => ({
      path: `${folder}/${name}`,
      type: "file" as const,
    })),
    reportReadout: vi.fn(),
    metadataProperties: testMetadataProperties(),
    // Only `shots` shows its manual order, and only when a test gives one.
    arrangement: vi.fn((folder: string) => (folder === "shots" ? arrangement : undefined)),
    arrange: vi.fn(async (_folder: string, _names: string[]) => {}),
    onFolderSorted: vi.fn((listener: (folder: string) => void) => {
      hearSort = listener;
      return () => {
        hearSort = undefined;
      };
    }),
    onWritten: (listener: (paths: readonly string[], through: number) => void) => {
      hearWrites.add(listener);
      return () => hearWrites.delete(listener);
    },
    writesNotified: () => writes,
    files: vi.fn(() => ["tools/lyrics.flow.html", "tools/polish.flow.html", "shots/guide.md"]),
    createFromTemplate: vi.fn(async (_template: string, folder: string, title: string) => ({
      path: `${folder}/${title}.md`,
      type: "file" as const,
    })),
    tags: {
      known: () => knownTags,
      read: vi.fn(async () => {
        knownTags = TAGS;
        return knownTags;
      }),
    },
  };
  // What the last frontmatter edit left, from an empty block.
  const edited: Record<string, unknown> = {};
  const pane = createClassPane(deps);
  opened.push(pane);
  document.body.append(pane.element);
  await pane.setInput({ kind: "class", path: file.path }, { isCurrent: () => true });
  // What the last save wrote, read back.
  const saved = () => {
    const call = deps.scheduleSave.mock.calls.at(-1);
    return call ? parseClassFile(call[1]) : undefined;
  };
  // A write's response landing, and the paths it named told after.
  const wrote = () => ++writes;
  const tell = (...paths: string[]) => {
    for (const listener of hearWrites) listener(paths, writes);
  };
  return { pane, deps, saved, edited, sorted: (folder: string) => hearSort?.(folder), wrote, tell };
}

const DESCRIPTION = { key: "description", values: ["Every shot."] };

const texts = (root: Element, selector: string) =>
  [...root.querySelectorAll(selector)].map((element) => element.textContent?.trim());

describe("classPane", () => {
  it("lists each note under its title, then its fields, with a value that doesn't fit shown as written", async () => {
    const { pane, deps } = await setup(classFile(), rows, { reading: true });

    expect(texts(pane.element, "thead th:not(.row-gutter)")).toEqual(["Title", "Status", "Take", "Tags"]);
    const body = [...pane.element.querySelectorAll("tbody tr")].map((tr) =>
      [...tr.querySelectorAll("td:not(.row-gutter)")].map((td) => td.textContent?.trim()),
    );
    expect(body).toEqual([
      ["Wide", "approved", "2", "night"],
      ["Close", "wip", "two", ""],
      ["Insert", "", "", ""],
    ]);
    expect(texts(pane.element, ".pill")).toEqual(["night"]);
    expect(pane.title()).toBe("Shots");
    expect(deps.loadRows).toHaveBeenCalledWith("shots/shots.class.html");
  });

  it("fills a tag's pill with its color, a bare tag's too, and leaves any other list's plain", async () => {
    const file = classFile({
      fields: [
        { id: "tags", type: "text", label: "Tags" },
        { id: "file.tags", type: "text", label: "All tags" },
        { id: "cast", type: "text", label: "Cast" },
      ],
    });
    const { pane } = await setup(file, [
      note("wide.md", "Wide", { tags: ["night", "day"], cast: ["night"] }),
      note("close.md", "Close", { tags: "night" }),
    ]);
    const pills = (row: number, column: number) => [
      ...pane.element
        .querySelectorAll("tbody tr")
        [row].querySelectorAll("td:not(.row-gutter)")
        [column].querySelectorAll<HTMLElement>(".pill"),
    ];
    const shown = (pill: HTMLElement) => [pill.textContent, pill.dataset.tag, pill.classList.contains("has-tag-color")];

    // Filled once the pane's read of the space's tags lands.
    await vi.waitFor(() =>
      expect(pills(0, 1).map(shown)).toEqual([
        ["night", "night", true],
        ["day", "day", false],
      ]),
    );
    expect(pills(0, 1)[0].style.backgroundColor).toBe("rgb(31, 58, 147)");
    expect(pills(0, 2).map(shown)).toEqual([
      ["night", "night", true],
      ["day", "day", false],
    ]);
    expect(pills(0, 3).map(shown)).toEqual([["night", undefined, false]]);
    expect(pills(1, 1).map(shown)).toEqual([["night", "night", true]]);
    expect(pills(1, 2).map(shown)).toEqual([["night", "night", true]]);
  });

  it("opens a row's note in the Class's place", async () => {
    const { pane, deps } = await setup();
    pane.element.querySelector<HTMLButtonElement>(".class-row-title")?.click();
    expect(deps.openPath).toHaveBeenCalledWith("shots/wide.md");
  });

  it("starts no selection where a row's title is pressed, and opens nothing from a press dragged off it", async () => {
    const { pane, deps } = await setup();
    const title = pane.element.querySelector(".class-row-title") as HTMLElement;
    const select = new Event("selectstart", { bubbles: true, cancelable: true });
    title.firstChild?.dispatchEvent(select);
    expect(select.defaultPrevented).toBe(true);
    title.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 10, clientY: 5 }));
    title.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1, clientX: 40, clientY: 5 }));
    expect(deps.openPath).not.toHaveBeenCalled();
  });

  it("switches views from its bar: cards grouped by a select's options, and a view's own filter", async () => {
    const { pane } = await setup();
    expect(texts(pane.element, ".class-view")).toEqual(["All", "Board", "Approved"]);

    [...pane.element.querySelectorAll<HTMLButtonElement>(".class-view")][1].click();
    expect(texts(pane.element, ".class-group-heading")).toEqual(["approved1", "wip1", "No Status1"]);
    expect(texts(pane.element, ".data-cards-title")).toEqual(["Wide", "Close", "Insert"]);
    expect(pane.element.querySelector("table")).toBeNull();

    [...pane.element.querySelectorAll<HTMLButtonElement>(".class-view")][2].click();
    expect(texts(pane.element, "tbody .class-row-title")).toEqual(["Wide"]);
  });

  it("names a group by its field even when the view hides that field", async () => {
    const view = { name: "Board", layout: "list" as const, groupBy: "status", fields: ["take"], filter: [] };
    const { pane } = await setup(classFile({ views: [view] }));
    expect(texts(pane.element, ".class-group-heading")).toEqual(["approved1", "wip1", "No Status1"]);
    expect(texts(pane.element, "thead th:not(.row-gutter)").slice(0, 2)).toEqual(["Title", "Take"]);
  });

  it("shows only the fields a view lists, in its order", async () => {
    const { pane } = await setup(
      classFile({ views: [{ name: "Short", layout: "list", fields: ["take", "status"], filter: [] }] }),
      rows,
      { reading: true },
    );
    expect(texts(pane.element, "thead th:not(.row-gutter)")).toEqual(["Title", "Take", "Status"]);
    expect(texts(pane.element, "tbody tr:first-child td:not(.row-gutter)")).toEqual(["Wide", "2", "approved"]);
  });

  it("shows a Class with no views as one, and says when nothing is in it", async () => {
    const { pane } = await setup(classFile({ views: [] }), []);
    expect(texts(pane.element, ".class-view")).toEqual(["All"]);
    expect(pane.element.querySelector(".class-count")?.textContent).toBe("0 items");
    expect(pane.element.querySelector(".data-table-empty")?.textContent).toBe("This Class is empty.");
  });

  it("reads no rows for a file it can't read, and says why", async () => {
    const { pane, deps } = await setup(classFile({ locked: "unreadable" }));
    expect(deps.loadRows).not.toHaveBeenCalled();
    expect(pane.element.querySelector(".document-locked-notice")).not.toBeNull();
    expect(pane.element.querySelector("table")).toBeNull();
  });
});

describe("classPane: a note's preview", () => {
  afterEach(() => vi.useRealTimers());

  // As a browser moves the pointer onto it: an over, then a move.
  const over = (target: Element) => {
    target.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, pointerType: "mouse" }));
    target.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerType: "mouse" }));
  };
  const titled = (pane: EditorPane, text: string) =>
    [...pane.element.querySelectorAll<HTMLElement>(".class-row-title")].find(
      (title) => title.textContent === text,
    ) as HTMLElement;

  it("shows a note row's note while the pointer rests on its title, and opens it beside", async () => {
    const { pane, deps } = await setup();
    deps.loadFile.mockResolvedValue({
      kind: "text",
      path: "shots/wide.md",
      revision: "r1",
      content: "# Wide\n\nOne long take.\n",
      documentType: "note",
      toolkits: [],
      classLinks: [],
      fields: [],
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    over(titled(pane, "Wide"));
    await vi.advanceTimersByTimeAsync(300);

    const preview = document.querySelector<HTMLElement>(".link-preview");
    expect(deps.loadFile).toHaveBeenLastCalledWith("shots/wide.md");
    expect(preview?.querySelector(".editor-reading-content")?.textContent).toContain("One long take.");
    // The veil sits outside what the rows redraw, so drawing them kept it.
    expect(pane.element.querySelector(".link-preview-veil")?.classList.contains("is-shown")).toBe(true);

    preview?.querySelector<HTMLButtonElement>(".preview-open")?.click();
    expect(deps.openBeside).toHaveBeenCalledWith("shots/wide.md");
    expect(deps.openPath).not.toHaveBeenCalled();
    expect(document.querySelector(".link-preview")).toBeNull();
  });

  it("shows a screenplay row's screenplay in its format's locked editor", async () => {
    const kinds: ClassRow[] = [{ ...note("draft.fountain", "Brick", {}), kind: "screenplay" }];
    const { pane, deps } = await setup(classFile({ views: [] }), kinds);
    deps.loadFile.mockResolvedValue({
      kind: "text",
      path: "shots/draft.fountain",
      revision: "r1",
      content: "INT. CELLAR - NIGHT",
      documentType: "screenplay",
      toolkits: [],
      classLinks: [],
      fields: [],
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    over(titled(pane, "Brick"));
    await vi.advanceTimersByTimeAsync(300);

    const page = document.querySelector<HTMLElement>(".link-preview .editor-page");
    expect(deps.loadFile).toHaveBeenLastCalledWith("shots/draft.fountain");
    expect(page?.querySelector(".cm-editor.fountain-editor .cm-line")?.textContent).toBe("INT. CELLAR - NIGHT");
  });

  it("gives a title a page shows no path hint, and another kind's title its hint and no preview", async () => {
    const kinds: ClassRow[] = [
      note("look.md", "Look", {}),
      { ...note("draft.fountain", "Brick", {}), kind: "screenplay" },
      { ...note("wide.png", "Still", {}), kind: "image" },
    ];
    const { pane, deps } = await setup(classFile({ views: [] }), kinds);
    expect(titled(pane, "Look").dataset.tooltip).toBeUndefined();
    expect(titled(pane, "Brick").dataset.tooltip).toBeUndefined();
    expect(titled(pane, "Still").dataset.tooltip).toBe("shots/wide.png");

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    over(titled(pane, "Still"));
    await vi.advanceTimersByTimeAsync(1000);
    expect(deps.loadFile).not.toHaveBeenCalledWith("shots/wide.png");
    expect(document.querySelector(".link-preview")).toBeNull();
  });
});

describe("classPane: changed where it shows", () => {
  const toolbarButton = (pane: EditorPane, label: string) => {
    const button = [...(pane.toolbar?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find((each) =>
      each.textContent?.startsWith(label),
    );
    if (!button) throw new Error(`no ${label} button`);
    return button;
  };
  // A button's label, its count aside.
  const labelOf = (button: HTMLElement) =>
    [...button.childNodes]
      .filter((node) => !(node instanceof HTMLElement && node.classList.contains("count-badge")))
      .map((node) => node.textContent)
      .join("")
      .trim();
  const popoverButton = (label: string) => {
    const button = [...document.querySelectorAll<HTMLButtonElement>(".class-popover button")].find(
      (each) => labelOf(each) === label,
    );
    if (!button) throw new Error(`no "${label}" in the popover`);
    return button;
  };
  const type = (input: HTMLInputElement | null, value: string, event = "input") => {
    if (!input) throw new Error("no input");
    input.value = value;
    input.dispatchEvent(new Event(event));
  };

  it("puts Filter, Sort, Group, Fields and Links in the toolbar, and none of them while reading", async () => {
    const { pane } = await setup();
    expect(texts(pane.toolbar as HTMLElement, ".class-toolbar-label")).toEqual([
      "Filter",
      "Sort",
      "Group",
      "Fields",
      "Links",
      "New note",
    ]);
    expect(pane.toolbar?.hidden).toBe(false);

    const reading = await setup(classFile(), rows, { reading: true });
    expect(reading.pane.toolbar?.hidden).toBe(true);
  });

  it("sorts the view from Sort, and saves the Class", async () => {
    const { pane, saved } = await setup();
    toolbarButton(pane, "Sort").click();
    const by = document.querySelector<HTMLSelectElement>(".class-popover select");
    if (!by) throw new Error("no Sort by");
    by.value = "take";
    by.dispatchEvent(new Event("change"));

    expect(saved()?.views[0].sort).toEqual({ property: "take", order: "asc" });
    expect(texts(pane.element, ".class-chip-label")).toEqual(["Sorted by Take, ascending"]);
  });

  it("filters the view as a filter is typed, shows it as a chip, and removes it from there", async () => {
    const { pane, saved } = await setup();
    toolbarButton(pane, "Filter").click();
    popoverButton("This view").click();
    popoverButton("+ Add filter").click();
    type(document.querySelector(".class-filter-property"), "status");
    expect(saved()).toBeUndefined();
    type(document.querySelector(".class-filter-values"), "approved");

    expect(saved()?.views[0].filter).toEqual([{ property: "status", test: "is", values: ["approved"] }]);
    expect(texts(pane.element, "tbody .class-row-title")).toEqual(["Wide"]);
    expect(texts(pane.element, ".class-chip-label")).toEqual(["Status is approved"]);
    // The Class's Folder rule counts beside the view's own filter.
    const badge = pane.toolbar?.querySelector<HTMLElement>(".class-toolbar-button .count-badge");
    expect(badge?.hidden).toBe(false);
    expect(badge?.textContent).toBe("2");

    pane.element.querySelector<HTMLButtonElement>(".class-chip-remove")?.click();
    expect(badge?.textContent).toBe("1");
    expect(saved()?.views[0].filter).toEqual([]);
    expect(texts(pane.element, "tbody .class-row-title")).toEqual(["Wide", "Close", "Insert"]);
  });

  it("filters by every tag a row carries on file.tags, by what it has, named All tags", async () => {
    const carried = [{ ...rows[0], inlineTags: ["scenes"] }, rows[1], { ...rows[2], inlineTags: ["Night"] }];
    const { pane, saved } = await setup(classFile(), carried);
    toolbarButton(pane, "Filter").click();
    popoverButton("This view").click();
    popoverButton("+ Add filter").click();
    const property = document.querySelector<HTMLInputElement>(".class-filter-property");
    type(property, "file.tags");
    type(property, "file.tags", "change");
    type(document.querySelector(".class-filter-values"), "night");

    expect(saved()?.views[0].filter).toEqual([{ property: "file.tags", test: "has", values: ["night"] }]);
    expect(texts(pane.element, "tbody .class-row-title")).toEqual(["Wide", "Insert"]);
    expect(texts(pane.element, ".class-chip-label")).toEqual(["All tags has night"]);
  });

  it("counts every filter on the view on Filter, its own and the Class's", async () => {
    const { pane } = await setup(
      classFile({
        filter: [{ property: "status", test: "not-empty", values: [] }],
        views: [{ name: "All", layout: "list", filter: [{ property: "take", test: "is", values: ["2"] }] }],
      }),
    );
    const badge = pane.toolbar?.querySelector<HTMLElement>(".class-toolbar-button .count-badge");
    expect(badge?.hidden).toBe(false);
    expect(badge?.textContent).toBe("2");
  });

  it("lists All views before This view, and opens on All views while this view has no filter", async () => {
    const { pane } = await setup();
    toolbarButton(pane, "Filter").click();
    const scopes = [...document.querySelectorAll<HTMLElement>(".class-popover-scope")];
    expect(scopes.map(labelOf)).toEqual(["All views", "This view"]);
    expect(scopes.map((each) => each.getAttribute("aria-pressed"))).toEqual(["true", "false"]);
  });

  it("opens Filter on This view once it has filters, and from a chip", async () => {
    const approved = [{ property: "status", test: "is", values: ["approved"] }];
    const { pane } = await setup(classFile({ views: [{ name: "Approved", layout: "list", filter: approved }] }));
    const pressed = () =>
      [...document.querySelectorAll<HTMLElement>(".class-popover-scope")].map((each) =>
        each.getAttribute("aria-pressed"),
      );
    toolbarButton(pane, "Filter").click();
    expect(pressed()).toEqual(["false", "true"]);
    toolbarButton(pane, "Filter").click();
    expect(document.querySelector(".class-popover")).toBeNull();
    pane.element.querySelector<HTMLElement>(".class-chip-label")?.click();
    expect(pressed()).toEqual(["false", "true"]);
  });

  it("shows the Folder rule as a line in All views, and reads the notes again once it changes", async () => {
    const { pane, deps, saved } = await setup();
    toolbarButton(pane, "Filter").click();
    popoverButton("All views").click();
    const line = document.querySelector(".class-filter-line");
    expect(line?.querySelector<HTMLInputElement>(".class-filter-property")?.value).toBe("file.folder");
    expect(line?.querySelector<HTMLInputElement>(".class-filter-values")?.value).toBe("shots");
    const test = line?.querySelector<HTMLSelectElement>("select");
    if (!test) throw new Error("no test");
    test.value = "within";
    test.dispatchEvent(new Event("change"));

    expect(saved()?.filter).toEqual([{ property: "file.folder", test: "within", values: ["shots"] }]);
    expect(deps.loadRows).toHaveBeenCalledTimes(1);
    deps.scheduleSave.mock.calls.at(-1)?.[2]?.();
    await vi.waitFor(() => expect(deps.loadRows).toHaveBeenCalledTimes(2));
  });

  it("reads the whole space once the Folder line is removed", async () => {
    const { pane, deps, saved } = await setup();
    toolbarButton(pane, "Filter").click();
    popoverButton("All views").click();
    document.querySelector<HTMLButtonElement>(".class-filter-line [aria-label='Remove this filter']")?.click();
    expect(saved()?.filter).toEqual([]);
    expect(document.querySelector(".class-filter-line")).toBeNull();
    deps.scheduleSave.mock.calls.at(-1)?.[2]?.();
    await vi.waitFor(() => expect(deps.loadRows).toHaveBeenCalledTimes(2));
  });

  it("offers is within and the Class's own folder only on a Folder line", async () => {
    const { pane, saved } = await setup();
    toolbarButton(pane, "Filter").click();
    popoverButton("All views").click();
    const tests = (line: Element | null | undefined) =>
      [...(line?.querySelectorAll("option") ?? [])].map((option) => option.textContent);
    const folderLine = document.querySelector(".class-filter-line");
    expect(tests(folderLine)).toContain("is within");
    const values = folderLine?.querySelector<HTMLInputElement>(".class-filter-values");
    const offered = document.getElementById(values?.getAttribute("list") ?? "")?.querySelectorAll("option");
    expect([...(offered ?? [])].map((option) => [option.value, option.label])).toEqual([
      ["this.file.folder", "This folder"],
    ]);

    popoverButton("+ Add filter").click();
    const added = document.querySelectorAll(".class-filter-line")[1];
    type(added.querySelector(".class-filter-property"), "status");
    expect(tests(added)).not.toContain("is within");
    expect(added.querySelector(".class-filter-values")?.hasAttribute("list")).toBe(false);

    // Off Folder, "is within" would hold on every row, so it turns back to is.
    const test = document.querySelector<HTMLSelectElement>(".class-filter-line select");
    if (!test) throw new Error("no test");
    test.value = "within";
    test.dispatchEvent(new Event("change"));
    const property = document.querySelector<HTMLInputElement>(".class-filter-property");
    type(property, "take");
    type(property, "take", "change");
    expect(test.value).toBe("is");
    expect(saved()?.filter).toEqual([{ property: "take", test: "is", values: ["shots"] }]);
  });

  describe("a folder dragged in from the tree", () => {
    const dropOn = (path: string, type: "file" | "directory") => {
      const event = new MouseEvent("drop", { bubbles: true, cancelable: true });
      const data = new Map([
        ["text/plain", path],
        ["application/x-pragma-entry-type", type],
      ]);
      Object.defineProperty(event, "dataTransfer", {
        value: { types: [...data.keys()], getData: (kind: string) => data.get(kind) ?? "" },
      });
      document.querySelector(".class-popover")?.dispatchEvent(event);
    };

    it("joins the Folder line once, and a file is refused", async () => {
      const { pane, saved } = await setup();
      toolbarButton(pane, "Filter").click();
      popoverButton("All views").click();
      dropOn("shots/guide.md", "file");
      expect(document.querySelector(".class-popover-error:not([hidden])")?.textContent).toBe(
        "Drop a folder, not a file.",
      );
      dropOn("scenes", "directory");
      dropOn("Scenes/", "directory");
      expect(saved()?.filter).toEqual([{ property: "file.folder", test: "is", values: ["shots", "scenes"] }]);
      expect(document.querySelector<HTMLInputElement>(".class-filter-values")?.value).toBe("shots, scenes");
    });

    it("starts a Folder line on a Class with none", async () => {
      const { pane, saved } = await setup(
        classFile({ filter: [{ property: "status", test: "not-empty", values: [] }] }),
      );
      toolbarButton(pane, "Filter").click();
      popoverButton("All views").click();
      dropOn("scenes", "directory");
      expect(saved()?.filter).toEqual([
        { property: "status", test: "not-empty", values: [] },
        { property: "file.folder", test: "is", values: ["scenes"] },
      ]);
    });
  });

  it("names the Class's own folder This folder in a chip", async () => {
    const own = [{ property: "file.folder", test: "is", values: ["this.file.folder"] }];
    const { pane } = await setup(classFile({ views: [{ name: "All", layout: "list", filter: own }] }));
    expect(texts(pane.element, ".class-chip-label")).toEqual(["Folder is This folder"]);
  });

  it("says when a view keeps nothing, and when the Class can't be read again", async () => {
    const file = classFile({
      views: [{ name: "None", layout: "list", filter: [{ property: "status", test: "is", values: ["shot"] }] }],
    });
    const { pane, deps } = await setup(file);
    expect(pane.element.querySelector(".data-table-empty")?.textContent).toBe("Nothing in this view.");

    deps.loadRows.mockRejectedValueOnce(new Error("offline"));
    toolbarButton(pane, "Filter").click();
    popoverButton("All views").click();
    const test = document.querySelector<HTMLSelectElement>(".class-filter-line select");
    if (!test) throw new Error("no test");
    test.value = "within";
    test.dispatchEvent(new Event("change"));
    deps.scheduleSave.mock.calls.at(-1)?.[2]?.();
    await vi.waitFor(() =>
      expect(pane.element.querySelector(".class-rows-error")?.textContent).toBe("Couldn't refresh this Class: offline"),
    );
  });

  it("adds a view from +, and the tab showing opens its menu", async () => {
    const { pane, saved } = await setup();
    pane.element.querySelector<HTMLButtonElement>(".class-view-add")?.click();
    expect(saved()?.views.map((view) => view.name)).toEqual(["All", "Board", "Approved", "View 4"]);
    expect(texts(pane.element, ".class-view[aria-selected=true]")).toEqual(["View 4"]);

    pane.element.querySelector<HTMLButtonElement>(".class-view[aria-selected=true]")?.click();
    menuItem("Delete view").click();
    expect(saved()?.views.map((view) => view.name)).toEqual(["All", "Board", "Approved"]);
    expect(texts(pane.element, ".class-view[aria-selected=true]")).toEqual(["Approved"]);
  });

  it("opens a field's menu from its header: hiding it writes the fields this view shows", async () => {
    const { pane, saved } = await setup();
    const take = [...pane.element.querySelectorAll<HTMLElement>(".class-field-header")].find(
      (header) => header.textContent === "Take",
    );
    take?.click();
    menuItem("Hide in this view").click();

    expect(saved()?.views[0].fields).toEqual(["status", "tags"]);
    expect(texts(pane.element, "thead th:not(.row-gutter)")).toEqual(["Title", "Status", "Tags"]);
  });

  it("deletes a field from the Class alone, and from every view's list", async () => {
    const file = classFile({
      views: [{ name: "Short", layout: "list", fields: ["take", "status"], filter: [] }],
    });
    const { pane, saved } = await setup(file);
    pane.element.querySelector<HTMLElement>(".class-field-header")?.click();
    menuItem("Delete field").click();
    expect(document.querySelector(".dialog-panel .dialog-title")?.textContent).toBe('Delete the "Take" field?');
    document.querySelector<HTMLButtonElement>(".dialog-panel .dialog-primary")?.click();
    await vi.waitFor(() => expect(saved()?.fields.map((field) => field.id)).toEqual(["status", "tags"]));
    expect(saved()?.views[0].fields).toEqual(["status"]);
  });

  it("changes nothing while reading: no field menus, no new view, and chips without a remove", async () => {
    const { pane } = await setup(classFile(), rows, { reading: true });
    [...pane.element.querySelectorAll<HTMLButtonElement>(".class-view")][2].click();
    expect(texts(pane.element, ".class-chip-label")).toEqual(["Status is approved"]);
    expect(pane.element.querySelector(".class-chip-remove")).toBeNull();
    expect(pane.element.querySelector(".class-field-header")).toBeNull();
    expect(pane.element.querySelector(".class-view-add")).toBeNull();
  });

  // Its field names select with its values only then: in Edit a header opens
  // its field's menu.
  it("marks its rows read-only while reading, and not while editing", async () => {
    const readOnly = (pane: EditorPane) =>
      pane.element.querySelector(".data-table-form")?.classList.contains("is-read-only");
    expect(readOnly((await setup(classFile(), rows, { reading: true })).pane)).toBe(true);
    expect(readOnly((await setup()).pane)).toBe(false);
  });
});

// Info holds facts about the file; what a Class reads is its content, shown
// in Filter ▸ All views where it changes.
describe("classPane: the Info tab", () => {
  it("adds nothing of its own to it until a preview shows a file", async () => {
    const { pane } = await setup(classFile({ metadata: [DESCRIPTION] }));
    expect(pane.inspector?.hidden).toBe(true);
  });
});

describe("classPane: its Properties-tab section", () => {
  it("edits the description there, and writes nothing else", async () => {
    const { pane, deps, saved } = await setup(classFile({ metadata: [DESCRIPTION], views: [] }));
    const field = pane.properties?.querySelector<HTMLTextAreaElement>('[data-key="description"] textarea');
    if (!field) throw new Error("no description field");
    expect(field.value).toBe("Every shot.");
    deps.loadRows.mockClear();

    field.value = "Every shot, by status.";
    field.dispatchEvent(new Event("input"));

    expect(metadataText(saved()?.metadata, "description")).toBe("Every shot, by status.");
    expect(saved()?.views).toEqual([]);
    expect(deps.loadRows).not.toHaveBeenCalled();
  });

  it("edits any other key there, keeping the description in its place", async () => {
    const tags = { key: "tags", values: ["shots"] };
    const { pane, deps, saved } = await setup(classFile({ metadata: [tags, DESCRIPTION], views: [] }));
    deps.loadRows.mockClear();
    const remove = pane.properties?.querySelector<HTMLButtonElement>(".property-editor-pill-remove");
    if (!remove) throw new Error("no tag to remove");
    remove.click();

    expect(saved()?.metadata).toEqual([{ key: "tags", values: [] }, DESCRIPTION]);
    expect(deps.loadRows).not.toHaveBeenCalled();
  });

  it("shows them read-only while reading", async () => {
    const status = { key: "status", values: ["draft"] };
    const { pane } = await setup(classFile({ metadata: [DESCRIPTION, status] }), rows, { reading: true });
    expect(pane.properties?.querySelector("input, textarea")).toBeNull();
    const values = [...(pane.properties?.querySelectorAll(".meta-value") ?? [])];
    expect(values.map((value) => value.textContent)).toEqual(["Every shot.", "draft"]);
  });
});

describe("classPane: values and new notes", () => {
  const cellOf = (pane: EditorPane, row: number, column: number) =>
    pane.element.querySelectorAll("tbody tr")[row].querySelectorAll("td:not(.row-gutter)")[column];

  it("writes one key of one note as its field types it, and says which note", async () => {
    const { pane, deps, edited } = await setup();
    const status = cellOf(pane, 0, 1).querySelector("select") as HTMLSelectElement;
    status.value = "draft";
    status.dispatchEvent(new Event("change"));
    expect(deps.editProperties).toHaveBeenCalledWith("shots/wide.md", expect.any(Function));
    expect(edited).toEqual({ status: "draft" });
    await vi.waitFor(() => expect(deps.reportReadout).toHaveBeenCalledWith("Saved Status in wide.md"));

    const take = cellOf(pane, 2, 2).querySelector("input") as HTMLInputElement;
    take.value = "7";
    take.dispatchEvent(new Event("input"));
    expect(deps.editProperties).toHaveBeenCalledTimes(1);
    take.dispatchEvent(new Event("change"));
    expect(edited).toEqual({ status: "draft", take: 7 });
  });

  it("shows a value that isn't its field's type as written, until the field is set", async () => {
    const { pane, deps, edited } = await setup();
    const status = cellOf(pane, 1, 1).querySelector("select") as HTMLSelectElement;
    expect(status.selectedOptions[0].textContent).toBe("wip · not an option");
    const take = cellOf(pane, 1, 2).querySelector<HTMLButtonElement>(".class-unfit");
    expect(take?.textContent).toBe("two · not integer");
    expect(deps.editProperties).not.toHaveBeenCalled();

    take?.click();
    const input = cellOf(pane, 1, 2).querySelector("input") as HTMLInputElement;
    input.value = "2";
    input.dispatchEvent(new Event("change"));
    expect(edited).toEqual({ take: 2 });
  });

  it("keeps a note whose frontmatter doesn't parse read-only, and says why", async () => {
    const broken: ClassRow = { ...note("bad.md", "Bad", {}), error: "line 2: x" };
    const { pane } = await setup(classFile(), [broken]);
    expect(pane.element.querySelector(".class-row-error")?.textContent).toBe(
      "Its frontmatter doesn't parse: line 2: x",
    );
    expect(cellOf(pane, 0, 1).querySelector("select")).toBeNull();
  });

  it("takes a value back, and says so, when its note can't be written", async () => {
    const { pane, deps } = await setup();
    deps.editProperties.mockRejectedValueOnce(new Error("disk full"));
    const status = cellOf(pane, 0, 1).querySelector("select") as HTMLSelectElement;
    status.value = "draft";
    status.dispatchEvent(new Event("change"));
    await vi.waitFor(() =>
      expect(pane.element.querySelector(".class-rows-error")?.textContent).toBe(
        "Couldn't save Status in wide.md: disk full",
      ),
    );
    expect((cellOf(pane, 0, 1).querySelector("select") as HTMLSelectElement).value).toBe("approved");
  });

  it("makes a new note in the first folder, titled, with what keeps it in view, past a taken name", async () => {
    const file = classFile({
      filter: [{ property: "tags", test: "has", values: ["shot"] }],
      views: [{ name: "Approved", layout: "list", filter: [{ property: "status", test: "is", values: ["approved"] }] }],
    });
    const { pane, deps } = await setup(file);
    deps.createFile.mockRejectedValueOnce(new ApiError("Already exists", 409));
    pane.element.querySelector<HTMLButtonElement>(".data-table-add-row")?.click();
    expect(pane.element.querySelector(".class-new-note-hint")?.textContent).toBe(
      "Made in shots/ with tags: shot, status: approved, so it stays in view.",
    );
    const input = pane.element.querySelector(".class-new-note-input") as HTMLInputElement;
    input.value = "Part 1: Intro";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));

    await vi.waitFor(() => expect(deps.createFile).toHaveBeenCalledTimes(2));
    expect(deps.createFile.mock.calls.map((call) => call[1])).toEqual(["Part 1 - Intro.md", "Part 1 - Intro 2.md"]);
    expect(deps.createFile.mock.calls[1][0]).toBe("shots");
    expect(deps.createFile.mock.calls[1][2]).toBe("---\nstatus: approved\ntags:\n  - shot\n---\n\n# Part 1: Intro\n");
    await vi.waitFor(() => expect(deps.loadRows).toHaveBeenCalledTimes(2));
    expect(deps.reportReadout).toHaveBeenCalledWith("Made Part 1 - Intro 2.md in shots/");
  });

  it("offers no new note, and sets no value, while reading", async () => {
    const { pane } = await setup(classFile(), rows, { reading: true });
    expect(pane.element.querySelector(".data-table-add-row")).toBeNull();
    expect(pane.element.querySelector("tbody select, tbody input")).toBeNull();
  });
});

// A drag, faked as jsdom has no DataTransfer, with where the pointer is.
function drag(target: Element, type: string, at: { clientX?: number; clientY?: number } = {}): Event {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, ...at });
  const data = new Map<string, string>();
  Object.defineProperty(event, "dataTransfer", {
    value: {
      setData: (kind: string, value: string) => data.set(kind, value),
      getData: (kind: string) => data.get(kind) ?? "",
      effectAllowed: "",
      dropEffect: "",
    },
  });
  target.dispatchEvent(event);
  return event;
}

describe("classPane: arranging rows", () => {
  // The folder's entries as it shows them here: its notes, and a Table that
  // is no row.
  const listed = ["wide.md", "notes.table.html", "close.md", "insert.md"];
  const titleOf = (pane: EditorPane, title: string) =>
    [...pane.element.querySelectorAll<HTMLElement>(".class-row-title")].find(
      (each) => each.textContent === title,
    ) as HTMLElement;

  it("drags a row by its title before another, among every entry its folder lists", async () => {
    const { pane, deps } = await setup(classFile(), rows, { arrangement: listed });
    const insert = titleOf(pane, "Insert");
    expect(insert.draggable).toBe(true);
    drag(insert, "dragstart");
    const wide = titleOf(pane, "Wide").closest("tr") as HTMLElement;
    expect(drag(wide, "dragover", { clientY: 0 }).defaultPrevented).toBe(true);
    expect(wide.classList.contains("class-drop-before")).toBe(true);
    drag(wide, "drop", { clientY: 0 });
    expect(deps.arrange).toHaveBeenCalledWith("shots", ["insert.md", "wide.md", "notes.table.html", "close.md"]);
    expect(wide.classList.contains("class-drop-before")).toBe(false);
  });

  it("drops a card after another by the half it is over", async () => {
    const file = classFile({ views: [{ name: "Cards", layout: "cards", filter: [] }] });
    const { pane, deps } = await setup(file, rows, { arrangement: listed });
    drag(titleOf(pane, "Wide"), "dragstart");
    const close = titleOf(pane, "Close").closest(".data-cards-card") as HTMLElement;
    drag(close, "dragover", { clientX: 1 });
    expect(close.classList.contains("class-drop-after")).toBe(true);
    drag(close, "drop", { clientX: 1 });
    expect(deps.arrange).toHaveBeenCalledWith("shots", ["notes.table.html", "close.md", "wide.md", "insert.md"]);
  });

  it("drags no row where the order isn't one folder's own", async () => {
    const draggable = async (file: ClassFileResponse, options: { arrangement?: string[]; reading?: boolean }) => {
      const { pane } = await setup(file, rows, options);
      return [...pane.element.querySelectorAll<HTMLElement>(".class-row-title")].some((title) => title.draggable);
    };
    const arranged = { arrangement: listed };
    expect(await draggable(classFile(), arranged)).toBe(true);
    // A view sorted or grouped shows an order of its own.
    const sorted = { name: "By take", layout: "list" as const, sort: { property: "take", order: "asc" as const } };
    expect(await draggable(classFile({ views: [{ ...sorted, filter: [] }] }), arranged)).toBe(false);
    const board = { name: "Board", layout: "cards" as const, groupBy: "status", filter: [] };
    expect(await draggable(classFile({ views: [board] }), arranged)).toBe(false);
    // Rows from several folders, or from below one, follow no one order.
    const within = [{ property: "file.folder", test: "within", values: ["shots"] }];
    expect(await draggable(classFile({ filter: within }), arranged)).toBe(false);
    const two = [{ property: "file.folder", test: "is", values: ["shots", "scenes"] }];
    expect(await draggable(classFile({ filter: two }), arranged)).toBe(false);
    // A folder shown in another order here, and reading view.
    expect(await draggable(classFile(), {})).toBe(false);
    expect(await draggable(classFile(), { ...arranged, reading: true })).toBe(false);
  });

  it("reads its rows again once a folder it reads is arranged, here or anywhere", async () => {
    const { deps, sorted } = await setup(classFile(), rows, { arrangement: listed });
    sorted("elsewhere");
    sorted("shots/inner");
    expect(deps.loadRows).toHaveBeenCalledTimes(1);
    sorted("shots");
    await vi.waitFor(() => expect(deps.loadRows).toHaveBeenCalledTimes(2));

    const below = await setup(
      classFile({ filter: [{ property: "file.folder", test: "within", values: ["shots"] }] }),
      rows,
    );
    below.sorted("shots/inner");
    await vi.waitFor(() => expect(below.deps.loadRows).toHaveBeenCalledTimes(2));
  });

  it("says so when its folder can't be arranged", async () => {
    const { pane, deps } = await setup(classFile(), rows, { arrangement: listed });
    deps.arrange.mockRejectedValueOnce(new Error("Reorder failed"));
    drag(titleOf(pane, "Insert"), "dragstart");
    drag(titleOf(pane, "Wide").closest("tr") as HTMLElement, "drop", { clientY: 0 });
    await vi.waitFor(() =>
      expect(pane.element.querySelector(".class-rows-error")?.textContent).toBe(
        "Couldn't arrange shots/: Reorder failed",
      ),
    );
  });
});

describe("classPane: a pane too narrow for its toolbar", () => {
  afterEach(() => vi.unstubAllGlobals());

  // A pane `width` wide whose toolbar buttons the browser measures at 300.
  async function paneOf(width: number, options: { reading?: boolean } = {}) {
    let measure: (() => void) | undefined;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          measure = callback;
        }
        observe() {}
        disconnect() {}
      },
    );
    const { pane } = await setup(classFile(), rows, options);
    Object.defineProperty(pane.toolbar as HTMLElement, "scrollWidth", { configurable: true, value: 300 });
    Object.defineProperty(pane.element, "clientWidth", { configurable: true, value: width });
    measure?.();
    return pane;
  }

  function toolbarMenu(pane: EditorPane): (string | undefined)[] {
    const menus = createMenus(createCommands());
    classPane({ menus } as never);
    const tab = { kind: "class" as const, path: "shots/shots.class.html" };
    return menus.resolve("editor.toolbar", { tab, pane }).map((item) => item.label);
  }

  it("folds Filter, Sort, Group, Fields, Links and New note into ⋮ where they'd crowd the title", async () => {
    const wide = await paneOf(1000);
    expect(wide.toolbar?.classList.contains("is-folded")).toBe(false);
    expect(toolbarMenu(wide)).toEqual([]);

    const narrow = await paneOf(500);
    expect(narrow.toolbar?.classList.contains("is-folded")).toBe(true);
    expect(toolbarMenu(narrow)).toEqual(["Filter…", "Sort…", "Group…", "Fields…", "Links…", "New note…"]);
  });

  it("opens each one from ⋮ as its button would", async () => {
    const pane = await paneOf(500);
    pane.openTool("sort");
    expect(document.querySelector('.class-popover[aria-label="Sort"]')).not.toBeNull();
    pane.openTool("fields");
    expect(document.querySelector('.class-popover[aria-label="Sort"]')).toBeNull();
    expect(document.querySelector('.class-popover[aria-label="Fields"]')).not.toBeNull();
    pane.openTool("new-note");
    expect(document.activeElement?.classList.contains("class-new-note-input")).toBe(true);
  });

  it("offers nothing from ⋮ while reading, when there are no buttons to fold", async () => {
    expect(toolbarMenu(await paneOf(500, { reading: true }))).toEqual([]);
  });
});

describe("classPane: its links", () => {
  const popover = () => document.querySelector<HTMLElement>('.class-popover[aria-label="Links"]');
  const named = () => texts(popover() ?? document.body, ".class-link-name");
  const openLinks = (pane: EditorPane) =>
    (
      [...(pane.toolbar as HTMLElement).querySelectorAll<HTMLButtonElement>("button")].find((button) =>
        button.textContent?.startsWith("Links"),
      ) as HTMLButtonElement
    ).click();
  const fileItem = (name: string) =>
    [...document.querySelectorAll<HTMLButtonElement>(".context-menu button")].find((button) =>
      button.textContent?.startsWith(name),
    );
  const press = (label: string) => {
    const found = [...(popover()?.querySelectorAll<HTMLElement>("button") ?? [])].find(
      (each) => each.textContent === label || each.getAttribute("aria-label") === label,
    );
    if (!found) throw new Error(`no "${label}" in Links`);
    found.click();
  };

  it("lists its links by what they give, counts them, adds a file picked from the space's, and removes one", async () => {
    const { pane, saved } = await setup(classFile({ links: ["../tools/polish.flow.html", "guide.md"], filter: [] }));
    expect((pane.toolbar as HTMLElement).querySelector(".count-badge:not([hidden])")?.textContent).toBe("2");
    openLinks(pane);
    expect(texts(popover() ?? document.body, ".class-popover-heading")).toEqual([
      "Flows · buttons in each note's Tools tab",
      "Files · in each note's Links tab",
    ]);
    expect(named()).toEqual(["polish", "guide"]);

    press("+ Add file");
    expect(fileItem("polish")?.getAttribute("aria-checked")).toBe("true");
    fileItem("lyrics")?.click();
    expect(saved()?.links).toEqual(["../tools/polish.flow.html", "guide.md", "../tools/lyrics.flow.html"]);
    expect(named()).toEqual(["polish", "lyrics", "guide"]);

    press("Remove this link");
    expect(saved()?.links).toEqual(["guide.md", "../tools/lyrics.flow.html"]);
    expect(named()).toEqual(["lyrics", "guide"]);
  });

  it("stays open while a file is picked from its menu or dragged in, and closes on a click anywhere else", async () => {
    const { pane } = await setup();
    openLinks(pane);
    // A popover hears presses a tick after it opens.
    await new Promise((resolve) => setTimeout(resolve, 0));
    press("+ Add file");
    const menu = document.querySelector('.context-menu[role="menu"]') as HTMLElement;
    menu.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    menu.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(popover()).not.toBeNull();
    // A press in the tree may become a drag, which ends with no click.
    document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    expect(popover()).not.toBeNull();
    document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(popover()).toBeNull();
  });

  it("takes a file dragged in from the tree, and says why it takes no folder", async () => {
    const { pane, saved } = await setup();
    openLinks(pane);
    const dropOf = (path: string, type: "file" | "directory") => {
      const event = new MouseEvent("drop", { bubbles: true, cancelable: true });
      const data = new Map([
        ["text/plain", path],
        ["application/x-pragma-entry-type", type],
      ]);
      Object.defineProperty(event, "dataTransfer", {
        value: { types: [...data.keys()], getData: (kind: string) => data.get(kind) ?? "" },
      });
      popover()?.dispatchEvent(event);
    };

    dropOf("tools", "directory");
    expect(popover()?.querySelector(".class-popover-error:not([hidden])")?.textContent).toBe(
      "Drop a file, not a folder.",
    );
    dropOf("shots/guide.md", "file");
    expect(saved()?.links).toEqual(["guide.md"]);
    expect(named()).toEqual(["guide"]);
  });

  it("starts New note from its template, then gives the note what keeps it in view", async () => {
    listTemplates();
    const view = {
      name: "Approved",
      layout: "list" as const,
      filter: [{ property: "status", test: "is", values: ["approved"] }],
    };
    const { pane, deps, edited } = await setup(classFile({ links: ["../_templates/shot.md"], views: [view] }));
    pane.element.querySelector<HTMLButtonElement>(".data-table-add-row")?.click();
    expect(pane.element.querySelector(".class-new-note-hint")?.textContent).toBe(
      "Made in shots/ from shot, with status: approved, so it stays in view.",
    );
    const input = pane.element.querySelector(".class-new-note-input") as HTMLInputElement;
    input.value = "Dolly in";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));

    await vi.waitFor(() => expect(deps.loadRows).toHaveBeenCalledTimes(2));
    expect(deps.createFromTemplate).toHaveBeenCalledWith("_templates/shot.md", "shots", "Dolly in");
    expect(deps.createFile).not.toHaveBeenCalled();
    expect(deps.editProperties.mock.calls[0][0]).toBe("shots/Dolly in.md");
    expect(edited).toEqual({ status: "approved" });
  });

  it("asks which template a new note starts from when the Class links several", async () => {
    listTemplates();
    const { pane, deps } = await setup(classFile({ links: ["../_templates/shot.md", "../_templates/still.md"] }));
    pane.element.querySelector<HTMLButtonElement>(".data-table-add-row")?.click();
    const choice = pane.element.querySelector(".class-new-note-template") as HTMLSelectElement;
    expect([...choice.options].map((option) => option.textContent)).toEqual(["shot", "still"]);
    choice.value = "_templates/still.md";
    choice.dispatchEvent(new Event("change"));
    const input = pane.element.querySelector(".class-new-note-input") as HTMLInputElement;
    input.value = "Close";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));

    await vi.waitFor(() =>
      expect(deps.createFromTemplate).toHaveBeenCalledWith("_templates/still.md", "shots", "Close"),
    );
  });
});

describe("classPane: screenplays and media as rows", () => {
  const cellOf = (pane: EditorPane, row: number, column: number) =>
    pane.element.querySelectorAll("tbody tr")[row].querySelectorAll("td:not(.row-gutter)")[column];
  const kinds: ClassRow[] = [
    note("look.md", "Look", { status: "draft" }),
    { ...note("draft.fountain", "Brick", { title: "Brick", status: "approved" }), kind: "screenplay" },
    { ...note("frame.png", "frame", {}), kind: "image", size: 2048 },
  ];
  const facts = [
    { id: "status", type: "select" as const, label: "Status", options: ["draft", "approved"] },
    { id: "file.ext", type: "text" as const, label: "Extension" },
    { id: "file.size", type: "integer" as const, label: "Size" },
  ];

  it("shows a screenplay's title page and a file's own facts, and sets neither", async () => {
    const { pane } = await setup(classFile({ fields: facts, views: [] }), kinds);
    const values = (row: number) => [1, 2, 3].map((column) => cellOf(pane, row, column).textContent?.trim());
    expect(values(1)).toEqual(["approved", "fountain", "64"]);
    expect(values(2).slice(1)).toEqual(["png", "2048"]);
    expect(cellOf(pane, 1, 1).querySelector("select, input")).toBeNull();
    expect(cellOf(pane, 0, 2).querySelector("select, input")).toBeNull();
    // A note's own value can still be set.
    expect(cellOf(pane, 0, 1).querySelector("select")).not.toBeNull();
  });

  // A note's media field and a picture's own file share the cards' picture
  // slot, so a preview steps from one to the other.
  it("previews a card's picture over the Class, stepping from a note's to a file's own, pointing the copilot and the Info tab at each", async () => {
    const covered: ClassRow[] = [
      note("look.md", "Look", { cover: "look.png" }),
      { ...note("frame.png", "frame", {}), kind: "image", size: 2048 },
    ];
    const file = classFile({
      fields: [{ id: "cover", type: "media", label: "Cover" }],
      views: [{ name: "Cards", layout: "cards", filter: [] }],
    });
    const { pane, deps } = await setup(file, covered);
    const preview = pane.element.querySelector(".file-preview") as HTMLElement;
    const shown = () => preview.querySelector(".file-preview-frame > img")?.getAttribute("src");
    pane.element.querySelector<HTMLButtonElement>(".media-field-thumb")?.click();
    expect(preview.hidden).toBe(false);
    expect(shown()).toBe("/raw?path=shots/look.png");
    expect(pane.selectedFile?.()).toEqual({ path: "shots/look.png", previewing: true });
    const named = () => pane.inspector?.querySelector(".meta-value")?.textContent;
    expect([pane.inspector?.hidden, named()]).toEqual([false, "look.png"]);
    pane.element.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(shown()).toBe("/raw?path=shots/frame.png");
    expect(pane.selectedFile?.()).toEqual({ path: "shots/frame.png", previewing: true });
    expect(named()).toBe("frame.png");
    pane.dismissTransient?.();
    expect(preview.hidden).toBe(true);
    expect(pane.selectedFile?.()).toBeUndefined();
    expect(pane.inspector?.hidden).toBe(true);
    expect(deps.openPath).not.toHaveBeenCalled();
  });

  it("pictures a media row with its own file among cards", async () => {
    const { pane } = await setup(classFile({ views: [{ name: "Cards", layout: "cards", filter: [] }] }), kinds);
    const cards = [...pane.element.querySelectorAll(".data-cards-card")];
    expect(cards.map((card) => card.querySelector(".data-cards-picture") !== null)).toEqual([false, false, true]);
    expect(cards[2].querySelector(".media-field-name")?.textContent).toBe("frame.png");
  });

  it("adds a file's own fact from Fields, typed by the file", async () => {
    const { pane, saved } = await setup();
    const fields = [...(pane.toolbar as HTMLElement).querySelectorAll("button")].find(
      (button) => button.textContent === "Fields",
    );
    fields?.click();
    const offered = () => [...document.querySelectorAll(".class-popover-facts button")].map((each) => each.textContent);
    expect(offered()).toEqual(["+ Name", "+ Folder", "+ Extension", "+ Size", "+ Modified", "+ All tags"]);
    ([...document.querySelectorAll<HTMLButtonElement>(".class-popover-facts button")].at(-2) as HTMLElement).click();
    expect(saved()?.fields.at(-1)).toEqual({ id: "file.modified", type: "timestamp", label: "Modified" });
    expect(offered()).toEqual(["+ Name", "+ Folder", "+ Extension", "+ Size", "+ All tags"]);
  });

  it("gives a file's own fact no type of its own to change", async () => {
    const { pane } = await setup(classFile({ fields: facts.slice(1), views: [] }), kinds);
    (pane.element.querySelector(".class-field-header") as HTMLElement).click();
    expect(texts(document.body, ".context-menu button")).toEqual(["Rename…", "Hide in this view", "Delete field"]);
  });

  it("groups by a file's own fact, with one New note after the groups", async () => {
    const view = { name: "By extension", layout: "list" as const, groupBy: "file.ext", filter: [] };
    const { pane } = await setup(classFile({ fields: facts, views: [view] }), [...kinds].reverse());
    expect(texts(pane.element, ".class-group-heading")).toEqual(["fountain1", "md1", "png1"]);
    expect(pane.element.querySelectorAll(".data-table-add-row")).toHaveLength(1);
  });
});

describe("classPane: find", () => {
  it("finds the rows' titles and values, never a column's name or a group's heading", async () => {
    const { pane } = await setup();
    const aside = pane.toolbarAside;
    if (!aside) throw new Error("the Class pane has no toolbar aside");
    document.body.append(aside);
    const field = () => aside.querySelector(".find-card:not(.is-closing) .find-card-input") as HTMLInputElement;
    const count = () => aside.querySelector(".find-card:not(.is-closing) .find-card-count")?.textContent;
    const type = (value: string) => {
      field().value = value;
      field().dispatchEvent(new Event("input"));
    };

    expect(pane.findable?.()).toBe("find");
    pane.openFind?.(false);
    expect(aside.querySelector<HTMLElement>(".find-card-reveal")?.hidden).toBe(true);
    type("Wide");
    expect(count()).toBe("1 of 1");
    type("Status");
    expect(count()).toBe("No matches");
    type("approved");
    expect(count()).toBe("1 of 1");

    // The Board groups by status, under a heading that names it.
    [...pane.element.querySelectorAll<HTMLButtonElement>(".class-view")][1].click();
    await Promise.resolve();
    expect(texts(pane.element, ".class-group-heading")[0]).toContain("approved");
    expect(count()).toBe("1 of 1");

    pane.dismissTransient?.();
    expect(pane.hasTransient?.()).toBe(false);
  });
});

describe("classPane: a row's card", () => {
  afterEach(() => window.dispatchEvent(new MouseEvent("mousedown", { detail: 1 })));

  const open = (pane: EditorPane, index: number) =>
    pane.element.querySelectorAll<HTMLButtonElement>("tbody .row-open")[index].click();
  const cardTitle = (pane: EditorPane) => pane.element.querySelector(".row-card-title")?.textContent;
  const tile = (pane: EditorPane, name: string) =>
    [...pane.element.querySelectorAll(".row-card-tile")].find(
      (each) => each.querySelector(".row-card-label")?.textContent === name,
    ) as HTMLElement;
  const facts = (pane: EditorPane) => pane.element.querySelector(".row-card-facts")?.textContent;
  // Takes in a view sorted by them, so a new take moves its row.
  const takes = [
    note("one.md", "One", { status: "draft", take: 1 }),
    note("two.md", "Two", { status: "draft", take: 2 }),
    note("three.md", "Three", { status: "draft", take: 3 }),
  ];
  const byTake = classFile({
    views: [{ name: "By take", layout: "list", sort: { property: "take", order: "asc" }, filter: [] }],
  });

  it("opens a note's card from its gutter, offers the note in a new tab, and writes an edit to it", async () => {
    const { pane, deps, edited } = await setup();
    open(pane, 0);
    expect(cardTitle(pane)).toBe("Wide");
    expect(facts(pane)).toBe("Row 1 of 3 · Shots");
    (pane.element.querySelector(".row-card-open") as HTMLButtonElement).click();
    expect(deps.openBeside).toHaveBeenCalledWith("shots/wide.md");

    const take = tile(pane, "Take").querySelector("input") as HTMLInputElement;
    take.value = "5";
    take.dispatchEvent(new Event("change"));
    expect(deps.editProperties).toHaveBeenCalledWith("shots/wide.md", expect.any(Function));
    expect(edited).toEqual({ take: 5 });
  });

  it("arranges in Design mode alone, writing the Class's card block, and never while reading", async () => {
    const { pane, deps, saved } = await setup();
    const moveRight = (on: EditorPane, name: string) =>
      tile(on, name)
        .querySelector(".row-card-label")
        ?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", altKey: true, bubbles: true }));
    open(pane, 1);
    expect(pane.element.querySelector(".row-card-page")?.classList.contains("is-arrangeable")).toBe(false);
    moveRight(pane, "Status");
    expect(deps.scheduleSave).not.toHaveBeenCalled();

    pane.design?.toggle();
    expect(pane.design?.isActive()).toBe(true);
    moveRight(pane, "Status");
    expect(saved()?.card).toEqual([{ field: "take" }, { field: "status" }, { field: "tags" }]);

    const reading = await setup(classFile(), rows, { reading: true });
    reading.pane.design?.toggle();
    open(reading.pane, 0);
    expect(reading.pane.element.querySelector(".row-card-page")?.classList.contains("is-arrangeable")).toBe(false);
    moveRight(reading.pane, "Status");
    expect(reading.deps.scheduleSave).not.toHaveBeenCalled();
  });

  it("locks the card's values in Design mode, leaving the list's to edit, and ends Design with the Class", async () => {
    const { pane } = await setup();
    pane.design?.toggle();
    open(pane, 0);
    expect(pane.element.querySelector(".row-card-value :is(input, select, textarea)")).toBeNull();
    expect(tile(pane, "Take").querySelector(".row-card-value")?.textContent).toBe("2");
    expect(pane.element.querySelector("tbody select")).not.toBeNull();

    pane.design?.toggle();
    expect(tile(pane, "Take").querySelector("input")?.value).toBe("2");

    pane.design?.toggle();
    await pane.setInput(
      { kind: "class", path: "other.class.html" },
      { isCurrent: () => true },
      {
        ...classFile(),
        path: "other.class.html",
      },
    );
    expect(pane.design?.isActive()).toBe(false);
  });

  it("follows its row to the place a sort moves it, its controls kept", async () => {
    const { pane } = await setup(byTake, takes);
    open(pane, 0);
    const take = tile(pane, "Take").querySelector("input") as HTMLInputElement;
    take.value = "9";
    take.dispatchEvent(new Event("change"));
    expect(cardTitle(pane)).toBe("One");
    expect(tile(pane, "Take").querySelector("input")).toBe(take);
    expect(facts(pane)).toBe("Row 3 of 3 · Shots");

    pane.dismissTransient?.();
    const selected = pane.element.querySelector("tbody > tr.is-selected .class-row-title");
    expect(selected?.textContent).toBe("One");
  });

  it("closes with a row an edit takes out of the view, as the row leaves the grid", async () => {
    const approved = classFile({
      views: [{ name: "Approved", layout: "list", filter: [{ property: "status", test: "is", values: ["approved"] }] }],
    });
    const { pane } = await setup(approved);
    open(pane, 0);
    const status = tile(pane, "Status").querySelector("select") as HTMLSelectElement;
    status.value = "draft";
    status.dispatchEvent(new Event("change"));
    expect(pane.hasTransient?.()).toBe(false);
  });

  it("draws its row again from a fresh read of the rows", async () => {
    const { pane, deps, sorted } = await setup(classFile(), rows, {
      arrangement: ["wide.md", "close.md", "insert.md"],
    });
    open(pane, 0);
    const take = tile(pane, "Take").querySelector("input");
    sorted("shots");
    await vi.waitFor(() => expect(deps.loadRows).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(tile(pane, "Take").querySelector("input")).not.toBe(take));
    expect(cardTitle(pane)).toBe("Wide");
  });

  it("takes a field added to the Class at the card's end, and loses a deleted field's tile", async () => {
    const { pane, saved } = await setup(
      classFile({ card: [{ field: "take" }, { heading: "Review" }, { field: "status" }] }),
    );
    const fields = [...(pane.toolbar as HTMLElement).querySelectorAll("button")].find(
      (button) => button.textContent === "Fields",
    );
    fields?.click();
    ([...document.querySelectorAll<HTMLButtonElement>(".class-popover-facts button")].at(-2) as HTMLElement).click();
    expect(saved()?.card).toEqual([
      { field: "take" },
      { heading: "Review" },
      { field: "status" },
      { field: "file.modified" },
    ]);

    [...pane.element.querySelectorAll<HTMLElement>(".class-field-header")]
      .find((header) => header.textContent?.includes("Take"))
      ?.click();
    menuItem("Delete field").click();
    document.querySelector<HTMLButtonElement>(".dialog-panel .dialog-primary")?.click();
    await vi.waitFor(() =>
      expect(saved()?.card).toEqual([{ heading: "Review" }, { field: "status" }, { field: "file.modified" }]),
    );
  });

  it("names its note to its ⋮, and closes onto the row in its place once a write takes the note away", async () => {
    const { pane, deps, wrote, tell } = await setup();
    const opens = vi.spyOn(deps.contextMenu, "open");
    open(pane, 1);
    (pane.element.querySelector(".row-card-more") as HTMLButtonElement).click();
    expect(opens).toHaveBeenLastCalledWith(
      expect.objectContaining({ menu: ROW_CARD_MENU, arg: { file: "shots/close.md" } }),
    );

    deps.loadRows.mockImplementation(async () => structuredClone([rows[0], rows[2]]));
    wrote();
    tell("shots/close.md", ".trash/close.md");
    await vi.waitFor(() => expect(pane.hasTransient?.()).toBe(false));
    const selected = pane.element.querySelector("tbody > tr.is-selected .class-row-title");
    expect(selected?.textContent).toBe("Insert");
  });

  it("closes when the pane shows another Class, or nothing", async () => {
    const { pane } = await setup();
    open(pane, 0);
    await pane.setInput(
      { kind: "class", path: "other.class.html" },
      { isCurrent: () => true },
      {
        ...classFile(),
        path: "other.class.html",
      },
    );
    expect(pane.hasTransient?.()).toBe(false);
    open(pane, 0);
    pane.clearInput();
    expect(pane.hasTransient?.()).toBe(false);
  });
});

describe("classPane: writes and a row's menu", () => {
  it("reads its rows again for a write in a folder it reads, never another's or one a read since holds", async () => {
    const { deps, wrote, tell, sorted } = await setup(classFile(), rows, {
      arrangement: ["wide.md", "close.md", "insert.md"],
    });
    expect(deps.loadRows).toHaveBeenCalledTimes(1);
    wrote();
    tell("notes/elsewhere.md");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(deps.loadRows).toHaveBeenCalledTimes(1);

    // A read started once a write landed holds it, so its notice reads nothing more.
    wrote();
    sorted("shots");
    await vi.waitFor(() => expect(deps.loadRows).toHaveBeenCalledTimes(2));
    tell("shots/new.md");
    expect(deps.loadRows).toHaveBeenCalledTimes(2);

    wrote();
    tell("shots/newer.md");
    await vi.waitFor(() => expect(deps.loadRows).toHaveBeenCalledTimes(3));
    wrote();
    tell("shots");
    await vi.waitFor(() => expect(deps.loadRows).toHaveBeenCalledTimes(4));
  });

  it("draws nothing from a read that lands after a newer one", async () => {
    const { pane, deps, wrote, tell, sorted } = await setup(classFile(), rows, {
      arrangement: ["wide.md", "close.md", "insert.md"],
    });
    const titles = () => texts(pane.element, ".class-row-title");
    let land: (read: ClassRow[]) => void = () => undefined;
    deps.loadRows.mockImplementationOnce(() => new Promise((resolve) => (land = resolve)));
    wrote();
    tell("shots/new.md");
    await vi.waitFor(() => expect(deps.loadRows).toHaveBeenCalledTimes(2));
    deps.loadRows.mockImplementationOnce(async () => structuredClone([rows[0]]));
    sorted("shots");
    await vi.waitFor(() => expect(titles()).toEqual(["Wide"]));
    land(structuredClone(rows));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(titles()).toEqual(["Wide"]);
  });

  it("names a row's note under Open card on its right-click, by its place among the rows shown", async () => {
    const opened: MenuOpenOptions[] = [];
    const installed = installTextMenu({ open: (options) => void opened.push(options) });
    onTestFinished(() => installed.dispose());
    const takes = [
      note("one.md", "One", { status: "draft", take: 1 }),
      note("two.md", "Two", { status: "approved", take: 2 }),
      note("three.md", "Three", { status: "draft", take: 3 }),
    ];
    const board = classFile({
      views: [
        { name: "Board", layout: "cards", groupBy: "status", sort: { property: "take", order: "desc" }, filter: [] },
      ],
    });
    const { pane } = await setup(board, takes);
    for (const title of ["One", "Two", "Three"]) {
      const card = [...pane.element.querySelectorAll(".data-cards-card")].find(
        (each) => each.querySelector(".class-row-title")?.textContent === title,
      );
      card?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
      expect(opened.at(-1)).toEqual(
        expect.objectContaining({ menu: ROW_MENU, arg: { file: `shots/${title.toLowerCase()}.md` } }),
      );
    }
    expect(opened.at(-1)?.items?.map((item) => item.label)).toEqual(["Open card"]);
  });
});
