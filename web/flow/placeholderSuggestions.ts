// The suggester for text a Flow's run fills: once `{{` is typed, the
// placeholders that box's run fills, each with what it gives now or where
// its value comes from, and in a Prompt whose text reaches a Generate node,
// once `@` is, the image pins wired there. A box offers only what its run
// fills, so nothing picked is left standing as written.
//
// A text box and a Prompt's editor share the list and its keys; only how
// each reads the text before its caret and writes a pick differs.

import { Prec } from "@codemirror/state";
import { type EditorView, keymap, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { DATE_OFFERS, fillDates, readClock } from "../../src/protocol/datePlaceholders.ts";
import {
  FLOW_NODE_REGISTRY,
  IMAGE_REFERENCE_SLOTS,
  IMAGE_REFERENCES_MAX,
  TEMPLATE_VARIABLE_SLOTS,
  TEMPLATE_VARIABLES_MAX,
} from "../../src/protocol/flowNodes.ts";
import type { FlowGraph } from "../../src/protocol/types.ts";
import { createSuggestionList, type SuggestionAnchor, type SuggestionRow } from "../lib/suggestionList.ts";

/** What a pick writes, and the line beside it in the list. */
export interface PlaceholderChoice {
  text: string;
  detail: string;
}

/** The date placeholders, each beside what it gives at `now`. */
export function dateChoices(now: Date): PlaceholderChoice[] {
  const reading = readClock(now);
  return DATE_OFFERS.map((text) => ({ text, detail: fillDates(text, reading) }));
}

/** What a Prompt's text offers after `{{`: the named, wired slots of each
 * Template Variables it is the source of, then the dates. */
export function promptChoices(graph: FlowGraph, nodeId: string, now: Date): PlaceholderChoice[] {
  const names: string[] = [];
  for (const edge of graph.edges) {
    if (edge.source !== nodeId || edge.targetPort !== "source") continue;
    const target = graph.nodes.find((node) => node.id === edge.target);
    if (target?.type !== "templateVariables") continue;
    for (let slot = 1; slot <= TEMPLATE_VARIABLES_MAX; slot++) {
      const named = target.config[TEMPLATE_VARIABLE_SLOTS.configKey?.(slot) ?? ""];
      const name = typeof named === "string" ? named.trim() : "";
      const port = TEMPLATE_VARIABLE_SLOTS.portId(slot);
      const wired = graph.edges.some((other) => other.target === target.id && other.targetPort === port);
      if (name && wired && !names.includes(name)) names.push(name);
    }
  }
  const slots = names.map((name) => ({ text: `{{${name}}}`, detail: "From Template Variables" }));
  return [...slots, ...dateChoices(now)];
}

/** What a Prompt's text offers after `@`: the image pins wired into each
 * Generate node it reaches, straight or through a Template Variables. */
export function promptPins(graph: FlowGraph, nodeId: string): PlaceholderChoice[] {
  const pins: PlaceholderChoice[] = [];
  const reach = (from: string, visited: Set<string>): void => {
    for (const edge of graph.edges) {
      if (edge.source !== from || edge.sourcePort !== "text" || visited.has(edge.target)) continue;
      const target = graph.nodes.find((node) => node.id === edge.target);
      if (!target) continue;
      if (target.type === "templateVariables" && edge.targetPort === "source") {
        reach(target.id, new Set([...visited, target.id]));
        continue;
      }
      const definition = FLOW_NODE_REGISTRY[target.type];
      if (!definition?.referenceSlots || (edge.targetPort !== "instruction" && edge.targetPort !== "prompt")) continue;
      for (let pin = 1; pin <= IMAGE_REFERENCES_MAX; pin++) {
        const port = IMAGE_REFERENCE_SLOTS.portId(pin);
        const text = `@${port}`;
        const wired = graph.edges.some((other) => other.target === target.id && other.targetPort === port);
        if (wired && !pins.some((choice) => choice.text === text)) {
          pins.push({ text, detail: `Wired into ${definition.label}` });
        }
      }
    }
  };
  reach(nodeId, new Set([nodeId]));
  return pins;
}

/** The placeholder the text before the caret begins: where its `{{` sits,
 * and what follows it; undefined while none is open. */
export function openPlaceholder(before: string): { start: number; typed: string } | undefined {
  const match = /\{\{([^{}\n]*)$/.exec(before);
  return match ? { start: match.index, typed: match[1] } : undefined;
}

/** The choices holding what's typed after the opener, case aside: those it
 * begins first, each group in the order given. A host's value is matched by
 * its name after the `$`, and once a `$` is typed only those are offered. */
export function matchingChoices(
  choices: readonly PlaceholderChoice[],
  typed: string,
  opener = "{{",
): PlaceholderChoice[] {
  const marked = typed.startsWith("$");
  const query = (marked ? typed.slice(1) : typed).toLowerCase();
  const ranked = choices.flatMap((choice) => {
    const written = choice.text.slice(opener.length);
    if (marked && !written.startsWith("$")) return [];
    const at = written.replace(/^\$/, "").toLowerCase().indexOf(query);
    return at === -1 ? [] : [{ choice, rank: at === 0 ? 0 : 1 }];
  });
  return ranked.sort((a, b) => a.rank - b.rank).map(({ choice }) => choice);
}

interface Begun {
  start: number;
  matches: PlaceholderChoice[];
}

interface Suggester {
  // Shows what the text before the caret begins, or closes.
  refresh(before: string): void;
  // Takes a key while the list is open; whether it did.
  key(key: string): boolean;
  close(): void;
}

// The list and its keys, for a field whose text and writes are the
// caller's: `begun` reads what the text before the caret starts, and
// `write` puts a pick in place of it, from `start` to the caret.
function createSuggester(
  field: HTMLElement,
  begun: (before: string) => Begun | undefined,
  write: (start: number, text: string) => void,
  anchor?: () => SuggestionAnchor,
): Suggester {
  let current: Begun | undefined;
  const list = createSuggestionList(field, {
    id: "placeholder-suggestions",
    label: "Placeholders",
    className: "placeholder-suggestions",
    onClose: () => {
      current = undefined;
    },
    anchor,
  });

  function row(choice: PlaceholderChoice): SuggestionRow {
    return {
      fill: (element) => {
        const text = document.createElement("span");
        text.className = "placeholder-suggestion-text";
        text.textContent = choice.text;
        const detail = document.createElement("span");
        detail.className = "context-menu-detail";
        detail.textContent = choice.detail;
        element.append(text, detail);
      },
      pick: () => pick(choice),
    };
  }

  function pick(choice: PlaceholderChoice): void {
    const start = current?.start;
    list.close();
    if (start !== undefined) write(start, choice.text);
  }

  return {
    refresh: (before) => {
      current = begun(before);
      if (!current || current.matches.length === 0) list.close();
      else list.show(current.matches.map(row), 0);
    },
    key: (key) => {
      const matches = current?.matches ?? [];
      if (!list.isOpen() || matches.length === 0) return false;
      if (key === "ArrowDown" || key === "ArrowUp") {
        list.highlight((list.active() + (key === "ArrowDown" ? 1 : -1) + matches.length) % matches.length);
      } else if (key === "Enter" || key === "Tab") {
        pick(matches[Math.max(0, list.active())]);
      } else if (key === "Escape") {
        list.close();
      } else {
        return false;
      }
      return true;
    },
    close: list.close,
  };
}

function placeholderBegun(before: string, choices: readonly PlaceholderChoice[]): Begun | undefined {
  const open = openPlaceholder(before);
  return open && { start: open.start, matches: matchingChoices(choices, open.typed) };
}

/** Offers `choices` in a text box once `{{` is typed. A pick goes in through
 * the box's own input handler, as typing would. */
export function attachPlaceholderSuggestions(
  field: HTMLInputElement | HTMLTextAreaElement,
  choices: () => readonly PlaceholderChoice[],
): void {
  const suggester = createSuggester(
    field,
    (before) => placeholderBegun(before, choices()),
    (start, text) => {
      field.setRangeText(text, start, field.selectionStart ?? field.value.length, "end");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    },
  );
  field.addEventListener("input", () => {
    const caret = field.selectionStart ?? field.value.length;
    suggester.refresh(field.selectionEnd === caret ? field.value.slice(0, caret) : "");
  });
  field.addEventListener("blur", suggester.close);
  field.addEventListener("keydown", (event) => {
    if (!(event instanceof KeyboardEvent) || event.isComposing || !suggester.key(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
  });
}

// The caret's own box, where the editor can draw one.
function caretAnchor(view: EditorView): SuggestionAnchor {
  try {
    const coords = view.coordsAtPos(view.state.selection.main.head);
    if (coords) return coords;
  } catch {
    // A view not laid out yet has no caret box; its own box stands in.
  }
  return view.contentDOM.getBoundingClientRect();
}

/** A Prompt editor's suggester: `choices` once `{{` is typed, and once `@`
 * is, `pins`. Only typing opens it, so moving the caret into a placeholder
 * already written doesn't. */
export function promptSuggestions(
  choices: () => readonly PlaceholderChoice[],
  pins: () => readonly PlaceholderChoice[],
) {
  const plugin = ViewPlugin.fromClass(
    class {
      lineFrom = 0;
      suggester: Suggester;
      constructor(view: EditorView) {
        this.suggester = createSuggester(
          view.contentDOM,
          (before) => {
            const mention = /@(\w*)$/.exec(before);
            if (!mention) return placeholderBegun(before, choices());
            return { start: mention.index, matches: matchingChoices(pins(), mention[1], "@") };
          },
          (start, text) => {
            const from = this.lineFrom + start;
            const to = view.state.selection.main.head;
            view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length } });
          },
          () => caretAnchor(view),
        );
      }
      update(update: ViewUpdate): void {
        const selection = update.state.selection.main;
        if (!update.view.hasFocus || !selection.empty || (update.selectionSet && !update.docChanged)) {
          if (update.focusChanged || update.selectionSet || update.docChanged) this.suggester.close();
          return;
        }
        if (!update.docChanged) return;
        const line = update.state.doc.lineAt(selection.head);
        const before = line.text.slice(0, selection.head - line.from);
        this.lineFrom = line.from;
        // Drawn once the update is over: the list hangs from the caret's box,
        // and CodeMirror refuses a layout read during an update.
        queueMicrotask(() => {
          if (update.view.hasFocus) this.suggester.refresh(before);
        });
      }
      destroy(): void {
        this.suggester.close();
      }
    },
  );
  const keys = ["ArrowDown", "ArrowUp", "Enter", "Tab", "Escape"].map((key) => ({
    key,
    run: (view: EditorView) => view.plugin(plugin)?.suggester.key(key) ?? false,
  }));
  return [plugin, Prec.highest(keymap.of(keys))];
}
