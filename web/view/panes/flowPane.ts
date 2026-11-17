// The Flow pane: a `.flow.html` graph on the xyflow canvas, with App Mode
// as its alternate view. Adapts createFlowView to the EditorPane contract;
// the pane builds its own DOM (flow/flowElements.ts), so any number can
// exist.

import { spendEntry } from "../../../src/protocol/flowExecutors.ts";
import { basenameOf } from "../../../src/protocol/rootedPath.ts";
import { type FileResponse, postFlowAppMode, type Tab } from "../../core/apiClient.ts";
import {
  createFilePreview,
  type FilePreviewDeps,
  type PreviewFile,
  type PreviewSources,
  servedPreviewSources,
} from "../../filePreview.ts";
import type { CanvasRunHost } from "../../flow/canvasRun.ts";
import { createFlowElements } from "../../flow/flowElements.ts";
import { createFlowJobs } from "../../flow/flowJobs.ts";
import { createFlowProblemReport } from "../../flow/flowProblemReport.ts";
import { createFlowView, type FlowView, type FlowViewDeps } from "../../flow/xyflowAdapter.ts";
import { bindFrameStats } from "../../lib/frameStats.ts";
import type { EditorPane, EditorPaneDescriptor } from "../../services/editorPanes.ts";
import type { FileNotices } from "../../services/fileNotices.ts";
import type { FormatRegistry } from "../../services/formats.ts";
import type { ConsoleEntry, ConsoleEntryLevel } from "../../services/modelConsole.ts";
import { showStats } from "../../services/settings.ts";
import type { Tabs } from "../../services/tabs.ts";
import type { MetadataProperties } from "../metadataProperties.ts";

export interface FlowPaneDeps
  extends Omit<
      FlowViewDeps,
      "problems" | "spent" | "previewResult" | "onRunsChange" | "onViewportChange" | "onAppModeChange"
    >,
    CanvasRunHost {
  // How many runs and jobs of the shown Flow are going, for the toolbar.
  onRunCount: (count: number) => void;
  // The pane wrote where the canvas was left onto its tab, once a pan or
  // zoom ended.
  onPlaceChange: () => void;
  // The view shown changed: a pan, a zoom or an App Mode switch.
  onViewChange: () => void;
  // Keeps whether the Flow at `path` shows App Mode on this install.
  saveAppMode: (path: string, appMode: boolean) => Promise<void>;
  loadFile: (path: string) => Promise<FileResponse>;
  // The base the pane's next save names (see services/saveQueue.ts).
  noteRevision: (path: string, revision: string) => void;
  // What's wrong with the flow (services/fileNotices.ts), as it opens, after
  // every change, and as its cards find a file gone.
  reportProblems: (path: string, problems: readonly string[]) => void;
  metadataProperties: () => MetadataProperties;
  // A Console entry. Each generation a run pays for gets one, notes and all.
  logEntry: (level: ConsoleEntryLevel, kind: string, label: string, content: string) => ConsoleEntry;
  // What the group's status bar counts of a run's notices.
  notices: Pick<FileNotices, "begin" | "add">;
  // What a result's preview reads, and where its Open button, and a link
  // on a previewed page, open a file.
  previewSources: PreviewSources;
  formats: Pick<FormatRegistry, "get">;
  openPath: (path: string) => void;
  openBeside: (path: string) => void;
}

export interface FlowPane extends EditorPane {
  readonly kind: "flow";
  readonly flowView: FlowView;
}

export function isFlowPane(pane: EditorPane): pane is FlowPane {
  return pane.kind === "flow";
}

// What a descriptor is wired with: everything but the hooks a pane takes
// from the group it is created in, the routes its previews read, and the
// opens it makes through the tabs.
export type FlowPaneWiring = Omit<
  FlowPaneDeps,
  | "onRendered"
  | "onRunCount"
  | "onPlaceChange"
  | "onViewChange"
  | "showRuns"
  | "notices"
  | "previewSources"
  | "openPath"
  | "openBeside"
  | "openToSide"
  | "saveAppMode"
> & { tabs: () => Pick<Tabs, "openSpacePath" | "openEntryBeside"> };

export function flowPane({ tabs, ...deps }: FlowPaneWiring): EditorPaneDescriptor {
  return {
    kind: "flow",
    chrome: {
      toolbar: true,
      readingView: false,
      statusbar: true,
      actions: ["flow-run", "flow-app-mode", "flow-rename", "flow-permissions"],
    },
    create: (group) =>
      createFlowPane({
        ...deps,
        previewSources: servedPreviewSources(),
        openPath: (path) => void tabs().openSpacePath(path),
        openBeside: (path) => void tabs().openEntryBeside(path),
        onRendered: () => group.rendered(),
        onRunCount: (count) => group.setFlowRuns(count),
        onPlaceChange: () => group.placeChanged(),
        onViewChange: () => group.viewChanged(),
        saveAppMode: postFlowAppMode,
        showRuns: () => group.showRuns(),
        notices: group.notices,
        openToSide: group.openToSide,
      }),
  };
}

type ResultPreviewDeps = Omit<FilePreviewDeps, "host" | "refocus" | "count" | "fileAt" | "openInPlace" | "shown">;

// A Generate node's result over the whole pane, canvas or App Mode, with
// the gallery's preview: one file, so no arrows, and a double-click or
// Enter opens nothing. While it shows, the pane's box holds focus for its
// keys, off the canvas, whose own keys would act on the node behind it.
function createResultPreview(host: HTMLElement, deps: ResultPreviewDeps) {
  let file: PreviewFile | undefined;
  // Where focus was as the preview opened, given back as it closes.
  let opener: HTMLElement | undefined;
  const preview = createFilePreview({
    ...deps,
    host,
    count: () => (file ? 1 : 0),
    fileAt: (index) => (index === 0 ? file : undefined),
    refocus: () => {
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    },
  });
  host.tabIndex = -1;
  host.addEventListener("keydown", (event) => {
    if (event.target !== host || event.metaKey || event.ctrlKey) return;
    if (preview.key(event.key)) event.preventDefault();
  });
  const resize = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(() => preview.fit());
  resize?.observe(host);
  return {
    show(path: string) {
      const focused = document.activeElement;
      opener = focused instanceof HTMLElement && focused !== host ? focused : undefined;
      file = { path, name: basenameOf(path) };
      preview.show(0);
      host.focus({ preventScroll: true });
    },
    isOpen: () => preview.shownIndex() !== undefined,
    close: (refocus?: boolean) => preview.close(refocus),
    dispose() {
      resize?.disconnect();
      preview.dispose();
    },
  };
}

export function createFlowPane(deps: FlowPaneDeps): FlowPane {
  const {
    loadFile,
    reportProblems,
    metadataProperties,
    logEntry,
    notices,
    previewSources,
    formats,
    openPath,
    openBeside,
    onRunCount,
    onPlaceChange,
    onViewChange,
    saveAppMode,
    ...viewDeps
  } = deps;
  const elements = createFlowElements();
  const results = createResultPreview(elements.root, {
    ...previewSources,
    loadFile,
    formats,
    contextMenu: deps.contextMenu,
    dialog: deps.dialog,
    openPath,
    openBeside,
  });
  const problems = createFlowProblemReport(reportProblems);
  const jobs = createFlowJobs({
    notices,
    openPath,
    dialog: deps.dialog,
    onCount: (count) => {
      onRunCount(count);
      flowView.setRunCount(count);
    },
  });
  // The Flow shown. A generation names the Flow it came from instead: the
  // pane may show another by the time it settles.
  let shown: string | undefined;
  // Its tab, which keeps where the canvas was left: the pane reads the file
  // again on every switch back, outside edit and rename, and the file's
  // viewport is only where it was at the last save.
  let shownTab: Extract<Tab, { kind: "flow" }> | undefined;
  // The App Mode switched to this session, by Flow path, over what the file
  // read brought: a switch back can read the file before the switch's own
  // save has landed.
  const appModes = new Map<string, boolean>();
  // The Flows with runs going: a run starting where none was starts the
  // status bar's count of run notices over there.
  let going = new Set<string>();
  const flowView = createFlowView(elements, {
    ...viewDeps,
    previewResult: results.show,
    problems,
    onRunsChange: (runs) => {
      const now = new Set(runs.map((run) => run.flowPath));
      for (const path of now) if (!going.has(path)) notices.begin(path, "run");
      going = now;
      jobs.setRuns(runs);
    },
    // A generation whose provider said nothing is a plain Console entry.
    spent: (flowPath, spend) => {
      const [kind, label, content] = spendEntry(spend);
      const count = spend.notes?.length ?? 0;
      if (count > 0) notices.add(flowPath, "run", { level: "info", kind, label, content, count });
      else logEntry("info", kind, label, content);
    },
    onViewportChange: (viewport) => {
      if (!shownTab) return;
      shownTab.viewport = viewport;
      onPlaceChange();
      onViewChange();
    },
    // Best-effort: a failed save costs only the switch, the next time the
    // Flow opens after a restart.
    onAppModeChange: (appMode) => {
      if (shown === undefined) return;
      appModes.set(shown, appMode);
      void saveAppMode(shown, appMode).catch(() => undefined);
      onViewChange();
    },
  });
  const stats = bindFrameStats(elements.hudStats, showStats);
  const properties = metadataProperties();

  return {
    kind: "flow",
    element: elements.root,
    properties: properties.section,
    tools: jobs.element,
    flowView,
    async setInput(tab, ctx, prefetched) {
      if (tab.kind !== "flow") throw new Error(`the flow pane can't show a "${tab.kind}" tab`);
      const file = prefetched ?? (await loadFile(tab.path));
      if (!ctx.isCurrent()) return;
      if (file.kind !== "flow") throw new Error(`${tab.path} is not a flow`);
      deps.noteRevision(file.path, file.revision);
      // Before the cards are built, not after: one may save while it's built,
      // and that report would list the last Flow's missing files under this one.
      problems.opened(file.path, file.graph);
      if (shown !== file.path) results.close(false);
      shown = file.path;
      shownTab = tab;
      jobs.show(file.path);
      flowView.render(file, { viewport: tab.viewport, appMode: appModes.get(file.path) ?? file.localAppMode });
      // Once per open: the view keeps this file, and each edit saves through it.
      properties.show(file.path, file.metadata, {
        onChange: file.locked === undefined ? (metadata) => flowView.setMetadata(metadata) : undefined,
      });
    },
    clearInput: () => {
      shownTab = undefined;
      results.close(false);
      flowView.clear();
      properties.clear();
      jobs.clear();
    },
    defaultView: {
      tooltip: "Saves this position, zoom and App Mode into the Flow, for every device and app.",
      differs: () => flowView.defaultViewDiffers(),
      async set() {
        const path = shown;
        if (!(await flowView.setDefaultView())) return false;
        // The App Mode kept for this install now matches the file's, and
        // posting it again lets the host drop it.
        const appMode = path === undefined ? undefined : appModes.get(path);
        if (path !== undefined && appMode !== undefined) await saveAppMode(path, appMode).catch(() => undefined);
        return true;
      },
    },
    title: () => flowView.getFileName(),
    // The canvas has no scroll of its own (it pans and zooms), so the title
    // is a fixed banner over it. App Mode is a plain scrolling form, so
    // there the title scrolls away with the cards like every other pane's.
    titleHost: () => (flowView.isAppModeActive() ? elements.appModePane : elements.root),
    hasTransient: () => results.isOpen() || flowView.hasTransient(),
    dismissTransient: () => (results.isOpen() ? results.close() : flowView.dismissTransient()),
    dispose() {
      jobs.dispose();
      results.dispose();
      stats.dispose();
      flowView.clear();
      elements.root.remove();
    },
  };
}
