// Changing how a gallery lists a folder on this install, and making that the
// folder's own order, through the gallery toolbar's Sort by menu; arranging
// the folder's own order, as a drag in the tree does; and how a gallery lays
// it out. Whatever draws a folder hears of a change here and lists it again.
import type { SortChoice, SortKind, SortOrder } from "../../src/protocol/folderSort.ts";
import type { FolderLayout } from "../../src/protocol/localSort.ts";
import { isLibraryPath } from "../../src/protocol/rootedPath.ts";
import {
  type FolderOrder,
  fetchSortKeys,
  postFolderLayout,
  postLocalSort,
  postSetOrder,
  postSetSort,
} from "../core/apiClient.ts";
import { shownSort } from "../core/folderOrder.ts";
import type { DialogService } from "./dialog.ts";
import type { MenuItem } from "./menus.ts";

const listeners = new Set<(path: string) => void>();

/** Calls `listener` with a folder's rooted path after its sort changed, or
 * failed to: either way what is drawn may be out of date. */
export function onFolderSortChanged(listener: (path: string) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function changed(path: string): void {
  for (const listener of listeners) listener(path);
}

/** Shows the folder at `path` by `sort` here, or by its own order for null.
 * `arrangement` is a manual order's entry names, as dragged. */
export async function setLocalSort(path: string, sort: SortChoice | null, arrangement?: string[]): Promise<void> {
  try {
    await postLocalSort(path, sort, arrangement);
  } finally {
    changed(path);
  }
}

/** Makes `names` the folder's own manual order, its `_structure.json`, as a
 * drag in the tree does: for every device and app, where a gallery's drag
 * arranges it here only. */
export async function setOwnArrangement(path: string, names: string[]): Promise<void> {
  try {
    await postSetOrder(path, names);
  } finally {
    changed(path);
  }
}

/** Lays the folder at `path` out as `layout` in every gallery here. */
export async function setFolderLayout(path: string, layout: FolderLayout): Promise<void> {
  try {
    await postFolderLayout(path, layout);
  } finally {
    changed(path);
  }
}

/** Makes the sort a folder shows here its own, for every device and app,
 * as the rule it is: never the order it shows, so the folder's manual
 * arrangement stays for Manual order to bring back. Manual order itself
 * writes `shown`, the entries' names in order, as that arrangement. */
export async function setAsDefault(path: string, order: FolderOrder, shown: string[]): Promise<void> {
  const sort = order.local;
  if (!sort) return;
  try {
    if (sort.by === "manual") {
      await postSetOrder(path, shown);
      if (order.default.by !== "manual") await postSetSort(path, sort, shown);
    } else await postSetSort(path, sort);
    await postLocalSort(path, null, null);
  } finally {
    changed(path);
  }
}

export interface SortByTarget {
  /** The folder's rooted path. */
  path: string;
  /** Its name, for the property picker's title. */
  name: string;
  order: FolderOrder;
  /** Its entries' names in the order shown. */
  shown(): string[];
  /** Whether it can keep an order of its own; a library folder can't, so it
   * is never offered Set as default. */
  keepsOrder: boolean;
}

// Each sort's direction when first picked: dates and sizes newest and
// largest first, names from A. Picking it again flips it.
const FIRST_ORDER: Record<"name" | "created" | "modified" | "size", SortOrder> = {
  name: "asc",
  created: "asc",
  modified: "desc",
  size: "desc",
};

const SORTS: readonly { by: SortKind; label: string }[] = [
  { by: "name", label: "Name" },
  { by: "created", label: "Date created" },
  { by: "modified", label: "Date modified" },
  { by: "size", label: "Size" },
  { by: "manual", label: "Manual order" },
  { by: "property", label: "Property…" },
];

const labelOf = (by: SortKind): string => SORTS.find((sort) => sort.by === by)?.label ?? by;

/** A folder's order in its Sort by row's words, for the mark a tree row
 * wears while the folder is in some order other than by name from A. */
export function describeSort(sort: SortChoice): string {
  if (sort.by === "manual") return labelOf("manual");
  const what = sort.by === "property" ? sort.property : labelOf(sort.by).toLowerCase();
  return `Sorted by ${what} (${sort.order === "desc" ? "descending" : "ascending"})`;
}

function failed(error: unknown): void {
  window.alert(error instanceof Error ? error.message : "Failed to change the sort.");
}

async function pickProperty(target: SortByTarget, dialog: DialogService): Promise<void> {
  // The field still takes a typed key when there is nothing to suggest.
  const keys = await fetchSortKeys(target.path).catch(() => [] as string[]);
  await dialog.form({
    title: `Sort "${target.name}" by property`,
    fields: [
      { id: "property", label: "Property", value: keys[0] ?? "", placeholder: "date", suggestions: keys },
      {
        id: "order",
        label: "Order",
        value: "asc",
        choices: [
          { value: "asc", label: "Ascending" },
          { value: "desc", label: "Descending" },
        ],
      },
    ],
    submitLabel: "Sort",
    failureMessage: "Failed to change the sort.",
    validate: (values) => (values.property?.trim() ? undefined : "Enter a property name."),
    submit: async (values) => {
      const property = values.property?.trim() ?? "";
      await setLocalSort(target.path, { by: "property", property, order: values.order === "desc" ? "desc" : "asc" });
      return undefined;
    },
  });
}

/** Picking the sort shown flips its direction; picking the folder's own
 * brings it back as it keeps it; picking another starts it in its first
 * direction. Manual order has no direction, and Property… asks for its key. */
async function pick(target: SortByTarget, by: SortKind, dialog: () => DialogService): Promise<void> {
  const shown = shownSort(target.order);
  const own = target.order.default;
  let next: SortChoice;
  if (shown.by === by) {
    if (shown.by === "manual") return;
    next = { ...shown, order: shown.order === "desc" ? "asc" : "desc" };
  } else if (own.by === by) next = own;
  else if (by === "manual") next = { by };
  else if (by === "property") return pickProperty(target, dialog());
  else next = { by, order: FIRST_ORDER[by] };
  await setLocalSort(target.path, next).catch(failed);
}

/** The Sort by flyout's rows: each sort, the one shown checked with its
 * direction, the folder's own marked with a dot; then, while the two
 * differ, the way to make what is shown the folder's own. */
export function sortByItems(target: SortByTarget, dialog: () => DialogService): MenuItem[] {
  const shown = shownSort(target.order);
  const own = target.order.default;
  // The folder keeps its own sort, so the dot and the row that saves it wear
  // the colour of the root it lives in, as its tabs' stripe does.
  const rootColor = isLibraryPath(target.path) ? "var(--view-library)" : "var(--view-space)";
  const items: MenuItem[] = SORTS.map(({ by, label }) => {
    const property =
      shown.by === "property" && by === "property"
        ? shown.property
        : own.by === by && own.by === "property"
          ? own.property
          : undefined;
    return {
      label: property === undefined ? label : `Property: ${property}`,
      group: "sorts",
      checked: () => shown.by === by,
      direction:
        shown.by === by && shown.by !== "manual" ? (shown.order === "desc" ? "descending" : "ascending") : undefined,
      mark: own.by === by ? "Default sort for this folder" : undefined,
      style: own.by === by ? { "--menu-mark": rootColor } : undefined,
      run: () => pick(target, by, dialog),
    };
  });
  if (target.keepsOrder && target.order.local) {
    items.push({
      label: "Set as default for this folder",
      description: "For every device and app",
      group: "default",
      style: { color: rootColor },
      run: () => setAsDefault(target.path, target.order, target.shown()).catch(failed),
    });
  }
  return items;
}
