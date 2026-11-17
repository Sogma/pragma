import { describe, expect, it, vi } from "vitest";
import { type CommandContext, createCommands } from "../../../web/services/commands.ts";
import { createMenus } from "../../../web/services/menus.ts";

const context: CommandContext = { tab: { kind: "empty" }, pane: undefined };

function setup() {
  const commands = createCommands();
  commands.register({ id: "new", label: "New Note", run: vi.fn() });
  commands.register({ id: "rename", label: "Rename", run: vi.fn(), when: (_, arg: { node?: string }) => !!arg.node });
  commands.register({ id: "table", label: "New Table", run: vi.fn() });
  const menus = createMenus(commands);
  return { commands, menus };
}

describe("menus", () => {
  it("resolves items against the item's when, then the command's, with labels and args filled in", () => {
    const { menus } = setup();
    menus.register("tree", [
      { command: "new", group: "create" },
      { command: "rename", group: "danger", danger: true },
      { command: "missing" },
      { label: "Only for files", when: (_, arg: { file?: boolean }) => arg.file === true },
      {
        command: "new",
        label: (_, arg) => `New in ${(arg as { node?: string }).node ?? "root"}`,
        arg: { node: "docs" },
      },
    ]);

    const resolved = menus.resolve("tree", context, { node: "a.md" });
    expect(resolved.map((item) => item.label)).toEqual(["New Note", "Rename", "New in docs"]);
    expect(resolved[0]).toMatchObject({ command: "new", arg: { node: "a.md" }, group: "create", danger: false });
    expect(resolved[1]).toMatchObject({ command: "rename", group: "danger", danger: true, checked: undefined });
    expect(resolved[2]).toMatchObject({ command: "new", arg: { node: "docs" }, icon: false });
    expect(menus.resolve("tree", context, {}).map((item) => item.label)).toEqual(["New Note", "New in docs"]);
    expect(menus.resolve("tree", context, { file: true }).map((item) => item.label)).toEqual([
      "New Note",
      "Only for files",
      "New in docs",
    ]);
    expect(menus.resolve("nothing", context)).toEqual([]);
  });

  it("keeps an item whose command doesn't apply, disabled, when asked, and still leaves out an unregistered one", () => {
    const { menus } = setup();
    const items = [
      { command: "new" },
      { command: "rename" },
      { command: "missing" },
      { label: "New", submenu: [{ command: "rename", label: "Rename here" }] },
    ];
    const kept = menus.resolveItems(items, context, {}, { keepInapplicable: true });
    expect(kept.map((item) => [item.label, item.disabled])).toEqual([
      ["New Note", undefined],
      ["Rename", true],
      ["New", undefined],
    ]);
    expect(kept[2].submenu?.map((item) => [item.label, item.disabled])).toEqual([["Rename here", true]]);
    expect(menus.resolveItems(items, context, {}).map((item) => item.label)).toEqual(["New Note"]);
  });

  it("prunes a submenu with no resolvable children, and renders checked items", () => {
    const { menus } = setup();
    menus.register("tree", [
      { label: "New", submenu: [{ command: "table", label: "Table" }, { command: "rename" }] },
      { command: "new", checked: (_, arg: { on?: boolean }) => arg.on === true },
    ]);
    const [submenu, checked] = menus.resolve("tree", context, { on: true });
    expect(submenu.submenu?.map((item) => item.label)).toEqual(["Table"]);
    expect(checked.checked).toBe(true);

    menus.register("empty", [{ label: "Wrapper", submenu: [{ command: "rename" }] }]);
    expect(menus.resolve("empty", context, {})).toEqual([]);
  });

  it("an item with its own action resolves without a command, and resolveItems works on a bare list", () => {
    const { menus } = setup();
    const run = vi.fn();
    const items = menus.resolveItems(
      [
        { label: "Local", run, icon: true, detail: "d", data: { k: "v" }, style: { color: "red" } },
        { label: "Hidden", run, when: () => false },
      ],
      context,
      { node: "n" },
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      label: "Local",
      run,
      arg: { node: "n" },
      icon: true,
      detail: "d",
      data: { k: "v" },
    });
  });

  it("merges contributions in registration order, function contributions included, until disposed", () => {
    const { menus } = setup();
    menus.register("m", [{ command: "new" }]);
    const dynamic = menus.register("m", (_, arg) =>
      (arg as { names: string[] }).names.map((name) => ({ command: "table", label: name, arg: name })),
    );
    expect(menus.resolve("m", context, { names: ["x", "y"] }).map((item) => [item.label, item.arg])).toEqual([
      ["New Note", { names: ["x", "y"] }],
      ["x", "x"],
      ["y", "y"],
    ]);
    dynamic.dispose();
    expect(menus.resolve("m", context, { names: ["x"] })).toHaveLength(1);
  });

  it("lists every command a menu names, whatever applies now, each once and never one carrying its own arg", () => {
    const { menus } = setup();
    menus.register("m", [
      { command: "rename", label: "Rename File", when: () => false },
      { command: "new" },
      { command: "table", arg: { node: "docs" } },
      { label: "A heading" },
      { command: "missing" },
    ]);
    menus.register("m", (current) => [
      { command: "new", label: "New Note again" },
      { command: "table", label: () => `Table in ${current.tab.kind}` },
    ]);
    expect(menus.commandsIn("m", context)).toEqual([
      { command: "rename", label: "Rename File" },
      { command: "new", label: "New Note" },
      { command: "table", label: "Table in empty" },
    ]);
    expect(menus.commandsIn("nothing", context)).toEqual([]);
  });
});
