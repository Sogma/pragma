// The server-side half of the Console: consequential work with no surface of
// its own to report it. Not a general logging sink — the admission rule is
// architecture.md's: an agent's API request or a headless Flow run earns an
// entry; git sync (Source Control reports it) or anything else driven through
// a surface that reports its own outcome does not.
//
// A record for the user to consult, never a channel the app reads back: no
// behavior in pragma may branch on what is or is not in here.
import type { ActivityEntry, ActivityResponse } from "../protocol/api.ts";

/** Entries kept in memory. Deliberately small: this is the tail the Console
 * reads between polls, not an audit log — nothing durable is promised, and
 * the Console is off for most users anyway. */
const LIMIT = 200;

let nextSeq = 1;
const entries: ActivityEntry[] = [];

/** Records one finished piece of work. Level follows the Console's own two
 * axes: `warn` for something that completed unhappily (a refused request),
 * `error` only for work that could not report an outcome at all. */
export function recordActivity(level: ActivityEntry["level"], kind: string, label: string, content: string): void {
  entries.push({ seq: nextSeq++, level, kind, label, content });
  if (entries.length > LIMIT) entries.splice(0, entries.length - LIMIT);
}

/** Everything since `since`, newest cursor included.
 *
 * A reader with no cursor gets the cursor and nothing else. The no-backlog
 * rule lives here rather than in the client so every reader obeys it: the
 * Console is a window onto what happens while it is open, and an entry from
 * before that would arrive with a timestamp it cannot show and a context the
 * user has already left. */
export function activitySince(since?: number): ActivityResponse {
  const cursor = nextSeq - 1;
  if (since === undefined) return { cursor, entries: [] };
  return { cursor, entries: entries.filter((entry) => entry.seq > since) };
}

/** Test seam: drops every entry and rewinds the cursor. */
export function resetActivityLog(): void {
  entries.length = 0;
  nextSeq = 1;
}
