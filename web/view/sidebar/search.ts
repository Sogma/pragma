// The Search view: every file the space tree shows, searched as you type,
// results grouped by file. A line match opens its file and selects the
// match — an Applet's in Edit code, since the running applet shows none of
// its source.
//
// Private documents are included: this is the person searching their own
// space, and nothing reaches a model.
//
// Showing the view again re-runs the query, since an edit made since would
// leave a line pointing at the wrong text.
import { basenameOf, dirnameOf } from "../../../src/protocol/rootedPath.ts";
import { readSearchQuery } from "../../../src/protocol/searchQuery.ts";
import type { SpaceSearchFile, SpaceSearchHit, SpaceSearchResponse, SpaceTreeNode } from "../../core/apiClient.ts";
import { stripExtension } from "../../core/paths.ts";
import { entryIconAt } from "../../core/spaceTree.ts";
import { el, setEntryIcon } from "../../lib/dom.ts";
import type { CommandRegistry } from "../../services/commands.ts";
import type { EditorPane } from "../../services/editorPanes.ts";
import type { KeybindingRegistry } from "../../services/keybindings.ts";
import { COMMAND_PALETTE, type MenuRegistry } from "../../services/menus.ts";
import type { SidebarView } from "../../services/sidebarViews.ts";
import type { Tabs } from "../../services/tabs.ts";

const ICON = `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
  <circle cx="10.5" cy="10.5" r="6.5" />
  <line x1="15.2" y1="15.2" x2="21" y2="21" />
</svg>`;

export const SEARCH_VIEW_ID = "search";
const DEBOUNCE_MS = 250;
// Characters of a line kept before its first match: enough context to read
// the match in, few enough that a match deep in a long paragraph still lands
// inside the snippet's few wrapped lines.
const LEAD_CHARS = 60;

export interface SearchViewDeps {
  commands: CommandRegistry;
  menus: MenuRegistry;
  keybindings: KeybindingRegistry;
  search: (query: string, dir: string | undefined) => Promise<SpaceSearchResponse>;
  // Makes this the active sidebar view.
  show: () => void;
  tabs: () => Pick<Tabs, "openSpacePath" | "activePath">;
  activePane: () => EditorPane | undefined;
}

/** `text` with every case-insensitive occurrence of `needle` in a <mark>,
 * starting a little before the first one. */
export function highlightedSnippet(text: string, needle: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  const lower = text.toLowerCase();
  const target = needle.toLowerCase();
  const first = lower.indexOf(target);
  let at = first > LEAD_CHARS ? first - LEAD_CHARS : 0;
  if (at > 0) fragment.append("…");
  while (target) {
    const found = lower.indexOf(target, at);
    if (found === -1) break;
    fragment.append(text.slice(at, found));
    const mark = document.createElement("mark");
    mark.className = "match-mark";
    mark.textContent = text.slice(found, found + target.length);
    fragment.append(mark);
    at = found + target.length;
  }
  fragment.append(text.slice(at));
  return fragment;
}

export function createSearchView(deps: SearchViewDeps): SidebarView {
  const panel = el("section", "sidebar-panel search-panel");
  panel.hidden = true;
  const input = el("input", "form-input search-input");
  input.type = "search";
  input.placeholder = "Search";
  input.setAttribute("aria-label", "Search the space");
  const scope = el("div", "caption search-scope");
  scope.hidden = true;
  const scopeLabel = el("span", "search-scope-label");
  const scopeClear = el("button", "icon-button search-scope-clear", "×");
  scopeClear.type = "button";
  scopeClear.setAttribute("aria-label", "Search the whole space");
  scope.append(scopeLabel, scopeClear);
  const summary = el("p", "caption search-summary");
  const results = el("div", "search-results");
  const empty = el("p", "sidebar-panel-empty", "Search the text of every file in the space.");
  panel.append(el("h2", "sidebar-title", "Search"), input, scope, summary, results, empty);

  let dir: string | undefined;
  let query = "";
  // What a result marks: the query's text, or for a query of tags alone, the
  // first tag as a note writes it.
  let marked = "";
  let requestToken = 0;
  let debounce: number | undefined;
  // Files whose matches are folded, kept across re-runs of one query.
  const folded = new Set<string>();

  async function openMatch(path: string, hit: SpaceSearchHit): Promise<void> {
    const tabs = deps.tabs();
    if (!("line" in hit)) return tabs.openSpacePath(path);
    await tabs.openSpacePath(path, { view: "code" });
    if (tabs.activePath() === path) deps.activePane()?.revealLine?.(hit.line, marked);
  }

  // `ambiguous`: another file in these results shares this one's name, so
  // the header names its folder too — otherwise the name alone says enough.
  function renderFile(file: SpaceSearchFile, ambiguous: boolean): HTMLElement {
    const group = el("div", "search-file");
    group.classList.toggle("folded", folded.has(file.path));
    const header = el("button", "search-file-header");
    header.type = "button";
    header.dataset.tooltip = file.path;
    header.setAttribute("aria-expanded", String(!folded.has(file.path)));
    const icon = el("span", "search-file-icon");
    setEntryIcon(icon, entryIconAt(file.path, "file"));
    header.append(el("span", "disclosure"), icon);
    header.append(el("span", "search-file-name", stripExtension(basenameOf(file.path))));
    if (ambiguous) header.append(el("span", "caption search-file-folder", dirnameOf(file.path)));
    header.append(el("span", "caption search-file-count", String(file.matches.length)));
    header.addEventListener("click", () => {
      const nowFolded = !folded.has(file.path);
      if (nowFolded) folded.add(file.path);
      else folded.delete(file.path);
      group.classList.toggle("folded", nowFolded);
      header.setAttribute("aria-expanded", String(!nowFolded));
    });
    const list = el("div", "card search-file-matches");
    for (const match of file.matches) {
      const row = el("button", "search-match");
      row.type = "button";
      if ("line" in match) row.dataset.tooltip = `Line ${match.line}`;
      else row.append(el("span", "caption search-match-label", match.label));
      const text = el("span", "search-match-text");
      text.append(highlightedSnippet(match.text, marked));
      row.append(text);
      row.addEventListener("click", () => void openMatch(file.path, match));
      list.append(row);
    }
    group.append(header, list);
    return group;
  }

  function render(response: SpaceSearchResponse): void {
    const count = response.files.reduce((total, file) => total + file.matches.length, 0);
    const tally = `${count.toLocaleString()} result${count === 1 ? "" : "s"}`;
    if (count === 0) summary.textContent = "No results.";
    else if (response.truncated) summary.textContent = `The first ${tally}. Narrow the search for the rest.`;
    else summary.textContent = tally;
    const shownName = (file: SpaceSearchFile) => stripExtension(basenameOf(file.path)).toLowerCase();
    const sharing = new Map<string, number>();
    for (const file of response.files) sharing.set(shownName(file), (sharing.get(shownName(file)) ?? 0) + 1);
    results.replaceChildren(...response.files.map((file) => renderFile(file, (sharing.get(shownName(file)) ?? 0) > 1)));
  }

  async function run(): Promise<void> {
    window.clearTimeout(debounce);
    const token = ++requestToken;
    const trimmed = input.value.trim();
    const idle = trimmed === "";
    empty.hidden = !idle;
    summary.hidden = idle;
    results.hidden = idle;
    if (idle) {
      results.replaceChildren();
      return;
    }
    if (trimmed !== query) folded.clear();
    query = trimmed;
    const { tags, text } = readSearchQuery(trimmed);
    marked = text || (tags.length > 0 ? `#${tags[0]}` : "");
    try {
      const response = await deps.search(trimmed, dir);
      if (token === requestToken) render(response);
    } catch {
      if (token !== requestToken) return;
      summary.textContent = "Search failed.";
      results.replaceChildren();
    }
  }

  function setScope(next: string | undefined): void {
    dir = next || undefined;
    scope.hidden = dir === undefined;
    scopeLabel.textContent = dir === undefined ? "" : `In ${dir}`;
    scopeLabel.dataset.tooltip = dir ?? "";
  }

  input.addEventListener("input", () => {
    window.clearTimeout(debounce);
    debounce = window.setTimeout(() => void run(), DEBOUNCE_MS);
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") void run();
  });
  scopeClear.addEventListener("click", () => {
    setScope(undefined);
    void run();
    input.focus();
  });
  void run();

  function focus(): void {
    deps.show();
    input.focus();
    input.select();
  }

  deps.commands.register({ id: "search.focus", label: "Search This Space", run: focus });
  deps.commands.register({
    id: "search.inFolder",
    label: "Search in Folder…",
    when: (_, arg) => (arg as { node?: SpaceTreeNode | null } | undefined)?.node?.type === "directory",
    run: (_, arg) => {
      setScope((arg as { node: SpaceTreeNode }).node.path);
      focus();
    },
  });
  // A tag opened from a note, searched for across the whole space.
  deps.commands.register({
    id: "search.forTag",
    label: "Search for Tag",
    when: (_, arg) => typeof (arg as { tag?: unknown } | undefined)?.tag === "string",
    run: (_, arg) => {
      setScope(undefined);
      input.value = `tag:${(arg as { tag: string }).tag}`;
      deps.show();
      void run();
    },
  });
  deps.keybindings.register({ key: "Mod+Shift+F", command: "search.focus" });
  deps.menus.register(COMMAND_PALETTE, [{ command: "search.focus" }]);

  return {
    id: SEARCH_VIEW_ID,
    label: "Search",
    icon: ICON,
    panel,
    onShow: () => {
      input.focus();
      if (input.value.trim()) void run();
    },
  };
}
