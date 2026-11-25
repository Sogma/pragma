// The editor pane registry (docs/architecture.md's Workspace and UI ownership section). One
// module per tab kind describes how to create a pane, and an editor group
// instantiates one per kind it shows, mounting one at a time; neither the
// group nor main.ts knows which kinds exist. A pane is never shared: two
// groups showing the same kind hold two instances.
import type { FileResponse, SelectedFile, Tab } from "../core/apiClient.ts";
import type { Disposable } from "../lib/disposable.ts";
import type { CommandRegistry } from "./commands.ts";
import type { FileNotices } from "./fileNotices.ts";
import type { KeybindingRegistry } from "./keybindings.ts";

export type PaneTabKind = Tab["kind"];

export interface OpenContext {
  // False once the group has moved on to another open (or closed) while
  // this one was still loading — a pane must not render a stale result.
  isCurrent(): boolean;
}

export interface EditorPane {
  readonly kind: PaneTabKind;
  // The pane's own DOM subtree, mounted into the group's host while active.
  readonly element: HTMLElement;
  // What this kind knows about the open file beyond the facts every file
  // shares, such as an image's dimensions, and about the file it points at
  // apart from its own. Mounted in the assistant's Info tab while the pane
  // is. One element for the pane's life, kept current by the pane, so it
  // never has to be re-fetched on an open. Absent for a kind with neither.
  readonly inspector?: HTMLElement;
  // The pane's own controls in the floating toolbar, mounted before the
  // reading-view toggle while the pane is: one element for the pane's life,
  // kept current by the pane. Absent for a kind with none.
  readonly toolbar?: HTMLElement;
  // An overlay of the pane's own in the toolbar's row, left of its box and
  // top-aligned with it, giving way first when the group is narrow: one
  // element for the pane's life, mounted while the pane is. Absent for a
  // kind with none.
  readonly toolbarAside?: HTMLElement;
  // An overlay of the pane's own under the toolbar's box, its right edge on
  // the box's: one element for the pane's life, mounted while the pane is.
  // Absent for a kind with none.
  readonly toolbarBelow?: HTMLElement;
  // The files the open document links to, mounted in the assistant's Links
  // tab while the pane is: one element for the pane's life, like the above.
  // Carries `data-empty` while the document links nowhere, which dims the
  // tab. Absent for a kind that lists none.
  readonly links?: HTMLElement;
  // The open document's properties, mounted in the assistant's Properties
  // tab while the pane is, like the above. Hidden while the open document
  // can keep none, so the tab says so; `data-empty` while it keeps none,
  // which dims the tab. Absent for a kind that never does.
  readonly properties?: HTMLElement;
  // The open document's paid jobs, mounted in the assistant's Tools tab
  // while the pane is, like the above. Carries `data-empty` while it has
  // none, which dims the tab unless the tab's own parts show something.
  // Absent for a kind that starts none.
  readonly tools?: HTMLElement;
  // Shows `tab`. `prefetched` is the tab's already-loaded file when the
  // caller has it in hand (a tree click fetches before it knows the kind);
  // otherwise the pane loads it.
  setInput(tab: Tab, ctx: OpenContext, prefetched?: FileResponse): Promise<void>;
  clearInput(): void;
  // The document's display name for the editor title bar, or undefined for
  // the filename fallback (docs/protocol.md, Display title).
  title(): string | undefined;
  // Where the group's title bar mounts for this pane — the pane's scroll
  // region, so the title scrolls with the content. Absent when the pane
  // renders its own title bar (the document pane does).
  titleHost?(): HTMLElement;
  // Scrolls to a line of the file — 1-based, whole-file, frontmatter
  // counted — and selects `text` where `at` says it starts, while it still
  // does, else its first occurrence on the line, else puts the cursor at its
  // start, flashing either. Absent for a kind with no lines.
  revealLine?(line: number, text?: string, at?: number): void;
  // Re-render in place after the group's reading view or Source mode flips.
  // Absent for a kind with neither.
  refresh?(): void;
  // A transient surface of the pane's own — a popover, a selection — that
  // Escape dismisses once no dialog or menu claims the key. Absent for a
  // kind with none.
  hasTransient?(): boolean;
  dismissTransient?(): void;
  // The file the pane points at apart from its own, which the copilot is
  // told of and may look at, and the inspector's "Selected …" section shows:
  // the one its preview shows, else a selected entry. Absent for a kind with
  // neither.
  selectedFile?(): SelectedFile | undefined;
  // What find's card can do in what the pane shows: "replace" where the
  // text can change, "find" where it can only be searched. Absent, or
  // undefined, where nothing can be: the chrome offers Find… by it.
  findable?(): "find" | "replace" | undefined;
  // Opens find's card, with Replace showing for `replace`.
  openFind?(replace: boolean): void;
  // Design mode, for a kind with a shape of its own: a Table's columns, a
  // row card's layout. Edit changes values; Design changes the shape, with
  // the values shown in it locked. Each is a deliberate step away from the
  // other, so neither can damage what the other edits. Absent for a kind
  // with nothing to design.
  design?: { isActive(): boolean; toggle(): void };
  // The ways this pane can draw its rows, for a kind that has more than
  // one: a Table's list and cards, a gallery's tile sizes and cards. Never
  // written to the file; the chrome lists them under one heading so a third
  // layout is one more entry rather than a new control, a line between
  // entries of different groups.
  layout?: {
    current(): string;
    set(id: string): void;
    available(): readonly { id: string; label: string; group?: string }[];
  };
  // The document's default view, which the chrome's one row writes from the
  // view shown here: your view stays this install's, and the space changes
  // only on that ask. `differs` is false where the write can't land, so the
  // row shows only while there is something to set. Absent for a kind whose
  // file keeps no view.
  //
  // A pane with one calls its group's viewChanged at every change to what it
  // shows, which takes the status bar's "saved" back once it stops holding.
  defaultView?: {
    differs(): boolean;
    // What the kind saves, shown on hover.
    readonly tooltip: string;
    // Whether it was written, which the chrome then says in the status bar.
    set(): Promise<boolean>;
  };
  dispose(): void;
}

// What a pane asks of the chrome around the host — the floating toolbar,
// its reading-view toggle (and the menu's matching item), the status bar,
// and which actions apply: overflow-menu items, plus "flow-run" for the
// toolbar's own Run button. Static per kind, applied on every switch.
//
// An applet's Source mode is decided when the menu opens instead, from the
// tab it is open in.
export interface PaneChrome {
  toolbar: boolean;
  readingView: boolean;
  statusbar: boolean;
  actions: readonly PaneAction[];
}

export type PaneAction =
  | "add-property"
  | "data-design"
  | "flow-run"
  | "flow-app-mode"
  | "flow-rename"
  | "flow-permissions";

export const NO_CHROME: PaneChrome = { toolbar: false, readingView: false, statusbar: false, actions: [] };

// The group a pane was created in, as the pane sees it. A pane reaches the
// toolbar, title bar and reading view only through this, so two groups
// showing one kind each drive their own.
export interface PaneGroup {
  // Where a dialog scoped to the pane anchors.
  readonly element: HTMLElement;
  isReadingView(): boolean;
  // Switches the group to editing. A read-only tab, which reading view never
  // lets go of, stays as it is.
  leaveReadingView(): void;
  // The group's Source mode: text shown as written, its format's formatting
  // off. A mode of the group's, held across the files it shows.
  isSourceMode(): boolean;
  // The pane drew new content: its title, and Run for a flow, are re-placed.
  rendered(): void;
  // The count beside the toolbar's Run, and what it reveals: the runs, in
  // the inspector's Tools tab.
  setFlowRuns(count: number): void;
  showRuns(): void;
  setAddPropertyAvailable(available: boolean): void;
  // Shown in the status bar while this group has focus.
  reportWordCount(count: { words: number; chars: number }): void;
  // A line of the pane's own, shown where a document's count is while this
  // group has focus: what it shows, or what it last did.
  reportReadout(text: string): void;
  // What an action did when nothing else on screen shows it, said in the
  // readout's place and flashed. What it returns takes it back.
  announce(text: string): () => void;
  // What the pane has to say about a file, counted on the status bar of
  // every group showing that file (services/fileNotices.ts).
  readonly notices: Pick<FileNotices, "begin" | "add">;
  // The pane wrote where its tab is left onto the tab, for the layout.
  placeChanged(): void;
  // The view shown changed, such as a Flow's pan, zoom or App Mode, so a
  // status bar line saying it is the default may no longer hold.
  viewChanged(): void;
  // Opens a file in the group beside this one, focus staying here: what a
  // run in this group opens to the side. Rejects when it can't be opened.
  openToSide(path: string): Promise<void>;
}

export interface EditorPaneDescriptor {
  kind: PaneTabKind;
  chrome: PaneChrome;
  create(group: PaneGroup): EditorPane;
}

export interface EditorPaneRegistry {
  register(descriptor: EditorPaneDescriptor): Disposable;
  get(kind: PaneTabKind): EditorPaneDescriptor | undefined;
  has(kind: PaneTabKind): boolean;
}

export function createEditorPanes(): EditorPaneRegistry {
  const descriptors = new Map<PaneTabKind, EditorPaneDescriptor>();
  return {
    register(descriptor) {
      if (descriptors.has(descriptor.kind)) {
        throw new Error(`an editor pane for "${descriptor.kind}" is already registered`);
      }
      descriptors.set(descriptor.kind, descriptor);
      return {
        dispose: () => {
          if (descriptors.get(descriptor.kind) === descriptor) descriptors.delete(descriptor.kind);
        },
      };
    },
    get: (kind) => descriptors.get(kind),
    has: (kind) => descriptors.has(kind),
  };
}

/** Escape dismissing the active pane's own transient (see `hasTransient`),
 * once no dialog or menu has claimed the key. */
export function registerPaneDismiss(commands: CommandRegistry, keybindings: KeybindingRegistry): void {
  commands.register({
    id: "editor.dismiss",
    label: "Dismiss",
    when: (context) => context.pane?.hasTransient?.() ?? false,
    run: (context) => context.pane?.dismissTransient?.(),
  });
  keybindings.register({ key: "Escape", command: "editor.dismiss" });
}
