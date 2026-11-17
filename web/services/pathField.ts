// A `path` field's control: the file or folder a Table or Class cell
// names, opened by a click as a link is, and set by a drop from a tree or a
// pick from what a link could name. One module for both panes, as the media
// field is.
//
// The value is a path as a note writes one: from the document's folder by
// the scope rule, a folder with its `/`. So a move rewrites it as it does a
// link.
import { readWrittenPath } from "../../src/protocol/relativeReference.ts";
import {
  basenameOf,
  dirnameOf,
  formatRootedPath,
  isLibraryPath,
  isLibraryRoot,
  isWithin,
  parseRootedPath,
} from "../../src/protocol/rootedPath.ts";
import { hasKnownKind } from "../../src/protocol/types.ts";
import { type LinkOffer, linkOffers } from "../core/linkOffers.ts";
import { DRAGGED_ENTRY_TYPE, readDraggedPath, stripExtension } from "../core/paths.ts";
import { entryIconAt, libraryFiles, linkScope, resolvePathFrom, writePathFrom } from "../core/spaceTree.ts";
import { onLinkClick, setEntryIcon } from "../lib/dom.ts";
import { type InheritedSetting, settingFolderLabel } from "./contextSettings.ts";
import { openFolderChooser } from "./folderChooser.ts";
import type { ContextMenuService, MenuItem } from "./menus.ts";

export interface PathFieldSpec {
  /** The document the value is written in, rooted. */
  docPath: string;
  value: string;
  readOnly: boolean;
  onChange(value: string): void;
  /** Opens a path as a link does: one ending in `/` as its folder. */
  openPath(rootedPath: string): void;
  notify(message: string): void;
  contextMenu: ContextMenuService;
  /** A setting's folder, where the whole field is a dropdown over the folders
   * one context holds; absent, the name opens what it names, as a link does,
   * and its chevrons choose from what a link could name. */
  folders?: FolderSettingField;
}

export interface FolderSettingField {
  /** The context's folder, whose folders are offered. */
  within: string;
  /** Whether the sidebar's tree draws a folder open. */
  isOpen(folder: string): boolean;
  openFolder(folder: string): void;
  /** What the field shows while it holds nothing: what an enclosing context
   * gives the setting. */
  inherited?: InheritedSetting;
}

const MAX_OFFERS = 50;

/** What a stored value names, read as a link in the document is: the entry,
 * rooted, and whether it is a folder; undefined for an empty or unreadable
 * value. `present` is false only for a space entry the listing lacks: a
 * library's listing may not have landed, so its entries are taken on trust. */
export function readPathValue(
  docPath: string,
  value: string,
): { path: string; folder: boolean; present: boolean } | undefined {
  const written = value.trim();
  const read = written ? readWrittenPath(dirnameOf(docPath), written, "markdown") : undefined;
  if (!read) return undefined;
  const found = resolvePathFrom(docPath, written, "markdown");
  if (found) return { path: found.path, folder: found.type === "directory", present: true };
  return { path: formatRootedPath(read.target), folder: read.folder, present: isLibraryRoot(read.target.root) };
}

// The value an entry picked or dropped is stored as, written from the
// document by the writing rule; undefined when the document can't name it.
function valueFor(docPath: string, offer: LinkOffer): string | undefined {
  return writePathFrom(dirnameOf(docPath), parseRootedPath(offer.path), { folder: offer.folder });
}

// A file by its name as Quick Open shows it, a known kind's extension left
// to its icon.
function entryName(path: string, folder: boolean): string {
  const name = basenameOf(path);
  return folder || !hasKnownKind(name) ? name : stripExtension(name);
}

export function createPathField(spec: PathFieldSpec): HTMLElement {
  const root = document.createElement("div");
  root.className = "path-field";

  const folders = spec.folders;
  root.classList.toggle("is-dropdown", folders !== undefined);
  const entry = document.createElement("button");
  entry.type = "button";
  entry.className = "path-field-entry";
  const icon = document.createElement("span");
  icon.className = "path-field-icon";
  const name = document.createElement("span");
  name.className = "path-field-name";
  // A setting's folder, drawn by the builder the Properties tab's card draws
  // it with, so the two never say different things about one setting.
  let setting: HTMLElement = document.createElement("span");
  if (folders) {
    const chevrons = document.createElement("span");
    chevrons.className = "path-field-chevrons";
    chevrons.setAttribute("aria-hidden", "true");
    entry.setAttribute("aria-haspopup", "dialog");
    entry.setAttribute("aria-expanded", "false");
    entry.append(setting, chevrons);
  } else entry.append(icon, name);
  root.append(entry);

  let value = spec.value;
  let target: ReturnType<typeof readPathValue>;

  function render(): void {
    target = readPathValue(spec.docPath, value);
    const empty = value.trim() === "";
    root.classList.toggle("is-empty", empty);
    if (folders) {
      const next = settingFolderLabel(folders.within, value, folders.inherited);
      setting.replaceWith(next);
      setting = next;
      entry.disabled = spec.readOnly;
      return;
    }
    root.classList.toggle("is-missing", target !== undefined && !target.present);
    root.classList.toggle("is-unreadable", target === undefined && !empty);
    entry.disabled = target === undefined ? spec.readOnly || !empty : !target.present;
    if (target === undefined) {
      setEntryIcon(icon, {});
      name.textContent = empty ? "None" : "Unreadable path";
      delete entry.dataset.tooltip;
      return;
    }
    setEntryIcon(icon, entryIconAt(target.path, target.folder ? "directory" : "file"));
    const shown = entryName(target.path, target.folder);
    name.textContent = target.present ? shown : `Missing: ${shown}`;
    entry.dataset.tooltip = target.path;
  }

  function set(next: string): void {
    value = next;
    spec.onChange(next);
    render();
  }

  // The entries a link in the document could name, the current one checked.
  async function choose(anchor: HTMLElement): Promise<void> {
    if (spec.contextMenu.isOpen(anchor)) {
      spec.contextMenu.close();
      return;
    }
    const scope = linkScope(spec.docPath);
    if (!scope) return;
    // A library document names only its own library's entries.
    const library = isLibraryPath(spec.docPath) ? [] : await libraryFiles();
    const docDir = dirnameOf(spec.docPath);
    const item = (offer: LinkOffer): MenuItem => {
      const folder = dirnameOf(offer.path);
      return {
        label: entryName(offer.path, offer.folder),
        detail: folder === docDir ? undefined : folder || "/",
        icon: true,
        entryIcon: entryIconAt(offer.path, offer.folder ? "directory" : "file"),
        checked: () => offer.path === target?.path,
        run: () => {
          const next = valueFor(spec.docPath, offer);
          if (next !== undefined) set(next);
        },
      };
    };
    const offered = (query: string) => linkOffers(scope, library, query).slice(0, MAX_OFFERS).map(item);
    spec.contextMenu.open({
      items: offered(""),
      anchor,
      align: "start",
      ariaLabel: "Choose a file or folder",
      empty: "Nothing to choose from",
      search: {
        placeholder: "Search files and folders",
        filter: (query) => {
          const found = offered(query);
          return found.length > 0 ? found : [{ label: "No matching files or folders" }];
        },
      },
    });
  }

  // A setting's folders: the context's own tree, opened from the whole field.
  function chooseFolder(): void {
    if (!folders || spec.readOnly) return;
    entry.setAttribute("aria-expanded", "true");
    openFolderChooser({
      anchor: entry,
      alignTo: root,
      within: folders.within,
      current: target?.present && target.folder ? target.path : undefined,
      reveal: folders.inherited?.path,
      label: "Choose a folder",
      isOpen: folders.isOpen,
      openFolder: folders.openFolder,
      onPick: (folder) => {
        const next = valueFor(spec.docPath, { path: folder, folder: true });
        if (next !== undefined) set(next);
      },
      onClose: () => entry.setAttribute("aria-expanded", "false"),
    });
  }

  if (folders) entry.addEventListener("click", chooseFolder);
  else
    onLinkClick(entry, () => {
      if (target?.present) spec.openPath(target.folder ? `${target.path}/` : target.path);
      else if (!spec.readOnly && value.trim() === "") void choose(entry);
    });

  if (!spec.readOnly) {
    const pick = document.createElement("button");
    pick.type = "button";
    pick.className = "icon-button path-field-choose";
    pick.setAttribute("aria-label", "Choose a file or folder");
    pick.addEventListener("click", () => void choose(pick));

    const clear = document.createElement("button");
    clear.type = "button";
    clear.className = "icon-button path-field-clear";
    clear.setAttribute("aria-label", "Clear");
    clear.addEventListener("click", () => set(""));
    if (folders) clear.setAttribute("aria-label", "Clear the folder");
    root.append(...(folders ? [clear] : [pick, clear]));

    // A tree row carries its rooted path, and whether it is a folder; a
    // file from the desktop is in no root a path can name.
    root.addEventListener("dragover", (event) => {
      event.preventDefault();
      root.classList.add("drag-over");
    });
    root.addEventListener("dragleave", () => root.classList.remove("drag-over"));
    root.addEventListener("drop", (event) => {
      event.preventDefault();
      event.stopPropagation();
      root.classList.remove("drag-over");
      const dragged = readDraggedPath(event);
      if (!dragged) {
        if (event.dataTransfer?.files?.length) spec.notify("Drag a file or folder from a tree.");
        return;
      }
      const folder = event.dataTransfer?.getData(DRAGGED_ENTRY_TYPE) === "directory";
      if (folders && (!folder || isLibraryRoot(dragged.root) || !isWithin(folders.within, dragged.path))) {
        spec.notify(`Drop a folder from inside ${folders.within}.`);
        return;
      }
      const next = valueFor(spec.docPath, { path: formatRootedPath(dragged), folder });
      if (next === undefined) {
        spec.notify("A document in a library can only name entries in that same library.");
        return;
      }
      set(next);
    });
  }

  render();
  return root;
}
