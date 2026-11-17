// The Find in context pane: a directory's markdown files ranked against a
// question, best match first, each with its score, the model's reasoning,
// and an Open action. The results ride on the tab itself — one search's
// answer, never persisted — so the pane has nothing to fetch.
import { basenameOf } from "../../../src/protocol/rootedPath.ts";
import type { FindContextResponse } from "../../core/apiClient.ts";
import type { EditorPane, EditorPaneDescriptor } from "../../services/editorPanes.ts";

export interface FindContextPaneDeps {
  openPath(path: string): void;
}

export function findContextPane(deps: FindContextPaneDeps): EditorPaneDescriptor {
  return {
    kind: "find-context",
    // A status bar for the arrows: a result opens in place, and Forward
    // returns to it from here.
    chrome: { toolbar: false, readingView: false, statusbar: true, actions: [] },
    create: () => createFindContextPane(deps),
  };
}

function el(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function createFindContextPane(deps: FindContextPaneDeps): EditorPane {
  const element = el("div", "editor-find-context");

  function render(result: FindContextResponse): void {
    element.replaceChildren(el("div", "find-context-header", "Top matches"));
    if (result.candidates.length === 0) {
      element.append(el("div", "find-context-empty", "No markdown files found in this directory yet."));
      return;
    }
    result.candidates.forEach((candidate, index) => {
      const best = index === 0;
      const card = el("div", best ? "card find-context-card best" : "card find-context-card");

      const top = el("div", "find-context-card-top");
      const title = el("div", "find-context-card-title");
      if (best) title.append(el("span", "find-context-best-tag", "Best match"));
      title.append(el("span", "find-context-card-name", basenameOf(candidate.path)));
      top.append(title, el("span", "find-context-score", `${Math.round(candidate.score * 100)}%`));
      card.append(top, el("div", "find-context-card-path", candidate.path));

      const bar = el("div", "find-context-bar");
      const fill = el("div", "find-context-bar-fill");
      fill.style.width = `${Math.max(0, Math.min(1, candidate.score)) * 100}%`;
      bar.append(fill);
      card.append(bar);

      if (candidate.reasoning.length > 0) {
        const reasoning = el("ul", "find-context-reasoning");
        for (const reason of candidate.reasoning) reasoning.append(el("li", "", reason));
        card.append(reasoning);
      }

      const actions = el("div", "find-context-card-actions");
      const open = document.createElement("button");
      open.type = "button";
      open.className = "find-context-open-button";
      open.textContent = "Open";
      open.addEventListener("click", () => deps.openPath(candidate.path));
      actions.append(open);
      card.append(actions);
      element.append(card);
    });
  }

  return {
    kind: "find-context",
    element,
    async setInput(tab) {
      if (tab.kind !== "find-context") throw new Error(`the Find in context pane can't show a "${tab.kind}" tab`);
      render(tab.result);
    },
    clearInput: () => element.replaceChildren(),
    title: () => undefined, // no title bar: the header names the view
    dispose: () => element.remove(),
  };
}
