import { describe, expect, it, vi } from "vitest";
import type { TableColumn } from "../../../src/protocol/types.ts";
import type { CommandContext } from "../../../web/services/commands.ts";
import { type FieldSettingHooks, fieldSettingItems } from "../../../web/services/fieldSettings.ts";
import type { MenuItem } from "../../../web/services/menus.ts";

const context = {} as CommandContext;

// The pane's side: a change lands on the field as the file holds it.
function hooks(field: TableColumn, offersOptions = false) {
  const given: FieldSettingHooks = {
    change: (edit) => edit(field),
    mediaFolder: vi.fn(),
    ...(offersOptions ? { options: vi.fn() } : {}),
  };
  return { given };
}

const labels = (items: MenuItem[]) => items.map((item) => item.label);
const item = (items: MenuItem[], label: string) => items.find((each) => each.label === label) as MenuItem;

describe("fieldSettingItems", () => {
  it("offers what only each type has, and nothing for a type with none", () => {
    const of = (type: TableColumn["type"]) => {
      const field: TableColumn = { id: "f", type, label: "F" };
      return labels(fieldSettingItems(field, hooks(field, true).given));
    };
    expect(of("media")).toEqual(["Show name", "Media folder…"]);
    expect(of("select")).toEqual(["Options…"]);
    expect(of("timestamp")).toEqual(["Fill new rows with the time added"]);
    for (const type of ["checkbox", "color", "integer", "path", "text"] as const) expect(of(type)).toEqual([]);
  });

  it("leaves out a setting the pane doesn't offer", () => {
    const field: TableColumn = { id: "s", type: "select", label: "S", options: ["a"] };
    expect(fieldSettingItems(field, hooks(field).given)).toEqual([]);
  });

  it("turns a setting on and off through the pane", () => {
    const field: TableColumn = { id: "still", type: "media", label: "Still" };
    const items = fieldSettingItems(field, hooks(field).given);
    const showName = item(items, "Show name");
    showName.run?.(context, undefined);
    expect(field.showName).toBe(true);
    expect(showName.checked?.(context, undefined)).toBe(true);
    showName.run?.(context, undefined);
    expect(field).not.toHaveProperty("showName");
  });
});
