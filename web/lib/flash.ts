// The mark an action leaves on an item it reveals in an unexpected place
// (architecture.md, Feedback and interaction). An element takes the class; editor
// text takes a decoration carrying it, since the editor draws its own lines.
// The look, its hold and its fade are all in utilities.css.
import { type EditorState, StateEffect } from "@codemirror/state";
import { Decoration, type DecorationSet, type EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";

// When the class comes off: the stylesheet's hold plus its fade. Shorter
// cuts the fade short.
const FLASH_MS = 1200;

const pending = new WeakMap<Element, number>();

export function flash(element: HTMLElement): void {
  window.clearTimeout(pending.get(element));
  // The animation restarts only if the class comes off across a reflow.
  element.classList.remove("flash");
  void element.offsetWidth;
  element.classList.add("flash");
  pending.set(
    element,
    window.setTimeout(() => {
      element.classList.remove("flash");
      pending.delete(element);
    }, FLASH_MS),
  );
}

// Takes the mark off before its fade is over, for an element that has
// stopped showing what was revealed.
export function unflash(element: HTMLElement): void {
  window.clearTimeout(pending.get(element));
  pending.delete(element);
  element.classList.remove("flash");
}

interface FlashedRange {
  from: number;
  to: number;
}

const setFlash = StateEffect.define<FlashedRange | null>();

// Flashes the text from `from` to `to`, or the line at `from` when the range
// is empty. Dispatched with the reveal it marks; the view needs editorFlash.
export function flashRange(from: number, to: number): StateEffect<FlashedRange | null> {
  return setFlash.of({ from, to });
}

let serial = 0;

// A fresh decoration each time: one equal to the last keeps its DOM, and with
// it an animation that has already run.
function decorate(state: EditorState, { from, to }: FlashedRange): DecorationSet {
  const spec = { class: "flash", attributes: { "data-flash": String(++serial) } };
  if (from < to) return Decoration.set(Decoration.mark(spec).range(from, to));
  return Decoration.set(Decoration.line(spec).range(state.doc.lineAt(from).from));
}

// A plugin, not a state field: a tab's editor state is cached and restored,
// and a mark kept in it would flash again when the tab comes back.
export const editorFlash = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet = Decoration.none;
    timer: number | undefined;

    constructor(readonly view: EditorView) {}

    update(update: ViewUpdate): void {
      this.decorations = this.decorations.map(update.changes);
      for (const tr of update.transactions) {
        for (const effect of tr.effects) {
          if (!effect.is(setFlash)) continue;
          window.clearTimeout(this.timer);
          this.decorations = effect.value ? decorate(update.state, effect.value) : Decoration.none;
          if (effect.value) {
            this.timer = window.setTimeout(() => this.view.dispatch({ effects: setFlash.of(null) }), FLASH_MS);
          }
        }
      }
    }

    destroy(): void {
      window.clearTimeout(this.timer);
    }
  },
  { decorations: (plugin) => plugin.decorations },
);
