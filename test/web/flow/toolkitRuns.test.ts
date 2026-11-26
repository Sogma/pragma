// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JobView } from "../../../src/protocol/api.ts";
import { createJobsFeed } from "../../../web/flow/jobsFeed.ts";
import { createToolkitRuns, type ToolkitRuns } from "../../../web/flow/toolkitRuns.ts";
import type { ConfirmOptions } from "../../../web/services/dialog.ts";
import { emptyModelLists } from "../support/emptyModelLists.ts";

// A note's toolkit runs under its buttons: each with the async job it waits
// on, Cancel, the job under Finished once it ends, and a stopped run's job
// listed until it ends.

const job = (id: string, fields: Partial<JobView> = {}): JobView => ({
  id,
  kind: "video",
  stage: "running",
  model: "higgsfield/seedance_2_5",
  provider: "Higgsfield",
  summary: "Shot 4, take 2",
  folder: "renders",
  startedAt: Date.now() - 20_000,
  quote: { amount: 70, unit: "credits" },
  settings: { resolution: "1080p", duration: 8 },
  ...fields,
});

let runs: ToolkitRuns | undefined;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  runs?.dispose();
  runs = undefined;
  vi.useRealTimers();
});

function setUp(answer: JobView[]) {
  const fetchJobs = vi.fn(async () => ({ jobs: answer }));
  const markJobsShown = vi.fn(async (_ids: readonly string[], _taken?: readonly string[]) => undefined);
  const confirm = vi.fn(async (_options: ConfirmOptions) => true);
  const cancelJob = vi.fn(async () => undefined);
  const onCount = vi.fn();
  runs = createToolkitRuns({
    confirm,
    openPath: vi.fn(),
    onCount,
    feed: createJobsFeed({ fetchJobs, markJobsShown }),
    cancelJob,
    modelLists: emptyModelLists(),
  });
  const stop = vi.fn();
  const add = (label: string, document = "shots.md") =>
    (runs as ToolkitRuns).add({ label, document, flowPath: "kite.flow.html", stop });
  return { element: runs.element, runs, add, stop, fetchJobs, markJobsShown, confirm, cancelJob, onCount };
}

const texts = (element: HTMLElement, selector: string) =>
  [...element.querySelectorAll(selector)].map((each) => each.textContent);

describe("createToolkitRuns", () => {
  it("shows a run's job on its row, asks before cancelling it, and lists it under Finished once it ends", async () => {
    const answer = [job("j1"), job("canvas", { stage: "saved", file: "renders/x.mp4" })];
    const { element, runs, add, stop, markJobsShown, confirm, cancelJob } = setUp(answer);
    runs.show("shots.md");
    const listed = add("Another take");
    listed.jobStarting("start-1")("j1");
    await vi.advanceTimersByTimeAsync(2000);
    expect(texts(element, ".flow-jobs-title")[0]).toMatch(/^Another take · started /);
    expect(texts(element, ".flow-jobs-detail")).toEqual(["Shot 4, take 2"]);
    expect(texts(element, ".flow-jobs-settings")).toEqual(["seedance_2_5 · 1080p · 8 s"]);
    expect(texts(element, ".flow-jobs-stage")).toEqual(["Generating · 0:20 · quoted 70 credits"]);
    // A job of the same Flow no run here started is another list's to show.
    expect(markJobsShown.mock.calls.flatMap(([ids]) => ids)).not.toContain("canvas");

    (element.querySelector(".flow-jobs-cancel") as HTMLButtonElement).click();
    await vi.advanceTimersByTimeAsync(0);
    expect((confirm.mock.calls[0][0].message as unknown[])[1]).toBe(
      "Higgsfield is already making this clip. Its 70 credits are spent, and Pragma can't call the job back.",
    );
    expect(stop).toHaveBeenCalledWith("The run was cancelled");
    expect(cancelJob).toHaveBeenCalledWith("j1");
    expect(element.querySelector(".flow-jobs-cancel")).toBeNull();

    listed.ended();
    answer.splice(0, 1, job("j1", { stage: "cancelled", endedAt: Date.now() }));
    await vi.advanceTimersByTimeAsync(2000);
    expect(texts(element, ".flow-jobs-stage")).toEqual(["Cancelled · 70 credits spent"]);
    expect(markJobsShown).toHaveBeenLastCalledWith(["j1"], []);
  });

  it("cancels a run that has spent nothing at once", async () => {
    const { element, runs, add, stop, confirm, onCount } = setUp([]);
    runs.show("shots.md");
    add("Make clip");
    expect(onCount).toHaveBeenLastCalledWith(1);
    (element.querySelector(".flow-jobs-cancel") as HTMLButtonElement).click();
    await vi.advanceTimersByTimeAsync(0);
    expect(confirm).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalledWith("The run was cancelled");
    expect(onCount).toHaveBeenLastCalledWith(0);
  });

  it("keeps a stopped run's row while its job goes on, on its own document only, until the clip lands", async () => {
    const answer = [job("j2")];
    const { element, runs, add, onCount } = setUp(answer);
    runs.show("shots.md");
    const listed = add("Make clip");
    listed.jobStarting("start-2")("j2");
    listed.ended();
    await vi.advanceTimersByTimeAsync(2000);
    expect(texts(element, ".flow-jobs-stage")).toEqual(["Generating · 0:20 · quoted 70 credits"]);

    runs.show("other.md");
    expect(element.hasAttribute("data-empty")).toBe(true);
    expect(onCount).toHaveBeenLastCalledWith(0);
    runs.show("shots.md");
    expect(onCount).toHaveBeenLastCalledWith(1);

    answer.splice(0, 1, job("j2", { stage: "saved", file: "renders/kite-3f2a.mp4", endedAt: Date.now() }));
    await vi.advanceTimersByTimeAsync(5000);
    expect(texts(element, ".flow-jobs-heading")).toEqual(["Finished"]);
    expect(texts(element, ".flow-jobs-title")).toEqual(["kite-3f2a.mp4"]);
  });
});
