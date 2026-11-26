// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { JobView, VideoModelsResponse } from "../../../src/protocol/api.ts";
import type { CanvasRunInfo } from "../../../web/flow/canvasRun.ts";
import { createFlowJobs, type FlowJobs } from "../../../web/flow/flowJobs.ts";
import { createJobsFeed } from "../../../web/flow/jobsFeed.ts";
import type { ConfirmOptions } from "../../../web/services/dialog.ts";
import type { ModelLists } from "../../../web/services/modelLists.ts";
import { emptyModelLists } from "../support/emptyModelLists.ts";

// The open Flow's async jobs in the Tools tab: Running and Finished, a notice
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
  settings: { resolution: "720p", duration: 5, aspectRatio: "16:9" },
  ...fields,
});

// Model lists whose video list comes when a test hands it over, as a
// picker's fetch would land.
function arrivingLists() {
  let video: VideoModelsResponse | undefined;
  const listeners = new Set<() => void>();
  const lists = {
    ...emptyModelLists(),
    get: ((kind: string) => (kind === "video" ? video : undefined)) as ModelLists["get"],
    load: vi.fn(),
    subscribe(listener: () => void) {
      listeners.add(listener);
      listener();
      return () => {
        listeners.delete(listener);
      };
    },
  };
  const arrive = (list: VideoModelsResponse) => {
    video = list;
    for (const listener of listeners) listener();
  };
  return { lists, arrive };
}

let jobs: FlowJobs | undefined;

afterEach(() => {
  jobs?.dispose();
  jobs = undefined;
});

function setUp(answer: JobView[], modelLists: ModelLists = emptyModelLists()) {
  const add = vi.fn();
  const openPath = vi.fn();
  const onCount = vi.fn();
  const fetchJobs = vi.fn(async () => ({ jobs: answer }));
  const markJobsShown = vi.fn(async () => undefined);
  const feed = createJobsFeed({ fetchJobs, markJobsShown });
  const confirm = vi.fn(async (_options: ConfirmOptions) => true);
  const cancelJob = vi.fn(async () => undefined);
  jobs = createFlowJobs({ notices: { add }, openPath, onCount, feed, dialog: { confirm }, cancelJob, modelLists });
  return { add, openPath, onCount, feed, confirm, cancelJob, fetchJobs, markJobsShown, element: jobs.element };
}

const run = (id: number, fields: Partial<CanvasRunInfo> = {}): CanvasRunInfo => ({
  id,
  number: id,
  flowPath: "v.flow.html",
  startedAt: Date.now(),
  jobs: [],
  starts: [],
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
    expect(texts(element, ".flow-jobs-title")[0]).toMatch(/^Generate Video · started /);
    expect(texts(element, ".flow-jobs-stage")[0]).toBe("Generating · 0:48 · quoted 70 credits");
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
    expect(titles[2]).toMatch(/^Generate Video · started /);
    expect(texts(element, ".flow-jobs-detail")).toEqual(["A kite at dusk", "Steam rises from the red cup"]);
    expect(texts(element, ".flow-jobs-settings")).toEqual([
      "seedance_2_5 · 720p · 5 s · 16:9",
      "seedance_2_5 · 720p · 5 s · 16:9",
    ]);
    expect(texts(element, ".flow-jobs-stage")).toEqual([
      "Generate Text (AI)",
      "Generating · 0:48 · quoted 70 credits",
      "Generating · 0:48 · quoted 70 credits",
    ]);
    expect(element.getAttribute("data-running")).toBe("3");
    expect(onCount).toHaveBeenLastCalledWith(3);

    // Its runs ended, a job still going lists on its own.
    poke.mockClear();
    jobs?.setRuns([]);
    expect(poke).not.toHaveBeenCalled();
    expect(texts(element, ".flow-jobs-title").every((title) => title?.startsWith("Generate Video"))).toBe(true);
    expect(element.getAttribute("data-running")).toBe("2");
    expect(onCount).toHaveBeenLastCalledWith(2);
  });

  // The host records a job before its provider takes it, and the run hears
  // the job's id only once the provider has.
  it("lists a job a run here is starting on that run's row, by the id its start went with", async () => {
    const { element } = setUp([
      live("a", { stage: "starting", startId: "start-1", quote: undefined }),
      live("b", { stage: "starting", startId: "start-elsewhere", quote: undefined, summary: "A kite at dusk" }),
    ]);
    jobs?.show("v.flow.html");
    jobs?.setRuns([run(1, { starts: ["start-1"], startingJob: true, nodes: ["Generate Video (AI)"] })]);
    await vi.waitFor(() =>
      expect(texts(element, ".flow-jobs-detail")).toEqual(["Steam rises from the red cup", "A kite at dusk"]),
    );
    const titles = texts(element, ".flow-jobs-title");
    expect(titles[0]).toMatch(/^Run 1 · started /);
    expect(titles[1]).toMatch(/^Generate Video · started /);
    expect(texts(element, ".flow-jobs-settings")).toEqual([
      "seedance_2_5 · 720p · 5 s · 16:9",
      "seedance_2_5 · 720p · 5 s · 16:9",
    ]);
    expect(texts(element, ".flow-jobs-stage")).toEqual(["Starting the job", "Starting the job"]);
    expect(element.getAttribute("data-running")).toBe("2");
  });

  it("keeps the job a cancelled run was starting off Running while it starts, and for the usual wait after", async () => {
    const answer = [live("a", { stage: "starting", startId: "start-1", quote: undefined })];
    const { element, confirm } = setUp(answer);
    jobs?.show("v.flow.html");
    const starting = run(1, { starts: ["start-1"], startingJob: true });
    jobs?.setRuns([starting]);
    await vi.waitFor(() => expect(texts(element, ".flow-jobs-stage")).toEqual(["Starting the job"]));
    (element.querySelector(".flow-jobs-cancel") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(starting.cancel).toHaveBeenCalled());
    const [summary] = confirm.mock.calls[0][0].message as [HTMLElement, string];
    expect(summary.textContent).toContain(
      "Steam rises from the red cupseedance_2_5 · 720p · 5 s · 16:9Starting the job",
    );
    jobs?.setRuns([]);
    expect(element.hasAttribute("data-running")).toBe(false);

    // Each poll draws the list afresh, and the clip it lists as saved says it landed.
    const poll = async (job: JobView, landed: string) => {
      const saved = live(landed, { stage: "saved", file: `clips/${landed}.mp4`, endedAt: Date.now() });
      answer.splice(0, answer.length, job, saved);
      jobs?.show("other.flow.html");
      jobs?.show("v.flow.html");
      await vi.waitFor(() => expect(texts(element, ".flow-jobs-title")).toContain(`${landed}.mp4`));
    };
    const now = Date.now();
    const clock = vi.spyOn(Date, "now");
    try {
      clock.mockReturnValue(now + 60_000);
      await poll(live("a", { stage: "starting", startId: "start-1" }), "x");
      expect(element.hasAttribute("data-running")).toBe(false);

      // Started, it waits for the run's cancel; one that never lands brings it back.
      clock.mockReturnValue(now + 70_000);
      await poll(live("a", { startId: "start-1" }), "y");
      expect(element.hasAttribute("data-running")).toBe(false);
      clock.mockReturnValue(now + 80_000);
      await poll(live("a", { startId: "start-1" }), "z");
      expect(element.getAttribute("data-running")).toBe("1");
      expect(element.querySelector(".flow-jobs-cancel")?.getAttribute("aria-label")).toBe("Cancel this job");
    } finally {
      clock.mockRestore();
    }
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
      /^Run 2 · started .*Steam rises from the red cupseedance_2_5 · 720p · 5 s · 16:9Generating · 0:48 · quoted 70 credits$/,
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
      live("a", { kind: "image", provider: "Higgsfield", settings: { aspectRatio: "3:2" } }),
      live("b", { kind: "image", stage: "failed", endedAt: Date.now() }),
      live("c", { kind: "image", stage: "saved", file: "art/image-c.png", endedAt: Date.now() }),
    ];
    const { element, add, confirm } = setUp(answer);
    jobs?.show("v.flow.html");
    await vi.waitFor(() => expect(element.querySelectorAll(".flow-jobs-cancel")).toHaveLength(1));
    expect(texts(element, ".flow-jobs-title")[0]).toMatch(/^Generate Image · started /);
    expect(texts(element, ".flow-jobs-settings")[0]).toBe("seedance_2_5 · 3:2");
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

  it("says what each job makes under its prompt, naming the model as its picker does once the list comes", async () => {
    const { lists, arrive } = arrivingLists();
    const { element } = setUp(
      [
        live("a"),
        live("b", { stage: "saved", file: "clips/video-b.mp4", endedAt: Date.now(), delivered: true }),
        live("c", { stage: "cancelled", endedAt: Date.now(), settings: undefined }),
      ],
      lists,
    );
    jobs?.show("v.flow.html");
    await vi.waitFor(() => expect(texts(element, ".flow-jobs-settings")).toHaveLength(3));
    expect(lists.load).toHaveBeenCalledWith("video");
    const lines = [...element.querySelectorAll(".flow-jobs-text")].map((text) =>
      [...text.children].map((line) => line.className.split(" ")[0]),
    );
    expect(lines).toEqual([
      ["flow-jobs-title", "flow-jobs-detail", "flow-jobs-settings", "flow-jobs-stage"],
      ["flow-jobs-title", "flow-jobs-settings", "flow-jobs-stage"],
      ["flow-jobs-title", "flow-jobs-settings", "flow-jobs-stage"],
    ]);
    expect(texts(element, ".flow-jobs-settings")).toEqual([
      "seedance_2_5 · 720p · 5 s · 16:9",
      "seedance_2_5 · 720p · 5 s · 16:9",
      "seedance_2_5",
    ]);

    arrive({
      models: [
        {
          id: "higgsfield/seedance_2_5",
          label: "Seedance 2.5 (Higgsfield)",
          provider: "higgsfield",
          model: "Seedance 2.5",
        },
      ],
      providers: [{ id: "higgsfield", label: "Higgsfield" }],
      defaultModel: null,
      failures: [],
    });
    expect(texts(element, ".flow-jobs-settings")).toEqual([
      "Seedance 2.5 · 720p · 5 s · 16:9",
      "Seedance 2.5 · 720p · 5 s · 16:9",
      "Seedance 2.5",
    ]);
  });
});
