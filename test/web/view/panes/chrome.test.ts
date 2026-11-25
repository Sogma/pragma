// @vitest-environment jsdom
// Pins what each pane asks of the chrome around the host — the floating
// toolbar, its reading-view toggle, the status bar, the overflow actions —
// since that is the contract main.ts applies on every tab switch.
import { describe, expect, it, vi } from "vitest";
import { type CommandContext, createCommands } from "../../../../web/services/commands.ts";
import type { PaneChrome } from "../../../../web/services/editorPanes.ts";
import { createMenus } from "../../../../web/services/menus.ts";
import { appletPane } from "../../../../web/view/panes/appletPane.ts";
import { classPane } from "../../../../web/view/panes/classPane.ts";
import { appletSourcePane, documentPane } from "../../../../web/view/panes/documentPane.ts";
import { createEmptyPane, EMPTY_TAB_MENU, emptyPane } from "../../../../web/view/panes/emptyPane.ts";
import { findContextPane } from "../../../../web/view/panes/findContextPane.ts";
import { flowPane } from "../../../../web/view/panes/flowPane.ts";
import { imagePane, videoPane } from "../../../../web/view/panes/mediaPane.ts";
import { pdfPane } from "../../../../web/view/panes/pdfPane.ts";
import { tablePane } from "../../../../web/view/panes/tablePane.ts";

// The descriptors only carry deps into create(), which no test here calls.
const deps = new Proxy({}, { get: () => vi.fn() }) as never;

const full: PaneChrome = { toolbar: true, readingView: true, statusbar: true, actions: [] };
const none: PaneChrome = { toolbar: false, readingView: false, statusbar: false, actions: [] };

describe("pane chrome declarations", () => {
  it.each([
    ["document", documentPane(deps), { ...full, actions: ["add-property"] }],
    ["applet-source", appletSourcePane(deps), { ...full, readingView: false }],
    ["table", tablePane(deps), { ...full, actions: ["data-design"] }],
    ["class", classPane({ menus: { register: vi.fn() } } as never), { ...full, actions: ["data-design"] }],
    [
      "flow",
      flowPane(deps),
      { ...full, readingView: false, actions: ["flow-run", "flow-app-mode", "flow-rename", "flow-permissions"] },
    ],
    ["image", imagePane(deps), { ...none, statusbar: true }],
    ["video", videoPane(deps), { ...none, statusbar: true }],
    ["pdf", pdfPane(deps, deps), { ...full, readingView: false }],
    ["applet", appletPane(deps), { ...full, readingView: false, actions: [] }],
    ["find-context", findContextPane(deps), { ...none, statusbar: true }],
    ["empty", emptyPane(deps), none],
  ] as const)("%s", (kind, descriptor, chrome) => {
    expect(descriptor.kind).toBe(kind);
    expect(descriptor.chrome).toEqual(chrome);
  });
});

describe("emptyPane", () => {
  it("shows its menu's items as buttons that run their commands, and refuses any other tab", async () => {
    const commands = createCommands();
    const menus = createMenus(commands);
    const ran: { context: CommandContext; arg: unknown }[] = [];
    commands.register({ id: "make", label: "New Thing", run: (context, arg) => void ran.push({ context, arg }) });
    commands.register({ id: "never", label: "Hidden", when: () => false, run: vi.fn() });
    menus.register(EMPTY_TAB_MENU, [
      { command: "make", arg: { at: "top" }, entryIcon: { glyph: "table" } },
      { command: "never" },
    ]);
    const pane = createEmptyPane({ menus, commands });
    await pane.setInput({ kind: "empty" }, { isCurrent: () => true });
    expect(pane.element.classList.contains("editor-empty")).toBe(true);

    const buttons = [...pane.element.querySelectorAll<HTMLButtonElement>(".editor-empty-action")];
    expect(buttons.map((button) => button.textContent)).toEqual(["New Thing"]);
    expect(buttons[0].querySelector("[data-entry-icon]")?.getAttribute("data-entry-icon")).toBe("table");
    buttons[0].click();
    expect(ran).toEqual([{ context: { tab: { kind: "empty" }, pane }, arg: { at: "top" } }]);

    expect(pane.title()).toBeUndefined();
    await expect(pane.setInput({ kind: "image", path: "a.png" }, { isCurrent: () => true })).rejects.toThrow(
      /can't show/,
    );
  });
});
