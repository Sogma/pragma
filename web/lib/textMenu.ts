/// <reference types="vite/client" />

// The text menu: a right-click on text that selects (base.css's user-select
// rule) opens Cut, Copy, Paste and Select All where the text can be typed
// in, and Copy and Select All where it can only be read. It takes only a
// right-click nothing nearer has taken (the Console's), and never one on an
// image or media.
//
// A link, or a row that opens a card, puts its own menu above those items
// instead of taking the right-click, so text in it can still be copied.
//
// In the desktop app, a misspelled word's suggestions and Add to Dictionary
// come first, as a browser's menu puts them. In a browser, text it checks
// keeps the browser's own menu, the only one that can offer them, except on
// a link: only this one has the link's menu.
import { selectAll } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import type { Misspelling } from "../../src/protocol/api.ts";
import type { ContextMenuService, MenuItem } from "../services/menus.ts";
import { type Disposable, listen } from "./disposable.ts";

type Field = HTMLInputElement | HTMLTextAreaElement;

type Editable =
  | { kind: "editor"; view: EditorView; editable: boolean }
  | { kind: "field"; field: Field; editable: boolean };

type Surface = Editable | { kind: "text"; root: Element };

type Speller = Pick<NonNullable<Window["pragmaElectron"]>, "replaceMisspelling" | "addToDictionary">;

// The inputs that hold text; a checkbox or a slider gets no text menu.
const TEXT_INPUTS = new Set(["text", "search", "url", "tel", "email", "password", "number"]);

// The ones a browser checks the spelling of: never an address, a number or
// a password.
const CHECKED_INPUTS = new Set(["text", "search"]);

const MAX_SUGGESTIONS = 6;

/** A menu put above the text menu's items for one right-click: a link's
 * registered menu, or a row's own items. */
export interface TextMenuLead {
  menu?: string;
  items?: MenuItem[];
  arg?: unknown;
  ariaLabel: string;
}

const leads = new WeakMap<Event, TextMenuLead>();

/** Puts `lead` above the items of the menu this right-click opens, even
 * where the text doesn't select. The event must stay uncancelled: a
 * cancelled right-click opens nothing here. */
export function leadTextMenu(event: Event, lead: TextMenuLead): void {
  leads.set(event, lead);
}

// Anywhere else the browser's own menu shows only under `pragma dev`, for
// Inspect. The desktop app has no browser menu to hide, and its own process
// offers Inspect there when run from source (electron/main.ts), so the
// right-click is left to it.
//
// Text the desktop app spellchecks is left uncancelled too: Chromium names
// the word under the pointer only while drawing a menu of its own, and the
// question for it must go out now, during the right-click, to arrive first.
// In a browser, that text is left to the browser's menu outright.
export function installTextMenu(menu: Pick<ContextMenuService, "open">): Disposable {
  return listen(document, "contextmenu", (event) => {
    if (!(event instanceof MouseEvent) || event.defaultPrevented) return;
    const lead = leads.get(event);
    const surface = surfaceAt(event.target);
    const bridge = window.pragmaElectron;
    const checked = surface ? spellchecked(surface, event.target) : undefined;
    const show = (spelling: MenuItem[]) =>
      menu.open({
        items: [...spelling, ...(lead?.items ?? [])],
        menu: lead?.menu,
        arg: lead?.arg,
        itemsAfter: surface ? itemsFor(surface) : undefined,
        at: { x: event.clientX, y: event.clientY },
        ariaLabel: lead?.ariaLabel ?? "Text",
      });
    if (checked && bridge) {
      void bridge.misspellingAtMenu().then((misspelling) => show(spellingItems(checked, misspelling, bridge)));
    } else if (checked && !lead) {
      return;
    } else if (surface || lead) {
      event.preventDefault();
      show([]);
    } else if (!import.meta.env.DEV && !bridge) {
      event.preventDefault();
    }
  });
}

function elementAt(target: EventTarget | null): Element | null {
  return target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
}

// Chromium marks words only in text that can be typed in and is checked: a
// field or editor with spellcheck off, or a run in one marked unchecked, has
// no word to name.
function spellchecked(surface: Surface, target: EventTarget | null): Editable | undefined {
  if (surface.kind === "text" || !surface.editable) return undefined;
  const input = surface.kind === "field" && surface.field instanceof HTMLInputElement ? surface.field : undefined;
  if (input && !CHECKED_INPUTS.has(input.type)) return undefined;
  return elementAt(target)?.closest("[spellcheck]")?.getAttribute("spellcheck") === "false" ? undefined : surface;
}

function spellingItems(surface: Editable, misspelling: Misspelling | null, speller: Speller): MenuItem[] {
  if (!misspelling) return [];
  const replace = (word: string) => row(word, "replace-word", surface, () => void speller.replaceMisspelling(word));
  const add = () => void speller.addToDictionary(misspelling.word);
  const suggestions = misspelling.suggestions.slice(0, MAX_SUGGESTIONS).map(replace);
  const none = row("No suggestions", "replace-word", surface, () => undefined, true);
  return [
    ...(suggestions.length ? suggestions : [none]).map((item) => ({ ...item, group: "spelling" })),
    { ...row("Add to Dictionary", "add-word", surface, add), group: "dictionary" },
  ];
}

// What decides whether the target's text selects: `auto` defers to the
// parent, so the first ancestor with any other value answers. An engine
// that reports no user-select gets no text menu.
function selectingRoot(target: Element): Element | undefined {
  for (let node: Element | null = target; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    const value = style.userSelect || style.webkitUserSelect;
    if (!value || value === "none") return undefined;
    if (value !== "auto") return node;
  }
  return undefined;
}

function surfaceAt(target: EventTarget | null): Surface | undefined {
  const element = elementAt(target);
  if (!element || element.closest("img, video, audio, canvas, iframe")) return undefined;
  const root = selectingRoot(element);
  if (!root) return undefined;
  const field = element.closest("input, textarea");
  if (field instanceof HTMLTextAreaElement || (field instanceof HTMLInputElement && TEXT_INPUTS.has(field.type))) {
    return { kind: "field", field, editable: !field.readOnly && !field.disabled };
  }
  if (field) return undefined;
  const editor = element.closest(".cm-content")?.closest<HTMLElement>(".cm-editor");
  const view = editor ? EditorView.findFromDOM(editor) : null;
  if (view) return { kind: "editor", view, editable: view.state.facet(EditorView.editable) && !view.state.readOnly };
  return { kind: "text", root };
}

function selectedText(surface: Surface): string {
  if (surface.kind === "editor") {
    const { state } = surface.view;
    const text = state.selection.ranges
      .filter((range) => !range.empty)
      .map((range) => state.sliceDoc(range.from, range.to))
      .join(state.lineBreak);
    // What Mod+C copies: the editor's clipboard filters may reshape the text.
    return state.facet(EditorView.clipboardOutputFilter).reduce((out, filter) => filter(out, state), text);
  }
  if (surface.kind === "field") {
    const { field } = surface;
    const start = field.selectionStart;
    const end = field.selectionEnd;
    return start === null || end === null ? "" : field.value.slice(start, end);
  }
  // Another surface's selection is not this one's to copy.
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return "";
  return selection.getRangeAt(0).intersectsNode(surface.root) ? selection.toString() : "";
}

function itemsFor(surface: Surface): MenuItem[] {
  const text = selectedText(surface);
  const items: MenuItem[] = [];
  const editable = surface.kind !== "text" && surface.editable ? surface : undefined;
  if (editable) items.push(row("Cut", "cut", surface, () => cut(editable, text), !text));
  items.push(row("Copy", "copy", surface, () => void copy(text), !text));
  if (editable) items.push(row("Paste", "paste", surface, () => paste(editable)));
  // Opening this menu closes a menu the text sits in, a node menu's Info
  // value, taking the text off screen: Select All would select nothing.
  if (surface.kind === "text" && surface.root.closest('[role="menu"]')) return items;
  items.push({ ...row("Select All", "select-all", surface, () => selectEverything(surface)), group: "select" });
  return items;
}

// Each action first hands the surface its focus back as the surface takes
// it: the closing menu returns focus with a plain focus(), which on an
// editor's content puts the caret at the start and loses CodeMirror's
// selection, while view.focus() restores it.
function row(label: string, action: string, surface: Surface, run: () => void, unavailable = false): MenuItem {
  const act = () => {
    if (surface.kind === "editor") surface.view.focus();
    else if (surface.kind === "field") surface.field.focus();
    run();
  };
  return { label, group: "clipboard", icon: true, data: { textAction: action }, run: act, disabled: () => unavailable };
}

// A refused clipboard is swallowed, as the copy buttons do: only a
// permission-denied browser hits it, and Cut then keeps the text.
function copy(text: string): Promise<boolean> {
  return navigator.clipboard.writeText(text).then(
    () => true,
    () => false,
  );
}

// A field is edited through execCommand, not setRangeText: only an edit the
// browser makes itself lands in the field's own undo history and fires
// `input` as typing does.
function cut(surface: Editable, text: string): void {
  void copy(text).then((copied) => {
    if (!copied) return;
    if (surface.kind === "editor") {
      surface.view.dispatch(surface.view.state.replaceSelection(""), { userEvent: "delete.cut", scrollIntoView: true });
    } else {
      surface.field.focus();
      document.execCommand("delete");
    }
  });
}

function paste(surface: Editable): void {
  navigator.clipboard.readText().then(
    (text) => {
      if (surface.kind === "editor") {
        surface.view.dispatch(surface.view.state.replaceSelection(text), {
          userEvent: "input.paste",
          scrollIntoView: true,
        });
      } else {
        surface.field.focus();
        document.execCommand("insertText", false, text);
      }
    },
    () => undefined,
  );
}

function selectEverything(surface: Surface): void {
  if (surface.kind === "editor") selectAll(surface.view);
  else if (surface.kind === "field") surface.field.select();
  else {
    window.getSelection()?.selectAllChildren(surface.root);
  }
}
