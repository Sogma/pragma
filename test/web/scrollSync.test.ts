import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createScrollSync, type ScrollSync } from "../../web/scrollSync.ts";
import type { DocumentPane, ScrollChange } from "../../web/view/panes/documentPane.ts";

// A document pane as the sync sees it: a file, a mode, and a place. Moving
// it records where it was sent; the test plays the writer by setting `line`
// and saying it scrolled.
function pane(path: string, reading: boolean) {
  const listeners = new Set<(change: ScrollChange) => void>();
  const side = {
    reading,
    line: 1,
    moves: [] as number[],
    emit(change: ScrollChange) {
      for (const listener of listeners) listener(change);
    },
    watchers: () => listeners.size,
    as: undefined as unknown as DocumentPane,
  };
  side.as = {
    kind: "document",
    path: () => path,
    isReading: () => side.reading,
    topLine: () => side.line,
    scrollToLine(line: number) {
      side.line = line;
      side.moves.push(line);
    },
    onScrollChange(listener: (change: ScrollChange) => void) {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
  } as unknown as DocumentPane;
  return side;
}

let frames: FrameRequestCallback[] = [];
let now = 0;
const nextFrame = () => {
  const due = frames;
  frames = [];
  for (const callback of due) callback(now);
};

beforeEach(() => {
  frames = [];
  now = 1000;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => frames.push(callback));
  vi.stubGlobal("cancelAnimationFrame", () => {});
  vi.spyOn(performance, "now").mockImplementation(() => now);
});

const syncs: ScrollSync[] = [];
afterEach(() => {
  for (const sync of syncs.splice(0)) sync.dispose();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function paired(left = pane("notes/a.md", false), right = pane("notes/a.md", true)) {
  let shown = [left, right];
  const sync = createScrollSync(() => shown.map((side) => side.as));
  syncs.push(sync);
  sync.refresh();
  return {
    left,
    right,
    sync,
    show(...sides: ReturnType<typeof pane>[]) {
      shown = sides;
    },
  };
}

describe("scroll sync", () => {
  it("puts the reading side level with the editor when the pair forms", () => {
    const left = pane("notes/a.md", false);
    left.line = 40.5;
    const { right } = paired(left);
    nextFrame();
    expect(right.moves).toEqual([40.5]);
    expect(left.moves).toEqual([]);
  });

  it("brings the side that just arrived level with the one already there", () => {
    const page = pane("notes/a.md", true);
    page.line = 200;
    const editor = pane("notes/a.md", false);
    const { left, right, show, sync } = paired(page, pane("notes/b.md", false));
    nextFrame();

    // An editor opened beside a page goes to the page's place.
    show(left, editor);
    sync.refresh();
    editor.emit("view");
    nextFrame();
    expect(editor.moves).toEqual([200]);
    expect(page.moves).toEqual([]);

    // Its mode switched back and forth in its own group, a page goes to the editor's.
    now += 200;
    editor.line = 120;
    left.reading = false;
    left.emit("view");
    nextFrame();
    left.reading = true;
    left.emit("view");
    nextFrame();
    expect(left.moves).toEqual([120]);
    expect(right.moves).toEqual([]);
  });

  it("follows whichever side the writer scrolls", () => {
    const { left, right } = paired();
    nextFrame();
    now += 200;
    left.line = 55;
    left.emit("scroll");
    nextFrame();
    expect(right.line).toBe(55);

    now += 200;
    right.line = 70;
    right.emit("scroll");
    nextFrame();
    expect(left.line).toBe(70);
  });

  it("takes a side's scroll just after it was moved for the echo of the move", () => {
    const { left, right } = paired();
    nextFrame();
    now += 200;
    left.line = 55;
    left.emit("scroll");
    nextFrame();
    now += 50;
    right.line = 56;
    right.emit("scroll");
    nextFrame();
    expect(left.moves).toEqual([]);

    now += 100;
    right.emit("scroll");
    nextFrame();
    expect(left.moves).toEqual([56]);
  });

  it("puts the reading side back when its page moves under it, and lets the page settle", () => {
    const { left, right } = paired();
    nextFrame();
    left.line = 12;
    now += 200;
    right.line = 30;
    right.emit("reflow");
    right.emit("scroll");
    nextFrame();
    expect(right.line).toBe(12);
    expect(left.moves).toEqual([]);
  });

  it("lets a scroll outrank a reflow in the same frame", () => {
    const { left, right } = paired();
    nextFrame();
    now += 200;
    right.line = 30;
    right.emit("scroll");
    right.emit("reflow");
    nextFrame();
    expect(left.line).toBe(30);
  });

  it("forms the pair when one side switches to reading, and ends it when it switches back", () => {
    const { left, right } = paired(pane("a.md", false), pane("a.md", false));
    nextFrame();
    left.line = 20;
    left.emit("scroll");
    nextFrame();
    expect(right.moves).toEqual([]);

    right.reading = true;
    right.emit("view");
    nextFrame();
    expect(right.moves).toEqual([20]);

    right.reading = false;
    right.emit("view");
    nextFrame();
    now += 200;
    left.line = 90;
    left.emit("scroll");
    nextFrame();
    expect(right.moves).toEqual([20]);
  });

  it("tells which two panes scroll as one each time it works the pair out, and none once it ends", () => {
    const heard: (readonly DocumentPane[])[] = [];
    const left = pane("a.md", false);
    const right = pane("a.md", false);
    const sync = createScrollSync(
      () => [left.as, right.as],
      (panes) => heard.push(panes),
    );
    syncs.push(sync);
    sync.refresh();
    nextFrame();
    expect(heard).toEqual([[]]);

    right.reading = true;
    right.emit("view");
    nextFrame();
    expect(heard).toHaveLength(2);
    expect(heard[1][0]).toBe(left.as);
    expect(heard[1][1]).toBe(right.as);

    // A scroll only moves the other side.
    now += 200;
    left.line = 30;
    left.emit("scroll");
    nextFrame();
    expect(heard).toHaveLength(2);

    right.reading = false;
    right.emit("view");
    nextFrame();
    expect(heard.at(-1)).toEqual([]);
  });

  it("leaves two editors, two readers, and two files each to its own scroll", () => {
    for (const [left, right] of [
      [pane("a.md", false), pane("a.md", false)],
      [pane("a.md", true), pane("a.md", true)],
      [pane("a.md", false), pane("b.md", true)],
    ]) {
      paired(left, right);
      nextFrame();
      now += 200;
      left.line = 33;
      left.emit("scroll");
      right.line = 44;
      right.emit("scroll");
      nextFrame();
      expect([left.moves, right.moves]).toEqual([[], []]);
    }
  });

  it("stops watching a pane the groups no longer show", () => {
    const { left, right, sync, show } = paired();
    nextFrame();
    show(left);
    sync.refresh();
    nextFrame();
    expect(right.watchers()).toBe(0);
    now += 200;
    left.line = 8;
    left.emit("scroll");
    nextFrame();
    expect(right.moves).toEqual([1]);

    sync.dispose();
    expect(left.watchers()).toBe(0);
  });
});
