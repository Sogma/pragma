// The rows the Tools tab lists paid work in, a Flow's runs and jobs and a
// note's toolkit runs alike: what is going, with Cancel and the dialog that
// asks before credits already spent are given up, and how each job ended.
import type { JobView } from "../../src/protocol/api.ts";
import { describeCost } from "../../src/protocol/flowExecutors.ts";
import { basenameOf } from "../../src/protocol/rootedPath.ts";
import { versionWhen } from "../lib/dateText.ts";
import type { DialogService } from "../services/dialog.ts";

const SVG_NS = "http://www.w3.org/2000/svg";

export const isLive = (job: JobView) => job.stage === "starting" || job.stage === "running";

/** What a job of each kind makes, in the lists' words, and how its notices
 * are labelled on the Console. */
export const madeBy = {
  video: { noun: "clip", without: "The job ended without a clip.", kind: "VIDEO", node: "Generate Video" },
  image: { noun: "image", without: "The job ended without an image.", kind: "IMAGE", node: "Generate Image" },
} as const;

/** What a row of something going says. */
export interface LiveParts {
  title: string;
  detail?: string;
  stage: string;
  problem: boolean;
}

function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const clock = (n: number) => String(n).padStart(2, "0");
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours > 0 ? `${hours}:${clock(minutes)}:${clock(seconds % 60)}` : `${minutes}:${clock(seconds % 60)}`;
}

export const modelName = (ref: string) => ref.slice(ref.indexOf("/") + 1);

const startedTitle = (job: JobView) => `${modelName(job.model)} · started ${versionWhen(job.startedAt)}`;

function spinner(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "flow-jobs-spinner");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const circle = document.createElementNS(SVG_NS, "circle");
  circle.setAttribute("cx", "12");
  circle.setAttribute("cy", "12");
  circle.setAttribute("r", "9");
  circle.setAttribute("stroke-dasharray", "42 14");
  svg.appendChild(circle);
  return svg;
}

export function liveStage(job: JobView): string {
  if (job.problem !== undefined) return job.problem;
  if (job.stage === "starting") return "Starting the job";
  const quote = job.quote ? ` · quoted ${describeCost(job.quote)}` : "";
  return `Rendering · ${elapsed(Date.now() - job.startedAt)}${quote}`;
}

/** A live job's row, under `title`, by default its model and start. */
export function jobParts(job: JobView, title = startedTitle(job)): LiveParts {
  return { title, detail: job.summary, stage: liveStage(job), problem: job.problem !== undefined };
}

/** A row of something going; inside a dialog's message, of spans. */
export function liveRow(parts: LiveParts, tag: "div" | "span" = "div"): HTMLElement {
  const el = document.createElement(tag);
  el.className = "flow-jobs-row";
  const thumb = document.createElement("span");
  thumb.className = "flow-jobs-thumb is-running";
  thumb.appendChild(spinner());
  const text = document.createElement("span");
  text.className = "flow-jobs-text";
  const title = document.createElement("span");
  title.className = "flow-jobs-title";
  title.textContent = parts.title;
  text.append(title);
  if (parts.detail) {
    const detail = document.createElement("span");
    detail.className = "flow-jobs-detail";
    detail.textContent = parts.detail;
    text.append(detail);
  }
  const stage = document.createElement("span");
  stage.className = `flow-jobs-stage ${parts.problem ? "is-problem" : "is-live"}`;
  stage.textContent = parts.stage;
  text.append(stage);
  el.append(thumb, text);
  return el;
}

export function cancelButton(label: string, cancel: () => Promise<void>): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "flow-jobs-cancel";
  button.setAttribute("aria-label", label);
  button.dataset.tooltip = label;
  button.addEventListener("click", () => void cancel());
  return button;
}

/** Asks before giving up `job`, whose credits are spent. Before a job
 * starts, nothing is lost, so nobody asks. */
export function confirmCancel(
  confirm: DialogService["confirm"],
  parts: LiveParts,
  job: JobView | undefined,
): Promise<boolean> {
  const quote = job?.quote;
  const spent = quote
    ? `Its ${describeCost(quote)} ${quote.amount === 1 ? "is" : "are"} spent`
    : "Its credits are spent";
  const summary = liveRow(parts, "span");
  summary.classList.add("flow-jobs-summary");
  return confirm({
    title: "Cancel this job?",
    message: [
      summary,
      job
        ? `${job.provider ?? "The provider"} is already making this ${madeBy[job.kind].noun}. ${spent}, and Pragma can't call the job back.`
        : `The provider is already working on it. ${spent}, and Pragma can't call the job back.`,
    ],
    confirmLabel: "Cancel anyway",
    cancelLabel: "Keep running",
    danger: true,
  });
}

/** How a job ended: what it saved, as a button that opens it; a cancel, with
 * what it spent; or why it failed. */
export function endedRow(job: JobView, openPath: (path: string) => void): HTMLElement {
  const saved = job.stage === "saved" && job.file !== undefined;
  const el = document.createElement(saved ? "button" : "div");
  el.className = "flow-jobs-row";
  if (saved) {
    (el as HTMLButtonElement).type = "button";
    el.setAttribute("data-tooltip", `Open the ${madeBy[job.kind].noun}`);
    const file = job.file as string;
    el.addEventListener("click", () => openPath(file));
  }
  const thumb = document.createElement("span");
  thumb.className = `flow-jobs-thumb is-${job.interrupted ? "interrupted" : job.stage}`;
  thumb.dataset.kind = job.kind;
  const text = document.createElement("span");
  text.className = "flow-jobs-text";
  const title = document.createElement("span");
  title.className = "flow-jobs-title";
  const stage = document.createElement("span");
  stage.className = "flow-jobs-stage";
  if (saved) {
    const quote = job.quote ? ` · quoted ${describeCost(job.quote)}` : "";
    title.textContent = basenameOf(job.file as string);
    stage.textContent = `Saved at ${versionWhen(job.endedAt ?? job.startedAt)}${quote}`;
  } else if (job.stage === "cancelled") {
    title.textContent = startedTitle(job);
    stage.textContent = job.quote ? `Cancelled · ${describeCost(job.quote)} spent` : "Cancelled";
  } else {
    title.textContent = startedTitle(job);
    stage.textContent = job.error ?? madeBy[job.kind].without;
    stage.classList.add(job.interrupted ? "is-problem" : "is-failed");
  }
  text.append(title, stage);
  el.append(thumb, text);
  return el;
}

export function section(heading: string, rows: readonly HTMLElement[]): HTMLElement {
  const el = document.createElement("div");
  el.className = "flow-jobs-section";
  const head = document.createElement("div");
  head.className = "section-label flow-jobs-heading";
  head.textContent = heading;
  el.append(head, ...rows);
  return el;
}
