// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TableFileResponse } from "../../../../web/core/apiClient.ts";
import { createDialogService } from "../../../../web/services/dialog.ts";
import { createTableView } from "../../../../web/view/panes/tablePane.ts";
import { testContextMenu } from "../../support/testContextMenu.ts";

// Each test opens its own dialog through the service; none of them closes the
// previous test's, so the body starts clean.
beforeEach(() => {
  document.body.replaceChildren();
});

function sampleFile(overrides: Partial<TableFileResponse> = {}): TableFileResponse {
  return {
    kind: "table",
    path: "inventory.table.html",
    revision: "rev-1",
    version: "1",
    name: "Inventory",
    columns: [
      { id: "name", label: "Name", type: "text" },
      { id: "done", label: "Done", type: "checkbox" },
    ],
    rows: [{ values: { name: "Widget", done: "false" } }],
    ...overrides,
  };
}

// Design on by default: most of these tests exercise the column tools,
// which is what Design exists to show. A test of values or rows turns it
// off, as the mode tests below do.
function setup(readingView = false, designing = true) {
  const editorTable = document.createElement("div");
  const scheduleSave = vi.fn();
  const onRendered = vi.fn();
  const tableView = createTableView({
    editorTable,
    dialog: createDialogService(),
    contextMenu: testContextMenu(),
    isReadingView: () => readingView,
    scheduleSave,
    onRendered,
    openPath: vi.fn(),
    openMedia: vi.fn(),
    dialogHost: document.body,
  });
  tableView.setDesigning(designing);
  return { tableView, editorTable, scheduleSave, onRendered };
}

describe("render / clear / isActive / getFileName", () => {
  it("is inactive with no file name before any render", () => {
    const { tableView } = setup();
    expect(tableView.isActive()).toBe(false);
    expect(tableView.getFileName()).toBeUndefined();
  });

  it("becomes active and exposes the file name after render()", () => {
    const { tableView, onRendered } = setup();
    tableView.render(sampleFile());
    expect(tableView.isActive()).toBe(true);
    expect(tableView.getFileName()).toBe("Inventory");
    expect(onRendered).toHaveBeenCalledTimes(1);
  });

  it("clear() resets to inactive", () => {
    const { tableView } = setup();
    tableView.render(sampleFile());
    tableView.clear();
    expect(tableView.isActive()).toBe(false);
    expect(tableView.getFileName()).toBeUndefined();
  });

  it("draws the table grid into editorTable", () => {
    const { tableView, editorTable } = setup();
    tableView.render(sampleFile());
    expect(editorTable.querySelectorAll("tbody tr")).toHaveLength(1);
    expect(editorTable.querySelectorAll("thead th")).toHaveLength(3); // 2 columns + add-column cell
  });

  it("shows an empty-state message when the table has no columns", () => {
    const { tableView, editorTable } = setup();
    tableView.render(sampleFile({ columns: [], rows: [] }));
    expect(editorTable.querySelector(".data-table-empty")?.textContent).toBe("This Table has no columns defined yet.");
    expect(editorTable.querySelector("table")).toBeNull();
  });
});

describe("editing a cell persists", () => {
  it("editing a text cell schedules a save with re-serialized content", () => {
    const { tableView, editorTable, scheduleSave } = setup(false, false);
    tableView.render(sampleFile());
    const textInput = editorTable.querySelector(".data-table-cell-text") as HTMLInputElement;
    textInput.value = "Gadget";
    textInput.dispatchEvent(new Event("input", { bubbles: true }));
    expect(scheduleSave).toHaveBeenCalledTimes(1);
    const [path, content] = scheduleSave.mock.calls[0];
    expect(path).toBe("inventory.table.html");
    expect(content).toContain("Gadget");
  });

  it("toggling a checkbox cell persists the new boolean-as-string value", () => {
    const { tableView, editorTable, scheduleSave } = setup(false, false);
    tableView.render(sampleFile());
    const checkbox = editorTable.querySelector(".data-table-cell-checkbox") as HTMLInputElement;
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event("change", { bubbles: true }));
    expect(scheduleSave).toHaveBeenCalledTimes(1);
  });
});

describe("row add/delete", () => {
  it("+ Add appends a row with blank values and persists", () => {
    const { tableView, editorTable, scheduleSave } = setup(false, false);
    tableView.render(sampleFile());
    const addButton = editorTable.querySelector(".data-table-add-row") as HTMLButtonElement;
    addButton.click();
    expect(editorTable.querySelectorAll("tbody tr")).toHaveLength(2);
    expect(scheduleSave).toHaveBeenCalledTimes(1);
  });

  it("the delete button, an entry's in either layout, asks first, naming it, and removes it once confirmed", async () => {
    const { tableView, editorTable, scheduleSave } = setup(false, false);
    tableView.render(sampleFile());
    const button = editorTable.querySelector(".data-table-row-delete") as HTMLButtonElement;
    expect(button.getAttribute("aria-label")).toBe("Delete entry");
    button.click();
    const overlay = document.querySelector(".dialog-panel") as HTMLElement;
    expect(overlay.querySelector(".dialog-title")?.textContent).toBe('Delete "Widget" entry?');
    expect(editorTable.querySelectorAll("tbody tr")).toHaveLength(1);
    expect(scheduleSave).not.toHaveBeenCalled();

    (overlay.querySelector(".dialog-primary") as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(document.querySelector(".dialog-panel")).toBeNull();
    expect(editorTable.querySelectorAll("tbody tr")).toHaveLength(0);
    expect(scheduleSave).toHaveBeenCalledTimes(1);
  });

  it("Cancel keeps the row", async () => {
    const { tableView, editorTable, scheduleSave } = setup(false, false);
    tableView.render(sampleFile());
    (editorTable.querySelector(".data-table-row-delete") as HTMLButtonElement).click();
    const [cancel] = document.querySelectorAll<HTMLButtonElement>(".dialog-panel .dialog-actions button");
    cancel.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(document.querySelector(".dialog-panel")).toBeNull();
    expect(editorTable.querySelectorAll("tbody tr")).toHaveLength(1);
    expect(scheduleSave).not.toHaveBeenCalled();
  });

  it("names a row by its title's text, cut short, and one with none as this row", () => {
    const { tableView, editorTable } = setup(false, false);
    tableView.render(
      sampleFile({
        rows: [
          { values: { name: "A take that runs on well past the length a title shows", done: "false" } },
          { values: { name: "  ", done: "true" } },
        ],
      }),
    );
    const titleFor = (index: number) => {
      editorTable.querySelectorAll<HTMLButtonElement>(".data-table-row-delete")[index].click();
      const title = document.querySelector(".dialog-panel .dialog-title")?.textContent;
      document.querySelectorAll<HTMLButtonElement>(".dialog-panel .dialog-actions button")[0].click();
      return title;
    };
    expect(titleFor(0)).toBe('Delete "A take that runs on well past the length…" entry?');
    expect(titleFor(1)).toBe("Delete this entry?");
  });
});

describe("column add", () => {
  it("the header's + button opens a popover with the type list alphabetical and Checkbox/checkbox as the default", () => {
    const { tableView, editorTable } = setup();
    tableView.render(sampleFile());
    const addColumnButton = editorTable.querySelector(".data-table-add-column") as HTMLButtonElement;
    addColumnButton.click();
    const popover = document.querySelector(".popover") as HTMLElement;
    expect(popover).not.toBeNull();
    const typeSelect = popover.querySelector("select") as HTMLSelectElement;
    expect([...typeSelect.options].map((option) => option.textContent)).toEqual([
      "Checkbox",
      "Color",
      "Integer",
      "Media",
      "Path",
      "Select",
      "Text",
      "Timestamp",
    ]);
    expect(typeSelect.value).toBe("checkbox");
    expect((popover.querySelector(".popover-field") as HTMLElement).hidden).toBe(true); // options field only shown for "select"
    (popover.querySelector(".action-button") as HTMLButtonElement).click(); // close it, blank name is a no-op
  });

  it("submitting adds a column, slugifies its id, backfills existing rows, and persists", () => {
    const { tableView, editorTable, scheduleSave } = setup();
    tableView.render(sampleFile());
    (editorTable.querySelector(".data-table-add-column") as HTMLButtonElement).click();
    const popover = document.querySelector(".popover") as HTMLElement;
    const nameInput = popover.querySelector("input") as HTMLInputElement;
    nameInput.value = "Unit Price";
    nameInput.dispatchEvent(new Event("input", { bubbles: true }));
    (popover.querySelector(".action-button") as HTMLButtonElement).click();

    expect(document.querySelector(".popover")).toBeNull(); // closed itself
    expect(editorTable.querySelectorAll("thead th")).toHaveLength(4); // 3 columns + add-column cell
    expect(editorTable.querySelectorAll("thead .data-table-column-label")[2].textContent).toBe("Unit Price");
    expect(editorTable.querySelectorAll("tbody tr")[0].querySelectorAll("td")).toHaveLength(3);
    const [, content] = scheduleSave.mock.calls[scheduleSave.mock.calls.length - 1];
    expect(content).toContain('data-field="unit-price"');
  });

  it("a select column needs at least one option before it can be added", () => {
    const { tableView, editorTable } = setup();
    tableView.render(sampleFile());
    (editorTable.querySelector(".data-table-add-column") as HTMLButtonElement).click();
    const popover = document.querySelector(".popover") as HTMLElement;
    const nameInput = popover.querySelector("input") as HTMLInputElement;
    const typeSelect = popover.querySelector("select") as HTMLSelectElement;
    const submit = popover.querySelector(".action-button") as HTMLButtonElement;
    nameInput.value = "Status";
    nameInput.dispatchEvent(new Event("input", { bubbles: true }));
    typeSelect.value = "select";
    typeSelect.dispatchEvent(new Event("change", { bubbles: true }));
    expect(submit.disabled).toBe(true);
    const optionsInput = popover.querySelectorAll("input")[1] as HTMLInputElement;
    optionsInput.value = "Open, Closed";
    optionsInput.dispatchEvent(new Event("input", { bubbles: true }));
    expect(submit.disabled).toBe(false);
  });
});

describe("column delete", () => {
  function openColumnMenuFor(editorTable: HTMLElement, columnIndex: number): void {
    const menuButtons = editorTable.querySelectorAll(".data-table-column-menu");
    (menuButtons[columnIndex] as HTMLButtonElement).click();
  }

  it("the ⋮ menu's Delete column item opens a confirm modal, without deleting yet", () => {
    const { tableView, editorTable, scheduleSave } = setup();
    tableView.render(sampleFile());
    openColumnMenuFor(editorTable, 0);
    const menu = document.querySelector(".context-menu") as HTMLElement;
    expect(menu).not.toBeNull();
    (menu.querySelector("button.danger") as HTMLButtonElement).click();

    expect(document.querySelector(".context-menu")).toBeNull(); // menu closed itself
    const overlay = document.querySelector(".dialog-panel") as HTMLElement;
    expect(overlay).not.toBeNull();
    expect(overlay.querySelector(".dialog-title")?.textContent).toBe('Delete "Name" column?');
    expect(editorTable.querySelectorAll("thead .data-table-column-label")).toHaveLength(2); // not deleted yet
    expect(scheduleSave).not.toHaveBeenCalled();
  });

  it("Cancel dismisses the modal without deleting", () => {
    const { tableView, editorTable, scheduleSave } = setup();
    tableView.render(sampleFile());
    openColumnMenuFor(editorTable, 0);
    (document.querySelector(".context-menu button.danger") as HTMLButtonElement).click();
    const overlay = document.querySelector(".dialog-panel") as HTMLElement;
    const [cancelButton] = overlay.querySelectorAll(".dialog-actions button");
    (cancelButton as HTMLButtonElement).click();

    expect(document.querySelector(".dialog-panel")).toBeNull();
    expect(editorTable.querySelectorAll("thead .data-table-column-label")).toHaveLength(2);
    expect(scheduleSave).not.toHaveBeenCalled();
  });

  it("confirming removes the column, its value from every row, and persists", async () => {
    const { tableView, editorTable, scheduleSave } = setup();
    tableView.render(sampleFile());
    openColumnMenuFor(editorTable, 0); // "Name"
    (document.querySelector(".context-menu button.danger") as HTMLButtonElement).click();
    const overlay = document.querySelector(".dialog-panel") as HTMLElement;
    (overlay.querySelector(".dialog-primary") as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(document.querySelector(".dialog-panel")).toBeNull();
    expect(editorTable.querySelectorAll("thead .data-table-column-label")).toHaveLength(1);
    expect(editorTable.querySelectorAll("thead .data-table-column-label")[0].textContent).toBe("Done");
    expect(editorTable.querySelectorAll("tbody tr")[0].querySelectorAll("td")).toHaveLength(1);
    const [, content] = scheduleSave.mock.calls[scheduleSave.mock.calls.length - 1];
    expect(content).not.toContain('data-field="name"');
  });

  it("deleting every column falls back to the empty-table state", async () => {
    const { tableView, editorTable } = setup();
    tableView.render(sampleFile({ columns: [{ id: "name", label: "Name", type: "text" }] }));
    openColumnMenuFor(editorTable, 0);
    (document.querySelector(".context-menu button.danger") as HTMLButtonElement).click();
    (document.querySelector(".dialog-primary") as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(editorTable.querySelector(".data-table-empty")).not.toBeNull();
    expect(editorTable.querySelector("table")).toBeNull();
  });
});

describe("column media folder", () => {
  const mediaFile = () =>
    sampleFile({
      columns: [
        { id: "name", label: "Name", type: "text" },
        { id: "still", label: "Still", type: "media" },
      ],
      rows: [{ values: { name: "Widget", still: "" } }],
    });

  function menuLabels(): string[] {
    return Array.from(document.querySelectorAll(".context-menu button")).map((button) => button.textContent ?? "");
  }

  it("is offered on a media column's ⋮ menu only", () => {
    const { tableView, editorTable } = setup();
    tableView.render(mediaFile());
    const buttons = editorTable.querySelectorAll<HTMLButtonElement>(".data-table-column-menu");
    buttons[0].click();
    expect(menuLabels()).not.toContain("Media folder…");
    buttons[0].click(); // closes
    buttons[1].click();
    expect(menuLabels()).toContain("Media folder…");
  });

  it("writes the entered folder onto the column, and clears it when emptied", async () => {
    const { tableView, editorTable, scheduleSave } = setup();
    tableView.render(mediaFile());
    const setFolder = async (value: string) => {
      editorTable.querySelectorAll<HTMLButtonElement>(".data-table-column-menu")[1].click();
      const item = Array.from(document.querySelectorAll<HTMLButtonElement>(".context-menu button")).find(
        (button) => button.textContent === "Media folder…",
      );
      item?.click();
      const input = document.querySelector(".dialog-panel input") as HTMLInputElement;
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      (document.querySelector(".dialog-primary") as HTMLButtonElement).click();
      await vi.waitFor(() => expect(document.querySelector(".dialog-panel")).toBeNull());
    };

    await setFolder("stills/");
    await vi.waitFor(() => expect(scheduleSave).toHaveBeenCalledTimes(1));
    expect(scheduleSave.mock.lastCall?.[1]).toContain(
      'data-field="still" data-type="media" data-media-folder="stills"',
    );
    await setFolder("");
    await vi.waitFor(() => expect(scheduleSave).toHaveBeenCalledTimes(2));
    expect(scheduleSave.mock.lastCall?.[1]).not.toContain("data-media-folder");
  });

  function openFolderPrompt(editorTable: HTMLElement): HTMLElement {
    editorTable.querySelectorAll<HTMLButtonElement>(".data-table-column-menu")[1].click();
    Array.from(document.querySelectorAll<HTMLButtonElement>(".context-menu button"))
      .find((button) => button.textContent === "Media folder…")
      ?.click();
    return document.querySelector(".dialog-panel") as HTMLElement;
  }

  // jsdom has no DragEvent; the drop carries what a tree row writes.
  function dropRow(panel: HTMLElement, path: string, type: "file" | "directory"): void {
    const data: Record<string, string> = { "text/plain": path, "application/x-pragma-entry-type": type };
    const event = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", {
      value: { types: Object.keys(data), getData: (k: string) => data[k] ?? "" },
    });
    panel.dispatchEvent(event);
  }

  it("is scoped to the editor, and takes a folder dragged in from a tree", () => {
    const { tableView, editorTable } = setup();
    tableView.render(mediaFile());
    const panel = openFolderPrompt(editorTable);
    expect(panel.parentElement?.classList.contains("dialog-scoped")).toBe(true);
    const input = panel.querySelector(".dialog-input") as HTMLInputElement;

    dropRow(panel, "stills/shots", "directory");
    expect(input.value).toBe("stills/shots/");
    dropRow(panel, "lib:refs/incoming", "directory");
    expect(input.value).toBe("lib:refs/incoming/");
  });

  it("refuses a dragged file, leaving the field as it was", () => {
    const { tableView, editorTable } = setup();
    tableView.render(mediaFile());
    const panel = openFolderPrompt(editorTable);
    const input = panel.querySelector(".dialog-input") as HTMLInputElement;
    dropRow(panel, "stills/a.png", "file");
    expect(input.value).toBe("");
    const error = panel.querySelector(".dialog-error") as HTMLElement;
    expect(error.hidden).toBe(false);
    expect(error.textContent).toContain("folder");
  });

  it("closes with the table it was about", () => {
    const { tableView, editorTable } = setup();
    tableView.render(mediaFile());
    openFolderPrompt(editorTable);
    tableView.clear();
    expect(document.querySelector(".dialog-panel")).toBeNull();
  });
});

describe("reading view", () => {
  it("hides the delete column, add-row button and type icons, and draws the values as content", () => {
    const { tableView, editorTable } = setup(true);
    tableView.render(sampleFile());
    expect(editorTable.querySelectorAll("thead th")).toHaveLength(2); // no delete-button column
    expect(editorTable.querySelector("thead .type-icon")).toBeNull();
    expect([...editorTable.querySelectorAll("thead th")].map((th) => th.textContent)).toEqual(["Name", "Done"]);
    expect(editorTable.querySelector(".data-table-add-row")).toBeNull();
    expect(editorTable.querySelector(".data-table-row-delete")).toBeNull();
    expect(editorTable.querySelector(".data-table-column-menu")).toBeNull();
    expect(editorTable.querySelectorAll("tbody input, tbody select, tbody button")).toHaveLength(0);
    const values = [...editorTable.querySelectorAll("tbody .data-table-value")];
    expect(values.map((value) => value.textContent)).toEqual(["Widget", ""]);
    expect(values[1].getAttribute("aria-label")).toBe("Not checked");
  });

  // Its column names select with its values only then: in Edit and Design a
  // header carries the column's tools.
  it("marks the grid read-only, as a locked file's is, and neither one in Edit or Design", () => {
    const readOnly = (editorTable: HTMLElement) =>
      editorTable.querySelector(".data-table-form")?.classList.contains("is-read-only");
    const reading = setup(true);
    reading.tableView.render(sampleFile());
    expect(readOnly(reading.editorTable)).toBe(true);
    const locked = setup(false, false);
    locked.tableView.render(sampleFile({ version: "99.0", locked: "newer-format" }));
    expect(readOnly(locked.editorTable)).toBe(true);
    const editing = setup(false, false);
    editing.tableView.render(sampleFile());
    expect(readOnly(editing.editorTable)).toBe(false);
    editing.tableView.setDesigning(true);
    expect(readOnly(editing.editorTable)).toBe(false);
  });
});

// docs/protocol.md's "Reading and write protection" rule: a file the server sends
// locked is drawn read-only and never saved over, whatever the reason.
describe("a locked file", () => {
  it("shows an unreadable file as its notice alone, not as an empty table to fill in", () => {
    const { tableView, editorTable } = setup();
    tableView.render(sampleFile({ columns: [], rows: [], locked: "unreadable" }));
    expect(editorTable.querySelector(".document-locked-notice")?.textContent).toMatch(/couldn't be read/);
    expect(editorTable.querySelector(".data-table-empty")).toBeNull();
    expect(editorTable.querySelector(".data-table-add-row")).toBeNull();
  });

  it("draws a newer-format file as content under its notice, with nothing to edit, in Edit too", () => {
    const { tableView, editorTable, scheduleSave } = setup(false, false);
    tableView.render(sampleFile({ version: "99.0", locked: "newer-format" }));
    expect(editorTable.querySelector(".document-locked-notice")?.textContent).toContain("99.0");
    expect(editorTable.querySelectorAll("tbody input, tbody select, tbody button")).toHaveLength(0);
    expect(editorTable.querySelector("tbody .data-table-value")?.textContent).toBe("Widget");
    expect(editorTable.querySelector(".data-table-add-row")).toBeNull();
    expect(scheduleSave).not.toHaveBeenCalled();
  });
});

describe("refresh", () => {
  it("re-draws from the current working copy and calls onRendered again", () => {
    const { tableView, editorTable, onRendered } = setup();
    tableView.render(sampleFile());
    editorTable.innerHTML = "wiped";
    tableView.refresh();
    expect(editorTable.querySelector(".data-table")).not.toBeNull();
    expect(onRendered).toHaveBeenCalledTimes(2);
  });

  it("is a no-op when nothing is active", () => {
    const { tableView, editorTable, onRendered } = setup();
    tableView.refresh();
    expect(editorTable.innerHTML).toBe("");
    expect(onRendered).toHaveBeenCalledTimes(1);
  });
});

// Edit changes values and rows; Design changes the table's shape. Neither
// reaches the other's, so a mis-click while entering data stays away from a
// column delete, and one while reshaping away from a value.
describe("design mode", () => {
  it("keeps the column tools to Design, and the values and rows to Edit", () => {
    const { tableView, editorTable } = setup(false, false);
    tableView.render(sampleFile());
    expect(editorTable.querySelector(".data-table-column-menu")).toBeNull();
    expect(editorTable.querySelector(".data-table-add-column")).toBeNull();
    expect(editorTable.querySelector(".data-table-add-row")).not.toBeNull();
    expect(editorTable.querySelector(".data-table-row-delete")).not.toBeNull();
    expect((editorTable.querySelector(".data-table-cell-text") as HTMLInputElement).readOnly).toBe(false);
    expect(editorTable.querySelectorAll("thead .type-icon")).toHaveLength(2);

    tableView.setDesigning(true);
    expect(tableView.isDesigning()).toBe(true);
    expect(editorTable.querySelectorAll("thead .type-icon")).toHaveLength(2);
    expect(editorTable.querySelectorAll(".data-table-column-menu")).toHaveLength(2);
    expect(editorTable.querySelector(".data-table-add-column")).not.toBeNull();
    expect(editorTable.querySelector(".data-table-add-row")).toBeNull();
    expect(editorTable.querySelector(".data-table-row-delete")).toBeNull();
    expect(editorTable.querySelectorAll("tbody input, tbody select, tbody button")).toHaveLength(0);
    expect(editorTable.querySelector("tbody .data-table-value")?.textContent).toBe("Widget");
  });

  it("shows nothing to design while reading, whatever the mode says", () => {
    const { tableView, editorTable } = setup(true, true);
    tableView.render(sampleFile());
    expect(editorTable.querySelector(".data-table-column-menu")).toBeNull();
    expect(editorTable.querySelector(".data-table-add-column")).toBeNull();
  });

  // A mode entered for one table must not be inherited by the next one
  // opened; re-drawing the same table keeps it.
  it("drops Design when a different table is drawn, and keeps it for the same one", () => {
    const { tableView } = setup(false, true);
    tableView.render(sampleFile());
    tableView.render(sampleFile());
    expect(tableView.isDesigning()).toBe(true);
    tableView.render(sampleFile({ path: "other.table.html" }));
    expect(tableView.isDesigning()).toBe(false);
  });

  it("drops Design once the view lets its table go, even when the same table comes back", () => {
    const { tableView } = setup(false, true);
    tableView.render(sampleFile());
    tableView.clear();
    tableView.render(sampleFile());
    expect(tableView.isDesigning()).toBe(false);
  });

  // With no columns there is nothing to protect and nothing else to do.
  it("offers Add column on an empty table in Edit as well as Design", () => {
    const { tableView, editorTable } = setup(false, false);
    tableView.render(sampleFile({ columns: [], rows: [] }));
    expect(editorTable.querySelector(".data-table-add-row")?.textContent).toBe("+ Add column");
    tableView.setDesigning(true);
    expect(editorTable.querySelector(".data-table-add-row")?.textContent).toBe("+ Add column");
  });
});

// Two layouts over one set of rows. A card is composed by convention, from
// the grid's own controls, so nothing here tests a second widget — only
// that the right cells land in the right places and blanks behave.
describe("layouts", () => {
  const mediaFile = () =>
    sampleFile({
      columns: [
        { id: "take", label: "Take", type: "text" },
        { id: "status", label: "Status", type: "select", options: ["queued", "complete"] },
        { id: "file", label: "File", type: "media" },
        { id: "note", label: "Note", type: "text" },
      ],
      rows: [
        { values: { take: "BR2-001", status: "complete", file: "one.webm", note: "" } },
        { values: { take: "BR2-002", status: "queued", file: "", note: "retake" } },
      ],
    });

  it("opens in the list unless the file says cards, and keeps the session's choice for the same file", () => {
    const { tableView, editorTable } = setup(false, false);
    tableView.render(mediaFile());
    expect(tableView.getLayout()).toBe("list");
    expect(editorTable.querySelector("table.data-table")).not.toBeNull();

    tableView.setLayout("cards");
    expect(editorTable.querySelector("table.data-table")).toBeNull();
    expect(editorTable.querySelectorAll(".data-cards-card")).toHaveLength(2);
    tableView.render(mediaFile());
    expect(tableView.getLayout()).toBe("cards");

    tableView.render(sampleFile({ path: "other.table.html", layout: "cards" }));
    expect(tableView.getLayout()).toBe("cards");
    tableView.render(sampleFile({ path: "third.table.html" }));
    expect(tableView.getLayout()).toBe("list");
  });

  it("opens in the layout picked on this install over the file's own, and saves the file's own", () => {
    const { tableView, editorTable, scheduleSave } = setup(false, false);
    tableView.render({ ...mediaFile(), localLayout: "cards" });
    expect(editorTable.querySelectorAll(".data-cards-card")).toHaveLength(2);
    (editorTable.querySelector(".data-table-add-row") as HTMLButtonElement).click();
    const [, content] = scheduleSave.mock.calls.at(-1) as [string, string];
    expect(content).not.toContain("data-layout");

    tableView.render(sampleFile({ path: "board.table.html", layout: "cards", localLayout: "list" }));
    expect(tableView.getLayout()).toBe("list");
    expect(editorTable.querySelector("table.data-table")).not.toBeNull();
  });

  it("composes a card from the first media, first, and first select columns, the rest as lines", () => {
    const { tableView, editorTable } = setup(false, false);
    tableView.render({ ...mediaFile(), layout: "cards" });
    const card = editorTable.querySelector(".data-cards-card") as HTMLElement;
    expect(card.querySelector(".data-cards-picture .media-field video")).not.toBeNull();
    expect((card.querySelector(".data-cards-title input") as HTMLInputElement).value).toBe("BR2-001");
    expect((card.querySelector(".data-cards-badge select") as HTMLSelectElement).value).toBe("complete");
    expect([...card.querySelectorAll(".data-cards-field-label")].map((l) => l.textContent)).toEqual(["Note"]);
    // Editing: the row delete sits on the card, and Add is below.
    expect(card.querySelector(".data-table-row-delete")).not.toBeNull();
    expect(editorTable.querySelector(".data-table-add-row")).not.toBeNull();
  });

  // The picture is claimed first: a media column at the front is still the
  // picture, and the title is whatever comes next — or nothing, for a table
  // that is only media.
  it("a media column in first place is the picture, never the title", () => {
    const { tableView, editorTable } = setup(false, false);
    const mediaFirst = sampleFile({
      columns: [
        { id: "file", label: "File", type: "media" },
        { id: "take", label: "Take", type: "text" },
        { id: "status", label: "Status", type: "select", options: ["queued", "complete"] },
      ],
      rows: [{ values: { file: "one.webm", take: "BR2-001", status: "queued" } }],
    });
    tableView.render({ ...mediaFirst, layout: "cards" });
    const card = editorTable.querySelector(".data-cards-card") as HTMLElement;
    expect(card.querySelector(".data-cards-picture .media-field video")).not.toBeNull();
    expect((card.querySelector(".data-cards-title input") as HTMLInputElement).value).toBe("BR2-001");
    expect((card.querySelector(".data-cards-badge select") as HTMLSelectElement).value).toBe("queued");
    expect(card.querySelectorAll(".data-cards-field")).toHaveLength(0);

    tableView.render({
      ...sampleFile({
        columns: [{ id: "file", label: "File", type: "media" }],
        rows: [{ values: { file: "one.webm" } }],
      }),
      layout: "cards",
    });
    const only = editorTable.querySelector(".data-cards-card") as HTMLElement;
    expect(only.querySelector(".data-cards-picture .media-field video")).not.toBeNull();
    expect(only.querySelector(".data-cards-title")).toBeNull();
    expect(only.querySelector(".data-cards-head .data-table-row-delete")).not.toBeNull();
  });

  it("skips a blank line while reading, and shows it while editing", () => {
    const reading = setup(true, false);
    reading.tableView.render({ ...mediaFile(), layout: "cards" });
    const cards = reading.editorTable.querySelectorAll(".data-cards-card");
    expect(cards[0].querySelector(".data-cards-field")).toBeNull(); // note is blank
    expect(cards[1].querySelectorAll(".data-cards-field")).toHaveLength(1);
    expect(cards[0].querySelector(".data-table-row-delete")).toBeNull();

    const editing = setup(false, false);
    editing.tableView.render({ ...mediaFile(), layout: "cards" });
    expect(
      editing.editorTable.querySelectorAll(".data-cards-card")[0].querySelectorAll(".data-cards-field"),
    ).toHaveLength(1);
  });

  it("is always the list while designing, and comes back once Design is off", () => {
    const { tableView, editorTable } = setup(false, false);
    tableView.render({ ...mediaFile(), layout: "cards" });
    tableView.setDesigning(true);
    expect(editorTable.querySelector("table.data-table")).not.toBeNull();
    expect(tableView.getLayout()).toBe("cards");
    tableView.setDesigning(false);
    expect(editorTable.querySelector(".data-cards")).not.toBeNull();
  });

  it("adds and deletes rows from the cards, persisting the file's own layout", async () => {
    const { tableView, editorTable, scheduleSave } = setup(false, false);
    tableView.render({ ...mediaFile(), layout: "cards" });
    (editorTable.querySelector(".data-table-add-row") as HTMLButtonElement).click();
    expect(editorTable.querySelectorAll(".data-cards-card")).toHaveLength(3);
    (editorTable.querySelector(".data-table-row-delete") as HTMLButtonElement).click();
    expect(document.querySelector(".dialog-panel .dialog-title")?.textContent).toBe('Delete "BR2-001" entry?');
    (document.querySelector(".dialog-primary") as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(editorTable.querySelectorAll(".data-cards-card")).toHaveLength(2);
    const [, content] = scheduleSave.mock.calls.at(-1) as [string, string];
    expect(content).toContain('data-layout="cards"');
  });
});

describe("timestamp columns", () => {
  // What a datetime-local control holds for an instant: wall time here.
  function localValue(date: Date): string {
    const pad = (value: number) => String(value).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  }

  const stampedFile = (added: string, fill = true) =>
    sampleFile({
      columns: [
        { id: "name", label: "Name", type: "text" },
        { id: "added", label: "Added", type: "timestamp", ...(fill ? { default: "now" as const } : {}) },
      ],
      rows: [{ values: { name: "Widget", added } }],
    });

  function addTimestampColumn(editorTable: HTMLElement, fill: boolean): void {
    (editorTable.querySelector(".data-table-add-column") as HTMLButtonElement).click();
    const popover = document.querySelector(".popover") as HTMLElement;
    const nameInput = popover.querySelector("input") as HTMLInputElement;
    nameInput.value = "Added";
    nameInput.dispatchEvent(new Event("input", { bubbles: true }));
    const typeSelect = popover.querySelector("select") as HTMLSelectElement;
    typeSelect.value = "timestamp";
    typeSelect.dispatchEvent(new Event("change", { bubbles: true }));
    const fillField = popover.querySelector(".popover-checkbox") as HTMLElement;
    expect(fillField.hidden).toBe(false);
    const fillBox = fillField.querySelector("input") as HTMLInputElement;
    expect(fillBox.checked).toBe(true); // ticked to start with
    fillBox.checked = fill;
    (popover.querySelector(".action-button") as HTMLButtonElement).click();
  }

  it("fills a new row with the time it's added, but not the rows already there", () => {
    vi.useFakeTimers({ now: new Date("2026-10-07T12:32:05.250Z"), toFake: ["Date"] });
    try {
      const { tableView, editorTable, scheduleSave } = setup();
      tableView.render(sampleFile());
      addTimestampColumn(editorTable, true);
      let [, content] = scheduleSave.mock.calls.at(-1) as [string, string];
      expect(content).toContain('data-field="added" data-type="timestamp" data-default="now"');
      expect(content).toContain("<tr><td>Widget</td><td>false</td><td></td></tr>");

      tableView.setDesigning(false);
      (editorTable.querySelector(".data-table-add-row") as HTMLButtonElement).click();
      [, content] = scheduleSave.mock.calls.at(-1) as [string, string];
      expect(content).toContain("<tr><td></td><td>false</td><td>2026-10-07T12:32:05Z</td></tr>");
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves new rows blank when the column isn't filled", () => {
    const { tableView, editorTable, scheduleSave } = setup();
    tableView.render(sampleFile());
    addTimestampColumn(editorTable, false);
    tableView.setDesigning(false);
    (editorTable.querySelector(".data-table-add-row") as HTMLButtonElement).click();
    const [, content] = scheduleSave.mock.calls.at(-1) as [string, string];
    expect(content).toContain('data-type="timestamp">Added</th>');
    expect(content).toContain("<tr><td></td><td>false</td><td></td></tr>");
  });

  it("is switched from the column menu, which only a timestamp column offers it on", () => {
    const { tableView, editorTable, scheduleSave } = setup();
    tableView.render(stampedFile(""));
    const menus = editorTable.querySelectorAll<HTMLButtonElement>(".data-table-column-menu");
    menus[0].click();
    expect(document.querySelector('.context-menu [role="menuitemcheckbox"]')).toBeNull();
    menus[0].click(); // closes
    menus[1].click();
    const item = document.querySelector('.context-menu [role="menuitemcheckbox"]') as HTMLButtonElement;
    expect(item.textContent).toContain("Fill new rows with the time added");
    expect(item.getAttribute("aria-checked")).toBe("true");
    item.click();
    const [, content] = scheduleSave.mock.calls.at(-1) as [string, string];
    expect(content).toContain('data-type="timestamp">Added</th>');
    expect(content).toContain("<td>Widget</td><td></td>"); // the row already there is untouched
  });

  const display = (iso: string) =>
    new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));
  const lastSaved = (scheduleSave: ReturnType<typeof vi.fn>) => (scheduleSave.mock.calls.at(-1) as [string, string])[1];
  const pickerButton = (label: string) =>
    [...document.querySelectorAll<HTMLButtonElement>(".timestamp-picker button")].find(
      (button) => button.textContent === label,
    ) as HTMLButtonElement;

  it("shows a stored instant as local text, and stores a time picked for it as UTC", () => {
    const { tableView, editorTable, scheduleSave } = setup(false, false);
    tableView.render(stampedFile("2026-10-07T12:32:05Z"));
    const cell = editorTable.querySelector(".data-table-cell-timestamp") as HTMLButtonElement;
    expect(cell.textContent).toBe(display("2026-10-07T12:32:05Z"));

    cell.click();
    const input = document.querySelector('.timestamp-picker input[type="datetime-local"]') as HTMLInputElement;
    // As an instant, not a string: jsdom spells a whole second with ".000".
    expect(new Date(input.value).getTime()).toBe(Date.parse("2026-10-07T12:32:05Z"));
    input.value = localValue(new Date("2027-01-02T03:04:05Z"));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    expect(lastSaved(scheduleSave)).toContain("<td>2027-01-02T03:04:05Z</td>");
    expect(cell.textContent).toBe(display("2027-01-02T03:04:05Z"));
    expect(document.querySelector(".timestamp-picker")).not.toBeNull(); // a date, then its time

    pickerButton("Clear").click();
    expect(document.querySelector(".timestamp-picker")).toBeNull();
    expect(lastSaved(scheduleSave)).toContain("<td>Widget</td><td></td>");
    expect(cell.textContent).toBe("None");
  });

  it("stamps the time it is now from the picker", () => {
    vi.useFakeTimers({ now: new Date("2026-10-07T12:32:05.250Z"), toFake: ["Date"] });
    try {
      const { tableView, editorTable, scheduleSave } = setup(false, false);
      tableView.render(stampedFile("", false));
      (editorTable.querySelector(".data-table-cell-timestamp") as HTMLButtonElement).click();
      pickerButton("Now").click();
      expect(lastSaved(scheduleSave)).toContain("<td>2026-10-07T12:32:05Z</td>");
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows a value that isn't a timestamp as the text it is, and keeps it", () => {
    const { tableView, editorTable, scheduleSave } = setup(false, false);
    tableView.render(stampedFile("last Tuesday"));
    const cell = editorTable.querySelector(".data-table-cell-timestamp") as HTMLButtonElement;
    expect(cell.textContent).toBe("last Tuesday");
    expect(cell.dataset.tooltip).toBe("Not a time Pragma can read, kept as written");
    expect(scheduleSave).not.toHaveBeenCalled();
  });

  it("is drawn as its time, with no picker, while reading and while designing", () => {
    for (const [reading, designing] of [
      [true, false],
      [false, true],
    ]) {
      const { tableView, editorTable } = setup(reading, designing);
      tableView.render(stampedFile("2026-10-07T12:32:05Z"));
      expect(editorTable.querySelector(".data-table-cell-timestamp")).toBeNull();
      expect(editorTable.querySelectorAll("tbody .data-table-value")[1].textContent).toBe(
        display("2026-10-07T12:32:05Z"),
      );
    }
  });
});

describe("a media column's file names", () => {
  it("show once Design's column menu says so, saved with the column", () => {
    const { tableView, editorTable, scheduleSave } = setup();
    tableView.render(
      sampleFile({ columns: [{ id: "still", label: "Still", type: "media" }], rows: [{ values: { still: "a.png" } }] }),
    );
    const name = () => editorTable.querySelector(".media-field-name") as HTMLElement;
    expect(name().hidden).toBe(true);

    (editorTable.querySelector(".data-table-column-menu") as HTMLButtonElement).click();
    const items = [...document.querySelectorAll<HTMLButtonElement>(".context-menu button")];
    expect(items.map((each) => each.textContent?.trim())).toEqual([
      "Rename…",
      "Show name",
      "Media folder…",
      "Delete column",
    ]);
    const item = items[1];
    expect(item.getAttribute("aria-checked")).toBe("false");
    item.click();
    expect(name().hidden).toBe(false);
    const [, content] = scheduleSave.mock.calls.at(-1) as [string, string];
    expect(content).toContain('<th data-field="still" data-type="media" data-show-name>Still</th>');
  });
});

// The group places its title bar in the view's element and re-places it
// only when told the view has drawn; a redraw from inside the table, which
// doesn't tell it, replaces only what the view drew.
describe("a redraw from inside the table", () => {
  it("leaves the group's title bar where it is", async () => {
    const { tableView, editorTable } = setup();
    tableView.render(
      sampleFile({
        columns: [
          { id: "still", label: "Still", type: "media" },
          { id: "name", label: "Name", type: "text" },
        ],
        rows: [{ values: { still: "a.png", name: "Widget" } }],
      }),
    );
    const title = document.createElement("div");
    editorTable.prepend(title);
    const intact = () =>
      editorTable.firstElementChild === title && editorTable.querySelectorAll(".data-table-form").length === 1;

    editorTable.querySelectorAll<HTMLButtonElement>(".data-table-column-menu")[0].click();
    [...document.querySelectorAll<HTMLButtonElement>(".context-menu button")]
      .find((button) => button.textContent?.includes("Show name"))
      ?.click();
    expect(intact()).toBe(true);

    editorTable.querySelectorAll<HTMLButtonElement>(".data-table-column-menu")[1].click();
    (document.querySelector(".context-menu button.danger") as HTMLButtonElement).click();
    (document.querySelector(".dialog-primary") as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(editorTable.querySelectorAll("thead .data-table-column-label")).toHaveLength(1);
    expect(intact()).toBe(true);

    tableView.setDesigning(false);
    tableView.setLayout("cards");
    (editorTable.querySelector(".data-table-add-row") as HTMLButtonElement).click();
    expect(editorTable.querySelectorAll(".data-cards-card")).toHaveLength(2);
    expect(intact()).toBe(true);
  });
});
