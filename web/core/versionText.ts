// Who History says made a change: the section listing changes and the tab
// showing one say it alike. Its times are written as every date is
// (lib/dateText.ts).
import { basenameOf } from "../../src/protocol/rootedPath.ts";
import type { HistoryVersion } from "./apiClient.ts";
import { stripExtension } from "./paths.ts";

/** Who made the change that replaced a version's text. */
export function replacedBy(version: HistoryVersion): string {
  switch (version.source) {
    case "edit":
      return "You";
    case "copilot":
      return "Copilot";
    case "flow":
      return version.detail === undefined ? "Flow" : `Flow: ${stripExtension(basenameOf(version.detail))}`;
    case "links":
      return "Links updated";
    case "published":
      return "Published";
    case "restored":
      return "Restored";
    case "outside":
      return "Changed outside Pragma";
  }
}
