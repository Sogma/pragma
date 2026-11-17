// A version History kept of a file, as a diff against the file's text now:
// the red lines are the version's, the green ones what replaced them since.
// The version rides on its tab, never persisted, as a Find in context answer does.
import { fetchHistoryVersion, type HistoryVersion, type Tab } from "../../core/apiClient.ts";
import { replacedBy } from "../../core/versionText.ts";
import { dateTimeLabel } from "../../lib/dateText.ts";
import { diffLines, renderLineDiff } from "../../lineDiff.ts";
import type { EditorPane, EditorPaneDescriptor } from "../../services/editorPanes.ts";

export interface VersionPaneDeps {
  /** Puts a version's text back in place of its file's: `gone` when the
   * file was deleted since, which Restore brings back. */
  restore(path: string, text: string, gone: boolean): Promise<void>;
}

export function versionPane(deps: VersionPaneDeps): EditorPaneDescriptor {
  return {
    kind: "version",
    // A status bar for the arrows: a file opened in the version's place
    // keeps it for Back.
    chrome: { toolbar: true, readingView: false, statusbar: true, actions: [] },
    create: () => createVersionPane(deps),
  };
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

interface Shown {
  path: string;
  content: string;
  gone: boolean;
}

export function createVersionPane(deps: VersionPaneDeps): EditorPane {
  const element = el("div", "editor-version");

  const copy = el("button", "icon-button");
  copy.type = "button";
  copy.setAttribute("aria-label", "Copy text");
  copy.append(el("span", "version-copy-icon"));
  // The tab's one action, drawn as a Flow's Run is.
  const restore = el("button", "toolbar-action primary-fill version-restore-button");
  restore.type = "button";
  restore.append(el("span", "version-restore-icon"), el("span", "", "Restore"));
  const toolbar = el("div", "version-toolbar");
  toolbar.append(copy, restore);

  // The version on show, once its text has come: what the toolbar acts on.
  let shown: Shown | undefined;
  const show = (next: Shown | undefined) => {
    shown = next;
    copy.disabled = restore.disabled = next === undefined;
  };
  show(undefined);

  // A refused clipboard is swallowed, as every copy button's is: only a
  // permission-denied browser hits it.
  copy.addEventListener("click", () => {
    if (shown) navigator.clipboard.writeText(shown.content).catch(() => undefined);
  });
  restore.addEventListener("click", () => {
    if (!shown) return;
    restore.disabled = true;
    void deps.restore(shown.path, shown.content, shown.gone).finally(() => {
      restore.disabled = shown === undefined;
    });
  });

  function render(version: HistoryVersion, content: string, current: string | undefined): void {
    const page = el("div", "version-page");
    const heading = el("div", "version-heading");
    heading.append(
      el("span", "version-when", dateTimeLabel(version.time)),
      el("span", "caption version-source", replacedBy(version)),
    );
    const note =
      current === undefined
        ? "The file has been deleted since. Restore brings it back with this text."
        : current === content
          ? "The file's text is the same as this version's."
          : "Changes made since this version.";
    page.append(heading, el("p", "caption version-note", note));
    if (current !== content) page.append(renderLineDiff(diffLines(content, current ?? "")));
    element.replaceChildren(page);
  }

  return {
    kind: "version",
    element,
    toolbar,
    async setInput(tab: Tab, ctx) {
      if (tab.kind !== "version") throw new Error(`the version pane can't show a "${tab.kind}" tab`);
      show(undefined);
      element.replaceChildren();
      try {
        const { content, current } = await fetchHistoryVersion(tab.path, tab.version.id);
        if (!ctx.isCurrent()) return;
        render(tab.version, content, current);
        show({ path: tab.path, content, gone: current === undefined });
      } catch {
        if (!ctx.isCurrent()) return;
        element.replaceChildren(el("p", "caption version-note version-missing", "This version is no longer kept."));
      }
    },
    clearInput() {
      show(undefined);
      element.replaceChildren();
    },
    title: () => undefined, // no title bar: the heading names the version
    dispose: () => element.remove(),
  };
}
