// A color value as a pill filled with the color and carrying its hex, in the
// text color that fill gets on a tag pill or a node title, so a Table or Class
// shows that contrast where the color is picked. A value that isn't a hex
// color reads "None" beside the color picker's empty swatch.
import { normalizeHexColor } from "../../src/protocol/types.ts";
import { readableTextColor } from "./color.ts";

export function createColorChip(value: string): HTMLElement {
  const chip = document.createElement("span");
  chip.className = "color-chip";
  paintColorChip(chip, value);
  return chip;
}

export function paintColorChip(chip: HTMLElement, value: string): void {
  const hex = normalizeHexColor(value);
  chip.classList.toggle("is-empty", !hex);
  chip.style.background = hex;
  chip.style.color = hex ? readableTextColor(hex) : "";
  chip.textContent = hex || "None";
}
