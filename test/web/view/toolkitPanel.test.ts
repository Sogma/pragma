// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { TextToolkitInfo } from "../../../src/protocol/api.ts";
import { SetupError } from "../../../src/protocol/setupNeed.ts";
import type { JobStarting } from "../../../web/flow/browserEnvironment.ts";
import type { ToolkitInvocation, ToolkitRun } from "../../../web/flow/toolkitAction.ts";
import type { DocumentAccess } from "../../../web/services/documentAccess.ts";
import type { MenuOpenOptions } from "../../../web/services/menus.ts";
import { createToolkitPanel } from "../../../web/view/toolkitPanel.ts";
import { emptyModelLists } from "../support/emptyModelLists.ts";

vi.mock("../../../web/core/apiClient.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fetchJobs: vi.fn(async () => ({ jobs: [] })),
  markJobsShown: vi.fn(async () => undefined),
  cancelJob: vi.fn(async () => undefined),
}));

// A run the test ends: with what it shows, or failing.
interface HeldRun {
  stop: ReturnType<typeof vi.fn<(reason: string) => void>>;
  finish(result?: Partial<ToolkitRun>): void;
  fail(error: Error): void;
}

function setup() {
  const buttons = document.createElement("div");
  const results = document.createElement("div");
  // On the page: an outcome lands only on a line that is.
  document.body.replaceChildren(buttons, results);
  const reveal = vi.fn();
  const access = {} as DocumentAccess;
  let path = "draft.md";
  const runs: HeldRun[] = [];
  const start = vi.fn((_invocation: ToolkitInvocation, _actionId: string, _jobStarting: JobStarting) => {
    let finish: HeldRun["finish"] = () => {};
    let fail: HeldRun["fail"] = () => {};
    const done = new Promise<ToolkitRun>((resolve, reject) => {
      finish = (result = {}) => resolve({ lines: [], warnings: [], ...result });
      fail = reject;
    });
    const stop = vi.fn((reason: string) => fail(new Error(reason)));
    runs.push({ stop, finish, fail });
    return { done, stop };
  });
  const confirm = vi.fn(async () => true);
  // The tab session's two events, fired by hand.
  const listeners = {
    activate: new Set<(group: { id: string }) => void>(),
    closed: new Set<(group: { id: string }) => void>(),
  };
  const watch = (set: Set<(group: { id: string }) => void>) => (listener: (group: { id: string }) => void) => {
    set.add(listener);
    return () => set.delete(listener);
  };
  const openFlow = vi.fn(async (_path: string) => {});
  const openBeside = vi.fn(async (_path: string, _group: string) => {});
  const tabs = {
    onActivate: watch(listeners.activate),
    onGroupClosed: watch(listeners.closed),
    openEntryBeside: openFlow,
    openBeside,
    openSpacePath: vi.fn(),
  } as never;
  const menuOpen = vi.fn<(options: MenuOpenOptions) => void>();
  const menuIsOpen = vi.fn<(anchor?: HTMLElement) => boolean>(() => false);
  const menuClose = vi.fn();
  const panel = createToolkitPanel(
    { buttons, results },
    {
      target: () => ({ path, access, group: "group-1" }),
      activePath: () => path,
      tabs: () => tabs,
      reveal,
      start,
      confirm,
      contextMenu: { open: menuOpen, isOpen: menuIsOpen, close: menuClose },
      modelLists: emptyModelLists(),
    },
  );
  // The focused group showing another document.
  const open = (next: string) => {
    path = next;
  };
  const fire = (event: "activate" | "closed", id: string) => {
    for (const listener of listeners[event]) listener({ id });
  };
  return {
    panel,
    buttons,
    results,
    reveal,
    start,
    runs,
    confirm,
    access,
    open,
    fire,
    menuOpen,
    menuIsOpen,
    menuClose,
    openFlow,
    openBeside,
  };
}

const rewrite: TextToolkitInfo = {
  classPath: "drafts.class.html",
  path: "tools/rewrite.flow.html",
  name: "Rewrite",
  actions: [
    { nodeId: "tighten", label: "Tighten", nodeType: "replaceSelection" },
    { nodeId: "expand", label: "Expand", nodeType: "showResult" },
  ],
};

describe("createToolkitPanel", () => {
  it("says so when no toolkit applies, and marks the list empty until one does", () => {
    const { panel, buttons } = setup();
    panel.setToolkits([], "draft.md");
    expect(buttons.querySelector(".inspector-empty")?.textContent).toBe("No toolkits for this file.");
    expect(buttons.hasAttribute("data-empty")).toBe(true);
    panel.setToolkits([rewrite], "draft.md");
    expect(buttons.hasAttribute("data-empty")).toBe(false);
  });

  // A run's result lands where its button was; the user may have moved off
  // the Tools tab while it ran.
  it("reveals itself before drawing a run's result", async () => {
    const { panel, buttons, results, reveal, runs } = setup();
    panel.setToolkits([rewrite], "draft.md");
    buttons.querySelector<HTMLButtonElement>(".run-button")?.click();
    runs[0].finish({ lines: ["done"] });
    await vi.waitFor(() => expect(results.textContent).toContain("done"));
    expect(reveal).toHaveBeenCalledTimes(1);
  });

  // What a run couldn't send is said under the result, never as one of its rows.
  it("draws a run's warnings apart from its result rows", async () => {
    const { panel, buttons, results, runs } = setup();
    panel.setToolkits([rewrite], "draft.md");
    const button = buttons.querySelector<HTMLButtonElement>(".run-button");
    button?.click();
    runs[0].finish({
      lines: ["Shot 1"],
      warnings: ["Left out /projects/story/secret.md: it's private.", "Stopped looking after 60 seconds."],
    });
    await vi.waitFor(() =>
      expect([...results.querySelectorAll(".option-text")].map((row) => row.textContent)).toEqual(["Shot 1"]),
    );
    expect(results.querySelector(".action-results-note")?.textContent).toBe(
      "Left out /projects/story/secret.md: it's private.\nStopped looking after 60 seconds.",
    );
    button?.click();
    runs[1].finish({ lines: ["Again"] });
    await vi.waitFor(() => expect(results.textContent).toContain("Again"));
    expect(results.querySelector(".action-results-note")).toBeNull();
  });

  it("shows a Flow toolkit as a section whose buttons are its actions", () => {
    const { panel, buttons } = setup();
    panel.setToolkits([rewrite], "draft.md");
    expect(buttons.querySelector(".toolkit-section-title")?.textContent).toBe("Rewrite");
    expect([...buttons.querySelectorAll(".run-button")].map((el) => el.textContent)).toEqual(["Tighten", "Expand"]);
  });

  const polish: TextToolkitInfo = { ...rewrite, path: "tools/polish.flow.html", name: "Polish" };

  it("starts every section expanded, and again on every call", () => {
    const { panel, buttons } = setup();
    panel.setToolkits([rewrite, polish], "draft.md");
    buttons.querySelector<HTMLButtonElement>(".toolkit-section-toggle")?.click();
    panel.setToolkits([rewrite, polish], "draft.md");
    const toggles = [...buttons.querySelectorAll(".toolkit-section-toggle")];
    expect(toggles.map((el) => el.getAttribute("aria-expanded"))).toEqual(["true", "true"]);
    const bodies = [...buttons.querySelectorAll<HTMLElement>(".toolkit-section-body")];
    expect(bodies.map((el) => el.hidden)).toEqual([false, false]);
  });

  it("folds and unfolds a section from its header, leaving the others as they are", () => {
    const { panel, buttons } = setup();
    panel.setToolkits([rewrite, polish], "draft.md");
    const [first, second] = buttons.querySelectorAll<HTMLButtonElement>(".toolkit-section-toggle");
    const [firstBody, secondBody] = buttons.querySelectorAll<HTMLElement>(".toolkit-section-body");
    first.click();
    expect(first.getAttribute("aria-expanded")).toBe("false");
    expect([firstBody.hidden, secondBody.hidden]).toEqual([true, false]);
    second.click();
    expect([firstBody.hidden, secondBody.hidden]).toEqual([true, true]);
    first.click();
    expect(first.getAttribute("aria-expanded")).toBe("true");
    expect([firstBody.hidden, secondBody.hidden]).toEqual([false, true]);
  });

  it("keeps a run's result when a section folds", async () => {
    const { panel, buttons, results, runs } = setup();
    panel.setToolkits([rewrite], "draft.md");
    buttons.querySelector<HTMLButtonElement>(".run-button")?.click();
    runs[0].finish({ lines: ["tightened"] });
    await vi.waitFor(() => expect(results.textContent).toContain("tightened"));
    buttons.querySelector<HTMLButtonElement>(".toolkit-section-toggle")?.click();
    expect(results.textContent).toContain("tightened");
  });

  it("gives each button its node's glyph", () => {
    const { panel, buttons } = setup();
    panel.setToolkits([rewrite], "draft.md");
    const runButtons = [...buttons.querySelectorAll<HTMLElement>(".run-button")];
    expect(runButtons.map((el) => el.dataset.nodeType)).toEqual(["replaceSelection", "showResult"]);
    expect(runButtons.every((el) => el.querySelector(".flow-node-dot"))).toBe(true);
  });

  it("fills a button with its node's color, and leaves an uncolored one plain", () => {
    const { panel, buttons } = setup();
    panel.setToolkits(
      [{ ...rewrite, actions: [{ ...rewrite.actions[0], color: "#0189d2" }, rewrite.actions[1]] }],
      "draft.md",
    );
    const [colored, plain] = buttons.querySelectorAll<HTMLElement>(".run-button");
    expect(colored.classList.contains("colored")).toBe(true);
    expect(colored.style.getPropertyValue("--node-color")).toBe("#0189d2");
    expect(colored.style.color).not.toBe("");
    expect(plain.classList.contains("colored")).toBe(false);
    expect(plain.style.color).toBe("");
  });

  it("gives a button its node's comment as its tooltip, and one without none", () => {
    const { panel, buttons } = setup();
    const commented = { ...rewrite.actions[0], comment: "Cuts the words the selection doesn't need." };
    panel.setToolkits([{ ...rewrite, actions: [commented, rewrite.actions[1]] }], "draft.md");
    const [withComment, without] = buttons.querySelectorAll<HTMLElement>(".run-button");
    expect(withComment.dataset.tooltip).toBe("Cuts the words the selection doesn't need.");
    expect(without.dataset.tooltip).toBeUndefined();
  });

  it("gives a named section its Flow's path as a tooltip", () => {
    const { panel, buttons } = setup();
    panel.setToolkits([rewrite, { ...rewrite, name: "", path: "tools/plain.flow.html" }], "draft.md");
    const toggles = buttons.querySelectorAll<HTMLElement>(".toolkit-section-toggle");
    expect(toggles[0].dataset.tooltip).toBe("tools/rewrite.flow.html");
    // A nameless Flow already shows its path as the title.
    expect(toggles[1].querySelector(".toolkit-section-title")?.textContent).toBe("tools/plain.flow.html");
    expect(toggles[1].dataset.tooltip).toBeUndefined();
  });

  it("opens a section's Flow, and the Class that gave it, each beside its icon, from its header's right-click menu", () => {
    const { panel, buttons, menuOpen, openFlow } = setup();
    panel.setToolkits([{ ...rewrite, classPath: "songs/tools/lyrics.class.html" }], "draft.md");
    const header = buttons.querySelectorAll<HTMLElement>(".toolkit-section-header")[0];
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 20 });
    header.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    const options = menuOpen.mock.calls[0][0];
    expect(options.at).toEqual({ x: 10, y: 20 });
    expect(options.items?.map((item) => item.label)).toEqual(["Open Flow", "Open Class"]);
    expect(options.items?.map((item) => item.icon && item.entryIcon?.glyph)).toEqual(["flow", "class"]);
    void options.items?.[0].run?.({} as never, undefined);
    expect(openFlow).toHaveBeenCalledWith("tools/rewrite.flow.html");
    void options.items?.[1].run?.({} as never, undefined);
    expect(openFlow).toHaveBeenCalledWith("songs/tools/lyrics.class.html");
  });

  it("opens the same menu under the header's More options button, and closes it on a second click", () => {
    const { panel, buttons, menuOpen, menuIsOpen, menuClose } = setup();
    panel.setToolkits([rewrite], "draft.md");
    const more = buttons.querySelector<HTMLButtonElement>(".toolkit-section-header .toolkit-section-menu");
    expect(more?.getAttribute("aria-label")).toBe("More options");
    more?.click();
    const options = menuOpen.mock.calls[0][0];
    expect(options.anchor).toBe(more);
    expect(options.align).toBe("end");
    expect(options.items?.map((item) => item.label)).toEqual(["Open Flow", "Open Class"]);
    // The click opens the menu and leaves the section as it was.
    expect(buttons.querySelector(".toolkit-section-toggle")?.getAttribute("aria-expanded")).toBe("true");

    menuIsOpen.mockReturnValue(true);
    more?.click();
    expect(menuIsOpen).toHaveBeenLastCalledWith(more);
    expect(menuClose).toHaveBeenCalledTimes(1);
    expect(menuOpen).toHaveBeenCalledTimes(1);
  });

  it("runs a Flow action against the document the button was clicked in", async () => {
    const { panel, buttons, start, access, openBeside } = setup();
    panel.setToolkits([rewrite], "draft.md");
    buttons.querySelectorAll<HTMLButtonElement>(".run-button")[1].click();
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({ flow: { path: "tools/rewrite.flow.html", name: "Rewrite" }, path: "draft.md", access }),
      "expand",
      expect.any(Function),
    );
    // What the run opens to the side goes beside the group the click came from.
    const [invocation] = start.mock.calls[0];
    await invocation.openToSide("notes/summary.md");
    expect(openBeside).toHaveBeenCalledWith("notes/summary.md", "group-1");
  });

  // Like a result, a failure can land after the user moved off the Tools tab.
  it("shows a failed Flow run where its button was, revealing itself", async () => {
    const { panel, buttons, results, reveal, runs } = setup();
    panel.setToolkits([rewrite], "draft.md");
    buttons.querySelector<HTMLButtonElement>(".run-button")?.click();
    runs[0].fail(new Error("Current Document: Permission denied"));
    await vi.waitFor(() => expect(results.textContent).toContain("Current Document: Permission denied"));
    expect(results.querySelector(".setting-link")).toBeNull();
    expect(reveal).toHaveBeenCalledTimes(1);
  });

  // The next run may end in a proposal drawn in the editor, with nothing to
  // show here, so nothing would draw over the failure.
  it("clears a failure as soon as a button is clicked again", async () => {
    const { panel, buttons, results, runs } = setup();
    panel.setToolkits([rewrite], "draft.md");
    const tighten = buttons.querySelector<HTMLButtonElement>(".run-button");
    tighten?.click();
    runs[0].fail(new SetupError("Generate Text: No model selected.", { kind: "defaultModel", output: "text" }));
    await vi.waitFor(() => expect(results.textContent).toContain("No model selected."));
    tighten?.click();
    expect(results.textContent).toBe("");
    runs[1].finish();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(results.textContent).toBe("");
    expect(results.querySelector(".inline-error")).toBeNull();
  });

  // Every button reports into one area, so the failure names its button.
  it("titles a failed run with its button, and links it to the setting that fixes it", async () => {
    const { panel, buttons, results, runs } = setup();
    panel.setToolkits([rewrite], "draft.md");
    buttons.querySelector<HTMLButtonElement>(".run-button")?.click();
    runs[0].fail(new SetupError("Generate Text: No model selected.", { kind: "defaultModel", output: "text" }));
    await vi.waitFor(() =>
      expect(results.querySelector(".setting-link")?.textContent).toBe("Go to AI Models settings"),
    );
    const card = results.querySelector(".inline-error");
    expect(card?.querySelector(".inline-error-title")?.textContent).toBe("Tighten failed");
    expect(card?.querySelector(".inline-error-message")?.textContent).toBe("Generate Text: No model selected.");
    expect(card?.querySelector(".setting-link")?.classList.contains("btn")).toBe(true);
  });

  it("keeps every button clickable while runs go, listing each under them until it ends", async () => {
    const { panel, buttons, start, runs } = setup();
    panel.setToolkits([rewrite], "draft.md");
    const [tighten, expand] = buttons.querySelectorAll<HTMLButtonElement>(".run-button");
    tighten.click();
    expand.click();
    expect(start).toHaveBeenCalledTimes(2);
    expect([tighten.disabled, expand.disabled]).toEqual([false, false]);
    const titles = () => [...buttons.querySelectorAll(".flow-jobs-title")].map((title) => title.textContent);
    expect(titles().sort()).toEqual([
      expect.stringMatching(/^Expand · started /),
      expect.stringMatching(/^Tighten · started /),
    ]);
    expect([...buttons.querySelectorAll(".flow-jobs-stage")].map((stage) => stage.textContent)).toEqual([
      "Running",
      "Running",
    ]);
    expect(buttons.getAttribute("data-running")).toBe("2");

    runs[0].finish();
    await vi.waitFor(() => expect(buttons.getAttribute("data-running")).toBe("1"));
    expect(titles()).toEqual([expect.stringMatching(/^Expand · started /)]);
  });

  // The panel follows the focused group, so another document's toolkits show
  // at once, and a run's result waits for nobody.
  it("lists a document's runs only on it, and draws a run's result only while its document shows", async () => {
    const { panel, buttons, results, runs, open } = setup();
    panel.setToolkits([rewrite], "draft.md");
    buttons.querySelector<HTMLButtonElement>(".run-button")?.click();
    open("other.md");
    panel.setToolkits([], "other.md");
    expect(buttons.querySelector(".inspector-empty")).not.toBeNull();
    expect(buttons.querySelector(".flow-jobs-row")).toBeNull();
    runs[0].finish({ lines: ["tightened"] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(results.textContent).toBe("");
  });

  it("stops a run when its own group shows another document or closes, never for the other group", async () => {
    const { panel, buttons, runs, fire } = setup();
    panel.setToolkits([rewrite], "draft.md");
    buttons.querySelector<HTMLButtonElement>(".run-button")?.click();

    fire("activate", "group-2");
    fire("closed", "group-2");
    expect(runs[0].stop).not.toHaveBeenCalled();
    fire("activate", "group-1");
    expect(runs[0].stop).toHaveBeenCalledWith("The document changed");
    fire("closed", "group-1");
    expect(runs[0].stop).toHaveBeenCalledTimes(2);

    await vi.waitFor(() => expect(buttons.getAttribute("data-running")).toBeNull());
    fire("activate", "group-1");
    expect(runs[0].stop).toHaveBeenCalledTimes(2); // no longer watching once the run ended
  });

  it("cancels a run that has spent nothing at once from its row, drawing no failure for it", async () => {
    const { panel, buttons, results, runs, confirm } = setup();
    panel.setToolkits([rewrite], "draft.md");
    buttons.querySelector<HTMLButtonElement>(".run-button")?.click();
    const cancel = buttons.querySelector<HTMLButtonElement>(".flow-jobs-cancel");
    expect(cancel?.getAttribute("aria-label")).toBe("Cancel this run");
    cancel?.click();
    await vi.waitFor(() => expect(runs[0].stop).toHaveBeenCalledWith("The run was cancelled"));
    expect(confirm).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(buttons.querySelector(".flow-jobs-row")).toBeNull());
    expect(results.textContent).toBe("");
  });

  it("leaves out a Flow toolkit with no actions", () => {
    const { panel, buttons } = setup();
    panel.setToolkits([{ ...rewrite, actions: [] }], "draft.md");
    expect(buttons.querySelector(".inspector-empty")).not.toBeNull();
  });
});
