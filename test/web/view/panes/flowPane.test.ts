// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { FlowFileResponse, Tab } from "../../../../web/core/apiClient.ts";
import { PREVIEW_FILE_MENU } from "../../../../web/filePreview.ts";
import type { FlowViewDeps } from "../../../../web/flow/xyflowAdapter.ts";
import { createDialogService } from "../../../../web/services/dialog.ts";
import { createFlowPane } from "../../../../web/view/panes/flowPane.ts";
import { emptyModelLists } from "../../support/emptyModelLists.ts";
import { testMetadataProperties } from "../../support/metadataProperties.ts";
import { testPreviewSources } from "../../support/previewSources.ts";

type PaneHooks = Pick<
  FlowViewDeps,
  "problems" | "spent" | "onRunsChange" | "previewResult" | "onViewportChange" | "onAppModeChange"
>;

// The canvas is xyflow's, and not what this pane adds; a stand-in keeps the
// test to the pane's own contract, and to the hooks the pane hands it.
const canvas = vi.hoisted(() => ({
  deps: undefined as undefined | PaneHooks,
  setMetadata: undefined as undefined | ((metadata: unknown) => void),
  render: undefined as undefined | ((file: unknown, local?: unknown) => void),
  differs: false,
  setDefaultView: undefined as undefined | (() => Promise<boolean>),
}));
vi.mock("../../../../web/flow/xyflowAdapter.ts", () => ({
  createFlowView: (_elements: unknown, deps: PaneHooks) => {
    canvas.deps = deps;
    canvas.setMetadata = vi.fn();
    canvas.render = vi.fn();
    canvas.setDefaultView = vi.fn(async () => true);
    return {
      render: canvas.render,
      defaultViewDiffers: () => canvas.differs,
      setDefaultView: canvas.setDefaultView,
      clear: vi.fn(),
      getFileName: () => undefined,
      isAppModeActive: () => false,
      hasTransient: () => false,
      dismissTransient: vi.fn(),
      setMetadata: canvas.setMetadata,
      setRunCount: vi.fn(),
    };
  },
}));

function file(overrides: Partial<FlowFileResponse> = {}): FlowFileResponse {
  return {
    kind: "flow",
    path: "flows/update.flow.html",
    revision: "rev-1",
    version: "1.0",
    graph: { nodes: [], edges: [] },
    capabilities: [],
    grantedCapabilities: [],
    runsUnattended: false,
    ...overrides,
  };
}

function setup(reportProblems = vi.fn(), hooks: Record<string, unknown> = {}) {
  return createFlowPane({
    loadFile: vi.fn(),
    noteRevision: vi.fn(),
    reportProblems,
    modelLists: emptyModelLists(),
    metadataProperties: testMetadataProperties(),
    previewSources: testPreviewSources(),
    contextMenu: { open: vi.fn(), close: vi.fn(), isOpen: () => false },
    dialog: createDialogService(),
    openPath: vi.fn(),
    onViewChange: vi.fn(),
    ...hooks,
  } as never);
}

type FlowTab = Extract<Tab, { kind: "flow" }>;

const current = { isCurrent: () => true };
const DESCRIPTION = { key: "description", values: ["Updates settings"] };
const tab = { kind: "flow" as const, path: "flows/update.flow.html" };

function descriptionField(pane: { properties?: HTMLElement }): HTMLTextAreaElement | null {
  return pane.properties?.querySelector('[data-key="description"] textarea') ?? null;
}

describe("flowPane", () => {
  it("counts a generation's notes as notices on the Flow that ran it, and logs one with none plainly", async () => {
    const logEntry = vi.fn();
    const notices = { begin: vi.fn(), add: vi.fn() };
    const onRunCount = vi.fn();
    const pane = setup(vi.fn(), { logEntry, notices, onRunCount });
    await pane.setInput(tab, current, file());

    // Runs going side by side start the bar's count over once, as the first does.
    const run = {
      id: 1,
      number: 1,
      flowPath: "flows/update.flow.html",
      startedAt: Date.now(),
      jobs: [],
      startingJob: false,
      nodes: [],
      cancel: vi.fn(),
    };
    canvas.deps?.onRunsChange([run]);
    canvas.deps?.onRunsChange([run, { ...run, id: 2, number: 2 }]);
    expect(notices.begin).toHaveBeenCalledTimes(1);
    expect(notices.begin).toHaveBeenCalledWith("flows/update.flow.html", "run");
    expect(onRunCount).toHaveBeenLastCalledWith(2);

    // The run names its Flow: the pane may show another by the time it settles.
    const notes = ["mode: used omni_reference (a frame came)"];
    const clip = { media: "video" as const, model: "h/seedance_2_5", path: "clips/a.mp4", reused: false };
    canvas.deps?.spent("flows/other.flow.html", { ...clip, cost: { amount: 15, unit: "credits" }, notes });
    expect(notices.add).toHaveBeenCalledWith("flows/other.flow.html", "run", {
      level: "info",
      kind: "VIDEO",
      label: "Generate Video · h/seedance_2_5",
      content: "Quoted 15 credits · clips/a.mp4\nmode: used omni_reference (a frame came)",
      count: 1,
    });
    expect(logEntry).not.toHaveBeenCalled();

    canvas.deps?.spent("flows/other.flow.html", { ...clip, reused: true });
    expect(logEntry).toHaveBeenCalledWith(
      "info",
      "VIDEO",
      "Generate Video · h/seedance_2_5",
      "Reused, nothing spent · clips/a.mp4",
    );
    expect(notices.add).toHaveBeenCalledTimes(1);
  });

  it("previews a result's file over the pane, holding its keys off the canvas until it closes", async () => {
    const openPath = vi.fn();
    const contextMenu = { open: vi.fn(), close: vi.fn(), isOpen: () => false };
    const pane = setup(vi.fn(), { openPath, contextMenu });
    document.body.append(pane.element);
    await pane.setInput(tab, current, file());
    const canvasPane = pane.element.querySelector(".flow-pane") as HTMLElement;
    canvasPane.focus();

    canvas.deps?.previewResult("art/a-0123456789ab.png");
    const preview = pane.element.querySelector(".file-preview") as HTMLElement;
    expect(preview.hidden).toBe(false);
    expect(preview.querySelector("img")?.getAttribute("src")).toBe("/raw?path=art/a-0123456789ab.png");
    expect(document.activeElement).toBe(pane.element);
    expect(pane.hasTransient?.()).toBe(true);

    // One file: no arrows, and nothing opens in place, only from its ⋮.
    const enter = new KeyboardEvent("keydown", { key: "Enter", cancelable: true });
    pane.element.dispatchEvent(enter);
    preview.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect([enter.defaultPrevented, openPath.mock.calls.length]).toEqual([false, 0]);
    expect(preview.querySelectorAll('.file-preview-nav:not([aria-disabled="true"])')).toHaveLength(0);
    (preview.querySelector(".media-hud-more") as HTMLButtonElement).click();
    expect(contextMenu.open).toHaveBeenCalledWith(
      expect.objectContaining({
        menu: PREVIEW_FILE_MENU,
        arg: { file: "art/a-0123456789ab.png", bookmark: "art/a-0123456789ab.png" },
      }),
    );

    pane.dismissTransient?.();
    expect(preview.hidden).toBe(true);
    expect(document.activeElement).toBe(canvasPane);
    expect(pane.hasTransient?.()).toBe(false);

    // A tab that leaves the Flow takes the preview with it.
    canvas.deps?.previewResult("art/a-0123456789ab.png");
    pane.clearInput();
    expect(preview.hidden).toBe(true);
    pane.element.remove();
  });

  it("shows the flow's description to edit in its Properties-tab section, and has no Info section", async () => {
    const pane = setup();
    expect(pane.inspector).toBeUndefined();
    expect(pane.properties?.hidden).toBe(true);

    await pane.setInput(tab, current, file());
    expect(pane.properties?.hidden).toBe(false);
    expect(pane.properties?.hasAttribute("data-empty")).toBe(true);

    await pane.setInput(tab, current, file({ metadata: [DESCRIPTION] }));
    expect(descriptionField(pane)?.value).toBe("Updates settings");
  });

  it("saves an edited description through the canvas, keeping the other keys", async () => {
    const pane = setup();
    const tags = { key: "tags", values: ["settings"] };
    await pane.setInput(tab, current, file({ metadata: [DESCRIPTION, tags] }));
    const field = descriptionField(pane);
    if (!field) throw new Error("no description field");
    field.value = "Updates every setting.";
    field.dispatchEvent(new Event("input"));
    expect(canvas.setMetadata).toHaveBeenLastCalledWith([
      { key: "description", values: ["Updates every setting."] },
      tags,
    ]);
  });

  it("shows any other key as a property, saved through the canvas, and only shows a locked flow's", async () => {
    const pane = setup();
    await pane.setInput(tab, current, file({ metadata: [DESCRIPTION, { key: "status", values: ["draft"] }] }));
    const field = pane.properties?.querySelector<HTMLTextAreaElement>('[data-key="status"] textarea');
    if (!field) throw new Error("no status field");
    field.value = "done";
    field.dispatchEvent(new Event("input"));
    expect(canvas.setMetadata).toHaveBeenLastCalledWith([DESCRIPTION, { key: "status", values: ["done"] }]);

    await pane.setInput(
      tab,
      current,
      file({ metadata: [{ key: "status", values: ["draft"] }], locked: "newer-format" }),
    );
    expect(pane.properties?.querySelector("textarea")).toBeNull();
    expect(pane.properties?.textContent).toContain("draft");
  });

  it("clearInput hides the section", async () => {
    const pane = setup();
    await pane.setInput(tab, current, file({ metadata: [DESCRIPTION] }));
    pane.clearInput();

    expect(pane.properties?.hidden).toBe(true);
    expect(descriptionField(pane)).toBeNull();
  });

  it("reports the flow's problems as it opens and after every change", async () => {
    const reportProblems = vi.fn();
    const pane = setup(reportProblems);
    const node = { id: "show-1", type: "showText", position: { x: 0, y: 0 }, config: {} };
    const wire = { id: "e", source: "show-1", sourcePort: "reply", target: "show-1", targetPort: "text" };
    await pane.setInput(tab, current, file({ graph: { nodes: [node], edges: [wire] } }));
    expect(reportProblems).toHaveBeenCalledWith("flows/update.flow.html", [
      'Show Text "show-1": a wire comes out of "reply", a pin it doesn\'t have.',
    ]);

    canvas.deps?.problems.onGraphChange("flows/update.flow.html", { nodes: [node], edges: [] });
    expect(reportProblems).toHaveBeenLastCalledWith("flows/update.flow.html", []);
  });

  it("counts a file a card found gone with the flow's problems, until it's found again or the flow reopens", async () => {
    const reportProblems = vi.fn();
    const pane = setup(reportProblems);
    const node = { id: "load-1", type: "loadNote", position: { x: 0, y: 0 }, config: { notePath: "gone.md" } };
    const opened = file({ graph: { nodes: [node], edges: [] } });
    await pane.setInput(tab, current, opened);
    expect(reportProblems).toHaveBeenLastCalledWith("flows/update.flow.html", []);

    canvas.deps?.problems.fileMissing("load-1", 'No file at "flows/gone.md"');
    expect(reportProblems).toHaveBeenLastCalledWith("flows/update.flow.html", [
      'Load Note "load-1": No file at "flows/gone.md"',
    ]);
    canvas.deps?.problems.fileMissing("load-1", undefined);
    expect(reportProblems).toHaveBeenLastCalledWith("flows/update.flow.html", []);

    // A reload builds the cards afresh, and they check again.
    canvas.deps?.problems.fileMissing("load-1", 'No file at "flows/gone.md"');
    await pane.setInput(tab, current, opened);
    expect(reportProblems).toHaveBeenLastCalledWith("flows/update.flow.html", []);
  });

  it("keeps where the canvas was left on the shown tab, and shows each tab's over its file's", async () => {
    const onPlaceChange = vi.fn();
    const onViewChange = vi.fn();
    const pane = setup(vi.fn(), { onPlaceChange, onViewChange });
    const first: FlowTab = { kind: "flow", path: "flows/update.flow.html" };
    const second: FlowTab = { kind: "flow", path: "flows/other.flow.html", viewport: { x: 5, y: 6, zoom: 0.5 } };
    const saved = { x: 0, y: 0, zoom: 1 };
    await pane.setInput(first, current, file({ graph: { nodes: [], edges: [], viewport: saved } }));
    expect(canvas.render).toHaveBeenLastCalledWith(expect.objectContaining({ path: first.path }), {
      viewport: undefined,
      appMode: undefined,
    });

    canvas.deps?.onViewportChange({ x: 40, y: -20, zoom: 2 });
    expect(first.viewport).toEqual({ x: 40, y: -20, zoom: 2 });
    expect(onPlaceChange).toHaveBeenCalledTimes(1);

    await pane.setInput(second, current, file({ path: second.path }));
    expect(canvas.render).toHaveBeenLastCalledWith(expect.objectContaining({ path: second.path }), {
      viewport: second.viewport,
      appMode: undefined,
    });
    canvas.deps?.onViewportChange({ x: 1, y: 2, zoom: 1 });
    expect([first.viewport, second.viewport]).toEqual([
      { x: 40, y: -20, zoom: 2 },
      { x: 1, y: 2, zoom: 1 },
    ]);

    // Back on the first tab, its file read again: the tab's view, not the file's.
    await pane.setInput(first, current, file({ graph: { nodes: [], edges: [], viewport: saved } }));
    expect(canvas.render).toHaveBeenLastCalledWith(expect.objectContaining({ path: first.path }), {
      viewport: { x: 40, y: -20, zoom: 2 },
      appMode: undefined,
    });

    pane.clearInput();
    canvas.deps?.onViewportChange({ x: 9, y: 9, zoom: 1 });
    expect(first.viewport).toEqual({ x: 40, y: -20, zoom: 2 });
    expect(onPlaceChange).toHaveBeenCalledTimes(2);
    expect(onViewChange).toHaveBeenCalledTimes(2);
  });

  it("keeps App Mode per Flow on this install, over what a file read brings", async () => {
    const saveAppMode = vi.fn(async () => undefined);
    const onViewChange = vi.fn();
    const pane = setup(vi.fn(), { saveAppMode, onViewChange });
    const other: FlowTab = { kind: "flow", path: "flows/other.flow.html" };
    await pane.setInput(tab, current, file());
    canvas.deps?.onAppModeChange(true);
    expect(saveAppMode).toHaveBeenCalledExactlyOnceWith(tab.path, true);
    expect(onViewChange).toHaveBeenCalledTimes(1);

    await pane.setInput(other, current, file({ path: other.path, localAppMode: true }));
    expect(canvas.render).toHaveBeenLastCalledWith(expect.objectContaining({ path: other.path }), {
      viewport: undefined,
      appMode: true,
    });
    // A read made before the switch's own save landed.
    await pane.setInput(tab, current, file());
    expect(canvas.render).toHaveBeenLastCalledWith(expect.objectContaining({ path: tab.path }), {
      viewport: undefined,
      appMode: true,
    });
  });

  it("sets the default view the canvas offers, then lets this install's App Mode go", async () => {
    const saveAppMode = vi.fn(async () => undefined);
    const pane = setup(vi.fn(), { saveAppMode });
    await pane.setInput(tab, current, file());
    expect(pane.defaultView?.tooltip).toBe(
      "Saves this position, zoom and App Mode into the Flow, for every device and app.",
    );
    canvas.differs = true;
    expect(pane.defaultView?.differs()).toBe(true);

    canvas.deps?.onAppModeChange(true);
    expect(await pane.defaultView?.set()).toBe(true);
    expect(canvas.setDefaultView).toHaveBeenCalledTimes(1);
    expect(saveAppMode.mock.calls).toEqual([
      [tab.path, true],
      [tab.path, true],
    ]);

    vi.mocked(canvas.setDefaultView as () => Promise<boolean>).mockResolvedValueOnce(false);
    expect(await pane.defaultView?.set()).toBe(false);
    expect(saveAppMode).toHaveBeenCalledTimes(2);
    canvas.differs = false;
  });
});
