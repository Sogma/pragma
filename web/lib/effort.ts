// The effort a chat turn or a Generate node asks its model for: the names
// every surface shows a level by, and the slider the model menu pins under
// its list.
import { type EffortLevel, effortFor } from "../../src/protocol/api.ts";
import type { MenuSlider } from "../services/menus.ts";

export const EFFORT_LABEL = "Effort";

const LEVEL_NAMES: Record<EffortLevel, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
};

export function effortName(level: EffortLevel): string {
  return LEVEL_NAMES[level];
}

/** Default as a ring, then the model's levels, set at the level a turn would send. */
export function effortSlider(levels: readonly EffortLevel[], pick: string, choose: (pick: string) => void): MenuSlider {
  return {
    label: EFFORT_LABEL,
    stops: [
      { value: "", label: "Default", ring: true },
      ...levels.map((level) => ({ value: level, label: LEVEL_NAMES[level] })),
    ],
    value: effortFor(pick, levels) ?? "",
    change: choose,
  };
}
