// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createLinksList } from "../../../web/view/linksList.ts";
import { memorySetting } from "../support/editorLayout.ts";

// jsdom lays nothing out, so there is nothing to scroll.
Element.prototype.scrollIntoView ??= () => {};

// Each group as its heading followed by its rows' names.
function groups(element: HTMLElement): string[][] {
  return [...element.querySelectorAll(".inspector-section")].map((section) => [
    section.querySelector(".inspector-section-title")?.textContent ?? "",
    ...[...section.querySelectorAll(".inspector-link-name")].map((name) => name.textContent ?? ""),
  ]);
}

function setup(oneList = memorySetting(false)) {
  const deps = {
    open: vi.fn(),
    showMenu: vi.fn(),
    showLinkingMenu: vi.fn(),
    openMention: vi.fn(),
    describe: vi.fn(async (_path: string) => undefined as string | undefined),
    treeOrder: vi.fn((paths: readonly string[]) => [...paths]),
    oneList,
  };
  return { list: createLinksList(deps), deps };
}

describe("the Links tab's list", () => {
  it("groups files under their folder, the groups by name and the files by the tree's order", () => {
    const { list, deps } = setup();
    const tree = [
      "world/characters/The Thing.md",
      "world/characters/Lina.md",
      "world/locations/Vostok Station.md",
      "world/props/Box.table.html",
    ];
    deps.treeOrder.mockImplementation((paths) => [...paths].sort((a, b) => tree.indexOf(a) - tree.indexOf(b)));
    list.render({
      found: [
        { path: "world/props/Box.table.html", count: 1, mentions: [] },
        { path: "world/characters/Lina.md", count: 4, mentions: [] },
        { path: "world/locations/Vostok Station.md", count: 1, mentions: [] },
        { path: "world/characters/The Thing.md", count: 2, mentions: [] },
      ],
      missing: [],
    });
    expect(groups(list.element)).toEqual([
      ["characters", "The Thing", "Lina"],
      ["locations", "Vostok Station"],
      ["props", "Box"],
    ]);
    const counts = [...list.element.querySelectorAll(".inspector-link-count")].map((count) => count.textContent);
    expect(counts).toEqual(["2", "4", "1", "1"]);
  });

  it("tells same-named folders apart by their path, names the space root, and puts missing targets last, by name", () => {
    const { list } = setup();
    list.render({
      found: [
        { path: "projects/b/notes/y.md", mentions: [] },
        { path: "top.md", mentions: [] },
        { path: "projects/a/notes/x.md", mentions: [] },
      ],
      missing: ["Ghost", "apparition"],
    });
    expect(groups(list.element)).toEqual([
      ["a/notes", "x"],
      ["b/notes", "y"],
      ["Space", "top"],
      ["Not found", "apparition", "Ghost"],
    ]);
  });

  it("opens a row on click and offers its menu on right-click", () => {
    const { list, deps } = setup();
    list.render({ found: [{ path: "world/Lina.md", mentions: [] }], missing: [] });
    const row = list.element.querySelector<HTMLElement>("button.inspector-link");
    row?.click();
    expect(deps.open).toHaveBeenCalledWith("world/Lina.md", { anchor: expect.any(HTMLElement) });
    row?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 3, clientY: 4 }));
    expect(deps.showMenu).toHaveBeenCalledWith("world/Lina.md", { x: 3, y: 4 });
  });

  it("lists what a Class links its rows to after the note's own links, under the Class, even with none of its own", () => {
    const { list, deps } = setup();
    const lyrics = {
      classPath: "songs/tools/lyrics.class.html",
      name: "Lyrics",
      paths: ["songs/voice.md", "songs/rhymes.table.html"],
    };
    list.render({ found: [{ path: "songs/chico/lyrics/moon.md", mentions: [] }], missing: [] }, [lyrics]);
    expect(groups(list.element)).toEqual([
      ["lyrics", "moon"],
      ["From the Lyrics Class", "voice", "rhymes"],
    ]);

    list.render({ found: [], missing: [] }, [lyrics]);
    expect(list.element.hasAttribute("data-empty")).toBe(false);
    expect(groups(list.element)).toEqual([["From the Lyrics Class", "voice", "rhymes"]]);
    (list.element.querySelector(".inspector-link") as HTMLElement).click();
    expect(deps.open).toHaveBeenCalledWith("songs/voice.md", expect.anything());
  });

  it("says so when there is nothing to list, and marks itself empty until there is", () => {
    const { list } = setup();
    list.render({ found: [], missing: [] });
    expect(list.element.textContent).toBe("No links in this file.");
    expect(list.element.hasAttribute("data-empty")).toBe(true);
    list.render({ found: [], missing: ["Ghost"] });
    expect(list.element.hasAttribute("data-empty")).toBe(false);
  });

  it("lists a link whose root's listing is still to land nowhere, yet never says the file has no links", () => {
    const { list } = setup();
    list.render({ found: [{ path: "notes/a.md", mentions: [] }], missing: [], pending: ["lib:footage/cover"] });
    expect(groups(list.element)).toEqual([["notes", "a"]]);
    list.render({ found: [], missing: [], pending: ["cover"] });
    expect(list.element.textContent).toBe("");
    expect(list.element.hasAttribute("data-empty")).toBe(false);
  });

  it("opens a row's description on its chevron, keeps it open across redraws, and reads it again when told to", async () => {
    const { list, deps } = setup();
    deps.describe.mockImplementation(async (path: string) =>
      path === "world/Lina.md" ? "The investigator." : undefined,
    );
    const links = {
      found: [
        { path: "world/Lina.md", mentions: [] },
        { path: "world/Box.md", mentions: [] },
      ],
      missing: [],
    };
    list.render(links);
    const description = (name: string) =>
      [...list.element.querySelectorAll<HTMLElement>(".inspector-link-item")]
        .find((item) => item.querySelector(".inspector-link-name")?.textContent === name)
        ?.querySelector<HTMLElement>(".inspector-link-description");
    const toggle = (name: string) =>
      description(name)?.parentElement?.querySelector<HTMLElement>(".inspector-link-toggle");

    // An icon button, so its name shows as its tooltip (web/lib/tooltip.ts).
    expect(toggle("Lina")?.matches(".icon-button[aria-label='Description']")).toBe(true);
    expect(description("Lina")?.hidden).toBe(true);
    expect(deps.describe).not.toHaveBeenCalled();

    toggle("Lina")?.click();
    toggle("Box")?.click();
    await vi.waitFor(() => expect(description("Lina")?.textContent).toBe("The investigator."));
    expect(description("Box")?.textContent).toBe("No description.");
    expect(toggle("Lina")?.getAttribute("aria-expanded")).toBe("true");

    list.render(links);
    await vi.waitFor(() => expect(description("Lina")?.textContent).toBe("The investigator."));
    expect(description("Lina")?.hidden).toBe(false);
    expect(deps.describe).toHaveBeenCalledTimes(2);

    list.forgetDescriptions();
    list.render(links);
    await vi.waitFor(() => expect(deps.describe).toHaveBeenCalledTimes(4));

    toggle("Lina")?.click();
    expect(description("Lina")?.hidden).toBe(true);
  });

  it("gives a missing target no chevron", () => {
    const { list } = setup();
    list.render({ found: [], missing: ["Ghost"] });
    expect(list.element.querySelector(".inspector-link-toggle")).toBeNull();
  });

  it("reveals a row: opens it to its description, scrolls it into view and flashes it", async () => {
    const { list, deps } = setup();
    deps.describe.mockImplementation(async () => "The investigator.");
    list.render({
      found: [
        { path: "world/Box.md", mentions: [] },
        { path: "world/Lina.md", mentions: [] },
      ],
      missing: [],
    });
    const scrolled = vi.spyOn(Element.prototype, "scrollIntoView");

    list.reveal("world/Lina.md");

    const item = list.element.querySelector<HTMLElement>('.inspector-link-item[data-path="world/Lina.md"]');
    expect(item?.querySelector(".inspector-link-toggle")?.getAttribute("aria-expanded")).toBe("true");
    expect(scrolled.mock.contexts.at(-1)).toBe(item);
    expect(item?.querySelector(".inspector-link")?.classList.contains("flash")).toBe(true);
    await vi.waitFor(() =>
      expect(item?.querySelector(".inspector-link-description")?.textContent).toBe("The investigator."),
    );
    scrolled.mockRestore();
  });
});

describe("Backlinks", () => {
  const plan = "See [[plan]] and [[Plan]].";
  const backlinks = [
    {
      path: "drafts/a.md",
      mentions: [
        { line: 3, text: plan, at: 6, length: 4 },
        { line: 3, text: plan, at: 19, length: 4 },
        { line: 7, text: "Then [[plan]] again.", at: 7, length: 4 },
      ],
    },
    { path: "b.md", mentions: [{ line: 1, text: "[[plan]]", at: 2, length: 4 }] },
  ];

  it("lists the notes linking here after the links, under Backlinks and their folder", () => {
    const { list } = setup();
    list.render({ found: [{ path: "notes/x.md", mentions: [] }], missing: [] }, [], backlinks);
    expect(groups(list.element)).toEqual([
      ["notes", "x"],
      ["Backlinks from drafts", "a"],
      ["Backlinks from Space", "b"],
    ]);
  });

  it("shows a note's lines on its chevron, each once with its mentions marked, and opens one at its first", () => {
    const { list, deps } = setup();
    list.render({ found: [], missing: [] }, [], backlinks);
    const item = list.element.querySelector(".inspector-link-item");
    const lines = item?.querySelector<HTMLElement>(".inspector-link-mentions");
    const toggle = item?.querySelector<HTMLElement>(".inspector-link-toggle");
    expect(toggle?.matches(".icon-button[aria-label='Mentions']")).toBe(true);
    expect(lines?.hidden).toBe(true);
    toggle?.click();
    expect(lines?.hidden).toBe(false);
    const buttons = [...(lines?.querySelectorAll<HTMLElement>(".inspector-link-mention") ?? [])];
    expect(buttons.map((button) => button.textContent)).toEqual([plan, "Then [[plan]] again."]);
    expect(buttons.map((button) => button.dataset.tooltip)).toEqual(["Line 3", "Line 7"]);
    expect([...buttons[0].querySelectorAll("mark")].map((mark) => mark.textContent)).toEqual(["plan", "Plan"]);
    buttons[0].click();
    expect(deps.openMention).toHaveBeenCalledWith("drafts/a.md", backlinks[0].mentions[0]);
  });

  it("opens a linking note on click, and offers its own menu on right-click", () => {
    const { list, deps } = setup();
    list.render({ found: [], missing: [] }, [], backlinks);
    const row = list.element.querySelector<HTMLElement>(".inspector-link");
    row?.click();
    expect(deps.open).toHaveBeenCalledWith("drafts/a.md", expect.objectContaining({ anchor: row }));
    row?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 4, clientY: 8 }));
    expect(deps.showLinkingMenu).toHaveBeenCalledWith("drafts/a.md", { x: 4, y: 8 });
    expect(deps.showMenu).not.toHaveBeenCalled();
  });

  it("keeps the tab lit for a file with no links of its own but some linking to it", () => {
    const { list } = setup();
    list.render({ found: [], missing: [] }, [], backlinks);
    expect(list.element.querySelector(".inspector-empty")?.textContent).toBe("No links in this file.");
    expect(list.element.hasAttribute("data-empty")).toBe(false);
    list.render({ found: [], missing: [] }, [], []);
    expect(list.element.hasAttribute("data-empty")).toBe(true);
  });

  it("starts a long line a little before its first mention", () => {
    const { list } = setup();
    const text = `${"x".repeat(100)} [[plan]]`;
    list.render({ found: [], missing: [] }, [], [{ path: "c.md", mentions: [{ line: 1, text, at: 103, length: 4 }] }]);
    const snippet = list.element.querySelector(".inspector-link-mention")?.textContent ?? "";
    expect(snippet.startsWith("…")).toBe(true);
    expect(snippet.endsWith("[[plan]]")).toBe(true);
    expect(snippet.length).toBeLessThan(text.length);
  });
});

describe("one list", () => {
  const lyrics = {
    classPath: "songs/tools/lyrics.class.html",
    name: "Lyrics",
    paths: ["songs/voice.md", "songs/rhymes.table.html"],
  };
  const backlinks = [
    { path: "drafts/b.md", mentions: [{ line: 1, text: "[[plan]]", at: 2, length: 4 }] },
    { path: "A.md", mentions: [] },
  ];
  const titles = (element: HTMLElement) => groups(element).map(([title]) => title);

  it("lists each side A–Z under Links to and Backlinks, missing targets and a Class's files as grouped", () => {
    const { list } = setup(memorySetting(true));
    list.render(
      {
        found: [
          { path: "world/characters/Lina.md", count: 4, mentions: [] },
          { path: "notes/box.md", count: 1, mentions: [] },
          { path: "Atlas.md", count: 2, mentions: [] },
        ],
        missing: ["Ghost"],
      },
      [lyrics],
      backlinks,
    );
    expect(groups(list.element)).toEqual([
      ["Links to", "Atlas", "box", "Lina"],
      ["Not found", "Ghost"],
      ["From the Lyrics Class", "voice", "rhymes"],
      ["Backlinks", "A", "b"],
    ]);
    const counts = [...list.element.querySelectorAll(".inspector-link-count")].map((count) => count.textContent);
    expect(counts).toEqual(["2", "1", "4"]);
  });

  it("names a row's folder only where a row from another folder in the same list shares its name", () => {
    const oneList = memorySetting(true);
    const { list } = setup(oneList);
    const links = {
      found: [
        { path: "notes/README.md", mentions: [] },
        { path: "readme.md", mentions: [] },
        { path: "projects/a/notes/Plan.md", mentions: [] },
        { path: "projects/b/notes/Plan.md", mentions: [] },
        { path: "notes/Lina.md", mentions: [] },
        { path: "notes/Lina.table.html", mentions: [] },
      ],
      missing: [],
    };
    list.render(links, [], [{ path: "Lina.md", mentions: [] }]);
    const rows = [...list.element.querySelectorAll(".inspector-link-item")].map((item) => [
      item.querySelector(".inspector-link-name")?.textContent,
      item.querySelector(".inspector-link-folder")?.textContent,
    ]);
    expect(rows).toEqual([
      ["Lina", undefined],
      ["Lina", undefined],
      ["Plan", "a/notes"],
      ["Plan", "b/notes"],
      ["README", "notes"],
      ["readme", "Space"],
      ["Lina", undefined],
    ]);

    oneList.set(false);
    expect(list.element.querySelector(".inspector-link-folder")).toBeNull();
  });

  it("puts one switch on the first heading, named for what a click does, and every list follows a click", () => {
    const oneList = memorySetting(false);
    const { list } = setup(oneList);
    const { list: other } = setup(oneList);
    document.body.append(list.element);
    const links = { found: [{ path: "world/Lina.md", mentions: [] }], missing: ["Ghost"] };
    list.render(links, [], backlinks);
    other.render(links, [], backlinks);
    const toggles = () => [...list.element.querySelectorAll<HTMLElement>(".inspector-links-grouping")];
    expect(toggles()).toHaveLength(1);
    expect(toggles()[0].closest(".inspector-section")).toBe(list.element.querySelector(".inspector-section"));
    expect(toggles()[0].getAttribute("aria-label")).toBe("Show as one list");

    toggles()[0].focus();
    toggles()[0].click();
    expect(oneList.get()).toBe(true);
    expect(titles(list.element)).toEqual(["Links to", "Not found", "Backlinks"]);
    expect(titles(other.element)).toEqual(["Links to", "Not found", "Backlinks"]);
    expect(toggles()).toHaveLength(1);
    expect(toggles()[0].getAttribute("aria-label")).toBe("Group by folder");
    expect(document.activeElement).toBe(toggles()[0]);

    toggles()[0].click();
    expect(titles(list.element)).toEqual(["world", "Not found", "Backlinks from drafts", "Backlinks from Space"]);
    list.element.remove();
  });

  it("offers no switch where the form changes nothing", () => {
    const { list } = setup();
    list.render({ found: [], missing: ["Ghost"] }, [lyrics]);
    expect(list.element.querySelector(".inspector-links-grouping")).toBeNull();
  });

  it("keeps an open row open across a switch, and stops following once disposed", () => {
    const oneList = memorySetting(false);
    const { list } = setup(oneList);
    list.render({ found: [], missing: [] }, [], backlinks);
    const chevron = () =>
      [...list.element.querySelectorAll(".inspector-link-item")]
        .find((item) => item.querySelector(".inspector-link-name")?.textContent === "b")
        ?.querySelector<HTMLElement>(".inspector-link-toggle");
    chevron()?.click();
    oneList.set(true);
    expect(chevron()?.getAttribute("aria-expanded")).toBe("true");

    list.dispose();
    oneList.set(false);
    expect(titles(list.element)).toEqual(["Backlinks"]);
  });
});
