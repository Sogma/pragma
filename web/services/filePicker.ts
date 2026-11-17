// The space's files as a searchable menu, for a pick such as a Class's
// links. Callers say which files are on offer.
import { basenameOf, dirnameOf } from "../../src/protocol/rootedPath.ts";
import { stripExtension } from "../core/paths.ts";
import { entryIconAt } from "../core/spaceTree.ts";
import type { ContextMenuService, MenuItem } from "./menus.ts";

export interface FilePick {
  // Every file on offer, by path.
  files: readonly string[];
  anchor: HTMLElement;
  ariaLabel: string;
  // Whether a file is already chosen, for its check.
  chosen(path: string): boolean;
  pick(path: string): void;
}

export function pickFile(contextMenu: ContextMenuService, pick: FilePick): void {
  const item = (path: string): MenuItem => ({
    label: stripExtension(basenameOf(path)),
    detail: dirnameOf(path) || undefined,
    icon: true,
    entryIcon: entryIconAt(path, "file"),
    checked: () => pick.chosen(path),
    run: () => pick.pick(path),
  });
  contextMenu.open({
    items: pick.files.map(item),
    anchor: pick.anchor,
    align: "end",
    ariaLabel: pick.ariaLabel,
    empty: "No files in this space",
    search: {
      placeholder: "Search files…",
      filter: (query) => {
        const needle = query.trim().toLowerCase();
        const found = pick.files.filter((path) => path.toLowerCase().includes(needle)).map(item);
        return found.length > 0 ? found : [{ label: "No matching files" }];
      },
    },
  });
}
