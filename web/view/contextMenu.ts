// The one context-menu component: renders any menu from its resolved items,
// positioned at a point (a right-click) or under an anchor (a ⋮ button), and
// dismissed by a click elsewhere, a resize, or Escape through the keybinding
// dispatcher. A picked item closes the menu first, then runs its command, or
// its own action, with the context the menu was opened in.
import { DisposableStore, listen } from "../lib/disposable.ts";
import { el, keyLabel, setEntryIcon } from "../lib/dom.ts";
import { installPathChipMenu } from "../lib/pathChipMenu.ts";
import { installTextMenu } from "../lib/textMenu.ts";
import type { CommandContext, CommandRegistry } from "../services/commands.ts";
import type { KeybindingRegistry } from "../services/keybindings.ts";
import type {
  ContextMenuService,
  MenuOpenOptions,
  MenuPreview,
  MenuRange,
  MenuRegistry,
  MenuSlider,
  MenuTile,
  MenuTileSection,
  ResolvedMenuItem,
} from "../services/menus.ts";

export interface ContextMenu extends ContextMenuService {
  dispose(): void;
}

export interface ContextMenuDeps {
  commands: CommandRegistry;
  menus: MenuRegistry;
  keybindings: KeybindingRegistry;
  // The focused group's active tab and pane, read when a menu opens.
  context: () => CommandContext;
}

export const CLOSE_CONTEXT_MENU = "contextMenu.close";

const VIEWPORT_MARGIN = 4;

// A slider under the list: `row` takes the keyboard highlight, `footer` is
// what the menu pins.
interface RenderedSlider {
  footer: HTMLElement;
  row: HTMLElement;
  input: HTMLInputElement;
}

export function createContextMenu(deps: ContextMenuDeps): ContextMenu {
  const store = new DisposableStore();
  let open:
    | { element: HTMLElement; anchor?: HTMLElement; opener: Element | null; session: DisposableStore }
    | undefined;
  // Names the highlighted row of a focused list to a screen reader.
  let rowIds = 0;
  // A row's label alone, without its trailing detail, for typing to jump.
  const rowLabels = new WeakMap<HTMLElement, string>();
  // What a row shows while it is pointed at or reached by the keys, and the
  // one showing now, ended before the next starts.
  const previews = new WeakMap<HTMLElement, MenuPreview>();
  let previewing: MenuPreview | undefined;
  function preview(next: MenuPreview | undefined): void {
    if (next === previewing) return;
    previewing?.end();
    previewing = next;
    next?.show();
  }

  function close(): void {
    if (!open) return;
    preview(undefined);
    const { element, anchor, opener, session } = open;
    open = undefined;
    session.dispose();
    // Focus inside the menu (its search box, a clicked row) goes back to the
    // anchor, or for a menu opened at a point to what had it before: left to
    // fall to the page, it would strand a keyboard user in a dialog, and take
    // a Flow canvas's Undo away after a pick from its menu.
    const refocus = element.contains(document.activeElement);
    element.remove();
    anchor?.setAttribute("aria-expanded", "false");
    const returnTo = anchor ?? (opener instanceof HTMLElement ? opener : undefined);
    if (refocus) returnTo?.focus({ preventScroll: true });
  }

  store.add(
    deps.commands.register({
      id: CLOSE_CONTEXT_MENU,
      label: "Close menu",
      when: () => open !== undefined,
      run: close,
    }),
  );
  store.add(deps.keybindings.register({ key: "Escape", command: CLOSE_CONTEXT_MENU, weight: 100 }));

  // A row's tooltip sits beside it, where one below would cover the next
  // row, and waits out the delay, so sliding down the list flashes none.
  function decorate(row: HTMLElement, item: ResolvedMenuItem): void {
    if (item.className) row.classList.add(...item.className.split(/\s+/).filter(Boolean));
    for (const [key, value] of Object.entries(item.data ?? {})) row.dataset[key] = value;
    for (const [property, value] of Object.entries(item.style ?? {})) row.style.setProperty(property, value);
    if (item.tooltip) {
      row.dataset.tooltip = item.tooltip;
      row.dataset.tooltipSide = "right";
      row.dataset.tooltipWait = "";
    }
  }

  // A font is the label's alone: a trailing value beside it, such as "Not
  // installed", stays in the interface's font, whatever the label falls
  // back to.
  function label(item: ResolvedMenuItem): Node {
    if (item.font === undefined) return document.createTextNode(item.label);
    const text = el("span", "context-menu-font");
    text.style.fontFamily = item.font;
    text.textContent = item.label;
    return text;
  }

  function fill(row: HTMLElement, item: ResolvedMenuItem): void {
    if (item.icon) {
      const icon = el("span", "context-menu-icon");
      if (item.entryIcon) setEntryIcon(icon, item.entryIcon);
      row.append(icon);
    }
    if (item.description === undefined) row.append(label(item));
    else {
      const description = el("span", "caption context-menu-description");
      description.textContent = item.description;
      const text = el("span", "context-menu-text");
      text.append(label(item), description);
      row.classList.add("has-description");
      row.append(text);
    }
    if (item.direction) row.append(el("span", `context-menu-direction is-${item.direction}`));
    if (item.mark !== undefined) {
      const mark = el("span", "context-menu-mark");
      mark.dataset.tooltip = item.mark;
      mark.setAttribute("aria-hidden", "true");
      row.append(mark);
    }
    if (item.detail !== undefined) {
      const detail = el("span", "context-menu-detail");
      detail.textContent = item.detail;
      row.append(detail);
    }
    if (item.shortcut !== undefined) {
      const shortcut = el("span", "context-menu-detail");
      shortcut.append(keyLabel(item.shortcut));
      row.append(shortcut);
    }
  }

  // A list with any checkable row keeps the check's place at the end of
  // every row, after any trailing value, so those values line up whether a
  // row can be checked or not. A flyout's row has its arrow there instead.
  //
  // A picker's rows are choices of its one value, so a checkable row there
  // is a radio item to a screen reader, not a checkbox, unless it toggles.
  function renderItems(items: ResolvedMenuItem[], into: HTMLElement, context: CommandContext, picker = false): void {
    const checkable = items.some((item) => item.checked !== undefined);
    let previousGroup: string | undefined;
    items.forEach((item, index) => {
      const separated = index > 0 && item.group !== previousGroup;
      previousGroup = item.group;
      let row: HTMLElement;
      if (item.submenu || item.tiles) {
        row = el("div", "context-menu-item has-submenu");
        fill(row, item);
        const flyout = el("div", "context-submenu");
        if (item.tiles) renderTiles(item.tiles, flyout);
        else if (item.search) renderSearchFlyout(item, flyout, context, picker);
        else if (item.submenu) renderItems(item.submenu, flyout, context, picker);
        row.append(flyout);
      } else if (item.command === undefined && item.run === undefined) {
        row = el("div", "context-menu-item context-menu-label");
        fill(row, item);
        // The value selects for copying. Focusable, so the click selecting it
        // keeps focus in the menu, which hands it back on close: dropped to
        // the page instead, it would leave a Flow canvas without its Undo.
        const value = row.querySelector<HTMLElement>(":scope > .context-menu-detail");
        if (value) value.tabIndex = -1;
      } else {
        const button = document.createElement("button");
        button.type = "button";
        const checkRole = picker && !item.toggle ? "menuitemradio" : "menuitemcheckbox";
        button.setAttribute("role", item.checked === undefined ? "menuitem" : checkRole);
        rowLabels.set(button, item.label);
        fill(button, item);
        if (item.checked !== undefined) button.setAttribute("aria-checked", String(item.checked));
        if (item.mark !== undefined) button.setAttribute("aria-label", `${item.label}, ${item.mark}`);
        if (item.danger) button.classList.add("danger");
        if (item.disabled) button.disabled = true;
        button.addEventListener("click", () => {
          close();
          if (item.run) void item.run(context, item.arg);
          else if (item.command !== undefined) void deps.commands.run(item.command, context, item.arg);
        });
        row = button;
      }
      if (checkable && !item.submenu && !item.tiles) row.append(el("span", "menu-item-check"));
      if (item.preview) previews.set(row, item.preview);
      decorate(row, item);
      if (separated) row.classList.add("menu-item-separated");
      into.append(row);
    });
  }

  // A flyout led by a search box: a query swaps its rows for the matches, a
  // flat list the keys walk, each previewed as it is reached. Escape clears
  // a query before it closes the menu.
  function renderSearchFlyout(
    item: ResolvedMenuItem,
    flyout: HTMLElement,
    context: CommandContext,
    picker: boolean,
  ): void {
    const search = item.search;
    if (!search) return;
    flyout.classList.add("has-search");
    const input = document.createElement("input");
    input.type = "text";
    input.className = "context-menu-search";
    input.placeholder = search.placeholder;
    input.setAttribute("aria-label", search.placeholder);
    const body = el("div", "context-menu-items");
    const results = el("div", "context-menu-results");
    results.hidden = true;
    renderItems(item.submenu ?? [], body, context, picker);
    input.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || event.isComposing || input.value === "") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      input.value = "";
      input.dispatchEvent(new Event("input"));
    });
    const rows = () => [...(results.hidden ? body : results).querySelectorAll<HTMLElement>(":scope > button:enabled")];
    const track = navigate(
      input,
      rows,
      () => !results.hidden,
      undefined,
      (row) => preview(row && previews.get(row)),
    );
    input.addEventListener("input", () => {
      const query = input.value.trim();
      results.replaceChildren();
      body.hidden = query !== "";
      results.hidden = query === "";
      if (query) {
        const matches = deps.menus.resolveItems(search.filter(query), context, item.arg);
        renderList(matches, results, context, "No matches", picker);
        track();
        return;
      }
      for (const row of body.querySelectorAll(".highlighted")) row.classList.remove("highlighted");
      preview(undefined);
    });
    flyout.append(input, body, results);
  }

  // A tile applies at once and leaves the menu open; every tile then redraws
  // whether it is on, since one pick can turn another off.
  function renderTiles(sections: MenuTileSection[], into: HTMLElement): void {
    into.classList.add("is-tiles");
    const drawn: { button: HTMLButtonElement; tile: MenuTile }[] = [];
    const redraw = () => {
      for (const { button, tile } of drawn) button.setAttribute("aria-checked", String(tile.checked()));
    };
    for (const section of sections) {
      const group = el("div", "context-menu-tiles");
      group.setAttribute("role", "group");
      group.setAttribute("aria-label", section.label);
      const heading = el("div", "context-menu-tiles-heading");
      heading.setAttribute("aria-hidden", "true");
      heading.textContent = section.label;
      const grid = el("div", "context-menu-tiles-grid");
      for (const tile of section.tiles) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "context-menu-tile";
        button.setAttribute("role", tile.radio ? "menuitemradio" : "menuitemcheckbox");
        const glyph = el("span", "context-menu-tile-glyph");
        glyph.style.setProperty("--glyph", tile.glyph);
        const name = el("span", "context-menu-tile-label");
        name.textContent = tile.label;
        button.append(glyph, name);
        if (tile.tooltip) button.dataset.tooltip = tile.tooltip;
        button.addEventListener("click", () => {
          tile.pick();
          redraw();
        });
        drawn.push({ button, tile });
        grid.append(button);
      }
      group.append(heading, grid);
      if (section.range) group.append(renderRange(section.range));
      into.append(group);
    }
    redraw();
  }

  // The shared slider (settings.css), its value after the label in a slot
  // as wide as either end's, as the stops' names sit, so the label keeps its
  // width as the knob moves.
  function renderRange(range: MenuRange): HTMLElement {
    const row = el("div", "context-menu-tiles-range");
    if (range.tooltip) row.dataset.tooltip = range.tooltip;
    const values = el("span", "context-menu-slider-names");
    const shown = el("span", "context-menu-slider-name current");
    for (const end of [range.min, range.max]) {
      const value = el("span", "context-menu-slider-name");
      value.textContent = `(${range.format(end)})`;
      values.append(value);
    }
    values.append(shown);
    const label = el("span", "context-menu-slider-label");
    label.setAttribute("aria-hidden", "true");
    label.append(range.label, " ", values);
    const input = document.createElement("input");
    input.type = "range";
    input.className = "settings-slider context-menu-tiles-range-input";
    input.min = String(range.min);
    input.max = String(range.max);
    input.step = String(range.step);
    input.value = String(range.value());
    input.setAttribute("aria-label", range.label);
    const show = () => {
      const text = range.format(Number(input.value));
      shown.textContent = `(${text})`;
      input.setAttribute("aria-valuetext", text);
    };
    show();
    input.addEventListener("input", () => {
      show();
      range.change(Number(input.value));
    });
    closeOnEnterOrEscape(input);
    row.append(label, input);
    return row;
  }

  // Enter closes the menu, as a pick would. Escape is taken here first, as
  // the search box takes its own, so a dialog's Escape can't outrank it.
  function closeOnEnterOrEscape(input: HTMLInputElement): void {
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || (event.key === "Escape" && !event.isComposing)) {
        event.preventDefault();
        close();
      }
    });
  }

  // The stops are drawn under a native range input, which brings the
  // keyboard, the pointer and the slider role with it. The name slot stacks
  // every stop's name and shows one, so moving the knob never resizes the
  // menu.
  function renderSlider(slider: MenuSlider): RenderedSlider {
    const row = el("div", "context-menu-slider-row");
    const names = el("span", "context-menu-slider-names");
    const label = el("span", "context-menu-slider-label");
    label.setAttribute("aria-hidden", "true");
    label.append(slider.label, " ", names);
    const track = el("div", "context-menu-slider-track");
    track.style.setProperty("--stops", String(slider.stops.length));
    const input = document.createElement("input");
    input.type = "range";
    input.className = "context-menu-slider-input";
    input.min = "0";
    input.max = String(slider.stops.length - 1);
    input.setAttribute("aria-label", slider.label);
    for (const stop of slider.stops) {
      const name = el("span", "context-menu-slider-name");
      name.textContent = `(${stop.label})`;
      names.append(name);
      track.append(el("span", stop.ring ? "context-menu-slider-stop ring" : "context-menu-slider-stop"));
    }
    const show = () => {
      const index = Number(input.value);
      for (const [at, name] of [...names.children].entries()) name.classList.toggle("current", at === index);
      input.setAttribute("aria-valuetext", slider.stops[index]?.label ?? "");
    };
    const start = slider.stops.findIndex((stop) => stop.value === slider.value);
    input.value = String(Math.max(0, start));
    show();
    input.addEventListener("input", () => {
      show();
      const stop = slider.stops[Number(input.value)];
      if (stop) slider.change(stop.value);
    });
    closeOnEnterOrEscape(input);
    input.addEventListener("blur", () => row.classList.remove("highlighted"));
    track.append(input);
    row.append(label, track);
    const footer = el("div", "context-menu-slider");
    footer.append(row);
    return { footer, row, input };
  }

  function renderList(
    items: ResolvedMenuItem[],
    into: HTMLElement,
    context: CommandContext,
    empty: string,
    picker = false,
  ): void {
    if (items.length === 0) {
      const placeholder = el("div", "context-menu-empty");
      placeholder.textContent = empty;
      into.append(placeholder);
    } else {
      renderItems(items, into, context, picker);
    }
  }

  // The keys the focused `keys` element takes: the arrow keys move a
  // highlight through `rows()`, the pickable top-level rows of whichever
  // list is showing (a flyout parent is hovered, not picked), and Enter
  // picks the highlighted row. Returns what restarts the highlight once the
  // list is drawn anew.
  function navigate(
    keys: HTMLElement,
    rows: () => HTMLElement[],
    filtered: () => boolean,
    slider: RenderedSlider | undefined,
    onHighlight?: (row: HTMLElement | undefined) => void,
  ): () => void {
    // The search box types a space; a focused list picks with it, and lets
    // Tab go on past it, as a select does.
    const typing = keys instanceof HTMLInputElement;
    let highlighted = -1;
    const highlight = () => {
      rows().forEach((row, index) => {
        row.classList.toggle("highlighted", index === highlighted);
        if (index !== highlighted) return;
        row.scrollIntoView?.({ block: "nearest" });
        if (typing) return;
        row.id ||= `context-menu-row-${++rowIds}`;
        keys.setAttribute("aria-activedescendant", row.id);
      });
      onHighlight?.(rows()[highlighted]);
    };
    // Typing jumps to the next row whose label starts with what was typed
    // within a second, as a select's list does; one key pressed again steps
    // through the rows that start with it.
    let typed = "";
    let typedAt = 0;
    const jump = (key: string) => {
      const now = Date.now();
      typed = (now - typedAt > 1000 ? "" : typed) + key.toLocaleLowerCase();
      typedAt = now;
      const all = rows();
      const find = (prefix: string, start: number) => {
        for (let step = 0; step < all.length; step++) {
          const index = (start + step) % all.length;
          if (rowLabels.get(all[index])?.toLocaleLowerCase().startsWith(prefix)) return index;
        }
        return -1;
      };
      let index = find(typed, typed.length === 1 ? highlighted + 1 : Math.max(highlighted, 0));
      if (index < 0 && [...typed].every((char) => char === typed[0])) index = find(typed[0], highlighted + 1);
      if (index < 0) return;
      highlighted = index;
      highlight();
    };
    // A slider under the list is one more stop for ↑/↓, past either end of
    // the rows; there ←/→ move it, and ↑/↓ come back to the list.
    slider?.input.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      event.preventDefault();
      const count = rows().length;
      highlighted = count === 0 ? -1 : event.key === "ArrowDown" ? 0 : count - 1;
      keys.focus();
      highlight();
    });
    keys.addEventListener("keydown", (event) => {
      // Taken here before the keybinding chain, where a dialog outranks a
      // menu: a menu opened inside a dialog would otherwise stay open over
      // it while the dialog closed.
      if (event.key === "Escape" && !event.isComposing) {
        event.preventDefault();
        close();
        return;
      }
      if (event.key === "Tab" && !typing) {
        close();
        return;
      }
      const count = rows().length;
      const down = event.key === "ArrowDown";
      if (slider && (down || event.key === "ArrowUp") && (count === 0 || highlighted === (down ? count - 1 : 0))) {
        event.preventDefault();
        highlighted = -1;
        highlight();
        slider.row.classList.add("highlighted");
        slider.input.focus();
        return;
      }
      if (count === 0) return;
      // A search box keeps Home, End and typed keys for its own text.
      const onList = !typing && event.target === keys && !event.isComposing;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : count - 1;
        highlighted = (highlighted + step) % count;
        highlight();
      } else if (onList && (event.key === "Home" || event.key === "End")) {
        event.preventDefault();
        highlighted = event.key === "Home" ? 0 : count - 1;
        highlight();
      } else if ((event.key === "Enter" || (event.key === " " && !typing)) && highlighted >= 0) {
        event.preventDefault();
        rows()[highlighted]?.click();
      } else if (onList && event.key.length === 1 && event.key !== " " && !event.ctrlKey && !event.metaKey) {
        event.preventDefault();
        jump(event.key);
      }
    });
    return () => {
      rows().forEach((row, index) => {
        row.addEventListener("mouseenter", () => {
          highlighted = index;
          highlight();
        });
      });
      // Unfiltered, the highlight starts on the checked row, so a long list
      // opens on the current choice rather than its first row.
      const checked = filtered() ? -1 : rows().findIndex((row) => row.getAttribute("aria-checked") === "true");
      highlighted = checked >= 0 ? checked : rows().length > 0 ? 0 : -1;
      highlight();
    };
  }

  // The search box replaces the tree with a flat, filtered list while it
  // has a query.
  function renderSearch(
    options: MenuOpenOptions,
    context: CommandContext,
    body: HTMLElement,
    into: HTMLElement,
    slider: RenderedSlider | undefined,
  ): HTMLInputElement | undefined {
    const search = options.search;
    if (!search) return undefined;
    const input = document.createElement("input");
    input.type = "text";
    input.className = "context-menu-search";
    input.placeholder = search.placeholder;
    const results = el("div", "context-menu-results");
    results.hidden = true;
    const rows = () => [...(results.hidden ? body : results).querySelectorAll<HTMLElement>(":scope > button:enabled")];
    const track = navigate(input, rows, () => !results.hidden, slider);
    input.addEventListener("input", () => {
      const query = input.value.trim();
      results.replaceChildren();
      body.hidden = query !== "";
      results.hidden = query === "";
      if (query) {
        const matches = deps.menus.resolveItems(search.filter(query), context, options.arg);
        renderList(matches, results, context, options.empty ?? "No matches", options.picker);
      }
      track();
    });
    into.append(input, body, results);
    input.value = search.query ?? "";
    input.dispatchEvent(new Event("input"));
    return input;
  }

  function place(element: HTMLElement, options: MenuOpenOptions): void {
    let left: number;
    let top: number;
    if (options.at === "top") {
      left = (window.innerWidth - element.offsetWidth) / 2;
      top = Math.round(window.innerHeight * 0.12);
    } else if (options.anchor) {
      const rect = options.anchor.getBoundingClientRect();
      // A picker's list scrolls, so where neither side holds it whole it
      // takes the roomier one, shortened to fit, rather than covering the
      // anchor that names its value.
      if (options.picker) {
        element.style.minWidth = `${Math.max(rect.width, element.offsetWidth)}px`;
        const room = Math.max(window.innerHeight - rect.bottom, rect.top) - 2 * VIEWPORT_MARGIN;
        if (element.offsetHeight > room) element.style.maxHeight = `${room}px`;
      }
      top = rect.bottom + VIEWPORT_MARGIN;
      // Above an anchor with no room below it, as every anchored popover
      // opens. A searchable one then keeps the size it opened at: filtering
      // shortens it from the bottom, which would lift it off the anchor.
      if (top + element.offsetHeight > window.innerHeight - VIEWPORT_MARGIN) {
        top = rect.top - VIEWPORT_MARGIN - element.offsetHeight;
        if (options.search) {
          element.style.minWidth = `${element.offsetWidth}px`;
          element.style.minHeight = `${element.offsetHeight}px`;
        }
      }
      left = options.align === "end" ? rect.right - element.offsetWidth : rect.left;
      // Under the anchor after all where there's no room on its left.
      const besideLeft = rect.left - VIEWPORT_MARGIN - element.offsetWidth;
      if (options.beside && besideLeft >= VIEWPORT_MARGIN) {
        const firstRow = element.querySelector<HTMLElement>("button, .context-menu-item");
        left = besideLeft;
        top = rect.top - (firstRow ? firstRow.getBoundingClientRect().top - element.getBoundingClientRect().top : 0);
      }
    } else {
      left = options.at?.x ?? 0;
      top = options.at?.y ?? 0;
    }
    // Kept on screen: a right-click near an edge would otherwise open the
    // menu half outside the viewport.
    left = Math.max(VIEWPORT_MARGIN, Math.min(left, window.innerWidth - element.offsetWidth - VIEWPORT_MARGIN));
    top = Math.max(VIEWPORT_MARGIN, Math.min(top, window.innerHeight - element.offsetHeight - VIEWPORT_MARGIN));
    element.style.left = `${left}px`;
    element.style.top = `${top}px`;
    // A flyout opens to the right, which a menu at the viewport's right edge
    // (the editor's own ⋮ button) has no room for, and one that would run
    // past the bottom edge is lifted to end at it. Decided here, once, so
    // the flyout never moves under the pointer; it is hidden until hovered,
    // so it is shown for the measurement alone.
    const right = left + element.offsetWidth;
    for (const flyout of element.querySelectorAll<HTMLElement>(".has-submenu > .context-submenu")) {
      flyout.style.display = "flex";
      const { offsetWidth: width, offsetTop: lifted } = flyout;
      const box = flyout.getBoundingClientRect();
      flyout.style.removeProperty("display");
      const opensLeft = right + width + VIEWPORT_MARGIN > window.innerWidth;
      flyout.parentElement?.classList.toggle("opens-left", opensLeft);
      // A search's matches may run wider than its rows: it keeps the width
      // it opens at, and widens only into the room on its side.
      if (flyout.classList.contains("has-search")) {
        const room = opensLeft ? left - VIEWPORT_MARGIN : window.innerWidth - right - VIEWPORT_MARGIN;
        flyout.style.minWidth = `${width}px`;
        flyout.style.maxWidth = `${Math.max(width, room)}px`;
      }
      const overflow = Math.min(box.bottom - (window.innerHeight - VIEWPORT_MARGIN), box.top - VIEWPORT_MARGIN);
      if (overflow > 0) flyout.style.top = `${lifted - overflow}px`;
    }
  }

  const menu: ContextMenu = {
    open(options) {
      close();
      const opener = document.activeElement;
      const context = deps.context();
      const element = el("div", "context-menu");
      if (options.className) element.classList.add(...options.className.split(/\s+/).filter(Boolean));
      element.setAttribute("role", "menu");
      if (options.ariaLabel) element.setAttribute("aria-label", options.ariaLabel);
      const items = [
        ...(options.items ? deps.menus.resolveItems(options.items, context, options.arg) : []),
        ...(options.menu ? deps.menus.resolve(options.menu, context, options.arg) : []),
        ...(options.itemsAfter ? deps.menus.resolveItems(options.itemsAfter, context, options.arg) : []),
      ];
      // Rows sit directly in the menu; a searchable menu wraps them so the
      // search box can swap the whole list for its results.
      const body = options.search ? el("div", "context-menu-items") : element;
      renderList(items, body, context, options.empty ?? "Nothing to do here", options.picker);
      const slider = options.slider ? renderSlider(options.slider) : undefined;
      const search = renderSearch(options, context, body, element, slider);
      const list = !search && options.picker ? element : undefined;
      if (list) {
        list.tabIndex = -1;
        const rows = () => [...list.querySelectorAll<HTMLElement>(":scope > button:enabled")];
        navigate(list, rows, () => false, slider)();
      }
      if (slider) element.append(slider.footer);
      // Full screen shows the full-screen element alone, so a menu opened
      // there, a video player's, goes inside it: on the page it would open
      // unseen.
      (document.fullscreenElement ?? document.body).append(element);
      place(element, options);
      (search ?? list)?.focus({ preventScroll: true });
      // Highlighted before the menu was on screen, where it couldn't scroll.
      element.querySelector<HTMLElement>(".highlighted")?.scrollIntoView?.({ block: "nearest" });

      const session = new DisposableStore();
      // Armed after this event turn, so the click that opened the menu
      // can't be the one that closes it. The anchor is exempt: its own
      // click handler toggles, and a pointerdown there closing the menu
      // first would make that click reopen it.
      const arm = window.setTimeout(() => {
        session.add(
          listen(
            document,
            "pointerdown",
            (event) => {
              const target = event.target as Node;
              if (element.contains(target) || options.anchor?.contains(target)) return;
              close();
            },
            true,
          ),
        );
      }, 0);
      session.add(() => window.clearTimeout(arm));
      session.add(listen(window, "resize", close));
      // Pointing at a row previews it, and any other row, or leaving the
      // menu, ends that. A flyout's search box or slider gives up its focus
      // to a row outside its flyout, which then closes as any flyout does.
      session.add(
        listen(element, "mouseover", (event) => {
          const row = (event.target as Element).closest<HTMLElement>("button, .context-menu-item");
          preview(row ? previews.get(row) : undefined);
          const focused = document.activeElement;
          const held = ".context-submenu > .context-menu-search, .context-menu-tiles-range-input";
          if (!(focused instanceof HTMLElement) || !focused.matches(held)) return;
          const owner = focused.closest(".has-submenu");
          if (owner && row && !owner.contains(row)) focused.blur();
        }),
      );
      session.add(listen(element, "mouseleave", () => preview(undefined)));
      // A key typed while a flyout's search box shows goes into it, ahead of
      // whatever else listens for keys: a player's shortcuts, a note's editor.
      // A field in the menu types its own.
      session.add(
        listen(
          window,
          "keydown",
          (sent) => {
            const event = sent as KeyboardEvent;
            if (event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
            if (event.key.length !== 1 || event.key === " ") return;
            if (event.target instanceof Node && element.contains(event.target)) return;
            const shown = [...element.querySelectorAll<HTMLElement>(".context-submenu.has-search")].find(
              (flyout) => getComputedStyle(flyout).display !== "none",
            );
            const input = shown?.querySelector<HTMLInputElement>(":scope > .context-menu-search");
            if (!input) return;
            event.preventDefault();
            event.stopPropagation();
            input.focus({ preventScroll: true });
            input.value += event.key;
            input.dispatchEvent(new Event("input"));
          },
          true,
        ),
      );
      options.anchor?.setAttribute("aria-expanded", "true");
      open = { element, anchor: options.anchor, opener, session };
    },
    close,
    isOpen: (anchor) => open !== undefined && (anchor === undefined || open.anchor === anchor),
    dispose() {
      close();
      store.dispose();
    },
  };
  // A right-click on a path chip opens Copy path, and one on text that
  // selects, which nothing nearer has taken, opens the text menu in the
  // browser's place. The chip's listener goes first, or a chip in a chat
  // note would open Copy and Select All.
  store.add(installPathChipMenu({ commands: deps.commands, menus: deps.menus, menu }));
  store.add(installTextMenu(menu));
  return menu;
}
