// A path named in running text: its entry's icon, then the path from where it
// is to its name, and the whole path, scheme included, in its tooltip. The
// folders between the top one and the one it sits in fold into "…" as its
// room narrows, or always in a compact label.
//
// A library's `lib:<id>` is drawn as the Libraries icon and the library's
// display name, as the status bar draws it; a space path carries no scheme,
// so its top folder says where it is.
import {
  basenameOf,
  dirnameOf,
  isLibraryRoot,
  isWithin,
  parseRootedPath,
  type RootedPath,
} from "../../src/protocol/rootedPath.ts";
import { hasKnownKind, splitDocumentName } from "../../src/protocol/types.ts";
import type { EntryIcon } from "../core/paths.ts";
import { setEntryIcon } from "./dom.ts";

/** What a label asks of the layers above this one: a library's display name
 * by its id, and the icon an entry draws, as the tree draws it. */
export interface PathNames {
  libraryName(id: string): string | undefined;
  icon(path: string, type: "file" | "directory"): EntryIcon;
}

export interface PathLabelOptions {
  /** The punctuation that follows the path in its sentence, kept on its
   * line: a break before it would leave a "." alone on the next. */
  after?: string;
  /** Whether the path names a folder, when the caller knows; otherwise a
   * name with no extension is taken for one. */
  type?: "file" | "directory";
  /** Always the top folder, "…", the folder the path sits in and its name,
   * for a path inside a sentence: a label there has a whole line to fill,
   * and every folder would crowd the sentence. */
  compact?: boolean;
  /** The space folder the path is shown from, the folders above it left
   * out, as a context's setting reads from its context. The path naming
   * that folder itself shows its name. */
  from?: string;
  /** A path standing alone, as a control's value or a row's title: in the
   * type around it, never the box that sets a path apart in running text. */
  standalone?: boolean;
}

/** Settings' Show extensions, as a class on the root. A label names a file
 * of a kind Pragma knows without its extension unless it's on, as the tree
 * does, and keeps the extension in its tooltip either way. */
export function applyShowExtensions(on: boolean): void {
  document.documentElement.classList.toggle("show-extensions", on);
  // A label already at the edge of its room keeps its size, so its observer
  // never hears that the names in it grew.
  for (const label of document.querySelectorAll(".path-label")) refits.get(label)?.();
}

function part(className: string, text = ""): HTMLSpanElement {
  const element = document.createElement("span");
  element.className = className;
  element.textContent = text;
  return element;
}

// A file's name, its extension a piece of its own that path-label.css shows
// only under Show extensions.
function named(name: string, type: "file" | "directory"): HTMLElement {
  if (type === "directory" || !hasKnownKind(name)) return part("path-label-name", name);
  const { stem, extension } = splitDocumentName(name);
  const piece = part("path-label-name", stem);
  piece.append(part("path-label-ext", extension));
  return piece;
}

// A piece and the "/" after it, so a folder that folds takes its separator
// along.
function step(className: string, text: string): HTMLElement {
  const piece = part("path-label-step");
  piece.append(part(className, text), part("path-label-separator", "/"));
  return piece;
}

// Where the path is, the folders between it and the one the path sits in,
// then that folder and the name.
function steps(
  path: string,
  libraryName: (id: string) => string | undefined,
  type: "file" | "directory",
  from: string | undefined,
): { library: boolean; where?: HTMLElement; between: HTMLElement[]; last: HTMLElement[] } {
  let rooted: RootedPath;
  try {
    rooted = parseRootedPath(path);
  } catch {
    // An unparseable path still names something to someone: shown as written.
    return { library: false, between: [], last: [part("path-label-name", path)] };
  }
  const library = isLibraryRoot(rooted.root) ? rooted.root.library : undefined;
  let shown = rooted.path;
  if (from && library === undefined && isWithin(from, rooted.path)) {
    shown = rooted.path === from ? basenameOf(from) : rooted.path.slice(from.length + 1);
  }
  const folders = dirnameOf(shown).split("/").filter(Boolean);
  let where: HTMLElement | undefined;
  if (library !== undefined) where = part("path-label-root", libraryName(library) ?? library);
  else if (folders.length > 1) where = part("path-label-folder", folders.shift());
  const folder = folders.pop();
  const last = folder ? [step("path-label-folder", folder)] : [];
  // A root names itself: a library by its name, the space as "Space".
  if (shown) last.push(named(basenameOf(shown), type));
  else if (!where) last.push(part("path-label-name", "Space"));
  const between = folders.map((name) => step("path-label-folder", name));
  return { library: library !== undefined, where, between, last };
}

const separated = (pieces: HTMLElement[]): HTMLElement[] =>
  pieces.flatMap((piece, index) => (index > 0 ? [part("path-label-separator", "/"), piece] : [piece]));

/** `path` as a label. `names` names a library by its id, the id standing in
 * for a name not read yet, being what the path already says; a bare name
 * lookup draws no entry icon.
 *
 * Unless compact, a label shows every folder its room holds, its room being
 * the nearest box around it that isn't inline. As that narrows, the folders
 * between the top one and the one the path sits in fold into "…" from the
 * top down, and they come back as it widens. */
export function createPathLabel(
  path: string,
  names: PathNames | PathNames["libraryName"],
  options: PathLabelOptions = {},
): HTMLElement {
  const { after = "", compact = false, from, standalone = false } = options;
  const type = options.type ?? (splitDocumentName(basenameOf(path)).extension ? "file" : "directory");
  const { libraryName, icon } = typeof names === "function" ? { libraryName: names, icon: undefined } : names;
  const label = part(standalone ? "path-label path-label-standalone" : "path-label");
  label.dataset.tooltip = path;
  // What a right-click copies (pathChipMenu.ts), however much of the
  // path the label shows.
  label.dataset.path = path;
  label.dataset.pathType = type;
  // The path in its own box, the punctuation after it outside.
  const box = part("path-label-box");
  label.append(box);
  const { library, where, between, last } = steps(path, libraryName, type, from);
  // A library's icon leads the label, so the entry's icon sits beside the
  // path it marks.
  if (library) box.append(part("path-label-root-icon"));
  // A root names itself, its own icon included. A plain file, which the
  // tree leaves bare, still shows one here, before its path.
  if (icon && !isRootPath(path)) {
    const entry = icon(path, type);
    const glyph = part("path-label-icon");
    setEntryIcon(glyph, entry.glyph ? entry : { glyph: "file" });
    box.append(glyph);
  }
  const pieces = where ? [where] : [];
  if (between.length || last.length) {
    // What follows where the path is, in one piece that gives way from its
    // start (path-label.css), so the end of the name stays.
    const run = part("path-label-run");
    const tail = part("path-label-tail");
    tail.append(run);
    pieces.push(tail);
    const more = step("path-label-more", "…");
    if (compact) run.append(...(between.length ? [more] : []), ...last);
    else {
      run.append(...between, ...last);
      if (between.length) fitting(label, () => fold(tail, run, between, more));
    }
  }
  box.append(...separated(pieces));
  if (after) label.append(part("path-label-after", after));
  return label;
}

function isRootPath(path: string): boolean {
  try {
    return parseRootedPath(path).path === "";
  } catch {
    return false;
  }
}

// Every folder shown, then those between folded from the top down while what
// follows the top one overflows its room. A folded folder leaves the DOM and
// the "…" is text, so a copy of the label holds what it shows, never a path
// with folders silently missing.
function fold(tail: HTMLElement, run: HTMLElement, between: HTMLElement[], more: HTMLElement): void {
  more.remove();
  run.prepend(...between);
  for (const folder of between) {
    if (run.getBoundingClientRect().width <= tail.getBoundingClientRect().width) return;
    folder.remove();
    if (!more.isConnected) run.prepend(more);
  }
}

// Each fitting label's fold, by its label; the rooms already watched; the
// labels to fit on the next frame.
const refits = new WeakMap<Element, () => void>();
const rooms = new WeakSet<Element>();
const due = new Set<Element>();
let observer: ResizeObserver | undefined;
let frame = 0;

// Without layout (jsdom) a label shows every folder.
function fitting(label: HTMLElement, refit: () => void): void {
  if (typeof ResizeObserver !== "function") return;
  refits.set(label, refit);
  observer ??= new ResizeObserver(resized);
  observer.observe(label);
}

// A folded label is only as wide as what it shows, so its own size never says
// room came back; the box it sits in does. That box is watched from the next
// frame, as the fit is: observing it, or folding, inside the observer's
// callback is a loop the browser reports as an error.
function resized(entries: ResizeObserverEntry[]): void {
  for (const { target } of entries) {
    if (refits.has(target)) due.add(target);
    else for (const label of target.querySelectorAll(".path-label")) if (refits.has(label)) due.add(label);
  }
  cancelAnimationFrame(frame);
  frame = requestAnimationFrame(() => {
    for (const label of due) {
      if (!label.isConnected) continue;
      const room = roomOf(label);
      if (room && !rooms.has(room)) {
        rooms.add(room);
        observer?.observe(room);
      }
      refits.get(label)?.();
    }
    due.clear();
  });
}

// An inline box is only as wide as what it holds, so it can't be the room.
function roomOf(label: Element): Element | undefined {
  for (let at = label.parentElement; at; at = at.parentElement) {
    const { display } = getComputedStyle(at);
    if (!display.startsWith("inline") && display !== "contents") return at;
  }
  return undefined;
}
