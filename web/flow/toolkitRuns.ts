// A note's toolkit runs in the Tools tab, under its buttons: Running, each
// run with the paid job it waits on and Cancel, and Finished, the jobs those
// runs started that ended. A job is listed by the Flow that ran it, so this
// follows each such Flow's jobs feed while a run of it, or a job one left,
// goes on, and says shown only the jobs it listed.
//
// A run stopped by its document leaving its group leaves its job going: the
// host still saves what it makes, so the row stays until the job ends.
import type { JobView } from "../../src/protocol/api.ts";
import { cancelJob } from "../core/apiClient.ts";
import { versionWhen } from "../lib/dateText.ts";
import type { DialogService } from "../services/dialog.ts";
import type { ModelLists } from "../services/modelLists.ts";
import type { JobStarting } from "./browserEnvironment.ts";
import {
  cancelButton,
  confirmCancel,
  endedRow,
  isLive,
  jobParts,
  type LiveParts,
  liveRow,
  section,
} from "./jobRows.ts";
import { type JobsFeed, jobsFeed } from "./jobsFeed.ts";

// Polls a job a stopped run left may be missing from before it counts as
// gone: another window may have shown it and had the host forget it.
const MISSES = 3;

export interface ToolkitRunsDeps {
  // Asks before Cancel gives up a job whose credits are spent.
  confirm: DialogService["confirm"];
  openPath(path: string): void;
  // How many rows Running lists for the shown document.
  onCount(count: number): void;
  // Where a row names a job's model from, redrawn as a list arrives.
  modelLists: Pick<ModelLists, "get" | "load" | "subscribe">;
  feed?: JobsFeed;
  cancelJob?: typeof cancelJob;
}

/** A run as it starts: its button's label, the note it runs on, its Flow,
 * and how to stop it. */
export interface ToolkitRunStart {
  label: string;
  document: string;
  flowPath: string;
  stop(reason: string): void;
}

export interface ToolkitRuns {
  /** The list, `data-empty` while it has nothing to show. */
  readonly element: HTMLElement;
  /** Lists a run from its click: the hook that hears of its paid jobs, what
   * to call once it ends, and whether the person cancelled it. */
  add(run: ToolkitRunStart): { jobStarting: JobStarting; ended(): void; cancelled(): boolean };
  show(document: string | undefined): void;
  dispose(): void;
}

interface Entry extends ToolkitRunStart {
  startedAt: number;
  jobs: string[];
  starting: number;
  ended: boolean;
  cancelled: boolean;
}

export function createToolkitRuns(deps: ToolkitRunsDeps): ToolkitRuns {
  const feed = deps.feed ?? jobsFeed();
  const element = document.createElement("div");
  element.className = "flow-jobs";
  element.setAttribute("data-empty", "");

  let shown: string | undefined;
  let count = 0;
  const entries: Entry[] = [];
  // Each Flow's jobs at its last poll, and the ones seen ended or gone.
  const latest = new Map<string, readonly JobView[]>();
  const over = new Set<string>();
  const misses = new Map<string, number>();
  // Each document's Finished list, newest first.
  const finished = new Map<string, JobView[]>();
  const follows = new Map<string, () => void>();

  const jobView = (entry: Entry, id: string) => latest.get(entry.flowPath)?.find((each) => each.id === id);
  // Followed while it may still start a job or one it started hasn't ended,
  // a cancelled run's too, whose job then ends cancelled; listed while that
  // holds and it isn't cancelled.
  const followed = (entry: Entry) => !entry.ended || entry.starting > 0 || entry.jobs.some((id) => !over.has(id));
  const goingOn = (entry: Entry) => !entry.cancelled && followed(entry);

  // The job a run's row shows: its newest one still going.
  const liveJob = (entry: Entry) =>
    entry.jobs.map((id) => jobView(entry, id)).findLast((job): job is JobView => job !== undefined && isLive(job));

  function parts(entry: Entry): LiveParts {
    const job = liveJob(entry);
    const title = `${entry.label} · started ${versionWhen(entry.startedAt)}`;
    return job ? jobParts(job, deps.modelLists, title) : { title, stage: "Running", problem: false };
  }

  // A run with a job started or starting has spent its credits.
  async function cancel(entry: Entry): Promise<void> {
    const spent = entry.starting > 0 || entry.jobs.some((id) => !over.has(id));
    if (spent && !(await confirmCancel(deps.confirm, parts(entry), liveJob(entry)))) return;
    entry.cancelled = true;
    entry.stop("The run was cancelled");
    for (const id of entry.jobs) if (!over.has(id)) void (deps.cancelJob ?? cancelJob)(id).catch(() => undefined);
    feed.poke(entry.flowPath);
    render();
  }

  function render(): void {
    const rows = entries
      .filter((entry) => entry.document === shown && goingOn(entry))
      .sort((a, b) => b.startedAt - a.startedAt)
      .map((entry) => {
        const row = liveRow(parts(entry));
        row.append(cancelButton("Cancel this run", () => cancel(entry)));
        return row;
      });
    const done = shown === undefined ? [] : (finished.get(shown) ?? []);
    const sections: HTMLElement[] = [];
    if (rows.length > 0) sections.push(section("Running", rows));
    if (done.length > 0)
      sections.push(
        section(
          "Finished",
          done.map((job) => endedRow(job, deps.openPath, deps.modelLists)),
        ),
      );
    element.replaceChildren(...sections);
    element.toggleAttribute("data-empty", sections.length === 0);
    if (rows.length !== count) {
      count = rows.length;
      deps.onCount(count);
    }
  }

  function accept(flowPath: string, jobs: readonly JobView[]): string[] {
    latest.set(flowPath, jobs);
    const listed: string[] = [];
    for (const entry of entries) {
      if (entry.flowPath !== flowPath) continue;
      for (const id of entry.jobs) {
        const job = jobs.find((each) => each.id === id);
        if (job && !isLive(job)) {
          listed.push(id);
          if (!over.has(id)) finished.set(entry.document, [job, ...(finished.get(entry.document) ?? [])]);
          over.add(id);
        } else if (!job && entry.ended && !over.has(id) && (misses.get(id) ?? 0) + 1 >= MISSES) {
          over.add(id);
        } else if (!job && entry.ended) {
          misses.set(id, (misses.get(id) ?? 0) + 1);
        }
      }
    }
    refollow();
    render();
    return listed;
  }

  // Follows each Flow a followed run came from, and only those, and lets go
  // of a run once nothing of it is left to follow.
  function refollow(): void {
    for (let index = entries.length - 1; index >= 0; index--) if (!followed(entries[index])) entries.splice(index, 1);
    const wanted = new Set(entries.map((entry) => entry.flowPath));
    for (const [flowPath, unfollow] of follows) {
      if (wanted.has(flowPath)) continue;
      unfollow();
      follows.delete(flowPath);
    }
    for (const flowPath of wanted) {
      if (!follows.has(flowPath))
        follows.set(
          flowPath,
          feed.follow(flowPath, (jobs) => accept(flowPath, jobs)),
        );
    }
  }

  // Subscribed last: it draws at once, and a draw reads the state above.
  const unsubscribe = deps.modelLists.subscribe(() => render());

  return {
    element,
    add(run) {
      const entry: Entry = { ...run, startedAt: Date.now(), jobs: [], starting: 0, ended: false, cancelled: false };
      entries.push(entry);
      refollow();
      render();
      return {
        jobStarting: () => {
          entry.starting++;
          render();
          return (job) => {
            entry.starting--;
            if (job !== undefined) entry.jobs.push(job);
            if (job !== undefined && entry.cancelled) void (deps.cancelJob ?? cancelJob)(job).catch(() => undefined);
            feed.poke(entry.flowPath);
            render();
          };
        },
        ended() {
          entry.ended = true;
          refollow();
          render();
        },
        cancelled: () => entry.cancelled,
      };
    },
    show(document) {
      shown = document;
      render();
    },
    dispose() {
      unsubscribe();
      for (const unfollow of follows.values()) unfollow();
      follows.clear();
    },
  };
}
