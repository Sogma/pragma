// The toolkits in the assistant inspector's Tools tab (docs/protocol.md,
// Flows → Actions): an accordion of every Flow the open document's Classes
// or the open Table link, its action nodes as buttons, the document's runs
// under them, and the result area a run draws into. A section's header
// names its Flow; its More options button and a right-click open one menu.
//
// A run's result has nowhere else to land, hence one component. Buttons stay
// clickable while runs go, each click a run of its own, and a run's failure
// and results draw below them only while its document is shown.
import type { TextToolkitInfo } from "../../src/protocol/api.ts";
import type { FlowAction } from "../../src/protocol/flowActions.ts";
import { isTableFile } from "../../src/protocol/types.ts";
import { entryIconAt } from "../core/spaceTree.ts";
import type { ToolkitInvocation, ToolkitRow, ToolkitSource } from "../flow/toolkitAction.ts";
import { createToolkitRuns } from "../flow/toolkitRuns.ts";
import { readableTextColor } from "../lib/color.ts";
import { createOutcomeLine } from "../lib/outcomeLine.ts";
import type { DialogService } from "../services/dialog.ts";
import type { ContextMenuService, MenuItem } from "../services/menus.ts";
import type { ModelLists } from "../services/modelLists.ts";
import type { Tabs } from "../services/tabs.ts";
import type { StartedToolkitRun } from "./toolkitRunner.ts";

export interface ToolkitPanelElements {
  buttons: HTMLDivElement;
  results: HTMLDivElement;
}

export interface ToolkitPanelDeps {
  /** The document a button acts on and the editor group it is open in —
   * captured at the click, so the run keeps acting on that document (or
   * fails) wherever focus goes. Undefined when no text document or Table is
   * open. */
  target(): { path: string; source: ToolkitSource; group: string } | undefined;
  /** The open document's or Table's path in `group` now, checked after a run
   * so a stale run's failure can't overwrite what that group shows. */
  activePath(group: string): string | undefined;
  /** The tab session, read when it is used: it is built after the panel. */
  tabs(): Pick<Tabs, "onActivate" | "onGroupClosed" | "openEntryBeside" | "openBeside" | "openSpacePath">;
  /** Brings the panel back into view. What a run draws lands where its
   * button was, and the user may have switched away while it ran. */
  reveal(): void;
  start(invocation: ToolkitInvocation, actionId: string, row: ToolkitRow): StartedToolkitRun;
  // Asks before Cancel gives up a run's job whose credits are spent.
  confirm: DialogService["confirm"];
  contextMenu: ContextMenuService;
  modelLists: Pick<ModelLists, "get" | "load" | "subscribe">;
}

export interface ToolkitPanel {
  /** The open document, by path, and its resolved toolkits, in their order,
   * every section expanded on every call: one collapsed by hand doesn't
   * survive a tab switch. */
  setToolkits(toolkits: readonly TextToolkitInfo[], document: string | undefined): void;
}

export function createToolkitPanel(elements: ToolkitPanelElements, deps: ToolkitPanelDeps): ToolkitPanel {
  let toolkitsShown = false;
  // The document the panel shows, whose runs list under its buttons.
  let shown: string | undefined;
  const results = createOutcomeLine(elements.results, {
    fallback: "The toolkit button failed.",
    reveal: () => deps.reveal(),
  });
  const runs = createToolkitRuns({
    confirm: (options) => deps.confirm(options),
    openPath: (path) => void deps.tabs().openSpacePath(path),
    modelLists: deps.modelLists,
    contextMenu: deps.contextMenu,
    onCount: (count) => {
      if (count > 0) elements.buttons.setAttribute("data-running", String(count));
      else elements.buttons.removeAttribute("data-running");
      markEmpty();
    },
  });

  // data-empty dims the Tools tab (view/assistantPanel.ts).
  function markEmpty(): void {
    elements.buttons.toggleAttribute("data-empty", !toolkitsShown && runs.element.hasAttribute("data-empty"));
  }

  function runButton(toolkit: TextToolkitInfo, action: FlowAction): void {
    const target = deps.target();
    if (!target) return;
    const { path, source, group } = target;
    const tabs = deps.tabs();
    let stop = (_reason: string) => {};
    const openToSide = (file: string) => tabs.openBeside(file, group);
    const listed = runs.add({
      label: action.label,
      document: path,
      flowPath: toolkit.path,
      stop: (why) => stop(why),
      openToSide,
    });
    const invocation = { flow: { path: toolkit.path, name: toolkit.name }, path, source, openToSide };
    const run = deps.start(invocation, action.nodeId, listed);
    stop = run.stop;
    // The run's document access is bound to its group's pane, so the run
    // stops when that group shows another document or closes — not when
    // focus moves to the other group.
    const stopIn = (changed: { id: string }) => {
      if (changed.id === group) run.stop("The document changed");
    };
    const unwatch = [tabs.onActivate(stopIn), tabs.onGroupClosed(stopIn)];
    // Drawn only where the run's document still is, and never for a run the
    // person cancelled.
    const here = () => shown === path && deps.activePath(group) === path && !listed.cancelled();
    // Every button reports into one area, so a failure names its button.
    void results
      .run(() => run.done, {
        current: here,
        result: ({ lines, warnings }) => resultContent(lines, warnings),
        title: `${action.label} failed`,
      })
      .finally(() => {
        for (const off of unwatch) off();
        listed.ended();
      });
  }

  // A button wears its node's glyph and, when it has one, is filled with its
  // color, like the node's title bar on the canvas.
  function runButtonFor(action: FlowAction, run: () => void): HTMLButtonElement {
    const { label, comment, nodeType, color } = action;
    const runEl = document.createElement("button");
    runEl.type = "button";
    runEl.className = "run-button";
    runEl.dataset.nodeType = nodeType;
    if (comment) runEl.dataset.tooltip = comment;
    const glyph = document.createElement("span");
    glyph.className = "flow-node-dot";
    const content = document.createElement("span");
    content.className = "run-button-content";
    content.append(glyph, label);
    runEl.append(content);
    if (color) {
      runEl.classList.add("colored");
      runEl.style.setProperty("--node-color", color);
      runEl.style.color = readableTextColor(color);
    }
    runEl.addEventListener("click", run);
    return runEl;
  }

  function render(toolkits: readonly TextToolkitInfo[]): void {
    elements.buttons.innerHTML = "";
    results.clear();

    for (const toolkit of toolkits) {
      if (toolkit.actions.length === 0) continue;

      const section = document.createElement("div");
      section.className = "toolkit-section";

      // A row of two buttons, the fold toggle and More options: a <button>
      // header couldn't hold the menu button.
      const header = document.createElement("div");
      header.className = "toolkit-section-header";
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "section-label toolkit-section-toggle";
      const chevron = document.createElement("span");
      chevron.className = "disclosure toolkit-section-chevron";
      const title = document.createElement("span");
      title.className = "toolkit-section-title";
      title.textContent = toolkit.name || toolkit.path;
      // A nameless Flow's title is already its path.
      if (toolkit.name) toggle.dataset.tooltip = toolkit.path;
      toggle.append(chevron, title);

      // Beside the document, never in its place: the document's tab is what
      // the panel shows the toolkit for. The Class that gave it opens too, so
      // where the buttons come from is a click away; a Table's own links'
      // come from the Table itself, already open.
      const items: MenuItem[] = [
        {
          label: "Open Flow",
          icon: true,
          entryIcon: entryIconAt(toolkit.path, "file"),
          run: () => void deps.tabs().openEntryBeside(toolkit.path),
        },
      ];
      if (!isTableFile(toolkit.classPath)) {
        items.push({
          label: "Open Class",
          icon: true,
          entryIcon: entryIconAt(toolkit.classPath, "file"),
          run: () => void deps.tabs().openEntryBeside(toolkit.classPath),
        });
      }
      const menuButton = document.createElement("button");
      menuButton.type = "button";
      menuButton.className = "icon-button toolkit-section-menu";
      menuButton.setAttribute("aria-label", "More options");
      menuButton.setAttribute("aria-haspopup", "true");
      menuButton.setAttribute("aria-expanded", "false");
      const menuIcon = document.createElement("span");
      menuIcon.className = "more-icon";
      menuButton.append(menuIcon);
      menuButton.addEventListener("click", () => {
        if (deps.contextMenu.isOpen(menuButton)) deps.contextMenu.close();
        else deps.contextMenu.open({ items, anchor: menuButton, align: "end", ariaLabel: "Toolkit" });
      });
      header.append(toggle, menuButton);
      header.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        deps.contextMenu.open({ items, at: { x: event.clientX, y: event.clientY }, ariaLabel: "Toolkit" });
      });

      const body = document.createElement("div");
      body.className = "toolkit-section-body";
      toggle.setAttribute("aria-expanded", "true");
      // Folds in place: a redraw would clear the result a run drew below.
      toggle.addEventListener("click", () => {
        body.hidden = !body.hidden;
        toggle.setAttribute("aria-expanded", String(!body.hidden));
      });
      for (const action of toolkit.actions) body.appendChild(runButtonFor(action, () => runButton(toolkit, action)));

      section.append(header, body);
      elements.buttons.appendChild(section);
    }

    toolkitsShown = elements.buttons.hasChildNodes();
    if (!toolkitsShown) {
      const empty = document.createElement("p");
      empty.className = "inspector-empty";
      empty.textContent = "No toolkits for this file.";
      elements.buttons.appendChild(empty);
    }
    elements.buttons.append(runs.element);
    markEmpty();
  }

  // Informational rows with nothing to click, then `notes`, quieter, on what
  // the run sent as context.
  function resultContent(lines: readonly string[], warnings: readonly string[]): HTMLElement[] {
    const content: HTMLElement[] = [];
    for (const line of lines) {
      const row = document.createElement("div");
      row.className = "option";
      const textEl = document.createElement("span");
      textEl.className = "option-text";
      textEl.textContent = line;
      row.appendChild(textEl);
      content.push(row);
    }
    if (warnings.length) {
      const note = document.createElement("p");
      note.className = "caption action-results-note";
      note.textContent = warnings.join("\n");
      content.push(note);
    }
    return content;
  }

  return {
    setToolkits(next, document) {
      shown = document;
      runs.show(shown);
      render(next);
    },
  };
}
