// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JobView } from "../../../src/protocol/api.ts";
import { createJobsFeed } from "../../../web/flow/jobsFeed.ts";

// The window's one poll of a Flow's jobs, shared by the Tools tab and the
// runs waiting on a clip: who it asks for, what it hands on, and what it
// tells the host it showed or took.

const job = (id: string, fields: Partial<JobView> = {}): JobView => ({
  id,
  kind: "video",
  stage: "running",
  model: "higgsfield/seedance_2_5",
  summary: "Steam rises from the red cup",
  folder: "clips",
  startedAt: 1,
  ...fields,
});

let answers: JobView[][];
let fetchJobs: ReturnType<typeof vi.fn>;
let markJobsShown: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  answers = [];
  fetchJobs = vi.fn(async () => ({ jobs: answers.length > 1 ? (answers.shift() as JobView[]) : (answers[0] ?? []) }));
  markJobsShown = vi.fn(async () => undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

const feed = () => createJobsFeed({ fetchJobs, markJobsShown } as never);

describe("createJobsFeed", () => {
  it("hands a follower each poll, says which ended jobs it showed, and stops once nothing goes on", async () => {
    answers = [[job("live"), job("done", { stage: "saved", file: "clips/a.mp4" })], [job("done", { stage: "saved" })]];
    const seen: string[][] = [];
    const unfollow = feed().follow("v.flow.html", (jobs) => void seen.push(jobs.map((each) => each.id)));
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toEqual([["live", "done"]]);
    expect(markJobsShown).toHaveBeenLastCalledWith(["done"], []);

    await vi.advanceTimersByTimeAsync(5000);
    expect(seen).toEqual([["live", "done"], ["done"]]);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(fetchJobs).toHaveBeenCalledTimes(2);
    unfollow();
  });

  // A clip whose run stopped waiting still shows once the feed sees it saved;
  // a job saved before the feed first saw it going is old news.
  it("tells the views the file of a job it saw going and then saved", async () => {
    answers = [
      [job("going"), job("old", { stage: "saved", file: "clips/old.mp4" })],
      [job("going", { stage: "saved", file: "clips/new.mp4" }), job("old", { stage: "saved", file: "clips/old.mp4" })],
    ];
    const notifyWritten = vi.fn();
    const unfollow = createJobsFeed({ fetchJobs, markJobsShown, notifyWritten } as never).follow(
      "v.flow.html",
      () => [],
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(notifyWritten).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5000);
    expect(notifyWritten).toHaveBeenCalledTimes(1);
    expect(notifyWritten).toHaveBeenCalledWith(["clips/new.mp4"]);
    unfollow();
  });

  // A job a run here waits on may be done by the first poll; its file is told
  // before the run hears the job ended.
  it("tells the views the file of a job a run waits on, saved by the first poll", async () => {
    answers = [[job("waited", { stage: "saved", file: "clips/fast.mp4" })]];
    const notifyWritten = vi.fn();
    const waiting = createJobsFeed({ fetchJobs, markJobsShown, notifyWritten } as never).wait("v.flow.html", "waited");
    await vi.advanceTimersByTimeAsync(5000);
    await waiting;
    expect(notifyWritten).toHaveBeenCalledWith(["clips/fast.mp4"]);
  });

  it("says shown only the ended jobs a follower showed, where it names them", async () => {
    answers = [[job("mine", { stage: "saved" }), job("theirs", { stage: "failed", error: "nope" })]];
    const unfollow = feed().follow("v.flow.html", () => ["mine"]);
    await vi.advanceTimersByTimeAsync(0);
    expect(markJobsShown).toHaveBeenLastCalledWith(["mine"], []);
    unfollow();
  });

  it("hands a waiting run its job once it ends, naming it as waited on until then", async () => {
    answers = [[job("j1")], [job("j1", { stage: "saved", result: "clips/a.mp4" })]];
    const waited = feed().wait("v.flow.html", "j1");
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetchJobs).toHaveBeenNthCalledWith(1, "v.flow.html", ["j1"]);
    await vi.advanceTimersByTimeAsync(5000);
    await expect(waited).resolves.toMatchObject({ id: "j1", stage: "saved", result: "clips/a.mp4" });
    expect(markJobsShown).toHaveBeenLastCalledWith([], ["j1"]);
  });

  it("asks for a waiting run while the window is hidden, and gives up on a job no longer recorded", async () => {
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    answers = [[]];
    const waited = feed().wait("v.flow.html", "gone");
    const failed = expect(waited).rejects.toThrow("The job is no longer recorded");
    await vi.advanceTimersByTimeAsync(15_000);
    await failed;
    expect(fetchJobs).toHaveBeenCalledTimes(3);
  });

  it("ends only the wait a signal stops", async () => {
    answers = [[job("j1")]];
    const stop = new AbortController();
    const waited = feed().wait("v.flow.html", "j1", stop.signal);
    stop.abort(new Error("the page closed"));
    await expect(waited).rejects.toThrow("the page closed");
  });
});
