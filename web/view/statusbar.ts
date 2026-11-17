// An editor group's status bar: Back and Forward, the open file's path, its
// notices (errors, problems and the rest), and its word count. Kept in one
// module because they share the one rule that shows or hides the strip: the
// active pane declares whether it wants a status bar, except that a failing
// save overrides it.
//
// One bar at a time also holds the app's own indicators, which belong to no
// file: a write that hasn't reached disk, and a model request in flight.
import {
  basenameOf,
  dirnameOf,
  formatRootedPath,
  isLibraryRoot,
  parseRootedPath,
  type RootedPath,
} from "../../src/protocol/rootedPath.ts";
import { formatWordCount } from "../core/documentContent.ts";
import { ensureLibraryPermissions, libraryName, onLibraryNames } from "../core/libraries.ts";
import type { Direction } from "../core/tabHistory.ts";
import { Emitter } from "../lib/emitter.ts";
import { flash, unflash } from "../lib/flash.ts";
import type { NoticesByPath } from "../services/fileNotices.ts";
import type { ContextMenuService } from "../services/menus.ts";
import type { ConsoleEntryLevel } from "../services/modelConsole.ts";
import type { SaveQueueState } from "../services/saveQueue.ts";

/** The menu a right-click on a folder in the path opens. Its argument is
 * `{ folder }`, the folder's rooted path. */
export const PATH_FOLDER_MENU = "statusbar.pathFolder";

export interface AppIndicatorsDeps {
  /** Asks the save queue to write now instead of waiting out its backoff. */
  retrySaves(): void;
  /** Asks again about every save held as a conflict. */
  reviewConflicts(): void;
}

/** The save warning and the model activity glyph: one of each for the app,
 * in whichever bar holds them. */
export interface AppIndicators {
  /** Lit by the Console's model calls, which write its tooltip too. */
  readonly activity: HTMLElement;
  readonly save: HTMLButtonElement;
  renderSave(state: SaveQueueState): void;
  /** Whether a save is failing or held as a conflict. */
  readonly failing: Pick<Emitter<boolean>, "get" | "subscribe">;
}

export interface StatusbarDeps {
  /** Back or Forward in the bar's own group. */
  go(direction: Direction): void;
  /** The chord that does the same, for the button's tooltip. */
  shortcutFor(direction: Direction): string | undefined;
  /** Opens the Console at `path`'s first notice of `level`. */
  showNotices(path: string, level: ConsoleEntryLevel): void;
  /** Opens a folder named in the path as a gallery, in the place of the
   * bar's group's tab. */
  openFolder(path: string): void;
  contextMenu: ContextMenuService;
}

export interface Statusbar {
  readonly element: HTMLDivElement;
  /** Whether the group's tab has anywhere to go back or forward to. */
  setNavigation(can: Record<Direction, boolean>): void;
  /** How many things each level says about every open file; the bar shows
   * the counts of the path it names. */
  renderNotices(notices: NoticesByPath): void;
  setPath(filePath: string): void;
  setWordCount(count: { words: number; chars: number }): void;
  /** Blanks the count for a tab whose pane hasn't reported one yet — every
   * kind but a document never will. */
  clearWordCount(): void;
  /** A pane's own line in the count's place: what it shows, such as a folder
   * view's folders and files, or what its last action did, such as which note
   * a Class's edit was saved in. A count reported since the last clear
   * wins over it. */
  setReadout(text: string): void;
  /** What an action did when nothing else on screen shows it, in the count's
   * place over the count and readout, flashed since the action was taken
   * elsewhere. It holds until the tab changes, the pane reports a count or
   * readout other than its last, or the caller takes it back with what this
   * returns, which leaves a later announcement alone. */
  announce(text: string): () => void;
  /** The active pane's chrome, which decides whether the strip shows at all. */
  setDeclared(declared: boolean): void;
  /** Takes the app's indicators in, or lets another bar have them. */
  holdIndicators(hold: boolean): void;
  dispose(): void;
}

// How far a press on a folder in the path may travel and still open it.
const SELECT_THRESHOLD_PX = 4;

const SAVE_ICON =
  '<svg class="editor-statusbar-save-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3.8 2.2 20.2h19.6z"/><path d="M12 10v4.2"/><path d="M12 17.6h.01"/></svg>';

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}

export function createAppIndicators(deps: AppIndicatorsDeps): AppIndicators {
  const activity = element("div", "editor-statusbar-activity");
  activity.hidden = true;
  activity.setAttribute("aria-hidden", "true");

  const save = element("button", "editor-statusbar-save");
  save.type = "button";
  save.hidden = true;
  save.setAttribute("aria-label", "Unsaved changes, click to retry");
  save.innerHTML = SAVE_ICON;
  const saveLabel = element("span", "editor-statusbar-save-label");
  save.append(saveLabel);

  const failing = new Emitter(false);
  let conflictsHeld = false;

  // Normally hidden, because normally every save lands; when one doesn't, the
  // app has to say so rather than going on looking saved. It keeps a
  // visible label: "something of yours isn't on disk" is not a thing to
  // leave to a hover title.
  //
  // The queue keeps retrying on its own backoff either way. A conflict
  // outranks a failure: retrying can't fix it, and only the writer can.
  function renderSave(state: SaveQueueState): void {
    const conflicts = state.conflictPaths.length;
    const count = state.failedPaths.length;
    conflictsHeld = conflicts > 0;
    save.hidden = count === 0 && !conflictsHeld;
    if (conflicts > 0) {
      saveLabel.textContent = conflicts === 1 ? "Save conflict" : `${conflicts} save conflicts`;
      save.dataset.tooltip = `Changed by something else since you opened it: ${state.conflictPaths.join(", ")}\nClick to choose which version to keep.`;
    } else if (count > 0) {
      saveLabel.textContent = count === 1 ? "Not saved" : `${count} not saved`;
      save.dataset.tooltip = [
        `Couldn't save: ${state.failedPaths.join(", ")}`,
        state.message,
        "Retrying. Click to try now.",
      ]
        .filter(Boolean)
        .join("\n");
    }
    failing.set(!save.hidden);
  }

  save.addEventListener("click", () => (conflictsHeld ? deps.reviewConflicts() : deps.retrySaves()));

  return { activity, save, renderSave, failing };
}

// The notices a bar can show about its file, most severe first, each named
// for what its level means there.
const NOTICES = [
  { level: "error", className: "editor-statusbar-errors", noun: "error" },
  { level: "warn", className: "editor-statusbar-problems", noun: "problem" },
  { level: "info", className: "editor-statusbar-notices", noun: "notice" },
] as const;

// One level's notices about the named file, the details of which are in the
// Console: hidden while there's nothing to say, so its presence is the
// signal, like the save warning's, and a count that stays visible.
function notice({ level, className, noun }: (typeof NOTICES)[number]) {
  const button = element("button", className);
  button.type = "button";
  button.hidden = true;
  const icon = element("span", `${className}-icon`);
  icon.setAttribute("aria-hidden", "true");
  const label = element("span", `${className}-label`);
  button.append(icon, label);
  function draw(total: number): void {
    button.hidden = total === 0;
    const counted = total === 1 ? `1 ${noun}` : `${total} ${noun}s`;
    label.textContent = counted;
    button.dataset.tooltip = `This file has ${counted}. Click for the details in the Console.`;
  }
  return { level, button, draw };
}

function navButton(className: string, label: string): HTMLButtonElement {
  const button = element("button", `icon-button ${className}`);
  button.type = "button";
  button.disabled = true;
  button.setAttribute("aria-label", label);
  return button;
}

function buildBar() {
  const root = element("div", "editor-statusbar");
  const nav = element("div", "editor-statusbar-nav");
  const back = navButton("editor-statusbar-back", "Back");
  const forward = navButton("editor-statusbar-forward", "Forward");
  nav.append(back, forward);
  const path = element("div", "editor-statusbar-path");
  const notices = NOTICES.map(notice);
  const wordCount = element("div", "editor-statusbar-wordcount");
  root.append(nav, path, ...notices.map((shown) => shown.button), wordCount);
  return { root, back, forward, path, notices, wordCount };
}

export function createStatusbar(deps: StatusbarDeps, indicators: AppIndicators): Statusbar {
  const elements = buildBar();
  // What the path last rendered, so a library's name arriving can redraw it
  // without the caller having to know a fetch happened at all, and naming
  // the same path again redraws nothing.
  let lastPath: string | undefined;
  let noticesByPath: NoticesByPath = new Map();
  // Each folder above the named entry, with the separator after it, so a
  // folder the width drops takes its separator along.
  let steps: HTMLElement[] = [];
  // Its "… / " comes from the stylesheet, so a copy of the path never holds
  // an ellipsis.
  const more = element("span", "editor-statusbar-path-more");
  let count: { words: number; chars: number } | undefined;
  let countWordsOnly = false;
  let readout: string | undefined;
  // A count or readout ends it only when different: a pane reports the same
  // one again on every draw, the draw the announced action caused among them.
  let announcement: string | undefined;
  // Counts announcements, so a take-back meant for an earlier one does nothing.
  let announced = 0;

  let declared = false;
  let holding = false;

  // The strip rides the active pane's chrome, except when a save is failing:
  // that indicator is the only notice the writer gets that their work isn't
  // on disk, and a pane declaring no status bar (the empty tab) must not be
  // able to hide the bar holding it.
  function applyVisibility(): void {
    elements.root.hidden = !declared && !(holding && indicators.failing.get());
  }

  // A folder above the file opens in the tab's place, where Back returns
  // from; its menu offers a new tab or the other group. A button rather than
  // a span, so a keyboard can reach it.
  //
  // The path selects for copying, and a drag across part of a folder's name
  // still ends in a click on it. How far the press travelled decides, not
  // what got selected: Chromium can start no selection at the very start of
  // a name, and a shaky click can select a letter. A keyboard's click has no
  // press.
  let pressedAt: { x: number; y: number } | undefined;
  elements.path.addEventListener("pointerdown", (event) => {
    pressedAt = { x: event.clientX, y: event.clientY };
  });
  // A triple-click takes the whole path and stops there. Left to Chromium, it
  // runs on into the next selectable text on the page, and a copy ends in a
  // newline.
  elements.path.addEventListener("mousedown", (event) => {
    if (event.detail < 3) return;
    event.preventDefault();
    document.getSelection()?.selectAllChildren(elements.path);
  });
  function folderButton(folder: string, ...content: (Node | string)[]): HTMLButtonElement {
    const button = element("button", "editor-statusbar-path-folder");
    button.type = "button";
    button.append(...content);
    button.addEventListener("click", (event) => {
      const travel = pressedAt ? Math.hypot(event.clientX - pressedAt.x, event.clientY - pressedAt.y) : 0;
      if (event.detail > 0 && travel >= SELECT_THRESHOLD_PX) return;
      deps.openFolder(folder);
    });
    button.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      deps.contextMenu.open({
        menu: PATH_FOLDER_MENU,
        arg: { folder },
        at: { x: event.clientX, y: event.clientY },
        ariaLabel: "Folder actions",
      });
    });
    return button;
  }

  // A rooted path is written `lib:<id>/…`, but that spelling is for storage
  // and the wire, not for a person reading a breadcrumb. The scheme becomes
  // the Libraries icon and the id the library's own display name, so "this
  // file is somewhere else" reads the same way it does on a library tab.
  //
  // Until the registry is read the id stands in: it is what the path already
  // says, so the breadcrumb is never wrong, only less friendly. The read, or
  // a rename, redraws through the registry's own signal below.
  function libraryRoot(id: string): HTMLButtonElement {
    const name = libraryName(id);
    const icon = element("span", "editor-statusbar-path-root-icon");
    const root = folderButton(formatRootedPath({ root: { library: id }, path: "" }), icon, name ?? id);
    root.classList.add("editor-statusbar-path-root");
    if (name === undefined) void ensureLibraryPermissions();
    return root;
  }

  const stopNames = onLibraryNames(() => {
    if (lastPath !== undefined) drawPath(lastPath);
  });

  // A narrow bar gives way in order: the path's leading folders, whole and
  // one at a time, then the count's characters or the end of an
  // announcement, and only then the end of the file's name, which is what
  // says which file this is. The tooltip keeps the whole path, and a cut
  // announcement's its whole text.
  function fitPath(): void {
    cutAnnouncement(false);
    for (const wordsOnly of count && announcement === undefined ? [false, true] : [false]) {
      countWordsOnly = wordsOnly;
      drawCount();
      more.remove();
      for (const step of steps) step.hidden = false;
      for (const step of steps) {
        if (nameFits()) return;
        step.hidden = true;
        if (!more.isConnected) elements.path.prepend(more);
      }
      if (nameFits()) return;
    }
    cutAnnouncement(announcement !== undefined);
  }
  function nameFits(): boolean {
    const end = elements.path.lastElementChild?.getBoundingClientRect().right ?? 0;
    return end <= elements.path.getBoundingClientRect().right;
  }
  function cutAnnouncement(cut: boolean): void {
    elements.wordCount.classList.toggle("is-cut", cut);
    if (cut && announcement !== undefined) elements.wordCount.dataset.tooltip = announcement;
    else delete elements.wordCount.dataset.tooltip;
  }
  // The cut comes off with the announcement, not at the next fit: a count or
  // readout as wide resizes nothing, and would stay cut, saying it on hover.
  //
  // So does the flash: left to fade, it would light what replaced the
  // announcement, or the empty box's padding.
  function endAnnouncement(): void {
    announcement = undefined;
    cutAnnouncement(false);
    unflash(elements.wordCount);
  }
  // A resize is fitted on the next frame, not in the observer's callback:
  // dropping the count's characters resizes the path being observed, which
  // inside the callback is a loop the browser reports as an error.
  let fitFrame = 0;
  function refit(): void {
    cancelAnimationFrame(fitFrame);
    fitFrame = requestAnimationFrame(fitPath);
  }
  const resizes = new ResizeObserver(refit);
  resizes.observe(elements.path);
  // The bar too: while an announcement is cut the path keeps its own width,
  // so a widening bar resizes nothing else observed.
  resizes.observe(elements.root);

  // Shows the full ancestry, not just the immediate parent folder, as much
  // of it as the bar's width allows.
  //
  // Always shows the extension regardless of the tree's "show extensions"
  // setting. Unlike the tree — a list of many names, where the extension is
  // often redundant clutter — the bar names one specific file, where the
  // extension disambiguates same-named files of different kinds.
  function drawPath(filePath: string): void {
    let rooted: RootedPath | undefined;
    try {
      rooted = parseRootedPath(filePath);
    } catch {
      // An unparseable path still names a file to someone; show it verbatim,
      // with no folder to open, rather than blanking the bar over a breadcrumb.
    }
    const folders: (Node | string)[] = [];
    if (rooted && isLibraryRoot(rooted.root)) folders.push(libraryRoot(rooted.root.library));

    const within = rooted?.path ?? filePath;
    const dir = dirnameOf(within);
    const names = dir ? dir.split("/") : [];
    names.forEach((name, index) => {
      const folder = names.slice(0, index + 1).join("/");
      folders.push(rooted ? folderButton(formatRootedPath({ root: rooted.root, path: folder }), name) : name);
    });
    let named: Node | string | undefined;
    if (within) {
      named = element("span", "editor-statusbar-path-name");
      named.textContent = basenameOf(within);
    } else {
      // A library's top folder, shown as itself, ends at the library's name.
      named = folders.pop();
    }
    steps = folders.map((folder) => {
      const step = element("span", "editor-statusbar-path-step");
      const separator = element("span", "editor-statusbar-path-separator");
      separator.textContent = "/";
      step.append(folder, separator);
      return step;
    });
    elements.path.replaceChildren(...steps, ...(named === undefined ? [] : [named]));
    // The title keeps the real path, scheme included: it's what a copy-paste
    // or a bug report needs, and the only place the raw form still shows.
    elements.path.dataset.tooltip = filePath;
    drawNotices();
    fitPath();
  }

  function drawNotices(): void {
    const counts = lastPath === undefined ? undefined : noticesByPath.get(lastPath);
    for (const shown of elements.notices) shown.draw(counts?.[shown.level] ?? 0);
  }

  function drawCount(): void {
    elements.wordCount.textContent = announcement ?? (count ? formatWordCount(count, countWordsOnly) : (readout ?? ""));
  }

  // Disabled rather than hidden when there is nowhere to go, so the path
  // beside them never shifts.
  function setNavigation(can: Record<Direction, boolean>): void {
    for (const [button, direction, label] of [
      [elements.back, "back", "Back"],
      [elements.forward, "forward", "Forward"],
    ] as const) {
      button.disabled = !can[direction];
      const shortcut = deps.shortcutFor(direction);
      button.dataset.tooltip = shortcut ? `${label} (${shortcut})` : label;
    }
  }

  elements.back.addEventListener("click", () => deps.go("back"));
  elements.forward.addEventListener("click", () => deps.go("forward"));
  for (const shown of elements.notices) {
    shown.button.addEventListener("click", () => {
      if (lastPath !== undefined) deps.showNotices(lastPath, shown.level);
    });
  }
  const stopFailing = indicators.failing.subscribe(applyVisibility);

  return {
    element: elements.root,
    setNavigation,
    renderNotices(next) {
      noticesByPath = next;
      drawNotices();
    },
    setPath(filePath) {
      if (filePath === lastPath) return;
      lastPath = filePath;
      drawPath(filePath);
    },
    setWordCount(next) {
      if (next.words !== count?.words || next.chars !== count?.chars) endAnnouncement();
      count = next;
      drawCount();
    },
    clearWordCount() {
      count = undefined;
      readout = undefined;
      endAnnouncement();
      drawCount();
    },
    setReadout(text) {
      if (text !== readout) endAnnouncement();
      readout = text;
      drawCount();
    },
    // Fitted on its own, not left to a resize: once the path has given all
    // its room, a wider announcement resizes nothing being observed.
    announce(text) {
      announcement = text;
      const shown = ++announced;
      drawCount();
      flash(elements.wordCount);
      refit();
      return () => {
        if (shown !== announced || announcement === undefined) return;
        endAnnouncement();
        drawCount();
      };
    },
    setDeclared(next) {
      declared = next;
      applyVisibility();
    },
    holdIndicators(hold) {
      holding = hold;
      // Either side of the file's notices, moved only from another bar: a
      // move takes keyboard focus off the save warning.
      if (hold && indicators.save.parentElement !== elements.root) {
        elements.notices[0].button.before(indicators.activity);
        elements.notices[elements.notices.length - 1].button.after(indicators.save);
      }
      applyVisibility();
    },
    dispose() {
      stopFailing();
      stopNames();
      resizes.disconnect();
      cancelAnimationFrame(fitFrame);
    },
  };
}
