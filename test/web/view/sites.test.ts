// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SiteSettingsResponse } from "../../../web/core/apiClient.ts";
import { createCommands } from "../../../web/services/commands.ts";
import { createDialogService } from "../../../web/services/dialog.ts";
import { createKeybindings } from "../../../web/services/keybindings.ts";
import { createMenus } from "../../../web/services/menus.ts";
import { createSiteDialogs, type SiteDialogsDeps, type SiteSettingsApi } from "../../../web/view/sites.ts";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const context = { tab: { kind: "empty" } as const, pane: undefined };

function panel(): HTMLElement {
  const found = document.querySelector<HTMLElement>(".dialog-panel");
  if (!found) throw new Error("no dialog open");
  return found;
}

function buttonNamed(root: ParentNode, label: string): HTMLButtonElement {
  const found = [...root.querySelectorAll("button")].find((b) => b.textContent === label);
  if (!found) throw new Error(`no "${label}" button`);
  return found;
}

// Controls are keyed by the field's JSON Pointer, so the id carries the
// pointer's own slashes — CSS.escape rather than a bare selector.
function inputFor(pointer: string): HTMLInputElement {
  const found = panel().querySelector<HTMLInputElement>(`#${CSS.escape(`site-setting-${pointer}`)}`);
  if (!found) throw new Error(`no "${pointer}" field`);
  return found;
}

// What the publisher's own schema and values resolve to by the time they
// reach the dialog (src/server/siteSettingsHandler.ts does the flattening).
function settings(overrides: Partial<SiteSettingsResponse> = {}): SiteSettingsResponse {
  return {
    siteName: "My blog",
    publisherLabel: "Sogma CMS",
    skipped: 0,
    assetsFolder: "",
    fields: [
      {
        pointer: "/analytics/ga_id",
        label: "Google Analytics ID",
        description: "GA4 measurement id.",
        placeholder: "G-ABC1234DEF",
        group: "Analytics",
        value: "G-OLD1234567",
      },
      { pointer: "/analytics/gtm_id", label: "Google Tag Manager ID", group: "Analytics", value: "" },
    ],
    ...overrides,
  };
}

function publisher(id: string, label: string): { id: string; label: string } {
  return { id, label };
}

function setup(overrides: Partial<SiteDialogsDeps> = {}, api: Partial<SiteSettingsApi> = {}) {
  const commands = createCommands();
  const menus = createMenus(commands);
  const keybindings = createKeybindings(commands);
  const deps: SiteDialogsDeps = {
    commands,
    menus,
    dialog: createDialogService(document.body, { commands, keybindings }),
    settings: {
      load: vi.fn(async () => settings()),
      save: vi.fn(async () => settings({ fields: [] })),
      saveAssetsFolder: vi.fn(async (_site: string, folder: string) => folder.trim()),
      uploadImage: vi.fn(async () => ({ publicId: "k3jf8xmz2p", preview: { url: null, label: "Still processing…" } })),
      ...api,
    },
    onAssetsFolderSaved: vi.fn(),
    siteImages: vi.fn(() => ["blog/assets/logo.png", "blog/icon.png"]),
    createSite: vi.fn(),
    publishers: () => [publisher("sogma", "Sogma CMS")],
    onSiteCreated: vi.fn(async () => {}),
    ...overrides,
  };
  const dialogs = createSiteDialogs(deps);
  return { commands, menus, deps, dialogs };
}

async function openSettings(commands: ReturnType<typeof createCommands>): Promise<void> {
  void commands.run("site.settings", context, { kind: "site", path: "blog" });
  await tick();
}

beforeEach(() => {
  document.body.replaceChildren();
});

describe("createSiteDialogs: the Settings command", () => {
  it("contributes one item to the listItem menu", () => {
    const { menus } = setup();
    const items = menus.resolve("listItem", context, { kind: "site", path: "blog" });
    expect(items.map((item) => item.label)).toEqual(["Settings"]);
  });

  it("applies to a site row only, and only with a publisher key stored", () => {
    const { commands } = setup();
    expect(commands.isEnabled("site.settings", context, { kind: "site", path: "blog" })).toBe(true);
    // A Libraries row opens the same menu with no target at all.
    expect(commands.isEnabled("site.settings", context, undefined)).toBe(false);

    const keyless = setup({ publishers: () => [] });
    expect(keyless.commands.isEnabled("site.settings", context, { kind: "site", path: "blog" })).toBe(false);
  });
});

describe("createSiteDialogs: New Site", () => {
  async function openNewSite(overrides: Partial<SiteDialogsDeps> = {}) {
    const harness = setup(overrides);
    harness.dialogs.openNewSite("websites");
    await tick();
    return harness;
  }

  function fieldFor(id: string): HTMLInputElement | HTMLSelectElement {
    const found = panel().querySelector<HTMLInputElement | HTMLSelectElement>(`#dialog-field-${id}`);
    if (!found) throw new Error(`no "${id}" field`);
    return found;
  }

  it("names the only publisher without asking which one", async () => {
    const { deps } = await openNewSite();
    expect(panel().querySelector<HTMLElement>(".dialog-title .dialog-title-icon")?.dataset.entryIcon).toBe("site");
    expect(panel().querySelector("#dialog-field-publisher")).toBeNull();

    fieldFor("name").value = "My blog";
    buttonNamed(panel(), "Create Site").click();
    await tick();

    expect(deps.createSite).toHaveBeenCalledWith("websites", {
      name: "My blog",
      domain: undefined,
      publisherId: "sogma",
    });
  });

  it("asks which publisher once there is more than one", async () => {
    const { deps } = await openNewSite({
      publishers: () => [publisher("sogma", "Sogma CMS"), publisher("staging", "Sogma (staging)")],
    });
    const picker = fieldFor("publisher");
    expect([...picker.querySelectorAll("option")].map((o) => o.textContent)).toEqual(["Sogma CMS", "Sogma (staging)"]);

    picker.value = "staging";
    fieldFor("name").value = "My blog";
    buttonNamed(panel(), "Create Site").click();
    await tick();

    expect(deps.createSite).toHaveBeenCalledWith("websites", {
      name: "My blog",
      domain: undefined,
      publisherId: "staging",
    });
  });
});

describe("createSiteDialogs: Site Settings", () => {
  it("draws General and one category per group, like Settings", async () => {
    const { commands, deps } = setup();
    await openSettings(commands);

    expect(deps.settings.load).toHaveBeenCalledWith("blog");
    expect(panel().querySelector(".dialog-title")?.textContent).toBe("My blog Settings [Sogma CMS]");
    expect(panel().querySelector(".dialog-title .dialog-title-muted")?.textContent).toBe("[Sogma CMS]");
    expect(panel().querySelector<HTMLElement>(".dialog-title .dialog-title-icon")?.dataset.entryIcon).toBe("site");
    expect(panel().querySelector(".dialog-message")).toBeNull();
    expect([...panel().querySelectorAll(".settings-nav-item")].map((b) => b.textContent)).toEqual([
      "General",
      "Analytics",
    ]);
    const visibleTitles = () =>
      [...panel().querySelectorAll<HTMLElement>(".settings-category:not([hidden]) .field-row-title")].map(
        (l) => l.textContent,
      );
    const actions = () => panel().querySelector<HTMLElement>(".settings-body .site-settings-actions");
    expect(visibleTitles()).toEqual(["Assets folder"]);
    expect(actions()?.hidden).toBe(true);

    buttonNamed(panel(), "Analytics").click();
    expect(visibleTitles()).toEqual(["Google Analytics ID", "Google Tag Manager ID"]);
    expect(actions()?.hidden).toBe(false);
    expect(buttonNamed(panel(), "Save").className).toBe("btn primary");
    expect(inputFor("/analytics/ga_id").value).toBe("G-OLD1234567");
    expect(inputFor("/analytics/ga_id").placeholder).toBe("G-ABC1234DEF");
    expect(panel().querySelector(".dialog-field-description")).toBeNull();
  });

  it("moves through its categories with ↓ and ↑, as Settings' do", async () => {
    const { commands } = setup();
    await openSettings(commands);
    const arrow = (key: string) =>
      document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));

    buttonNamed(panel(), "General").focus();
    arrow("ArrowDown");
    expect(document.activeElement).toBe(buttonNamed(panel(), "Analytics"));
    arrow("ArrowUp");
    expect(document.activeElement).toBe(buttonNamed(panel(), "General"));
    expect(buttonNamed(panel(), "General").classList.contains("active")).toBe(true);
  });

  it("saves the assets folder on its own, without the publisher", async () => {
    const { commands, deps } = setup();
    await openSettings(commands);

    inputFor("assets-folder").value = " media/images ";
    inputFor("assets-folder").dispatchEvent(new Event("change"));
    await tick();

    expect(deps.settings.saveAssetsFolder).toHaveBeenCalledWith("blog", "media/images");
    expect(deps.settings.save).not.toHaveBeenCalled();
    expect(inputFor("assets-folder").value).toBe("media/images");
  });

  it("shows a refused assets folder under it", async () => {
    const { commands } = setup(
      {},
      {
        saveAssetsFolder: vi.fn(async () => {
          throw new Error("Must be a folder inside the site.");
        }),
      },
    );
    await openSettings(commands);

    inputFor("assets-folder").value = "../up";
    inputFor("assets-folder").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    await tick();

    expect(panel().querySelector(".settings-category:not([hidden]) .inline-error")?.textContent).toBe(
      "Must be a folder inside the site.",
    );
  });

  describe("image settings", () => {
    const identity = () =>
      settings({
        fields: [
          { pointer: "/identity/title", label: "Site title", group: "Identity", value: "My blog" },
          {
            pointer: "/identity/logo",
            label: "Logo",
            group: "Identity",
            kind: "image",
            value: "r7pq2wm4x1",
            preview: { url: "https://cdn.example/logo.webp", label: "logo.png" },
          },
          ...settings().fields,
        ],
      });

    it("lists Identity in the publisher's order, below General", async () => {
      const { commands } = setup({}, { load: vi.fn(async () => identity()) });
      await openSettings(commands);

      expect([...panel().querySelectorAll(".settings-nav-item")].map((b) => b.textContent)).toEqual([
        "General",
        "Identity",
        "Analytics",
      ]);
      buttonNamed(panel(), "Identity").click();
      expect(panel().querySelector<HTMLImageElement>(".site-image-picture")?.src).toBe("https://cdn.example/logo.webp");
      expect(panel().querySelector(".site-image-name")?.textContent).toBe("logo.png");
      expect(panel().querySelector(".site-image-field")?.classList.contains("is-empty")).toBe(false);
    });

    it("uploads the chosen space image and saves its file id", async () => {
      const { commands, deps } = setup({}, { load: vi.fn(async () => identity()) });
      await openSettings(commands);
      buttonNamed(panel(), "Identity").click();

      buttonNamed(panel(), "Choose…").click();
      await tick();
      const picker = [...document.querySelectorAll<HTMLElement>(".dialog-panel")].at(-1);
      if (!picker) throw new Error("no picker");
      [...picker.querySelectorAll<HTMLElement>(".dialog-option")]
        .find((option) => option.querySelector(".dialog-option-label")?.textContent === "logo.png")
        ?.click();
      await tick();
      await tick();

      expect(deps.settings.uploadImage).toHaveBeenCalledWith("blog", "blog/assets/logo.png");
      buttonNamed(panel(), "Save").click();
      await tick();
      expect(deps.settings.save).toHaveBeenCalledWith("blog", { "/identity/logo": "k3jf8xmz2p" });
    });

    it("clears an image with null", async () => {
      const { commands, deps } = setup({}, { load: vi.fn(async () => identity()) });
      await openSettings(commands);
      buttonNamed(panel(), "Identity").click();

      panel().querySelector<HTMLButtonElement>(".site-image-clear")?.click();
      expect(panel().querySelector(".site-image-name")?.textContent).toBe("None");
      // "None" is the field's own word, which a copy leaves out.
      expect(panel().querySelector(".site-image-field")?.classList.contains("is-empty")).toBe(true);
      buttonNamed(panel(), "Save").click();
      await tick();
      expect(deps.settings.save).toHaveBeenCalledWith("blog", { "/identity/logo": null });
    });
  });

  describe("toggle settings", () => {
    const indexing = () =>
      settings({
        fields: [
          {
            pointer: "/indexing/block_search_engines",
            label: "Block search engines",
            description: "Every page is sent with `noindex`. The site stays public.",
            group: "Search & AI",
            kind: "toggle",
            value: false,
          },
          {
            pointer: "/indexing/block_ai_training",
            label: "Block AI training",
            description: "Asks AI companies not to train on the site.",
            group: "Search & AI",
            kind: "toggle",
            value: true,
          },
          ...settings().fields,
        ],
      });

    it("draws a switch with its description under the title", async () => {
      const { commands } = setup({}, { load: vi.fn(async () => indexing()) });
      await openSettings(commands);
      buttonNamed(panel(), "Search & AI").click();

      const toggle = inputFor("/indexing/block_search_engines");
      expect(toggle.type).toBe("checkbox");
      expect(toggle.checked).toBe(false);
      expect(inputFor("/indexing/block_ai_training").checked).toBe(true);

      const row = toggle.closest(".field-row");
      expect(row?.querySelector<HTMLLabelElement>(".field-row-title")?.htmlFor).toBe(toggle.id);
      const description = row?.querySelector(".field-row-description");
      expect(description?.textContent).toBe("Every page is sent with noindex. The site stays public.");
      expect(description?.querySelector("code")?.textContent).toBe("noindex");
    });

    it("keeps a text field's description off the form", async () => {
      const { commands } = setup({}, { load: vi.fn(async () => indexing()) });
      await openSettings(commands);
      buttonNamed(panel(), "Analytics").click();

      expect(inputFor("/analytics/ga_id").closest(".field-row")?.querySelector(".field-row-description")).toBeNull();
    });

    it("sends a flipped switch as true or false, and an untouched one not at all", async () => {
      const { commands, deps } = setup({}, { load: vi.fn(async () => indexing()) });
      await openSettings(commands);
      buttonNamed(panel(), "Search & AI").click();

      inputFor("/indexing/block_search_engines").click();
      inputFor("/indexing/block_ai_training").click();
      buttonNamed(panel(), "Save").click();
      await tick();

      expect(deps.settings.save).toHaveBeenCalledWith("blog", {
        "/indexing/block_search_engines": true,
        "/indexing/block_ai_training": false,
      });
    });

    it("sends nothing for a switch flipped and flipped back", async () => {
      const { commands, deps } = setup({}, { load: vi.fn(async () => indexing()) });
      await openSettings(commands);
      buttonNamed(panel(), "Search & AI").click();

      inputFor("/indexing/block_ai_training").click();
      inputFor("/indexing/block_ai_training").click();
      buttonNamed(panel(), "Save").click();
      await tick();

      expect(deps.settings.save).not.toHaveBeenCalled();
    });
  });

  it("sends only the fields that changed", async () => {
    const { commands, deps } = setup();
    await openSettings(commands);

    inputFor("/analytics/ga_id").value = "G-NEW1234567";
    buttonNamed(panel(), "Save").click();
    await tick();

    // gtm_id was never touched, so it must not appear in the patch at all —
    // a merge patch leaves out what it doesn't mean to change.
    expect(deps.settings.save).toHaveBeenCalledWith("blog", { "/analytics/ga_id": "G-NEW1234567" });
  });

  it("clears a setting with null rather than an empty string", async () => {
    const { commands, deps } = setup();
    await openSettings(commands);

    inputFor("/analytics/ga_id").value = "";
    buttonNamed(panel(), "Save").click();
    await tick();

    expect(deps.settings.save).toHaveBeenCalledWith("blog", { "/analytics/ga_id": null });
  });

  it("sends nothing when nothing was edited", async () => {
    const { commands, deps } = setup();
    await openSettings(commands);

    buttonNamed(panel(), "Save").click();
    await tick();

    expect(deps.settings.save).not.toHaveBeenCalled();
  });

  it("names the field the service rejected", async () => {
    const rejection = Object.assign(new Error("Not a valid GA4 measurement id."), { field: "/analytics/ga_id" });
    const { commands } = setup(
      {},
      {
        save: vi.fn(async () => {
          throw rejection;
        }),
      },
    );
    await openSettings(commands);

    inputFor("/analytics/ga_id").value = "nope";
    buttonNamed(panel(), "Save").click();
    await tick();

    expect(panel().querySelector(".site-settings-actions .inline-error")?.textContent).toBe(
      "Google Analytics ID: Not a valid GA4 measurement id.",
    );
  });

  it("reports a failed load instead of an empty form", async () => {
    const { commands } = setup(
      {},
      {
        load: vi.fn(async () => {
          throw new Error("No Sogma publisher key configured.");
        }),
      },
    );
    await openSettings(commands);

    expect(panel().querySelector(".dialog-message")?.textContent).toBe("No Sogma publisher key configured.");
    expect(panel().querySelector(".settings-input")).toBeNull();
  });

  it("still opens on General when the publisher has nothing this pragma can draw", async () => {
    const { commands } = setup({}, { load: vi.fn(async () => settings({ fields: [], skipped: 2 })) });
    await openSettings(commands);

    expect(panel().querySelector(".dialog-message")?.textContent).toBe(
      "2 settings need a newer version of Pragma to edit.",
    );
    expect([...panel().querySelectorAll(".settings-nav-item")].map((b) => b.textContent)).toEqual(["General"]);
  });

  it("notes skipped fields alongside the ones it can draw", async () => {
    const { commands } = setup({}, { load: vi.fn(async () => settings({ skipped: 1 })) });
    await openSettings(commands);

    expect(panel().querySelector(".dialog-message")?.textContent).toBe(
      "1 setting needs a newer version of Pragma to edit.",
    );
  });
});
