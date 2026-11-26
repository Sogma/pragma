// A version History kept of a file, shown as the change that replaced it:
// the red lines are the version's, the green ones what its change put in,
// up to the next version or, for the newest, the file's text now. Since
// then compares an older version with the file's text now instead.
// The version rides on its tab, never persisted, as a Find in context answer does.
import {
  fetchHistoryVersion,
  type HistoryVersion,
  type HistoryVersionResponse,
  type Tab,
} from "../../core/apiClient.ts";
import { replacedBy } from "../../core/versionText.ts";
import { dateTimeLabel } from "../../lib/dateText.ts";
import { el } from "../../lib/dom.ts";
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

interface Shown {
  path: string;
  content: string;
  gone: boolean;
}

// What the diff compares the version with: the text its change left, or the
// file's text now.
type Compared = "change" | "since";

const SCOPES: readonly { compared: Compared; label: string }[] = [
  { compared: "change", label: "This change" },
  { compared: "since", label: "Since then" },
];

export function createVersionPane(deps: VersionPaneDeps): EditorPane {
  const element = el("div", "editor-version");

  const copy = el("button", "icon-button");
  copy.type = "button";
  copy.setAttribute("aria-label", "Copy the text before this change");
  copy.append(el("span", "version-copy-icon"));
  // The tab's one action, drawn as a Flow's Run is.
  const restore = el("button", "toolbar-action primary-fill version-restore-button");
  restore.type = "button";
  restore.dataset.tooltip = "Put back the text before this change";
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
  let compared: Compared = "change";

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

  function heading(version: HistoryVersion): HTMLElement {
    const row = el("div", "version-heading");
    const dot = el("span", "caption", "·");
    dot.setAttribute("aria-hidden", "true");
    row.append(
      el("span", "version-who", replacedBy(version)),
      dot,
      el("span", "caption version-when", dateTimeLabel(version.time)),
    );
    return row;
  }

  // Redrawn in place, so the pressed button keeps the focus a click gave it.
  function scopeSwitch(onChange: () => void): HTMLElement {
    const group = el("div", "version-scopes");
    group.setAttribute("role", "group");
    group.setAttribute("aria-label", "What to compare");
    const buttons = SCOPES.map(({ compared: each, label }) => {
      const button = el("button", "version-scope", label);
      button.type = "button";
      button.addEventListener("click", () => {
        if (compared === each) return;
        compared = each;
        for (const [index, other] of buttons.entries()) {
          other.setAttribute("aria-pressed", String(SCOPES[index].compared === compared));
        }
        onChange();
      });
      button.setAttribute("aria-pressed", String(compared === each));
      return button;
    });
    group.append(...buttons);
    return group;
  }

  // The newest version's change left the file's text now, so it has nothing
  // to switch between, and a deleted file's newest change can't be shown.
  function comparison({ content, next, current }: HistoryVersionResponse): HTMLElement[] {
    const since = next === undefined || compared === "since";
    const after = since ? current : next;
    if (after === undefined) {
      return [
        el("p", "caption version-note", "The file has been deleted since. Restore brings it back with this text."),
        renderLineDiff(diffLines(content, "")),
      ];
    }
    if (after === content) {
      const note =
        compared === "since"
          ? "The file's text is the same as this version's."
          : "This change left the text as it was.";
      return [el("p", "caption version-note", note)];
    }
    return [renderLineDiff(diffLines(content, after))];
  }

  function render(version: HistoryVersion, response: HistoryVersionResponse): void {
    const page = el("div", "version-page");
    const body = el("div", "version-body");
    const draw = () => body.replaceChildren(...comparison(response));
    page.append(heading(version));
    if (response.next !== undefined) page.append(scopeSwitch(draw));
    page.append(body);
    draw();
    element.replaceChildren(page);
  }

  return {
    kind: "version",
    element,
    toolbar,
    async setInput(tab: Tab, ctx) {
      if (tab.kind !== "version") throw new Error(`the version pane can't show a "${tab.kind}" tab`);
      show(undefined);
      compared = "change";
      element.replaceChildren();
      try {
        const response = await fetchHistoryVersion(tab.path, tab.version.id);
        if (!ctx.isCurrent()) return;
        render(tab.version, response);
        show({ path: tab.path, content: response.content, gone: response.current === undefined });
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
