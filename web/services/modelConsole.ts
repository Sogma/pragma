// The Console's entries, each written once its outcome is known, and the
// status bar's activity glyph, lit while a generate call from this page is in
// flight.
import type { EffortLevel } from "../../src/protocol/api.ts";
import type { SetupNeed } from "../../src/protocol/setupNeed.ts";
import { effortName } from "../lib/effort.ts";
import { flash } from "../lib/flash.ts";
import { settingLinks } from "../lib/settingLink.ts";

// How important/severe a settled entry is — orthogonal to *kind* (what
// produced it: LLM vs HTTP). Two axes, never merged into one flat "type".
// No "pending" state: an entry is written once, after the
// outcome is already known, never created early and mutated in place — a
// call that's still in flight simply hasn't logged anything yet.
export type ConsoleEntryLevel = "info" | "warn" | "error";

// `context` is what a generation sent as context, as lines, and `warn` that
// some of it fell short, which marks the entry as a warning; `prompt` the
// prompt a caller that keeps one logs, as Find in context does; `effort` the
// level the model ran at.
export type LlmCallOutcome =
  | {
      failed: false;
      model: string;
      effort?: EffortLevel;
      context?: readonly string[];
      warn?: boolean;
      prompt?: string;
      options: string[];
    }
  | { failed: true; message: string; need?: SetupNeed };

export interface ModelConsoleElements {
  consoleEntries: HTMLElement;
  activityIndicator: HTMLElement;
}

export interface ConsoleEntry {
  /** Scrolls the Console to the entry and flashes it; false once Clear has
   * removed it. */
  reveal(): boolean;
  /** Whether it's still in the Console, which Clear empties. */
  kept(): boolean;
}

/** A failed model call as the Console writes it: why it failed. */
export function failedCallEntry(label: string, failure: { message: string; need?: SetupNeed }) {
  return { kind: "LLM", label, content: failure.message, need: failure.need };
}

/** An entry as the clipboard takes it: a header line, then the content. */
export interface ConsoleEntryText {
  element: HTMLElement;
  text: string;
}

export interface ModelConsole {
  // Writes one complete entry — level, kind, label, content, in that
  // display order — the moment the outcome is known: every Flow's text
  // generation, and Find in context's call.
  logLlmCall(label: string, outcome: LlmCallOutcome): void;
  // Low-level escape hatch for a kind with no dedicated outcome formatter:
  // the caller's fully formed entry is written through unchanged. The
  // activity feed uses it, since the server has already decided how a
  // headless Flow run or an agent's request should read.
  logEntry(level: ConsoleEntryLevel, kind: string, label: string, content: string, need?: SetupNeed): ConsoleEntry;
  // The status-bar indicator, lit around each model call a Flow makes and
  // named by the model the call asks for, "" for the default.
  beginLlmActivity(model: string): void;
  endLlmActivity(model: string): void;
  // The entry `target` sits in, for the Console's right-click Copy; undefined
  // off an entry (the welcome line, the empty space below).
  entryAt(target: Node): ConsoleEntryText | undefined;
  // Every entry still shown, in order, a blank line between them.
  allText(): string;
  // Empties the Console, the welcome line with it.
  clear(): void;
}

const DEFAULT_LLM_ACTIVITY_TITLE = "Working on a model request…";

// The one DOM-writing primitive every kind funnels through — level, kind,
// label, content, in that display order (level first: it's the most
// important thing to scan for, surfaced as the entry's left-border color
// rather than buried in the content text). Appends a finished entry;
// there's nothing to come back and mutate later.
function writeEntry(
  consoleEntries: HTMLElement,
  level: ConsoleEntryLevel,
  kind: string,
  label: string,
  content: string,
  need?: SetupNeed,
): HTMLElement {
  const entry = document.createElement("div");
  entry.className = `console-entry console-entry-level-${level}`;

  const labelEl = document.createElement("div");
  labelEl.className = "console-entry-label";

  const kindEl = document.createElement("span");
  kindEl.className = "console-entry-kind";
  kindEl.textContent = kind;
  labelEl.appendChild(kindEl);

  const labelText = document.createElement("span");
  labelText.className = "console-entry-label-text";
  labelText.textContent = label;
  labelEl.appendChild(labelText);
  entry.appendChild(labelEl);

  const contentEl = document.createElement("pre");
  contentEl.className = "console-entry-content";
  contentEl.textContent = content;
  entry.append(contentEl, ...settingLinks(need));

  consoleEntries.appendChild(entry);
  entry.scrollIntoView({ block: "start" });
  return entry;
}

// Level becomes a word only when it isn't info: the left-border colour that
// shows it doesn't survive a copy, and info is most entries.
function entryText(level: ConsoleEntryLevel, kind: string, label: string, content: string): string {
  const header = `${level === "info" ? "" : `[${level}] `}${kind}  ${label}`;
  return `${header}\n${content}`;
}

function revealEntry(entry: HTMLElement): boolean {
  if (!entry.isConnected) return false;
  entry.scrollIntoView({ block: "nearest" });
  flash(entry);
  return true;
}

// Constructor-injected with the two DOM elements it owns, rather than
// reaching for module-level globals. main.ts constructs one instance at startup with the
// real elements; nothing else needs to know this touches the DOM at all.
export function createModelConsole({ consoleEntries, activityIndicator }: ModelConsoleElements): ModelConsole {
  // The status-bar LLM activity indicator, ref-counted so overlapping
  // generate calls (a flow with several generate nodes) keep it lit until
  // the last settles. Applet and toolkit calls drive it through
  // the reporter; Flow's generate executor drives it directly; chat runs its
  // own tool loop and stays outside it, with its own typing bubble.

  // One entry per in-flight call — the requested model id ("" when left to
  // the server), so the tooltip names what's running as calls overlap and
  // finish out of order.
  const llmActivityModels: string[] = [];
  let llmActivityShowTimer: ReturnType<typeof setTimeout> | undefined;

  const entryTexts = new WeakMap<Element, string>();

  function write(
    level: ConsoleEntryLevel,
    kind: string,
    label: string,
    content: string,
    need?: SetupNeed,
  ): HTMLElement {
    const entry = writeEntry(consoleEntries, level, kind, label, content, need);
    entryTexts.set(entry, entryText(level, kind, label, content));
    return entry;
  }

  function entryAt(target: Node): ConsoleEntryText | undefined {
    for (let node: Node | null = target; node && node !== consoleEntries; node = node.parentNode) {
      const text = entryTexts.get(node as Element);
      if (text !== undefined) return { element: node as HTMLElement, text };
    }
    return undefined;
  }

  function allText(): string {
    return [...consoleEntries.children].flatMap((entry) => entryTexts.get(entry) ?? []).join("\n\n");
  }

  function clear(): void {
    consoleEntries.replaceChildren();
  }

  function refreshLlmActivityTitle(): void {
    const named = [...new Set(llmActivityModels.filter(Boolean))];
    activityIndicator.dataset.tooltip = named.length ? `Working: ${named.join(", ")}` : DEFAULT_LLM_ACTIVITY_TITLE;
  }

  function beginLlmActivity(model: string): void {
    llmActivityModels.push(model);
    refreshLlmActivityTitle();
    if (llmActivityModels.length === 1 && llmActivityShowTimer === undefined && activityIndicator.hidden) {
      // Brief delay so a sub-second generation doesn't flash the icon on and
      // straight back off.
      llmActivityShowTimer = setTimeout(() => {
        llmActivityShowTimer = undefined;
        if (llmActivityModels.length > 0) activityIndicator.hidden = false;
      }, 150);
    }
  }

  function endLlmActivity(model: string): void {
    const idx = llmActivityModels.indexOf(model);
    if (idx !== -1) llmActivityModels.splice(idx, 1);
    if (llmActivityModels.length > 0) {
      refreshLlmActivityTitle();
      return;
    }
    if (llmActivityShowTimer !== undefined) {
      clearTimeout(llmActivityShowTimer);
      llmActivityShowTimer = undefined;
    }
    activityIndicator.hidden = true;
    activityIndicator.dataset.tooltip = DEFAULT_LLM_ACTIVITY_TITLE;
  }

  function logLlmCall(label: string, outcome: LlmCallOutcome): void {
    if (outcome.failed) {
      const { kind, content, need } = failedCallEntry(label, outcome);
      write("error", kind, label, content, need);
      return;
    }
    const resultText = outcome.options.length > 0 ? outcome.options.join("\n---\n") : "(no options returned)";
    const parts = [outcome.context?.join("\n"), outcome.prompt, resultText].filter(Boolean);
    const ran = outcome.effort ? `${outcome.model} · ${effortName(outcome.effort)}` : outcome.model;
    write(outcome.warn ? "warn" : "info", "LLM", `${label} (${ran})`, parts.join("\n\n"));
  }

  function logEntry(
    level: ConsoleEntryLevel,
    kind: string,
    label: string,
    content: string,
    need?: SetupNeed,
  ): ConsoleEntry {
    const entry = write(level, kind, label, content, need);
    return { reveal: () => revealEntry(entry), kept: () => entry.isConnected };
  }

  return { logLlmCall, logEntry, beginLlmActivity, endLlmActivity, entryAt, allText, clear };
}
