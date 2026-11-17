// A file edited in one group and read in the other scrolls as one
// (docs/architecture.md's Files and views section): whichever side the writer scrolls,
// the other follows, matched by file line (web/core/scrollPlace.ts).
//
// When the pair forms, the side that just arrived (opened, switched to, or
// switched mode) comes level with the one already there; when both did, or
// the reading side's page moves under it (drawn again after an edit, an image
// loading, a new width), the reading side is put level with the editor.
import { type Disposable, DisposableStore } from "./lib/disposable.ts";
import type { DocumentPane, ScrollChange } from "./view/panes/documentPane.ts";

// A side just moved to match the other, or whose page just moved under it,
// goes on scrolling by itself for a moment: CodeMirror settling heights it
// had estimated, a scroll clamped to a shorter page. None of that is the
// writer's hand, and following it would pull the other side after it.
const ECHO_MS = 100;

interface Pair {
  editing: DocumentPane;
  reading: DocumentPane;
}

export interface ScrollSync extends Disposable {
  /** Which panes the groups show may have changed: one was mounted, or a
   * group closed. */
  refresh(): void;
}

/** `shown` lists the document panes the groups show, left to right.
 * `paired` hears which two of them scroll as one, or none, each time that is
 * worked out again. */
export function createScrollSync(
  shown: () => readonly DocumentPane[],
  paired?: (panes: readonly DocumentPane[]) => void,
): ScrollSync {
  const store = new DisposableStore();
  // Every document pane shown, paired or not: a pane switching to reading
  // is how a pair forms.
  const watched = new Map<DocumentPane, Disposable>();
  const quietUntil = new Map<DocumentPane, number>();
  let pair: Pair | undefined;

  // What the next frame does, gathered from everything since the last one.
  let repair = false;
  const arrived = new Set<DocumentPane>();
  let scrolled: DocumentPane | undefined;
  let reflowed = false;
  let frame: number | undefined;

  function schedule(): void {
    frame ??= requestAnimationFrame(run);
  }

  function hush(pane: DocumentPane): void {
    quietUntil.set(pane, performance.now() + ECHO_MS);
  }

  function changed(pane: DocumentPane, change: ScrollChange): void {
    if (change === "view") {
      repair = true;
      arrived.add(pane);
    } else if (!pair) return;
    else if (change === "reflow") {
      hush(pane);
      reflowed = true;
    } else if (performance.now() >= (quietUntil.get(pane) ?? 0)) scrolled = pane;
    else return;
    schedule();
  }

  function pairShown(): Pair | undefined {
    const panes = shown().filter((pane) => pane.kind === "document");
    for (const [pane, watch] of watched) {
      if (panes.includes(pane)) continue;
      watch.dispose();
      watched.delete(pane);
      quietUntil.delete(pane);
    }
    // A pane not shown before has just arrived, whatever it said before it
    // was watched.
    for (const pane of panes) {
      if (watched.has(pane)) continue;
      const watch = pane.onScrollChange((change) => changed(pane, change));
      watched.set(pane, watch);
      arrived.add(pane);
    }
    if (panes.length !== 2) return undefined;
    const [a, b] = panes;
    const path = a.path();
    if (path === undefined || path !== b.path() || a.isReading() === b.isReading()) return undefined;
    return a.isReading() ? { editing: b, reading: a } : { editing: a, reading: b };
  }

  function move(target: DocumentPane, source: DocumentPane): void {
    const line = source.topLine();
    if (line === undefined) return;
    hush(target);
    target.scrollToLine(line);
  }

  function run(): void {
    frame = undefined;
    const formed = repair;
    const leader = scrolled;
    const relevel = reflowed;
    repair = false;
    scrolled = undefined;
    reflowed = false;
    if (formed) {
      pair = pairShown();
      paired?.(pair ? [pair.editing, pair.reading] : []);
    }
    const fresh = new Set(arrived);
    arrived.clear();
    if (!pair) return;
    // A scroll outranks a reflow in the same frame: the page is measured as
    // it stands now, so the writer's scroll lands where they put it.
    if (!formed && leader === pair.editing) move(pair.reading, pair.editing);
    else if (!formed && leader === pair.reading) move(pair.editing, pair.reading);
    else if (formed && fresh.has(pair.editing) && !fresh.has(pair.reading)) move(pair.editing, pair.reading);
    else if (formed || relevel) move(pair.reading, pair.editing);
  }

  store.add(() => {
    if (frame !== undefined) cancelAnimationFrame(frame);
    for (const watch of watched.values()) watch.dispose();
    watched.clear();
  });

  return {
    refresh() {
      repair = true;
      schedule();
    },
    dispose: () => store.dispose(),
  };
}
