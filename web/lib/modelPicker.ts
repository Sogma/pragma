// A model picker: a picker naming a model by its provider's mark and its own
// name, and the searchable menu it opens, grouped by provider. The chat
// composer, Settings and a Flow's model fields each draw one.
import type { EffortLevel, GroupedModelOption, ModelProviderSummary } from "../core/apiClient.ts";
import type { ContextMenuService, MenuItem, MenuSlider } from "../services/menus.ts";
import { EFFORT_LABEL, effortName } from "./effort.ts";
import { createPickerButton, setPickerName, togglePickerMenu } from "./picker.ts";
import { goToSettingsLabel } from "./settingLink.ts";

export type ModelKind = "text" | "image" | "video";

export interface ModelList {
  models: GroupedModelOption[];
  providers: ModelProviderSummary[];
  // Servers whose list couldn't be read, and why.
  failures?: { server: string; message: string }[];
}

// The menu row that picks "" to follow the default, and what the button's
// tooltip calls that default. The row is a noun like its checked neighbours,
// the menu already saying which kind. Callers name only the kind: wording
// passed in per picker drifted apart once already.
const DEFAULT_ROW = "Default";
const DEFAULT_NAMES: Record<ModelKind, string> = {
  text: "Default model",
  image: "Default image model",
  video: "Default video model",
};

// What a default reads as when there is none, on Settings' buttons and rows.
export const NONE_LABEL = "None";

// What one picker's menu holds beyond the list.
export interface ModelMenu {
  // The pick to check, and what picking a ref does.
  stored: string;
  pick(ref: string): void;
  // The row that picks "" to follow the default, `fallback`.
  defaultRow?: { fallback: string };
  // Settings' defaults: the row that picks none, after which every call must
  // name its own model.
  noneRow?: boolean;
  // The way into Settings → AI Models, for a menu opened outside it.
  settingsRow?: boolean;
  // What the menu says with no rows at all.
  empty?: string;
  // Pinned under the list: chat's effort, for a model that takes levels.
  slider?: MenuSlider;
}

/**
 * A model menu: the default's row or the none row where there is one, each
 * provider's models under a heading wearing its mark, then the way to
 * Settings where there is one. A query keeps the models whose name or
 * provider holds it; a stored model no provider lists stays as a flagged row.
 */
export function modelMenuItems(list: ModelList, menu: ModelMenu, query = ""): MenuItem[] {
  const needle = query.trim().toLowerCase();
  const matches = (...texts: string[]) => texts.some((text) => text.toLowerCase().includes(needle));
  const pick = (label: string, ref: string, extra: Partial<MenuItem>): MenuItem => ({
    label,
    run: () => menu.pick(ref),
    checked: () => menu.stored === ref,
    ...extra,
  });
  const heading = (provider: ModelProviderSummary): MenuItem => ({
    label: provider.label,
    icon: true,
    group: provider.id,
    data: { vendor: provider.vendor ?? "" },
  });
  const items: MenuItem[] = [];
  if (menu.defaultRow && matches(DEFAULT_ROW)) {
    const { fallback } = menu.defaultRow;
    const detail = list.models.find((model) => model.id === fallback)?.model ?? (fallback || NONE_LABEL);
    items.push(pick(DEFAULT_ROW, "", { group: "default", detail }));
  }
  // Offered once there is something to choose between: with no models and
  // nothing stored, the menu's `empty` line says how to get one instead.
  if (menu.noneRow && (list.models.length > 0 || menu.stored !== "") && matches(NONE_LABEL)) {
    items.push(pick(NONE_LABEL, "", { group: "none" }));
  }
  for (const provider of list.providers) {
    const models = list.models.filter(
      (model) => model.provider === provider.id && matches(model.model, provider.label),
    );
    if (models.length === 0) continue;
    items.push(heading(provider));
    for (const model of models) items.push(pick(model.model, model.id, { icon: true, group: provider.id }));
  }
  // A server whose list couldn't be read says so under its heading, the
  // reason on hover, rather than its models going missing without a word.
  for (const failure of needle ? [] : (list.failures ?? [])) {
    const provider = list.providers.find((entry) => entry.id === failure.server);
    items.push(heading(provider ?? { id: failure.server, label: failure.server }), {
      label: "Couldn't list its models",
      icon: true,
      group: failure.server,
      className: "model-menu-note",
      data: { tooltip: failure.message },
    });
  }
  if (menu.stored && !list.models.some((model) => model.id === menu.stored) && matches(menu.stored)) {
    items.push(pick(`${menu.stored} (not configured)`, menu.stored, { group: "unlisted" }));
  }
  if (menu.settingsRow && !needle) {
    items.push({ command: "settings.open", arg: "models", label: goToSettingsLabel("models"), group: "settings" });
  }
  return items;
}

export interface PickerText {
  // Its accessible name, ahead of the model's: "Chat model".
  role: string;
  // What it reads with no model to name.
  none: string;
  // Set while the ref named is only the kind's default, followed.
  follows?: ModelKind;
  // The effort the model runs at, named after it on a button with the slot
  // for it; absent at the model's own default.
  effort?: EffortLevel;
}

/**
 * Names `ref` on a picker button: its model's own name and its provider's
 * mark. A ref no provider lists is flagged, but only once `list` has
 * arrived, before which the two can't be told apart. A blank ref names
 * nothing until then either: the default it follows comes with the list.
 */
export function renderModelPicker(
  button: HTMLButtonElement,
  ref: string,
  list: ModelList | undefined,
  text: PickerText,
): void {
  const model = list?.models.find((entry) => entry.id === ref);
  const provider = model && list?.providers.find((entry) => entry.id === model.provider);
  const unlisted = list !== undefined && ref !== "" && !model;
  const name = model?.model ?? (ref ? ref.slice(ref.indexOf("/") + 1) : list ? text.none : "");
  setPickerName(button, name);
  const effort = text.effort && effortName(text.effort);
  const effortSlot = button.querySelector<HTMLElement>(".model-picker-effort");
  if (effortSlot) {
    effortSlot.textContent = effort ? `· ${effort}` : "";
    effortSlot.hidden = !effort;
  }
  const effortNote = effort ? `, ${EFFORT_LABEL} ${effort}` : "";
  button.setAttribute("aria-label", name ? `${text.role}: ${name}${effortNote}` : text.role);
  button.classList.toggle("unconfigured", unlisted);
  if (provider || unlisted) button.dataset.vendor = provider?.vendor ?? "";
  else delete button.dataset.vendor;
  const label = model?.label ?? (unlisted ? `${ref} (not configured)` : ref);
  if (label) button.dataset.tooltip = text.follows ? `${DEFAULT_NAMES[text.follows]}: ${label}` : label;
  else delete button.dataset.tooltip;
}

/** Opens `menu` under `button`, or closes it when it is open there already. */
export function toggleModelMenu(
  contextMenu: ContextMenuService,
  button: HTMLElement,
  list: ModelList,
  menu: ModelMenu,
  options: { ariaLabel: string; align?: "start" | "end" },
): void {
  togglePickerMenu(contextMenu, button, {
    items: (query) => modelMenuItems(list, menu, query),
    search: "Search models…",
    ariaLabel: options.ariaLabel,
    align: options.align,
    className: "model-menu",
    empty: menu.empty,
    slider: menu.slider,
  });
}

// A model picker built in code, for a surface with no markup of its own to
// find one in; the chat's and Settings' are in index.html.
export function createModelPickerButton(className: string): HTMLButtonElement {
  const button = createPickerButton(className ? `model-picker ${className}` : "model-picker");
  const mark = document.createElement("span");
  mark.className = "provider-mark";
  mark.setAttribute("aria-hidden", "true");
  button.prepend(mark);
  const effort = document.createElement("span");
  effort.className = "model-picker-effort";
  effort.hidden = true;
  button.querySelector(".picker-name")?.after(effort);
  return button;
}
