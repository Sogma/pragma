// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { MetadataEntry } from "../../../src/protocol/types.ts";
import type { CommandContext } from "../../../web/services/commands.ts";
import type { DialogService } from "../../../web/services/dialog.ts";
import type { ContextMenuService, MenuItem } from "../../../web/services/menus.ts";
import { createMetadataProperties } from "../../../web/view/metadataProperties.ts";
import { createPropertyEditor } from "../../../web/view/propertyEditor.ts";

const context = {} as CommandContext;

function setup(metadata: MetadataEntry[], editable = true, answer: string | null = null) {
  const open = vi.fn<ContextMenuService["open"]>();
  const properties = createMetadataProperties({
    createPropertyEditor,
    contextMenu: { open, close: vi.fn(), isOpen: () => false },
    tags: { known: () => [], read: async () => [] },
    dialog: { prompt: vi.fn(async () => answer) } as unknown as DialogService,
  });
  const onChange = vi.fn<(metadata: MetadataEntry[]) => void>();
  properties.show("tables/models.table.html", metadata, editable ? { onChange } : {});
  const row = (key: string) =>
    properties.section.querySelector(`.property-editor-row[data-key="${key}"], .meta-row`) as HTMLElement;
  // The menu a key's icon opens, as items.
  const menu = (key: string): MenuItem[] => {
    properties.section
      .querySelector<HTMLButtonElement>(`.property-editor-row[data-key="${key}"] .property-menu-button`)
      ?.click();
    return open.mock.calls.at(-1)?.[0].items ?? [];
  };
  const pick = (key: string, label: string, sub?: string) => {
    const item = menu(key).find((each) => each.label === label);
    const target = sub ? ((item?.submenu ?? []) as MenuItem[]).find((each) => each.label === sub) : item;
    target?.run?.(context, undefined);
  };
  const saved = () => onChange.mock.calls.at(-1)?.[0];
  return { properties, row, menu, pick, saved };
}

const labels = (items: MenuItem[]) => items.map((item) => item.label);
const checkedType = (items: MenuItem[]) =>
  (items[0].submenu as MenuItem[]).find((each) => each.checked?.(context, undefined))?.label;

describe("a metadata block's key types", () => {
  it("offers each key a Type, checked on its own, with that type's settings before Remove", () => {
    const { menu } = setup([
      { key: "rating", values: ["4"], field: { type: "score" } },
      { key: "description", values: ["d"] },
    ]);
    const rating = menu("rating");
    expect(labels(rating)).toEqual(["Type", "Max…", "Can be rejected", "Remove"]);
    expect(checkedType(rating)).toBe("Score");
    expect(labels((rating[0].submenu as MenuItem[]) ?? [])).not.toContain("Media");
    expect(checkedType(menu("description"))).toBe("Text");
  });

  it("types a key from its menu, saving the type and drawing the key with its control", () => {
    const { pick, saved, row } = setup([{ key: "rating", values: ["4"] }]);
    pick("rating", "Type", "Score");
    expect(saved()).toEqual([{ key: "rating", values: ["4"], field: { type: "score" } }]);
    expect(row("rating").querySelectorAll(".score-mark[data-lit]")).toHaveLength(4);
  });

  it("saves a typed value as text, and takes the type away with Text", () => {
    const { pick, saved, row } = setup([{ key: "rating", values: ["4"], field: { type: "score" } }]);
    row("rating").querySelectorAll<HTMLButtonElement>(".score-mark")[1].click();
    expect(saved()).toEqual([{ key: "rating", values: ["2"], field: { type: "score" } }]);
    pick("rating", "Type", "Text");
    expect(saved()).toEqual([{ key: "rating", values: ["2"] }]);
    expect(row("rating").querySelector(".score")).toBeNull();
  });

  it("carries a key's type through a rename, and drops it with the key", () => {
    const { saved, row, pick } = setup([{ key: "rating", values: ["4"], field: { type: "score" } }]);
    const key = row("rating").querySelector<HTMLInputElement>(".property-editor-key") as HTMLInputElement;
    key.value = "stars";
    key.dispatchEvent(new Event("blur"));
    expect(saved()).toEqual([{ key: "stars", values: ["4"], field: { type: "score" } }]);
    pick("stars", "Remove");
    expect(saved()).toEqual([]);
  });

  it("asks for a select's options, and offers a timestamp no setting for new rows", async () => {
    const { pick, saved, menu } = setup(
      [
        { key: "status", values: ["draft"], field: { type: "select" } },
        { key: "due", values: [], field: { type: "timestamp" } },
      ],
      true,
      "draft, final",
    );
    pick("status", "Options…");
    await vi.waitFor(() => expect(saved()?.[0].field).toEqual({ type: "select", options: ["draft", "final"] }));
    expect(labels(menu("due"))).toEqual(["Type", "Remove"]);
  });

  it("draws a locked block's typed values as their type locks them", () => {
    const { properties } = setup([{ key: "rating", values: ["3"], field: { type: "score" } }], false);
    expect(properties.section.querySelectorAll(".meta-value .score-mark[data-lit]")).toHaveLength(3);
    expect(properties.section.querySelector("button")).toBeNull();
  });
});
