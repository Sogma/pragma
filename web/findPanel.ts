// The find panel: CodeMirror's search drawn as a card in the editor
// toolbar's row instead of a strip across the editor. The query, the match
// marks and the commands stay CodeMirror's. The card counts the matches and
// moves the selection to the nearest one as the query changes, so the count
// has a current match to name.
//
// While a rendered page shows in the editor's place, the same card searches
// the page. Its query stays the editor's, so it outlasts a switch.
import {
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  openSearchPanel,
  replaceAll,
  replaceNext,
  SearchQuery,
  search,
  searchPanelOpen,
  selectMatches,
  setSearchQuery,
} from "@codemirror/search";
import {
  EditorSelection,
  type EditorState,
  type Extension,
  Facet,
  type SelectionRange,
  StateEffect,
  StateField,
} from "@codemirror/state";
import { EditorView, type KeyBinding, type Panel, panels, runScopeHandlers, type ViewUpdate } from "@codemirror/view";
import {
  COUNT_LIMIT,
  configOf,
  createFindCard,
  type Finder,
  type FindOption,
  type QueryConfig,
  slideIn,
  slideOut,
  visibleArea,
} from "./findCard.ts";
import { createPageFinder } from "./pageFind.ts";

interface Match {
  from: number;
  to: number;
}

interface FindPanel extends Panel {
  opened(): void;
  focusFind(): void;
  focusReplace(): void;
  // Whether the card searches a rendered page rather than the text.
  onPage(): boolean;
  step(backward: boolean): void;
  // Picks a match on the page after the query changed, or from the top of
  // what shows.
  seekOnPage(fromView: boolean): void;
}

/** A rendered page shown in the editor's place, which find searches
 * instead of the editor's text. */
export const findOnPage = Facet.define<HTMLElement, HTMLElement | undefined>({ combine: (pages) => pages[0] });

const setReplaceShown = StateEffect.define<boolean>();

// Whether the Replace row shows. In the state, so it outlasts a close and
// each tab keeps its own.
const replaceShown = StateField.define<boolean>({
  create: () => false,
  update(shown, tr) {
    for (const effect of tr.effects) if (effect.is(setReplaceShown)) shown = effect.value;
    return shown;
  },
});

// The card each view shows, for the commands and the reveal that reach it.
const livePanels = new WeakMap<EditorView, FindPanel>();

// CodeMirror marks a panel container with its theme classes, whose root rule
// forces `display: flex !important`. So the container is a frame inside the
// host, made once per host, and the host stays the caller's to lay out and
// to hide.
const frames = new WeakMap<HTMLElement, HTMLElement>();

function frameIn(host: HTMLElement): HTMLElement {
  let frame = frames.get(host);
  if (!frame) {
    frame = document.createElement("div");
    frame.className = "find-card-frame";
    host.append(frame);
    frames.set(host, frame);
  }
  return frame;
}

function nearestMatch(state: EditorState, query: SearchQuery): Match | undefined {
  const after = query.getCursor(state, state.selection.main.from).next();
  const found = after.done ? query.getCursor(state).next() : after;
  return found.done ? undefined : { from: found.value.from, to: found.value.to };
}

// Whether a match shows, clear of the card. The positions are clamped:
// CodeMirror's Replace asks about the next match in the text it is about to
// write, which can run past the end of the text on screen.
function inView(view: EditorView, range: SelectionRange): boolean {
  const length = view.state.doc.length;
  const start = view.coordsAtPos(Math.min(range.from, length));
  const end = view.coordsAtPos(Math.min(range.to, length));
  if (!start || !end) return false;
  const card = livePanels.get(view)?.dom;
  const area = visibleArea(view.scrollDOM, card, { left: start.left, right: end.right });
  return start.top >= area.top && end.bottom <= area.bottom;
}

// A match in view stays where it is; any other is brought to the middle of
// the editor, so the lines around it show too.
function revealMatch(range: SelectionRange, view: EditorView) {
  return EditorView.scrollIntoView(range, { y: inView(view, range) ? "nearest" : "center" });
}

// Puts a changed query in the state and, with `seek`, selects its nearest
// match from the selection's start on, wrapping. From the start, so typing
// on from "Fl" to "Flow" stays on the word it found. On a page the page's
// own match is picked instead, the hidden selection left as it was.
function commitQuery(view: EditorView, change: Partial<QueryConfig>, seek: boolean): void {
  const current = getSearchQuery(view.state);
  const query = new SearchQuery({ ...configOf(current), ...change });
  if (query.eq(current)) return;
  const onPage = view.state.facet(findOnPage) !== undefined;
  const match = seek && !onPage && query.valid ? nearestMatch(view.state, query) : undefined;
  if (!match) view.dispatch({ effects: setSearchQuery.of(query) });
  else {
    const selection = EditorSelection.single(match.from, match.to);
    view.dispatch({
      selection,
      effects: [setSearchQuery.of(query), revealMatch(selection.main, view)],
      userEvent: "select.search",
    });
  }
  if (seek && onPage) livePanels.get(view)?.seekOnPage(false);
}

function toggleOption(view: EditorView, option: FindOption): boolean {
  commitQuery(view, { [option]: !getSearchQuery(view.state)[option] }, true);
  return true;
}

/** Opens the panel with Replace showing; a read-only editor gets Find
 * alone. Focus goes to Replace once there is something to find. */
export function openReplace(view: EditorView): boolean {
  openSearchPanel(view);
  if (view.state.readOnly) return true;
  if (!view.state.field(replaceShown, false)) view.dispatch({ effects: setReplaceShown.of(true) });
  if (getSearchQuery(view.state).search) livePanels.get(view)?.focusReplace();
  return true;
}

/** Opens the panel over a rendered page with Find holding `seed`, the text
 * selected on the page, or else the query it had: never the hidden editor's
 * selection, which CodeMirror's own open would take. */
export function openFindOnPage(view: EditorView, seed: string | undefined): void {
  const kept = getSearchQuery(view.state);
  openSearchPanel(view);
  const wanted = seed === undefined ? kept : new SearchQuery({ ...configOf(kept), search: seed });
  if (!getSearchQuery(view.state).eq(wanted)) view.dispatch({ effects: setSearchQuery.of(wanted) });
  const panel = livePanels.get(view);
  panel?.seekOnPage(true);
  panel?.focusFind();
}

// Every match selected and the editor focused, to type over all of them.
function selectAllMatches(view: EditorView): boolean {
  if (view.state.facet(findOnPage) || !selectMatches(view)) return false;
  view.focus();
  return true;
}

// On a page, CodeMirror's next, previous and reopen would act on the hidden
// editor, so these take their keys first there and pass them on elsewhere.
function stepOnPage(view: EditorView, backward: boolean): boolean {
  const panel = livePanels.get(view);
  if (!panel?.onPage()) return false;
  panel.step(backward);
  return true;
}

function refocusOnPage(view: EditorView): boolean {
  const panel = livePanels.get(view);
  if (!panel?.onPage()) return false;
  panel.focusFind();
  return true;
}

/** The find panel's own keys, ahead of CodeMirror's search keymap. Replace
 * opens from the editor too; the rest act while focus is in the card. */
export const FIND_KEYMAP: readonly KeyBinding[] = [
  { key: "Mod-h", mac: "Mod-Alt-f", run: openReplace, scope: "editor search-panel", preventDefault: true },
  { key: "Alt-c", run: (view) => toggleOption(view, "caseSensitive"), scope: "search-panel" },
  { key: "Alt-w", run: (view) => toggleOption(view, "wholeWord"), scope: "search-panel" },
  { key: "Alt-r", run: (view) => toggleOption(view, "regexp"), scope: "search-panel" },
  { key: "Alt-Enter", run: selectAllMatches, scope: "search-panel" },
  { key: "Mod-Alt-Enter", run: replaceAll, scope: "search-panel" },
  { key: "F3", run: (view) => stepOnPage(view, false), shift: (view) => stepOnPage(view, true), scope: "search-panel" },
  {
    key: "Mod-g",
    run: (view) => stepOnPage(view, false),
    shift: (view) => stepOnPage(view, true),
    scope: "search-panel",
  },
  { key: "Mod-f", run: refocusOnPage, scope: "search-panel" },
];

function createFindPanel(view: EditorView, frame: HTMLElement): FindPanel {
  let query = getSearchQuery(view.state);
  let matches: Match[] = [];
  let capped = false;
  let page: Finder | undefined;

  const card = createFindCard({
    find: (value) => commitQuery(view, { search: value }, true),
    replace: (value) => commitQuery(view, { replace: value }, false),
    toggle: (option) => toggleOption(view, option),
    step,
    close: () => closeSearchPanel(view),
    replaceOne: () => replaceNext(view),
    replaceAll: () => replaceAll(view),
    reveal() {
      const shown = !view.state.field(replaceShown, false);
      view.dispatch({ effects: setReplaceShown.of(shown) });
      if (shown) card.focusReplace();
      else if (card.dom.contains(document.activeElement)) card.findInput.focus();
    },
    key: (event) => runScopeHandlers(view, event, "search-panel"),
  });
  const { dom } = card;

  function recount(state: EditorState): void {
    matches = [];
    capped = false;
    if (!query.valid) return;
    const cursor = query.getCursor(state);
    for (let found = cursor.next(); !found.done; found = cursor.next()) {
      if (matches.length === COUNT_LIMIT) {
        capped = true;
        break;
      }
      matches.push({ from: found.value.from, to: found.value.to });
    }
  }

  // The match the selection is on, by binary search: matches never overlap,
  // so their starts are in order.
  function currentIndex(state: EditorState): number {
    const { from, to } = state.selection.main;
    let low = 0;
    let high = matches.length - 1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      const match = matches[middle];
      if (match.from < from) low = middle + 1;
      else if (match.from > from) high = middle - 1;
      else return match.to === to ? middle : -1;
    }
    return -1;
  }

  function drawCount(state: EditorState): void {
    card.drawCount(query, page ? page.count() : { total: matches.length, current: currentIndex(state), capped });
  }

  function drawReplace(state: EditorState): void {
    const editable = !state.readOnly;
    card.drawReplace(editable, editable && state.field(replaceShown, false) === true);
  }

  // CodeMirror's next and previous select all of Find when it has focus.
  // The caret goes back where it was, so a letter typed next adds on to the
  // query rather than replacing it.
  function keepCaret(run: () => void): void {
    const { selectionStart, selectionEnd } = card.findInput;
    run();
    if (document.activeElement === card.findInput) card.findInput.setSelectionRange(selectionStart, selectionEnd);
  }

  function step(backward: boolean): void {
    if (!page) {
      keepCaret(() => (backward ? findPrevious : findNext)(view));
      return;
    }
    page.step(backward);
    drawCount(view.state);
  }

  // The page's finder while a page shows; none while the editor does.
  function searchPage(root: HTMLElement | undefined): void {
    page?.dispose();
    page = root
      ? createPageFinder({ root, values: () => [root], card: () => dom, changed: () => drawCount(view.state) })
      : undefined;
    page?.search(query);
  }

  const panel: FindPanel = {
    dom,
    top: true,
    mount() {
      for (const leaving of frame.querySelectorAll(".find-card.is-closing")) leaving.remove();
    },
    update(update: ViewUpdate) {
      let queryChanged = false;
      for (const tr of update.transactions) {
        for (const effect of tr.effects) {
          if (effect.is(setSearchQuery) && !effect.value.eq(query)) {
            query = effect.value;
            queryChanged = true;
          }
        }
      }
      const root = update.state.facet(findOnPage);
      const surfaceChanged = root !== update.startState.facet(findOnPage);
      if (queryChanged) card.drawQuery(query);
      if (surfaceChanged) searchPage(root);
      else if (queryChanged) page?.search(query);
      if (!page && (queryChanged || surfaceChanged || update.docChanged)) recount(update.state);
      if (queryChanged || surfaceChanged || update.docChanged || update.selectionSet) drawCount(update.state);
      if (
        update.startState.readOnly !== update.state.readOnly ||
        update.startState.field(replaceShown, false) !== update.state.field(replaceShown, false)
      ) {
        drawReplace(update.state);
      }
    },
    // A transaction that closes the panel leaves it closed in the view's
    // state; a tab switch or a disposed pane takes the panel from a state
    // where it is still open, and the card goes at once.
    destroy() {
      if (livePanels.get(view) === panel) livePanels.delete(view);
      searchPage(undefined);
      if (!searchPanelOpen(view.state)) slideOut(dom, frame);
    },
    opened() {
      card.focusFind();
      slideIn(dom);
    },
    focusFind: () => card.focusFind(),
    focusReplace: () => card.focusReplace(),
    onPage: () => page !== undefined,
    step,
    seekOnPage(fromView) {
      if (fromView) page?.fromView();
      else page?.seek();
      drawCount(view.state);
    },
  };

  card.drawQuery(query);
  const root = view.state.facet(findOnPage);
  if (root) searchPage(root);
  else recount(view.state);
  drawCount(view.state);
  drawReplace(view.state);
  livePanels.set(view, panel);
  return panel;
}

// Slides the card in and puts the caret in Find when a transaction opens the
// panel. A tab switch restores a state with it open by no transaction, so
// its card neither slides nor takes focus.
const openOnTransaction = EditorView.updateListener.of((update) => {
  if (!searchPanelOpen(update.startState) && searchPanelOpen(update.state)) livePanels.get(update.view)?.opened();
});

/** CodeMirror's search with its panel drawn in `host`, which the editor's
 * group shows left of its toolbar. */
export function findPanel(host: HTMLElement): Extension {
  const frame = frameIn(host);
  return [
    search({ top: true, createPanel: (view) => createFindPanel(view, frame), scrollToMatch: revealMatch }),
    panels({ topContainer: frame }),
    replaceShown,
    openOnTransaction,
  ];
}
