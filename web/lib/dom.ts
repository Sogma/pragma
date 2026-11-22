import type { DocumentLock, VideoFormatResponse } from "../../src/protocol/api.ts";
import { formatAspectRatio } from "../../src/protocol/aspectRatio.ts";
import { DOCUMENT_FORMAT_MAJOR } from "../../src/protocol/types.ts";
import type { EntryIcon } from "../core/paths.ts";

// querySelector that throws instead of returning null. Every layout element the
// app wires up is present in web/index.html, so a miss is a build-time bug that
// should fail loudly at boot rather than surface as a downstream null.
export function must<E extends Element>(selector: string, root: ParentNode = document): E {
  const found = root.querySelector<E>(selector);
  if (!found) throw new Error(`element not found: ${selector}`);
  return found;
}

/** An element of `tag` with its class name and its text, each when given. */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** The muted line a tree shows where rows are still being listed. */
export function renderTreeLoading(tag: "p" | "li"): HTMLElement {
  const line = document.createElement(tag);
  line.className = "tree-loading";
  line.textContent = "Loading…";
  return line;
}

/** Marks `element` as the icon of an entry, which web/styles/entry-icons.css
 * paints from these attributes alone; the surface only sizes and spaces it.
 * No glyph leaves it bare. */
export function setEntryIcon(element: HTMLElement, icon: EntryIcon): void {
  if (icon.glyph) element.dataset.entryIcon = icon.glyph;
  else delete element.dataset.entryIcon;
  element.toggleAttribute("data-scope", icon.scope === true);
}

/** An entry's icon as an element of its own, for a surface that takes one. */
export function createEntryIcon(icon: EntryIcon): HTMLSpanElement {
  const element = document.createElement("span");
  setEntryIcon(element, icon);
  return element;
}

/** A tree row's leading glyph. A real element, not the label's ::before,
 * because only an element can carry its own tooltip — and keeping the
 * tooltip on the glyph keeps it from firing on every row the pointer
 * crosses. */
export function renderTreeIcon(icon: EntryIcon, title: string | undefined): HTMLSpanElement {
  const element = document.createElement("span");
  element.className = "node-icon";
  setEntryIcon(element, icon);
  if (title) element.dataset.tooltip = title;
  return element;
}

// A byte count for a Size row: one decimal below 10 of a unit, none above.
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unitIndex]}`;
}

/** A media duration the way a player writes one: m:ss, growing to h:mm:ss
 * past the hour. Seconds are floored rather than rounded, so a clip never
 * reports a length it has not reached. A duration a browser cannot work out
 * yet arrives as NaN or Infinity, which reads Unknown, not a crash. */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "Unknown";
  const whole = Math.floor(seconds);
  const pad = (value: number) => String(value).padStart(2, "0");
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(whole % 60)}` : `${minutes}:${pad(whole % 60)}`;
}

/** `23.976 fps`, `25 fps`; a variable rate is its average, to a tenth. */
export function formatFrameRate({ frameRate, variableFrameRate }: VideoFormatResponse): string | undefined {
  if (frameRate === null) return undefined;
  const rounded = Number(frameRate.toFixed(variableFrameRate ? 1 : 3));
  return variableFrameRate ? `${rounded} fps (variable)` : `${rounded} fps`;
}

/** Pixel dimensions with their aspect ratio: `1080 × 1920px (9:16)`, or
 * `1080 × 1920 (9:16)` with an empty `unit`. */
export function formatDimensions(width: number, height: number, unit = "px"): string {
  const size = `${width} × ${height}${unit}`;
  return width > 0 && height > 0 ? `${size} (${formatAspectRatio(width, height)})` : size;
}

// The reading view's frontmatter row shape and CSS classes, so every pane's
// Info-tab section reads as one convention. Returns the value span so a
// caller can fill it once an async lookup resolves, keeping row order fixed
// rather than in whatever order the lookups finish.
export function appendMetaRow(container: HTMLElement, key: string, value: string): HTMLElement {
  const row = document.createElement("div");
  row.className = "meta-row";
  const keyEl = document.createElement("span");
  keyEl.className = "meta-key";
  keyEl.textContent = key;
  const valueEl = document.createElement("span");
  valueEl.className = "meta-value";
  valueEl.textContent = value;
  row.append(keyEl, valueEl);
  container.appendChild(row);
  return valueEl;
}

/** A meta row for an opaque value, such as a digest, held to one
 * line and cut with an ellipsis, like a tree name. The full value is a
 * tooltip only while it is actually cut off. */
export function appendCodeRow(container: HTMLElement, key: string, value: string): HTMLElement {
  const valueEl = appendMetaRow(container, key, value);
  valueEl.classList.add("meta-code");
  valueEl.dataset.tooltipOverflow = "";
  return valueEl;
}

/** A block in the assistant's Info tab, under `title` when one is given.
 * Every pane that supplies one builds it here, so they share one heading
 * style and one hidden-when-empty convention: the section starts hidden, and
 * its owner shows it. */
export function createInspectorSection(title?: string): { section: HTMLElement; body: HTMLElement } {
  const section = document.createElement("section");
  section.className = "inspector-section";
  section.hidden = true;
  if (title !== undefined) {
    const heading = document.createElement("div");
    heading.className = "section-label inspector-section-title";
    heading.textContent = title;
    section.append(heading);
  }
  const body = document.createElement("div");
  section.append(body);
  return { section, body };
}

/** A title bar (web/styles/editor.css): the top of a document, holding its
 * title in a field its owner fills, places, and makes read-only or not. */
export function createTitleBar(): { bar: HTMLDivElement; input: HTMLInputElement } {
  const bar = document.createElement("div");
  bar.className = "editor-title-bar";
  const inner = document.createElement("div");
  inner.className = "editor-title-inner";
  const input = document.createElement("input");
  input.type = "text";
  input.className = "editor-title-input";
  input.setAttribute("aria-label", "Document title");
  inner.append(input);
  bar.append(inner);
  return { bar, input };
}

const RUN_COUNT_SPINNER =
  '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9" stroke-dasharray="42 14" /></svg>';

/** How many runs of a Flow are going, beside its Run on the toolbar and in
 * App Mode, which stays clickable meanwhile; a click shows them. Hidden while
 * none is. */
export function buildRunCount(show: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "toolbar-action flow-run-count";
  button.dataset.tooltip = "Show the runs in the Tools tab";
  button.innerHTML = `${RUN_COUNT_SPINNER}<span></span>`;
  button.addEventListener("click", show);
  setRunCount(button, 0);
  return button;
}

export function setRunCount(button: HTMLButtonElement, count: number): void {
  button.hidden = count === 0;
  (button.lastElementChild as HTMLElement).textContent = `${count} running`;
}

export function buildTableRowDeleteButton(onClick: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "icon-button data-table-row-delete";
  button.setAttribute("aria-label", "Delete entry");
  const icon = document.createElement("span");
  icon.className = "data-table-row-delete-icon";
  button.appendChild(icon);
  button.addEventListener("click", onClick);
  return button;
}

/** A Settings list row that opens its item's subpage: the whole row is the
 * button, ending in a chevron. `item` is the item's id, which outlives the
 * row, so Settings can find it again after the list is rebuilt. */
export function buildOpenRow(item: string, content: Node[], onOpen: () => void): HTMLButtonElement {
  const row = document.createElement("button");
  row.type = "button";
  row.className = "list-item settings-open-row";
  row.dataset.settingsItem = item;
  const chevron = document.createElement("span");
  chevron.className = "settings-open-row-chevron";
  chevron.setAttribute("aria-hidden", "true");
  row.append(...content, chevron);
  row.addEventListener("click", onOpen);
  return row;
}

/** Swaps a Settings list's rows for `rows`. Removing the focused row drops
 * focus to the page, so it moves to the new row for the same item, or to the
 * row now in its place when that item is gone. */
export function replaceRows(list: HTMLElement, rows: HTMLElement[]): void {
  const focused = document.activeElement;
  if (!(focused instanceof HTMLElement) || focused.parentElement !== list) {
    list.replaceChildren(...rows);
    return;
  }
  const index = Array.from(list.children).indexOf(focused);
  const item = focused.dataset.settingsItem;
  list.replaceChildren(...rows);
  const same = rows.find((row) => item !== undefined && row.dataset.settingsItem === item);
  (same ?? rows[Math.min(index, rows.length - 1)])?.focus({ preventScroll: true });
}

// A token row's trash can, under the word a token takes: a revoked token
// stops working, which "Remove" would undersell. The accessible name adds
// the token's own, since a screen reader lists every row's button together.
export function buildRevokeButton(name: string, onClick: () => void): HTMLButtonElement {
  return buildGlyphButton("btn btn-icon btn-icon-remove danger", "Revoke", name, onClick);
}

// The same trash can for a row with nothing else on it to open, such as a
// word added to the dictionary.
export function buildRemoveButton(name: string, onClick: () => void): HTMLButtonElement {
  return buildGlyphButton("btn btn-icon btn-icon-remove danger", "Remove", name, onClick);
}

function buildGlyphButton(className: string, word: string, name: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.dataset.tooltip = word;
  button.setAttribute("aria-label", `${word} ${name}`);
  const glyph = document.createElement("span");
  glyph.className = "btn-icon-glyph";
  glyph.setAttribute("aria-hidden", "true");
  button.appendChild(glyph);
  button.addEventListener("click", onClick);
  return button;
}

// An icon-only copy button that shows `.copied` (a checkmark) briefly on
// success. `text` is read at click time, so the button can exist before
// there's anything to copy. A refused clipboard is swallowed: a user only
// hits it in a permission-denied browser, not worth its own error state.
export function buildCopyButton(className: string, text: () => string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `icon-button ${className}`;
  button.setAttribute("aria-label", "Copy to clipboard");
  const icon = document.createElement("span");
  icon.className = "copy-button-icon";
  button.appendChild(icon);
  let resetTimer = 0;
  button.addEventListener("click", () => {
    navigator.clipboard
      .writeText(text())
      .then(() => {
        button.classList.add("copied");
        button.dataset.tooltip = "Copied";
        window.clearTimeout(resetTimer);
        resetTimer = window.setTimeout(() => {
          button.classList.remove("copied");
          delete button.dataset.tooltip;
        }, 1200);
      })
      .catch(() => undefined);
  });
  return button;
}

// Wraps each code block markdownRender.ts renders (reading view, chat
// replies) in a `.code-block` positioning context with a copy button in its
// corner — done here so that module stays a pure renderer with no clipboard
// wiring. The wrapper, not the `<pre>`, carries the button so it stays put
// when a wide block scrolls horizontally.
export function addCodeBlockCopyButtons(root: ParentNode): void {
  for (const pre of [...root.querySelectorAll("pre")]) {
    const wrapper = document.createElement("div");
    wrapper.className = "code-block";
    pre.replaceWith(wrapper);
    wrapper.appendChild(pre);
    wrapper.appendChild(buildCopyButton("code-copy", () => (pre.querySelector("code") ?? pre).textContent ?? ""));
  }
}

// The banner a Table or Class pane shows when its file is locked
// against saving. One helper, because the two panes lock for exactly the
// same reasons and should say exactly the same thing.
export function buildLockNotice(lock: DocumentLock, version: string): HTMLElement {
  const notice = document.createElement("div");
  notice.className = "document-locked-notice inline-warning";
  notice.textContent = lockMessage(lock, version);
  return notice;
}

// The Flow pane builds its notice up front, before any file is open
// (flowElements.ts), so it fills the text in on render instead.
export function lockMessage(lock: DocumentLock, version: string): string {
  if (lock === "unreadable") {
    return "This file's markup couldn't be read, so it's shown read-only: saving it here would erase it. Fix it in a text editor, then reopen it.";
  }
  return `This document uses ${formatVersionPhrase(version)}, so it's shown read-only: saving it here would drop anything this build can't read.`;
}

// Names both sides the way the file and the check state them: the
// document's `data-format-version` verbatim, so it matches the root element,
// and this build's side as a major (`1.x`), since majors are all the guard
// compares. Never phrased as a *pragma* version — a file carries a format
// version, and another implementation may have written it.
export function formatVersionPhrase(version: string): string {
  return `Pragma document format ${version}. This build writes ${DOCUMENT_FORMAT_MAJOR}.x`;
}

// Swallows a file dropped anywhere that isn't a drop target of pragma's own:
// the browser's default navigates to the file, replacing the whole app and
// every unsaved buffer, and an image aimed at a note is easy to miss.
// Registered on the window, so these run only after a real target has handled
// and cancelled the event: this can catch a miss and nothing else.
export function ignoreStrayFileDrops(): void {
  window.addEventListener("dragover", (event) => event.preventDefault());
  window.addEventListener("drop", (event) => event.preventDefault());
}

// How far a press on a link-like button may travel and still open it.
const LINK_PRESS_TRAVEL_PX = 4;

/** A button that opens something, in text that selects, pressed as a link
 * is: a press opens it and starts no selection, though one started beside
 * the button takes its text in. A press dragged away opens nothing: Firefox
 * still sends its click to text nested in the button, wherever it was let
 * go. A keyboard's click has no press to have travelled. */
export function onLinkClick(button: HTMLElement, open: () => void): void {
  let pressedAt: { x: number; y: number } | undefined;
  button.addEventListener("pointerdown", (event) => {
    pressedAt = { x: event.clientX, y: event.clientY };
  });
  button.addEventListener("selectstart", (event) => event.preventDefault());
  button.addEventListener("click", (event) => {
    const travel = pressedAt ? Math.hypot(event.clientX - pressedAt.x, event.clientY - pressedAt.y) : 0;
    if (event.detail > 0 && travel >= LINK_PRESS_TRAVEL_PX) return;
    open();
  });
}

const TYPED_INPUT_TYPES = new Set(["text", "search", "url", "email", "tel", "password", "number"]);

/** Whether an element takes typed text, and so its own Undo and Delete. A
 * checkbox, a select or a button takes neither. */
export function takesTyping(element: Element): boolean {
  if (element instanceof HTMLInputElement) return TYPED_INPUT_TYPES.has(element.type);
  return (
    element instanceof HTMLTextAreaElement || element.closest('[contenteditable=""], [contenteditable="true"]') !== null
  );
}

const ARROW_NAMES: Record<string, string> = { "←": "Left", "→": "Right", "↑": "Up", "↓": "Down" };

/** A shortcut's label with each arrow key drawn as its icon. The label is
 * text first — the arrows are characters a title or a search box shows as
 * they are — and only here, where markup can hold an icon, do they become one. */
export function keyLabel(text: string): HTMLElement {
  const label = document.createElement("span");
  label.className = "key-label";
  for (const piece of text.split(/([←→↑↓])/)) {
    const name = ARROW_NAMES[piece];
    if (!name) {
      if (piece) label.append(piece);
      continue;
    }
    const arrow = document.createElement("span");
    arrow.className = `key-arrow key-arrow-${name.toLowerCase()}`;
    arrow.setAttribute("role", "img");
    arrow.setAttribute("aria-label", `${name} arrow`);
    label.append(arrow);
  }
  return label;
}
