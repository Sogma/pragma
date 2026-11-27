// What the Tools tab's buttons act on (docs/protocol.md, Flows → Actions):
// the focused group's text document, through its live editor, or the Table
// it shows, as its pane holds it at the click.
//
// A text document's toolkits arrived on its own fetch, so following focus is
// a redraw, not a request. A Table's come with its file, which its pane reads
// only after focus moved to its tab: until then the Tools tab lists none.
import type { TextToolkitInfo } from "../src/protocol/api.ts";
import * as workspace from "./core/workspace.ts";
import type { ToolkitSource } from "./flow/toolkitAction.ts";
import { createDocumentAccess } from "./services/documentAccess.ts";
import type { EditorPane } from "./services/editorPanes.ts";
import type { Tabs } from "./services/tabs.ts";
import { isDocumentPane } from "./view/panes/documentPane.ts";
import { isTablePane } from "./view/panes/tablePane.ts";

export interface ToolkitTargetsDeps {
  focusedPane(): EditorPane | undefined;
  /** The tab session, read when it is used: it is built after the panel. */
  tabs(): Pick<Tabs, "activePath" | "activeDocument">;
  show(toolkits: readonly TextToolkitInfo[], document: string | undefined): void;
}

export interface ToolkitTargets {
  /** The document a click acts on, taken at the click, and its group. */
  target(): { path: string; source: ToolkitSource; group: string } | undefined;
  /** The text document's or Table's path `group` shows now. */
  activePath(group: string): string | undefined;
  /** Lists the focused tab's toolkits: on focus, and once `from`, a Table's
   * pane, has read its toolkits, when it is the focused one. */
  follow(from?: EditorPane): void;
}

export function createToolkitTargets(deps: ToolkitTargetsDeps): ToolkitTargets {
  return {
    // A model has frontmatter only for a note (.md): exactly the scope
    // `visibility: private` applies to (docs/architecture.md, Privacy).
    target() {
      const group = workspace.focusedGroup().id;
      const pane = deps.focusedPane();
      if (pane && isTablePane(pane)) {
        const at = pane.atClick();
        return at && { path: at.path, source: { kind: "table", at }, group };
      }
      const path = deps.tabs().activePath();
      const model = deps.tabs().activeDocument();
      if (!pane || !isDocumentPane(pane) || !path) return undefined;
      const access = createDocumentAccess({
        getView: () => pane.view,
        getActivePath: () => pane.path(),
        getActiveDocument: () => model,
        getContent: () => model?.content() ?? pane.view.state.doc.toString(),
      });
      return { path, source: { kind: "text", access }, group };
    },
    activePath(group) {
      const shown = workspace.groupById(group);
      const tab = shown && workspace.activeTabOf(shown);
      return tab?.kind === "table" ? tab.path : deps.tabs().activePath(group);
    },
    follow(from) {
      const pane = deps.focusedPane();
      if (from && from !== pane) return;
      const tab = workspace.activeTab();
      if (tab.kind !== "table") {
        deps.show(deps.tabs().activeDocument()?.toolkits ?? [], deps.tabs().activePath());
        return;
      }
      const table = pane && isTablePane(pane) ? pane.shownTable() : undefined;
      deps.show(table?.path === tab.path ? table.toolkits : [], tab.path);
    },
  };
}
