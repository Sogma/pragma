// A document's toolkit runs in the Tools tab, under its buttons: Running,
// each run with the async job it waits on and Cancel, and Finished, the jobs
// those runs started that ended. A job is listed by the Flow that ran it, so
// this follows each such Flow's jobs feed while a run of it, or a job one
// left, goes on, and says shown only the jobs it listed.
//
// A run that asks before a For Each zone's other items start shows the ask
// under its row: what the first item made, then Continue or Stop.
//
// A run stopped by its document leaving its group leaves its job going: the
// host still saves what it makes, so the row stays until the job ends.
import type { JobView } from "../../src/protocol/api.ts";
import { basenameOf, dirnameOf } from "../../src/protocol/rootedPath.ts";
import { imageMediaTypeForPath, videoMediaTypeForPath } from "../../src/protocol/types.ts";
import { cancelJob, rawFileUrl } from "../core/apiClient.ts";
import { stripExtension } from "../core/paths.ts";
import { entryIconAt } from "../core/spaceTree.ts";
import { versionWhen } from "../lib/dateText.ts";
import { setEntryIcon } from "../lib/dom.ts";
import type { DialogService } from "../services/dialog.ts";
import type { ContextMenuService } from "../services/menus.ts";
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
import { createResultClip, type ResultClip } from "./resultClip.ts";
import type { ToolkitAsk } from "./toolkitAction.ts";

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
  // Where an asked clip's More options menu opens.
  contextMenu: ContextMenuService;
  feed?: JobsFeed;
  cancelJob?: typeof cancelJob;
}

/** A run as it starts: its button's label, the document it runs on, its
 * Flow, how to stop it, and how to open a file beside the document without
 * leaving it. */
export interface ToolkitRunStart {
  label: string;
  document: string;
  flowPath: string;
  stop(reason: string): void;
  openToSide(path: string): Promise<void>;
}

export interface ToolkitRuns {
  /** The list, `data-empty` while it has nothing to show. */
  readonly element: HTMLElement;
  /** Lists a run from its click: the hook that hears of its async jobs, the
   * ask it shows under its row, what to call once it ends, and whether the
   * person cancelled it. */
  add(run: ToolkitRunStart): {
    jobStarting: JobStarting;
    ask(ask: ToolkitAsk, signal: AbortSignal): Promise<boolean>;
    ended(): void;
    cancelled(): boolean;
  };
  show(document: string | undefined): void;
  dispose(): void;
}

interface Entry extends ToolkitRunStart {
  startedAt: number;
  jobs: string[];
  starting: number;
  ended: boolean;
  cancelled: boolean;
  // The ask the run waits on, its card built once so a redraw keeps a clip
  // playing.
  asking?: { title: string; card: HTMLElement };
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
    if (entry.asking) return { title, stage: entry.asking.title, problem: false, waiting: true };
    return job ? jobParts(job, deps.modelLists, title) : { title, stage: "Running", problem: false };
  }

  // What the item made, a clip playing in place and a picture shown, each
  // file a click from opening beside the document: opening it in the
  // document's own group would stop the run.
  function askCard(entry: Entry, ask: ToolkitAsk, answer: (go: boolean) => void, clips: ResultClip[]): HTMLElement {
    const card = document.createElement("div");
    card.className = "flow-jobs-ask";
    card.setAttribute("role", "group");
    card.setAttribute("aria-label", ask.title);
    const open = (path: string) => void entry.openToSide(path).catch(() => undefined);
    for (const file of ask.files) {
      if (videoMediaTypeForPath(file)) {
        const clip = createResultClip("flow-jobs-ask-media", open, deps.contextMenu, () => "");
        clip.show(file);
        clips.push(clip);
        card.append(clip.el);
      } else if (imageMediaTypeForPath(file)) {
        const image = document.createElement("img");
        image.className = "flow-jobs-ask-media";
        image.src = rawFileUrl(file);
        image.alt = "";
        image.addEventListener("click", () => open(file));
        card.append(image);
      }
      const link = document.createElement("button");
      link.type = "button";
      link.className = "flow-jobs-ask-file";
      link.dataset.tooltip = file;
      const icon = document.createElement("span");
      setEntryIcon(icon, entryIconAt(file, "file"));
      const folder = document.createElement("span");
      folder.className = "flow-jobs-ask-folder";
      folder.textContent = dirnameOf(file) ? `${dirnameOf(file)}/` : "";
      link.append(icon, folder, stripExtension(basenameOf(file)));
      link.addEventListener("click", () => open(file));
      card.append(link);
    }
    const choice = (className: string, label: string, go: boolean) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = className;
      button.textContent = label;
      button.addEventListener("click", () => answer(go));
      return button;
    };
    const buttons = document.createElement("div");
    buttons.className = "flow-jobs-ask-buttons";
    buttons.append(choice("btn primary", `Continue with ${ask.rest} more`, true), choice("btn", "Stop", false));
    card.append(buttons);
    return card;
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
      .flatMap((entry) => {
        const row = liveRow(parts(entry));
        row.append(cancelButton("Cancel this run", () => cancel(entry)));
        return entry.asking ? [row, entry.asking.card] : [row];
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
    const running = rows.filter((row) => row.classList.contains("flow-jobs-row")).length;
    if (running !== count) {
      count = running;
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
        ask: (ask, signal) =>
          new Promise<boolean>((resolve) => {
            if (signal.aborted) {
              resolve(false);
              return;
            }
            const clips: ResultClip[] = [];
            let open = true;
            const answer = (go: boolean) => {
              if (!open) return;
              open = false;
              signal.removeEventListener("abort", stopped);
              for (const clip of clips) clip.dispose();
              entry.asking = undefined;
              render();
              resolve(go);
            };
            const stopped = () => answer(false);
            entry.asking = { title: ask.title, card: askCard(entry, ask, answer, clips) };
            signal.addEventListener("abort", stopped, { once: true });
            render();
          }),
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
