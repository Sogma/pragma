import { describe, expect, it, vi } from "vitest";
import type { TableColumn } from "../../../src/protocol/types.ts";
import type { CommandContext } from "../../../web/services/commands.ts";
import type { DialogService, PromptOptions } from "../../../web/services/dialog.ts";
import { type FieldSettingHooks, fieldSettingItems } from "../../../web/services/fieldSettings.ts";
import type { MenuItem } from "../../../web/services/menus.ts";

const context = {} as CommandContext;

// The pane's side: a change lands on the field as the file holds it, and a
// prompt answers `answer`.
function hooks(field: TableColumn, offersOptions = false, answer: string | null = null) {
  const prompt = vi.fn((_options: PromptOptions) => Promise.resolve(answer));
  const given: FieldSettingHooks = {
    change: (edit) => edit(field),
    dialog: { prompt } as unknown as DialogService,
    mediaFolder: vi.fn(),
    ...(offersOptions ? { options: vi.fn() } : {}),
  };
  return { given, prompt };
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
    expect(of("score")).toEqual(["Max…", "Can be rejected"]);
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

  it("lets a score be rejected, and asks for its max, leaving out the default", async () => {
    const field: TableColumn = { id: "r", type: "score", label: "Rating" };
    item(fieldSettingItems(field, hooks(field).given), "Can be rejected").run?.(context, undefined);
    expect(field.reject).toBe(true);
    const ten = hooks(field, false, "10");
    item(fieldSettingItems(field, ten.given), "Max…").run?.(context, undefined);
    const options = ten.prompt.mock.calls[0][0];
    expect(options.value).toBe("5");
    expect(options.validate?.("11")).toBe("Enter a whole number from 1 to 10.");
    expect(options.validate?.("7")).toBeUndefined();
    await vi.waitFor(() => expect(field.max).toBe(10));
    item(fieldSettingItems(field, hooks(field, false, "5").given), "Max…").run?.(context, undefined);
    await vi.waitFor(() => expect(field).not.toHaveProperty("max"));
  });
});
