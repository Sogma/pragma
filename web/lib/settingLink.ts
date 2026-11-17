// The link from an error to the setting that fixes it (docs/architecture.md,
// Feedback and interaction): one control on every surface that shows such an
// error, named for the Settings page it opens. Settings says once how to open
// a need's place, so no surface is wired to it.
import type { SetupNeed } from "../../src/protocol/setupNeed.ts";

// Each page's name as Settings' nav writes it.
const PAGES = { models: "AI Models", publishing: "Publishing" } as const;

export type SetupPage = keyof typeof PAGES;

/** The Settings page that meets `need`. */
export function setupPage(need: SetupNeed): SetupPage {
  return need.kind === "publisher" || need.kind === "publisherKey" ? "publishing" : "models";
}

/** What a control that opens `page` says, as a link or a menu row. */
export function goToSettingsLabel(page: SetupPage): string {
  return `Go to ${PAGES[page]} settings`;
}

let opener: ((need: SetupNeed) => void) | undefined;

/** How every link opens its need's place, given once by Settings. */
export function provideSettingLinks(open: (need: SetupNeed) => void): void {
  opener = open;
}

/** The link under an error, as a list to spread among its children: one
 * when a setting fixes the error, none when `need` is undefined. An inline
 * error draws it as a button. */
export function settingLinks(need: SetupNeed | undefined, look: "link" | "button" = "link"): HTMLButtonElement[] {
  if (!need) return [];
  const link = document.createElement("button");
  link.type = "button";
  link.className = look === "button" ? "setting-link btn" : "setting-link";
  link.textContent = goToSettingsLabel(setupPage(need));
  link.addEventListener("click", () => opener?.(need));
  return [link];
}
