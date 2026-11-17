import type { Tab } from "./apiClient.ts";

// A group is the tabs one strip shows and the one of them on screen. The
// workspace holds its groups in on-screen order, and exactly one has focus:
// the group a command, the assistant and the copilot act on.
//
// `readingView` and `sourceMode` are the group's modes, not any tab's: each
// holds across the files the group shows. A read-only tab reads whatever
// reading view says; Source mode shows text as written while it is edited.
export interface EditorGroup {
  readonly id: string;
  tabs: Tab[];
  activeTabIndex: number;
  readingView: boolean;
  sourceMode: boolean;
}

interface WorkspaceState {
  groups: EditorGroup[];
  focusedId: string;
  nextId: number;
}

// Seeded with one tab so `activeTabIndex` is always a valid index into
// `tabs` — never a separate "no tabs yet" state to check for. Boot replaces
// this default once the saved layout (or its absence) is known, and closing a
// group's last tab always leaves one or removes the group, so the invariant
// holds from then on.
const state: WorkspaceState = {
  groups: [{ id: "group-1", tabs: [{ kind: "empty" }], activeTabIndex: 0, readingView: false, sourceMode: false }],
  focusedId: "group-1",
  nextId: 2,
};

export function groups(): readonly EditorGroup[] {
  return state.groups;
}

export function groupById(id: string): EditorGroup | undefined {
  return state.groups.find((group) => group.id === id);
}

export function focusedGroup(): EditorGroup {
  const group = groupById(state.focusedId);
  if (!group) throw new Error(`no editor group with id "${state.focusedId}"`);
  return group;
}

export function setFocusedGroup(id: string): void {
  if (!groupById(id)) throw new Error(`no editor group with id "${id}"`);
  state.focusedId = id;
}

/** A new group of one empty tab, placed last — the right-hand side. */
export function addGroup(): EditorGroup {
  const group: EditorGroup = {
    id: `group-${state.nextId++}`,
    tabs: [{ kind: "empty" }],
    activeTabIndex: 0,
    readingView: false,
    sourceMode: false,
  };
  state.groups.push(group);
  return group;
}

/** Removes a group, handing focus to its neighbour if it had it. The last
 * group is never removed: closing its last tab leaves an empty one. */
export function removeGroup(id: string): void {
  const index = state.groups.findIndex((group) => group.id === id);
  if (index === -1 || state.groups.length === 1) return;
  state.groups.splice(index, 1);
  if (state.focusedId === id) state.focusedId = state.groups[Math.max(0, index - 1)].id;
}

// `activeTabIndex` is always a valid index into `tabs` (see the seed comment
// above), so a caller needs no undefined guard before reading this.
export function activeTabOf(group: EditorGroup): Tab {
  return group.tabs[group.activeTabIndex];
}

/** The focused group's active tab: what "the open document" means. */
export function activeTab(): Tab {
  return activeTabOf(focusedGroup());
}
