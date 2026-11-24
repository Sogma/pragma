// A setting's folder chooser: the folders inside one context, drawn as the
// space tree draws them, in its order, open where the sidebar's tree is and
// on the folder the setting holds, and searched by name. A click on a row
// picks it, one on its chevron opens or shuts it, and its Open button, where
// the caller can open a gallery, opens the folder's, as the tree's does.
import type { SpaceTreeNode } from "../../src/protocol/api.ts";
import { entryNameKey } from "../../src/protocol/entryName.ts";
import { dirnameOf, isWithin } from "../../src/protocol/rootedPath.ts";
import { type EntryIcon, entryIcon } from "../core/paths.ts";
import { findDirectoryChildren, pathNames } from "../core/spaceTree.ts";
import { setEntryIcon } from "../lib/dom.ts";
import { openFlyout } from "../lib/flyout.ts";
import { createPathLabel } from "../lib/pathLabel.ts";

export interface FolderChooserSpec {
  /** What opened it, where focus goes back. */
  anchor: HTMLElement;
  /** Its right edge is lined up with this one's, so it opens back over the
   * row it belongs to. */
  alignTo: HTMLElement;
  /** The folder whose folders are offered, never itself: "" for the space's
   * top folder. */
  within: string;
  /** The folders offered, as a tree, when they aren't the space's own inside
   * `within`: a library's, its paths rooted. */
  folders?: readonly SpaceTreeNode[];
  /** A row's glyph, when it isn't the one the space tree would draw. */
  icon?(node: SpaceTreeNode): EntryIcon;
  /** The folder the setting holds, marked as the tree marks the open file. */
  current?: string;
  /** The folder to start on when the setting holds none here. */
  reveal?: string;
  label: string;
  /** Whether the sidebar's tree draws this folder open. */
  isOpen(folder: string): boolean;
  onPick(folder: string): void;
  openFolder?(folder: string): void;
  onClose?(): void;
}

interface Row {
  node: SpaceTreeNode;
  depth: number;
}

// Kept between the chooser and the window's edges, and its anchor.
const MARGIN = 4;

const folderChildren = (node: SpaceTreeNode | undefined): SpaceTreeNode[] =>
  node?.children?.filter((child) => child.type === "directory") ?? [];

export function openFolderChooser(spec: FolderChooserSpec): void {
  // Read as children, not from the folder's node: the space's top folder has
  // no node in the tree.
  const top = (spec.folders ?? findDirectoryChildren(spec.within) ?? []).filter((child) => child.type === "directory");
  const inside = (path: string | undefined): path is string =>
    path !== undefined && path !== spec.within && isWithin(spec.within, path);

  const open = new Set<string>();
  const remember = (nodes: SpaceTreeNode[]): void => {
    for (const node of nodes) {
      if (spec.isOpen(node.path)) open.add(node.path);
      remember(folderChildren(node));
    }
  };
  remember(top);
  const openAbove = (path: string): void => {
    for (let at = dirnameOf(path); inside(at); at = dirnameOf(at)) open.add(at);
  };
  const start = [spec.current, spec.reveal].find(inside);
  if (start) openAbove(start);

  let query = "";
  let cursor = start;

  const rows = (): Row[] => {
    const found: Row[] = [];
    const key = entryNameKey(query);
    const keep = (node: SpaceTreeNode): boolean =>
      entryNameKey(node.name).includes(key) || folderChildren(node).some(keep);
    const walk = (nodes: SpaceTreeNode[], depth: number): void => {
      for (const node of nodes) {
        if (query && !keep(node)) continue;
        found.push({ node, depth });
        if (query || open.has(node.path)) walk(folderChildren(node), depth + 1);
      }
    };
    walk(top, 0);
    return found;
  };

  const search = document.createElement("input");
  search.type = "text";
  search.className = "context-menu-search";
  search.placeholder = spec.within ? `Search folders in ${spec.within.split("/").at(-1)}` : "Search folders";
  search.setAttribute("aria-label", search.placeholder);

  const tree = document.createElement("div");
  tree.className = "file-tree folder-chooser-tree";

  const element = document.createElement("div");
  element.className = "popover folder-chooser";
  element.setAttribute("role", "dialog");
  element.setAttribute("aria-label", spec.label);
  element.append(search, tree);

  function drawRow({ node, depth }: Row): HTMLLIElement {
    const leaf = folderChildren(node).length === 0;
    const item = document.createElement("li");
    item.className = "tree-row directory";
    item.classList.toggle("collapsed", !leaf && !query && !open.has(node.path));
    item.classList.toggle("is-leaf", leaf);
    item.style.setProperty("--depth", String(depth));
    item.setAttribute("role", "treeitem");
    if (!leaf) item.setAttribute("aria-expanded", String(Boolean(query) || open.has(node.path)));

    const label = document.createElement("span");
    label.className = "node-label";
    label.dataset.path = node.path;
    label.classList.toggle("active", node.path === spec.current);
    label.classList.toggle("cursor", node.path === cursor);
    const icon = document.createElement("span");
    icon.className = "node-icon";
    setEntryIcon(icon, spec.icon?.(node) ?? entryIcon(node));
    const name = document.createElement("span");
    name.className = "node-name";
    name.append(...withMatch(node.name, query));
    label.append(icon, name);
    if (spec.openFolder) {
      const openButton = document.createElement("button");
      openButton.type = "button";
      openButton.className = "icon-button node-open";
      openButton.tabIndex = -1;
      openButton.setAttribute("aria-label", "Open gallery");
      label.append(openButton);
    }
    item.append(label);

    if (depth > 0) {
      const guides = document.createElement("span");
      guides.className = "tree-guides";
      for (let at = dirnameOf(node.path), level = 0; level < depth; at = dirnameOf(at), level++) {
        const line = document.createElement("span");
        line.classList.toggle("active", spec.current?.startsWith(`${at}/`) === true);
        guides.prepend(line);
      }
      item.append(guides);
    }
    return item;
  }

  function showCursor(center: boolean): void {
    const row = tree.querySelector<HTMLElement>(".node-label.cursor");
    if (!row) return;
    const box = tree.getBoundingClientRect();
    const at = row.getBoundingClientRect();
    if (center) tree.scrollTop += at.top - box.top - (tree.clientHeight - at.height) / 2;
    else if (at.top < box.top) tree.scrollTop += at.top - box.top;
    else if (at.bottom > box.bottom) tree.scrollTop += at.bottom - box.bottom;
  }

  function draw(): void {
    const shown = rows();
    if (!shown.some((row) => row.node.path === cursor)) cursor = shown[0]?.node.path;
    if (shown.length === 0) {
      const empty = document.createElement("div");
      empty.className = "folder-chooser-empty";
      empty.textContent = query ? "No matching folders" : "No folders here";
      tree.replaceChildren(empty);
      return;
    }
    const list = document.createElement("ul");
    list.className = "tree-list";
    list.setAttribute("role", "tree");
    list.style.setProperty("--tree-row-height", "24px");
    list.append(...shown.map(drawRow));
    tree.replaceChildren(list);
    showCursor(false);
  }

  const flyout = openFlyout(spec.anchor, element, spec.onClose);
  const pick = (path: string): void => {
    flyout.close();
    spec.onPick(path);
  };

  tree.addEventListener("click", (event) => {
    const label = (event.target as Element).closest<HTMLElement>(".node-label");
    const path = label?.dataset.path;
    if (!label || path === undefined) return;
    if ((event.target as Element).closest(".node-open")) {
      flyout.close();
      spec.openFolder?.(path);
      return;
    }
    const icon = label.querySelector(".node-icon");
    const onChevron = icon !== null && event.clientX < icon.getBoundingClientRect().left;
    if (onChevron && !query && !label.parentElement?.classList.contains("is-leaf")) {
      if (open.has(path)) open.delete(path);
      else open.add(path);
      cursor = path;
      draw();
      search.focus();
      return;
    }
    pick(path);
  });

  // A search puts the keyboard's row on its first match, not a folder kept
  // above one; clearing it keeps that row in view.
  search.addEventListener("input", () => {
    query = search.value.trim();
    if (query) {
      const key = entryNameKey(query);
      cursor = rows().find((row) => entryNameKey(row.node.name).includes(key))?.node.path;
    } else if (cursor) openAbove(cursor);
    draw();
  });

  search.addEventListener("keydown", (event) => {
    const shown = rows();
    const at = shown.findIndex((row) => row.node.path === cursor);
    const row = shown[at];
    const opens = row !== undefined && !query && folderChildren(row.node).length > 0;
    const go = (index: number): void => {
      cursor = shown[Math.max(0, Math.min(shown.length - 1, index))]?.node.path;
      draw();
    };
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      go(at + (event.key === "ArrowDown" ? 1 : -1));
    } else if (event.key === "ArrowRight" && opens && row) {
      event.preventDefault();
      if (open.has(row.node.path)) go(at + 1);
      else {
        open.add(row.node.path);
        draw();
      }
    } else if (event.key === "ArrowLeft" && row && !query) {
      event.preventDefault();
      if (opens && open.has(row.node.path)) {
        open.delete(row.node.path);
        draw();
      } else if (inside(dirnameOf(row.node.path))) {
        cursor = dirnameOf(row.node.path);
        draw();
      }
    } else if (event.key === "Enter" && cursor !== undefined) {
      event.preventDefault();
      pick(cursor);
    }
  });

  draw();
  place();
  search.focus();
  showCursor(true);

  // Placed once its rows are in: below the anchor where they fit, else on
  // the roomier side. Below, the list grows to the window's foot and no
  // further; above, it keeps the height it opened at, so a folder opened or
  // a search typed never moves the box off its anchor or past the window.
  function place(): void {
    const anchor = spec.anchor.getBoundingClientRect();
    const chrome = element.offsetHeight - tree.offsetHeight;
    const below = window.innerHeight - anchor.bottom - 2 * MARGIN - chrome;
    const above = anchor.top - 2 * MARGIN - chrome;
    const up = tree.offsetHeight > below && above > below;
    if (up) tree.style.height = `${Math.max(0, Math.min(tree.offsetHeight, above))}px`;
    else {
      const longest = Number.parseFloat(getComputedStyle(tree).maxHeight) || Number.POSITIVE_INFINITY;
      tree.style.maxHeight = `${Math.max(0, Math.min(longest, below))}px`;
    }
    element.style.top = `${up ? anchor.top - MARGIN - element.offsetHeight : anchor.bottom + MARGIN}px`;
    const box = spec.alignTo.getBoundingClientRect();
    const left = Math.min(box.right - element.offsetWidth, window.innerWidth - MARGIN - element.offsetWidth);
    element.style.left = `${Math.max(MARGIN, left)}px`;
  }
}

export interface FolderFieldSpec {
  /** The folder shown first, rooted: "" is the space's top folder. */
  value: string;
  /** The folders offered: each root a row of its own, its folders under it,
   * read as the chooser opens. The first starts open. */
  roots(): Promise<SpaceTreeNode[]>;
  /** A root's glyph; its folders draw as the tree draws them. */
  rootIcon(root: SpaceTreeNode): EntryIcon;
  label: string;
}

export interface FolderField {
  readonly element: HTMLElement;
  value(): string;
}

/** A form's folder: an input's box holding the folder picked, as its path,
 * that opens the chooser over the field. */
export function createFolderField(spec: FolderFieldSpec): FolderField {
  let value = spec.value;
  const entry = document.createElement("button");
  entry.type = "button";
  entry.className = "form-input dialog-input folder-field";
  entry.setAttribute("aria-haspopup", "dialog");
  entry.setAttribute("aria-expanded", "false");
  const chevrons = document.createElement("span");
  chevrons.className = "folder-field-chevrons";
  chevrons.setAttribute("aria-hidden", "true");
  const draw = () =>
    entry.replaceChildren(createPathLabel(value, pathNames, { type: "directory", standalone: true }), chevrons);

  entry.addEventListener("click", () => {
    if (entry.getAttribute("aria-expanded") === "true") return;
    entry.setAttribute("aria-expanded", "true");
    const reset = () => entry.setAttribute("aria-expanded", "false");
    void spec.roots().then((roots) => {
      const tops = new Set(roots.map((root) => root.path));
      openFolderChooser({
        anchor: entry,
        alignTo: entry,
        within: "",
        folders: roots,
        icon: (node) => (tops.has(node.path) ? spec.rootIcon(node) : entryIcon(node)),
        current: value,
        label: spec.label,
        isOpen: (folder) => folder === roots[0]?.path,
        // A click on a row takes focus off the chooser's search box, so the
        // chooser hands it back to nothing: the field takes it, in its dialog.
        onPick: (folder) => {
          value = folder;
          draw();
          entry.focus();
        },
        onClose: reset,
      });
    }, reset);
  });

  draw();
  return { element: entry, value: () => value };
}

// A name with the part a search matched marked, as Search marks a hit. The
// mark is found in lower case, whose offsets are the name's own.
function withMatch(name: string, query: string): (string | HTMLElement)[] {
  const at = query ? name.toLowerCase().indexOf(query.toLowerCase()) : -1;
  if (at < 0) return [name];
  const mark = document.createElement("span");
  mark.className = "match-mark";
  mark.textContent = name.slice(at, at + query.length);
  return [name.slice(0, at), mark, name.slice(at + query.length)];
}
