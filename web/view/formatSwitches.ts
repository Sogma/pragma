// The Editor page's switches for the formats notes and screenplays are
// written in, which sit together on the page: Markdown's Use [[Wikilinks]]
// and Single line breaks, and Hide format syntax for both.
import { must } from "../lib/dom.ts";
import { bindToggle } from "../lib/toggleRow.ts";
import { hideFormatSyntax, singleLineBreaks, useWikilinks } from "../services/settings.ts";

export function bindFormatSwitches(): void {
  bindToggle(must<HTMLButtonElement>("#setting-use-wikilinks"), useWikilinks);
  bindToggle(must<HTMLButtonElement>("#setting-single-line-breaks"), singleLineBreaks);
  bindToggle(must<HTMLButtonElement>("#setting-hide-format-syntax"), hideFormatSyntax);
}
