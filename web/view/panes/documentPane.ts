// The document pane: a text document in CodeMirror with an editable title
// bar, properties in the Properties tab and a reading view; one instance per
// editor group, all state on the instance. The document's format
// (web/services/formats.ts) supplies its language, its links and its reading
// view, so the pane names no format.
//
// Also registered as "applet-source" — an applet's raw HTML, in HTML mode
// with no title, properties or reading view.
//
// It never owns document data: edits go into the shared model
// (web/services/documents.ts) as change sets, and peers' change sets are
// mapped through this view's selection, folds and history, so two panes on
// one file stay in step. Per tab it keeps only view state.
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  closeCompletion,
  completionKeymap,
} from "@codemirror/autocomplete";
import {
  defaultKeymap,
  history,
  historyKeymap,
  isolateHistory,
  toggleComment,
  undoSelection,
} from "@codemirror/commands";
import { html as htmlLang } from "@codemirror/lang-html";
import {
  bracketMatching,
  foldGutter,
  foldKeymap,
  HighlightStyle,
  indentOnInput,
  syntaxHighlighting,
} from "@codemirror/language";
import { lintKeymap } from "@codemirror/lint";
import {
  closeSearchPanel,
  highlightSelectionMatches,
  openSearchPanel,
  searchKeymap,
  searchPanelOpen,
} from "@codemirror/search";
import {
  Annotation,
  ChangeSet,
  type ChangeSpec,
  Compartment,
  EditorState,
  type Extension,
  Facet,
  type StateEffect,
  StateField,
  Text,
  Transaction,
} from "@codemirror/state";
import {
  type BlockInfo,
  crosshairCursor,
  Decoration,
  type DecorationSet,
  drawSelection,
  dropCursor,
  EditorView,
  gutters,
  highlightActiveLineGutter,
  highlightSpecialChars,
  type KeyBinding,
  keymap,
  lineNumbers,
  rectangularSelection,
  ViewPlugin,
} from "@codemirror/view";
import { tags } from "@lezer/highlight";
import type { ProposedFileEdit, SelectedRange } from "../../../src/protocol/api.ts";
import { opensFrontmatter, splitFrontmatter } from "../../../src/protocol/frontmatter.ts";
import { basenameOf, dirnameOf, formatRootedPath, isLibraryPath } from "../../../src/protocol/rootedPath.ts";
import { isAgentsFile } from "../../../src/protocol/scopes.ts";
import { imageMediaTypeForPath, isFountainFile, isMarkdownFile } from "../../../src/protocol/types.ts";
import {
  type Backlink,
  type BacklinkMention,
  type FileResponse,
  getBacklinks,
  type Tab,
  type TabPlace,
} from "../../core/apiClient.ts";
import { countWordsAndChars, splitDocumentProperties, titleFromName } from "../../core/documentContent.ts";
import {
  attachImageToDocument,
  imageEmbedFor,
  isSpaceImageMediaType,
  pastedImageName,
} from "../../core/imageAttach.ts";
import { DRAGGED_ENTRY_TYPE, desktopFiles, linkedEntry, readDraggedPath, stripExtension } from "../../core/paths.ts";
import { heightAtLine, type LineAnchor, lineAtHeight, risingAnchors } from "../../core/scrollPlace.ts";
import { type DocumentLinks, imageFolderFor, readingResolvers } from "../../core/spaceTree.ts";
import {
  abandonProposal,
  acceptAll,
  editProposal,
  type ProposalExtra,
  type ProposalOutcome,
  proposalFlow,
  proposeEdit,
} from "../../editProposal.ts";
import { FIND_KEYMAP, findOnPage, findPanel, openFindOnPage, openReplace } from "../../findPanel.ts";
import { createFormatColumn } from "../../formatColumn.ts";
import { activeLineHighlight } from "../../lib/activeLine.ts";
import { type Disposable, DisposableStore, listen, toDisposable } from "../../lib/disposable.ts";
import { createTitleBar, el } from "../../lib/dom.ts";
import { editorFlash, flash, flashRange } from "../../lib/flash.ts";
import { indentGuides, wrappedLineIndent } from "../../lib/indentGuides.ts";
import { selectedTextMark } from "../../lib/selection.ts";
import { checkSpelling, unchecked } from "../../lib/spellcheck.ts";
import { syntaxHighlighters } from "../../lib/syntax.ts";
import { paintTagPills } from "../../lib/tagPill.ts";
import type { TagSource } from "../../lib/tagSuggestions.ts";
import { leadTextMenu } from "../../lib/textMenu.ts";
import { diffWords } from "../../lineDiff.ts";
import { renderFrontmatter } from "../../markdownRender.ts";
import { installLinkPreview } from "../../notePreview.ts";
import { selectedText } from "../../pageFind.ts";
import { contextSettingsCard, settingId } from "../../services/contextSettings.ts";
import type { DialogService } from "../../services/dialog.ts";
import type { DocumentEvent, DocumentModel, DocumentsService } from "../../services/documents.ts";
import type { EditorPane, EditorPaneDescriptor, PaneGroup } from "../../services/editorPanes.ts";
import {
  applyFormat,
  type FormatActions,
  type FormatContext,
  type FormatRegistry,
  type TextFormat,
} from "../../services/formats.ts";
import type { ContextMenuService, MenuItem } from "../../services/menus.ts";
import type { SaveQueue } from "../../services/saveQueue.ts";
import {
  type EditorLayout,
  formatColumn,
  formatColumnExtra,
  linksOneList,
  type Setting,
  spellcheck,
} from "../../services/settings.ts";
import type { OpenSource } from "../../services/tabs.ts";
import type { createLinksList } from "../linksList.ts";
import type { createPropertyEditor } from "../propertyEditor.ts";

export type DocumentPaneKind = "document" | "applet-source";

/** The menu a right-click on a row in Links opens. Its argument is
 * `{ file }`, the linked file's rooted path. */
export const LINKED_FILE_MENU = "editor.linkedFile";

/** The menu above the text menu's items on a link in the text, edited or
 * read, which can also show its row. Its argument is the link's `{ file }`,
 * or a folder link's `{ folder }`. */
export const LINKED_NAME_MENU = "editor.linkedName";

/** The menu a right-click on a Backlinks row opens. Its argument is
 * `{ file, target }`: the linking note, and the document it links to. */
export const LINKED_FROM_MENU = "editor.linkingNote";

// How long typing pauses before Links re-reads the text.
const LINKS_DELAY_MS = 300;
// How long a scroll or the caret rests before its place is written down.
const PLACE_SETTLE_MS = 500;
type DocumentTab = Extract<Tab, { kind: DocumentPaneKind }>;

export interface DocumentPaneDeps {
  documents: DocumentsService;
  // An applet in Source mode writes its raw HTML straight here; a document
  // model schedules its own saves.
  saveQueue: SaveQueue;
  loadFile: (path: string) => Promise<FileResponse>;
  // The format each document type is written in.
  formats: FormatRegistry;
  // Its group's sticky reading-view toggle. The pane reads it on every open
  // and whenever refresh() is called.
  isReadingView: () => boolean;
  // Switches the group to editing, refreshing this pane before it returns.
  leaveReadingView: () => void;
  // Its group's Source mode: a note's text as written, its formatting off.
  // Read like the reading-view toggle.
  isSourceMode: () => boolean;
  // A linked file's description, for a Links row opened to show it.
  describe: (path: string) => Promise<string | undefined>;
  // Linked files in the order the file tree draws them, for Links.
  treeOrder: (paths: readonly string[]) => string[];
  // A space-relative link clicked in reading view, or a row in Links; done
  // once the group shows it.
  openPath: (path: string, from?: OpenSource) => Promise<void> | void;
  // A link preview's open button: the file in a new tab after this one.
  openBeside: (path: string) => void;
  // Draws LINKED_FILE_MENU and LINKED_FROM_MENU; the pane never builds a
  // menu itself.
  contextMenu: ContextMenuService;
  // Where a previewed Table's picture that has gone says why.
  dialog: DialogService;
  // The properties section's row editor, injected because a view never
  // imports another view.
  createPropertyEditor: typeof createPropertyEditor;
  // The space's tag vocabulary: the color of a tag's pill, and the tags its
  // add-tag input suggests.
  tags: TagSource;
  // The Links tab's list, injected for the same reason.
  createLinksList: typeof createLinksList;
  // Whether that list shows each side as one list rather than by folder.
  linksOneList: Setting<boolean>;
  // Brings the properties into view — the assistant shown, its Properties
  // tab selected — before Add property puts a row there to type into.
  revealProperties: () => void;
  // The document's word and character count, or the selection's when
  // there is one; reported on every edit and selection change.
  onWordCount: (counts: { words: number; chars: number }) => void;
  // Whether the toolbar's "Add property" entry applies right now: a document
  // whose properties parse, out of reading view.
  onAddPropertyAvailable: (available: boolean) => void;
  // The pane wrote where the open document is left onto its tab, once a
  // scroll or a caret move settled.
  onPlaceChange: () => void;
  // What the open file says that the pane can't show as it says: a block
  // that doesn't parse, left in the text. Replaces the file's last report.
  reportProblems: (path: string, problems: readonly string[]) => void;
  // Files appeared in the space that the tree doesn't know about yet — an
  // image dropped or pasted into the text. Fired once per gesture, not once
  // per file, so a drop of five doesn't start five overlapping tree reads.
  onSpaceChanged: () => void;
  // A failure worth interrupting for, in the same words the user would get
  // from the tree: an image too large to copy in, a drop the space can't take.
  notify: (message: string) => void;
  // Settings → Editor's layout for a note or screenplay, the Code page's for
  // an applet in Source mode.
  layout: EditorLayout;
  // Whether a note being edited shows its Format column, and how many tools
  // past its format's usual ones it holds.
  formatColumn: Setting<boolean>;
  formatColumnExtra: Setting<number>;
  // Whether a document's text is spellchecked; raw code never is.
  spellcheck: Setting<boolean>;
  // An app command run as a key would run it: the Format column's Source
  // mode, which is the group's.
  runCommand: (id: string, arg?: unknown) => void;
  // The chord that runs a command, as a person reads it.
  shortcutFor: (id: string) => string | undefined;
}

export interface DocumentPane extends EditorPane {
  readonly kind: DocumentPaneKind;
  // The live editor, for a toolkit run's document access and fold commands.
  readonly view: EditorView;
  // The open file's path — what a toolkit button clicked from this pane is
  // bound to.
  path(): string | undefined;
  // What the writer has highlighted, in the file's real line numbers — the
  // ones the gutter shows — or undefined for a collapsed cursor.
  selectedRange(): SelectedRange | undefined;
  // Shows the Properties tab with a new row in it, focused and flashed.
  addProperty(): void;
  // What find can do in the open file: "find" while it is read, on its
  // rendered page or in its locked editor, "replace" while it can change.
  findable(): "find" | "replace" | undefined;
  // Whether Source mode applies to what shows: the editor of a file whose
  // format draws its text formatted.
  hasSourceMode(): boolean;
  // Opens find's card, with Replace showing for `replace`.
  openFind(replace: boolean): void;
  // What the open file's format lets a person do to its text from the
  // Format column, the palette and their keys: undefined while its editor
  // isn't showing or can't change.
  formatActions(): FormatActions | undefined;
  // Applies one of them by id, the editor keeping focus.
  applyFormat(id: string): void;
  // Whether the format offers the action `id` and it can run where the
  // selection is: where its command shows and runs.
  formatApplies(id: string): boolean;
  // The open file's format's own rows in the ⋮ menu.
  formatMenu(): readonly MenuItem[];
  // Re-applies the group's reading view and Source mode to what is open.
  // Optional on EditorPane; a document pane always has one.
  refresh(): void;
  // The space's files changed: linked names and Links re-resolve.
  spaceChanged(): void;
  // Opens `path`'s row in Links to its description, Links read afresh first
  // so a name typed a moment ago is there.
  revealLink(path: string): void;
  // Selects and flashes the text's next mention of `path` after the one the
  // selection is on, wrapping, or its first when the selection is on none.
  revealMention(path: string): void;
  revealLine(line: number, text?: string): void;
  // Draws a proposed rewrite of the whole file over its text, out of reading
  // view, for the writer to accept or reject change by change, or with
  // `apply` accepts all of it at once, as one edit undo reverts. Returns how
  // many changes it shows, or undefined when `edit` is for a file this pane
  // isn't showing.
  propose(edit: ProposedFileEdit, onSettled: (outcome: ProposalOutcome) => void, apply?: boolean): number | undefined;
  // Puts `text` in place of the open file's, title and properties among it,
  // as one edit undo takes back, saved as a restore. False with no document
  // open to take it.
  restore(text: string): boolean;
  // Whether the document is read rather than edited: its rendered page, or
  // its editor locked.
  isReading(): boolean;
  // Where the showing surface is scrolled to: the file line under its top
  // edge plus the share of it scrolled past, 12.5 being halfway down line 12.
  // Undefined while it isn't laid out.
  topLine(): number | undefined;
  // Scrolls the showing surface to a place topLine gave. With `caret`, the
  // editor's cursor goes to the first line starting in view, so typing begins
  // where the eye is rather than pulling the view back to an old cursor.
  scrollToLine(line: number, caret?: boolean): void;
  // Told when the showing surface scrolls, when what it shows moves under it
  // without a scroll, and when the pane shows another tab or switches
  // between editing and reading.
  onScrollChange(listener: (change: ScrollChange) => void): Disposable;
}

export type ScrollChange = "scroll" | "reflow" | "view";

export function isDocumentPane(pane: EditorPane): pane is DocumentPane {
  return pane.kind === "document" || pane.kind === "applet-source";
}

// What a descriptor is wired with: everything but the hooks a pane takes
// from the group it is created in, and the settings bound here. The pane
// factory still takes those as deps, for tests.
export type DocumentPaneWiring = Omit<
  DocumentPaneDeps,
  | "isReadingView"
  | "leaveReadingView"
  | "isSourceMode"
  | "onWordCount"
  | "onAddPropertyAvailable"
  | "onPlaceChange"
  | "linksOneList"
  | "formatColumn"
  | "formatColumnExtra"
  | "spellcheck"
>;

function inGroup(deps: DocumentPaneWiring, group: PaneGroup): DocumentPaneDeps {
  return {
    ...deps,
    linksOneList,
    formatColumn,
    formatColumnExtra,
    spellcheck,
    isReadingView: () => group.isReadingView(),
    leaveReadingView: () => group.leaveReadingView(),
    isSourceMode: () => group.isSourceMode(),
    onWordCount: (counts) => group.reportWordCount(counts),
    onAddPropertyAvailable: (available) => group.setAddPropertyAvailable(available),
    onPlaceChange: () => group.placeChanged(),
  };
}

export function documentPane(deps: DocumentPaneWiring): EditorPaneDescriptor {
  return {
    kind: "document",
    // Add property shows only for a document with properties, out of reading
    // view; the pane refines that through onAddPropertyAvailable once open.
    chrome: { toolbar: true, readingView: true, statusbar: true, actions: ["add-property"] },
    create: (group) => createDocumentPane("document", inGroup(deps, group)),
  };
}

export function appletSourcePane(deps: DocumentPaneWiring): EditorPaneDescriptor {
  return {
    kind: "applet-source",
    chrome: { toolbar: true, readingView: false, statusbar: true, actions: [] }, // raw code has no reading view
    create: (group) => createDocumentPane("applet-source", inGroup(deps, group)),
  };
}

// A note's links and URLs take the accent every other interactive surface
// uses, and nothing else in a note is token-colored: registering any
// highlighter switches off every `fallback: true` one, so CodeMirror's
// default style can't be layered under this.
const markdownLinkHighlightStyle = HighlightStyle.define([
  { tag: [tags.link, tags.url], color: "var(--color-accent)" },
]);

const codeHighlighting = syntaxHighlighters.map((highlighter) => syntaxHighlighting(highlighter));
const codeIndentation = [indentGuides(), wrappedLineIndent()];

// Read-only in the CodeMirror sense (blocks transactions) plus non-editable
// in the DOM sense (drops contenteditable, so there's no caret to blink) —
// together these are what reading view locks. A rendered `page` shown in
// the editor's place is what find searches.
function readingViewExtensions(active: boolean, page?: HTMLElement): Extension {
  return [EditorState.readOnly.of(active), EditorView.editable.of(!active), page ? findOnPage.of(page) : []];
}

// The gutter shows the file's real line numbers: `offset` is how many lines
// of frontmatter and lifted heading sit above the editor's line 1.
//
// This is why the setup below is `codemirror`'s basicSetup copied out rather
// than imported: basicSetup's own lineNumbers() can't be reconfigured, and a
// second lineNumbers() alongside it is rejected. At offset 0 this renders
// exactly like the default.
function lineNumbersExtension(offset: number): Extension {
  return lineNumbers({ formatNumber: (lineNo) => String(lineNo + offset) });
}

// CodeMirror's bindings on keys a format's action may take: a screenplay's
// Underline takes Mod-u, a note's Comment Mod-/. A document whose format has
// no action on one gets CodeMirror's back below, so Mod-u never falls
// through to the browser, whose own is View Source, and code keeps its
// comment toggle.
const CLAIMABLE_KEYS: readonly KeyBinding[] = [
  { key: "Mod-u", run: undoSelection },
  { key: "Mod-/", run: toggleComment },
];

const claimable = (binding: KeyBinding) => CLAIMABLE_KEYS.some((each) => each.key === binding.key);

/** The keys a document editor handles before the app's own listener sees
 * them, so Settings → Shortcuts can say which chords it takes first. */
export const DOCUMENT_KEYMAP: readonly KeyBinding[] = [
  ...closeBracketsKeymap,
  // Mod-i is Italic's: CodeMirror's select-parent would take it first.
  ...defaultKeymap.filter((binding) => binding.key !== "Mod-i" && !claimable(binding)),
  ...FIND_KEYMAP,
  ...searchKeymap,
  ...historyKeymap.filter((binding) => !claimable(binding)),
  ...foldKeymap,
  ...completionKeymap,
  ...lintKeymap,
];

function unclaimedKeys(format: TextFormat | "code" | undefined): Extension {
  const actions = format === undefined || format === "code" ? undefined : format.actions;
  const claimed = new Set(
    [...(actions?.lines ?? []), ...(actions?.marks ?? [])].map((action) =>
      action.key?.toLowerCase().replaceAll("+", "-"),
    ),
  );
  return keymap.of(CLAIMABLE_KEYS.filter((binding) => !claimed.has(binding.key?.toLowerCase())));
}

// Marks a transaction that came from the model — a peer view's edit — so
// the update listener doesn't push it back into the model.
const syncAnnotation = Annotation.define<boolean>();

// Tags a state with the view that built it. A cached state's extensions
// close over that view; another pane must rebuild rather than adopt it.
const stateOwner = Facet.define<EditorView, EditorView | undefined>({ combine: (values) => values[0] });

// How a state shows a note: its body formatted, or in Source mode the whole
// file as written, frontmatter and heading included. A group's Source mode
// is applied to a state only when it differs, since a switch rebuilds the
// formatting and moves the head in or out of the text.
type NoteView = "formatted" | "whole";
const noteView = Facet.define<NoteView, NoteView | undefined>({ combine: (values) => values[0] });

const holdsWholeFile = (state: EditorState) => state.facet(noteView) === "whole";

// Source mode shows the frontmatter, YAML rather than prose, so the
// spellchecker skips the block. Read again on every edit rather than mapped:
// an edit can open or close it.
function frontmatterBlock(doc: Text): DecorationSet {
  if (!opensFrontmatter(doc.sliceString(0, 8))) return Decoration.none;
  const content = doc.toString();
  const split = splitFrontmatter(content);
  if (!split) return Decoration.none;
  return Decoration.set(unchecked.range(0, content.length - split.gap.length - split.body.length));
}

const frontmatterUnchecked = StateField.define<DecorationSet>({
  create: (state) => frontmatterBlock(state.doc),
  update: (block, tr) => (tr.docChanged ? frontmatterBlock(tr.state.doc) : block),
  provide: (field) => EditorView.decorations.from(field),
});

interface SplitContent {
  body: string;
  title: string | undefined;
  properties: Record<string, unknown> | undefined;
}

// A whole file cut the way the pane holds it: a document splits into body,
// lifted title, and frontmatter as its model does; raw code is all body. Line
// breaks normalized, since the editor's text only ever holds "\n".
function splitForProposal(content: string, model: DocumentModel | undefined): SplitContent {
  const text = content.replace(/\r\n?/g, "\n");
  if (!model) return { body: text, title: undefined, properties: undefined };
  return splitDocumentProperties({ documentType: model.documentType, content: text });
}

// The parts of a proposed rewrite that live outside the editor's text. Each
// applies only what the proposal itself changed, so a property it left alone
// keeps whatever the writer set meanwhile.
function proposedExtras(model: DocumentModel, before: SplitContent, after: SplitContent): ProposalExtra[] {
  const extras: ProposalExtra[] = [];
  const title = after.title ?? "";
  if (model.title() && (before.title ?? "") !== title) {
    extras.push({ label: title ? `Title: "${title}"` : "Remove the title", apply: () => model.setTitleText(title) });
  }
  const was = before.properties ?? {};
  const next = after.properties ?? {};
  const keys = [...new Set([...Object.keys(was), ...Object.keys(next)])].filter(
    (key) => JSON.stringify(was[key]) !== JSON.stringify(next[key]),
  );
  if (keys.length && model.properties()) {
    extras.push({
      label: `Properties: ${keys.join(", ")}`,
      apply: () => {
        const live = model.properties();
        if (!live) return;
        for (const key of keys) {
          if (key in next) live[key] = next[key];
          else Reflect.deleteProperty(live, key);
        }
        model.notePropertiesChanged();
      },
    });
  }
  return extras;
}

// CodeMirror's default fold marker, glyphs and all, with its hint moved off
// `title` (which the browser would draw) onto the app's tooltip. A folded
// line's marker is tagged, so the stylesheet keeps it showing while the
// others wait for the pointer.
function foldMarker(open: boolean): HTMLElement {
  const marker = document.createElement("span");
  marker.textContent = open ? "⌄" : "›";
  marker.dataset.tooltip = open ? "Fold line" : "Unfold line";
  if (!open) marker.dataset.folded = "";
  return marker;
}

// A narrow pane widens its left margin by the gutter's width (editor.css),
// so the line numbers stay on screen. The gutter is out of flow, so the
// stylesheet can't size by it: it's measured here, onto the pane, where the
// title bar outside CodeMirror reads it too. Listed after CodeMirror's
// gutter plugin, whose element must be in place when this is built.
function gutterWidthOn(host: HTMLElement): Extension {
  return ViewPlugin.define((view) => {
    const resizes = new ResizeObserver(([entry]) => {
      host.style.setProperty("--gutter-width", `${entry.borderBoxSize[0].inlineSize}px`);
    });
    const gutters = view.scrollDOM.querySelector(".cm-gutters");
    if (gutters) resizes.observe(gutters);
    return { destroy: () => resizes.disconnect() };
  });
}

export function createDocumentPane(kind: DocumentPaneKind, deps: DocumentPaneDeps): DocumentPane {
  const store = new DisposableStore();

  // The edit surface (title bar, CodeMirror) and the reading view are
  // siblings; one shows at a time. The title bar moves between
  // them so it scrolls with whichever is showing.
  const element = el("div", "editor-document-pane");
  // Code, not a note: it takes the Code page's font (editor.css).
  element.classList.toggle("editor-applet-source", kind === "applet-source");
  // The layout's classes go on the pane, never on #editor, so two groups
  // side by side lay out a note and code each by its own page.
  store.add(deps.layout.readableLineLength.subscribe((on) => element.classList.toggle("wide-editor", !on)));
  store.add(deps.layout.lineNumbers.subscribe((show) => element.classList.toggle("hide-line-numbers", !show)));
  store.add(deps.layout.foldMarkers.subscribe((show) => element.classList.toggle("hide-fold-markers", !show)));
  const guides = deps.layout.indentGuides;
  if (guides) store.add(guides.subscribe((show) => element.classList.toggle("hide-indent-guides", !show)));
  const editSurface = el("div", "editor-document");
  const { bar: titleBar, input: titleInput } = createTitleBar();
  titleBar.hidden = true;
  // No heading: the tab names it. Still an inspector section, whose rules lay
  // out reading view's rows and flatten the property editor.
  const propertiesSection = document.createElement("section");
  propertiesSection.className = "inspector-section";
  propertiesSection.hidden = true;
  const properties = document.createElement("div");
  propertiesSection.append(properties);
  const links = store.add(
    deps.createLinksList({
      open: deps.openPath,
      showMenu: (file, at) => showLinkedFileMenu(file, at),
      showLinkingMenu: (file, at) => showLinkingNoteMenu(file, at),
      openMention: (file, mention) => void openMention(file, mention),
      describe: deps.describe,
      treeOrder: deps.treeOrder,
      oneList: deps.linksOneList,
    }),
  );
  const cm = el("div", "editor-cm");
  editSurface.append(cm);
  const reading = el("div", "editor-reading");
  reading.hidden = true;
  const readingContent = el("div", "prose editor-reading-content");
  reading.append(readingContent);
  element.append(editSurface, reading);
  // Where find's card shows: the group mounts it left of its toolbar.
  const findHost = el("div", "find-card-host");

  const readingViewCompartment = new Compartment();
  const lineNumberOffsetCompartment = new Compartment();
  const noteViewCompartment = new Compartment();
  const spellcheckCompartment = new Compartment();
  const view = new EditorView({ parent: cm });

  // The open tab and, for a document, its model. `undefined` between inputs.
  let current: { tab: DocumentTab; model?: DocumentModel; unsubscribe?: () => void } | undefined;
  let appliedLineOffset = 0;

  const formatOf = (model: DocumentModel): TextFormat => deps.formats.get(model.documentType);

  const formatContext: FormatContext = {
    path: () => current?.tab.path,
    openPath: (path, anchor) => deps.openPath(path, { anchor }),
    searchTag: (name) => deps.runCommand("search.forTag", { tag: name }),
  };

  // ---- The Format column, which the group mounts under its toolbar's box ----

  const column = createFormatColumn({
    contextMenu: deps.contextMenu,
    shortcutFor: deps.shortcutFor,
    sourceMode: { isOn: () => deps.isSourceMode(), toggle: () => deps.runCommand("editor.toggleSourceMode") },
    bottom: () => element.getBoundingClientRect().bottom,
    extra: deps.formatColumnExtra,
    close: () => deps.formatColumn.set(false),
    toTitle,
  });
  store.add(column);

  function formatActions(): FormatActions | undefined {
    const model = current?.model;
    if (!model || editSurface.hidden || view.state.readOnly) return undefined;
    return formatOf(model).actions;
  }

  // Redrawn whenever what shows changes. It slides only when the setting
  // itself flips, as Find's card slides only when opened or closed.
  function drawColumn(slide = false): void {
    const actions = deps.formatColumn.get() ? formatActions() : undefined;
    column.show(actions && { view, actions }, slide);
  }
  store.add(deps.formatColumn.subscribe(() => drawColumn(true)));

  // How the group shows a format's text: formatted by the format, or in
  // Source mode as the whole file. A format without formatting has one way.
  function viewOf(format: TextFormat | "code" | undefined): NoteView | undefined {
    if (format === undefined || format === "code" || !format.formatting) return undefined;
    return deps.isSourceMode() ? "whole" : "formatted";
  }

  function noteViewFor(format: TextFormat | "code" | undefined): Extension {
    const shown = viewOf(format);
    if (!shown || format === undefined || format === "code") return [];
    return [noteView.of(shown), shown === "formatted" ? (format.formatting?.(formatContext) ?? []) : []];
  }

  // A document's text is checked while the setting is on, with its format's
  // skips and, in Source mode, the frontmatter's; raw code never is.
  function spellcheckFor(format: TextFormat | "code" | undefined): Extension {
    if (format === undefined || format === "code" || !deps.spellcheck.get()) return [];
    return [checkSpelling, format.spellcheckSkips ?? [], viewOf(format) === "whole" ? frontmatterUnchecked : []];
  }

  // Only the state showing is reconfigured here; a tab's cached state
  // catches up each time it shows again.
  store.add(
    deps.spellcheck.subscribe(() => {
      if (!current) return;
      const format = current.model && formatOf(current.model);
      view.dispatch({ effects: spellcheckCompartment.reconfigure(spellcheckFor(format)) });
    }),
  );

  // ---- An image dropped from the desktop, pasted, or dragged out of the tree ----

  // Only a format that embeds images takes one: the embed is Markdown's
  // `![]()`, which other formats and an Applet's raw HTML mean nothing by. The
  // two handlers below still claim a file drop in those, because CodeMirror's
  // own fallback for one is to read the file as text — which for a PNG inserts
  // a screenful of mojibake and calls it an edit.
  function acceptsImages(): boolean {
    const model = current?.model;
    return model !== undefined && formatOf(model).embedsImages && !view.state.readOnly;
  }

  // The insert lands a round trip after the gesture, so the position is
  // clamped and the path re-checked: drift from an edit landed meanwhile is
  // a nuisance, but the file the pane moved on to is the wrong document.
  //
  // No newline of its own: newlines around the embed would split a
  // dropped-on word across lines, a worse answer than an image inline where
  // it was aimed.
  function insertImageMarkdown(markdown: string, pos: number, pathAtStart: string, userEvent: string): void {
    if (current?.tab.path !== pathAtStart) return;
    const at = Math.min(pos, view.state.doc.length);
    view.dispatch({ changes: { from: at, insert: markdown }, selection: { anchor: at + markdown.length }, userEvent });
    view.focus();
  }

  // Every file is copied in before anything is inserted, so one drop of five
  // images is one edit and one undo rather than five of each.
  async function attachImages(files: { blob: Blob; name: string }[], pos: number): Promise<void> {
    const docPath = current?.tab.path;
    if (docPath === undefined) return;
    const embeds: string[] = [];
    let failure: string | undefined;
    for (const { blob, name } of files) {
      try {
        embeds.push(await attachImageToDocument(blob, name, docPath, imageFolderFor(docPath)));
      } catch (error) {
        failure ??= error instanceof Error ? error.message : `Couldn't add "${name}".`;
      }
    }
    if (embeds.length) {
      insertImageMarkdown(embeds.join("\n"), pos, docPath, "input.drop");
      deps.onSpaceChanged();
    }
    if (failure) deps.notify(failure);
  }

  const imageInputHandlers = EditorView.domEventHandlers({
    drop(event, target) {
      const files = desktopFiles(event);
      // Imprecise, as CodeMirror's own drop is: the precise lookup answers
      // null on an empty line or past a line's end, where a drop still lands.
      const pos = target.posAtCoords({ x: event.clientX, y: event.clientY }, false);
      if (files.length) {
        if (acceptsImages() && pos !== null) {
          void attachImages(
            files.map((file) => ({ blob: file, name: file.name })),
            pos,
          );
        }
        return true;
      }

      // A tree row's drag carries its path, which needs no copy — the entry
      // already sits in the space or a library, so this writes a reference to
      // where it is: an image's embed, or a link to anything else.
      const dragged = readDraggedPath(event);
      if (!dragged || !acceptsImages() || pos === null) return false;
      const docPath = current?.tab.path;
      if (docPath === undefined) return false;
      const folder = event.dataTransfer?.getData(DRAGGED_ENTRY_TYPE) === "directory";
      const reference = imageMediaTypeForPath(dragged.path)
        ? imageEmbedFor(docPath, formatRootedPath(dragged))
        : current?.model && formatOf(current.model).linkFor?.(docPath, dragged, folder);
      if (reference === undefined) {
        deps.notify("A library document can only name files in its own library.");
        return true;
      }
      insertImageMarkdown(reference, pos, docPath, "input.drop");
      return true;
    },

    paste(event, target) {
      if (!acceptsImages()) return false;
      const data = event.clipboardData;
      // Text on the clipboard wins. Copying an image out of a web page puts
      // both an `<img>` and the file itself there, but so does copying a
      // path or a URL, and pasting text as an image is the worse mistake.
      if (!data || data.getData("text/plain")) return false;
      const image = [...data.files].find((file) => isSpaceImageMediaType(file.type));
      if (!image) return false;
      const docPath = current?.tab.path;
      if (docPath === undefined) return false;
      const pos = target.state.selection.main.from;
      void attachImageToDocument(image, pastedImageName(image.type), docPath, imageFolderFor(docPath))
        .then((markdown) => {
          insertImageMarkdown(markdown, pos, docPath, "input.paste");
          deps.onSpaceChanged();
        })
        .catch((error: unknown) => {
          deps.notify(error instanceof Error ? error.message : "Couldn't add that image.");
        });
      return true;
    },
  });

  function extensionsFor(format: TextFormat | "code", lineOffset: number): Extension[] {
    const language = format === "code" ? [htmlLang(), codeIndentation] : format.extensions(formatContext);
    const highlighting = format === "code" ? codeHighlighting : syntaxHighlighting(markdownLinkHighlightStyle);
    // Raw code stays editable whatever the reading-view toggle says; the
    // toggle applies to prose only.
    const readingActive = format !== "code" && deps.isReadingView();
    return [
      stateOwner.of(view),
      // CodeMirror's gutter plugin otherwise sets an inline `position:
      // sticky` on .cm-gutters, which no stylesheet rule can override; the
      // stylesheet positions the gutter itself. Nothing is lost: with
      // lineWrapping on, the scroller never scrolls horizontally.
      gutters({ fixed: false }),
      lineNumberOffsetCompartment.of(lineNumbersExtension(lineOffset)),
      highlightActiveLineGutter(),
      highlightSpecialChars(),
      history(),
      foldGutter({ markerDOM: foldMarker }),
      gutterWidthOn(element),
      drawSelection(),
      dropCursor(),
      EditorState.allowMultipleSelections.of(true),
      indentOnInput(),
      bracketMatching(),
      closeBrackets(),
      autocompletion(),
      rectangularSelection(),
      crosshairCursor(),
      activeLineHighlight,
      selectedTextMark,
      highlightSelectionMatches(),
      findPanel(findHost),
      keymap.of(DOCUMENT_KEYMAP),
      unclaimedKeys(format),
      highlighting,
      imageInputHandlers,
      editProposal({ barHost: element }),
      editorFlash,
      EditorView.lineWrapping,
      language,
      noteViewCompartment.of(noteViewFor(format)),
      readingViewCompartment.of(readingViewExtensions(readingActive)),
      spellcheckCompartment.of(spellcheckFor(format)),
      EditorView.updateListener.of((update) => {
        if (update.docChanged && current) {
          const model = current.model;
          if (model) {
            // Transaction by transaction: each one's changes are relative
            // to the doc it started from, and the model follows along, by
            // the text the editor held then. A change that came from the
            // model is not pushed back.
            for (const tr of update.transactions) {
              if (!tr.docChanged || tr.annotation(syncAnnotation)) continue;
              const source = {
                origin: view,
                userEvent: tr.annotation(Transaction.userEvent),
                proposedBy: tr.annotation(proposalFlow),
              };
              if (holdsWholeFile(tr.startState)) model.applyContentChanges(tr.changes, source);
              else model.applyBodyChanges(tr.changes, source);
            }
          } else {
            deps.saveQueue.schedule(current.tab.path, update.state.doc.toString());
          }
        }
        if (update.docChanged || update.selectionSet) {
          reportWordCount(update.state);
          column.update();
          schedulePlace();
        }
        if (update.docChanged) scheduleLinks();
        if (update.geometryChanged && rewrapping) {
          rewrapping = false;
          noteScroll("reflow");
        }
      }),
    ];
  }

  function stateFor(model: DocumentModel, cursor?: number): EditorState {
    const format = formatOf(model);
    const whole = viewOf(format) === "whole";
    const doc = whole ? Text.of(model.content().split("\n")) : model.bodyText();
    return EditorState.create({
      doc,
      selection: cursor === undefined ? undefined : { anchor: Math.min(cursor, doc.length) },
      extensions: extensionsFor(format, whole ? 0 : model.lineOffset()),
    });
  }

  // Whether a state still holds the model's text: its whole file, or its
  // body, as the state shows it.
  function holdsModelText(state: EditorState, model: DocumentModel): boolean {
    return holdsWholeFile(state) ? state.doc.toString() === model.content() : state.doc.eq(model.bodyText());
  }

  // How many file lines sit above the editor's first: none while it holds
  // the whole file.
  function lineOffset(): number {
    const model = current?.model;
    return model && !holdsWholeFile(view.state) ? model.lineOffset() : 0;
  }

  function showLinkedFileMenu(file: string, at: { x: number; y: number }): void {
    deps.contextMenu.open({ menu: LINKED_FILE_MENU, arg: { file }, at, ariaLabel: "Link actions" });
  }

  function showLinkingNoteMenu(file: string, at: { x: number; y: number }): void {
    const target = current?.model?.path;
    if (target === undefined) return;
    deps.contextMenu.open({ menu: LINKED_FROM_MENU, arg: { file, target }, at, ariaLabel: "Linking note actions" });
  }

  function revealLine(line: number, text?: string, at?: number): void {
    const offset = lineOffset();
    const target = view.state.doc.line(Math.min(Math.max(1, line - offset), view.state.doc.lines));
    let found = -1;
    if (text && at !== undefined && target.text.slice(at, at + text.length).toLowerCase() === text.toLowerCase()) {
      found = at;
    } else if (text) {
      found = target.text.toLowerCase().indexOf(text.toLowerCase());
    }
    const anchor = target.from + Math.max(0, found);
    const head = found === -1 ? anchor : anchor + (text?.length ?? 0);
    view.dispatch({
      selection: { anchor, head },
      effects: [EditorView.scrollIntoView(anchor, { y: "center" }), flashRange(anchor, head)],
    });
    view.focus();
  }

  // The note opens in this group, in place of the document Links listed, and
  // the mention is selected once this pane shows it.
  async function openMention(file: string, mention: BacklinkMention): Promise<void> {
    await deps.openPath(file);
    if (current?.model?.path !== file) return;
    revealLine(mention.line, mention.text.slice(mention.at, mention.at + mention.length), mention.at);
  }

  let linksTimer: ReturnType<typeof setTimeout> | undefined;
  let placeTimer: ReturnType<typeof setTimeout> | undefined;

  function readLinks(model: DocumentModel): DocumentLinks {
    return formatOf(model).links(model, view.state);
  }

  // The notes linking to the open note or screenplay. An answer for a
  // document no longer shown, or one a later ask overtook, is dropped.
  let linkedFrom: { path: string; backlinks: readonly Backlink[] } | undefined;
  let linkedFromAsks = 0;

  function askLinkedFrom(path: string): void {
    const ask = ++linkedFromAsks;
    getBacklinks(path).then(
      (backlinks) => {
        if (ask !== linkedFromAsks || current?.model?.path !== path) return;
        linkedFrom = { path, backlinks };
        renderLinks();
      },
      () => undefined,
    );
  }

  // `fresh` for a newly shown document or a changed space, where a linked
  // file's description may have changed too, and which notes link here;
  // typing only redraws, so it never asks the server.
  function renderLinks(fresh = false): void {
    clearTimeout(linksTimer);
    if (fresh) links.forgetDescriptions();
    const model = current?.model;
    if (fresh && model && kind === "document" && (isMarkdownFile(model.path) || isFountainFile(model.path))) {
      askLinkedFrom(model.path);
    }
    const backlinks = linkedFrom?.path === model?.path ? linkedFrom?.backlinks : undefined;
    links.render(model ? readLinks(model) : { found: [], missing: [] }, model?.classLinks, backlinks);
  }

  function scheduleLinks(): void {
    clearTimeout(linksTimer);
    linksTimer = setTimeout(() => renderLinks(), LINKS_DELAY_MS);
  }

  // A note's count is its body's in either view, so Source mode's head
  // never changes it.
  function reportWordCount(state: EditorState): void {
    const ranges = state.selection.ranges.filter((range) => !range.empty);
    const text = ranges.length
      ? ranges.map((range) => state.sliceDoc(range.from, range.to)).join("\n")
      : (current?.model?.body() ?? state.doc.toString());
    deps.onWordCount(countWordsAndChars(text));
  }

  // Writes the view state back onto the open tab, so reactivating it
  // restores undo history, selection, folds, and scroll. Whichever of the
  // two scroll owners is active (the edit surface for a document with a title
  // bar, CodeMirror's own scroller otherwise) holds the position.
  //
  // Under reading view the edit surface is hidden and reads 0, so only the
  // reading scroll is taken and the editor's place is left as it was.
  function snapshot(): void {
    if (!current) return;
    current.tab.state = view.state;
    if (!reading.hidden && current.tab.kind === "document") current.tab.readingScrollTop = reading.scrollTop;
    else current.tab.scrollTop = Math.max(view.scrollDOM.scrollTop, editSurface.scrollTop);
    if (current.tab.kind === "document") current.tab.place = placeOf() ?? current.tab.place;
  }

  function detach(): void {
    current?.unsubscribe?.();
    current = undefined;
  }

  // Reconfigures the gutter to the model's current line offset in place —
  // a properties or title edit moved it — without replacing the state
  // (which would drop undo history, selection, and scroll).
  function syncLineNumberOffset(): void {
    if (!current?.model || lineOffset() === appliedLineOffset) return;
    appliedLineOffset = lineOffset();
    view.dispatch({ effects: lineNumberOffsetCompartment.reconfigure(lineNumbersExtension(appliedLineOffset)) });
  }

  // A change to the model's body, made where the body sits in the whole file
  // the editor holds, the head above it rewritten too where the change moved it.
  function underHead(changes: ChangeSet): ChangeSet {
    const doc = view.state.doc;
    const length = doc.length - changes.length;
    const head = current?.model?.head() ?? "";
    const specs: ChangeSpec[] = head === doc.sliceString(0, length) ? [] : [{ from: 0, to: length, insert: head }];
    changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
      specs.push({ from: fromA + length, to: toA + length, insert: inserted });
    });
    return ChangeSet.of(specs, doc.length);
  }

  // The head the whole file shows rewritten, where an edit outside the text,
  // to the title or a property, moved it.
  function syncHead(): void {
    const model = current?.model;
    if (!model || !holdsWholeFile(view.state)) return;
    const length = view.state.doc.length - model.bodyText().length;
    const head = model.head();
    if (view.state.sliceDoc(0, length) === head) return;
    view.dispatch({ changes: { from: 0, to: length, insert: head }, annotations: syncAnnotation.of(true) });
  }

  function onModelChange(event: DocumentEvent): void {
    switch (event.kind) {
      case "body": {
        if (event.origin === view) return;
        // A peer's edit, applied as a change so this view's selection,
        // folds, and history map through it rather than being replaced.
        const annotations: Annotation<unknown>[] = [syncAnnotation.of(true)];
        if (event.userEvent) annotations.push(Transaction.userEvent.of(event.userEvent));
        view.dispatch({ changes: holdsWholeFile(view.state) ? underHead(event.changes) : event.changes, annotations });
        if (!reading.hidden) renderReading();
        return;
      }
      case "title":
        syncHead();
        syncLineNumberOffset();
        refreshTitle();
        return;
      case "properties":
        syncHead();
        syncLineNumberOffset();
        reportFrontmatter();
        markPropertiesEmpty();
        // This pane's own property editor already shows its own edit; any
        // other, the whole file's text included, is drawn afresh.
        if (event.origin !== propertiesSection) renderProperties();
        return;
      case "reload": {
        const model = current?.model;
        if (!model) return;
        // One change rather than a new state, so the selection, folds, scroll
        // and a pending proposal map through it as through a peer's edit, and
        // undo takes it back as a step of its own.
        const text = holdsWholeFile(view.state) ? model.content() : model.body();
        const changes = diffWords(view.state.doc.toString(), text);
        if (changes.length > 0) {
          view.dispatch({ changes, annotations: [syncAnnotation.of(true), isolateHistory.of("full")] });
        }
        reportFrontmatter();
        syncLineNumberOffset();
        reportWordCount(view.state);
        refresh();
        renderLinks(true);
        return;
      }
      case "saved":
        return;
    }
  }

  function filename(path: string): string {
    return stripExtension(basenameOf(path));
  }

  // The title bar lives inside whichever surface is showing, as its first
  // child, so it scrolls with the content. `.has-title` is what makes the
  // edit surface the single scroll region (see the CSS).
  function mountTitleBar(container: HTMLElement | null): void {
    editSurface.classList.toggle("has-title", container === editSurface);
    if (!container) {
      titleBar.remove();
      return;
    }
    if (titleBar.parentElement !== container || container.firstElementChild !== titleBar) {
      container.prepend(titleBar);
    }
  }

  function fillTitleBar(value: string, options: { editable: boolean; placeholder?: string }): void {
    titleBar.hidden = false;
    // Never clobber the field while the user is typing in it.
    if (document.activeElement !== titleInput) titleInput.value = value;
    titleInput.placeholder = options.placeholder ?? "";
    titleInput.readOnly = !options.editable;
  }

  // The cursor at the end of the title, while the bar shows it editable: in
  // edit view, outside Source mode, where the title is a line of the text.
  function toTitle(): boolean {
    if (!titleBar.isConnected || titleBar.hidden || titleInput.readOnly) return false;
    titleInput.focus();
    titleInput.setSelectionRange(titleInput.value.length, titleInput.value.length);
    return true;
  }

  function refreshTitle(): void {
    if (!current) {
      mountTitleBar(null);
      return;
    }
    const { tab, model } = current;
    if (!model) {
      fillTitleBar(filename(tab.path), { editable: false }); // raw code: the filename, read-only
      mountTitleBar(editSurface);
      return;
    }
    // The model lifts a title only where the document type has one by
    // docs/protocol.md's Display title rule; a note whose frontmatter doesn't
    // parse keeps its heading in the text, below that block, and in Source
    // mode the heading is a line of the whole file.
    const readingActive = deps.isReadingView();
    if (model.title() === undefined || (!readingActive && holdsWholeFile(view.state))) {
      mountTitleBar(null);
      return;
    }
    const title = model.title();
    fillTitleBar(title?.text ?? "", {
      editable: !readingActive,
      placeholder: title?.placeholder ?? filename(tab.path),
    });
    mountTitleBar(readingActive ? reading : editSurface);
  }

  // The properties of a document type that keeps them, and nothing for any
  // other: the model holds them, or says why a block that doesn't parse gave
  // none.
  //
  // Edit mode gives the row editor even with no rows, so the first property
  // is one click. Reading view locks it to read-only rows — an editor left
  // live beside a locked page would make reading view a lock with a side door.
  function renderProperties(): void {
    const model = current?.model;
    const data = model?.properties();
    const keeps = data !== undefined || model?.frontmatterError() !== undefined;
    const readingActive = deps.isReadingView();
    deps.onAddPropertyAvailable(data !== undefined && !readingActive);
    propertiesSection.hidden = !keeps;
    markPropertiesEmpty();
    if (!keeps) {
      properties.replaceChildren();
      return;
    }
    if (!data) {
      properties.replaceChildren(propertiesNote("No properties: the frontmatter doesn't parse."));
      return;
    }
    if (readingActive) {
      const empty = Object.keys(data).length === 0;
      // A context's settings read as the editor shows them: its card, never
      // the block as text.
      const card = contextOf()?.card(data);
      const shown = card ? { ...data, pragma: "" } : data;
      properties.replaceChildren(
        empty ? propertiesNote("No properties.") : renderFrontmatter(shown, current?.tab.path, model?.fields),
      );
      if (card) properties.append(card);
      paintTagPills(properties, deps.tags);
      return;
    }
    propertyEditor()?.render();
  }

  // Re-marked on every properties change, this pane's own edits included,
  // which never re-render: deleting the last property empties the section.
  // Frontmatter that doesn't parse is not empty — its error is worth reading.
  function markPropertiesEmpty(): void {
    const data = current?.model?.properties();
    propertiesSection.toggleAttribute("data-empty", data !== undefined && Object.keys(data).length === 0);
  }

  function propertiesNote(text: string): HTMLElement {
    const note = document.createElement("p");
    note.className = "inspector-empty";
    note.textContent = text;
    return note;
  }

  // The context a space folder's own AGENTS.md opens, never the space's:
  // its settings shown read-only, each opening the Context dialog at it.
  function contextOf(): { card(data: Record<string, unknown>): HTMLElement | undefined; open(): void } | undefined {
    const path = current?.tab.path;
    if (path === undefined || !isAgentsFile(path) || isLibraryPath(path)) return undefined;
    const folder = dirnameOf(path);
    if (folder === "") return undefined;
    const open = (setting?: string) => deps.runCommand("context.open", { folder, setting });
    const words = (kind: string) => deps.formats.scopeSettings(kind);
    return {
      card: (data) =>
        Object.hasOwn(data, "pragma")
          ? contextSettingsCard(folder, data.pragma, words, (setting) => open(settingId(setting)))
          : undefined,
      open: () => open(),
    };
  }

  function propertyEditor(): ReturnType<typeof createPropertyEditor> | undefined {
    const model = current?.model;
    const data = model?.properties();
    if (!model || !data) return undefined;
    return deps.createPropertyEditor(properties, data, () => model.notePropertiesChanged(propertiesSection), {
      contextMenu: deps.contextMenu,
      tags: deps.tags,
      path: current?.tab.path,
      context: contextOf(),
      fields: model.fields,
    });
  }

  // Reconciles the group's reading view and Source mode with the open
  // document: which surface shows, the rendered page, the read-only lock,
  // the formatting, the properties section, and the title bar.
  //
  // A document read in its locked editor, switched at the very top, stays at
  // the very top. Its format may hide lines while reading, and as they come
  // back CodeMirror holds the first visible line in place, which would leave
  // the opening lines just above the fold, as if they were gone.
  function refresh(options: { restoringTab?: boolean } = {}): void {
    if (!current) return;
    const model = current.model;
    const format = model && formatOf(model);
    const readingActive = !!model && deps.isReadingView();
    // A format with a page of its own renders it; any other is read in
    // CodeMirror, locked.
    const showRendered = readingActive && format?.renderReading !== undefined;
    // A tab being shown gets its own saved scroll back afterwards.
    const keepTop =
      !options.restoringTab &&
      format !== undefined &&
      format.renderReading === undefined &&
      view.state.facet(EditorView.editable) === readingActive &&
      view.scrollDOM.scrollTop < 1;
    const shown = viewOf(format);
    const switching = shown !== view.state.facet(noteView);
    const swap = switching && model ? headSwap(model, shown === "whole") : undefined;
    const place = switching && !options.restoringTab && !showRendered ? keptPlace(swap) : [];
    element.classList.toggle("reading-view", readingActive);
    reading.hidden = !showRendered;
    editSurface.hidden = showRendered;
    renderProperties();
    if (showRendered) renderReading();
    view.dispatch({
      changes: swap,
      annotations: swap && [syncAnnotation.of(true), Transaction.addToHistory.of(false)],
      effects: [
        readingViewCompartment.reconfigure(
          readingViewExtensions(readingActive, showRendered ? readingContent : undefined),
        ),
        ...(switching ? [noteViewCompartment.reconfigure(noteViewFor(format))] : []),
        spellcheckCompartment.reconfigure(spellcheckFor(format)),
        // A margin as tall as the editor clamps the scroll at 0: the padding
        // above line 1 shows too, as it does when the file opens.
        ...(place.length || !keepTop
          ? place
          : [EditorView.scrollIntoView(0, { y: "start", yMargin: view.scrollDOM.clientHeight })]),
      ],
    });
    if (switching) syncLineNumberOffset();
    refreshTitle();
    drawColumn();
    noteScroll("view");
  }

  // The edit that moves the editor between a note's body and its whole file:
  // the head put above the body, or taken off it. Out of the history, so undo
  // steps over a switch rather than taking it back.
  function headSwap(model: DocumentModel, whole: boolean): ChangeSet {
    const length = view.state.doc.length;
    return whole
      ? ChangeSet.of({ from: 0, insert: model.head() }, length)
      : ChangeSet.of({ from: 0, to: length - model.bodyText().length }, length);
  }

  // Where a switch into or out of Source mode leaves the editor: the line at
  // the top stays there, since sized headings change every height below it,
  // and the very top stays the very top, title bar and all.
  function keptPlace(swap: ChangeSet | undefined): StateEffect<unknown>[] {
    const scroller = editScroller();
    if (!scroller.clientHeight) return [];
    if (scroller.scrollTop < 1) return [EditorView.scrollIntoView(0, { y: "start", yMargin: scroller.clientHeight })];
    const top = view.lineBlockAtHeight(scroller.scrollTop - documentTopIn(scroller)).from;
    return [EditorView.scrollIntoView(swap ? swap.mapPos(top, 1) : top, { y: "start", yMargin: 0 })];
  }

  // Whether the page reading view shows would be drawn differently now.
  let readingChanged = () => false;
  function renderReading(): void {
    const model = current?.model;
    const rendered = model && formatOf(model).renderReading?.(model);
    if (!rendered) return;
    readingChanged = rendered.changed;
    readingContent.replaceChildren(rendered.page);
    paintTagPills(readingContent, deps.tags);
    noteScroll("reflow");
  }

  // ---- Its place, for a view of the same file scrolling beside it ----

  const scrollListeners = new Set<(change: ScrollChange) => void>();
  // A surface took a new size that CodeMirror hasn't measured yet.
  let rewrapping = false;
  function noteScroll(change: ScrollChange): void {
    for (const listener of scrollListeners) listener(change);
  }

  // What scrolls while the editor shows: the edit surface, title bar and
  // all, or CodeMirror's own scroller where there is no title (codemirror.css).
  function editScroller(): HTMLElement {
    return editSurface.classList.contains("has-title") ? editSurface : view.scrollDOM;
  }

  // Where the first line starts in `scroller`'s content.
  function documentTopIn(scroller: HTMLElement): number {
    return view.documentTop - scroller.getBoundingClientRect().top + scroller.scrollTop;
  }

  // A CodeMirror block's two ends: a folded run, or the lines a format hides
  // while reading, is one block spread over its lines. The space above the
  // first block, title bar and padding, counts as part of it, as on the page,
  // so the very top is the first line on either surface.
  function blockAnchors(block: BlockInfo, documentTop: number): LineAnchor[] {
    const doc = view.state.doc;
    const offset = lineOffset();
    return [
      { line: doc.lineAt(block.from).number + offset, y: block.from === 0 ? 0 : documentTop + block.top },
      { line: doc.lineAt(block.to).number + offset + 1, y: documentTop + block.bottom },
    ];
  }

  function editorHeightAt(line: number, scroller: HTMLElement): number {
    const doc = view.state.doc;
    const at = Math.min(Math.max(1, Math.floor(line) - lineOffset()), doc.lines);
    return heightAtLine(blockAnchors(view.lineBlockAt(doc.line(at).from), documentTopIn(scroller)), line);
  }

  function editorScrollTo(line: number): void {
    const scroller = editScroller();
    if (!scroller.clientHeight) return;
    const y = editorHeightAt(line, scroller);
    if (Math.abs(scroller.scrollTop - y) >= 1) scroller.scrollTop = y;
  }

  // The page's blocks by the line each starts on, the file's first line at
  // its very top and the line past its last where it ends.
  function pageAnchors(): LineAnchor[] {
    const model = current?.model;
    if (!model) return [];
    const top = reading.getBoundingClientRect().top - reading.scrollTop;
    const first = model.lineOffset() + 1;
    const blocks = [...readingContent.querySelectorAll<HTMLElement>("[data-line]")].map((block) => ({
      line: Number(block.dataset.line),
      y: block.getBoundingClientRect().top - top,
    }));
    const end = { line: first + model.bodyText().lines, y: readingContent.getBoundingClientRect().bottom - top };
    return risingAnchors([{ line: first, y: 0 }, ...blocks, end]);
  }

  function topLine(): number | undefined {
    if (!current) return undefined;
    if (!reading.hidden) {
      const anchors = pageAnchors();
      return anchors.length && reading.clientHeight ? lineAtHeight(anchors, reading.scrollTop) : undefined;
    }
    const scroller = editScroller();
    if (!scroller.clientHeight) return undefined;
    const documentTop = documentTopIn(scroller);
    const block = view.lineBlockAtHeight(scroller.scrollTop - documentTop);
    return lineAtHeight(blockAnchors(block, documentTop), scroller.scrollTop);
  }

  function scrollToLine(line: number, caret = false): void {
    if (!current) return;
    if (reading.hidden) {
      if (caret) {
        const doc = view.state.doc;
        const at = Math.min(Math.max(1, Math.ceil(line) - lineOffset()), doc.lines);
        view.dispatch({ selection: { anchor: doc.line(at).from } });
      }
      editorScrollTo(line);
      return;
    }
    const anchors = pageAnchors();
    if (!anchors.length || !reading.clientHeight) return;
    const y = heightAtLine(anchors, line);
    if (Math.abs(reading.scrollTop - y) >= 1) reading.scrollTop = y;
  }

  // Where the open document is left: the showing surface's top line, and the
  // caret as a file line and column, which a switch between formatted and
  // Source mode doesn't move.
  function placeOf(): TabPlace | undefined {
    const line = topLine();
    if (line === undefined) return undefined;
    const head = view.state.selection.main.head;
    const at = view.state.doc.lineAt(head);
    return { line: Math.round(line * 100) / 100, caret: { line: at.number + lineOffset(), column: head - at.from } };
  }

  // The place goes onto the tab once a scroll or a caret move settles, and
  // the layout saves it then: a window closed without switching tabs still
  // reopens where it was.
  function schedulePlace(): void {
    if (current?.tab.kind !== "document") return;
    clearTimeout(placeTimer);
    placeTimer = setTimeout(() => {
      const place = placeOf();
      if (!place || current?.tab.kind !== "document") return;
      current.tab.place = place;
      deps.onPlaceChange();
    }, PLACE_SETTLE_MS);
  }

  // Last session's place, by file line, for a surface with no scroll of its
  // own this session: its pixels may sit on other text since. Once more a
  // frame on, after CodeMirror measures the lines it estimated.
  function putBack(tab: DocumentTab, place: TabPlace, caret: boolean): void {
    if (caret && place.caret) {
      const doc = view.state.doc;
      const at = doc.line(Math.min(Math.max(1, place.caret.line - lineOffset()), doc.lines));
      view.dispatch({ selection: { anchor: Math.min(at.from + place.caret.column, at.to) } });
    }
    scrollToLine(place.line);
    requestAnimationFrame(() => {
      if (current?.tab === tab) scrollToLine(place.line);
    });
  }

  store.add(
    listen(
      element,
      "scroll",
      (event) => {
        if (event.target !== reading && event.target !== editScroller()) return;
        noteScroll("scroll");
        schedulePlace();
      },
      { capture: true },
    ),
  );
  // An image in the page loaded, or either surface took a new size and
  // rewrapped: what shows moved under its scroll without scrolling, which not
  // every browser follows with a scroll of its own.
  //
  // CodeMirror measures a new size a moment after it lands, so until then its
  // line heights are the old width's; the geometry change that measure brings
  // is reported as a reflow too (the update listener in extensionsFor).
  const resizes = new ResizeObserver((entries) => {
    if (entries.some((entry) => entry.target === editSurface)) rewrapping = true;
    noteScroll("reflow");
    column.fitToRoom();
  });
  resizes.observe(readingContent);
  resizes.observe(editSurface);
  store.add(() => resizes.disconnect());

  function reportFrontmatter(): void {
    const model = current?.model;
    if (!model) return;
    const error = model.frontmatterError();
    deps.reportProblems(
      model.path,
      error === undefined
        ? []
        : [
            `The frontmatter isn't valid YAML (${error}). Until it's fixed and the note reopened, it has no properties and is kept private.`,
          ],
    );
  }

  function show(tab: DocumentTab, model: DocumentModel | undefined, state: EditorState): void {
    const fresh = tab.state === undefined;
    snapshot();
    detach();
    linkPreview.close();
    current = { tab, model, unsubscribe: model?.subscribe(onModelChange) };
    reportFrontmatter();
    view.setState(state);
    // A cached state may predate a frontmatter edit made through another
    // tab; resync rather than trust it.
    appliedLineOffset = Number.NaN;
    syncLineNumberOffset();
    reportWordCount(view.state);
    refresh({ restoringTab: true });
    renderLinks(true);
    if (tab.scrollTop !== undefined) {
      view.scrollDOM.scrollTop = tab.scrollTop;
      editSurface.scrollTop = tab.scrollTop;
    }
    // One reading element serves every note this pane shows, so a note with
    // no place of its own starts at the top, not at the last note's offset.
    if (!reading.hidden) reading.scrollTop = (tab.kind === "document" && tab.readingScrollTop) || 0;
    if (tab.kind !== "document" || !tab.place) return;
    if ((reading.hidden ? tab.scrollTop : tab.readingScrollTop) === undefined) putBack(tab, tab.place, fresh);
  }

  store.add(
    listen(titleInput, "input", () => {
      const model = current?.model;
      if (!model?.title() || titleInput.readOnly) return;
      model.setTitleText(titleInput.value, view);
    }),
  );
  // Tab in an empty title fills it with the file's name read as a title and
  // leaves the caret there; once it holds text, Tab moves on into the text.
  // The fill goes through execCommand: only an edit the browser makes itself
  // lands in the field's undo history and fires `input` as typing does.
  store.add(
    listen(titleInput, "keydown", (event) => {
      const { key, shiftKey, altKey, ctrlKey, metaKey } = event as KeyboardEvent;
      if (key !== "Tab" || shiftKey || altKey || ctrlKey || metaKey) return;
      const title = current?.model?.title();
      if (!title || titleInput.readOnly || titleInput.value) return;
      const filled = titleFromName(title.placeholder);
      if (!filled) return;
      event.preventDefault();
      document.execCommand("insertText", false, filled);
    }),
  );

  // A format's rendered page is plain DOM: a space-relative link carries
  // data-space-path instead of a navigable href, and this is what turns a
  // click on it, or on a tag, into in-app navigation.
  store.add(
    listen(readingContent, "click", (event) => {
      const target = event.target as HTMLElement;
      const tag = target.closest<HTMLElement>(".inline-tag");
      if (tag?.dataset.tag) deps.runCommand("search.forTag", { tag: tag.dataset.tag });
      const link = target.closest<HTMLElement>("a[data-space-path]");
      if (!link) return;
      event.preventDefault();
      deps.openPath(link.dataset.spacePath ?? "", { anchor: link });
    }),
  );
  // A right-click on a link, edited or read and in every format, puts the
  // link's menu above the text menu's items. Left uncancelled for the text
  // menu to open.
  const linkAt = (target: EventTarget | null): string | undefined => {
    const link = target instanceof Element ? target.closest<HTMLElement>("[data-space-path]") : null;
    return link && (cm.contains(link) || readingContent.contains(link)) ? link.dataset.spacePath : undefined;
  };
  store.add(
    listen(element, "contextmenu", (event) => {
      const path = linkAt(event.target);
      if (path) leadTextMenu(event, { menu: LINKED_NAME_MENU, arg: linkedEntry(path), ariaLabel: "Link actions" });
    }),
  );
  // Its press leaves the caret where it was: a caret put in the link would
  // unfold the link's syntax under its menu.
  store.add(
    listen(cm, "mousedown", (event) => {
      if ((event as MouseEvent).button === 2 && linkAt(event.target)) event.preventDefault();
    }),
  );
  // A link to a file a page draws, edited or read, shows the file while the
  // pointer rests on it, in this pane's part of the editor, with the rest of
  // this note muted.
  const linkPreview = store.add(
    installLinkPreview(element, {
      loadFile: deps.loadFile,
      readingResolvers,
      formats: deps.formats,
      openPath: (path) => deps.openPath(path),
      openBeside: deps.openBeside,
      area: element,
      runs: "right",
      contextMenu: deps.contextMenu,
      dialog: deps.dialog,
    }),
  );

  function showProposal(
    edit: ProposedFileEdit,
    onSettled: (outcome: ProposalOutcome) => void,
    apply: boolean,
    userEvent?: string,
  ): number | undefined {
    if (!current || current.tab.path !== edit.path) return undefined;
    const model = current.model;
    // The whole file the editor holds in Source mode takes a rewrite whole,
    // its title and properties changes among the text's.
    const lifting = holdsWholeFile(view.state) ? undefined : model;
    const before = splitForProposal(edit.before, lifting);
    const after = splitForProposal(edit.newContent, lifting);
    const hunks = diffWords(before.body, after.body);
    const extras = lifting ? proposedExtras(lifting, before, after) : [];
    // Reading view decides none of a proposal, so the group leaves it first:
    // an apply and the scroll to the first change both need the live editor.
    // Asked of the editor's lock, not the toggle, which raw code ignores; a
    // proposal with nothing in it leaves the mode alone.
    if ((hunks.length || extras.length) && view.state.readOnly) deps.leaveReadingView();
    const shown = proposeEdit(view, { base: before.body, hunks, extras, onSettled });
    if (apply) acceptAll(view, userEvent);
    return shown;
  }

  return {
    kind,
    element,
    toolbarAside: findHost,
    toolbarBelow: column.element,
    // Raw code has no links or properties.
    links: kind === "document" ? links.element : undefined,
    properties: kind === "document" ? propertiesSection : undefined,
    view,
    path: () => current?.tab.path,
    selectedRange() {
      const { from, to } = view.state.selection.main;
      if (from === to) return undefined;
      // The main range only, like a toolkit run's selection — not the union
      // the word count reports, which has no single range.
      const { doc } = view.state;
      // Dragging through a line's end puts `to` on the next line's first
      // character; counted in, that reports a line the writer sees
      // unhighlighted (and, at the end of a paragraph, an empty one).
      const end = doc.lineAt(to).from === to ? to - 1 : to;
      const first = doc.lineAt(from);
      const last = doc.lineAt(end);
      const offset = lineOffset();
      return {
        startLine: first.number + offset,
        startColumn: from - first.from + 1,
        endLine: last.number + offset,
        endColumn: end - last.from + 1,
      };
    },
    revealLine,
    async setInput(tab, ctx, prefetched) {
      if (tab.kind !== kind) throw new Error(`the ${kind} pane can't show a "${tab.kind}" tab`);
      if (tab.kind === "document") {
        const model = deps.documents.get(tab.path);
        if (!model) throw new Error(`${tab.path} has no document model; adopt it before opening`);
        // A cached state is reused only if it is this pane's own and still
        // matches the model. One that fell behind (another tab edited the
        // shared model meanwhile) restarts from the model, keeping the cursor,
        // clamped, but not the history. One built by another pane closes over
        // that pane's listeners and is rebuilt the same way.
        let state = tab.state;
        if (!state || state.facet(stateOwner) !== view || !holdsModelText(state, model)) {
          if (state) abandonProposal(state);
          const cursor = state?.selection.main.head;
          state = stateFor(model, cursor);
        }
        show(tab, model, state);
        return;
      }
      let state = tab.state;
      if (!state) {
        const file = prefetched ?? (await deps.loadFile(tab.path));
        if (!ctx.isCurrent()) return;
        if (file.kind !== "applet") throw new Error(`${tab.path} is not an applet`);
        deps.saveQueue.noteRevision(file.path, file.revision);
        state = EditorState.create({ doc: file.html, extensions: extensionsFor("code", 0) });
      }
      show(tab, undefined, state);
    },
    clearInput() {
      snapshot();
      detach();
      linkPreview.close();
      // A keystroke leaves completion a timer that reads completion's own
      // state, which the empty state below lacks; closing completion first
      // cancels the timer, or it throws once it fires.
      closeCompletion(view);
      view.setState(EditorState.create());
      mountTitleBar(null);
      readingContent.replaceChildren();
      properties.replaceChildren();
      propertiesSection.hidden = true;
      renderLinks();
      drawColumn();
      noteScroll("view");
    },
    title: () => current?.model?.title()?.text.trim() || undefined,
    refresh,
    spaceChanged() {
      const model = current?.model;
      if (model) formatOf(model).spaceChanged?.(view);
      // Only when a link leads somewhere new: the space changes with every
      // save, and drawing the page again drops its selection and stops a
      // video playing in it.
      if (!reading.hidden && readingChanged()) renderReading();
      renderLinks(true);
    },
    revealLink(path) {
      renderLinks();
      links.reveal(path);
    },
    revealMention(path) {
      const model = current?.model;
      const mentions = model && readLinks(model).found.find((link) => link.path === path)?.mentions;
      if (!mentions?.length) return;
      const { from, to } = view.state.selection.main;
      const on = mentions.findIndex((mention) => mention.from <= from && to <= mention.to);
      const next = mentions[(on + 1) % mentions.length];
      view.dispatch({
        selection: { anchor: next.from, head: next.to },
        effects: [EditorView.scrollIntoView(next.from, { y: "center" }), flashRange(next.from, next.to)],
      });
      view.focus();
    },
    addProperty() {
      if (!current?.model?.properties() || deps.isReadingView()) return;
      deps.revealProperties();
      const row = propertyEditor()?.addProperty();
      if (row) flash(row);
    },
    findable() {
      if (!current) return undefined;
      return view.state.readOnly ? "find" : "replace";
    },
    hasSourceMode() {
      const model = current?.model;
      return model !== undefined && formatOf(model).formatting !== undefined && !deps.isReadingView();
    },
    openFind(replace) {
      if (!reading.hidden) openFindOnPage(view, selectedText(readingContent));
      else if (replace) openReplace(view);
      else openSearchPanel(view);
    },
    // Find's card over a rendered page, which Escape on the page closes as
    // it does from the editor.
    hasTransient: () => !reading.hidden && searchPanelOpen(view.state),
    dismissTransient: () => void closeSearchPanel(view),
    formatActions,
    applyFormat(id) {
      const actions = formatActions();
      if (!actions) return;
      const action = [...actions.lines, ...actions.marks].find((each) => each.id === id);
      if ((action?.title && toTitle()) || !applyFormat(actions, id, view)) return;
      view.focus();
    },
    formatApplies(id) {
      const actions = formatActions();
      const action = actions && [...actions.lines, ...actions.marks].find((each) => each.id === id);
      return action !== undefined && action.applies?.(view.state) !== false;
    },
    formatMenu() {
      const model = current?.model;
      return (model && formatOf(model).menu) ?? [];
    },
    propose: (edit, onSettled, apply = false) => showProposal(edit, onSettled, apply),
    restore(text) {
      const model = current?.model;
      if (!current || !model) return false;
      const edit = { path: current.tab.path, before: model.content(), newContent: text, revision: "" };
      showProposal(edit, () => undefined, true, "input.restore");
      return true;
    },
    isReading: () => current?.model !== undefined && deps.isReadingView(),
    topLine,
    scrollToLine,
    onScrollChange(listener) {
      scrollListeners.add(listener);
      return toDisposable(() => scrollListeners.delete(listener));
    },
    dispose() {
      scrollListeners.clear();
      clearTimeout(linksTimer);
      clearTimeout(placeTimer);
      detach();
      view.destroy();
      store.dispose();
      element.remove();
      findHost.remove();
      column.element.remove();
    },
  };
}
