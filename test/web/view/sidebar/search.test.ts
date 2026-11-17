// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SpaceSearchResponse } from "../../../../web/core/apiClient.ts";
import { type CommandContext, createCommands } from "../../../../web/services/commands.ts";
import type { EditorPane } from "../../../../web/services/editorPanes.ts";
import { createKeybindings } from "../../../../web/services/keybindings.ts";
import { COMMAND_PALETTE, createMenus } from "../../../../web/services/menus.ts";
import type { OpenOptions } from "../../../../web/services/tabs.ts";
import { createSearchView, highlightedSnippet } from "../../../../web/view/sidebar/search.ts";

const context: CommandContext = { tab: { kind: "empty" }, pane: undefined };
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const RESPONSE: SpaceSearchResponse = {
  files: [
    { path: "notes/draft.md", matches: [{ line: 3, text: "the fox jumps" }] },
    {
      path: "cast.table.html",
      matches: [
        { label: "Name", text: "Fox" },
        { label: "Notes", text: "fox again" },
      ],
    },
    { path: "tools/picker.applet.html", matches: [{ line: 7, text: "const fox = 1;" }] },
  ],
  truncated: false,
};

const detachers: (() => void)[] = [];
beforeEach(() => {
  document.body.replaceChildren();
});
afterEach(() => {
  for (const detach of detachers.splice(0)) detach();
  vi.useRealTimers();
});

function setup(response: SpaceSearchResponse = RESPONSE) {
  const commands = createCommands();
  const keybindings = createKeybindings(commands, { mac: false });
  const listener = keybindings.attach(document, () => context);
  detachers.push(() => listener.dispose());
  const menus = createMenus(commands);
  const search = vi.fn(async (_query: string, _dir: string | undefined) => response);
  const revealLine = vi.fn();
  let activePath: string | undefined;
  const openPath = vi.fn(async (path: string, _options?: OpenOptions) => {
    activePath = path;
  });
  const show = vi.fn(() => view.onShow?.());
  const view = createSearchView({
    commands,
    menus,
    keybindings,
    search,
    show,
    tabs: () => ({ openSpacePath: openPath, activePath: () => activePath }),
    activePane: () => ({ revealLine }) as unknown as EditorPane,
  });
  document.body.append(view.panel);
  view.panel.hidden = false;
  const input = view.panel.querySelector<HTMLInputElement>(".search-input") as HTMLInputElement;
  const type = async (text: string) => {
    input.value = text;
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    await flush();
  };
  return { view, commands, menus, search, show, openPath, revealLine, input, type };
}

const q = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)];

describe("search view", () => {
  it("registers as a view with nothing searched yet", () => {
    const { view } = setup();
    expect(view.id).toBe("search");
    expect(q(".sidebar-panel-empty")[0].hidden).toBe(false);
    expect(q(".search-results")[0].hidden).toBe(true);
  });

  it("searches after typing stops, not per keystroke", async () => {
    vi.useFakeTimers();
    const { input, search } = setup();
    for (const text of ["f", "fo", "fox"]) {
      input.value = text;
      input.dispatchEvent(new Event("input"));
    }
    expect(search).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(250);
    expect(search).toHaveBeenCalledTimes(1);
    expect(search).toHaveBeenCalledWith("fox", undefined);
  });

  it("groups results by file with kind and count, labels a value match, and marks every match", async () => {
    const { type } = setup();
    await type("fox");
    expect(q(".search-summary")[0].textContent).toBe("4 results");
    expect(q(".search-file-icon").map((icon) => icon.dataset.entryIcon)).toEqual(["markdown", "table", "applet"]);
    expect(q(".search-file-name").map((n) => n.textContent)).toEqual(["draft", "cast", "picker"]);
    expect(q(".search-file-folder")).toEqual([]);
    expect(q(".search-file-count").map((n) => n.textContent)).toEqual(["1", "2", "1"]);
    expect(q(".search-match-label").map((n) => n.textContent)).toEqual(["Name", "Notes"]);
    expect(q(".search-match mark").map((n) => n.textContent)).toEqual(["fox", "Fox", "fox", "fox"]);
  });

  it("names the folder only for results that share a displayed name", async () => {
    const { type } = setup({
      files: [
        { path: "a/cast.md", matches: [{ line: 1, text: "fox" }] },
        { path: "b/cast.table.html", matches: [{ label: "Name", text: "fox" }] },
        { path: "c/other.md", matches: [{ line: 1, text: "fox" }] },
      ],
      truncated: false,
    });
    await type("fox");
    expect(q(".search-file-header").map((header) => header.querySelector(".search-file-folder")?.textContent)).toEqual([
      "a",
      "b",
      undefined,
    ]);
  });

  it("folds a file's matches from its header", async () => {
    const { type } = setup();
    await type("fox");
    const header = q(".search-file-header")[0];
    header.click();
    expect(q(".search-file")[0].classList.contains("folded")).toBe(true);
    expect(header.getAttribute("aria-expanded")).toBe("false");
  });

  it("opens a line match and reveals its line with the query selected", async () => {
    const { type, openPath, revealLine } = setup();
    await type("fox");
    q(".search-match")[0].click();
    await flush();
    expect(openPath).toHaveBeenCalledWith("notes/draft.md", { view: "code" });
    expect(revealLine).toHaveBeenCalledWith(3, "fox");
  });

  it("opens a value match as a tree click does, with no line to reveal", async () => {
    const { type, openPath, revealLine } = setup();
    await type("fox");
    q(".search-match")[2].click();
    await flush();
    expect(openPath).toHaveBeenCalledWith("cast.table.html");
    expect(revealLine).not.toHaveBeenCalled();
  });

  it("opens an Applet's line match in Edit code, where its source is visible", async () => {
    const { type, openPath, revealLine } = setup();
    await type("fox");
    q(".search-match")[3].click();
    await flush();
    expect(openPath).toHaveBeenCalledWith("tools/picker.applet.html", { view: "code" });
    expect(revealLine).toHaveBeenCalledWith(7, "fox");
  });

  it("reports a capped scan and an empty one", async () => {
    const capped = setup({ ...RESPONSE, truncated: true });
    await capped.type("fox");
    expect(q(".search-summary")[0].textContent).toBe("The first 4 results. Narrow the search for the rest.");
    document.body.replaceChildren();
    const none = setup({ files: [], truncated: false });
    await none.type("zzz");
    expect(q(".search-summary")[0].textContent).toBe("No results.");
  });

  it("Search in Folder scopes to a folder until cleared", async () => {
    const { commands, search, show, type } = setup();
    expect(commands.isEnabled("search.inFolder", context, { node: { type: "file", path: "a.md", name: "a.md" } })).toBe(
      false,
    );
    await commands.run("search.inFolder", context, { node: { type: "directory", path: "notes", name: "notes" } });
    expect(show).toHaveBeenCalled();
    expect(q(".search-scope")[0].hidden).toBe(false);
    expect(q(".search-scope-label")[0].textContent).toBe("In notes");
    await type("fox");
    expect(search).toHaveBeenLastCalledWith("fox", "notes");
    q(".search-scope-clear")[0].click();
    await flush();
    expect(search).toHaveBeenLastCalledWith("fox", undefined);
    expect(q(".search-scope")[0].hidden).toBe(true);
  });

  it("Search for Tag searches the whole space for a tag, marking it as a note writes it", async () => {
    const { commands, search, show, input, type, revealLine } = setup({
      files: [{ path: "notes/draft.md", matches: [{ line: 3, text: "the #fox jumps" }] }],
      truncated: false,
    });
    await commands.run("search.inFolder", context, { node: { type: "directory", path: "notes", name: "notes" } });
    expect(commands.isEnabled("search.forTag", context, undefined)).toBe(false);
    await commands.run("search.forTag", context, { tag: "fox" });
    await flush();
    expect(show).toHaveBeenCalled();
    expect(input.value).toBe("tag:fox");
    expect(search).toHaveBeenLastCalledWith("tag:fox", undefined);
    expect(q(".search-match mark").map((mark) => mark.textContent)).toEqual(["#fox"]);
    q(".search-match")[0].click();
    await flush();
    expect(revealLine).toHaveBeenCalledWith(3, "#fox");
    // With text beside the tag, the text is what a result marks.
    await type("tag:fox jumps");
    expect(q(".search-match mark").map((mark) => mark.textContent)).toEqual(["jumps"]);
  });

  it("Mod+Shift+F shows the view and focuses the box; the palette lists it", () => {
    const { show, input, menus } = setup();
    document.body.dispatchEvent(
      new KeyboardEvent("keydown", { key: "F", ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }),
    );
    expect(show).toHaveBeenCalled();
    expect(document.activeElement).toBe(input);
    expect(menus.resolve(COMMAND_PALETTE, context).map((item) => item.label)).toEqual(["Search This Space"]);
  });
});

describe("highlightedSnippet", () => {
  it("starts a long line shortly before its first match", () => {
    const holder = document.createElement("div");
    holder.replaceChildren(highlightedSnippet(`${"x".repeat(100)} needle y`, "NEEDLE"));
    expect(holder.innerHTML).toBe(`…${"x".repeat(59)} <mark class="match-mark">needle</mark> y`);
  });
});
