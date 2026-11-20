// @vitest-environment jsdom
import { undo, undoDepth } from "@codemirror/commands";
import { openSearchPanel, searchPanelOpen } from "@codemirror/search";
import { EditorView, keymap } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import {
  type AppletFileResponse,
  type Backlink,
  type FileResponse,
  getBacklinks,
  type Tab,
  type TextFileResponse,
} from "../../../../web/core/apiClient.ts";
import type { DocumentLinks } from "../../../../web/core/spaceTree.ts";
import { acceptAll } from "../../../../web/editProposal.ts";
import type { TagSource } from "../../../../web/lib/tagSuggestions.ts";
import { installTextMenu } from "../../../../web/lib/textMenu.ts";
import type { CommandContext } from "../../../../web/services/commands.ts";
import { createDialogService } from "../../../../web/services/dialog.ts";
import { createDocuments } from "../../../../web/services/documents.ts";
import { createFormats, type FormatRegistry } from "../../../../web/services/formats.ts";
import type { MenuItem } from "../../../../web/services/menus.ts";
import type { SaveQueue } from "../../../../web/services/saveQueue.ts";
import type { EditorLayout, Setting } from "../../../../web/services/settings.ts";
import { createLinksList } from "../../../../web/view/linksList.ts";
import {
  appletSourcePane,
  createDocumentPane,
  DOCUMENT_KEYMAP,
  type DocumentPane,
  type DocumentPaneKind,
  documentPane,
  isDocumentPane,
} from "../../../../web/view/panes/documentPane.ts";
import { createPropertyEditor } from "../../../../web/view/propertyEditor.ts";
import { polyfillRangeRects } from "../../support/codemirrorJsdom.ts";
import { memorySetting, testLayout } from "../../support/editorLayout.ts";
import { testFormats } from "../../support/formats.ts";
import { fakePaneGroup } from "../../support/paneGroup.ts";

polyfillRangeRects();
// jsdom lays nothing out, so there is no resize to observe.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

function noteFile(overrides: Partial<TextFileResponse> = {}): TextFileResponse {
  return {
    kind: "text",
    path: "notes/song.md",
    revision: "rev-1",
    documentType: "note",
    content: "---\ntags:\n  - a\n---\n\n# Song\n\nfirst line\n",
    toolkits: [],
    classLinks: [],
    ...overrides,
  };
}

function screenplay(): TextFileResponse {
  return noteFile({ path: "scene.fountain", documentType: "screenplay", content: "INT. ROOM - DAY\n" });
}

function applet(): AppletFileResponse {
  return {
    kind: "applet",
    path: "tools/hello.applet.html",
    html: "<html><body>hi</body></html>",
  } as AppletFileResponse;
}

interface LinkSources {
  worldNames?: (docPath: string) => ((name: string) => string | undefined) | undefined;
  markdownLinks?: (docPath: string, content: string) => DocumentLinks;
  tags?: TagSource;
  // In place of the app's two formats, wired to the sources above.
  formats?: FormatRegistry;
  layout?: EditorLayout;
  formatColumn?: Setting<boolean>;
  spellcheck?: Setting<boolean>;
  runCommand?: (id: string, arg?: unknown) => void;
}

// Every pane a test opens, disposed after it as closing one in the app
// does: an open pane keeps its Links redraw timer, which can fire after the
// file's DOM is torn down and fail the run with an unhandled error.
// Backlinks asks the server; here no note links anywhere unless a test
// says so.
vi.mock("../../../../web/core/apiClient.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../web/core/apiClient.ts")>()),
  getBacklinks: vi.fn(async () => []),
}));

const opened: DocumentPane[] = [];
// The text menu, as the app installs it, where a test puts a link's menu
// above it.
const textMenus: { dispose(): void }[] = [];
afterEach(() => {
  for (const menu of textMenus.splice(0)) menu.dispose();
  for (const pane of opened.splice(0)) if (pane.element.isConnected) pane.dispose();
  vi.mocked(getBacklinks)
    .mockReset()
    .mockImplementation(async () => []);
});

function setup(kind: DocumentPaneKind = "document", onDisk: FileResponse = noteFile(), sources: LinkSources = {}) {
  const queue: SaveQueue & { schedule: Mock<SaveQueue["schedule"]> } = {
    schedule: vi.fn<SaveQueue["schedule"]>(),
    flush: vi.fn(async () => true),
    pendingContent: () => undefined,
    state: () => ({ failedPaths: [], conflictPaths: [] }),
    subscribe: () => () => {},
    noteRevision: vi.fn(),
    // Older than any fixture's file, so a reload reads disk in.
    settledRevision: () => "rev-0",
    resolveConflict: vi.fn(),
    move: vi.fn(),
    pause: () => () => {},
    rebase: vi.fn(async () => {}),
    saveNow: vi.fn(async () => true),
    hasPending: () => false,
  };
  const loadFile = vi.fn(async (_path: string) => onDisk);
  const documents = createDocuments({ queue, fetchFile: loadFile });
  let readingView = false;
  let sourceMode = false;
  const deps = {
    documents,
    saveQueue: queue,
    loadFile,
    isReadingView: () => readingView,
    // As a group does it: the mode changes, then its pane re-applies it.
    leaveReadingView: vi.fn(() => {
      readingView = false;
      pane.refresh();
    }),
    isSourceMode: () => sourceMode,
    formats:
      sources.formats ??
      testFormats({
        resolveWikilinkTarget: (target: string) => `resolved/${target}.md`,
        worldNames: sources.worldNames,
        markdownLinks: sources.markdownLinks,
        loadFile,
      }),
    treeOrder: (paths: readonly string[]) => [...paths],
    describe: async () => undefined,
    openPath: vi.fn(),
    openBeside: vi.fn(),
    contextMenu: { open: vi.fn(), close: vi.fn(), isOpen: () => false },
    dialog: createDialogService(),
    createPropertyEditor,
    tags: sources.tags ?? { known: () => [], read: async () => [] },
    createLinksList,
    linksOneList: memorySetting(false),
    onWordCount: vi.fn(),
    revealProperties: vi.fn(),
    onAddPropertyAvailable: vi.fn(),
    onPlaceChange: vi.fn(),
    onSpaceChanged: vi.fn(),
    notify: vi.fn(),
    reportProblems: vi.fn(),
    layout: sources.layout ?? testLayout(),
    formatColumn: sources.formatColumn ?? memorySetting(false),
    formatColumnExtra: memorySetting(0),
    spellcheck: sources.spellcheck ?? memorySetting(true),
    runCommand: sources.runCommand ?? vi.fn(),
    shortcutFor: (_id: string): string | undefined => undefined,
  };
  const pane = createDocumentPane(kind, deps);
  opened.push(pane);
  document.body.append(pane.element);
  return {
    pane,
    documents,
    queue,
    loadFile,
    deps,
    setReadingView: (on: boolean) => {
      readingView = on;
    },
    setSourceMode: (on: boolean) => {
      sourceMode = on;
    },
  };
}

const current = { isCurrent: () => true };
const songTab = (): Tab => ({ kind: "document", path: "notes/song.md", documentType: "note" });

// The pane's properties, in the assistant's Properties tab.
function properties(pane: DocumentPane): HTMLElement {
  if (!pane.properties) throw new Error("the document pane has no properties");
  return pane.properties;
}

// The pane's list in the assistant's Links tab.
function links(pane: DocumentPane): HTMLElement {
  if (!pane.links) throw new Error("the document pane has no Links-tab list");
  return pane.links;
}

function q<E extends Element = HTMLElement>(root: ParentNode, selector: string): E {
  const element = root.querySelector<E>(selector);
  if (!element) throw new Error(`missing ${selector}`);
  return element;
}

// As a browser moves the pointer onto it: an over, then a move.
function hover(target: Element): void {
  for (const type of ["pointerover", "pointermove"]) {
    target.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerType: "mouse" }));
  }
}

const previewText = () => document.querySelector(".link-preview .editor-reading-content")?.textContent;

function typeAtEnd(view: EditorView, text: string): void {
  view.dispatch({ changes: { from: view.state.doc.length, insert: text } });
}

describe("documentPane", () => {
  it("registers as two kinds over one factory", () => {
    const { deps } = setup();
    expect(documentPane(deps).kind).toBe("document");
    expect(appletSourcePane(deps).kind).toBe("applet-source");
    expect(isDocumentPane(documentPane(deps).create(fakePaneGroup()))).toBe(true);
    expect(isDocumentPane({ kind: "table" } as never)).toBe(false);
  });

  it("shows a note from its model: body, editable title, properties in the Properties tab", async () => {
    const { pane, documents, deps } = setup();
    documents.adopt(noteFile());
    await pane.setInput(songTab(), current);

    expect(pane.view.state.doc.toString()).toBe("first line\n");
    const surface = q(pane.element, ".editor-document");
    const title = q<HTMLInputElement>(surface, ".editor-title-input");
    expect(surface.firstElementChild?.classList.contains("editor-title-bar")).toBe(true);
    expect(surface.classList.contains("has-title")).toBe(true);
    expect(title.value).toBe("Song");
    expect(title.placeholder).toBe("song");
    expect(title.readOnly).toBe(false);
    expect(pane.title()).toBe("Song");
    expect(pane.titleHost).toBeUndefined();

    expect(pane.element.querySelector(".property-editor")).toBeNull();
    expect(properties(pane).hidden).toBe(false);
    expect(properties(pane).querySelector('.property-editor-row[data-key="tags"]')).not.toBeNull();
    expect(properties(pane).hasAttribute("data-empty")).toBe(false);
    expect(deps.onAddPropertyAvailable).toHaveBeenLastCalledWith(true);
    expect(deps.onWordCount).toHaveBeenLastCalledWith({ words: 2, chars: 11 });
    expect(deps.reportProblems).toHaveBeenLastCalledWith("notes/song.md", []);
  });

  // The block is the writer's to fix, so it stays in the text, and nothing
  // that would compose a title or properties around it is offered.
  it("shows a note whose frontmatter doesn't parse as text, with no title bar or properties, and says why", async () => {
    const content = "---\ntitle: Chapter 1: The Start\n---\n\n# Chapter 1\n\nfirst line\n";
    const { pane, documents, deps, setReadingView } = setup();
    documents.adopt(noteFile({ content }));
    await pane.setInput(songTab(), current);

    expect(pane.view.state.doc.toString()).toBe(content);
    expect(pane.element.querySelector(".editor-title-bar")).toBeNull();
    expect(properties(pane).hidden).toBe(false);
    expect(properties(pane).textContent).toBe("No properties: the frontmatter doesn't parse.");
    expect(properties(pane).hasAttribute("data-empty")).toBe(false); // the error is worth reading
    expect(deps.onAddPropertyAvailable).toHaveBeenLastCalledWith(false);
    expect(deps.reportProblems).toHaveBeenLastCalledWith("notes/song.md", [
      "The frontmatter isn't valid YAML (line 2: Nested mappings are not allowed in compact mappings). Until it's fixed and the note reopened, it has no properties and is kept private.",
    ]);

    setReadingView(true);
    pane.refresh();

    const reading = q(pane.element, ".editor-reading");
    expect(reading.querySelector("h1")?.textContent).toBe("Chapter 1");
    expect(reading.textContent).not.toContain("title:");
    expect(pane.element.querySelector(".editor-title-bar")).toBeNull();
  });

  it("revealLine takes a whole-file line number, selects the text on it and flashes it", async () => {
    const { pane, documents } = setup();
    documents.adopt(noteFile());
    await pane.setInput(songTab(), current);
    const flashed = () => [...pane.view.contentDOM.querySelectorAll(".flash")].map((mark) => mark.textContent);
    // Line 8 of the file is the body's first line: frontmatter and the
    // lifted heading are counted, as a search result counts them.
    pane.revealLine(8, "LINE");
    expect(pane.view.state.sliceDoc(pane.view.state.selection.main.from, pane.view.state.selection.main.to)).toBe(
      "line",
    );
    expect(flashed()).toEqual(["line"]);
    pane.revealLine(2);
    expect(pane.view.state.selection.main.empty).toBe(true);
    expect(pane.view.state.selection.main.head).toBe(0);
    expect(flashed()).toEqual(["first line"]);
  });

  it("pushes an edit into the model, which schedules the recomposed save", async () => {
    const { pane, documents, queue } = setup();
    const model = documents.adopt(noteFile());
    await pane.setInput(songTab(), current);

    typeAtEnd(pane.view, "second line\n");

    expect(model.body()).toBe("first line\nsecond line\n");
    expect(queue.schedule).toHaveBeenCalledTimes(1);
    expect(queue.schedule.mock.calls[0][0]).toBe("notes/song.md");
    expect(queue.schedule.mock.calls[0][1]).toBe("---\ntags:\n  - a\n---\n\n# Song\n\nfirst line\nsecond line\n");
  });

  it("a title edit goes to the model", async () => {
    const { pane, documents, queue } = setup();
    const model = documents.adopt(noteFile());
    await pane.setInput(songTab(), current);

    const title = q<HTMLInputElement>(pane.element, ".editor-title-input");
    title.value = "Ballad";
    title.dispatchEvent(new Event("input"));

    expect(model.title()?.text).toBe("Ballad");
    expect(queue.schedule.mock.calls.at(-1)?.[1]).toContain("# Ballad");
  });

  it("a rename shows the file's new name as the empty title's placeholder", async () => {
    const { pane, documents } = setup();
    documents.adopt(noteFile({ content: "first line\n" }));
    await pane.setInput(songTab(), current);
    const title = q<HTMLInputElement>(pane.element, ".editor-title-input");
    expect(title.placeholder).toBe("song");

    documents.move("notes/song.md", "notes/ballad.md");

    expect(title.value).toBe("");
    expect(title.placeholder).toBe("ballad");
  });

  it("Tab fills an empty, editable title from the file's name and keeps the caret there", async () => {
    const { pane, documents, queue, setReadingView } = setup();
    const model = documents.adopt(noteFile({ path: "notes/music-references.md", content: "first line\n" }));
    await pane.setInput({ kind: "document", path: "notes/music-references.md", documentType: "note" }, current);
    const title = q<HTMLInputElement>(pane.element, ".editor-title-input");
    // jsdom has no execCommand; this one inserts at the caret and fires `input`, as the browser's does.
    const execCommand = vi.fn<Document["execCommand"]>((_command, _showUI, text = "") => {
      title.setRangeText(text, title.selectionStart ?? 0, title.selectionEnd ?? 0, "end");
      title.dispatchEvent(new Event("input"));
      return true;
    });
    document.execCommand = execCommand;
    // Whether the pane took the key, so the browser won't move on to the next field.
    const tab = (init: KeyboardEventInit = {}) =>
      !title.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", cancelable: true, ...init }));
    try {
      title.focus();
      expect(tab({ shiftKey: true })).toBe(false);
      expect(tab()).toBe(true);
      expect(execCommand).toHaveBeenCalledWith("insertText", false, "Music References");
      expect(model.title()?.text).toBe("Music References");
      expect(queue.schedule.mock.calls.at(-1)?.[1]).toBe("# Music References\n\nfirst line\n");
      expect(tab()).toBe(false);

      title.value = "";
      title.dispatchEvent(new Event("input"));
      setReadingView(true);
      pane.refresh();
      expect(tab()).toBe(false);
      expect(execCommand).toHaveBeenCalledTimes(1);
    } finally {
      Reflect.deleteProperty(document, "execCommand");
    }
  });

  it("reports the selection's count when there is one", async () => {
    const { pane, documents, deps } = setup();
    documents.adopt(noteFile());
    await pane.setInput(songTab(), current);

    pane.view.dispatch({ selection: { anchor: 0, head: 5 } });

    expect(deps.onWordCount).toHaveBeenLastCalledWith({ words: 1, chars: 5 });
  });

  it("reports the selected range in the file's line numbers, with columns counted from 1", async () => {
    const { pane, documents } = setup();
    documents.adopt(noteFile({ content: "---\ntags:\n  - a\n---\n\n# Song\n\nfirst line\nsecond line\n" }));
    await pane.setInput(songTab(), current);
    expect(pane.selectedRange()).toBeUndefined();

    // The body's first line is the file's line 8.
    pane.view.dispatch({ selection: { anchor: 6, head: 10 } });
    expect(pane.selectedRange()).toEqual({ startLine: 8, startColumn: 7, endLine: 8, endColumn: 11 });

    // Dragged through the line's end, onto the next line's first character.
    pane.view.dispatch({ selection: { anchor: 0, head: 11 } });
    expect(pane.selectedRange()).toEqual({ startLine: 8, startColumn: 1, endLine: 8, endColumn: 11 });
  });

  it("fills a tag's pill with its color in reading view as well as editing", async () => {
    const vocabulary = [{ name: "a", color: "#0b6e99" }];
    const tags = { known: () => vocabulary, read: async () => vocabulary };
    const { pane, documents, setReadingView } = setup("document", noteFile(), { tags });
    documents.adopt(noteFile());
    await pane.setInput(songTab(), current);
    const pill = () => properties(pane).querySelector<HTMLElement>('.pill[data-tag="a"]');
    expect(pill()?.style.backgroundColor).toBe("rgb(11, 110, 153)");

    setReadingView(true);
    pane.refresh();
    expect(properties(pane).querySelector("input")).toBeNull();
    expect(pill()?.style.backgroundColor).toBe("rgb(11, 110, 153)");
  });

  it("reading view renders the markdown, locks the editor, and locks the properties", async () => {
    const { pane, documents, deps, setReadingView } = setup();
    documents.adopt(noteFile());
    await pane.setInput(songTab(), current);

    setReadingView(true);
    pane.refresh();

    const reading = q(pane.element, ".editor-reading");
    expect(reading.hidden).toBe(false);
    expect(q(pane.element, ".editor-document").hidden).toBe(true);
    expect(pane.element.classList.contains("reading-view")).toBe(true);
    expect(reading.querySelector("p")?.textContent).toBe("first line");
    expect(reading.querySelector("h1")).toBeNull(); // the title bar carries the heading
    expect(reading.querySelector(".meta-rows")).toBeNull(); // properties stay in the Properties tab
    const title = q<HTMLInputElement>(reading, ".editor-title-input");
    expect(reading.firstElementChild?.classList.contains("editor-title-bar")).toBe(true);
    expect(title.readOnly).toBe(true);
    expect(pane.view.state.facet(EditorView.editable)).toBe(false);
    expect(properties(pane).hidden).toBe(false);
    expect(properties(pane).querySelector("input")).toBeNull();
    expect(properties(pane).querySelector(".pill")?.textContent).toBe("a");
    expect(deps.onAddPropertyAvailable).toHaveBeenLastCalledWith(false);

    setReadingView(false);
    pane.refresh();

    expect(properties(pane).querySelector('.property-editor-row[data-key="tags"]')).not.toBeNull();
    expect(q(pane.element, ".editor-document").hidden).toBe(false);
    expect(pane.view.state.facet(EditorView.editable)).toBe(true);
    expect(q<HTMLInputElement>(pane.element, ".editor-title-input").readOnly).toBe(false);
  });

  it("tells a view of the same file beside it what moved, and marks the page with file lines", async () => {
    const { pane, documents, setReadingView } = setup();
    documents.adopt(noteFile());
    const changes: string[] = [];
    pane.onScrollChange((change) => changes.push(change));
    await pane.setInput(songTab(), current);
    expect(changes).toEqual(["view"]);
    expect(pane.isReading()).toBe(false);

    setReadingView(true);
    pane.refresh();
    expect(pane.isReading()).toBe(true);
    expect(changes).toEqual(["view", "reflow", "view"]);
    // Frontmatter and the lifted heading count: the body starts on line 8.
    expect(q(pane.element, ".editor-reading p").dataset.line).toBe("8");

    changes.length = 0;
    q(pane.element, ".editor-reading").dispatchEvent(new Event("scroll"));
    expect(changes).toEqual(["scroll"]);
    // jsdom lays nothing out, so there is no place to give.
    expect(pane.topLine()).toBeUndefined();
  });

  it("leaves no completion timer to throw after the pane lets its file go", async () => {
    vi.useFakeTimers();
    try {
      const { pane, documents } = setup();
      documents.adopt(noteFile());
      await pane.setInput(songTab(), current);
      pane.view.dispatch({ changes: { from: pane.view.state.doc.length, insert: "w" }, userEvent: "input.type" });
      pane.clearInput();
      expect(() => vi.advanceTimersByTime(1000)).not.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });

  it("puts a link's menu above the text menu's on right-click, editing or reading, a folder link's as the folder's", async () => {
    const formats = testFormats({
      resolveWikilinkTarget: (target) =>
        target === "gone" ? undefined : target.endsWith("/") ? `notes/${target}` : `resolved/${target}.md`,
    });
    const { pane, documents, deps, setReadingView } = setup("document", noteFile(), { formats });
    textMenus.push(installTextMenu(deps.contextMenu));
    documents.adopt(noteFile({ content: "# Song\n\nsee [[other]], [[plan/]] and [[gone]]\n" }));
    await pane.setInput(songTab(), current);
    const rightClick = (target: Element) => {
      const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 7, clientY: 8 });
      target.dispatchEvent(event);
      return event;
    };
    const lastMenu = () => deps.contextMenu.open.mock.calls.at(-1)?.[0];

    const edited = [...pane.view.contentDOM.querySelectorAll<HTMLElement>("[data-space-path]")];
    expect(edited.map((link) => link.dataset.spacePath)).toEqual(["resolved/other.md", "notes/plan/"]);
    expect(rightClick(edited[0]).defaultPrevented).toBe(true);
    expect(lastMenu()).toMatchObject({
      menu: "editor.linkedName",
      arg: { file: "resolved/other.md" },
      at: { x: 7, y: 8 },
    });
    rightClick(edited[1]);
    expect(lastMenu()).toMatchObject({ menu: "editor.linkedName", arg: { folder: "notes/plan" } });
    rightClick(q(pane.view.contentDOM, ".cm-md-unresolved"));
    expect(deps.contextMenu.open).toHaveBeenCalledTimes(2);
    // The right button's press keeps the caret out of a link, which it would unfold.
    const press = (target: Element) => {
      const event = new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 2 });
      target.dispatchEvent(event);
      return event.defaultPrevented;
    };
    expect(press(edited[0])).toBe(true);
    expect(press(q(pane.view.contentDOM, ".cm-md-unresolved"))).toBe(false);

    setReadingView(true);
    pane.refresh();
    rightClick(q(pane.element, ".editor-reading-content a[data-space-path]"));
    expect(lastMenu()).toMatchObject({ menu: "editor.linkedName", arg: { file: "resolved/other.md" } });
    rightClick(q(pane.element, ".editor-reading-content .wikilink-unresolved"));
    expect(deps.contextMenu.open).toHaveBeenCalledTimes(3);
  });

  it("a space link clicked in reading view opens that path", async () => {
    const { pane, documents, deps, setReadingView } = setup();
    documents.adopt(noteFile({ content: "# Song\n\nsee [[other]]\n" }));
    setReadingView(true);
    await pane.setInput(songTab(), current);

    const link = q<HTMLAnchorElement>(pane.element, "a[data-space-path]");
    link.click();

    expect(deps.openPath).toHaveBeenCalledWith("resolved/other.md", { anchor: expect.any(HTMLElement) });
  });

  it("previews the note a link in the editor names while the pointer rests on it, until a key is typed", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { pane, documents, loadFile } = setup();
      documents.adopt(noteFile({ content: "# Song\n\nsee [[other]]\n" }));
      await pane.setInput(songTab(), current);
      loadFile.mockImplementation(async (path) => noteFile({ path, content: "# Other\n\nThe other song.\n" }));

      hover(q(pane.view.contentDOM, "[data-space-path]"));
      await vi.advanceTimersByTimeAsync(300);
      expect(loadFile).toHaveBeenLastCalledWith("resolved/other.md");
      expect(previewText()).toContain("The other song.");

      pane.view.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
      expect(document.querySelector(".link-preview")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("draws a tag in reading view as its pill, filled with its color, and opens Search for it on a click", async () => {
    const vocabulary = [{ name: "rain", color: "#0b6e99" }];
    const tags = { known: () => vocabulary, read: async () => vocabulary };
    const { pane, documents, deps, setReadingView } = setup("document", noteFile(), { tags });
    documents.adopt(noteFile({ content: "# Song\n\nA #Rain song\n" }));
    setReadingView(true);
    await pane.setInput(songTab(), current);

    const pill = q<HTMLElement>(pane.element, ".editor-reading-content .inline-tag");
    expect(pill.textContent).toBe("#Rain");
    expect(pill.style.backgroundColor).toBe("rgb(11, 110, 153)");
    pill.click();
    expect(deps.runCommand).toHaveBeenCalledWith("search.forTag", { tag: "Rain" });
    expect(deps.openPath).not.toHaveBeenCalled();
  });

  it("redraws reading view when the space changes where one of its links leads, and only then", async () => {
    let listed = false;
    const formats = testFormats({
      resolveWikilinkTarget: (target) => (listed ? `notes/${target}.md` : undefined),
      wikilinkPending: () => !listed,
    });
    const { pane, documents, setReadingView } = setup("document", noteFile(), { formats });
    documents.adopt(noteFile({ content: "# Song\n\nSee [[chorus]]\n" }));
    setReadingView(true);
    await pane.setInput(songTab(), current);

    const page = () => q(pane.element, ".editor-reading-content");
    const drawn = page().firstElementChild;
    expect(page().querySelector("a, .wikilink-unresolved")).toBeNull();
    pane.spaceChanged();
    expect(page().firstElementChild).toBe(drawn);

    listed = true;
    pane.spaceChanged();
    expect(page().firstElementChild).not.toBe(drawn);
    expect(q(page(), "a[data-space-path]").dataset.spacePath).toBe("notes/chorus.md");
  });

  it("a screenplay has no title bar or properties and stays in the editor under reading view", async () => {
    const { pane, documents, deps, setReadingView } = setup();
    documents.adopt(screenplay());
    await pane.setInput({ kind: "document", path: "scene.fountain", documentType: "screenplay" }, current);

    expect(pane.element.querySelector(".editor-title-bar")).toBeNull();
    expect(properties(pane).hidden).toBe(true);
    expect(q(pane.element, ".editor-document").classList.contains("has-title")).toBe(false);
    expect(deps.onAddPropertyAvailable).toHaveBeenLastCalledWith(false);
    expect(pane.title()).toBeUndefined();

    setReadingView(true);
    pane.refresh();

    expect(q(pane.element, ".editor-document").hidden).toBe(false);
    expect(q(pane.element, ".editor-reading").hidden).toBe(true);
    expect(pane.view.state.facet(EditorView.editable)).toBe(false);
  });

  it("opens a document type with no format registered as plain text, read in its locked editor", async () => {
    const world = (name: string) => (name === "LINA" ? "world/Lina.md" : undefined);
    const { pane, documents, deps, setReadingView } = setup("document", noteFile(), {
      worldNames: () => world,
      formats: createFormats(),
    });
    documents.adopt(noteFile({ path: "scene.fountain", documentType: "screenplay", content: "LINA\nHello.\n" }));
    await pane.setInput({ kind: "document", path: "scene.fountain", documentType: "screenplay" }, current);

    expect(pane.view.state.doc.toString()).toBe("LINA\nHello.\n");
    expect(pane.element.querySelector("[class*='cm-fountain']")).toBeNull();
    expect(pane.element.querySelector(".editor-title-bar")).toBeNull();
    expect(properties(pane).hidden).toBe(true);
    expect(deps.onAddPropertyAvailable).toHaveBeenLastCalledWith(false);
    pane.spaceChanged();
    expect(links(pane).querySelectorAll(".inspector-link")).toHaveLength(0);

    setReadingView(true);
    pane.refresh();
    expect(q(pane.element, ".editor-reading").hidden).toBe(true);
    expect(pane.view.state.facet(EditorView.editable)).toBe(false);
  });

  it("links a screenplay's world names, puts a linked name's menu above the text menu's, and re-resolves when the space changes", async () => {
    let world: Record<string, string> = { lina: "world/Lina.md" };
    const { pane, documents, deps } = setup("document", noteFile(), {
      worldNames: () => (name) => world[name.toLowerCase()],
    });
    textMenus.push(installTextMenu(deps.contextMenu));
    documents.adopt(
      noteFile({ path: "scene.fountain", documentType: "screenplay", content: "We meet NIKO.\n\nLINA\nHello.\n" }),
    );
    await pane.setInput({ kind: "document", path: "scene.fountain", documentType: "screenplay" }, current);

    const links = () => [...pane.element.querySelectorAll<HTMLElement>("[data-space-path]")];
    expect(links().map((link) => `${link.textContent} → ${link.dataset.spacePath}`)).toEqual(["LINA → world/Lina.md"]);

    const rightClick = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 60 });
    links()[0].dispatchEvent(rightClick);
    expect(rightClick.defaultPrevented).toBe(true);
    expect(deps.contextMenu.open).toHaveBeenCalledWith(
      expect.objectContaining({ menu: "editor.linkedName", arg: { file: "world/Lina.md" }, at: { x: 40, y: 60 } }),
    );

    // Anywhere else in the script, no link's menu.
    q(pane.element, ".cm-fountain-action").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    expect(deps.contextMenu.open).toHaveBeenCalledTimes(1);

    world = { ...world, niko: "world/Niko.md" };
    pane.spaceChanged();
    expect(links().map((link) => link.textContent)).toEqual(["NIKO", "LINA"]);
  });

  it("previews a linked name's world note while the pointer rests on the name, opening it in a new tab", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { pane, documents, loadFile, deps } = setup("document", noteFile(), {
        worldNames: () => (name) => (name.toLowerCase() === "lina" ? "world/Lina.md" : undefined),
      });
      documents.adopt(noteFile({ path: "scene.fountain", documentType: "screenplay", content: "LINA\nHello.\n" }));
      await pane.setInput({ kind: "document", path: "scene.fountain", documentType: "screenplay" }, current);
      loadFile.mockImplementation(async (path) => noteFile({ path, content: "# Lina\n\nThe pilot.\n" }));

      hover(q(pane.element, ".cm-fountain-link"));
      await vi.advanceTimersByTimeAsync(300);
      expect(loadFile).toHaveBeenLastCalledWith("world/Lina.md");
      expect(previewText()).toContain("The pilot.");

      q<HTMLButtonElement>(document.body, ".link-preview .preview-open").click();
      expect(deps.openBeside).toHaveBeenCalledWith("world/Lina.md");
      expect(deps.openPath).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops a screenplay's world links under reading view, so the browser keeps its own menu", async () => {
    const { pane, documents, deps, setReadingView } = setup("document", noteFile(), {
      worldNames: () => (name) => (name.toLowerCase() === "lina" ? "world/Lina.md" : undefined),
    });
    documents.adopt(noteFile({ path: "scene.fountain", documentType: "screenplay", content: "LINA\nHello.\n" }));
    await pane.setInput({ kind: "document", path: "scene.fountain", documentType: "screenplay" }, current);
    const links = () => pane.element.querySelectorAll("[data-space-path]");
    expect(links()).toHaveLength(1);

    setReadingView(true);
    pane.refresh();
    expect(links()).toHaveLength(0);
    const rightClick = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    q(pane.element, ".cm-fountain-character").dispatchEvent(rightClick);
    expect(rightClick.defaultPrevented).toBe(false);
    expect(deps.contextMenu.open).not.toHaveBeenCalled();

    setReadingView(false);
    pane.refresh();
    expect(links()).toHaveLength(1);
  });

  it("hides a screenplay's emphasis delimiters and note brackets while editing, its notes whole under reading view, and shows all in Source mode", async () => {
    const { pane, documents, setReadingView, setSourceMode } = setup();
    documents.adopt(
      noteFile({
        path: "scene.fountain",
        documentType: "screenplay",
        content: "He ***roars***, *hisses*, **shouts**, *whispers*, _waits_. [[cut?]]\n",
      }),
    );
    await pane.setInput({ kind: "document", path: "scene.fountain", documentType: "screenplay" }, current);
    const shown = () =>
      [
        ".cm-fountain-bold-italic",
        ".cm-fountain-italic",
        ".cm-fountain-bold",
        ".cm-fountain-underline",
        ".cm-fountain-note",
      ].flatMap((selector) => [...pane.element.querySelectorAll(selector)].map((element) => element.textContent));
    expect(shown()).toEqual(["roars", "hisses", "whispers", "shouts", "waits", "cut?"]);

    setReadingView(true);
    pane.refresh();
    expect(shown()).toEqual(["roars", "hisses", "whispers", "shouts", "waits"]);
    expect(pane.element.querySelector(".cm-line")?.textContent).toBe("He roars, hisses, shouts, whispers, waits.");
    expect(pane.view.state.doc.toString()).toContain("**shouts**");

    setReadingView(false);
    setSourceMode(true);
    pane.refresh();
    expect(shown()).toEqual(["***roars***", "*hisses*", "*whispers*", "**shouts**", "_waits_", "[[cut?]]"]);
  });

  it("lists a screenplay's linked files under Links, in order of first mention, with how often each appears", async () => {
    const world: Record<string, string> = { lina: "world/Lina.md", niko: "world/Niko.md" };
    const { pane, documents } = setup("document", noteFile(), {
      worldNames: () => (name) => world[name.toLowerCase()],
    });
    documents.adopt(
      noteFile({
        path: "scene.fountain",
        documentType: "screenplay",
        content: "INT. ROOM - DAY\n\nNIKO waits for LINA.\n\nLINA\nHello.\n",
      }),
    );
    await pane.setInput({ kind: "document", path: "scene.fountain", documentType: "screenplay" }, current);

    const rows = [...links(pane).querySelectorAll(".inspector-link")].map((row) => row.textContent);
    expect(rows).toEqual(["Niko1", "Lina2"]);
  });

  it("lists a note's links and its missing targets, opens a row on click, and re-reads the text as it changes", async () => {
    const markdownLinks = vi.fn(
      (_path: string, content: string): DocumentLinks => ({
        found: [
          { path: "notes/other.md", mentions: [] },
          { path: "deck.table.html", mentions: [] },
        ],
        missing: content.includes("gone") ? ["gone"] : [],
      }),
    );
    const { pane, documents, deps } = setup("document", noteFile(), { markdownLinks });
    documents.adopt(noteFile());
    await pane.setInput(songTab(), current);

    const rows = () => [...links(pane).querySelectorAll<HTMLElement>(".inspector-link")];
    const glyph = (row: HTMLElement) => row.querySelector<HTMLElement>(".inspector-link-icon")?.dataset.entryIcon;
    expect(rows().map((row) => [row.textContent, glyph(row)])).toEqual([
      ["other", "markdown"],
      ["deck", "table"],
    ]);

    rows()[1].click();
    expect(deps.openPath).toHaveBeenCalledWith("deck.table.html", { anchor: expect.any(HTMLElement) });
    rows()[0].dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 6 }));
    expect(deps.contextMenu.open).toHaveBeenCalledWith(
      expect.objectContaining({ menu: "editor.linkedFile", arg: { file: "notes/other.md" }, at: { x: 5, y: 6 } }),
    );

    typeAtEnd(pane.view, "see [[gone]]");
    await vi.waitFor(() => expect(rows().at(-1)?.classList.contains("missing")).toBe(true));
    expect(rows().at(-1)?.tagName).toBe("DIV");
    expect(rows().at(-1)?.textContent).toBe("gone");
  });

  it("reveals a linked file's row, reading the text afresh so a just-typed link is there", async () => {
    Element.prototype.scrollIntoView ??= () => {};
    const markdownLinks = vi.fn(
      (_path: string, content: string): DocumentLinks => ({
        found: content.includes("[[new]]") ? [{ path: "notes/new.md", mentions: [] }] : [],
        missing: [],
      }),
    );
    const { pane, documents } = setup("document", noteFile(), { markdownLinks });
    documents.adopt(noteFile());
    await pane.setInput(songTab(), current);

    typeAtEnd(pane.view, "see [[new]]");
    pane.revealLink("notes/new.md");

    const item = links(pane).querySelector<HTMLElement>('.inspector-link-item[data-path="notes/new.md"]');
    expect(item?.querySelector(".inspector-link-toggle")?.getAttribute("aria-expanded")).toBe("true");
  });

  it("selects and flashes a linked file's mentions in turn, from the first, never one in the title", async () => {
    // Each `[[x]]` as the real reader reports it: its target, offset into
    // the whole file.
    const markdownLinks = (_path: string, content: string): DocumentLinks => ({
      found: [
        {
          path: "notes/x.md",
          mentions: [...content.matchAll(/\[\[x\]\]/g)].map((match) => ({
            from: match.index + 2,
            to: match.index + 3,
          })),
        },
      ],
      missing: [],
    });
    const { pane, documents } = setup("document", noteFile(), { markdownLinks });
    documents.adopt(noteFile({ content: "---\ntags:\n  - a\n---\n\n# [[x]] Song\n\nsee [[x]], then [[x]]\n" }));
    await pane.setInput(songTab(), current);
    const body = pane.view.state.doc.toString();
    const first = body.indexOf("[[x]]") + 2;
    const second = body.lastIndexOf("[[x]]") + 2;
    const selected = () => [pane.view.state.selection.main.from, pane.view.state.selection.main.to];
    const flashedAt = () =>
      [...pane.view.contentDOM.querySelectorAll(".flash")].map((mark) => pane.view.posAtDOM(mark));

    pane.revealMention("notes/x.md");
    expect(selected()).toEqual([first, first + 1]);
    expect(flashedAt()).toEqual([first]);
    pane.revealMention("notes/x.md");
    expect(selected()).toEqual([second, second + 1]);
    expect(flashedAt()).toEqual([second]);
    pane.revealMention("notes/x.md");
    expect(selected()).toEqual([first, first + 1]);

    pane.view.dispatch({ selection: { anchor: 0 } });
    pane.revealMention("notes/x.md");
    expect(selected()).toEqual([first, first + 1]);
    pane.revealMention("notes/nowhere.md");
    expect(selected()).toEqual([first, first + 1]);
  });

  it("says so when the document links nowhere", async () => {
    const { pane, documents } = setup();
    documents.adopt(noteFile());
    await pane.setInput(songTab(), current);
    expect(links(pane).textContent).toBe("No links in this file.");
  });

  it("lists a link whose root's listing is still to land only once it lands", async () => {
    let listed = false;
    const markdownLinks = () =>
      listed
        ? { found: [{ path: "lib:footage/cover.md", mentions: [] }], missing: [] }
        : { found: [], missing: [], pending: ["lib:footage/cover"] };
    const { pane, documents } = setup("document", noteFile(), { markdownLinks });
    documents.adopt(noteFile({ content: "# Song\n\nSee [[lib:footage/cover]]\n" }));
    await pane.setInput(songTab(), current);
    expect(links(pane).textContent).toBe("");

    listed = true;
    pane.spaceChanged();
    expect(links(pane).querySelector(".inspector-link-name")?.textContent).toBe("cover");
  });

  it("lists no links or properties for raw code", () => {
    const { pane } = setup("applet-source");
    expect(pane.links).toBeUndefined();
    expect(pane.properties).toBeUndefined();
  });

  // With no properties the section still shows its "+ Add property" button,
  // so the first one is a click in the Properties tab as well as a toolbar item.
  it("addProperty() reveals the section and writes through the model", async () => {
    const { pane, documents, deps, queue } = setup();
    const model = documents.adopt(noteFile({ content: "# Song\n\nbody\n" }));
    await pane.setInput(songTab(), current);
    expect(properties(pane).hidden).toBe(false);
    expect(properties(pane).querySelector(".property-editor-row")).toBeNull();
    expect(properties(pane).querySelector(".data-table-add-row")).not.toBeNull();
    expect(properties(pane).hasAttribute("data-empty")).toBe(true);
    expect(deps.onAddPropertyAvailable).toHaveBeenLastCalledWith(true);

    pane.addProperty();

    expect(deps.revealProperties).toHaveBeenCalledTimes(1);
    expect(properties(pane).querySelector(".property-editor-row")?.classList.contains("flash")).toBe(true);
    expect(properties(pane).hasAttribute("data-empty")).toBe(false);
    expect(model.properties()).toEqual({ property: "" });
    expect(queue.schedule.mock.calls.at(-1)?.[1]).toMatch(/^---\nproperty: .*\n---\n\n# Song\n\nbody\n$/);
    expect(model.lineOffset()).toBe(6); // three frontmatter lines, a blank, the heading, a blank
  });

  // The pane's own edits never re-render its properties, so the mark
  // follows the model's change instead.
  it("marks the properties empty again once the last one is deleted", async () => {
    const { pane, documents, deps } = setup();
    documents.adopt(noteFile({ content: "---\nmood: calm\n---\n\n# Song\n" }));
    await pane.setInput(songTab(), current);
    expect(properties(pane).hasAttribute("data-empty")).toBe(false);

    q<HTMLButtonElement>(properties(pane), ".property-menu-button").click();
    const items: MenuItem[] = deps.contextMenu.open.mock.calls.at(-1)?.[0].items ?? [];
    void items.find((item) => item.label === "Remove")?.run?.({} as CommandContext, undefined);

    expect(properties(pane).querySelector(".property-editor-row")).toBeNull();
    expect(properties(pane).hasAttribute("data-empty")).toBe(true);
  });

  it("addProperty() does nothing in reading view", async () => {
    const { pane, documents, deps, setReadingView } = setup();
    const model = documents.adopt(noteFile({ content: "# Song\n\nbody\n" }));
    setReadingView(true);
    await pane.setInput(songTab(), current);
    expect(properties(pane).textContent).toBe("No properties."); // and no editor to add with

    pane.addProperty();

    expect(deps.revealProperties).not.toHaveBeenCalled();
    expect(model.properties()).toEqual({});
  });

  it("snapshots view state onto the tab when it moves on, and restores it with its history", async () => {
    const { pane, documents } = setup();
    documents.adopt(noteFile());
    const tab = songTab();
    await pane.setInput(tab, current);
    typeAtEnd(pane.view, "more\n");
    expect(undoDepth(pane.view.state)).toBe(1);

    pane.clearInput();

    expect(tab.kind === "document" && tab.state?.doc.toString()).toBe("first line\nmore\n");
    expect(pane.view.state.doc.toString()).toBe("");
    expect(pane.element.querySelector(".editor-title-bar")).toBeNull();

    await pane.setInput(tab, current);

    expect(pane.view.state.doc.toString()).toBe("first line\nmore\n");
    expect(undoDepth(pane.view.state)).toBe(1);
  });

  it("keeps reading view's place per tab, without touching the editor's", async () => {
    const { pane, documents, setReadingView } = setup();
    documents.adopt(noteFile());
    documents.adopt(noteFile({ path: "notes/other.md" }));
    const song = songTab();
    const other: Tab = { kind: "document", path: "notes/other.md", documentType: "note" };
    setReadingView(true);
    await pane.setInput(song, current);
    const reading = q(pane.element, ".editor-reading");
    reading.scrollTop = 300;

    await pane.setInput(other, current);
    expect(reading.scrollTop).toBe(0); // not the last note's place

    await pane.setInput(song, current);
    expect(reading.scrollTop).toBe(300);
    expect(song).not.toHaveProperty("scrollTop");
  });

  it("a tab whose cached state diverged from the shared model restarts from the model", async () => {
    const { pane, documents } = setup();
    documents.adopt(noteFile());
    documents.adopt(noteFile());
    const first = songTab();
    const second = songTab();

    await pane.setInput(first, current);
    typeAtEnd(pane.view, "from first\n");
    pane.view.dispatch({ selection: { anchor: 3 } });
    await pane.setInput(second, current); // snapshots `first`, builds `second` from the shared model
    expect(pane.view.state.doc.toString()).toBe("first line\nfrom first\n");
    typeAtEnd(pane.view, "from second\n");
    await pane.setInput(first, current);

    expect(pane.view.state.doc.toString()).toBe("first line\nfrom first\nfrom second\n");
    expect(pane.view.state.selection.main.head).toBe(3); // the cursor comes along; the history doesn't
    expect(undoDepth(pane.view.state)).toBe(0);
  });

  it("propose() draws a rewrite over the text and writes nothing until it is accepted", async () => {
    const { pane, documents, queue } = setup();
    const model = documents.adopt(noteFile());
    await pane.setInput(songTab(), current);
    const onSettled = vi.fn();

    const shown = pane.propose(
      {
        path: "notes/song.md",
        before: noteFile().content,
        newContent: "---\ntags:\n  - a\n  - b\n---\n\n# Ballad\n\nfirst verse\n",
        revision: "r",
      },
      onSettled,
    );

    // One change in the text, plus the title and the properties.
    expect(shown).toBe(3);
    expect(model.body()).toBe("first line\n");
    expect(queue.schedule).not.toHaveBeenCalled();
    expect(q(pane.element, ".edit-proposal-bar").textContent).toContain('Title: "Ballad"');

    acceptAll(pane.view);

    expect(model.body()).toBe("first verse\n");
    expect(model.title()?.text).toBe("Ballad");
    expect(model.properties()).toEqual({ tags: ["a", "b"] });
    expect(onSettled).toHaveBeenCalledWith({ accepted: 3, rejected: 0, dropped: 0, replaced: false });
  });

  it("propose() with apply accepts the whole rewrite at once, as one edit an undo reverts", async () => {
    const { pane, documents } = setup();
    const model = documents.adopt(noteFile());
    await pane.setInput(songTab(), current);
    const onSettled = vi.fn();

    const shown = pane.propose(
      {
        path: "notes/song.md",
        before: noteFile().content,
        newContent: noteFile({}).content.replace("line", "verse"),
        revision: "r",
      },
      onSettled,
      true,
    );

    expect(shown).toBe(1);
    expect(model.body()).toBe("first verse\n");
    expect(onSettled).toHaveBeenCalledWith({ accepted: 1, rejected: 0, dropped: 0, replaced: false });
    expect(q(pane.element, ".edit-proposal-bar").hidden).toBe(true);
    undo(pane.view);
    expect(model.body()).toBe("first line\n");
  });

  it("restore() puts a version's text in as one edit an undo reverts, and saves it as a restore", async () => {
    const { pane, documents, queue } = setup();
    const model = documents.adopt(noteFile());
    await pane.setInput(songTab(), current);

    expect(pane.restore(noteFile().content.replace("first line", "an older line"))).toBe(true);

    expect(model.body()).toBe("an older line\n");
    expect(queue.schedule).toHaveBeenLastCalledWith("notes/song.md", model.content(), expect.any(Function), "restored");
    undo(pane.view);
    expect(model.body()).toBe("first line\n");
  });

  it("restore() refuses with no document open", () => {
    const { pane } = setup();
    expect(pane.restore("anything")).toBe(false);
  });

  it("propose() leaves a property the proposal didn't change as the writer set it", async () => {
    const { pane, documents } = setup();
    const model = documents.adopt(noteFile());
    await pane.setInput(songTab(), current);
    const live = model.properties();
    if (!live) throw new Error("a note always has properties");
    live.status = "draft";

    pane.propose(
      {
        path: "notes/song.md",
        before: noteFile().content,
        newContent: "---\ntags:\n  - b\n---\n\n# Song\n\nfirst line\n",
        revision: "r",
      },
      vi.fn(),
    );
    acceptAll(pane.view);

    expect(model.properties()).toEqual({ tags: ["b"], status: "draft" });
  });

  it("propose() refuses an edit for a file this pane isn't showing", async () => {
    const { pane, documents } = setup();
    documents.adopt(noteFile());
    await pane.setInput(songTab(), current);

    expect(pane.propose({ path: "other.md", before: "", newContent: "x", revision: "r" }, vi.fn())).toBeUndefined();
  });

  it("propose() leaves reading view for a rewrite with changes in it, where they can be decided", async () => {
    const { pane, documents, deps, setReadingView } = setup();
    documents.adopt(noteFile());
    setReadingView(true);
    await pane.setInput(songTab(), current);
    const rewrite = (newContent: string) => ({
      path: "notes/song.md",
      before: noteFile().content,
      newContent,
      revision: "r",
    });

    expect(pane.propose(rewrite(noteFile().content), vi.fn())).toBe(0);
    expect(deps.leaveReadingView).not.toHaveBeenCalled();

    expect(pane.propose(rewrite(noteFile().content.replace("line", "verse")), vi.fn())).toBe(1);
    expect(deps.leaveReadingView).toHaveBeenCalledOnce();
    expect(q(pane.element, ".editor-reading").hidden).toBe(true);
    expect(q(pane.element, ".edit-proposal-bar").hidden).toBe(false);
  });

  it("propose() with apply lands a rewrite on a document left in reading view", async () => {
    const { pane, documents, setReadingView } = setup();
    const model = documents.adopt(noteFile());
    setReadingView(true);
    await pane.setInput(songTab(), current);
    const onSettled = vi.fn();

    pane.propose(
      {
        path: "notes/song.md",
        before: noteFile().content,
        newContent: noteFile().content.replace("line", "verse"),
        revision: "r",
      },
      onSettled,
      true,
    );

    expect(model.body()).toBe("first verse\n");
    expect(onSettled).toHaveBeenCalledWith({ accepted: 1, rejected: 0, dropped: 0, replaced: false });
  });

  it("a reload from disk settles a pending proposal as dropped", async () => {
    const { pane, documents, loadFile } = setup();
    const model = documents.adopt(noteFile());
    await pane.setInput(songTab(), current);
    const onSettled = vi.fn();
    pane.propose(
      {
        path: "notes/song.md",
        before: noteFile().content,
        newContent: noteFile({}).content.replace("line", "verse"),
        revision: "r",
      },
      onSettled,
    );
    loadFile.mockResolvedValueOnce(noteFile({ content: "# New\n\nfrom disk\n" }));

    await model.reload();

    expect(pane.view.state.doc.toString()).toBe("from disk\n");
    expect(onSettled).toHaveBeenCalledWith({ accepted: 0, rejected: 0, dropped: 1, replaced: false });
  });

  it("takes a reload from disk as one change, keeping the cursor, and undo takes it back first", async () => {
    const { pane, documents, loadFile } = setup();
    const model = documents.adopt(noteFile());
    await pane.setInput(songTab(), current);
    typeAtEnd(pane.view, "mine\n");
    const end = pane.view.state.doc.length;
    pane.view.dispatch({ selection: { anchor: end } });
    // Disk holds the writer's line, saved, and someone else's capital.
    loadFile.mockResolvedValueOnce(
      noteFile({ revision: "rev-2", content: noteFile().content.replace("first line\n", "First line\nmine\n") }),
    );

    await model.reload();

    expect(pane.view.state.doc.toString()).toBe("First line\nmine\n");
    expect(pane.view.state.selection.main.head).toBe(end);
    undo(pane.view);
    expect(pane.view.state.doc.toString()).toBe("first line\nmine\n");
    undo(pane.view);
    expect(pane.view.state.doc.toString()).toBe("first line\n");
  });

  it("refuses a tab of the other kind", async () => {
    const { pane, documents } = setup();
    documents.adopt(noteFile());
    await expect(pane.setInput({ kind: "applet-source", path: "x.applet.html" }, current)).rejects.toThrow(
      /can't show/,
    );
  });

  describe("the applet-source variant", () => {
    it("edits the raw HTML and saves it straight to the queue", async () => {
      const { pane, loadFile, queue, setReadingView } = setup("applet-source", applet());
      const tab: Tab = { kind: "applet-source", path: "tools/hello.applet.html" };
      await pane.setInput(tab, current);

      expect(loadFile).toHaveBeenCalledWith("tools/hello.applet.html");
      expect(pane.view.state.doc.toString()).toBe("<html><body>hi</body></html>");
      const title = q<HTMLInputElement>(pane.element, ".editor-document > .editor-title-bar .editor-title-input");
      expect(title.readOnly).toBe(true);
      expect(title.value).toBe("hello");
      expect(pane.title()).toBeUndefined();

      typeAtEnd(pane.view, "<!-- edited -->");
      expect(queue.schedule).toHaveBeenCalledWith(
        "tools/hello.applet.html",
        "<html><body>hi</body></html><!-- edited -->",
      );

      // Raw code has no reading view: the toggle never locks it.
      setReadingView(true);
      pane.refresh();
      expect(pane.view.state.facet(EditorView.editable)).toBe(true);
      expect(pane.element.classList.contains("reading-view")).toBe(false);
    });

    it("takes a proposal without touching the group's reading view, which never locks it", async () => {
      const { pane, deps, setReadingView } = setup("applet-source", applet());
      setReadingView(true);
      await pane.setInput({ kind: "applet-source", path: "tools/hello.applet.html" }, current);

      const shown = pane.propose(
        {
          path: "tools/hello.applet.html",
          before: applet().html,
          newContent: "<html><body>hello</body></html>",
          revision: "r",
        },
        vi.fn(),
      );

      expect(shown).toBeGreaterThan(0);
      expect(deps.leaveReadingView).not.toHaveBeenCalled();
    });

    it("uses a prefetched file, and a cached state without any fetch", async () => {
      const { pane, loadFile } = setup("applet-source", applet());
      const tab: Tab = { kind: "applet-source", path: "tools/hello.applet.html" };
      await pane.setInput(tab, current, applet());
      expect(loadFile).not.toHaveBeenCalled();

      typeAtEnd(pane.view, "!");
      pane.clearInput();
      await pane.setInput(tab, current);

      expect(loadFile).not.toHaveBeenCalled();
      expect(pane.view.state.doc.toString()).toBe("<html><body>hi</body></html>!");
    });

    it("renders nothing when the open went stale while loading", async () => {
      const { pane } = setup("applet-source", applet());
      await pane.setInput({ kind: "applet-source", path: "tools/hello.applet.html" }, { isCurrent: () => false });
      expect(pane.view.state.doc.toString()).toBe("");
    });

    it("is marked as code, which takes the Code page's font whatever the Editor's Font is", () => {
      expect(setup("applet-source", applet()).pane.element.classList.contains("editor-applet-source")).toBe(true);
      expect(setup().pane.element.classList.contains("editor-applet-source")).toBe(false);
    });

    it("lays itself out by its own layout, beside a note laid out by another", () => {
      const layout = testLayout({ readableLineLength: false, lineNumbers: true, foldMarkers: true });
      const code = setup("applet-source", applet(), { layout }).pane;
      const note = setup().pane;
      const classes = (pane: DocumentPane) =>
        ["wide-editor", "hide-line-numbers", "hide-fold-markers"].filter((name) =>
          pane.element.classList.contains(name),
        );
      expect(classes(code)).toEqual(["wide-editor"]);
      expect(classes(note)).toEqual(["hide-line-numbers"]);

      layout.readableLineLength.set(true);
      layout.lineNumbers.set(false);
      layout.foldMarkers.set(false);
      expect(classes(code)).toEqual(["hide-line-numbers", "hide-fold-markers"]);
      expect(classes(note)).toEqual(["hide-line-numbers"]);
    });

    it("draws indentation guides in code only, hidden while its layout turns them off", async () => {
      const layout = testLayout({ indentGuides: true });
      const code = setup("applet-source", applet(), { layout }).pane;
      await code.setInput({ kind: "applet-source", path: "tools/hello.applet.html" }, current);
      const noteSetup = setup();
      noteSetup.documents.adopt(noteFile());
      const note = noteSetup.pane;
      await note.setInput(songTab(), current);
      expect(code.element.querySelector(".cm-indent-guide-layer")).not.toBeNull();
      expect(note.element.querySelector(".cm-indent-guide-layer")).toBeNull();
      expect(code.element.classList.contains("hide-indent-guides")).toBe(false);
      layout.indentGuides?.set(false);
      expect(code.element.classList.contains("hide-indent-guides")).toBe(true);
      expect(note.element.classList.contains("hide-indent-guides")).toBe(false);
    });
  });

  describe("two panes on one model", () => {
    function pair() {
      const a = setup();
      const b = createDocumentPane("document", a.deps);
      opened.push(b);
      document.body.append(b.element);
      a.documents.adopt(noteFile());
      a.documents.adopt(noteFile());
      return { ...a, a: a.pane, b };
    }

    it("see each other's edits, each keeping its own selection", async () => {
      const { a, b, documents, queue } = pair();
      await a.setInput(songTab(), current);
      await b.setInput(songTab(), current);
      b.view.dispatch({ selection: { anchor: b.view.state.doc.length } });

      a.view.dispatch({ changes: { from: 0, insert: "0 " }, selection: { anchor: 2 } });

      expect(b.view.state.doc.toString()).toBe("0 first line\n");
      expect(b.view.state.selection.main.head).toBe("0 first line\n".length); // mapped past the insert
      expect(a.view.state.selection.main.head).toBe(2);

      typeAtEnd(b.view, "end\n");

      expect(a.view.state.doc.toString()).toBe("0 first line\nend\n");
      expect(a.view.state.selection.main.head).toBe(2);
      expect(documents.get("notes/song.md")?.body()).toBe("0 first line\nend\n");
      expect(queue.schedule).toHaveBeenCalledTimes(2);
      expect(a.view).not.toBe(b.view);
    });

    it("share one history: undo in either pane reverts the last edit in both", async () => {
      const { a, b } = pair();
      await a.setInput(songTab(), current);
      await b.setInput(songTab(), current);

      typeAtEnd(a.view, "from a\n");
      undo(b.view);

      expect(a.view.state.doc.toString()).toBe("first line\n");
      expect(b.view.state.doc.toString()).toBe("first line\n");
    });

    it("a peer's edit re-renders this pane's reading view and properties section", async () => {
      const { a, b, documents, setReadingView } = pair();
      const model = documents.get("notes/song.md");
      if (!model) throw new Error("no model");
      await a.setInput(songTab(), current);
      await b.setInput(songTab(), current);
      setReadingView(true);
      a.refresh(); // only a re-evaluates the toggle; b keeps editing

      typeAtEnd(b.view, "from b\n");
      expect(q(a.element, ".editor-reading-content").textContent).toContain("from b");

      const data = model.properties() as Record<string, unknown>;
      data.mood = "blue";
      model.notePropertiesChanged(b.view);
      expect(q(a.element, ".editor-reading-content").textContent).not.toContain("blue");
      expect(properties(a).textContent).toContain("blue");

      setReadingView(false);
      a.refresh();
      data.tempo = "slow";
      model.notePropertiesChanged(b.view);
      expect(properties(a).querySelector('.property-editor-row[data-key="tempo"]')).not.toBeNull();
    });

    it("rebuild a cached state the other pane built rather than adopting its listeners", async () => {
      const { a, b, documents } = pair();
      const tab = songTab();
      await a.setInput(tab, current);
      typeAtEnd(a.view, "from a\n");
      a.clearInput();
      expect(tab.kind === "document" && undoDepth(tab.state as never)).toBe(1);

      await b.setInput(tab, current);

      expect(b.view.state.doc.toString()).toBe("first line\nfrom a\n");
      expect(undoDepth(b.view.state)).toBe(0);
      typeAtEnd(b.view, "from b\n");
      expect(documents.get("notes/song.md")?.body()).toBe("first line\nfrom a\nfrom b\n");
    });
  });

  it("dispose() destroys the editor and removes the element", async () => {
    const { pane, documents } = setup();
    documents.adopt(noteFile());
    await pane.setInput(songTab(), current);

    pane.dispose();

    expect(pane.element.isConnected).toBe(false);
  });
});

describe("documentPane gutter width", () => {
  interface Observed {
    report: ResizeObserverCallback;
    targets: Element[];
    connected: boolean;
  }
  let observers: Observed[];

  // Keeps each observer's callback and targets, so a test can report a size
  // jsdom never lays out.
  beforeEach(() => {
    observers = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        readonly observed: Observed;
        constructor(report: ResizeObserverCallback) {
          this.observed = { report, targets: [], connected: true };
          observers.push(this.observed);
        }
        observe(target: Element) {
          this.observed.targets.push(target);
        }
        unobserve() {}
        disconnect() {
          this.observed.connected = false;
        }
      },
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const onGutters = () => observers.filter((o) => o.connected && o.targets.some((t) => t.matches(".cm-gutters")));

  it("keeps the gutter's measured width on the pane, and measures the next file's gutter after a switch", async () => {
    const { pane, documents } = setup();
    documents.adopt(noteFile());
    documents.adopt(screenplay());
    await pane.setInput(songTab(), current);

    const [note] = onGutters();
    expect(note.targets).toEqual([q(pane.element, ".cm-gutters")]);
    note.report([{ borderBoxSize: [{ inlineSize: 42.5 }] }] as unknown as ResizeObserverEntry[], {} as ResizeObserver);
    expect(pane.element.style.getPropertyValue("--gutter-width")).toBe("42.5px");

    await pane.setInput({ kind: "document", path: "scene.fountain", documentType: "screenplay" }, current);
    expect(note.connected).toBe(false);
    expect(onGutters().map((o) => o.targets)).toEqual([[q(pane.element, ".cm-gutters")]]);
  });
});

describe("documentPane find", () => {
  const twoFirsts = () => noteFile({ content: "# Song\n\nfirst line\n\nsecond line, a **first** look\n" });

  function card(aside: HTMLElement) {
    const find = () => q<HTMLInputElement>(aside, ".find-card:not(.is-closing) .find-card-input");
    return {
      find,
      count: () => q(aside, ".find-card:not(.is-closing) .find-card-count").textContent,
      type(value: string) {
        find().value = value;
        find().dispatchEvent(new Event("input"));
      },
      press(key: string, init: KeyboardEventInit = {}) {
        find().dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
      },
    };
  }

  async function openNote(file: TextFileResponse, reading = false) {
    const context = setup();
    context.documents.adopt(file);
    context.setReadingView(reading);
    await context.pane.setInput(songTab(), current);
    const aside = context.pane.toolbarAside;
    if (!aside) throw new Error("the document pane has no toolbar aside");
    document.body.append(aside);
    return { ...context, aside, card: card(aside) };
  }

  it("opens find's card in the toolbar aside, where it stays while the note shows its rendered page", async () => {
    const { pane, aside, setReadingView } = await openNote(noteFile());

    openSearchPanel(pane.view);
    expect(aside.querySelector(".find-card")).not.toBeNull();
    expect(pane.element.querySelector(".find-card")).toBeNull();

    setReadingView(true);
    pane.refresh();
    expect(aside.hidden).toBe(false);
    expect(aside.querySelector(".find-card")).not.toBeNull();
  });

  it("finds and replaces in a note being edited, opening the card with Replace showing", async () => {
    const { pane, aside } = await openNote(noteFile());

    expect(pane.findable()).toBe("replace");
    pane.openFind(true);
    expect(searchPanelOpen(pane.view.state)).toBe(true);
    expect(q(aside, ".find-card-reveal").getAttribute("aria-expanded")).toBe("true");
  });

  it("searches the rendered page while it shows, the query kept across the switch both ways", async () => {
    const { pane, card, setReadingView } = await openNote(twoFirsts());
    pane.openFind(false);
    card.type("first");
    expect(card.count()).toBe("1 of 2");
    const selected = pane.view.state.selection.main;

    setReadingView(true);
    pane.refresh();
    expect(card.find().value).toBe("first");
    expect(card.count()).toBe("? of 2");
    card.press("Enter");
    expect(card.count()).toBe("1 of 2");
    card.press("Enter");
    expect(card.count()).toBe("2 of 2");
    card.press("F3", { shiftKey: true });
    expect(card.count()).toBe("1 of 2");

    card.type("second");
    expect(card.count()).toBe("1 of 1");
    // The hidden editor's selection is left where editing left it.
    expect(pane.view.state.selection.main.eq(selected)).toBe(true);

    setReadingView(false);
    pane.refresh();
    expect(card.find().value).toBe("second");
    expect(card.count()).toBe("? of 1");
  });

  it("opens over the rendered page with Find holding the text selected there", async () => {
    const { pane, card } = await openNote(twoFirsts(), true);
    expect(pane.findable()).toBe("find");
    const range = document.createRange();
    range.selectNodeContents(q(pane.element, ".editor-reading-content strong"));
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);

    pane.openFind(false);
    expect(card.find().value).toBe("first");
    expect(document.activeElement).toBe(card.find());
    expect(card.count()).toBe("1 of 2");
    window.getSelection()?.removeAllRanges();
  });

  it("closes the card over the rendered page from Escape there, as the editor's Escape does", async () => {
    const { pane, setReadingView } = await openNote(twoFirsts());
    openSearchPanel(pane.view);
    expect(pane.hasTransient?.()).toBe(false);

    setReadingView(true);
    pane.refresh();
    expect(pane.hasTransient?.()).toBe(true);
    pane.dismissTransient?.();
    expect(searchPanelOpen(pane.view.state)).toBe(false);
  });

  it("finds without replacing on a note's rendered page and in a screenplay's reading view", async () => {
    const note = await openNote(noteFile(), true);
    expect(note.pane.findable()).toBe("find");

    const script = setup();
    script.documents.adopt(screenplay());
    await script.pane.setInput({ kind: "document", path: "scene.fountain", documentType: "screenplay" }, current);
    script.setReadingView(true);
    script.pane.refresh();
    expect(script.pane.findable()).toBe("find");
  });
});

describe("documentPane Format column", () => {
  it("shows the column for a note being edited while the setting is on, and slides it with the setting", async () => {
    const formatColumn = memorySetting(false);
    const { pane, documents, setReadingView } = setup("document", noteFile(), { formatColumn });
    documents.adopt(noteFile());
    await pane.setInput(songTab(), current);
    const column = pane.toolbarBelow;
    if (!column) throw new Error("the document pane has no column");
    expect(column.hidden).toBe(true);

    formatColumn.set(true);
    expect(column.hidden).toBe(false);
    expect(column.classList.contains("is-opening")).toBe(true);

    setReadingView(true);
    pane.refresh();
    expect(column.hidden).toBe(true);
    expect(pane.formatActions()).toBeUndefined();
  });

  it("offers a screenplay's actions, its column ending in Clear formatting, Source mode and Close", async () => {
    const { pane, documents } = setup("document", screenplay(), { formatColumn: memorySetting(true) });
    documents.adopt(screenplay());
    await pane.setInput({ kind: "document", path: "scene.fountain", documentType: "screenplay" }, current);
    expect(pane.formatActions()?.marks.map((action) => action.id)).toContain("underline");
    expect(pane.toolbarBelow?.hidden).toBe(false);
    const shown = [...(pane.toolbarBelow?.querySelectorAll("button") ?? [])]
      .filter((button) => !button.hidden)
      .map((button) => button.getAttribute("aria-label"));
    expect(shown.slice(-3)).toEqual(["Clear formatting", "Source mode", "Close"]);
  });

  it("applies an action by id to the note's text, through its model", async () => {
    const { pane, documents } = setup();
    documents.adopt(noteFile());
    await pane.setInput(songTab(), current);
    pane.view.dispatch({ selection: { anchor: pane.view.state.doc.toString().indexOf("line") } });
    pane.applyFormat("heading2");
    expect(documents.get("notes/song.md")?.content()).toContain("\n## first line\n");
  });

  it("moves the cursor to the end of the title for Heading 1, and writes the heading in Source mode", async () => {
    const { pane, documents, setSourceMode } = setup();
    documents.adopt(noteFile());
    await pane.setInput(songTab(), current);
    const before = documents.get("notes/song.md")?.content();
    pane.view.dispatch({ selection: { anchor: pane.view.state.doc.toString().indexOf("line") } });
    pane.applyFormat("heading1");
    const title = q<HTMLInputElement>(pane.element, ".editor-title-input");
    expect(document.activeElement).toBe(title);
    expect(title.selectionStart).toBe("Song".length);
    expect(documents.get("notes/song.md")?.content()).toBe(before);

    setSourceMode(true);
    pane.refresh();
    pane.view.dispatch({ selection: { anchor: pane.view.state.doc.toString().indexOf("first line") } });
    pane.applyFormat("heading1");
    expect(documents.get("notes/song.md")?.content()).toContain("\n# first line\n");
  });

  it("leaves Mod-I to Italic rather than to CodeMirror's select-parent", () => {
    expect(DOCUMENT_KEYMAP.some((binding) => binding.key === "Mod-i")).toBe(false);
  });

  it("leaves Mod-U to a screenplay's Underline, and to CodeMirror's undo selection where nothing claims it", async () => {
    expect(DOCUMENT_KEYMAP.some((binding) => binding.key === "Mod-u")).toBe(false);
    const takesModU = (view: EditorView) => view.state.facet(keymap).some((map) => map.some((b) => b.key === "Mod-u"));
    const notePane = setup();
    notePane.documents.adopt(noteFile());
    await notePane.pane.setInput(songTab(), current);
    expect(takesModU(notePane.pane.view)).toBe(true);
    const script = setup("document", screenplay());
    script.documents.adopt(screenplay());
    await script.pane.setInput({ kind: "document", path: "scene.fountain", documentType: "screenplay" }, current);
    expect(takesModU(script.pane.view)).toBe(false);
  });

  it("leaves Mod-/ to a note's Comment, and to CodeMirror's comment toggle where nothing claims it", async () => {
    expect(DOCUMENT_KEYMAP.some((binding) => binding.key === "Mod-/")).toBe(false);
    const takes = (view: EditorView) => view.state.facet(keymap).some((map) => map.some((b) => b.key === "Mod-/"));
    const notePane = setup();
    notePane.documents.adopt(noteFile());
    await notePane.pane.setInput(songTab(), current);
    expect(takes(notePane.pane.view)).toBe(false);
    const script = setup("document", screenplay());
    script.documents.adopt(screenplay());
    await script.pane.setInput({ kind: "document", path: "scene.fountain", documentType: "screenplay" }, current);
    expect(takes(script.pane.view)).toBe(true);
  });
});

describe("documentPane Source mode", () => {
  const note = (content = "# Song\n\nfirst **line** and [[other]]\n") => noteFile({ content });
  const lines = (pane: DocumentPane) =>
    [...pane.element.querySelectorAll(".cm-content .cm-line")].map((line) => line.textContent);
  const modelOf = (documents: ReturnType<typeof setup>["documents"]) => {
    const model = documents.get("notes/song.md");
    if (!model) throw new Error("no model for the song");
    return model;
  };

  it("draws a note formatted, and in Source mode its whole file as written, the title bar stepping aside", async () => {
    const { pane, documents, setSourceMode } = setup();
    documents.adopt(noteFile());
    await pane.setInput(songTab(), current);
    expect(lines(pane)).toEqual(["first line", ""]);

    setSourceMode(true);
    pane.refresh();
    expect(pane.view.state.doc.toString()).toBe(noteFile().content);
    expect(pane.element.querySelector(".editor-document > .editor-title-bar")).toBeNull();
    expect(pane.element.querySelector(".has-title")).toBeNull();

    setSourceMode(false);
    pane.refresh();
    expect(pane.view.state.doc.toString()).toBe("first line\n");
    expect(q<HTMLInputElement>(pane.element, ".editor-title-input").value).toBe("Song");
  });

  it("keeps undo across a switch, stepping over the switch itself", async () => {
    const { pane, documents, setSourceMode } = setup();
    documents.adopt(note());
    await pane.setInput(songTab(), current);
    typeAtEnd(pane.view, "more");
    setSourceMode(true);
    pane.refresh();
    expect(undoDepth(pane.view.state)).toBe(1);
    undo(pane.view);
    expect(pane.view.state.doc.toString()).toBe("# Song\n\nfirst **line** and [[other]]\n");
    expect(modelOf(documents).body()).toBe("first **line** and [[other]]\n");
  });

  it("a cached state takes its group's mode when its tab shows again", async () => {
    const { pane, documents, setSourceMode } = setup();
    documents.adopt(note());
    const tab = songTab();
    await pane.setInput(tab, current);
    pane.clearInput();
    setSourceMode(true);
    await pane.setInput(tab, current);
    expect(lines(pane)).toEqual(["# Song", "", "first **line** and [[other]]", ""]);
  });

  it("reads the properties from the whole file's YAML, and writes a Properties tab edit back into it", async () => {
    const { pane, documents, setSourceMode } = setup();
    documents.adopt(noteFile());
    setSourceMode(true);
    await pane.setInput(songTab(), current);
    const model = modelOf(documents);

    const tag = pane.view.state.doc.toString().indexOf("- a") + 2;
    pane.view.dispatch({ changes: { from: tag, to: tag + 1, insert: "b" } });
    expect(model.properties()).toEqual({ tags: ["b"] });
    expect(properties(pane).querySelector('.property-editor-row[data-key="tags"]')?.textContent).toContain("b");

    const live = model.properties();
    if (!live) throw new Error("no properties");
    live.mood = "blue";
    model.notePropertiesChanged();
    expect(pane.view.state.doc.toString()).toBe("---\ntags:\n  - b\nmood: blue\n---\n\n# Song\n\nfirst line\n");
  });

  it("counts lines from the file's own first line, and words from the body alone", async () => {
    const { pane, documents, deps, setSourceMode } = setup();
    documents.adopt(noteFile());
    setSourceMode(true);
    await pane.setInput(songTab(), current);
    pane.revealLine(8);
    expect(pane.view.state.doc.lineAt(pane.view.state.selection.main.head).text).toBe("first line");
    expect(deps.onWordCount).toHaveBeenLastCalledWith({ words: 2, chars: "first line\n".length });
  });

  it("keeps a formatted view of the same note in step with one holding the whole file", async () => {
    const formatted = setup();
    formatted.documents.adopt(noteFile());
    formatted.documents.adopt(noteFile());
    await formatted.pane.setInput(songTab(), current);
    const whole = createDocumentPane("document", { ...formatted.deps, isSourceMode: () => true });
    opened.push(whole);
    document.body.append(whole.element);
    await whole.setInput(songTab(), current);

    const title = whole.view.state.doc.toString().indexOf("Song");
    whole.view.dispatch({ changes: { from: title, to: title + 4, insert: "Tune" } });
    expect(q<HTMLInputElement>(formatted.pane.element, ".editor-title-input").value).toBe("Tune");

    typeAtEnd(formatted.pane.view, "more");
    expect(whole.view.state.doc.toString()).toBe("---\ntags:\n  - a\n---\n\n# Tune\n\nfirst line\nmore");

    modelOf(formatted.documents).setTitleText("Air", formatted.pane.view);
    expect(whole.view.state.doc.toString()).toBe("---\ntags:\n  - a\n---\n\n# Air\n\nfirst line\nmore");
  });

  it("has Source mode only while a note's or a screenplay's editor shows", async () => {
    const notePane = setup();
    notePane.documents.adopt(note());
    await notePane.pane.setInput(songTab(), current);
    expect(notePane.pane.hasSourceMode()).toBe(true);
    notePane.setReadingView(true);
    notePane.pane.refresh();
    expect(notePane.pane.hasSourceMode()).toBe(false);

    const script = setup();
    script.documents.adopt(screenplay());
    await script.pane.setInput({ kind: "document", path: "scene.fountain", documentType: "screenplay" }, current);
    expect(script.pane.hasSourceMode()).toBe(true);
    script.setReadingView(true);
    script.pane.refresh();
    expect(script.pane.hasSourceMode()).toBe(false);

    const code = setup("applet-source", applet());
    await code.pane.setInput({ kind: "applet-source", path: "tools/hello.applet.html" }, current);
    expect(code.pane.hasSourceMode()).toBe(false);
  });

  // The press puts the cursor where it landed, as the editor's own mousedown
  // does in a browser; jsdom can't lay out text for it.
  it("opens a wikilink clicked in the editor the way reading view opens it", async () => {
    const { pane, documents, deps } = setup();
    documents.adopt(note());
    await pane.setInput(songTab(), current);
    const link = q(pane.element, ".cm-md-link");
    link.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, detail: 1 }));
    pane.view.dispatch({ selection: { anchor: pane.view.posAtDOM(link) + 1 } });
    link.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, detail: 1 }));
    link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
    expect(deps.openPath).toHaveBeenCalledWith("resolved/other.md", { anchor: expect.any(HTMLElement) });
  });
});

describe("Backlinks", () => {
  const linkingSong: Backlink = {
    path: "notes/a.md",
    mentions: [{ line: 3, text: "song, then [[song]]", at: 13, length: 4 }],
  };

  it("asks which notes link here when a note opens and when the space changes, never while typing", async () => {
    vi.mocked(getBacklinks).mockImplementation(async () => [linkingSong]);
    const { pane, documents } = setup();
    documents.adopt(noteFile());
    await pane.setInput(songTab(), current);
    expect(getBacklinks).toHaveBeenCalledTimes(1);
    expect(getBacklinks).toHaveBeenLastCalledWith("notes/song.md");
    await vi.waitFor(() => expect(links(pane).textContent).toContain("Backlinks from notes"));

    typeAtEnd(pane.view, "more");
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(getBacklinks).toHaveBeenCalledTimes(1);
    expect(links(pane).textContent).toContain("Backlinks from notes");

    pane.spaceChanged();
    expect(getBacklinks).toHaveBeenCalledTimes(2);
  });

  it("drops an answer for a note no longer shown", async () => {
    const answers: ((backlinks: Backlink[]) => void)[] = [];
    vi.mocked(getBacklinks).mockImplementation(() => new Promise((resolve) => answers.push(resolve)));
    const { pane, documents } = setup();
    documents.adopt(noteFile());
    documents.adopt(noteFile({ path: "notes/other.md", content: "# Other\n" }));
    await pane.setInput(songTab(), current);
    await pane.setInput({ kind: "document", path: "notes/other.md", documentType: "note" }, current);
    answers[0]([linkingSong]);
    answers[1]([]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(links(pane).textContent).not.toContain("Backlinks");
  });

  it("opens a linking note at its mention's own place, not the line's first look-alike", async () => {
    vi.mocked(getBacklinks).mockImplementation(async (path) => (path === "notes/song.md" ? [linkingSong] : []));
    const { pane, documents, deps } = setup();
    documents.adopt(noteFile());
    documents.adopt(noteFile({ path: "notes/a.md", content: "# A\n\nsong, then [[song]]\n" }));
    deps.openPath.mockImplementation((path: string) =>
      pane.setInput({ kind: "document", path, documentType: "note" }, current),
    );
    await pane.setInput(songTab(), current);
    await vi.waitFor(() => expect(links(pane).querySelector(".inspector-link-mention")).not.toBeNull());

    q(links(pane), ".inspector-link-mention").click();
    await vi.waitFor(() => expect(pane.path()).toBe("notes/a.md"));
    await vi.waitFor(() => {
      const { from, to } = pane.view.state.selection.main;
      expect(pane.view.state.sliceDoc(from - 2, to + 2)).toBe("[[song]]");
    });
  });
});

describe("documentPane spellcheck", () => {
  const checked = (pane: DocumentPane) => q(pane.element, ".cm-content").getAttribute("spellcheck");

  // What the spellchecker does with the text holding `text`: the nearest
  // element that says, an unchecked run's mark or else the editor itself.
  function spellcheckAt(pane: DocumentPane, text: string): string | null | undefined {
    const walker = document.createTreeWalker(q(pane.element, ".cm-content"), NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.textContent?.includes(text))
        return node.parentElement?.closest("[spellcheck]")?.getAttribute("spellcheck");
    }
    throw new Error(`no text holds "${text}"`);
  }

  it("checks a note's and a screenplay's text while the setting is on, following it live", async () => {
    const setting = memorySetting(true);
    const { pane, documents } = setup("document", noteFile(), { spellcheck: setting });
    documents.adopt(noteFile());
    documents.adopt(screenplay());
    await pane.setInput(songTab(), current);
    expect(checked(pane)).toBe("true");

    setting.set(false);
    expect(checked(pane)).toBe("false");

    setting.set(true);
    await pane.setInput({ kind: "document", path: "scene.fountain", documentType: "screenplay" }, current);
    expect(checked(pane)).toBe("true");
  });

  it("never checks raw code", async () => {
    const { pane } = setup("applet-source", applet());
    await pane.setInput({ kind: "applet-source", path: "tools/hello.applet.html" }, current);
    expect(checked(pane)).toBe("false");
  });

  // Only the state on screen hears the setting change; a tab's cached one
  // would keep checking if showing it again didn't bring it up to date.
  it("brings a tab's cached editor up to date with the setting when it shows again", async () => {
    const setting = memorySetting(true);
    const { pane, documents } = setup("document", noteFile(), { spellcheck: setting });
    documents.adopt(noteFile());
    const tab = songTab();
    await pane.setInput(tab, current);
    pane.clearInput();

    setting.set(false);
    await pane.setInput(tab, current);

    expect(checked(pane)).toBe("false");
  });

  it("skips the frontmatter in Source mode, and marks nothing while the setting is off", async () => {
    const setting = memorySetting(true);
    const { pane, documents, setSourceMode } = setup("document", noteFile(), { spellcheck: setting });
    documents.adopt(noteFile({ content: "---\ntags:\n  - a\n---\n\n# Song\n\nSome `code` here\n" }));
    setSourceMode(true);
    await pane.setInput(songTab(), current);

    expect(spellcheckAt(pane, "tags")).toBe("false");
    expect(spellcheckAt(pane, "code")).toBe("false");
    expect(spellcheckAt(pane, "Some")).toBe("true");
    expect(spellcheckAt(pane, "Song")).toBe("true");

    setting.set(false);
    expect(pane.element.querySelector(".cm-line [spellcheck]")).toBeNull();
  });
});
