// The space a Pragma link opens, among those registered on this computer:
// the one whose id it names, else whose display name, else whose folder
// name, compared as entry names are. A name two spaces share opens neither,
// since a guess would open the wrong space's file.

import path from "node:path";
import { type PragmaGlobalConfig, type SpaceRecord, spaceLabel } from "../config/loadConfig.ts";
import { entryNameKey } from "../protocol/entryName.ts";
import { type PragmaLink, parsePragmaUrl } from "../protocol/pragmaUrl.ts";

export type LinkRoute = { spaceId: string; spacePath: string; link: PragmaLink } | { refusal: string };

const NAMES: readonly ((record: SpaceRecord) => string)[] = [spaceLabel, (record) => path.basename(record.path)];

export function routePragmaLink(config: PragmaGlobalConfig, input: string): LinkRoute {
  const read = parsePragmaUrl(input);
  if ("refusal" in read) return read;
  const { link } = read;
  const spaces = Object.entries(config.spaces ?? {});
  const routed = ([spaceId, record]: [string, SpaceRecord]): LinkRoute => ({ spaceId, spacePath: record.path, link });

  const byId = spaces.find(([id]) => id === link.space);
  if (byId) return routed(byId);
  const key = entryNameKey(link.space);
  for (const nameOf of NAMES) {
    const named = spaces.filter(([, record]) => entryNameKey(nameOf(record)) === key);
    if (named.length === 1) return routed(named[0]);
    if (named.length > 1) {
      const folders = named.map(([, record]) => record.path).join(", ");
      return { refusal: `More than one space on this computer is named "${link.space}": ${folders}` };
    }
  }
  return { refusal: `No space named "${link.space}" on this computer` };
}
