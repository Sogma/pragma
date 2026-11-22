// The inspector's Graph tab (docs/architecture.md's Workspace and UI ownership section): the
// open entry's own graph in 3D, what it links to and what links to it, its
// scope drawn in pragma's marks. The renderer and its library load the first
// time the tab is shown, and the graph is read again when the space changes.
import type { SpaceGraphResponse } from "../../src/protocol/api.ts";
import { fetchSpaceGraph, type Tab } from "../core/apiClient.ts";
import { linkedEntry } from "../core/paths.ts";
import { bindFrameStats } from "../lib/frameStats.ts";
import { createInlineError } from "../lib/inlineError.ts";
import { createSwitch } from "../lib/toggleRow.ts";
import type { InspectorTab } from "../services/inspectorTabs.ts";
import type { ContextMenuService } from "../services/menus.ts";
import { showStats } from "../services/settings.ts";
import { spaceChanges } from "../services/spaceChanges.ts";
import { EDGE_GROUPS, localGraph, type ShownNode, type ShowOptions } from "./graphData.ts";
import type { GraphLook, GraphScene } from "./graphScene.ts";
import { readShowOptions, SHOW_SWITCHES, writeShowOptions } from "./graphSettings.ts";
import type { Hues } from "./marks.ts";

// Three files joined at a bare point, one up and two down.
const ICON = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
  <path d="M12 12.82L12 8.27"/>
  <path d="M12 12.82L16.62 16.56"/>
  <path d="M12 12.82L7.38 16.56"/>
  <circle cx="12" cy="6.02" r="2.25"/>
  <circle cx="18.37" cy="17.98" r="2.25"/>
  <circle cx="5.63" cy="17.98" r="2.25"/>
</svg>`;

const HUES: (keyof Hues)[] = ["green", "cyan", "blue", "yellow", "orange", "red", "crimson"];

// A node's colour, by the aliases graph.css gives each kind; any other kind
// is --graph-kind-plain.
const KIND_TOKENS: Partial<Record<ShownNode["kind"], string>> = {
  class: "--graph-kind-class",
  table: "--graph-kind-table",
  flow: "--graph-kind-flow",
  applet: "--graph-kind-applet",
  folder: "--graph-kind-faint",
  missing: "--graph-kind-faint",
  tag: "--graph-kind-faint",
};

type SceneModule = typeof import("./graphScene.ts");

/** The menu a node has on a right-click, given a file's `{ file }` or a
 * folder's `{ folder }`: the ways to open it. */
export const GRAPH_NODE_MENU = "graph.node";

// A node's id is its path as a link writes it.
export const graphNodeTarget = linkedEntry;

export interface GraphTabDeps {
  // Opens an entry as a tree click does: in place, in the focused group. A
  // path ending in `/` is a folder.
  open(path: string): void;
  contextMenu: Pick<ContextMenuService, "open">;
}

export function createGraphTab(deps: GraphTabDeps): InspectorTab {
  const panel = document.createElement("div");
  panel.className = "graph-panel";
  const host = document.createElement("div");
  host.className = "graph-host";
  const status = document.createElement("div");
  status.className = "inspector-empty graph-status";
  const optionsButton = document.createElement("button");
  optionsButton.type = "button";
  optionsButton.className = "icon-button graph-options-button";
  optionsButton.setAttribute("aria-label", "Show options");
  optionsButton.setAttribute("aria-expanded", "false");
  optionsButton.append(Object.assign(document.createElement("span"), { className: "more-icon" }));
  const options = document.createElement("div");
  options.className = "popover graph-options";
  options.hidden = true;
  const stats = document.createElement("div");
  stats.className = "canvas-stat graph-stat";
  host.append(status, stats);
  bindFrameStats(stats, showStats);
  panel.append(host, optionsButton, options);

  let show: ShowOptions = readShowOptions();
  let data: SpaceGraphResponse | undefined;
  let scene: GraphScene | undefined;
  let module: SceneModule | undefined;
  let renderer: ReturnType<SceneModule["createGraphRenderer"]> | undefined;
  let visible = false;
  let stale = true;
  let loading = false;
  let focusId: string | null = null;
  let drawnFor: string | null | undefined;
  let refetchTimer = 0;

  const setStatus = (text: string, failed = false) => {
    if (failed) status.replaceChildren(createInlineError({ message: text }));
    else status.textContent = text;
    status.hidden = text === "";
  };

  // ---- Colours, read from the theme's tokens ----

  const probe = document.createElement("span");
  probe.className = "graph-probe";
  panel.append(probe);
  const colorOf = (css: string): number => {
    probe.style.color = css;
    const value = getComputedStyle(probe).color;
    const parts = value.match(/[\d.]+/g)?.map(Number) ?? [0, 0, 0];
    const [r, g, b] = value.startsWith("color(") ? parts.slice(0, 3).map((part) => Math.round(part * 255)) : parts;
    return (r << 16) | (g << 8) | b;
  };
  const token = (name: string) => colorOf(`var(${name})`);
  const readLook = (): GraphLook => {
    const plain = token("--graph-kind-plain");
    const kinds = Object.fromEntries(Object.entries(KIND_TOKENS).map(([kind, name]) => [kind, token(name)]));
    return {
      background: colorOf(getComputedStyle(host).backgroundColor),
      text: getComputedStyle(panel).color,
      line: token("--graph-line"),
      highlight: token("--graph-highlight"),
      noteGrey: plain,
      hues: Object.fromEntries(HUES.map((hue) => [hue, token(`--graph-hue-${hue}`)])) as unknown as Hues,
      font: getComputedStyle(panel).fontFamily,
      colorOf(node) {
        if (node.kind === "tag" && node.color) return { color: colorOf(node.color), alpha: 1 };
        return { color: kinds[node.kind] ?? plain, alpha: node.kind === "missing" ? 0.5 : 1 };
      },
    };
  };
  // The theme can change under the tab: a pick in Settings, or the system's
  // own switch when following it.
  let lookFrame = 0;
  const relook = () => {
    cancelAnimationFrame(lookFrame);
    lookFrame = requestAnimationFrame(() => scene?.setLook(readLook()));
  };
  new MutationObserver(relook).observe(document.documentElement, { attributes: true });
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", relook);

  // ---- The scene ----

  // A rebuild keeps every node shown before where it was, and starts the
  // camera where the last one left it, so moving to a linked file eases
  // over rather than starting afresh.
  function draw(): void {
    if (!data || !module) return;
    drawnFor = focusId;
    const start = scene?.positions();
    const view = scene?.view();
    scene?.dispose();
    scene = undefined;
    if (focusId === null) {
      host.classList.add("empty");
      setStatus("No file open.");
      return;
    }
    const graph = localGraph(data, show, focusId);
    if (graph.nodes.length === 0) {
      host.classList.add("empty");
      setStatus("Nothing links to or from this file.");
      return;
    }
    host.classList.remove("empty");
    setStatus("");
    renderer ??= module.createGraphRenderer();
    scene = module.createGraphScene(host, graph, {
      renderer,
      look: readLook(),
      start,
      view,
      open: (node) => deps.open(node.id),
      menu: (node, at) =>
        deps.contextMenu.open({ menu: GRAPH_NODE_MENU, arg: graphNodeTarget(node.id), at, ariaLabel: node.label }),
    });
    scene.focus(focusId);
    if (!visible) scene.pause();
  }

  async function load(): Promise<void> {
    if (loading) return;
    loading = true;
    stale = false;
    if (!scene) setStatus("Loading the graph");
    try {
      const [loaded, graph] = await Promise.all([module ? undefined : import("./graphScene.ts"), fetchSpaceGraph()]);
      module ??= loaded;
      data = graph;
      draw();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Failed to load the graph", true);
    } finally {
      loading = false;
    }
    if (stale && visible) void load();
  }

  spaceChanges.followSpace(() => {
    stale = true;
    if (!visible) return;
    window.clearTimeout(refetchTimer);
    refetchTimer = window.setTimeout(() => void load(), 400);
  });

  // ---- Show switches ----

  function change(next: ShowOptions): void {
    show = next;
    writeShowOptions(show);
    draw();
  }

  function toggle(label: string, on: boolean, set: (value: boolean) => void): HTMLElement {
    const row = document.createElement("div");
    row.className = "graph-option";
    row.append(Object.assign(document.createElement("span"), { textContent: label }), createSwitch(label, on, set));
    return row;
  }

  options.append(
    Object.assign(document.createElement("h3"), { className: "section-label graph-option-title", textContent: "Show" }),
    ...EDGE_GROUPS.map((group) =>
      toggle(group.label, show.edges.includes(group.key), (value) =>
        change({
          ...show,
          edges: value ? [...show.edges, group.key] : show.edges.filter((key) => key !== group.key),
        }),
      ),
    ),
    ...SHOW_SWITCHES.map((row) => toggle(row.label, show[row.key], (value) => change({ ...show, [row.key]: value }))),
  );

  let optionsOpen = false;
  const setOptionsOpen = (open: boolean) => {
    optionsOpen = open;
    options.hidden = !open;
    optionsButton.setAttribute("aria-expanded", String(open));
  };
  optionsButton.addEventListener("click", () => setOptionsOpen(!optionsOpen));
  document.addEventListener("pointerdown", (event) => {
    const inside = options.contains(event.target as Node) || optionsButton.contains(event.target as Node);
    if (optionsOpen && !inside) setOptionsOpen(false);
  });
  panel.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && optionsOpen) {
      setOptionsOpen(false);
      optionsButton.focus();
    }
  });

  return {
    id: "graph",
    label: "Graph",
    icon: ICON,
    panel,
    setTab(tab: Tab) {
      focusId =
        tab.kind === "empty" || tab.kind === "find-context" || tab.kind === "version"
          ? null
          : tab.kind === "gallery"
            ? `${tab.path}/`
            : tab.path;
      if (visible && data && focusId !== drawnFor) draw();
    },
    onShow() {
      visible = true;
      if (stale || !data) void load();
      else if (focusId !== drawnFor) draw();
      else scene?.resume();
    },
    onHide() {
      visible = false;
      scene?.pause();
      setOptionsOpen(false);
    },
  };
}
