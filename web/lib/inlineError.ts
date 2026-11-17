// An error shown where it happened, in the `inline-error` primitive
// (web/styles/inline-error.css). A title says what failed where several
// controls report into one place; the setting that fixes it is a button
// under the message.
import type { SetupNeed } from "../../src/protocol/setupNeed.ts";
import { settingLinks } from "./settingLink.ts";

export interface InlineError {
  /** What failed, for a place several controls report into. */
  title?: string;
  message: string;
  /** The setting that fixes it, when one does. */
  need?: SetupNeed;
}

/** The error's card, announced to assistive tech as it appears. */
export function createInlineError({ title, message, need }: InlineError): HTMLElement {
  const card = document.createElement("div");
  card.className = "inline-error";
  card.setAttribute("role", "alert");
  if (title) card.append(textPart("inline-error-title", title));
  card.append(textPart("inline-error-message", message), ...settingLinks(need, "button"));
  return card;
}

function textPart(className: string, text: string): HTMLDivElement {
  const part = document.createElement("div");
  part.className = className;
  part.textContent = text;
  return part;
}
