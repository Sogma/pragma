// A proposed edit drawn over a document rather than written into it, so
// autosave, the publish queue, and every other reader of the buffer see
// nothing until a change is accepted. Each change has its own accept and
// reject; a bar over the pane decides the rest at once.
//
// The proposal lives in the editor state, so it maps through every edit like
// a selection and travels with a tab's cached state; a change the writer's
// own edit runs into is dropped, never applied over what they typed.
import { ChangeSet, type EditorState, type Extension, StateEffect, StateField, type Text } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, type ViewUpdate, WidgetType } from "@codemirror/view";
import { diffWords, type TextHunk } from "./lineDiff.ts";

export interface ProposalOutcome {
  accepted: number;
  rejected: number;
  // Changes the writer's own edits ran into before they were decided.
  dropped: number;
  // A newer proposal took this one's place before it was decided.
  replaced: boolean;
}

// A change outside the text — a lifted title, a property — decided by the
// bar together with whatever else is left.
export interface ProposalExtra {
  label: string;
  apply(): void;
}

export interface NewProposal {
  // The text the hunks were computed against. A document that has moved on
  // since has them carried onto its current text.
  base: string;
  hunks: readonly TextHunk[];
  extras?: readonly ProposalExtra[];
  onSettled?(outcome: ProposalOutcome): void;
}

interface PendingHunk extends TextHunk {
  id: number;
}

// Several candidates for one span, decided as a single change.
interface Choice {
  from: number;
  to: number;
  texts: readonly string[];
  index: number;
}

interface Proposal {
  serial: number;
  // With a choice, only the candidate showing, marked against the span.
  hunks: readonly PendingHunk[];
  extras: readonly ProposalExtra[];
  outcome: ProposalOutcome;
  onSettled?(outcome: ProposalOutcome): void;
  choice?: Choice;
}

interface Resolution {
  ids: readonly number[] | "all";
  accept: boolean;
}

const setProposal = StateEffect.define<Proposal>();
const resolveChanges = StateEffect.define<Resolution>();
// Steps the candidate showing by this many, wrapping at either end.
const stepChoice = StateEffect.define<number>();
let nextSerial = 1;

function pendingCount(proposal: Proposal | null | undefined): number {
  if (!proposal) return 0;
  return (proposal.choice ? 1 : proposal.hunks.length) + proposal.extras.length;
}

// Offsets hunks computed against a slice back into document positions.
function hunksAt(from: number, before: string, after: string): PendingHunk[] {
  return diffWords(before, after).map((hunk, id) => ({ ...hunk, from: hunk.from + from, to: hunk.to + from, id }));
}

function drawChoice(proposal: Proposal, doc: Text): Proposal {
  const { choice } = proposal;
  if (!choice) return proposal;
  return {
    ...proposal,
    hunks: hunksAt(choice.from, doc.sliceString(choice.from, choice.to), choice.texts[choice.index]),
  };
}

// Text typed exactly at a change's edge lands beside it and leaves it
// standing. An edit inside it, or on the very spot an insertion is proposed,
// has decided that change for the writer.
function runsInto(changes: ChangeSet, hunk: TextHunk): boolean {
  let hit = false;
  changes.iterChangedRanges((fromA, toA) => {
    if (hunk.from === hunk.to) hit ||= fromA === toA ? fromA === hunk.from : fromA < hunk.from && toA > hunk.from;
    else hit ||= fromA === toA ? fromA > hunk.from && fromA < hunk.to : fromA < hunk.to && toA > hunk.from;
  });
  return hit;
}

function carry(proposal: Proposal, changes: ChangeSet): Proposal {
  const { choice } = proposal;
  if (choice) {
    if (runsInto(changes, { ...choice, insert: "" })) {
      const outcome = { ...proposal.outcome, dropped: proposal.outcome.dropped + 1 };
      return { ...proposal, choice: undefined, hunks: [], outcome };
    }
    return {
      ...proposal,
      choice: { ...choice, from: changes.mapPos(choice.from, 1), to: changes.mapPos(choice.to, -1) },
    };
  }
  const hunks = proposal.hunks
    .filter((hunk) => !runsInto(changes, hunk))
    .map((hunk) => ({ ...hunk, from: changes.mapPos(hunk.from, 1), to: changes.mapPos(hunk.to, -1) }));
  const dropped = proposal.hunks.length - hunks.length;
  return { ...proposal, hunks, outcome: { ...proposal.outcome, dropped: proposal.outcome.dropped + dropped } };
}

function resolve(proposal: Proposal, { ids, accept }: Resolution): Proposal {
  const all = ids === "all";
  // A choice is decided whole, never a hunk of the candidate showing.
  if (proposal.choice && !all) return proposal;
  const decided = all ? pendingCount(proposal) : proposal.hunks.filter((hunk) => ids.includes(hunk.id)).length;
  if (!decided) return proposal;
  const key = accept ? "accepted" : "rejected";
  return {
    ...proposal,
    hunks: all ? [] : proposal.hunks.filter((hunk) => !ids.includes(hunk.id)),
    extras: all ? [] : proposal.extras,
    choice: undefined,
    outcome: { ...proposal.outcome, [key]: proposal.outcome[key] + decided },
  };
}

const proposalField = StateField.define<Proposal | null>({
  create: () => null,
  update(value, tr) {
    let next = value;
    let redraw = false;
    for (const effect of tr.effects) {
      if (effect.is(setProposal)) next = effect.value;
      else if (effect.is(resolveChanges) && next) next = resolve(next, effect.value);
      else if (effect.is(stepChoice) && next?.choice) {
        const { choice } = next;
        const index = (choice.index + effect.value + choice.texts.length) % choice.texts.length;
        next = { ...next, choice: { ...choice, index } };
        redraw = true;
      }
    }
    if (next && tr.docChanged) {
      next = carry(next, tr.changes);
      redraw = true;
    }
    return next && redraw ? drawChoice(next, tr.state.doc) : next;
  },
});

/** Draws `proposal` over the view's document, replacing any proposal already
 * there. Returns how many changes it shows: none when it matches the text, or
 * every one of its hunks ran into an edit made since `base`. */
export function proposeEdit(view: EditorView, proposal: NewProposal): number {
  return place(view, proposal.base, {
    serial: nextSerial++,
    hunks: proposal.hunks.map((hunk, id) => ({ ...hunk, id })),
    extras: proposal.extras ?? [],
    outcome: { accepted: 0, rejected: 0, dropped: 0, replaced: false },
    onSettled: proposal.onSettled,
  });
}

function place(view: EditorView, base: string, proposal: Proposal): number {
  const text = view.state.doc.toString();
  let placed = proposal;
  if (base !== text) placed = carry(placed, ChangeSet.of(diffWords(base, text), base.length));
  if (!pendingCount(placed)) return 0;
  placed = drawChoice(placed, view.state.doc);
  const at = placed.choice?.from ?? placed.hunks[0]?.from;
  view.dispatch({
    effects: [setProposal.of(placed), ...(at === undefined ? [] : [EditorView.scrollIntoView(at, { y: "center" })])],
  });
  return pendingCount(placed);
}

/** Proposes a replacement for `[from, to)` of `base`, marked word by word so
 * only what differs from the replaced text shows as a change. Several
 * alternatives make one choice, the first showing. Returns how many changes
 * it shows. */
export function proposeReplacement(
  view: EditorView,
  range: { base: string; from: number; to: number },
  alternatives: readonly string[],
): number {
  const [only] = alternatives;
  if (alternatives.length === 1) {
    return proposeEdit(view, {
      base: range.base,
      hunks: hunksAt(range.from, range.base.slice(range.from, range.to), only),
    });
  }
  if (!alternatives.length) return 0;
  return place(view, range.base, {
    serial: nextSerial++,
    hunks: [],
    extras: [],
    outcome: { accepted: 0, rejected: 0, dropped: 0, replaced: false },
    choice: { from: range.from, to: range.to, texts: alternatives, index: 0 },
  });
}

/** Settles a proposal whose state is being thrown away — the file reloaded
 * from disk under it — so whoever is waiting on it hears that it went. */
export function abandonProposal(state: EditorState): void {
  const proposal = state.field(proposalField, false);
  if (!pendingCount(proposal) || !proposal) return;
  proposal.onSettled?.({ ...proposal.outcome, dropped: proposal.outcome.dropped + pendingCount(proposal) });
}

/** The changes still waiting on the writer, in document order. */
export function pendingChanges(state: EditorState): readonly TextHunk[] {
  return state.field(proposalField, false)?.hunks ?? [];
}

function acceptChange(view: EditorView, id: number): void {
  const hunk = view.state.field(proposalField, false)?.hunks.find((pending) => pending.id === id);
  if (!hunk || view.state.readOnly) return;
  view.dispatch({
    changes: { from: hunk.from, to: hunk.to, insert: hunk.insert },
    effects: resolveChanges.of({ ids: [id], accept: true }),
    userEvent: "input.proposal",
  });
}

function rejectChange(view: EditorView, id: number): void {
  if (view.state.readOnly) return;
  view.dispatch({ effects: resolveChanges.of({ ids: [id], accept: false }) });
}

/** Applies every change still pending as one edit, so one undo reverts it,
 * then the extras. A `userEvent` other than a proposal's names what made the
 * change, which its save carries on: a restore, say. */
export function acceptAll(view: EditorView, userEvent = "input.proposal"): void {
  const proposal = view.state.field(proposalField, false);
  if (!proposal || !pendingCount(proposal) || view.state.readOnly) return;
  const { choice } = proposal;
  view.dispatch({
    changes: choice
      ? { from: choice.from, to: choice.to, insert: choice.texts[choice.index] }
      : proposal.hunks.map(({ from, to, insert }) => ({ from, to, insert })),
    effects: resolveChanges.of({ ids: "all", accept: true }),
    userEvent,
  });
  for (const extra of proposal.extras) extra.apply();
}

export function rejectAll(view: EditorView): void {
  if (!pendingCount(view.state.field(proposalField, false)) || view.state.readOnly) return;
  view.dispatch({ effects: resolveChanges.of({ ids: "all", accept: false }) });
}

function stepAlternative(view: EditorView, by: number): void {
  if (view.state.field(proposalField, false)?.choice) view.dispatch({ effects: stepChoice.of(by) });
}

function actionButton(className: string, label: string, run: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.dataset.tooltip = label;
  button.setAttribute("aria-label", label);
  // Keeps the editor's focus and selection where the writer left them.
  button.addEventListener("mousedown", (event) => event.preventDefault());
  button.addEventListener("click", run);
  return button;
}

// What a change inserts, and its accept and reject, drawn after the text it
// replaces. The insertion is never document text: the caret can't enter it
// and a save can't see it. A choice's hunks carry no buttons of their own:
// the choice is decided whole, by ChoiceWidget.
class ChangeWidget extends WidgetType {
  constructor(
    readonly id: number,
    readonly insert: string,
    readonly decidable: boolean,
  ) {
    super();
  }

  eq(other: ChangeWidget): boolean {
    return other.id === this.id && other.insert === this.insert && other.decidable === this.decidable;
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement("span");
    wrap.className = "cm-proposal-change";
    const inserted = (text: string) => {
      const span = document.createElement("span");
      span.className = "cm-proposal-insert";
      span.textContent = text;
      return span;
    };
    // The buttons go after the inserted words but before any line break that
    // ends them, so an inserted paragraph keeps its buttons on its last line.
    const breaks = /\n*$/.exec(this.insert)?.[0] ?? "";
    const words = this.insert.slice(0, this.insert.length - breaks.length);
    if (words) wrap.append(inserted(words));
    if (this.decidable) {
      const actions = document.createElement("span");
      actions.className = "cm-proposal-actions";
      actions.append(
        actionButton("cm-proposal-accept", "Accept this change", () => acceptChange(view, this.id)),
        actionButton("cm-proposal-reject", "Reject this change", () => rejectChange(view, this.id)),
      );
      wrap.append(actions);
    }
    if (breaks) wrap.append(inserted(breaks));
    return wrap;
  }
}

function stepButtons(view: EditorView, count: number, index: number): HTMLElement[] {
  const position = document.createElement("span");
  position.className = "caption cm-proposal-position";
  position.textContent = `${index + 1}/${count}`;
  return [
    actionButton("cm-proposal-prev", "Previous alternative", () => stepAlternative(view, -1)),
    position,
    actionButton("cm-proposal-next", "Next alternative", () => stepAlternative(view, 1)),
  ];
}

// A choice's controls, after its span: step through the alternatives, keep
// the one showing, or turn them all down.
class ChoiceWidget extends WidgetType {
  constructor(
    readonly index: number,
    readonly count: number,
  ) {
    super();
  }

  eq(other: ChoiceWidget): boolean {
    return other.index === this.index && other.count === this.count;
  }

  toDOM(view: EditorView): HTMLElement {
    const actions = document.createElement("span");
    actions.className = "cm-proposal-actions";
    actions.append(
      ...stepButtons(view, this.count, this.index),
      actionButton("cm-proposal-accept", "Accept this alternative", () => acceptAll(view)),
      actionButton("cm-proposal-reject", "Reject every alternative", () => rejectAll(view)),
    );
    return actions;
  }
}

const deletedMark = Decoration.mark({ class: "cm-proposal-delete" });

const proposalDecorations = EditorView.decorations.compute([proposalField], (state) => {
  const proposal = state.field(proposalField, false);
  if (!pendingCount(proposal) || !proposal) return Decoration.none;
  const { choice } = proposal;
  const ranges = proposal.hunks.flatMap((hunk) => [
    ...(hunk.to > hunk.from ? [deletedMark.range(hunk.from, hunk.to)] : []),
    Decoration.widget({ widget: new ChangeWidget(hunk.id, hunk.insert, !choice), side: 1 }).range(hunk.to),
  ]);
  if (choice) {
    const widget = new ChoiceWidget(choice.index, choice.texts.length);
    ranges.push(Decoration.widget({ widget, side: 2 }).range(choice.to));
  }
  return Decoration.set(ranges, true);
});

function summarize(proposal: Proposal): string {
  const { choice } = proposal;
  const count = proposal.hunks.length;
  const parts = choice
    ? [`Alternative ${choice.index + 1} of ${choice.texts.length}`]
    : count
      ? [`${count} proposed ${count === 1 ? "change" : "changes"}`]
      : [];
  return [...parts, ...proposal.extras.map((extra) => extra.label)].join(" · ");
}

// A proposal is settled once nothing of it is pending, or once a newer one
// replaces it. Reported from here, after the transaction, since reporting
// reaches outside the editor.
function reportSettled(update: ViewUpdate): void {
  const was = update.startState.field(proposalField, false);
  if (!was || !pendingCount(was)) return;
  const now = update.state.field(proposalField, false);
  if (!now || now.serial !== was.serial) was.onSettled?.({ ...was.outcome, replaced: true });
  else if (!pendingCount(now)) now.onSettled?.(now.outcome);
}

// The bar is the pane's, not the editor's: it floats over the pane rather than
// scrolling with the text. Hidden while the editor is read-only — reading view
// shows a proposal but decides none of it.
function proposalBar(host: HTMLElement): Extension {
  return ViewPlugin.define((view) => {
    const bar = document.createElement("div");
    bar.className = "floating-toolbar edit-proposal-bar";
    const summary = document.createElement("span");
    summary.className = "edit-proposal-summary";
    const prev = actionButton("cm-proposal-prev", "Previous alternative", () => stepAlternative(view, -1));
    const next = actionButton("cm-proposal-next", "Next alternative", () => stepAlternative(view, 1));
    const accept = actionButton("btn primary", "Accept all", () => acceptAll(view));
    const reject = actionButton("btn", "Reject all", () => rejectAll(view));
    bar.append(summary, prev, next, accept, reject);
    host.append(bar);

    const render = (state: EditorState) => {
      const proposal = state.field(proposalField, false);
      bar.hidden = !proposal || !pendingCount(proposal) || state.readOnly;
      if (!proposal || bar.hidden) return;
      summary.textContent = summarize(proposal);
      // One choice and nothing else is a single decision, not an "all".
      const single = proposal.choice && !proposal.extras.length;
      for (const [button, label] of [
        [accept, single ? "Accept" : "Accept all"],
        [reject, single ? "Reject" : "Reject all"],
      ] as const) {
        button.textContent = label;
        button.dataset.tooltip = label;
        button.setAttribute("aria-label", label);
      }
      prev.hidden = !proposal.choice;
      next.hidden = !proposal.choice;
    };
    render(view.state);

    return {
      update(update: ViewUpdate) {
        reportSettled(update);
        render(update.state);
      },
      destroy() {
        bar.remove();
      },
    };
  });
}

/** Everything an editor needs to show proposals; `barHost` is where the bar
 * floats. */
export function editProposal(options: { barHost: HTMLElement }): Extension {
  return [proposalField, proposalDecorations, proposalBar(options.barHost)];
}
