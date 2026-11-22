// An anchored color-picker popover: a grid of preset swatches over a custom
// hex entry, kept standalone so any surface can use it (the `.table.html`
// `color` column is one). It owns its whole DOM lifecycle — created on open,
// removed on close, dismissed on outside pointer-down / Escape / resize — so
// a call site adds no markup of its own.

import { normalizeHexColor } from "../src/protocol/types.ts";
import { positionPopover } from "./lib/flyout.ts";
import { LOGO_COLORS } from "./lib/logoColors.ts";
import type { CommandRegistry } from "./services/commands.ts";
import type { KeybindingRegistry } from "./services/keybindings.ts";

export interface ColorPickerOptions {
  /** The element the popover points at — placed just below it, flipped
   * above when there isn't room. */
  anchor: HTMLElement;
  /** Current value: a hex string (`#rgb`/`#rrggbb`, any case) or "". A value
   * matching a preset shows that swatch selected; any other non-empty value
   * pre-fills (and auto-expands) the custom field. */
  value: string;
  /** Fired once, when the user picks — a canonical lowercase `#rrggbb`
   * string, or "" for "No color". The popover closes itself immediately
   * after. */
  onPick: (value: string) => void;
}

interface Preset {
  name: string;
  hex: string;
}

// The logo's colors as the strong row, under a pale row that keeps each
// strong hue at one shared lightness, column by column. The logo's teal is
// left out because it shares cyan's hue; Purple fills the logo's gap between
// blue and crimson; Light crimson leans pink to stay apart from Light red.
// 9 per row — see COLUMNS, which the arrow-key navigation below also reads.
const COLUMNS = 9;
const PRESET_COLORS: Preset[] = [
  { name: "Light red", hex: "#fcd5ce" },
  { name: "Light orange", hex: "#fee0c9" },
  { name: "Light yellow", hex: "#fcedc1" },
  { name: "Light green", hex: "#ceecd5" },
  { name: "Light cyan", hex: "#c8eff3" },
  { name: "Light blue", hex: "#cae3f9" },
  { name: "Light purple", hex: "#e6d9f8" },
  { name: "Light crimson", hex: "#f9d4e3" },
  { name: "Gray", hex: "#9b9a97" },
  { name: "Red", hex: LOGO_COLORS.red },
  { name: "Orange", hex: LOGO_COLORS.orange },
  { name: "Yellow", hex: LOGO_COLORS.yellow },
  { name: "Green", hex: LOGO_COLORS.green },
  { name: "Cyan", hex: LOGO_COLORS.cyan },
  { name: "Blue", hex: LOGO_COLORS.blue },
  { name: "Purple", hex: "#9751d7" },
  { name: "Crimson", hex: LOGO_COLORS.crimson },
];

// Only ever one open at a time — a fresh open closes the previous, and the
// close handler nulls this back out.
let teardown: (() => void) | null = null;

function isPreset(hex: string): boolean {
  return PRESET_COLORS.some((preset) => preset.hex === hex);
}

/** Opens the popover anchored to `anchor`. A second call (or any of the
 * dismiss paths) closes whatever's open first. */
export function openColorPicker({ anchor, value, onPick }: ColorPickerOptions): void {
  closeColorPicker();

  const current = normalizeHexColor(value);

  const popover = document.createElement("div");
  popover.className = "popover color-picker";
  popover.setAttribute("role", "dialog");
  popover.setAttribute("aria-label", "Choose a color");

  const commit = (next: string): void => {
    onPick(normalizeHexColor(next));
    closeColorPicker();
  };

  // --- Preset grid -----------------------------------------------------------
  const grid = document.createElement("div");
  grid.className = "color-picker-grid";
  const swatches: HTMLButtonElement[] = [];

  const addSwatch = (opts: { hex: string; label: string; empty?: boolean }): void => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "color-picker-swatch";
    if (opts.empty) button.classList.add("is-empty");
    button.style.setProperty("--swatch", opts.hex || "transparent");
    button.setAttribute("aria-label", opts.label);
    if (opts.empty ? current === "" : current === opts.hex) button.setAttribute("aria-pressed", "true");
    button.addEventListener("click", () => commit(opts.empty ? "" : opts.hex));
    swatches.push(button);
    grid.appendChild(button);
  };

  addSwatch({ hex: "", label: "No color", empty: true });
  for (const preset of PRESET_COLORS) addSwatch({ hex: preset.hex, label: preset.name });

  grid.addEventListener("keydown", (event) => {
    const index = swatches.indexOf(document.activeElement as HTMLButtonElement);
    if (index < 0) return;
    const delta =
      event.key === "ArrowRight"
        ? 1
        : event.key === "ArrowLeft"
          ? -1
          : event.key === "ArrowDown"
            ? COLUMNS
            : event.key === "ArrowUp"
              ? -COLUMNS
              : 0;
    if (delta === 0) return;
    event.preventDefault();
    const next = index + delta;
    if (next >= 0 && next < swatches.length) swatches[next].focus();
  });

  popover.appendChild(grid);

  // --- Custom hex entry ----------------------------------------------------
  const footer = document.createElement("div");
  footer.className = "color-picker-footer";

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "color-picker-custom-toggle";
  toggle.textContent = "Set custom color";

  const custom = document.createElement("div");
  custom.className = "color-picker-custom";

  const nativeInput = document.createElement("input");
  nativeInput.type = "color";
  nativeInput.className = "color-picker-native";
  nativeInput.value = current || "#000000";
  nativeInput.setAttribute("aria-label", "Custom color");

  const hexInput = document.createElement("input");
  hexInput.type = "text";
  hexInput.className = "form-input color-picker-hex";
  hexInput.placeholder = "#rrggbb";
  hexInput.setAttribute("aria-label", "Custom hex color");
  hexInput.value = current && !isPreset(current) ? current : "";

  custom.append(nativeInput, hexInput);

  // Native picker: `input` previews into the hex field, `change` (fired when
  // the OS dialog closes) commits.
  nativeInput.addEventListener("input", () => {
    hexInput.value = nativeInput.value;
  });
  nativeInput.addEventListener("change", () => commit(nativeInput.value));

  hexInput.addEventListener("input", () => {
    const normalized = normalizeHexColor(hexInput.value);
    if (normalized) nativeInput.value = normalized;
  });
  hexInput.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    const normalized = normalizeHexColor(hexInput.value);
    if (normalized) commit(normalized);
  });

  const expandCustom = (): void => {
    toggle.hidden = true;
    custom.hidden = false;
  };
  toggle.addEventListener("click", () => {
    expandCustom();
    // Seed the field with the current color (a preset, since a non-preset
    // value already expanded above) so it's a starting point, not blank.
    if (!hexInput.value && current) hexInput.value = current;
    hexInput.focus();
    hexInput.select();
  });

  // Start expanded when the current value isn't one of the presets, so an
  // already-custom color is editable without a click.
  if (current && !isPreset(current)) expandCustom();
  else custom.hidden = true;

  footer.append(toggle, custom);
  popover.appendChild(footer);

  // --- Mount, position, focus --------------------------------------------
  document.body.appendChild(popover);
  positionPopover(popover, anchor);

  const selected = swatches.find((swatch) => swatch.getAttribute("aria-pressed") === "true");
  (selected ?? swatches[0]).focus();

  // --- Dismissal ---------------------------------------------------------
  const onPointerDown = (event: PointerEvent): void => {
    const target = event.target as Node;
    if (!popover.contains(target) && !anchor.contains(target)) closeColorPicker();
  };
  const onResize = (): void => closeColorPicker();

  // Deferred so the same click that opened the popover doesn't close it.
  const armPointer = window.setTimeout(() => document.addEventListener("pointerdown", onPointerDown), 0);
  window.addEventListener("resize", onResize);

  teardown = () => {
    window.clearTimeout(armPointer);
    document.removeEventListener("pointerdown", onPointerDown);
    window.removeEventListener("resize", onResize);
    // Focus goes back to the anchor when it was inside — an Escape, or a
    // pick made with the keyboard.
    const restore = popover.contains(document.activeElement);
    popover.remove();
    if (restore) anchor.focus();
    teardown = null;
  };
}

export function closeColorPicker(): void {
  teardown?.();
}

// Escape reaches the picker through the keybinding dispatcher, below a
// dialog and above a pane's own transient.
export function registerColorPickerEscape(commands: CommandRegistry, keybindings: KeybindingRegistry): void {
  commands.register({
    id: "colorPicker.close",
    label: "Close color picker",
    when: () => teardown !== null,
    run: closeColorPicker,
  });
  keybindings.register({ key: "Escape", command: "colorPicker.close", weight: 60 });
}
