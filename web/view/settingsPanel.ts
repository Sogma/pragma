// The Settings dialog: which category is showing, its one level of
// drill-down, and the dialog frame the whole thing rides in.
//
// The panel owns navigation and nothing else. Every category's content is
// wired by whoever owns that content — the server-side lists, the toggles below
// — because what a preference *does* reaches far outside this dialog, into
// the editor, the tree and the console.
import type { SetupNeed } from "../../src/protocol/setupNeed.ts";
import { must } from "../lib/dom.ts";
import { flash } from "../lib/flash.ts";
import { canSlide, createPageSlide } from "../lib/pageSlide.ts";
import { provideSettingLinks, setupPage } from "../lib/settingLink.ts";
import { settingsNav } from "../lib/settingsNav.ts";
import type { CommandRegistry } from "../services/commands.ts";
import type { DialogService } from "../services/dialog.ts";
import type { KeybindingRegistry } from "../services/keybindings.ts";
import { COMMAND_PALETTE, type MenuRegistry } from "../services/menus.ts";
import type { ModelLists } from "../services/modelLists.ts";

export interface SettingsPanelElements {
  /** `#settings-panel`: the dialog's content, and the root every nav query
   * below is scoped to. */
  panel: HTMLElement;
  railButton: HTMLElement;
}

export interface SettingsPanelDeps {
  /** Read on open, not at construction: the dialog service outlives this
   * panel but is built after it. */
  dialog(): DialogService;
  /** Re-run whenever a category is shown at its top level — opening it,
   * switching to it, or backing out of its subpage. A list that loads
   * returns the load, so a setting link can wait for its rows. */
  onShowCategory: Record<string, () => void | Promise<void>>;
  commands: CommandRegistry;
  keybindings: KeybindingRegistry;
  menus: MenuRegistry;
  /** What each default's picker offers: a link to a default with nothing to
   * pick lands on Add provider instead. */
  modelLists: Pick<ModelLists, "get">;
}

export interface SettingsPanel {
  /** Lands on the category last shown unless a caller (the chat panel's
   * missing-API-key message) names one. Kept in memory only, so a reload
   * starts at "general", the nav's default-active item. */
  open(category?: string): void;
  close(): void;
  openSubpage(id: string): void;
  closeSubpage(): void;
}

// Where on its page each need is met: an item's row in a list, when it has
// one, and the control that meets it otherwise. A text or image default with
// no model to pick is met by adding a provider first; no provider makes
// videos, so a video default keeps its picker.
function placeOf(need: SetupNeed, lists: Pick<ModelLists, "get">): { list?: string; item?: string; control: string } {
  if (need.kind === "defaultModel") {
    if (need.output !== "video" && lists.get(need.output)?.models.length === 0) return { control: "#providers-add" };
    return { control: need.output === "text" ? "#setting-default-model" : `#setting-default-${need.output}-model` };
  }
  if (need.kind === "providerKey") return { list: "#providers-list", item: need.provider, control: "#providers-add" };
  if (need.kind === "publisherKey") {
    return { list: "#publishers-list", item: need.publisher, control: "#publishers-add" };
  }
  return { control: need.kind === "provider" ? "#providers-add" : "#publishers-add" };
}

export function createSettingsPanel(elements: SettingsPanelElements, deps: SettingsPanelDeps): SettingsPanel {
  const nav = settingsNav(must<HTMLElement>(".settings-nav", elements.panel), show);
  const categories = Array.from(elements.panel.querySelectorAll<HTMLElement>(".settings-category"));
  // A category's drill-down `.settings-subpage`s are sibling sections in
  // `#settings-body`, tagged `data-settings-parent`. Showing one hides the
  // parent category's content but keeps its nav item active, and a
  // `.settings-subpage-back` button returns to the category. One level deep
  // only: a subpage that drills further would need a stack here.
  const subpages = Array.from(elements.panel.querySelectorAll<HTMLElement>(".settings-subpage"));
  const sections = [...categories, ...subpages];
  // Every section scrolls on its own and forgets its place while hidden, so
  // the way back from a subpage restores where its category was.
  let categoryScroll = 0;
  // What a subpage was opened from, and the item its row stands for: focus
  // goes back there, found again by item if the list was rebuilt meanwhile.
  let opener: { element: HTMLElement; item?: string } | undefined;
  const slider = createPageSlide();

  let activeCategory = "general";
  let activeSubpage: string | null = null;
  // Undefined while closed. The panel's content is static markup handed to
  // the dialog service on open (the service supplies the scrim and the
  // frame); it is detached again on close and re-used next time.
  let handle: ReturnType<DialogService["open"]> | undefined;

  const sectionFor = (category: string, subpage: string | null): HTMLElement | undefined =>
    subpage === null
      ? categories.find((section) => section.dataset.settingsCategory === category)
      : subpages.find((section) => section.dataset.settingsSubpage === subpage);

  function show(category: string, subpage: string | null = null): Promise<void> {
    display(category, subpage);
    return Promise.resolve(subpage === null ? deps.onShowCategory[category]?.() : undefined);
  }

  function display(category: string, subpage: string | null): void {
    const from = sectionFor(activeCategory, activeSubpage);
    const opening = subpage !== null && activeSubpage === null && category === activeCategory;
    const returning = subpage === null && activeSubpage !== null && category === activeCategory;
    if (subpage !== null && activeSubpage === null) categoryScroll = opening && from ? from.scrollTop : 0;
    slider.stop();
    activeCategory = category;
    activeSubpage = subpage;
    nav.select(category);
    const to = sectionFor(category, subpage);
    for (const section of sections) section.hidden = section !== to;
    if (to && subpage !== null) to.scrollTop = 0;
    if (to && returning) to.scrollTop = categoryScroll;
    if (from && to && (opening || returning) && canSlide(to)) slider.run(from, to, opening);
  }

  function openSubpage(id: string): void {
    const section = subpages.find((s) => s.dataset.settingsSubpage === id);
    const parent = section?.dataset.settingsParent ?? activeCategory;
    const focused = document.activeElement;
    const list = activeSubpage === null && parent === activeCategory ? sectionFor(parent, null) : undefined;
    opener =
      focused instanceof HTMLElement && list?.contains(focused)
        ? { element: focused, item: focused.dataset.settingsItem }
        : undefined;
    show(parent, id);
    section?.querySelector<HTMLElement>(".settings-subpage-back")?.focus({ preventScroll: true });
  }

  // Focus lands before the category's refresh, which keeps it on the same
  // item's row as it rebuilds the list, or moves it to the row now in its place.
  function closeSubpage(): void {
    const back = opener;
    opener = undefined;
    display(activeCategory, null);
    if (back) {
      const rows = sectionFor(activeCategory, null)?.querySelectorAll<HTMLElement>("[data-settings-item]") ?? [];
      const row = back.element.isConnected
        ? back.element
        : Array.from(rows).find((el) => back.item !== undefined && el.dataset.settingsItem === back.item);
      row?.focus({ preventScroll: true });
    }
    void deps.onShowCategory[activeCategory]?.();
  }

  function open(category = activeCategory): Promise<void> {
    if (!handle) {
      // Reopening lands on the category at once, never sliding back from the
      // subpage Settings was closed on.
      slider.stop();
      activeSubpage = null;
      opener = undefined;
      elements.panel.hidden = false;
      elements.railButton.classList.add("active");
      handle = deps.dialog().open({
        title: "Settings",
        icon: "pragma",
        content: elements.panel,
        className: "dialog-settings dialog-flush",
        // On the category, so ↑/↓ work straight away.
        initialFocus: nav.item(category),
        // Escape steps back out of a subpage first rather than closing,
        // unlike the X and the scrim.
        onEscape: () => {
          if (!activeSubpage) return false;
          closeSubpage();
          return true;
        },
      });
      void handle.closed.then(() => {
        handle = undefined;
        elements.panel.hidden = true;
        elements.railButton.classList.remove("active");
      });
    }
    return show(category);
  }

  // A need's place: its page, then the row that meets it opened as a click
  // would, or else the control that does, focused and flashed. The row is
  // looked for once the page's list has reloaded, as every show reloads it.
  async function openSetting(need: SetupNeed): Promise<void> {
    await open(setupPage(need));
    const { list, item, control } = placeOf(need, deps.modelLists);
    const rows = list ? Array.from(elements.panel.querySelector(list)?.children ?? []) : [];
    const row = rows.find((el): el is HTMLElement => el instanceof HTMLElement && el.dataset.settingsItem === item);
    if (row) return row.click();
    const target = elements.panel.querySelector<HTMLElement>(control);
    target?.focus();
    if (target) flash(target.closest<HTMLElement>(".field-row") ?? target);
  }

  elements.panel.querySelectorAll<HTMLButtonElement>(".settings-subpage-back").forEach((button) => {
    button.addEventListener("click", closeSubpage);
  });
  elements.railButton.addEventListener("click", () => open());
  // A menu row may name the category to land on; a key press passes none.
  deps.commands.register({
    id: "settings.open",
    label: "Open Settings",
    run: (_, category: unknown) => open(typeof category === "string" ? category : undefined),
  });
  deps.keybindings.register({ key: "Mod+,", command: "settings.open" });
  deps.menus.register(COMMAND_PALETTE, [{ command: "settings.open" }]);
  provideSettingLinks((need) => void openSetting(need));

  return { open, close: () => handle?.close(), openSubpage, closeSubpage };
}
