// A font picker: a picker whose menu draws each font's name in that font. It
// lists the fonts a setting ships with, then the fonts installed here where
// the browser can list them; where it can't, it takes a font's name typed
// into its search box, checked against what this browser can draw.
import type { ContextMenuService, MenuItem } from "../services/menus.ts";
import type { Setting } from "../services/settings.ts";
import { createPickerButton, openPickerMenu, setPickerName } from "./picker.ts";

/** A font a setting ships with or names itself: Courier Prime, System monospace. */
export interface FontChoice {
  // What the setting stores.
  value: string;
  label: string;
  // The CSS font-family its row is drawn in.
  font: string;
  // Known, not measured: a bundled font may not have loaded yet.
  monospaced: boolean;
  // Stands in for a font the browser's list names itself, as the system's
  // code font does: offered only where nothing is listed, or while stored.
  standIn?: boolean;
}

/** Measures `text` set in `font`, a CSS font shorthand. */
export type MeasureText = (text: string, font: string) => number;

/** The fonts installed here, and what this browser can draw of them. */
export interface InstalledFonts {
  // The installed families, sorted, listed once; undefined where the
  // browser can't list them or the person said no. A browser that asks
  // first asks only from a click, so the first call must come from one.
  list(): Promise<string[] | undefined>;
  // Lists and measures the fonts before the menu needs them, a few at a
  // time while the page is idle, wherever listing asks nothing: the desktop
  // app, or a browser already allowed. Loading each font to measure it is
  // most of a first open's wait.
  warm(): void;
  // Whether a font of that name draws here: installed, and one this
  // browser lets a page use.
  draws(family: string): boolean;
  // Whether its letters all take one width.
  monospaced(family: string): boolean;
}

export interface InstalledFontsDeps {
  // The browser's list of the faces installed, where it has one.
  query?: () => Promise<{ family: string }[]>;
  measure?: MeasureText;
  // Whether listing would go ahead without asking.
  permitted?: () => Promise<boolean>;
}

/** A family as a CSS font-family string, quoted so any name stays one. */
export function cssFamily(family: string): string {
  return `"${family.replace(/["\\]/g, "\\$&")}"`;
}

/** An installed family as text is set in it, the system's sans-serif drawing
 * any letter it lacks: never the interface's font, which a note must not
 * follow. */
export function installedFamily(family: string): string {
  return `${cssFamily(family)}, var(--font-system)`;
}

function browserQuery(): InstalledFontsDeps["query"] {
  const local = window as { queryLocalFonts?: () => Promise<{ family: string }[]> };
  return local.queryLocalFonts ? () => local.queryLocalFonts?.() ?? Promise.resolve([]) : undefined;
}

async function browserPermitted(): Promise<boolean> {
  try {
    const status = await navigator.permissions.query({ name: "local-fonts" as PermissionName });
    return status.state === "granted";
  } catch {
    return false;
  }
}

function canvasMeasure(): MeasureText | undefined {
  const context = document.createElement("canvas").getContext("2d");
  if (!context) return undefined;
  return (text, font) => {
    context.font = font;
    return context.measureText(text).width;
  };
}

// Safari has no idle callback.
function whenIdle(step: () => void): void {
  if (typeof window.requestIdleCallback === "function") window.requestIdleCallback(() => step());
  else setTimeout(step, 0);
}

const SAMPLE = "mmmmmmmmmmlli1WQ@";
const GENERICS = ["monospace", "sans-serif", "serif"];
// Fonts measured per idle moment while warming: each first use loads the
// font, a couple of milliseconds apiece.
const WARM_BATCH = 8;

export function createInstalledFonts(deps: InstalledFontsDeps = {}): InstalledFonts {
  const query = "query" in deps ? deps.query : browserQuery();
  const permitted = deps.permitted ?? browserPermitted;
  let measure: MeasureText | undefined | null = deps.measure ?? null;
  const measured = (text: string, font: string) => {
    if (measure === null) measure = canvasMeasure();
    return measure?.(text, font);
  };
  let listed: Promise<string[] | undefined> | undefined;
  let warming = false;
  const draws = new Map<string, boolean>();
  const monospacedFonts = new Map<string, boolean>();

  function list(): Promise<string[] | undefined> {
    if (!query) return Promise.resolve(undefined);
    // Neither a refusal nor an empty answer, which a dismissed prompt can
    // give, is kept: the menu takes typed names meanwhile, and the next
    // open asks again, or gets the browser's remembered no at once.
    const none = () => {
      listed = undefined;
      return undefined;
    };
    listed ??= new Promise<{ family: string }[]>((resolve) => resolve(query())).then((faces) => {
      const families = [...new Set(faces.map((face) => face.family))]
        .filter((family) => family !== "" && !/^[.@]/.test(family))
        .sort((a, b) => a.localeCompare(b));
      return families.length > 0 ? families : none();
    }, none);
    return listed;
  }

  // Measured over serif, so a font with no Latin letters at all, falling
  // back for each, isn't taken for a monospaced one.
  function monospaced(family: string): boolean {
    let known = monospacedFonts.get(family);
    if (known === undefined) {
      const font = `72px ${cssFamily(family)}, serif`;
      const narrow = measured("iiiiiiiiii", font);
      const wide = measured("WWWWWWWWWW", font);
      known = narrow === undefined || wide === undefined || Math.abs(narrow - wide) < 1;
      monospacedFonts.set(family, known);
    }
    return known;
  }

  return {
    list,
    warm() {
      if (warming || !query) return;
      warming = true;
      void permitted()
        .then((allowed) => (allowed ? list() : undefined))
        .then((families) => {
          const pending = (families ?? []).filter((family) => !monospacedFonts.has(family));
          const step = () => {
            for (const family of pending.splice(0, WARM_BATCH)) monospaced(family);
            if (pending.length > 0) whenIdle(step);
          };
          if (families) step();
          else warming = false;
        });
    },
    // A missing font falls back to the generic family after it, so a name
    // that measures as each of three generics does is one nothing draws.
    draws(family) {
      let known = draws.get(family);
      if (known === undefined) {
        known = GENERICS.some((generic) => {
          const own = measured(SAMPLE, `72px ${cssFamily(family)}, ${generic}`);
          return own === undefined || own !== measured(SAMPLE, `72px ${generic}`);
        });
        draws.set(family, known);
      }
      return known;
    },
    monospaced,
  };
}

/** What one font picker's menu holds. */
export interface FontMenu {
  // The value to check, and what picking a value does.
  stored: string;
  pick(value: string): void;
  // The value marked with a dot.
  defaultValue: string;
  // Listed among the installed fonts.
  builtIn: FontChoice[];
  fonts: InstalledFonts;
  // For a setting whose layout assumes letters of one width, as a
  // screenplay's page does: the monospaced fonts come first, and a typed
  // font that isn't one says so.
  monospace: boolean;
}

const DEFAULT_MARK = "Default";
const NOT_INSTALLED = "Not installed";
const NOT_MONOSPACED = "Not monospaced";

/**
 * A font menu's rows: the stored font first when nothing else lists it,
 * then the built-in and installed fonts in one alphabetical list. Where the
 * browser lists none, a query offers the name typed instead, so any font
 * can still be picked by name.
 */
export function fontMenuItems(menu: FontMenu, installed: string[] | undefined, query = ""): MenuItem[] {
  const needle = query.trim().toLowerCase();
  const matches = (label: string) => label.toLowerCase().includes(needle);
  const builtInNames = new Set(menu.builtIn.map((choice) => choice.label.toLowerCase()));
  const families = (installed ?? []).filter((family) => !builtInNames.has(family.toLowerCase()));
  const listed = new Set([...builtInNames, ...families.map((family) => family.toLowerCase())]);
  const stored = menu.stored.toLowerCase();
  // A family's case is the person's to type: CSS matches names without it.
  const row = (choice: FontChoice, group: string, detail?: string): MenuItem => ({
    label: choice.label,
    font: choice.font,
    group,
    detail,
    mark: choice.value === menu.defaultValue ? DEFAULT_MARK : undefined,
    run: () => menu.pick(choice.value),
    checked: () => stored === choice.value.toLowerCase(),
  });
  // A named font no list holds says what's wrong with it.
  const named = (family: string, group: string): MenuItem => {
    const detail = !menu.fonts.draws(family)
      ? NOT_INSTALLED
      : menu.monospace && !menu.fonts.monospaced(family)
        ? NOT_MONOSPACED
        : undefined;
    return row({ value: family, label: family, font: installedFamily(family), monospaced: false }, group, detail);
  };

  const items: MenuItem[] = [];
  const storedFamily =
    menu.stored !== "" && !menu.builtIn.some((choice) => choice.value === menu.stored) && !listed.has(stored);
  if (storedFamily && matches(menu.stored)) items.push(named(menu.stored, "stored"));
  const fonts: FontChoice[] = [
    ...menu.builtIn.filter((choice) => !choice.standIn || installed === undefined || choice.value === menu.stored),
    ...families.filter(matches).map((family) => ({
      value: family,
      label: family,
      font: installedFamily(family),
      monospaced: menu.monospace && menu.fonts.monospaced(family),
    })),
  ]
    .filter((choice) => matches(choice.label))
    .sort((a, b) => a.label.localeCompare(b.label));
  const groups =
    installed !== undefined && menu.monospace
      ? [
          { heading: "Monospaced", fonts: fonts.filter((choice) => choice.monospaced) },
          { heading: "Other fonts", fonts: fonts.filter((choice) => !choice.monospaced) },
        ]
      : [{ heading: undefined, fonts }];
  for (const [index, { heading, fonts: shown }] of groups.entries()) {
    if (shown.length === 0) continue;
    const group = `fonts-${index}`;
    if (heading) items.push({ label: heading, group });
    for (const choice of shown) items.push(row(choice, group));
  }
  const typed = query.trim();
  if (typed && installed === undefined && !listed.has(needle) && needle !== stored) {
    const item = named(typed, "typed");
    if (item.detail === NOT_INSTALLED) item.disabled = () => true;
    items.push(item);
  }
  return items;
}

/** Opens a font menu under `button`, or closes it when it is open there
 * already. The installed fonts are listed before it opens: a browser that
 * asks first does so now, and the menu opens on the answer. */
export function toggleFontMenu(
  contextMenu: ContextMenuService,
  button: HTMLElement,
  menu: FontMenu,
  ariaLabel: string,
): void {
  if (contextMenu.isOpen(button)) {
    contextMenu.close();
    return;
  }
  void menu.fonts.list().then((installed) => {
    // Settings may have closed while the browser asked.
    if (!button.isConnected || button.checkVisibility?.() === false) return;
    openPickerMenu(contextMenu, button, {
      items: (query) => fontMenuItems(menu, installed, query),
      search: "Search or type a font name",
      ariaLabel,
      align: "end",
      className: "font-menu",
    });
  });
}

/** One font preference's Settings row: what it stores, and its menu. */
export interface FontSetting {
  // The row's name: "Font" where the page around it says whose font it is.
  title?: string;
  setting: Setting<string>;
  defaultValue: string;
  builtIn: FontChoice[];
  // As FontMenu's.
  monospace: boolean;
  fonts: InstalledFonts;
  contextMenu: ContextMenuService;
  // What the font is for, where the page around the row doesn't say.
  description?: string;
  // The reset's accessible name, saying whose font it puts back.
  resetLabel: string;
}

// The same reset arrow, tooltip and place as Font size's.
const RESET_ICON =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 4v6h6" /><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" /></svg>';

function div(className: string, text?: string): HTMLDivElement {
  const element = document.createElement("div");
  element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

/** A Font row, the same on every page that has one. */
export function fontSettingRow(options: FontSetting): HTMLDivElement {
  const { setting, defaultValue, builtIn, fonts, title = "Font" } = options;
  const text = div("field-row-text");
  text.append(div("field-row-title", title));
  if (options.description) text.append(div("field-row-description", options.description));
  const reset = document.createElement("button");
  reset.type = "button";
  reset.className = "icon-button";
  reset.dataset.tooltip = "Reset to default";
  reset.setAttribute("aria-label", options.resetLabel);
  reset.innerHTML = RESET_ICON;
  const picker = createPickerButton("form-input settings-select settings-wide-picker");
  const control = div("field-row-control");
  control.append(reset, picker);
  const row = div("field-row");
  row.append(text, control);

  // At the default the button says what it does, and nothing is there to
  // reset; a font picked over it is named, with the way back. The reset
  // keeps its place while hidden: it stands taller than the button, so the
  // row would grow on every pick.
  const name = (value: string) => builtIn.find((choice) => choice.value === value)?.label ?? value;
  setting.subscribe((value) => {
    const atDefault = value === defaultValue;
    setPickerName(picker, atDefault ? "Change font" : name(value));
    if (atDefault) picker.removeAttribute("aria-label");
    else picker.setAttribute("aria-label", `${title}: ${name(value)}`);
    reset.style.visibility = atDefault ? "hidden" : "";
  });
  // Reaching for the button is the moment to list and measure the fonts.
  picker.addEventListener("pointerenter", () => fonts.warm());
  picker.addEventListener("focus", () => fonts.warm());
  picker.addEventListener("click", () => {
    const pick = (value: string) => setting.set(value);
    const menu = { stored: setting.get(), pick, defaultValue, builtIn, fonts, monospace: options.monospace };
    toggleFontMenu(options.contextMenu, picker, menu, title);
  });
  reset.addEventListener("click", () => setting.set(defaultValue));
  return row;
}
