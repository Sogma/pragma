// A tab's file on a page while the pointer rests on its pill, for a tab that
// isn't shown: a note, a screenplay or a Table, under the strip, with its path
// above it. A pill names its file by the path it carries, as a link does; the
// group's view gives one only to a tab whose file isn't on screen.
//
// A glance, not a visit: the page takes no pointer (note-preview.css), so
// moving down onto it leaves the strip and the page goes at once. A click on
// the pill is what opens the file.
import { type Disposable, DisposableStore, listen } from "../lib/disposable.ts";
import { createPathLabel, type PathNames } from "../lib/pathLabel.ts";
import { closeTooltip } from "../lib/tooltip.ts";
import {
  createPage,
  loadPage,
  type PageKind,
  type PageSource,
  PREVIEW_DELAY_MS,
  pageKind,
  releasePage,
  sizePage,
} from "../notePreview.ts";

// Between the pill and the page, and between the page and its bounds.
const GAP = 6;
const MARGIN = 8;

export interface TabPreviewDeps extends Omit<PageSource, "openPath"> {
  /** The group's part of the editor a pill's page stays in: never left of
   * it or below it, though it may run past its right edge to the window's. */
  areaOf(pill: HTMLElement): HTMLElement | undefined;
  /** What the path over the page names a library by, and the icon its
   * entry draws. */
  pathNames: PathNames;
}

interface Shown {
  pill: HTMLElement;
  path: string;
  frame: HTMLElement;
  page: HTMLElement;
  // Where the pill was when its page showed: a redraw that moved it leaves
  // another pill under the pointer.
  left: number;
}

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(value, max));

/** Shows the file a pill in `host` names once the pointer rests on the pill,
 * and the next pill's at once while the pointer stays on the strip. Leaving
 * the strip, a press, a key, a wheel or a scroll of the strip takes it
 * down, and the next pill waits again. */
export function installTabPreview(host: HTMLElement, deps: TabPreviewDeps): Disposable {
  const store = new DisposableStore();
  // Nothing on the page is ever clicked: it takes no pointer.
  const source: PageSource = { ...deps, openPath: () => undefined };
  // The pill waiting out the rest, or whose file is being read.
  let pending: HTMLElement | undefined;
  let timer = 0;
  let shown: Shown | undefined;
  // Once a page has shown, the next pill's shows with no wait, until the
  // pointer leaves the strip or something done takes the page down.
  let warm = false;
  // Counts the reads started, so a file arriving after the pointer moved on is dropped.
  let reads = 0;

  // A strip redrawn under a still pointer takes down the page of a pill that
  // went, moved, or became its group's shown tab.
  const watcher = new MutationObserver(() => {
    if (!shown) return;
    const { pill, path, left } = shown;
    if (pill.isConnected && pill.dataset.spacePath === path && pill.getBoundingClientRect().left === left) return;
    forget();
    hide();
  });

  function pillAt(target: EventTarget | null): HTMLElement | undefined {
    const pill = target instanceof Element ? target.closest<HTMLElement>("[data-space-path]") : null;
    if (!pill || !host.contains(pill)) return undefined;
    return pageKind(pill.dataset.spacePath ?? "") ? pill : undefined;
  }

  function forget(): void {
    window.clearTimeout(timer);
    pending = undefined;
    reads++;
  }

  function hide(): void {
    if (!shown) return;
    watcher.disconnect();
    releasePage(shown.page);
    shown.frame.remove();
    shown = undefined;
  }

  function end(): void {
    forget();
    hide();
    warm = false;
  }

  function wait(pill: HTMLElement): void {
    pending = pill;
    if (warm) void open(pill);
    else timer = window.setTimeout(() => void open(pill), PREVIEW_DELAY_MS);
  }

  // The page shown before stays until the next is read, so sliding along the
  // strip never blanks between two.
  async function open(pill: HTMLElement): Promise<void> {
    const read = ++reads;
    const path = pill.dataset.spacePath ?? "";
    const kind = pageKind(path);
    if (!kind) return;
    const { frame, page } = build(path, kind);
    await loadPage(page, path, kind, source, () => read !== reads);
    if (read !== reads || !pill.isConnected || pill.dataset.spacePath !== path) {
      releasePage(page);
      return;
    }
    pending = undefined;
    hide();
    document.body.append(frame);
    shown = { pill, path, frame, page, left: pill.getBoundingClientRect().left };
    place(shown);
    warm = true;
    closeTooltip();
    watcher.observe(host, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-space-path"] });
  }

  function build(path: string, kind: PageKind): { frame: HTMLElement; page: HTMLElement } {
    const frame = document.createElement("div");
    frame.className = "tab-preview";
    // For the eye only: a screen reader has the pill, and the pane it opens.
    frame.setAttribute("aria-hidden", "true");
    const where = document.createElement("div");
    where.className = "tab-preview-path";
    where.append(createPathLabel(path, deps.pathNames, { type: "file", standalone: true }));
    const page = createPage(kind);
    frame.append(where, page);
    return { frame, page };
  }

  // Under the pill, centred on it and shifted only to stay in bounds. The
  // path line and the border come out of the room before the page is sized,
  // and the box takes the page's width, however long the path.
  function place({ pill, frame, page }: Shown): void {
    const box = pill.getBoundingClientRect();
    const area = deps.areaOf(pill)?.getBoundingClientRect();
    const left = (area?.left ?? 0) + MARGIN;
    const right = window.innerWidth - MARGIN;
    const top = box.bottom + GAP;
    const bottom = (area?.bottom ?? window.innerHeight) - MARGIN;
    const edges = frame.offsetWidth - frame.clientWidth;
    const chrome = frame.offsetHeight - page.offsetHeight;
    const width = sizePage(page, right - left - edges, bottom - top - chrome) + edges;
    frame.style.width = `${width}px`;
    frame.style.left = `${clamp((box.left + box.right) / 2 - width / 2, left, right - width)}px`;
    frame.style.top = `${top}px`;
  }

  // A wait starts on a move only: a pill redrawn or scrolled under a still
  // pointer gets an over and no move. Never mid-press: a press is a click or
  // a drag. Nor while a menu is open over the strip.
  store.add(
    listen(host, "pointermove", (event) => {
      const pointer = event as PointerEvent;
      if (pointer.pointerType === "touch" || pointer.buttons !== 0) return;
      const pill = pillAt(pointer.target);
      if (pill !== undefined && pill === pending) return;
      forget();
      if (pill === undefined) hide();
      else if (pill !== shown?.pill && !deps.contextMenu.isOpen()) wait(pill);
    }),
  );
  // Off the strip, the window's edge included. A pointer that crossed a part
  // of the header the window is dragged by may reach the editor having told
  // the strip nothing, so arriving anywhere else counts too.
  store.add(listen(host, "pointerleave", end));
  store.add(
    listen(document, "pointerover", (event) => {
      if ((shown || pending) && !(event.target instanceof Node && host.contains(event.target))) end();
    }),
  );
  for (const type of ["pointerdown", "keydown", "wheel", "dragstart"]) {
    store.add(listen(document, type, end, { capture: true, passive: true }));
  }
  for (const type of ["blur", "resize"]) store.add(listen(window, type, end));
  // Only a scroll that moves the pill: the chat scrolls as it writes.
  store.add(
    listen(
      document,
      "scroll",
      (event) => {
        const pill = shown?.pill ?? pending;
        if (pill && event.target instanceof Node && event.target.contains(pill)) end();
      },
      { capture: true, passive: true },
    ),
  );
  // While a page shows, its pill's × opens no tooltip over it. On the window,
  // so this hears the move after the tooltips' own listener on the document.
  store.add(
    listen(window, "pointerover", (event) => {
      if (shown && event.target instanceof Node && shown.pill.contains(event.target)) closeTooltip();
    }),
  );
  store.add(() => watcher.disconnect());
  store.add(end);
  return store;
}
