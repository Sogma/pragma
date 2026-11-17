// An editor group's title bar: one element
// moved into whichever of the group's panes is showing, so the title scrolls
// with that pane's content instead of floating above it.
//
// One per group, not one per pane, because a pane that scrolls its own title
// has to own the scroll region too — mounting the group's single bar inside
// it is what keeps that one region rather than two competing ones.
import { createTitleBar } from "../lib/dom.ts";

/** What the active pane is, for the one caller that has to ask: a pane names
 * itself and says where its title scrolls, or — having a title bar of its own,
 * or none at all — offers no host for the shared one. */
export interface TitleHost {
  title(): string | undefined;
  titleHost(): HTMLElement | null;
}

export interface EditorTitleBar {
  /** Shows `title` in `host`, or detaches the bar outright when either is
   * absent. The document pane renders its own editable `# Heading`, so it
   * passes no host and the shared bar stays out of its way. */
  show(title: string, host: HTMLElement): void;
  hide(): void;
}

export function createEditorTitleBar(): EditorTitleBar {
  const { bar, input } = createTitleBar();

  return {
    show(title, host) {
      // Don't clobber the field the user is actively typing in — a guard that
      // only matters if the bar stops being read-only.
      if (document.activeElement !== input) input.value = title;
      input.readOnly = true;
      // Re-parenting is conditional, not unconditional: `prepend` on an
      // already-correct parent still moves the node, which blurs anything
      // focused inside it and restarts CSS transitions on every render.
      if (bar.parentElement !== host || host.firstElementChild !== bar) host.prepend(bar);
    },
    hide() {
      bar.remove();
    },
  };
}
