// What each open file has to say for itself, counted on its status bar by
// the Console's three levels: an error a call on it met, what's wrong with it
// (docs/architecture.md, Feedback and interaction), what a run or a publish of it
// noticed. Live state, each source's say replacing its own last, so a bar
// shows what is current; the Console keeps the record.

import type { SetupNeed } from "../../src/protocol/setupNeed.ts";
import { Emitter } from "../lib/emitter.ts";
import type { ConsoleEntry, ConsoleEntryLevel } from "./modelConsole.ts";

/** How many things each level says about one file. */
export type NoticeCounts = Readonly<Record<ConsoleEntryLevel, number>>;
export type NoticesByPath = ReadonlyMap<string, NoticeCounts>;

/** A Console entry about one file, counted on its status bar. */
export interface FileNotice {
  level: ConsoleEntryLevel;
  kind: string;
  label: string;
  content: string;
  // How many things it says, as the bar counts them: a generation's notes
  // under the price it cost, say, not the price.
  count: number;
  // What it needs set up, when a setting fixes it.
  need?: SetupNeed;
}

export interface FileNoticesDeps {
  log(level: ConsoleEntryLevel, kind: string, label: string, content: string, need?: SetupNeed): ConsoleEntry;
  showConsole(): void;
}

export interface FileNotices {
  /** `source` starts over on `path`, as a run or a publish does: what it
   * said there before stops counting. */
  begin(path: string, source: string): void;
  /** Writes `notice` to the Console, counted on `path`'s bar until `source`
   * begins there again. */
  add(path: string, source: string, notice: FileNotice): void;
  /** What's wrong with `path` now, replacing what was; an empty list clears
   * it. Written only when something is new to its last entry, so reopening a
   * file, or fixing one of its problems, writes nothing. */
  reportProblems(path: string, problems: readonly string[]): void;
  subscribe(listener: (notices: NoticesByPath) => void): () => void;
  /** Opens the Console at `path`'s first notice of `level`. */
  reveal(path: string, level: ConsoleEntryLevel): void;
}

// A notice as a bar counts it, with what writes its entry again.
interface Held {
  source: string;
  level: ConsoleEntryLevel;
  count: number;
  write(): ConsoleEntry;
  entry: ConsoleEntry;
  // Its entry says more than is so: it lists a problem fixed since.
  stale: boolean;
}

const PROBLEMS = "problems";

export function createFileNotices(deps: FileNoticesDeps): FileNotices {
  const emitter = new Emitter<NoticesByPath>(new Map());
  const held = new Map<string, Held[]>();
  const problemsOf = new Map<string, readonly string[]>();
  // The last problems entry written for each path, and what it listed. Kept
  // past a fix, so a problem that comes back isn't written twice.
  const logged = new Map<string, { problems: readonly string[]; entry: ConsoleEntry }>();

  function hold(path: string, notices: Held[]): void {
    if (notices.length > 0) held.set(path, notices);
    else held.delete(path);
    const counts = { error: 0, warn: 0, info: 0 };
    for (const notice of notices) counts[notice.level] += notice.count;
    const next = new Map(emitter.get());
    if (counts.error + counts.warn + counts.info > 0) next.set(path, counts);
    else next.delete(path);
    emitter.set(next);
  }

  function writeProblems(path: string, problems: readonly string[]): ConsoleEntry {
    const entry = deps.log("warn", "Problems", path, problems.join("\n"));
    logged.set(path, { problems, entry });
    return entry;
  }

  return {
    begin(path, source) {
      const notices = held.get(path) ?? [];
      if (notices.some((notice) => notice.source === source)) {
        hold(
          path,
          notices.filter((notice) => notice.source !== source),
        );
      }
    },
    add(path, source, { level, kind, label, content, count, need }) {
      const write = () => deps.log(level, kind, label, content, need);
      hold(path, [...(held.get(path) ?? []), { source, level, count, write, entry: write(), stale: false }]);
    },
    reportProblems(path, reported) {
      const problems = [...reported];
      if (sameList(problemsOf.get(path) ?? [], problems)) return;
      const told = logged.get(path)?.problems ?? [];
      if (problems.some((problem) => !told.includes(problem))) writeProblems(path, problems);
      if (problems.length > 0) problemsOf.set(path, problems);
      else problemsOf.delete(path);
      const notices = [...(held.get(path) ?? [])];
      const at = notices.findIndex((notice) => notice.source === PROBLEMS);
      const last = logged.get(path);
      if (problems.length === 0 || !last) {
        if (at !== -1) notices.splice(at, 1);
      } else {
        const notice: Held = {
          source: PROBLEMS,
          level: "warn",
          count: problems.length,
          write: () => writeProblems(path, problems),
          entry: last.entry,
          stale: !sameList(last.problems, problems),
        };
        if (at === -1) notices.unshift(notice);
        else notices[at] = notice;
      }
      hold(path, notices);
    },
    subscribe: (listener) => emitter.subscribe(listener),
    reveal(path, level) {
      deps.showConsole();
      const shown = (held.get(path) ?? []).filter((notice) => notice.level === level);
      // Clear takes every entry, so those are written again, and so is a
      // problems entry that still lists what has been fixed.
      for (const notice of shown) {
        if (!notice.stale && notice.entry.kept()) continue;
        notice.entry = notice.write();
        notice.stale = false;
      }
      shown[0]?.entry.reveal();
    },
  };
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}
