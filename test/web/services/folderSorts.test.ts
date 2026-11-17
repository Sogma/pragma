// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchSortKeys, postLocalSort, postSetOrder, postSetSort } from "../../../web/core/apiClient.ts";
import type { CommandContext } from "../../../web/services/commands.ts";
import type { DialogService } from "../../../web/services/dialog.ts";
import {
  describeSort,
  onFolderSortChanged,
  type SortByTarget,
  setAsDefault,
  setLocalSort,
  setOwnArrangement,
  sortByItems,
} from "../../../web/services/folderSorts.ts";
import type { MenuItem } from "../../../web/services/menus.ts";

vi.mock("../../../web/core/apiClient.ts", () => ({
  postLocalSort: vi.fn(async () => undefined),
  postSetOrder: vi.fn(async () => undefined),
  postSetSort: vi.fn(async () => undefined),
  fetchSortKeys: vi.fn(async () => ["date", "title"]),
}));

const context: CommandContext = { tab: { kind: "empty" }, pane: undefined };

function target(order: SortByTarget["order"], keepsOrder = true): SortByTarget {
  return { path: "scenes", name: "scenes", order, shown: () => ["b.md", "a.md"], keepsOrder };
}

const rows = (items: MenuItem[]) =>
  items.map(({ label, checked, mark, direction }) => [label, checked?.(context, undefined), mark, direction]);

const run = async (items: MenuItem[], label: string) => {
  await items.find((item) => item.label === label)?.run?.(context, undefined);
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("the Sort by menu", () => {
  it("checks the sort shown with its direction, and marks the folder's own with a dot", () => {
    const items = sortByItems(target({ default: { by: "manual" }, local: { by: "name", order: "desc" } }), vi.fn());
    expect(rows(items)).toEqual([
      ["Name", true, undefined, "descending"],
      ["Date created", false, undefined, undefined],
      ["Date modified", false, undefined, undefined],
      ["Size", false, undefined, undefined],
      ["Manual order", false, "Default sort for this folder", undefined],
      ["Property…", false, undefined, undefined],
      ["Set as default for this folder", undefined, undefined, undefined],
    ]);
    expect(items.at(-1)?.description).toBe("For every device and app");
  });

  it("names the property it sorts by, and offers no default while the two agree or in a library", () => {
    const own = sortByItems(target({ default: { by: "property", property: "date", order: "desc" } }), vi.fn());
    expect(rows(own).at(-1)).toEqual(["Property: date", true, "Default sort for this folder", "descending"]);
    expect(own).toHaveLength(6);
    const local = target({ default: { by: "name", order: "asc" }, local: { by: "size", order: "desc" } }, false);
    expect(sortByItems(local, vi.fn()).map((item) => item.label)).not.toContain("Set as default for this folder");
  });

  it("paints the dot and the row that saves it in the colour of the folder's root", () => {
    const order = { default: { by: "manual" }, local: { by: "name", order: "desc" } } as const;
    const space = sortByItems(target(order), vi.fn());
    expect(space.find((item) => item.mark)?.style).toEqual({ "--menu-mark": "var(--view-space)" });
    expect(space.at(-1)?.style).toEqual({ color: "var(--view-space)" });
    const library = sortByItems({ ...target(order, false), path: "lib:footage" }, vi.fn());
    expect(library.find((item) => item.mark)?.style).toEqual({ "--menu-mark": "var(--view-library)" });
    expect(library.filter((item) => item.style).length).toBe(1);
  });

  it("flips the sort shown, starts another in its first direction, and leaves Manual order be", async () => {
    const shownName = sortByItems(target({ default: { by: "name", order: "asc" } }), vi.fn());
    await run(shownName, "Name");
    expect(postLocalSort).toHaveBeenLastCalledWith("scenes", { by: "name", order: "desc" }, undefined);
    await run(shownName, "Date modified");
    expect(postLocalSort).toHaveBeenLastCalledWith("scenes", { by: "modified", order: "desc" }, undefined);
    await run(shownName, "Date created");
    expect(postLocalSort).toHaveBeenLastCalledWith("scenes", { by: "created", order: "asc" }, undefined);
    await run(shownName, "Manual order");
    expect(postLocalSort).toHaveBeenLastCalledWith("scenes", { by: "manual" }, undefined);

    vi.mocked(postLocalSort).mockClear();
    await run(sortByItems(target({ default: { by: "manual" } }), vi.fn()), "Manual order");
    expect(postLocalSort).not.toHaveBeenCalled();
  });

  // The folder's own is picked back as it keeps it, never in a first direction.
  it("brings back the folder's own sort as it keeps it", async () => {
    const own = { by: "size", order: "asc" } as const;
    await run(sortByItems(target({ default: own, local: { by: "name", order: "asc" } }), vi.fn()), "Size");
    expect(postLocalSort).toHaveBeenLastCalledWith("scenes", own, undefined);
  });

  it("asks for a property's key, unless the folder's own order is one", async () => {
    const form = vi.fn<DialogService["form"]>(async (options) => {
      await options.submit?.({ property: " title ", order: "desc" });
      return null;
    });
    const dialog = () => ({ form }) as unknown as DialogService;
    await run(sortByItems(target({ default: { by: "name", order: "asc" } }), dialog), "Property…");
    expect(fetchSortKeys).toHaveBeenCalledWith("scenes");
    expect(form.mock.lastCall?.[0].fields?.[0]).toMatchObject({ value: "date", suggestions: ["date", "title"] });
    expect(postLocalSort).toHaveBeenLastCalledWith(
      "scenes",
      { by: "property", property: "title", order: "desc" },
      undefined,
    );

    const own = { by: "property", property: "date", order: "asc" } as const;
    await run(sortByItems(target({ default: own, local: { by: "name", order: "asc" } }), dialog), "Property: date");
    expect(postLocalSort).toHaveBeenLastCalledWith("scenes", own, undefined);
    expect(form).toHaveBeenCalledTimes(1);
  });
});

describe("setting the sort shown as the folder's own", () => {
  const shown = ["b.md", "a.md"];

  // A rule, never the order it shows, so the folder's manual arrangement
  // stays for Manual order to bring back.
  it("keeps every sort but Manual order as its rule, then forgets the sort here", async () => {
    for (const sort of [
      { by: "name", order: "asc" },
      { by: "size", order: "desc" },
      { by: "created", order: "desc" },
      { by: "property", property: "date", order: "desc" },
    ] as const) {
      await setAsDefault("scenes", { default: { by: "manual" }, local: sort }, shown);
      expect(postSetSort).toHaveBeenLastCalledWith("scenes", sort);
      expect(postLocalSort).toHaveBeenLastCalledWith("scenes", null, null);
    }
    expect(postSetOrder).not.toHaveBeenCalled();
  });

  it("keeps Manual order as the arrangement it shows", async () => {
    await setAsDefault("scenes", { default: { by: "name", order: "asc" }, local: { by: "manual" } }, shown);
    expect(postSetOrder).toHaveBeenCalledWith("scenes", shown);
    expect(postSetSort).toHaveBeenCalledWith("scenes", { by: "manual" }, shown);
    vi.mocked(postSetSort).mockClear();
    await setAsDefault("scenes", { default: { by: "manual" }, local: { by: "manual" } }, shown);
    expect(postSetOrder).toHaveBeenLastCalledWith("scenes", shown);
    expect(postSetSort).not.toHaveBeenCalled();
  });

  it("tells whatever draws the folder, even when the change failed", async () => {
    const heard: string[] = [];
    const stop = onFolderSortChanged((path) => heard.push(path));
    await setLocalSort("lib:footage", { by: "size", order: "desc" });
    vi.mocked(postLocalSort).mockRejectedValueOnce(new Error("offline"));
    await expect(setLocalSort("scenes", null)).rejects.toThrow("offline");
    stop();
    await setLocalSort("elsewhere", null);
    expect(heard).toEqual(["lib:footage", "scenes"]);
  });
});

// A drag in the tree or a Class writes the folder's own manual order.
describe("arranging a folder's own order", () => {
  it("writes the arrangement into the folder, and tells whatever draws it, even on failure", async () => {
    const heard: string[] = [];
    const stop = onFolderSortChanged((path) => heard.push(path));
    await setOwnArrangement("scenes", ["b.md", "a.md"]);
    expect(postSetOrder).toHaveBeenLastCalledWith("scenes", ["b.md", "a.md"]);
    expect(postLocalSort).not.toHaveBeenCalled();
    vi.mocked(postSetOrder).mockRejectedValueOnce(new Error("offline"));
    await expect(setOwnArrangement("acts", ["one.md"])).rejects.toThrow("offline");
    stop();
    expect(heard).toEqual(["scenes", "acts"]);
  });
});

// The words a tree row's mark uses: its Sort by row's, with the direction.
describe("a sort in words", () => {
  it("names each sort as its Sort by row does", () => {
    expect(describeSort({ by: "manual" })).toBe("Manual order");
    expect(describeSort({ by: "created", order: "asc" })).toBe("Sorted by date created (ascending)");
    expect(describeSort({ by: "size", order: "desc" })).toBe("Sorted by size (descending)");
    expect(describeSort({ by: "property", property: "status", order: "asc" })).toBe("Sorted by status (ascending)");
  });
});
