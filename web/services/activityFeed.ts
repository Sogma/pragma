// The Console's server-side entries, pulled in only while it is open.
// Polling, not a stream: pragma has no server-to-browser channel, and for a
// record that is read, never acted on, a few seconds' lag beats a long-lived
// connection through Vite, Electron and the remote-access target's auth. What
// belongs in it, and why it is not a general log, is src/server/activityLog.ts.
import { fetchActivity } from "../core/apiClient.ts";
import type { ModelConsole } from "./modelConsole.ts";
import type { Setting } from "./settings.ts";

const INTERVAL_MS = 5000;

export interface ActivityFeedDeps {
  modelConsole: ModelConsole;
  showConsole: Setting<boolean>;
}

/** Follows `showConsole`, and returns its own teardown. */
export function startActivityFeed({ modelConsole, showConsole }: ActivityFeedDeps): () => void {
  let cursor: number | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  // One poll at a time. A slow response must not stack up behind the
  // interval and deliver the same entries twice.
  let inFlight = false;

  async function poll(): Promise<void> {
    // A background tab keeps its cursor and catches up when it comes back:
    // the Console counts as open, it just isn't being looked at. The
    // no-backlog rule is about the time before it was opened, not this.
    if (inFlight || document.visibilityState === "hidden") return;
    inFlight = true;
    try {
      const activity = await fetchActivity(cursor);
      cursor = activity.cursor;
      for (const entry of activity.entries) {
        modelConsole.logEntry(entry.level, entry.kind, entry.label, entry.content);
      }
    } catch {
      // A failed poll says nothing worth recording — the endpoint it failed
      // to reach is the app's own, so the user already knows. Reporting it
      // here would also be self-referential noise, once per interval.
    } finally {
      inFlight = false;
    }
  }

  function start(): void {
    if (timer !== undefined) return;
    // Undefined cursor means "start from now": the first poll is answered
    // with a cursor and no entries, so opening the Console never replays
    // what happened before it was opened.
    cursor = undefined;
    void poll();
    timer = setInterval(() => void poll(), INTERVAL_MS);
  }

  function stop(): void {
    if (timer === undefined) return;
    clearInterval(timer);
    timer = undefined;
  }

  const onVisible = (): void => {
    if (document.visibilityState === "visible" && timer !== undefined) void poll();
  };
  document.addEventListener("visibilitychange", onVisible);
  // Fires immediately with the current value, so an already-open Console
  // starts polling without a separate first call.
  const unsubscribe = showConsole.subscribe((show) => (show ? start() : stop()));

  return () => {
    unsubscribe();
    stop();
    document.removeEventListener("visibilitychange", onVisible);
  };
}
