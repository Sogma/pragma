// The controls a Table's cells are drawn with, in its tab and in a preview of
// it, so a picture or a path shows the same in both: a media cell by its
// column's folder, strip and names, a path cell read from the Table's folder.
import { dirnameOf } from "../src/protocol/rootedPath.ts";
import { openColorPicker } from "./lib/colorPicker.ts";
import type { CellControls } from "./lib/fieldValue.ts";
import type { DialogService } from "./services/dialog.ts";
import { createMediaField, mediaImportFor } from "./services/mediaField.ts";
import type { ContextMenuService } from "./services/menus.ts";
import { createPathField } from "./services/pathField.ts";

export interface TableCellsDeps {
  /** The Table's own rooted path, which its values are read from. */
  tablePath(): string;
  /** A click on a media cell's picture, with the cell's field. */
  openMedia(rootedPath: string, field: HTMLElement): void;
  /** What a path cell names, by its rooted path: a path ending in `/` as
   * its folder. */
  openPath(rootedPath: string): void;
  /** Where a picture that has gone says why, and a file dropped on a cell
   * shows its copy. */
  dialog: DialogService;
  /** Offers what a path cell can name. */
  contextMenu: ContextMenuService;
}

export function tableCellControls(deps: TableCellsDeps): CellControls {
  return {
    media: (column, value, readOnly, onChange) =>
      createMediaField({
        docDir: dirnameOf(deps.tablePath()),
        value,
        folder: column.mediaFolder,
        readOnly,
        onChange,
        strip: column.id,
        showName: column.showName,
        openItem: deps.openMedia,
        dialog: deps.dialog,
        notify: (message) => window.alert(message),
        importFiles: mediaImportFor(deps.dialog),
      }),
    path: (value, readOnly, onChange) =>
      createPathField({
        docPath: deps.tablePath(),
        value,
        readOnly,
        onChange,
        openPath: deps.openPath,
        notify: (message) => window.alert(message),
        contextMenu: deps.contextMenu,
      }),
    pickColor: (anchor, value, onPick) => openColorPicker({ anchor, value, onPick }),
  };
}
