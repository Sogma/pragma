// The History section under the space tree: the files with earlier versions
// kept, the most recently changed first. A file opens to its versions, each
// by when it was kept and what wrote over it; a version opens beside its file
// to compare and restore. A deleted file stays listed while its versions last.

import { basenameOf, dirnameOf } from "../../../src/protocol/rootedPath.ts";
import {
  fetchHistoryFiles,
  fetchHistoryVersions,
  type HistoryFile,
  type HistoryVersion,
} from "../../core/apiClient.ts";
import { fileTypeClass, fileTypeLabel, stripExtension } from "../../core/paths.ts";
import { replacedBy } from "../../core/versionText.ts";
import { dateTimeLabel, shortWhen, versionWhen } from "../../lib/dateText.ts";
import { renderTreeIcon } from "../../lib/dom.ts";

export interface HistorySectionDeps {
  /** Whether the space still holds the file. */
  exists(path: string): boolean;
  showExtensions(): boolean;
  /** Opens a version beside its file. */
  openVersion(path: string, version: HistoryVersion): void;
}

export interface HistorySection {
  // What the Space panel holds under the section's header.
  readonly body: HTMLElement;
  // Reads the files afresh and draws them.
  refresh(): void;
  // Where the section's header shows how many files it lists.
  showCountIn(setCount: (text: string) => void): void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// A row the keyboard reaches and runs, as a click does.
function actionable(label: HTMLElement, run: () => void): void {
  label.tabIndex = 0;
  label.setAttribute("role", "button");
  label.addEventListener("click", run);
  label.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    run();
  });
}

export function createHistorySection(deps: HistorySectionDeps): HistorySection {
  const body = el("div", "history-section");
  const message = el("p", "stack-section-message");
  message.hidden = true;
  const list = el("ul", "history-list");
  list.dataset.tooltipWait = "";
  body.append(message, list);

  let files: HistoryFile[] = [];
  let setCount: ((text: string) => void) | undefined;
  // Open for the session, and each one's versions as last read.
  const open = new Set<string>();
  const versions = new Map<string, HistoryVersion[]>();

  async function refresh(): Promise<void> {
    try {
      files = await fetchHistoryFiles();
      message.textContent = "No earlier versions yet.";
    } catch {
      files = [];
      message.textContent = "Couldn't read the history.";
    }
    versions.clear();
    for (const path of [...open]) {
      if (!files.some((file) => file.path === path)) open.delete(path);
      else await readVersions(path);
    }
    render();
  }

  async function readVersions(path: string): Promise<void> {
    try {
      versions.set(path, await fetchHistoryVersions(path));
    } catch {
      versions.set(path, []);
    }
  }

  async function toggle(path: string): Promise<void> {
    if (open.delete(path)) return render();
    open.add(path);
    if (!versions.has(path)) await readVersions(path);
    render();
  }

  function fileRow(file: HistoryFile): HTMLLIElement {
    const gone = !deps.exists(file.path);
    const row = el("li", "tree-row history-file");
    row.classList.toggle("collapsed", !open.has(file.path));
    row.classList.toggle("gone", gone);
    const label = el("span", "node-label");
    label.setAttribute("aria-expanded", String(open.has(file.path)));
    label.dataset.tooltip = gone ? `${file.path}, deleted` : file.path;
    const name = basenameOf(file.path);
    const type = fileTypeClass(file.path);
    label.append(
      renderTreeIcon({ glyph: type }, fileTypeLabel(type)),
      el("span", "node-name", deps.showExtensions() ? name : stripExtension(name)),
    );
    const folder = dirnameOf(file.path);
    if (folder !== "") label.append(el("span", "caption history-folder", basenameOf(folder)));
    label.append(el("span", "caption history-time", shortWhen(file.latest)));
    actionable(label, () => void toggle(file.path));
    row.append(label);
    if (open.has(file.path)) row.append(versionList(file.path));
    return row;
  }

  function versionList(path: string): HTMLUListElement {
    const rows = el("ul", "history-versions");
    for (const version of versions.get(path) ?? []) {
      const row = el("li", "tree-row history-version");
      const label = el("span", "node-label");
      label.dataset.tooltip = dateTimeLabel(version.time);
      label.append(
        el("span", "history-when", versionWhen(version.time)),
        el("span", "caption history-source", replacedBy(version)),
      );
      actionable(label, () => deps.openVersion(path, version));
      row.append(label);
      rows.append(row);
    }
    return rows;
  }

  function render(): void {
    message.hidden = files.length > 0;
    list.hidden = files.length === 0;
    list.replaceChildren(...files.map(fileRow));
    setCount?.(files.length > 0 ? files.length.toLocaleString() : "");
  }

  return {
    body,
    refresh: () => void refresh(),
    showCountIn(set) {
      setCount = set;
    },
  };
}
