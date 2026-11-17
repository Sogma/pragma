// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { WORLD_SETTING } from "../../../src/protocol/scopeSettings.ts";
import { contextSettingsCard, contextSettingsGroups } from "../../../web/services/contextSettings.ts";
import type { ScopeSettingWords } from "../../../web/services/formats.ts";

// Each scope's block by its folder, the screenplays the space holds, and its
// folders.
const space = vi.hoisted(() => ({
  blocks: {} as Record<string, unknown>,
  screenplays: [] as string[],
  folders: new Set<string>(),
}));

vi.mock("../../../web/core/spaceTree.ts", () => ({
  scopeBlock: (folder: string) => space.blocks[folder],
  holdsDocumentType: (folder: string, type: string) =>
    type === "screenplay" && space.screenplays.some((file) => file.startsWith(`${folder}/`)),
  findDirectoryNode: (path: string) =>
    space.folders.has(path) ? { name: path.slice(path.lastIndexOf("/") + 1), path, type: "directory" } : undefined,
  pathNames: { libraryName: () => undefined, icon: () => ({ glyph: "folder" }) },
}));

const SCREENPLAY: ScopeSettingWords = {
  title: "Screenplay",
  keys: { world: { label: "World", description: "Names in a screenplay link to the notes in this folder." } },
};
const words = (kind: string) => (kind === "screenplay" ? SCREENPLAY : undefined);

function seed(blocks: Record<string, unknown>, screenplays: string[] = ["film/story/scene.fountain"]): void {
  space.blocks = blocks;
  space.screenplays = screenplays;
  space.folders = new Set(["film/story", "film/story/world", "film/notes"]);
}

const texts = (root: Element | undefined, selector: string) =>
  [...(root?.querySelectorAll(selector) ?? [])].map((each) => each.textContent);

describe("the Properties tab's card", () => {
  it("shows a context's screenplay settings where it holds a screenplay, each row opening the dialog at it", () => {
    seed({ film: { screenplay: { world: "story/world/" } } });
    const open = vi.fn();
    const card = contextSettingsCard("film", { screenplay: { world: "story/world/" } }, words, open);
    expect(texts(card, ".settings-group-title")).toEqual(["Screenplay"]);
    expect(texts(card, ".settings-open-row .field-row-title")).toEqual(["World"]);
    expect(texts(card, ".context-setting-value")).toEqual(["story/world"]);
    expect(card?.querySelector(".field-row-description")).toBeNull();
    card?.querySelector<HTMLElement>(".settings-open-row")?.click();
    expect(open).toHaveBeenCalledWith(WORLD_SETTING);
  });

  it("shows nothing for a context that holds no screenplay and sets none of its keys", () => {
    seed({ notes: "" }, []);
    expect(contextSettingsCard("notes", "", words, vi.fn())).toBeUndefined();
  });

  it("shows the folder an enclosing context gives, quiet, from that context and named for it", () => {
    seed({ film: { screenplay: { world: "story/world/" } }, "film/story": "" });
    const label = contextSettingsCard("film/story", "", words, vi.fn())?.querySelector(".context-setting-value");
    expect(label?.classList.contains("is-inherited")).toBe(true);
    expect(label?.querySelector(".path-label")?.textContent).toBe("story/world");
    expect(label?.querySelector(".context-setting-from")?.textContent).toBe("from film");
  });

  it("shows the context's own folder by its name, one the space lacks as missing, and one outside as none", () => {
    seed({});
    const value = (pragma: unknown) =>
      contextSettingsCard("film/story", pragma, words, vi.fn())?.querySelector(".context-setting-value");
    expect(value({ screenplay: { world: "./" } })?.textContent).toBe("story");
    const gone = value({ screenplay: { world: "drafts/world/" } });
    expect(gone?.classList.contains("is-missing")).toBe(true);
    expect(gone?.firstChild?.textContent).toBe("Missing:");
    expect(gone?.querySelector(".path-label")?.textContent).toBe("drafts/world");
    expect(value({ screenplay: { world: "../notes/" } })?.textContent).toBe("Names no folder here");
  });

  it("lists the keys nothing declares, a kind's and core's, as written", () => {
    seed({});
    const card = contextSettingsCard(
      "film",
      { outline: { beats: 8 }, screenplay: { wrold: "notes/" } },
      words,
      vi.fn(),
    );
    expect(texts(card, ".context-settings-unknown-label")).toEqual(["Not used by Pragma", "Not used by Pragma"]);
    expect(texts(card, ".context-settings-unknown .field-row-title")).toEqual(["outline", "wrold"]);
    expect(texts(card, ".context-settings-unknown .field-row-value")).toEqual(["beats: 8", "notes/"]);
  });
});

describe("the Context dialog's groups", () => {
  it("gives each setting a row with its name, its line and the control drawn for it", () => {
    seed({});
    const control = vi.fn(() => document.createElement("button"));
    const [group] = contextSettingsGroups("film", "", words, control);
    const row = group?.querySelector<HTMLElement>(".field-row");
    expect(row?.dataset.setting).toBe("screenplay.world");
    expect(texts(group, ".field-row-description")).toEqual(["Names in a screenplay link to the notes in this folder."]);
    expect(row?.querySelector(".field-row-control button")).not.toBeNull();
    expect(control).toHaveBeenCalledWith(expect.objectContaining({ setting: WORLD_SETTING, label: "World" }));
  });
});
