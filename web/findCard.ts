// Find's card: the controls every surface that finds draws, whether it
// searches an editor's text (findPanel.ts), a page (pageFind.ts) or a PDF.
// The surface hands in what each control does and draws its state into the
// card, so the card looks and answers its keys the same everywhere.
import { SearchQuery } from "@codemirror/search";
import { currentPlatform, formatChord, normalizeChord } from "./services/keybindings.ts";

export type FindOption = "caseSensitive" | "wholeWord" | "regexp";

const ALL_OPTIONS: readonly FindOption[] = ["caseSensitive", "wholeWord", "regexp"];

export type QueryConfig = ConstructorParameters<typeof SearchQuery>[0];

export function configOf(query: SearchQuery): QueryConfig {
  const { search, caseSensitive, literal, regexp, replace, wholeWord, test } = query;
  return { search, caseSensitive, literal, regexp, replace, wholeWord, test };
}

/** The query as the card draws it; CodeMirror's SearchQuery is one. */
export interface FindQueryView {
  readonly search: string;
  readonly replace: string;
  readonly caseSensitive: boolean;
  readonly wholeWord: boolean;
  readonly regexp: boolean;
  readonly valid: boolean;
}

/** How many matches there are, more than that when `capped`, and which is
 * current: -1 for none. `pending` while a search still runs, so none found
 * yet isn't yet "No matches". */
export interface FindCount {
  readonly total: number;
  readonly current: number;
  readonly capped: boolean;
  readonly pending?: boolean;
}

/** The search a card drives where no editor holds the text: a page's, or a
 * PDF's, run in its own frame. */
export interface Finder {
  // Runs `query`, the current match kept where it was.
  search(query: SearchQuery): void;
  count(): FindCount;
  // The first match from the top of what shows becomes current.
  fromView(): void;
  // The same, when no match is current; either way it comes into view.
  seek(): void;
  step(backward: boolean): void;
  dispose(): void;
}

export interface FindCardActions {
  find(value: string): void;
  replace(value: string): void;
  toggle(option: FindOption): void;
  step(backward: boolean): void;
  close(): void;
  replaceOne(): void;
  replaceAll(): void;
  reveal(): void;
  // A key pressed in the card, offered before its own Enter: true when the
  // surface took it.
  key(event: KeyboardEvent): boolean;
}

export interface FindCard {
  readonly dom: HTMLElement;
  readonly findInput: HTMLInputElement;
  drawQuery(query: FindQueryView): void;
  drawCount(query: FindQueryView, count: FindCount): void;
  // Whether the text can change, and whether Replace's row shows.
  drawReplace(editable: boolean, shown: boolean): void;
  focusFind(): void;
  focusReplace(): void;
}

// Counting stops here, so a one-letter query in a long screenplay costs no
// more than a rare word; past it the count reads "9999+".
export const COUNT_LIMIT = 9_999;

const mac = currentPlatform() === "mac";
// ⌘H hides the app on macOS, so Replace takes ⌥⌘F there, the chord Mac
// editors give it.
const REPLACE_KEY = mac ? "Mod+Alt+F" : "Mod+H";

function keyLabel(chord: string): string {
  return formatChord(normalizeChord(chord, mac), mac);
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}

// A press keeps focus where it was, so the caret stays in Find. The
// tooltip names the button's key, as the status bar's do.
function button(className: string, label: string, chord: string): HTMLButtonElement {
  const node = element("button", className);
  node.type = "button";
  node.setAttribute("aria-label", label);
  node.dataset.tooltip = `${label} (${keyLabel(chord)})`;
  node.append(element("span", "find-card-glyph"));
  node.addEventListener("mousedown", (event) => event.preventDefault());
  return node;
}

function field(label: string): { box: HTMLDivElement; input: HTMLInputElement } {
  const box = element("div", "form-input find-card-field");
  const input = element("input", "find-card-input");
  input.type = "text";
  input.placeholder = label;
  input.spellcheck = false;
  input.autocomplete = "off";
  input.setAttribute("aria-label", label);
  box.append(input);
  return { box, input };
}

/** The card, with the option buttons `offered`: all three, unless the
 * search behind it can't honour one. */
export function createFindCard(actions: FindCardActions, offered: readonly FindOption[] = ALL_OPTIONS): FindCard {
  const dom = element("div", "floating-toolbar find-card");
  dom.setAttribute("role", "search");
  const reveal = element("button", "icon-button find-card-reveal");
  reveal.type = "button";
  reveal.append(element("span", "find-card-glyph"));
  reveal.addEventListener("mousedown", (event) => event.preventDefault());

  const find = field("Find");
  // How CodeMirror's open command finds the field to focus.
  find.input.setAttribute("main-field", "true");
  const all: Record<FindOption, HTMLButtonElement> = {
    caseSensitive: button("icon-button find-card-option find-card-case", "Match case", "Alt+C"),
    wholeWord: button("icon-button find-card-option find-card-word", "Match whole word", "Alt+W"),
    regexp: button("icon-button find-card-option find-card-regex", "Use regular expression", "Alt+R"),
  };
  find.box.append(...offered.map((option) => all[option]));

  const count = element("span", "find-card-count");
  const previous = button("icon-button find-card-previous", "Previous match", "Shift+Enter");
  const next = button("icon-button find-card-next", "Next match", "Enter");
  const close = button("icon-button find-card-close", "Close", "Escape");
  const line = element("span", "find-card-line");
  line.setAttribute("aria-hidden", "true");
  const findActions = element("div", "find-card-actions");
  findActions.append(count, previous, next, line, close);

  const replace = field("Replace");
  const replaceOne = button("icon-button find-card-replace", "Replace", "Enter");
  const replaceEvery = button("icon-button find-card-replace-all", "Replace all", "Mod+Alt+Enter");
  const replaceActions = element("div", "find-card-actions");
  replaceActions.append(replaceOne, replaceEvery);

  const rows = element("div", "find-card-rows");
  rows.append(find.box, findActions, replace.box, replaceActions);
  dom.append(reveal, rows);

  find.input.addEventListener("input", () => actions.find(find.input.value));
  replace.input.addEventListener("input", () => actions.replace(replace.input.value));
  for (const option of offered) all[option].addEventListener("click", () => actions.toggle(option));
  previous.addEventListener("click", () => actions.step(true));
  next.addEventListener("click", () => actions.step(false));
  close.addEventListener("click", () => actions.close());
  replaceOne.addEventListener("click", () => actions.replaceOne());
  replaceEvery.addEventListener("click", () => actions.replaceAll());
  reveal.addEventListener("click", () => actions.reveal());
  dom.addEventListener("keydown", (event) => {
    if (actions.key(event)) {
      event.preventDefault();
      return;
    }
    if (event.key !== "Enter" || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.target === find.input) {
      event.preventDefault();
      actions.step(event.shiftKey);
    } else if (event.target === replace.input && !event.shiftKey) {
      event.preventDefault();
      actions.replaceOne();
    }
  });

  return {
    dom,
    findInput: find.input,
    drawQuery(query) {
      if (find.input.value !== query.search) find.input.value = query.search;
      if (replace.input.value !== query.replace) replace.input.value = query.replace;
      for (const option of offered) all[option].setAttribute("aria-pressed", String(query[option]));
    },
    drawCount(query, { total, current, capped, pending }) {
      const waiting = pending === true && !total;
      if (query.search !== "" && !query.valid) count.textContent = "Invalid pattern";
      else if (waiting) count.textContent = "";
      else if (!total) count.textContent = "No matches";
      else count.textContent = `${current < 0 ? "?" : current + 1} of ${total}${capped ? "+" : ""}`;
      count.classList.toggle("is-empty", query.search === "");
      count.classList.toggle("is-missing", query.search !== "" && !total && !waiting);
      for (const control of [previous, next, replaceOne, replaceEvery]) control.disabled = !total;
    },
    drawReplace(editable, shown) {
      reveal.hidden = !editable;
      dom.classList.toggle("has-reveal", editable);
      reveal.setAttribute("aria-expanded", String(shown));
      const label = shown ? "Hide replace" : "Show replace";
      reveal.setAttribute("aria-label", label);
      reveal.dataset.tooltip = shown ? label : `${label} (${keyLabel(REPLACE_KEY)})`;
      replace.box.hidden = !shown;
      replaceActions.hidden = !shown;
    },
    focusFind() {
      find.input.focus();
      find.input.select();
    },
    focusReplace() {
      replace.input.focus();
      replace.input.select();
    },
  };
}

// The card slides down out of the group's top edge on opening and back up
// on closing. A closing card is lent to `frame` until its slide ends, inert
// so nothing reaches a card that is gone.
export function slideIn(dom: HTMLElement): void {
  dom.classList.add("is-opening");
  dom.addEventListener("animationend", () => dom.classList.remove("is-opening"), { once: true });
}

export function slideOut(dom: HTMLElement, frame: HTMLElement): void {
  dom.classList.remove("is-opening");
  dom.classList.add("is-closing");
  dom.inert = true;
  frame.append(dom);
  if (dom.getAnimations?.().length) dom.addEventListener("animationend", () => dom.remove(), { once: true });
  else dom.remove();
}

/** The part of the window `from` shows through: inside every box above it
 * that clips, and below the card where the card is over `span`. */
export function visibleArea(
  from: Element,
  card: Element | undefined,
  span: { left: number; right: number },
): { top: number; bottom: number; left: number; right: number } {
  let top = 0;
  let bottom = window.innerHeight;
  let left = 0;
  let right = window.innerWidth;
  for (let node: Element | null = from; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (style.overflowY === "visible" && style.overflowX === "visible") continue;
    const box = node.getBoundingClientRect();
    if (style.overflowY !== "visible") {
      top = Math.max(top, box.top);
      bottom = Math.min(bottom, box.bottom);
    }
    if (style.overflowX !== "visible") {
      left = Math.max(left, box.left);
      right = Math.min(right, box.right);
    }
  }
  const cardBox = card?.getBoundingClientRect();
  if (cardBox && span.left < cardBox.right && span.right > cardBox.left) top = Math.max(top, cardBox.bottom);
  return { top, bottom, left, right };
}

/** `text` to start a search with, as the editor starts one from its
 * selection: on one line and at most 100 characters. */
export function seedText(text: string | undefined): string | undefined {
  return text && text.length <= 100 && !/[\r\n]/.test(text) ? text : undefined;
}

// A letter key by the letter it types, or by its place where a modifier
// changes what it types, as ⌥C does on macOS.
function letterOf(event: KeyboardEvent): string {
  if (/^[a-z]$/i.test(event.key)) return event.key.toLowerCase();
  return event.code.startsWith("Key") ? event.code.slice(3).toLowerCase() : "";
}

const OPTION_KEYS: Record<string, FindOption> = { c: "caseSensitive", w: "wholeWord", r: "regexp" };

export interface PaneFind {
  // Where the card shows, which the pane hands the chrome as its aside.
  readonly host: HTMLElement;
  // Shows the card and the query kept for `key`, the file the pane now
  // shows: open again as it was left, without sliding in or taking focus.
  show(key: string | undefined): void;
  isOpen(): boolean;
  // Opens the card with Find holding `seed`, or the text the pane says is
  // selected, the first match from the top of what shows current.
  open(seed?: string): void;
  close(): void;
  dispose(): void;
}

export interface PaneFindOptions {
  // Makes the search the card drives while it is open.
  finder(card: () => HTMLElement | undefined, changed: () => void): Finder;
  // The text selected in the pane, to start a search with.
  selected?: () => string | undefined;
  // Where focus was when the card opened, given back on Escape.
  root?: HTMLElement;
  offered?: readonly FindOption[];
}

/** Find's card for a pane with no editor: the editor's card with the Find
 * row alone, driving whatever search the pane makes. */
export function createPaneFind(options: PaneFindOptions): PaneFind {
  const offered = options.offered ?? ALL_OPTIONS;
  const host = element("div", "find-card-host");
  const frame = element("div", "find-card-frame");
  host.append(frame);
  const kept = new Map<string, { open: boolean; query: SearchQuery }>();
  let key: string | undefined;
  let query = new SearchQuery({ search: "" });
  let shown: { card: FindCard; finder: Finder } | undefined;
  let returnFocus: HTMLElement | undefined;

  function drawCount(): void {
    shown?.card.drawCount(query, shown.finder.count());
  }

  function commit(change: Partial<QueryConfig>): void {
    const next = new SearchQuery({ ...configOf(query), ...change });
    if (next.eq(query)) return;
    query = next;
    if (!shown) return;
    shown.card.drawQuery(query);
    shown.finder.search(query);
    shown.finder.seek();
    drawCount();
  }

  function step(backward: boolean): void {
    shown?.finder.step(backward);
    drawCount();
  }

  function onKey(event: KeyboardEvent): boolean {
    const mod = mac ? event.metaKey : event.ctrlKey;
    const letter = letterOf(event);
    if (event.key === "Escape" && !mod && !event.altKey) {
      close();
      return true;
    }
    const option = OPTION_KEYS[letter];
    if (event.altKey && !mod && !event.shiftKey && option && offered.includes(option)) {
      commit({ [option]: !query[option] });
      return true;
    }
    if ((event.key === "F3" && !mod && !event.altKey) || (mod && !event.altKey && letter === "g")) {
      step(event.shiftKey);
      return true;
    }
    if (mod && !event.altKey && !event.shiftKey && letter === "f") {
      shown?.card.focusFind();
      return true;
    }
    return false;
  }

  function mount(): { card: FindCard; finder: Finder } {
    for (const leaving of frame.querySelectorAll(".find-card.is-closing")) leaving.remove();
    const card = createFindCard(
      {
        find: (value) => commit({ search: value }),
        replace: () => undefined,
        toggle: (option) => commit({ [option]: !query[option] }),
        step,
        close,
        replaceOne: () => undefined,
        replaceAll: () => undefined,
        reveal: () => undefined,
        key: onKey,
      },
      offered,
    );
    card.drawReplace(false, false);
    card.drawQuery(query);
    frame.append(card.dom);
    const finder = options.finder(() => card.dom, drawCount);
    shown = { card, finder };
    finder.search(query);
    drawCount();
    return shown;
  }

  function takeDown(slide: boolean): void {
    if (!shown) return;
    const { card, finder } = shown;
    shown = undefined;
    finder.dispose();
    const hadFocus = card.dom.contains(document.activeElement);
    if (slide) slideOut(card.dom, frame);
    else card.dom.remove();
    if (hadFocus && returnFocus?.isConnected) returnFocus.focus();
    returnFocus = undefined;
  }

  function close(): void {
    takeDown(true);
  }

  return {
    host,
    show(next) {
      if (next === key) return;
      if (key !== undefined) kept.set(key, { open: shown !== undefined, query });
      takeDown(false);
      key = next;
      const saved = next === undefined ? undefined : kept.get(next);
      query = saved?.query ?? new SearchQuery({ search: "" });
      if (saved?.open) mount();
    },
    isOpen: () => shown !== undefined,
    open(seed = options.selected?.()) {
      if (seed !== undefined) query = new SearchQuery({ ...configOf(query), search: seed });
      if (!shown) {
        const active = document.activeElement;
        const root = options.root;
        returnFocus = active instanceof HTMLElement && root?.contains(active) ? active : undefined;
        slideIn(mount().card.dom);
      } else {
        shown.card.drawQuery(query);
        shown.finder.search(query);
      }
      shown?.finder.fromView();
      drawCount();
      shown?.card.focusFind();
    },
    close,
    dispose() {
      takeDown(false);
      kept.clear();
      host.remove();
    },
  };
}
