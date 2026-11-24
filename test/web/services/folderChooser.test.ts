// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SpaceTreeNode } from "../../../src/protocol/api.ts";
import { createFolderField, openFolderChooser } from "../../../web/services/folderChooser.ts";

// The space's listing: its top folder's entries.
const listing = vi.hoisted(() => ({ top: [] as SpaceTreeNode[] }));

vi.mock("../../../web/core/spaceTree.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../web/core/spaceTree.ts")>()),
  findDirectoryChildren: (path: string) => (path === "" ? listing.top : undefined),
}));

const entry = (path: string, children?: SpaceTreeNode[]): SpaceTreeNode => ({
  name: path.split("/").at(-1) ?? path,
  path,
  type: children ? "directory" : "file",
  children,
});

afterEach(() => document.body.replaceChildren());

describe("the folder chooser over the whole space", () => {
  it("offers the space's top folders, open where the sidebar's tree is", () => {
    listing.top = [
      entry("presets", [entry("presets/LUT", []), entry("presets/templates", [])]),
      entry("README.md"),
      entry("projects", []),
    ];
    const anchor = document.createElement("button");
    document.body.append(anchor);
    const onPick = vi.fn();
    openFolderChooser({
      anchor,
      alignTo: anchor,
      within: "",
      label: "Add a folder to LUTs",
      isOpen: (folder) => folder === "presets",
      openFolder: () => undefined,
      onPick,
    });
    const rows = [...document.querySelectorAll<HTMLElement>(".folder-chooser .node-label")];
    expect(rows.map((row) => row.textContent)).toEqual(["presets", "LUT", "templates", "projects"]);
    expect(document.querySelector<HTMLInputElement>(".folder-chooser input")?.placeholder).toBe("Search folders");
    rows[1].click();
    expect(onPick).toHaveBeenCalledWith("presets/LUT");
  });
});

describe("the folder chooser over a library", () => {
  // The tree as the Presets section hands it over: the library's top, open,
  // over its folders, every path rooted.
  function openLibrary(onPick: (folder: string) => void) {
    const anchor = document.createElement("button");
    document.body.append(anchor);
    openFolderChooser({
      anchor,
      alignTo: anchor,
      within: "",
      folders: [
        entry("lib:film", [entry("lib:film/Print", [entry("lib:film/Print/2383", [])]), entry("lib:film/Bleach.cube")]),
      ],
      icon: (node) => (node.path === "lib:film" ? { glyph: "library" } : { glyph: "folder" }),
      label: "Add a folder to LUTs",
      isOpen: (folder) => folder === "lib:film",
      openFolder: () => undefined,
      onPick,
    });
    return [...document.querySelectorAll<HTMLElement>(".folder-chooser .node-label")];
  }

  it("lists the library's top first, with its glyph, over its folders", () => {
    const rows = openLibrary(() => undefined);
    expect(
      rows.map((row) => [row.dataset.path, row.querySelector<HTMLElement>(".node-icon")?.dataset.entryIcon]),
    ).toEqual([
      ["lib:film", "library"],
      ["lib:film/Print", "folder"],
    ]);
  });

  it("picks the whole library or one of its folders by its rooted path", () => {
    const onPick = vi.fn();
    openLibrary(onPick)[0].click();
    openLibrary(onPick)[1].click();
    expect(onPick.mock.calls).toEqual([["lib:film"], ["lib:film/Print"]]);
  });
});

describe("the folder chooser where no gallery opens", () => {
  it("draws no Open button on its rows", () => {
    listing.top = [entry("projects", [])];
    const anchor = document.createElement("button");
    document.body.append(anchor);
    openFolderChooser({ anchor, alignTo: anchor, within: "", label: "Choose", isOpen: () => false, onPick: vi.fn() });
    expect(document.querySelectorAll(".folder-chooser .node-label")).toHaveLength(1);
    expect(document.querySelector(".folder-chooser .node-open")).toBeNull();
  });
});

describe("a form's folder field", () => {
  // The space's top and a library, each a row over its folders.
  const roots = () =>
    Promise.resolve([
      { ...entry("", [entry("a", [entry("a/stills", [])]), entry("b", [])]), name: "Space" },
      entry("lib:renders", [entry("lib:renders/day1", [])]),
    ]);
  const rows = () => [...document.querySelectorAll<HTMLElement>(".folder-chooser .node-label")];
  const shown = (field: { element: HTMLElement }) =>
    field.element.querySelector<HTMLElement>(".path-label")?.dataset.path;

  function open(value: string) {
    const field = createFolderField({
      value,
      roots,
      rootIcon: (root) => ({ glyph: root.path === "" ? "space" : "library" }),
      label: "Choose a folder",
    });
    document.body.append(field.element);
    field.element.click();
    return field;
  }

  it("shows its folder, and opens the chooser on it with the first root open", async () => {
    const field = open("a/stills");
    expect(shown(field)).toBe("a/stills");
    expect(field.element.getAttribute("aria-expanded")).toBe("true");
    await vi.waitFor(() => expect(rows().length).toBeGreaterThan(0));
    expect(
      rows().map((row) => [row.dataset.path, row.querySelector<HTMLElement>(".node-icon")?.dataset.entryIcon]),
    ).toEqual([
      ["", "space"],
      ["a", "folder"],
      ["a/stills", "folder"],
      ["b", "folder"],
      ["lib:renders", "library"],
    ]);
    expect(document.querySelector(".folder-chooser .node-label.active")?.getAttribute("data-path")).toBe("a/stills");
    expect(document.querySelector(".folder-chooser .node-open")).toBeNull();
  });

  it("takes the folder picked, the space's top or a library's included", async () => {
    const field = open("a/stills");
    await vi.waitFor(() => expect(rows().length).toBeGreaterThan(0));
    rows()[0].click();
    expect([field.value(), shown(field), field.element.getAttribute("aria-expanded")]).toEqual(["", "", "false"]);
    expect(document.activeElement).toBe(field.element);
    field.element.click();
    await vi.waitFor(() => expect(rows().length).toBeGreaterThan(0));
    rows().at(-1)?.click();
    expect(field.value()).toBe("lib:renders");
  });

  it("opens again after its folders couldn't be read", async () => {
    const roots = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue([entry("", [])]);
    const field = createFolderField({ value: "", roots, rootIcon: () => ({ glyph: "space" }), label: "Choose" });
    document.body.append(field.element);
    field.element.click();
    await vi.waitFor(() => expect(field.element.getAttribute("aria-expanded")).toBe("false"));
    field.element.click();
    await vi.waitFor(() => expect(rows()).toHaveLength(1));
  });
});
