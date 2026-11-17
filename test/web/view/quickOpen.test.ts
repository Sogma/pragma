// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Tab } from "../../../web/core/apiClient.ts";
import { type CommandContext, createCommands } from "../../../web/services/commands.ts";
import { createKeybindings } from "../../../web/services/keybindings.ts";
import { COMMAND_PALETTE, createMenus } from "../../../web/services/menus.ts";
import { createContextMenu } from "../../../web/view/contextMenu.ts";
import { createQuickOpen } from "../../../web/view/quickOpen.ts";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

let detach: (() => void) | undefined;

beforeEach(() => {
  document.body.replaceChildren();
});

afterEach(() => {
  detach?.();
});

function setup(options: { tab?: Tab; recent?: string[] } = {}) {
  const context: CommandContext = { tab: options.tab ?? { kind: "empty" }, pane: undefined };
  const commands = createCommands();
  const keybindings = createKeybindings(commands, { mac: false });
  const listener = keybindings.attach(document, () => context);
  detach = () => listener.dispose();
  const menus = createMenus(commands);
  const contextMenu = createContextMenu({ commands, menus, keybindings, context: () => context });
  const opened: string[] = [];
  const ran: string[] = [];
  commands.register({ id: "flow.rename", label: "Rename", run: () => void ran.push("rename") });
  commands.register({ id: "tree.delete", label: "Delete", run: () => void ran.push("delete") });
  menus.register(COMMAND_PALETTE, [{ command: "flow.rename", label: "Flow: Rename" }]);
  keybindings.register({ key: "Mod+R", command: "flow.rename" });
  createQuickOpen({
    commands,
    menus,
    keybindings,
    contextMenu,
    context: () => context,
    files: () => ["notes/draft.md", "cast.table.html", "songs/verse.md"],
    recentPaths: () => options.recent ?? [],
    openPath: (path) => void opened.push(path),
  });
  return { opened, ran };
}

function press(init: KeyboardEventInit & { key: string }, target: EventTarget = document.body) {
  target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
}

const menu = () => document.querySelector<HTMLElement>(".context-menu.quick-open");
const input = () => menu()?.querySelector<HTMLInputElement>(".context-menu-search") as HTMLInputElement;
const type = (text: string) => {
  input().value = text;
  input().dispatchEvent(new Event("input"));
};
const rows = (list: string) => [...(menu()?.querySelectorAll<HTMLElement>(`${list} > *`) ?? [])];
// A row's own text, without its folder or shortcut.
const labels = (list: string) =>
  rows(list).map((row) =>
    [...row.childNodes]
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.textContent)
      .join(""),
  );

describe("quick open", () => {
  it("opens on Ctrl+P with recent files, skipping the open one and any that have gone", () => {
    setup({
      tab: { kind: "document", path: "notes/draft.md", documentType: "note" },
      recent: ["notes/draft.md", "gone.md", "cast.table.html"],
    });
    press({ key: "p", ctrlKey: true });
    expect(document.activeElement).toBe(input());
    expect(input().value).toBe("");
    expect(labels(".context-menu-items")).toEqual(["cast"]);
  });

  it("says what to type when there is nothing recent", () => {
    setup();
    press({ key: "p", ctrlKey: true });
    expect(rows(".context-menu-items")[0].textContent).toBe("Type a file name, or > for commands");
  });

  it("ranks files as the query changes, each row naming its kind and folder, and Enter opens one", async () => {
    const { opened } = setup();
    press({ key: "p", ctrlKey: true });
    type("vers");
    const glyph = (row: HTMLElement) => row.querySelector<HTMLElement>(".context-menu-icon")?.dataset.entryIcon;
    const [row] = rows(".context-menu-results");
    expect(glyph(row)).toBe("markdown");
    expect(row.textContent).toBe("versesongs");
    type("cast");
    expect(glyph(rows(".context-menu-results")[0])).toBe("table");
    press({ key: "Enter" }, input());
    await tick();
    expect(opened).toEqual(["cast.table.html"]);
    expect(menu()).toBeNull();
  });

  it("reports no match rather than an empty box", () => {
    setup();
    press({ key: "p", ctrlKey: true });
    type("zzz");
    expect(rows(".context-menu-results")[0].textContent).toBe("No matching files");
  });

  it("lists only palette-contributed commands under >, with their shortcuts, on Ctrl+Shift+P and F1", async () => {
    const { ran } = setup();
    press({ key: "P", ctrlKey: true, shiftKey: true });
    expect(input().value).toBe(">");
    expect(rows(".context-menu-results").map((row) => row.textContent)).toEqual([
      "Flow: RenameCtrl + R",
      "Go to File…Ctrl + P",
      "Show All CommandsF1",
    ]);
    press({ key: "Escape" }, input());
    press({ key: "F1" });
    type("> ren");
    expect(rows(".context-menu-results").map((row) => row.textContent)).toEqual(["Flow: RenameCtrl + R"]);
    press({ key: "Enter" }, input());
    await tick();
    expect(ran).toEqual(["rename"]);
    press({ key: "F1" });
    type(">delete");
    expect(rows(".context-menu-results")[0].textContent).toBe("No matching commands");
  });
});
