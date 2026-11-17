// What History says wrote over a version: the section listing versions, the
// tab comparing one and its strip all say it alike. Its times are written
// as every date is (lib/dateText.ts).
import { basenameOf } from "../../src/protocol/rootedPath.ts";
import type { HistoryVersion } from "./apiClient.ts";
import { stripExtension } from "./paths.ts";

/** What wrote over a version, which is what it is the text from before. */
export function replacedBy(version: HistoryVersion): string {
  switch (version.source) {
    case "edit":
      return "Edited";
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
