// The open Flow's runs and paid jobs in the assistant's Tools tab: Running,
// this window's runs and any other job still going, and Finished, the jobs
// that ended while this window watched or since it last looked. The jobs
// come from the window's jobs feed, which the waiting runs share.
//
// A result saved with no run waiting is also a notice on the Flow's status
// bar; one a waiting run already showed is only listed.
import type { JobView } from "../../src/protocol/api.ts";
import { describeCost } from "../../src/protocol/flowExecutors.ts";
import { cancelJob } from "../core/apiClient.ts";
import { versionWhen } from "../lib/dateText.ts";
import type { DialogService } from "../services/dialog.ts";
import type { FileNotices } from "../services/fileNotices.ts";
import type { ModelLists } from "../services/modelLists.ts";
import type { CanvasRunInfo } from "./canvasRun.ts";
import {
  cancelButton,
  confirmCancel,
  endedRow,
  isLive,
  jobParts,
  type LiveParts,
  liveRow,
  liveStage,
  madeBy,
  section,
  settingsLine,
} from "./jobRows.ts";
import { type JobsFeed, jobsFeed } from "./jobsFeed.ts";

export interface FlowJobsDeps {
  notices: Pick<FileNotices, "add">;
  openPath(path: string): void;
  // Asks before Cancel gives up a job whose credits are spent.
  dialog: Pick<DialogService, "confirm">;
  // Where a row names a job's model from, redrawn as a list arrives.
  modelLists: Pick<ModelLists, "get" | "load" | "subscribe">;
  // How many rows Running lists, for the counts beside Run.
  onCount?(count: number): void;
  feed?: JobsFeed;
  cancelJob?: typeof cancelJob;
}

export interface FlowJobs {
  /** The Tools tab's part, `data-empty` while there is nothing to list, and
   * `data-running` the count Running lists. */
  readonly element: HTMLElement;
  show(path: string): void;
  clear(): void;
  /** Every run this window's canvas has going, whichever Flow it is of. */
  setRuns(runs: readonly CanvasRunInfo[]): void;
  dispose(): void;
}

// How long a job just cancelled stays off Running while the host takes the
// cancel: one that failed comes back, to be cancelled again.
const CANCELLING_MS = 15_000;

// A run's job: by its id once the start answered, and before then by the id
// the start went with, which the job carries from the moment it is recorded.
// Matched by id alone, a job starting lists on its own beside its run.
const ofRun = (run: CanvasRunInfo, job: JobView) =>
  run.jobs.includes(job.id) || (job.startId !== undefined && run.starts.includes(job.startId));

export function createFlowJobs(deps: FlowJobsDeps): FlowJobs {
  const feed = deps.feed ?? jobsFeed();
  const element = document.createElement("div");
  element.className = "flow-jobs";
  element.setAttribute("data-empty", "");

  let shown: string | undefined;
  // The shown Flow's jobs at the last poll, and those still going.
  let latest: readonly JobView[] = [];
  let running: JobView[] = [];
  let runs: readonly CanvasRunInfo[] = [];
  let count = 0;
  // Each Flow's Finished list, so going back to a Flow shows it again.
  const finished = new Map<string, JobView[]>();
  // The problems already told, by job and wording, so each is told once.
  const told = new Set<string>();
  // The jobs cancelled here, by id, and those of the starts a cancelled run
  // had sent, by start id: each by when, kept off Running until it ends.
  const cancelling = new Map<string, number>();
  const beingCancelled = (job: JobView) =>
    cancelling.has(job.id) || (job.startId !== undefined && cancelling.has(job.startId));
  let unfollow: (() => void) | undefined;

  function poke(): void {
    if (shown !== undefined) feed.poke(shown);
  }

  // A run with a job started or starting has spent its credits.
  async function cancelRun(run: CanvasRunInfo): Promise<void> {
    const known = run.jobs.map((id) => latest.find((each) => each.id === id));
    const spent = run.startingJob || known.some((job) => job === undefined || isLive(job));
    if (spent && !(await confirmCancel(deps.dialog.confirm, runParts(run), jobsOf(run).find(isLive)))) return;
    for (const id of [...run.jobs, ...run.starts]) cancelling.set(id, Date.now());
    run.cancel();
    poke();
  }

  async function cancelOnItsOwn(path: string, job: JobView): Promise<void> {
    if (!(await confirmCancel(deps.dialog.confirm, jobParts(job, deps.modelLists), job))) return;
    cancelling.set(job.id, Date.now());
    render();
    try {
      await (deps.cancelJob ?? cancelJob)(job.id);
    } catch (error) {
      cancelling.delete(job.id);
      render();
      const content = `Couldn't cancel the job: ${error instanceof Error ? error.message : String(error)}`;
      deps.notices.add(path, "jobs", {
        level: "error",
        kind: madeBy[job.kind].kind,
        label: `${madeBy[job.kind].node} · ${job.model}`,
        content,
        count: 1,
      });
    }
    poke();
  }

  // A run's jobs the feed knows of, newest first: the first is shown on the
  // run's row while it goes.
  function jobsOf(run: CanvasRunInfo): JobView[] {
    return latest.filter((job) => ofRun(run, job)).sort((a, b) => b.startedAt - a.startedAt);
  }

  function runParts(run: CanvasRunInfo): LiveParts {
    const job = jobsOf(run).at(0);
    const live = job !== undefined && isLive(job);
    return {
      title: `Run ${run.number} · started ${versionWhen(run.startedAt)}`,
      detail: job?.summary,
      settings: job && settingsLine(job, deps.modelLists),
      stage: live ? liveStage(job) : run.nodes.length > 0 ? run.nodes.join(", ") : "Starting",
      problem: live && job.problem !== undefined,
    };
  }

  function runRow(run: CanvasRunInfo): HTMLElement {
    const el = liveRow(runParts(run));
    el.append(cancelButton("Cancel this run", () => cancelRun(run)));
    return el;
  }

  function row(job: JobView): HTMLElement {
    if (!isLive(job)) return endedRow(job, deps.openPath, deps.modelLists);
    const el = liveRow(jobParts(job, deps.modelLists));
    const path = shown;
    if (path !== undefined) el.append(cancelButton("Cancel this job", () => cancelOnItsOwn(path, job)));
    return el;
  }

  // A selection in the list, a failure being copied, goes with the rows a
  // redraw replaces, and polls redraw every few seconds while a job runs, so
  // a redraw waits while one is there. A press outside the list ends the
  // wait, since a press on the canvas or a button leaves the selection in
  // place; so does showing another Flow.
  function selectionInList(): boolean {
    const selection = document.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return false;
    return selection.getRangeAt(0).intersectsNode(element);
  }
  let held = false;
  const onSelectionChange = (): void => {
    if (held && !selectionInList()) render();
  };
  const onPointerDown = (event: PointerEvent): void => {
    if (held && !(event.target instanceof Node && element.contains(event.target))) render(true);
  };
  document.addEventListener("selectionchange", onSelectionChange);
  document.addEventListener("pointerdown", onPointerDown, true);

  // Running holds the shown Flow's runs, each with the job it waits on, and
  // the jobs no run here started, newest first.
  function render(force = false): void {
    held = !force && selectionInList();
    if (held) return;
    const mine = runs.filter((run) => run.flowPath === shown);
    const onItsOwn = running.filter((job) => !mine.some((run) => ofRun(run, job)) && !beingCancelled(job));
    const live = [
      ...mine.map((run) => ({ at: run.startedAt, el: () => runRow(run) })),
      ...onItsOwn.map((job) => ({ at: job.startedAt, el: () => row(job) })),
    ]
      .sort((a, b) => b.at - a.at)
      .map((each) => each.el());
    const done = shown === undefined ? [] : (finished.get(shown) ?? []);
    const parts: HTMLElement[] = [];
    if (live.length > 0) parts.push(section("Running", live));
    if (done.length > 0) parts.push(section("Finished", done.map(row)));
    element.replaceChildren(...parts);
    element.toggleAttribute("data-empty", parts.length === 0);
    if (live.length > 0) element.setAttribute("data-running", String(live.length));
    else element.removeAttribute("data-running");
    if (live.length !== count) {
      count = live.length;
      deps.onCount?.(count);
    }
  }

  function tell(path: string, job: JobView): void {
    const { kind, node, without } = madeBy[job.kind];
    const label = `${node} · ${job.model}`;
    if (job.stage === "saved") {
      const quote = job.quote ? ` · Quoted ${describeCost(job.quote)}` : "";
      const content = `Saved with no run waiting${quote} · ${job.file ?? job.folder}`;
      deps.notices.add(path, "jobs", { level: "info", kind, label, content, count: 1 });
    } else {
      const level = job.interrupted ? "warn" : "error";
      deps.notices.add(path, "jobs", { level, kind, label, content: job.error ?? without, count: 1 });
    }
  }

  function accept(path: string, jobs: readonly JobView[]): void {
    latest = jobs;
    running = jobs.filter(isLive);
    for (const [key, at] of cancelling) {
      const job = jobs.find((each) => each.id === key || each.startId === key);
      // The countdown waits while the job starts: the run that started it
      // sends the cancel only once its start answers.
      if (job?.stage === "starting") cancelling.set(key, Date.now());
      else if ((job !== undefined && !isLive(job)) || Date.now() - at > CANCELLING_MS) cancelling.delete(key);
    }
    const list = finished.get(path) ?? [];
    const fresh = jobs.filter((job) => !isLive(job) && !list.some((seen) => seen.id === job.id));
    finished.set(path, [...fresh, ...list]);
    // Cancelling is the person's own doing, so it needs no notice.
    for (const job of fresh) if (!job.delivered && job.stage !== "cancelled") tell(path, job);
    for (const job of running) {
      const key = `${job.id}\n${job.problem ?? ""}`;
      if (job.problem === undefined || told.has(key)) continue;
      told.add(key);
      const { kind, node } = madeBy[job.kind];
      const label = `${node} · ${job.model}`;
      deps.notices.add(path, "jobs", { level: "warn", kind, label, content: job.problem, count: 1 });
    }
    render();
  }

  function stop(): void {
    unfollow?.();
    unfollow = undefined;
  }

  // Subscribed last: it draws at once, and a draw reads the state above.
  const unsubscribe = deps.modelLists.subscribe(() => render());

  return {
    element,
    show(path) {
      if (path === shown) return;
      stop();
      shown = path;
      latest = [];
      running = [];
      render(true);
      unfollow = feed.follow(path, (jobs) => {
        if (path === shown) accept(path, jobs);
        return undefined;
      });
    },
    clear() {
      stop();
      shown = undefined;
      latest = [];
      running = [];
      render(true);
    },
    setRuns(next) {
      // A run new here may start a job: ask for it soon.
      const fresh = next.some((run) => run.flowPath === shown && !runs.some((each) => each.id === run.id));
      runs = next;
      if (fresh && shown !== undefined) feed.poke(shown);
      render();
    },
    dispose() {
      stop();
      unsubscribe();
      document.removeEventListener("selectionchange", onSelectionChange);
      document.removeEventListener("pointerdown", onPointerDown, true);
    },
  };
}
