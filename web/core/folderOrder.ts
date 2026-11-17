// A folder's order as the client reads it (src/protocol/folderSort.ts): its
// own, and this install's sort while it shows the folder another way. The
// server lists the tree in each folder's own order and a gallery in the
// order it shows; these only say which.
import { NAME_ORDER, type SortChoice } from "../../src/protocol/folderSort.ts";
import type { FolderOrder, SpaceTreeNode } from "./apiClient.ts";

/** A tree folder's own order, read off its node: the one the tree lists it
 * in. A library folder keeps no order of its own, so its own is Name. */
export function ownSortOf(node: SpaceTreeNode): SortChoice {
  return node.sort ?? (node.sortable ? { by: "manual" } : NAME_ORDER);
}

export const shownSort = (order: FolderOrder): SortChoice => order.local ?? order.default;

/** Whether the folder shows its manual order, so a drag arranges it. */
export const showsManualOrder = (order: FolderOrder): boolean => shownSort(order).by === "manual";
