// Back and Forward within one tab: what a
// replacement in place leaves on the tab's history, and what a step back or
// forward makes of it. The tab session decides when either happens.
import type { Place, Tab, TabHistory } from "./apiClient.ts";

export type Direction = "back" | "forward";

/** A step under way: the place the tab goes to, and its history once there. */
export interface Step {
  to: Place;
  history: TabHistory;
}

const MAX_PLACES = 50;

/** One entry, whatever view shows it: an applet and its Source mode. A Find
 * Context answer is never the folder it searched, and a version is never its
 * file, nor another of its versions. */
export function samePlace(a: Place, b: Place): boolean {
  if (a.kind === "version" || b.kind === "version") {
    return a.kind === "version" && b.kind === "version" && a.path === b.path && a.version.id === b.version.id;
  }
  return a.path === b.path && (a.kind === "find-context") === (b.kind === "find-context");
}

/** The history `incoming` takes on replacing `outgoing` in place, or
 * undefined to leave its own: a tab moved onto a blank keeps the history it
 * brought, and a blank hands on whatever it carried.
 *
 * The place pushed is the replaced tab itself, never a copy: its pane writes
 * the scroll position back to it only as the next tab mounts, after this. */
export function historyAfter(outgoing: Tab, incoming: Tab): TabHistory | undefined {
  if (outgoing.kind === "empty") return outgoing.history && pruned(outgoing.history, incoming, () => true);
  if (incoming.kind !== "empty" && samePlace(outgoing, incoming)) return outgoing.history;
  return { back: [...(outgoing.history?.back ?? []), outgoing].slice(-MAX_PLACES), forward: [] };
}

/** Where a step from `current` goes, and the history the tab has once
 * there; undefined when there is nowhere to go. */
export function step(current: Tab, direction: Direction): Step | undefined {
  const history = current.history;
  const to = history?.[direction].at(-1);
  if (!history || !to) return undefined;
  const here = current.kind === "empty" ? [] : [current];
  return direction === "back"
    ? { to, history: { back: history.back.slice(0, -1), forward: [...history.forward, ...here] } }
    : { to, history: { back: [...history.back, ...here], forward: history.forward.slice(0, -1) } };
}

/** `history` without the places `keep` turns down. What is left beside its
 * own twin, or next to `current`, folds away: stepping to where the tab
 * already is would do nothing. */
export function pruned(history: TabHistory, current: Tab, keep: (place: Place) => boolean): TabHistory {
  const tidy = (places: readonly Place[]) => {
    const kept: Place[] = [];
    for (const place of places) {
      const last = kept.at(-1);
      if (keep(place) && !(last && samePlace(last, place))) kept.push(place);
    }
    while (current.kind !== "empty" && kept.length > 0 && samePlace(kept[kept.length - 1], current)) kept.pop();
    return kept;
  };
  return { back: tidy(history.back), forward: tidy(history.forward) };
}

/** `history` with each place `rename` gives a new path re-pointed there. */
export function repathed(history: TabHistory, rename: (path: string) => string | undefined): TabHistory {
  const follow = (place: Place): Place => {
    const path = rename(place.path);
    return path === undefined ? place : { ...place, path };
  };
  return { back: history.back.map(follow), forward: history.forward.map(follow) };
}
