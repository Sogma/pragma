// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { JobView } from "../../../src/protocol/api.ts";
import type { CanvasRunInfo } from "../../../web/flow/canvasRun.ts";
import { createFlowJobs, type FlowJobs } from "../../../web/flow/flowJobs.ts";
import { createJobsFeed } from "../../../web/flow/jobsFeed.ts";
import type { ConfirmOptions } from "../../../web/services/dialog.ts";

// The open Flow's paid jobs in the Tools tab: Running and Finished, a notice
// for a clip saved with nobody waiting, and the ended jobs said shown.

const live = (id: string, fields: Partial<JobView> = {}): JobView => ({
  id,
  kind: "video",
  stage: "running",
  model: "higgsfield/seedance_2_5",
  summary: "Steam rises from the red cup",
  folder: "clips",
  startedAt: Date.now() - 48_000,
  quote: { amount: 70, unit: "credits" },
  ...fields,
});

let jobs: FlowJobs | undefined;

afterEach(() => {
  jobs?.dispose();
  jobs = undefined;
});

function setUp(answer: JobView[]) {
  const add = vi.fn();
  const openPath = vi.fn();
  const onCount = vi.fn();
  const fetchJobs = vi.fn(async () => ({ jobs: answer }));
  const markJobsShown = vi.fn(async () => undefined);
  const feed = createJobsFeed({ fetchJobs, markJobsShown });
  const confirm = vi.fn(async (_options: ConfirmOptions) => true);
  const cancelJob = vi.fn(async () => undefined);
  jobs = createFlowJobs({ notices: { add }, openPath, onCount, feed, dialog: { confirm }, cancelJob });
  return { add, openPath, onCount, feed, confirm, cancelJob, fetchJobs, markJobsShown, element: jobs.element };
}

const run = (id: number, fields: Partial<CanvasRunInfo> = {}): CanvasRunInfo => ({
  id,
  number: id,
  flowPath: "v.flow.html",
  startedAt: Date.now(),
  jobs: [],
  startingJob: false,
  nodes: [],
  cancel: vi.fn(),
  ...fields,
});

const texts = (element: HTMLElement, selector: string) =>
  [...element.querySelectorAll(selector)].map((each) => each.textContent);

describe("createFlowJobs", () => {
  it("lists nothing, and says so, until a Flow with jobs shows", async () => {
    const { element, fetchJobs } = setUp([]);
    expect(element.hasAttribute("data-empty")).toBe(true);
    jobs?.show("v.flow.html");
    await vi.waitFor(() => expect(fetchJobs).toHaveBeenCalledWith("v.flow.html", []));
    expect(element.hasAttribute("data-empty")).toBe(true);
  });

  it("lists running and ended jobs, tells only a clip saved with nobody waiting, and says them shown", async () => {
    const { element, add, markJobsShown, openPath } = setUp([
      live("a"),
      live("b", { stage: "saved", file: "clips/video-b.mp4", endedAt: Date.now() }),
      live("c", { stage: "saved", file: "clips/video-c.mp4", endedAt: Date.now(), delivered: true }),
      live("d", { stage: "failed", error: 'Higgsfield\'s job ended as "nsfw".', endedAt: Date.now() }),
    ]);
    jobs?.show("v.flow.html");
    await vi.waitFor(() => expect(element.hasAttribute("data-empty")).toBe(false));
    expect(texts(element, ".flow-jobs-heading")).toEqual(["Running", "Finished"]);
    expect(texts(element, ".flow-jobs-title")[0]).toMatch(/^seedance_2_5 · started /);
    expect(texts(element, ".flow-jobs-stage")[0]).toBe("Rendering · 0:48 · quoted 70 credits");
    expect(texts(element, ".flow-jobs-title").slice(1, 3)).toEqual(["video-b.mp4", "video-c.mp4"]);

    expect(add.mock.calls.map(([path, source, notice]) => [path, source, notice.level, notice.content])).toEqual([
      ["v.flow.html", "jobs", "info", "Saved with no run waiting · Quoted 70 credits · clips/video-b.mp4"],
      ["v.flow.html", "jobs", "error", 'Higgsfield\'s job ended as "nsfw".'],
    ]);
    expect(markJobsShown).toHaveBeenCalledWith(["b", "c", "d"], []);

    (element.querySelector("button.flow-jobs-row") as HTMLButtonElement).click();
    expect(openPath).toHaveBeenCalledWith("clips/video-b.mp4");
  });

  it("tells a live job's problem once, and shows it in place of the stage", async () => {
    const problem = "Can't reach the provider: fetch failed. Checking again.";
    const { element, add } = setUp([live("a", { problem })]);
    jobs?.show("v.flow.html");
    await vi.waitFor(() => expect(texts(element, ".flow-jobs-stage")).toEqual([problem]));
    jobs?.show("other.flow.html");
    jobs?.show("v.flow.html");
    await vi.waitFor(() => expect(texts(element, ".flow-jobs-stage")).toEqual([problem]));
    expect(add).toHaveBeenCalledTimes(1);
    expect(add.mock.calls[0][2]).toMatchObject({ level: "warn", content: problem });
  });

  it("lists the Flow's runs here with the job each waits on, then the jobs no run here started, and counts them", async () => {
    const { element, onCount, feed } = setUp([live("a", { summary: "A kite at dusk" }), live("b")]);
    const poke = vi.spyOn(feed, "poke");
    jobs?.show("v.flow.html");
    await vi.waitFor(() => expect(element.getAttribute("data-running")).toBe("2"));
    expect(onCount).toHaveBeenLastCalledWith(2);

    jobs?.setRuns([
      run(1, { startedAt: Date.now() - 20_000, jobs: ["a"], nodes: ["Generate Video (AI)"] }),
      run(2, { startedAt: Date.now() - 10_000, nodes: ["Generate Text (AI)"] }),
      run(3, { flowPath: "other.flow.html" }),
    ]);
    expect(poke).toHaveBeenCalledWith("v.flow.html");
    const titles = texts(element, ".flow-jobs-title");
    expect(titles).toHaveLength(3);
    expect(titles[0]).toMatch(/^Run 2 · started /);
    expect(titles[1]).toMatch(/^Run 1 · started /);
    expect(titles[2]).toMatch(/^seedance_2_5 · started /);
    expect(texts(element, ".flow-jobs-detail")).toEqual(["A kite at dusk", "Steam rises from the red cup"]);
    expect(texts(element, ".flow-jobs-stage")).toEqual([
      "Generate Text (AI)",
      "Rendering · 0:48 · quoted 70 credits",
      "Rendering · 0:48 · quoted 70 credits",
    ]);
    expect(element.getAttribute("data-running")).toBe("3");
    expect(onCount).toHaveBeenLastCalledWith(3);

    // Its runs ended, a job still going lists on its own.
    poke.mockClear();
    jobs?.setRuns([]);
    expect(poke).not.toHaveBeenCalled();
    expect(texts(element, ".flow-jobs-title").every((title) => title?.startsWith("seedance_2_5"))).toBe(true);
    expect(element.getAttribute("data-running")).toBe("2");
    expect(onCount).toHaveBeenLastCalledWith(2);
  });

  // Polls redraw the list every few seconds while a job runs, and a redraw
  // would take a selection in it, a failure being copied, with the rows.
  it("holds its redraws while a selection is in the list, until a press outside or the selection ends", async () => {
    const { element } = setUp([
      live("a"),
      live("d", { stage: "failed", error: "Out of credits.", endedAt: Date.now() }),
    ]);
    document.body.append(element);
    const outside = document.createElement("div");
    document.body.append(outside);
    const failure = () =>
      [...element.querySelectorAll<HTMLElement>(".flow-jobs-stage")].find(
        (each) => each.textContent === "Out of credits.",
      );
    const select = (node: Node) => {
      const range = document.createRange();
      range.selectNodeContents(node);
      document.getSelection()?.removeAllRanges();
      document.getSelection()?.addRange(range);
    };
    try {
      jobs?.show("v.flow.html");
      await vi.waitFor(() => expect(failure()).toBeDefined());

      const unselected = failure() as HTMLElement;
      jobs?.setRuns([]);
      expect(unselected.isConnected).toBe(false);

      const selected = failure() as HTMLElement;
      select(selected);
      jobs?.setRuns([]);
      expect(selected.isConnected).toBe(true);
      selected.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      expect(selected.isConnected).toBe(true);
      outside.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      expect(selected.isConnected).toBe(false);

      const again = failure() as HTMLElement;
      select(again);
      jobs?.setRuns([]);
      document.getSelection()?.removeAllRanges();
      document.dispatchEvent(new Event("selectionchange"));
      expect(again.isConnected).toBe(false);

      // Another Flow's list draws at once, whatever is selected.
      select(failure() as HTMLElement);
      jobs?.show("other.flow.html");
      expect(element.hasAttribute("data-empty")).toBe(true);
    } finally {
      document.getSelection()?.removeAllRanges();
      element.remove();
      outside.remove();
    }
  });

  it("says nothing runs once nothing does", async () => {
    const { element, onCount } = setUp([]);
    jobs?.show("v.flow.html");
    jobs?.setRuns([run(1)]);
    expect(texts(element, ".flow-jobs-stage")).toEqual(["Starting"]);
    jobs?.setRuns([]);
    expect(element.hasAttribute("data-running")).toBe(false);
    expect(element.hasAttribute("data-empty")).toBe(true);
    expect(onCount.mock.calls).toEqual([[1], [0]]);
  });

  it("cancels a run that has spent nothing at once, and asks first about one whose job is going", async () => {
    const { element, confirm } = setUp([live("a", { provider: "Higgsfield" })]);
    jobs?.show("v.flow.html");
    await vi.waitFor(() => expect(element.getAttribute("data-running")).toBe("1"));
    const idle = run(1, { startedAt: Date.now() - 1000 });
    const paying = run(2, { jobs: ["a"] });
    jobs?.setRuns([idle, paying]);
    const cancelOf = (index: number) => element.querySelectorAll<HTMLButtonElement>(".flow-jobs-cancel")[index];
    expect(cancelOf(0).getAttribute("aria-label")).toBe("Cancel this run");

    cancelOf(1).click();
    await vi.waitFor(() => expect(idle.cancel).toHaveBeenCalled());
    expect(confirm).not.toHaveBeenCalled();

    confirm.mockResolvedValueOnce(false);
    cancelOf(0).click();
    await vi.waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    expect(paying.cancel).not.toHaveBeenCalled();
    const asked = confirm.mock.calls[0][0];
    expect(asked).toMatchObject({
      title: "Cancel this job?",
      confirmLabel: "Cancel anyway",
      cancelLabel: "Keep running",
      danger: true,
    });
    const [summary, line] = asked.message as [HTMLElement, string];
    expect(summary.textContent).toMatch(
      /^Run 2 · started .*Steam rises from the red cupRendering · 0:48 · quoted 70 credits$/,
    );
    expect(line).toBe(
      "Higgsfield is already making this clip. Its 70 credits are spent, and Pragma can't call the job back.",
    );

    cancelOf(0).click();
    await vi.waitFor(() => expect(paying.cancel).toHaveBeenCalled());
  });

  it("asks before cancelling a job no run here started, and lists it cancelled once it ends, telling nothing", async () => {
    const answer = [live("b")];
    const { element, confirm, cancelJob, add } = setUp(answer);
    jobs?.show("v.flow.html");
    await vi.waitFor(() => expect(element.querySelectorAll(".flow-jobs-cancel")).toHaveLength(1));
    const cancel = element.querySelector(".flow-jobs-cancel") as HTMLButtonElement;
    expect(cancel.getAttribute("aria-label")).toBe("Cancel this job");
    cancel.click();
    await vi.waitFor(() => expect(cancelJob).toHaveBeenCalledWith("b"));
    expect(confirm.mock.calls[0][0].message).toContain(
      "The provider is already making this clip. Its 70 credits are spent, and Pragma can't call the job back.",
    );
    expect(element.hasAttribute("data-running")).toBe(false);

    answer.splice(0, 1, live("b", { stage: "cancelled", endedAt: Date.now() }));
    jobs?.show("other.flow.html");
    jobs?.show("v.flow.html");
    await vi.waitFor(() => expect(texts(element, ".flow-jobs-stage")).toEqual(["Cancelled · 70 credits spent"]));
    expect(add).not.toHaveBeenCalled();
  });

  it("says image where the job made an image, in its rows, its dialog and its notices", async () => {
    const answer = [
      live("a", { kind: "image", provider: "Higgsfield" }),
      live("b", { kind: "image", stage: "failed", endedAt: Date.now() }),
      live("c", { kind: "image", stage: "saved", file: "art/image-c.png", endedAt: Date.now() }),
    ];
    const { element, add, confirm } = setUp(answer);
    jobs?.show("v.flow.html");
    await vi.waitFor(() => expect(element.querySelectorAll(".flow-jobs-cancel")).toHaveLength(1));
    expect(texts(element, ".flow-jobs-stage")).toContain("The job ended without an image.");
    expect(element.querySelector("button.flow-jobs-row")?.getAttribute("data-tooltip")).toBe("Open the image");
    expect(add.mock.calls.map(([, , notice]) => [notice.kind, notice.label])).toEqual([
      ["IMAGE", "Generate Image · higgsfield/seedance_2_5"],
      ["IMAGE", "Generate Image · higgsfield/seedance_2_5"],
    ]);
    (element.querySelector(".flow-jobs-cancel") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(confirm).toHaveBeenCalled());
    expect((confirm.mock.calls[0][0].message as unknown[])[1]).toBe(
      "Higgsfield is already making this image. Its 70 credits are spent, and Pragma can't call the job back.",
    );
  });
});
