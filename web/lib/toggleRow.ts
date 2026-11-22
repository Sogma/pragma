// The app's switch: built for any surface, bound to a boolean setting (on
// pages built in script as well as the ones written in web/index.html), and
// the Settings row around one.
import type { Setting } from "../services/settings.ts";
import { el } from "./dom.ts";

export interface ToggleBinding {
  /** What the preference does, run at startup as well as on every change, so
   * it is never in force without the button showing it or the reverse. */
  apply?(value: boolean): void;
  /** A one-off repair that only a *change* calls for, never startup — it acts
   * on state the writer built up under the old setting, which at startup
   * doesn't exist yet. */
  onChange?(value: boolean): void;
}

/** A switch named `label`, showing `checked`. Every switch built in script
 * comes from here, so none goes without a name for a screen reader. Given
 * `onChange`, a click flips it and reports the new state; without one, the
 * caller binds the click. */
export function createSwitch(label: string, checked = false, onChange?: (checked: boolean) => void): HTMLButtonElement {
  const button = el("button", "toggle-switch");
  button.type = "button";
  button.setAttribute("role", "switch");
  button.setAttribute("aria-label", label);
  button.setAttribute("aria-checked", String(checked));
  button.append(el("span", "toggle-knob"));
  if (onChange) {
    button.addEventListener("click", () => {
      const next = button.getAttribute("aria-checked") !== "true";
      button.setAttribute("aria-checked", String(next));
      onChange(next);
    });
  }
  return button;
}

/** A checkbox-style control: reflects `setting` on the button's
 * `aria-checked` and applies it, now and on every change, and flips it on
 * click. It follows the setting rather than the click, so a server-held
 * value that loads late or a refused save that flips back still shows. */
export function bindToggle(button: HTMLElement, setting: Setting<boolean>, binding: ToggleBinding = {}): void {
  setting.subscribe((value) => {
    button.setAttribute("aria-checked", String(value));
    binding.apply?.(value);
  });
  button.addEventListener("click", () => {
    const next = !setting.get();
    setting.set(next);
    binding.onChange?.(next);
  });
}

export interface ToggleRow extends ToggleBinding {
  /** The switch's name, and the row's title unless `shownTitle` takes its
   * place. */
  title: string;
  /** Shown as the row's title where the dialog around it already names the
   * switch; the switch keeps `title` as its name for a screen reader. */
  shownTitle?: Node;
  description: string;
  setting: Setting<boolean>;
}

/** A Settings row: its name and what it does, and a switch for `setting`. */
export function toggleSettingRow(options: ToggleRow): HTMLDivElement {
  const title = document.createElement("div");
  title.className = "field-row-title";
  if (options.shownTitle) title.append(options.shownTitle);
  else title.textContent = options.title;
  const description = document.createElement("div");
  description.className = "field-row-description";
  description.textContent = options.description;
  const text = document.createElement("div");
  text.className = "field-row-text";
  text.append(title, description);
  const button = createSwitch(options.title);
  bindToggle(button, options.setting, options);
  const row = document.createElement("div");
  row.className = "field-row";
  row.append(text, button);
  return row;
}
