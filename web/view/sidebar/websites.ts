// The Websites view: every site in the space (each `_site.json`, see
// docs/publishing.md) as a single-open accordion, each row expandable in
// place into that site's folder of the live space tree.
//
// That tree is drawn with the *main* tree's editing context — rename,
// create, drag and context menu behave as in the Space view — so the context
// is injected: the tree's actions live with the tree's owner.
import type { SpaceSiteEntry, SpaceTreeNode } from "../../core/apiClient.ts";
import { buildAccordionRow, setRowExpanded } from "../../lib/accordion.ts";
import type { SidebarView } from "../../services/sidebarViews.ts";
import type { TreeRenderContext, TreeView } from "../fileTreeView.ts";

const ICON = `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
  <circle cx="12" cy="12" r="10" />
  <line x1="12" y1="2" x2="12" y2="22" />
  <line x1="2" y1="12" x2="22" y2="12" />
  <path d="M12 2C8.5 2.5 7 6.8 7 12C7 17.2 8.5 21.5 12 22" />
  <path d="M12 2C15.5 2.5 17 6.8 17 12C17 17.2 15.5 21.5 12 22" />
  <path d="M4.9 5Q12 8 19.1 5" />
  <path d="M4.9 19Q12 16 19.1 19" />
</svg>`;

export interface WebsitesViewDeps {
  fetchSites: () => Promise<SpaceSiteEntry[]>;
  // The live space tree's entries under `sitePath`, drawn with the editing
  // context the main tree uses.
  createTree: (listPath: string) => TreeView;
  siteNodes: (sitePath: string) => SpaceTreeNode[];
  renderContext: () => TreeRenderContext;
  // The per-row "⋮" trigger; main.ts supplies it and the menu it opens.
  // `sitePath` identifies the row
  // to whatever that menu holds — the bare path rather than a menu-argument
  // type, so this view stays unaware of the menu's own vocabulary.
  createMenuButton: (label: string, sitePath: string) => HTMLButtonElement;
}

export interface WebsitesView {
  view: SidebarView;
  // Re-renders whichever site is expanded from the live tree. The tree's
  // owner calls this after every tree re-render, so an action started in
  // either place keeps both in sync.
  refreshExpanded(): void;
  // Reloads the list itself, for a change to a site's `_site.json`, such as
  // its name, made while the list shows it.
  refresh(): Promise<void>;
}

interface Row {
  header: HTMLDivElement;
  body: HTMLDivElement;
}

export function createWebsitesView(deps: WebsitesViewDeps): WebsitesView {
  const panel = document.createElement("section");
  panel.className = "sidebar-panel";
  panel.hidden = true;
  const title = document.createElement("h2");
  title.className = "sidebar-title";
  title.textContent = "Websites";
  const empty = document.createElement("p");
  empty.className = "sidebar-panel-empty";
  const list = document.createElement("div");
  list.className = "sidebar-list";
  list.hidden = true;
  panel.append(title, empty, list);

  const rows = new Map<string, Row>();
  let expandedPath: string | undefined;
  // The open site's tree, kept across its redraws and dropped with its row.
  let expandedTree: TreeView | undefined;

  function dropTree(): void {
    expandedTree?.dispose();
    expandedTree = undefined;
  }

  function showEmpty(message: string): void {
    empty.textContent = message;
    empty.hidden = false;
    list.hidden = true;
  }

  function refreshExpanded(): void {
    if (expandedPath === undefined) return;
    const row = rows.get(expandedPath);
    if (!row) return;
    expandedTree ??= deps.createTree(expandedPath);
    if (expandedTree.element.parentNode !== row.body) row.body.replaceChildren(expandedTree.element);
    expandedTree.render(deps.siteNodes(expandedPath), deps.renderContext());
  }

  function setExpanded(sitePath: string | undefined): void {
    if (sitePath !== expandedPath) dropTree();
    expandedPath = sitePath;
    for (const [path, row] of rows) setRowExpanded(row, path === sitePath);
    refreshExpanded();
  }

  async function refresh(): Promise<void> {
    rows.clear();
    list.replaceChildren();
    dropTree();
    // Nothing shows until the fetch settles — neither a stale list nor an
    // empty-state message that may turn out to be wrong.
    empty.hidden = true;
    list.hidden = true;

    let sites: SpaceSiteEntry[];
    try {
      sites = await deps.fetchSites();
    } catch {
      showEmpty("Failed to load sites.");
      return;
    }
    if (sites.length === 0) {
      showEmpty("No sites in this space yet.");
      return;
    }
    empty.hidden = true;
    list.hidden = false;

    for (const site of sites) {
      const { item, header, body } = buildAccordionRow(
        site.name,
        site.domain || site.primaryDomain || site.path,
        deps.createMenuButton("Site options", site.path),
        () => setExpanded(expandedPath === site.path ? undefined : site.path),
      );
      list.append(item);
      rows.set(site.path, { header, body });
    }

    // A site expanded before this rebuild stays open if it still exists;
    // otherwise nothing is, rather than pointing at a row that's gone.
    setExpanded(expandedPath !== undefined && rows.has(expandedPath) ? expandedPath : undefined);
  }

  return {
    view: { id: "websites", label: "Websites", icon: ICON, panel, onShow: () => void refresh() },
    refreshExpanded,
    refresh,
  };
}
