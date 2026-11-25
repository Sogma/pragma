import type { SelectedRange } from "../../src/protocol/api.ts";
import { scopeOf } from "../../src/protocol/scopes.ts";
import type { ChatViewContext, SelectedFile, Tab } from "./apiClient.ts";
import { isForeignRootTab } from "./paths.ts";
import { scopesOf } from "./spaceTree.ts";
import { activeTabOf, type EditorGroup } from "./workspace.ts";

// What the copilot is told the writer is looking at. `activePath` is only
// meaningful for a document or an applet in Source mode; every other tab that shows a
// file is named from the tab itself. Falling through to activePath for media
// or a running applet would let the copilot's edit tool treat it as a
// document and overwrite a file's binary bytes with text.
//
// A tab with no file of its own is "none", never undefined: the turn is
// still sent, so the chat never swallows a message without a word.
export function chatViewContext(
  activeTab: Tab,
  activePath: string | undefined,
  selection: PaneSelection | undefined,
): ChatViewContext {
  const view = paneView(activeTab, activePath, selection);
  return selection?.file ? { ...view, file: selection.file } : view;
}

function paneView(
  activeTab: Tab,
  activePath: string | undefined,
  selection: PaneSelection | undefined,
): ChatViewContext {
  // A library's file reaches the copilot only as an image to look at: its
  // other tools read the space.
  if (isForeignRootTab(activeTab)) {
    return activeTab.kind === "image" ? { view: "image", path: activeTab.path } : { view: "none" };
  }
  if (activeTab.kind === "gallery") return { view: "folder", path: activeTab.path };
  if (activeTab.kind === "image") return { view: "image", path: activeTab.path };
  if (activeTab.kind === "video") return { view: "video", path: activeTab.path };
  if (activeTab.kind === "pdf") return { view: "pdf", path: activeTab.path };
  if (activeTab.kind === "applet") return { view: "applet", path: activeTab.path };
  if (activeTab.kind === "flow") return { view: "flow", path: activeTab.path, node: selection?.node };
  if (activeTab.kind === "table") return { view: "table", path: activeTab.path };
  return activePath !== undefined
    ? { view: "document", path: activePath, selection: selection?.range }
    : { view: "none" };
}

/** What the focused pane has selected, which the copilot is told of: a
 * document's text, the node a Flow's canvas has selected, or a file the pane
 * points at. */
export interface PaneSelection {
  range?: SelectedRange;
  node?: string;
  file?: SelectedFile;
}

/** The editor groups, as the workspace holds them. */
export interface ScreenGroups {
  groups(): readonly EditorGroup[];
  focusedGroup(): EditorGroup;
}

/** The scope the focused tab sits in, none for a tab with no space file,
 * and the scope of every group's tab. */
export interface ScopesOnScreen {
  focused: string | undefined;
  shown: readonly string[];
}

/** What the writer sees, as the chat reads it: the focused group's tab, the
 * other group's while it shows another file the copilot is told of, and the
 * scopes shown. */
export interface ChatScreen {
  focused: ChatViewContext;
  beside?: ChatViewContext;
  scopes: ScopesOnScreen;
}

// A tab with no space file sits in no scope: a blank tab, a Find in context
// answer, a library's file.
function scopeOfTab(tab: Tab): string | undefined {
  if (tab.kind === "empty" || tab.kind === "find-context" || isForeignRootTab(tab)) return undefined;
  return scopeOf(scopesOf(tab.path), tab.path);
}

export function chatScreen(
  screen: ScreenGroups,
  activePath: (groupId: string) => string | undefined,
  selection: PaneSelection | undefined,
): ChatScreen {
  const group = screen.focusedGroup();
  const focused = chatViewContext(activeTabOf(group), activePath(group.id), selection);
  const scopes = {
    focused: scopeOfTab(activeTabOf(group)),
    shown: screen.groups().flatMap((each) => scopeOfTab(activeTabOf(each)) ?? []),
  };
  const other = screen.groups().find((each) => each !== group);
  if (!other) return { focused, scopes };
  const beside = chatViewContext(activeTabOf(other), activePath(other.id), undefined);
  if (beside.view === "none" || (focused.view !== "none" && focused.path === beside.path)) return { focused, scopes };
  return { focused, beside, scopes };
}

/** Which scope's chat shows next. The one showing stays while its scope is
 * on screen, so moving between groups never swaps the conversation; once it
 * has left, the chat follows the focused tab. A tab in no scope moves none. */
export function chatScopeFor(showing: string, { focused, shown }: ScopesOnScreen): string {
  return shown.includes(showing) ? showing : (focused ?? showing);
}

/** The scope the chat's switch offers: the focused tab's while it is another,
 * or else another group's on screen, so two scopes side by side always offer
 * each other whichever group has focus. None while every tab is the chat's. */
export function switchScopeFor(showing: string, { focused, shown }: ScopesOnScreen): string | undefined {
  if (focused !== undefined && focused !== showing) return focused;
  return shown.find((scope) => scope !== showing);
}
