// The empty pane: what a freshly "+"-opened tab shows, and what is left
// after closing the last tab (docs/architecture.md, Files and views). A pane like any
// other so the group always holds one and nothing outside it special-cases
// "nothing open".
import { createEntryIcon } from "../../lib/dom.ts";
import type { CommandContext, CommandRegistry } from "../../services/commands.ts";
import type { EditorPane, EditorPaneDescriptor } from "../../services/editorPanes.ts";
import type { MenuRegistry, ResolvedMenuItem } from "../../services/menus.ts";

/** The buttons an empty tab shows, contributed as a menu's items are: each
 * labelled as its command is, with the entry icon of what it makes. */
export const EMPTY_TAB_MENU = "editor.empty";

export interface EmptyPaneDeps {
  menus: MenuRegistry;
  commands: CommandRegistry;
}

export function emptyPane(deps: EmptyPaneDeps): EditorPaneDescriptor {
  return {
    kind: "empty",
    chrome: { toolbar: false, readingView: false, statusbar: false, actions: [] },
    create: () => createEmptyPane(deps),
  };
}

export function createEmptyPane(deps: EmptyPaneDeps): EditorPane {
  const element = document.createElement("div");
  element.className = "editor-empty";
  const actions = document.createElement("div");
  actions.className = "editor-empty-actions";
  element.append(actions);

  function actionButton(item: ResolvedMenuItem, context: CommandContext): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "editor-empty-action";
    if (item.entryIcon) button.append(createEntryIcon(item.entryIcon));
    const label = document.createElement("span");
    label.className = "editor-empty-action-label";
    label.textContent = item.label;
    button.append(label);
    button.addEventListener("click", () => {
      if (item.run) void item.run(context, item.arg);
      else if (item.command) void deps.commands.run(item.command, context, item.arg);
    });
    return button;
  }

  const pane: EditorPane = {
    kind: "empty",
    element,
    async setInput(tab) {
      if (tab.kind !== "empty") throw new Error(`the empty pane can't show a "${tab.kind}" tab`);
      const context = { tab, pane };
      actions.replaceChildren(
        ...deps.menus.resolve(EMPTY_TAB_MENU, context).map((item) => actionButton(item, context)),
      );
    },
    clearInput: () => undefined,
    title: () => undefined,
    dispose: () => element.remove(),
  };
  return pane;
}
