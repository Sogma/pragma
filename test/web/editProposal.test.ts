// @vitest-environment jsdom
import { history, undo } from "@codemirror/commands";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";
import {
  abandonProposal,
  acceptAll,
  editProposal,
  type NewProposal,
  pendingChanges,
  proposeEdit,
  proposeReplacement,
  rejectAll,
} from "../../web/editProposal.ts";
import { diffWords } from "../../web/lineDiff.ts";
import { polyfillRangeRects } from "./support/codemirrorJsdom.ts";

polyfillRangeRects();

function setup(doc: string, extra: { readOnly?: boolean } = {}) {
  const barHost = document.createElement("div");
  document.body.append(barHost);
  const view = new EditorView({
    state: EditorState.create({
      doc,
      extensions: [history(), editProposal({ barHost }), EditorState.readOnly.of(extra.readOnly ?? false)],
    }),
    parent: document.body,
  });
  const bar = () => barHost.querySelector<HTMLElement>(".edit-proposal-bar");
  return { view, bar };
}

function proposal(base: string, after: string, rest: Partial<NewProposal> = {}): NewProposal {
  return { base, hunks: diffWords(base, after), ...rest };
}

function click(view: EditorView, selector: string, index = 0): void {
  const button = view.dom.querySelectorAll<HTMLButtonElement>(selector)[index];
  if (!button) throw new Error(`no ${selector} at ${index}`);
  button.click();
}

describe("editProposal", () => {
  it("draws the changes over the text without touching it", () => {
    const { view, bar } = setup("one two three\n");
    expect(proposeEdit(view, proposal("one two three\n", "uno two tres\n"))).toBe(2);

    expect(view.state.doc.toString()).toBe("one two three\n");
    expect([...view.dom.querySelectorAll(".cm-proposal-delete")].map((el) => el.textContent)).toEqual(["one", "three"]);
    expect([...view.dom.querySelectorAll(".cm-proposal-insert")].map((el) => el.textContent)).toEqual(["uno", "tres"]);
    expect(bar()?.hidden).toBe(false);
    expect(bar()?.textContent).toContain("2 proposed changes");
  });

  it("decides each change on its own and reports once none is left", () => {
    const onSettled = vi.fn();
    const { view, bar } = setup("one two three\n");
    proposeEdit(view, proposal("one two three\n", "uno two tres\n", { onSettled }));

    click(view, ".cm-proposal-accept", 0);
    expect(view.state.doc.toString()).toBe("uno two three\n");
    expect(onSettled).not.toHaveBeenCalled();

    click(view, ".cm-proposal-reject", 0);
    expect(view.state.doc.toString()).toBe("uno two three\n");
    expect(onSettled).toHaveBeenCalledWith({ accepted: 1, rejected: 1, dropped: 0, replaced: false });
    expect(bar()?.hidden).toBe(true);
  });

  it("accepts everything left as one undoable edit, then the extras", () => {
    const apply = vi.fn();
    const onSettled = vi.fn();
    const { view, bar } = setup("one two three\n");
    proposeEdit(
      view,
      proposal("one two three\n", "uno two tres\n", { extras: [{ label: 'Title: "Uno"', apply }], onSettled }),
    );
    expect(bar()?.textContent).toContain('Title: "Uno"');

    acceptAll(view);

    expect(view.state.doc.toString()).toBe("uno two tres\n");
    expect(apply).toHaveBeenCalledTimes(1);
    expect(onSettled).toHaveBeenCalledWith({ accepted: 3, rejected: 0, dropped: 0, replaced: false });
    undo(view);
    expect(view.state.doc.toString()).toBe("one two three\n");
  });

  it("rejects everything left without changing the text or applying extras", () => {
    const apply = vi.fn();
    const onSettled = vi.fn();
    const { view } = setup("one two three\n");
    proposeEdit(view, proposal("one two three\n", "uno two tres\n", { extras: [{ label: "x", apply }], onSettled }));

    rejectAll(view);

    expect(view.state.doc.toString()).toBe("one two three\n");
    expect(apply).not.toHaveBeenCalled();
    expect(onSettled).toHaveBeenCalledWith({ accepted: 0, rejected: 3, dropped: 0, replaced: false });
  });

  it("carries changes through the writer's edits, and drops one they ran into", () => {
    const onSettled = vi.fn();
    const { view } = setup("one two three\n");
    proposeEdit(view, proposal("one two three\n", "uno two tres\n", { onSettled }));

    view.dispatch({ changes: { from: 0, insert: ">> " } }); // at a change's edge: it stands, shifted
    expect(pendingChanges(view.state)).toEqual([
      { id: 0, from: 3, to: 6, insert: "uno" },
      { id: 1, from: 11, to: 16, insert: "tres" },
    ]);

    view.dispatch({ changes: { from: 13, to: 14, insert: "X" } }); // inside "three"
    expect(pendingChanges(view.state).map((hunk) => hunk.insert)).toEqual(["uno"]);

    acceptAll(view);
    expect(view.state.doc.toString()).toBe(">> uno two thXee\n");
    expect(onSettled).toHaveBeenCalledWith({ accepted: 1, rejected: 0, dropped: 1, replaced: false });
  });

  it("carries a proposal made against older text onto the current one", () => {
    const { view } = setup("one two three\nadded while waiting\n");
    expect(proposeEdit(view, proposal("one two three\n", "uno two tres\n"))).toBe(2);

    acceptAll(view);
    expect(view.state.doc.toString()).toBe("uno two tres\nadded while waiting\n");
  });

  it("drops what the writer changed since the base, and shows nothing when nothing is left", () => {
    const { view } = setup("one 2 three\n");
    expect(proposeEdit(view, proposal("one two three\n", "one deux three\n"))).toBe(0);
    expect(pendingChanges(view.state)).toEqual([]);
  });

  it("settles a pending proposal as replaced when a newer one arrives", () => {
    const first = vi.fn();
    const { view } = setup("one two three\n");
    proposeEdit(view, proposal("one two three\n", "uno two three\n", { onSettled: first }));
    proposeEdit(view, proposal("one two three\n", "one two tres\n"));

    expect(first).toHaveBeenCalledWith({ accepted: 0, rejected: 0, dropped: 0, replaced: true });
    expect(pendingChanges(view.state).map((hunk) => hunk.insert)).toEqual(["tres"]);
  });

  it("reports what was left as dropped when its state is thrown away", () => {
    const onSettled = vi.fn();
    const { view } = setup("one two three\n");
    proposeEdit(view, proposal("one two three\n", "uno two tres\n", { onSettled }));

    abandonProposal(view.state);

    expect(onSettled).toHaveBeenCalledWith({ accepted: 0, rejected: 0, dropped: 2, replaced: false });
  });

  it("shows a proposal in a read-only editor but decides none of it", () => {
    const { view, bar } = setup("one two three\n", { readOnly: true });
    proposeEdit(view, proposal("one two three\n", "uno two tres\n"));

    expect(view.dom.querySelectorAll(".cm-proposal-insert")).toHaveLength(2);
    expect(bar()?.hidden).toBe(true);
    acceptAll(view);
    expect(view.state.doc.toString()).toBe("one two three\n");
  });

  describe("alternatives", () => {
    const range = { base: "a quick fox\n", from: 2, to: 7 };
    const shown = (view: EditorView) =>
      [...view.dom.querySelectorAll(".cm-proposal-insert")].map((el) => el.textContent);

    it("draws one alternative at a time, marked against the span, and steps through them", () => {
      const { view, bar } = setup("a quick fox\n");
      expect(proposeReplacement(view, range, ["swift", "sly", "quick red"])).toBe(1);

      expect(shown(view)).toEqual(["swift"]);
      expect(view.dom.querySelector(".cm-proposal-position")?.textContent).toBe("1/3");
      expect(bar()?.textContent).toContain("Alternative 1 of 3");
      expect(bar()?.querySelector(".btn.primary")?.textContent).toBe("Accept");
      // A choice is decided whole: no per-hunk buttons on the candidate.
      expect(view.dom.querySelectorAll(".cm-proposal-accept")).toHaveLength(1);

      click(view, ".cm-proposal-next");
      click(view, ".cm-proposal-next");
      expect(shown(view)).toEqual([" red"]);
      click(view, ".cm-proposal-next");
      expect(shown(view)).toEqual(["swift"]);
      click(view, ".cm-proposal-prev");
      expect(view.dom.querySelector(".cm-proposal-position")?.textContent).toBe("3/3");
    });

    it("accepts the alternative showing as one edit", () => {
      const { view, bar } = setup("a quick fox\n");
      proposeReplacement(view, range, ["swift", "sly"]);
      click(view, ".cm-proposal-next");
      click(view, ".cm-proposal-accept");

      expect(view.state.doc.toString()).toBe("a sly fox\n");
      expect(bar()?.hidden).toBe(true);
      undo(view);
      expect(view.state.doc.toString()).toBe("a quick fox\n");
    });

    it("rejects them all at once, and drops them when the writer edits the span", () => {
      const first = setup("a quick fox\n");
      proposeReplacement(first.view, range, ["swift", "sly"]);
      rejectAll(first.view);
      expect(first.view.state.doc.toString()).toBe("a quick fox\n");
      expect(pendingChanges(first.view.state)).toEqual([]);

      const second = setup("a quick fox\n");
      proposeReplacement(second.view, range, ["swift", "sly"]);
      second.view.dispatch({ changes: { from: 0, insert: ">> " } }); // outside: carried
      expect(shown(second.view)).toEqual(["swift"]);
      second.view.dispatch({ changes: { from: 7, to: 8, insert: "U" } }); // inside "quick"
      expect(pendingChanges(second.view.state)).toEqual([]);
    });

    it("treats a single alternative as an ordinary proposal", () => {
      const { view } = setup("a quick fox\n");
      expect(proposeReplacement(view, range, ["swift"])).toBe(1);
      expect(view.dom.querySelector(".cm-proposal-position")).toBeNull();
    });
  });
});
