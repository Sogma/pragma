// A Settings form's one message line, the first thing under its title: every
// error, warning and confirmation the form gives lands there, so none falls
// below the dialog's edge or among the gray notes. Showing one scrolls its
// page to the top, where the line is, since an outcome can land while the
// person is further down, ticking models.
//
// An attempt never empties the line as it starts. The next message replaces
// the last, so the fields under the line move once, not twice.
export type SettingsMessageLevel = "error" | "warning" | "success";

export interface SettingsMessage {
  /** Says `message` at `level`, in place of whatever the line said. */
  show(message: string, level?: SettingsMessageLevel): void;
  clear(): void;
}

const LEVELS: readonly SettingsMessageLevel[] = ["error", "warning", "success"];

/** Makes `line` a form's message line: from here on it owns the line's text,
 * level and `hidden`. */
export function createSettingsMessage(line: HTMLElement): SettingsMessage {
  return {
    show(message, level = "error") {
      line.textContent = message;
      for (const each of LEVELS) line.classList.toggle(`inline-${each}`, each === level);
      line.hidden = false;
      const page = line.closest<HTMLElement>(".settings-subpage");
      if (page) page.scrollTop = 0;
    },
    clear() {
      line.hidden = true;
    },
  };
}
