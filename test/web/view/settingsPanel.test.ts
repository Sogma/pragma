// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { SetupNeed } from "../../../src/protocol/setupNeed.ts";
import { buildOpenRow, must, replaceRows } from "../../../web/lib/dom.ts";
import type { ModelKind } from "../../../web/lib/modelPicker.ts";
import { settingLinks } from "../../../web/lib/settingLink.ts";
import { createCommands } from "../../../web/services/commands.ts";
import { createDialogService } from "../../../web/services/dialog.ts";
import { createKeybindings } from "../../../web/services/keybindings.ts";
import { createMenus } from "../../../web/services/menus.ts";
import type { ModelLists } from "../../../web/services/modelLists.ts";
import { createSettingsPanel } from "../../../web/view/settingsPanel.ts";
import { emptyModelLists } from "../support/emptyModelLists.ts";

// Settings as web/index.html has it, trimmed to one list category and its
// subpage. The list rebuilds on every show of the category, as the server-held
// lists do; jsdom has no animate(), so pages switch at once.
function settingsWithList(items: string[]) {
  document.body.innerHTML = `
    <button id="rail"></button>
    <div id="settings-panel" hidden>
      <nav class="settings-nav">
        <button class="settings-nav-item" data-settings-category="general">General</button>
        <button class="settings-nav-item" data-settings-category="models">Models</button>
      </nav>
      <div class="settings-body settings-pages">
        <section class="settings-category" data-settings-category="general"></section>
        <section class="settings-category" data-settings-category="models" hidden><div id="list"></div></section>
        <section class="settings-subpage" data-settings-subpage="provider" data-settings-parent="models" hidden>
          <button class="settings-subpage-back" aria-label="Back"></button>
        </section>
      </div>
    </div>`;
  const commands = createCommands();
  const keybindings = createKeybindings(commands);
  const dialog = createDialogService(document.body, { commands, keybindings });
  const list = must<HTMLElement>("#list");
  const render = () =>
    replaceRows(
      list,
      items.map((item) => buildOpenRow(item, [], () => settings.openSubpage("provider"))),
    );
  const settings = createSettingsPanel(
    { panel: must("#settings-panel"), railButton: must("#rail") },
    {
      dialog: () => dialog,
      onShowCategory: { models: render },
      commands,
      keybindings,
      menus: createMenus(commands),
      modelLists: emptyModelLists(),
    },
  );
  settings.open("models");
  const row = (item: string) => must<HTMLButtonElement>(`[data-settings-item="${item}"]`, list);
  const section = (selector: string) => must<HTMLElement>(selector);
  const navItem = (category: string) =>
    must<HTMLButtonElement>(`.settings-nav-item[data-settings-category="${category}"]`);
  return { settings, dialog, row, render, section, navItem };
}

describe("Settings' categories", () => {
  it("opens with focus on the category it shows", () => {
    const { navItem } = settingsWithList(["anthropic"]);
    expect(document.activeElement).toBe(navItem("models"));
    expect(navItem("models").classList.contains("active")).toBe(true);
  });

  it("↑ moves focus to the category above without showing it, and a click shows it", () => {
    const { navItem, section } = settingsWithList(["anthropic"]);
    navItem("models").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(navItem("general"));
    expect(section('.settings-category[data-settings-category="models"]').hidden).toBe(false);

    navItem("general").click();
    expect(section('.settings-category[data-settings-category="general"]').hidden).toBe(false);
    expect(navItem("general").classList.contains("active")).toBe(true);
    expect(navItem("models").classList.contains("active")).toBe(false);
  });
});

describe("Settings' dialog", () => {
  it("wears the dialog service's header, named by its title, and its close button closes Settings", () => {
    const { dialog } = settingsWithList(["anthropic"]);
    const panel = must<HTMLElement>(".dialog-panel");
    const title = must<HTMLElement>(".dialog-title", panel);
    expect(title.textContent).toBe("Settings");
    expect(must<HTMLImageElement>("img.dialog-title-icon", title).getAttribute("src")).toBe("/images/mark.svg");
    expect(panel.getAttribute("aria-labelledby")).toBe(title.id);

    must<HTMLButtonElement>(".dialog-close", panel).click();
    expect(dialog.isOpen()).toBe(false);
  });
});

describe("Settings' drill-down", () => {
  it("a row opens its subpage with focus on Back, and Back lands on that row again", () => {
    const { row, section } = settingsWithList(["anthropic", "openai"]);
    row("openai").focus();
    row("openai").click();
    expect(section('.settings-category[data-settings-category="models"]').hidden).toBe(true);
    expect(section('[data-settings-subpage="provider"]').hidden).toBe(false);
    expect(document.activeElement).toBe(section(".settings-subpage-back"));

    section(".settings-subpage-back").click();
    expect(section('.settings-category[data-settings-category="models"]').hidden).toBe(false);
    expect(section('[data-settings-subpage="provider"]').hidden).toBe(true);
    expect((document.activeElement as HTMLElement).dataset.settingsItem).toBe("openai");
  });

  it("finds the row by its item when the list was rebuilt while the subpage was open", () => {
    const { settings, row, render } = settingsWithList(["anthropic", "openai"]);
    row("openai").focus();
    row("openai").click();
    const opener = row("openai");
    render();
    settings.closeSubpage();
    expect(document.activeElement).not.toBe(opener);
    expect((document.activeElement as HTMLElement).dataset.settingsItem).toBe("openai");
  });

  it("moves focus to the row now in its place once the item is removed", () => {
    const items = ["anthropic", "openai", "gemini"];
    const { settings, row } = settingsWithList(items);
    row("openai").focus();
    row("openai").click();
    items.splice(1, 1);
    settings.closeSubpage();
    expect((document.activeElement as HTMLElement).dataset.settingsItem).toBe("gemini");
  });

  it("Escape steps back out of the subpage before it closes Settings", () => {
    const { dialog, row, section } = settingsWithList(["anthropic"]);
    row("anthropic").click();
    dialog.escape();
    expect(section('.settings-category[data-settings-category="models"]').hidden).toBe(false);
    expect(dialog.isOpen()).toBe(true);
    dialog.escape();
    expect(dialog.isOpen()).toBe(false);
  });

  it("reopens on the category last shown, not the subpage it was closed on", async () => {
    const { settings, row, section } = settingsWithList(["anthropic"]);
    row("anthropic").click();
    settings.close();
    await new Promise((resolve) => setTimeout(resolve, 0));
    settings.open();
    expect(section('.settings-category[data-settings-category="models"]').hidden).toBe(false);
    expect(section('[data-settings-subpage="provider"]').hidden).toBe(true);
  });

  it("a caller's category wins over the one last shown", async () => {
    const { settings, section } = settingsWithList(["anthropic"]);
    settings.close();
    await new Promise((resolve) => setTimeout(resolve, 0));
    settings.open("general");
    expect(section('.settings-category[data-settings-category="general"]').hidden).toBe(false);
    expect(section('.settings-category[data-settings-category="models"]').hidden).toBe(true);
  });
});

// Settings' pages a need can be met on, as web/index.html has them, each
// list loading after its page shows, as the server-held lists do. Each
// default's picker offers one model, unless `noModels` names its kind.
function settingsForNeeds(noModels: ModelKind[] = []) {
  document.body.innerHTML = `
    <button id="rail"></button>
    <div id="settings-panel" hidden>
      <nav class="settings-nav">
        <button class="settings-nav-item" data-settings-category="general">General</button>
        <button class="settings-nav-item" data-settings-category="models">AI Models</button>
        <button class="settings-nav-item" data-settings-category="publishing">Publishing</button>
        <button class="settings-nav-item" data-settings-category="files">Files</button>
      </nav>
      <div class="settings-body settings-pages">
        <section class="settings-category" data-settings-category="general"></section>
        <section class="settings-category" data-settings-category="models" hidden>
          <div class="field-row"><button id="setting-default-model"></button></div>
          <div class="field-row"><button id="setting-default-image-model"></button></div>
          <div class="field-row"><button id="setting-default-video-model"></button></div>
          <div id="providers-list"></div>
          <button id="providers-add"></button>
        </section>
        <section class="settings-category" data-settings-category="publishing" hidden>
          <div id="publishers-list"></div>
          <button id="publishers-add"></button>
        </section>
        <section class="settings-category" data-settings-category="files" hidden>
          <div id="sharing-list"></div>
        </section>
        <section class="settings-subpage" data-settings-subpage="provider" data-settings-parent="models" hidden></section>
        <section class="settings-subpage" data-settings-subpage="publisher" data-settings-parent="publishing" hidden></section>
        <section class="settings-subpage" data-settings-subpage="sharing" data-settings-parent="files" hidden></section>
      </div>
    </div>`;
  const commands = createCommands();
  const keybindings = createKeybindings(commands);
  const dialog = createDialogService(document.body, { commands, keybindings });
  const opened: string[] = [];
  const load = (list: string, items: string[], subpage: string) => async () => {
    await Promise.resolve();
    const rows = items.map((item) =>
      buildOpenRow(item, [], () => {
        opened.push(item);
        settings.openSubpage(subpage);
      }),
    );
    replaceRows(must<HTMLElement>(list), rows);
  };
  const listOf = (kind: ModelKind) => ({
    models: noModels.includes(kind) ? [] : [{ id: `p/${kind}`, label: kind, provider: "p", model: kind }],
    providers: [],
    defaultModel: null,
    failures: [],
  });
  const settings = createSettingsPanel(
    { panel: must("#settings-panel"), railButton: must("#rail") },
    {
      dialog: () => dialog,
      onShowCategory: {
        models: load("#providers-list", ["anthropic"], "provider"),
        publishing: load("#publishers-list", ["sogma"], "publisher"),
        files: load("#sharing-list", ["sharing"], "sharing"),
      },
      commands,
      keybindings,
      menus: createMenus(commands),
      modelLists: { get: listOf as ModelLists["get"] },
    },
  );
  const press = async (need: SetupNeed) => {
    settingLinks(need)[0].click();
    await vi.waitFor(() => expect(must<HTMLElement>("#settings-panel").hidden).toBe(false));
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  const shown = (selector: string) => !must<HTMLElement>(selector).hidden;
  return { press, opened, shown };
}

describe("a setting link", () => {
  it("opens the page of a default model's row, with focus on its picker and the row flashed", async () => {
    const { press, shown } = settingsForNeeds();
    await press({ kind: "defaultModel", output: "image" });
    expect(shown('.settings-category[data-settings-category="models"]')).toBe(true);
    expect(document.activeElement).toBe(must("#setting-default-image-model"));
    expect(must<HTMLElement>("#setting-default-image-model").parentElement?.classList.contains("flash")).toBe(true);
  });

  it("lands on Add provider, flashed, when a default has no model to pick, as with no provider set", async () => {
    const { press } = settingsForNeeds(["text"]);
    await press({ kind: "defaultModel", output: "text" });
    expect(document.activeElement).toBe(must("#providers-add"));
    expect(must<HTMLElement>("#providers-add").classList.contains("flash")).toBe(true);
  });

  it("keeps a video default's picker even with no model to pick", async () => {
    const { press } = settingsForNeeds(["video"]);
    await press({ kind: "defaultModel", output: "video" });
    expect(document.activeElement).toBe(must("#setting-default-video-model"));
  });

  it("opens the provider that needs a key, once its page's list has loaded", async () => {
    const { press, opened, shown } = settingsForNeeds();
    await press({ kind: "providerKey", provider: "anthropic" });
    expect(opened).toEqual(["anthropic"]);
    expect(shown('.settings-subpage[data-settings-subpage="provider"]')).toBe(true);
  });

  it("lands on Add provider when the provider isn't listed, or no provider serves the model", async () => {
    const { press, opened } = settingsForNeeds();
    await press({ kind: "providerKey", provider: "gone" });
    expect(opened).toEqual([]);
    expect(document.activeElement).toBe(must("#providers-add"));
  });

  it("opens the publisher that needs a key on the Publishing page", async () => {
    const { press, opened, shown } = settingsForNeeds();
    await press({ kind: "publisherKey", publisher: "sogma" });
    expect(opened).toEqual(["sogma"]);
    expect(shown('.settings-subpage[data-settings-subpage="publisher"]')).toBe(true);
  });

  it("opens Sharing from the Files page when a provider takes references only as links", async () => {
    const { press, opened, shown } = settingsForNeeds();
    await press({ kind: "sharing" });
    expect(opened).toEqual(["sharing"]);
    expect(shown('.settings-subpage[data-settings-subpage="sharing"]')).toBe(true);
  });
});
