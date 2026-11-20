// The files Pragma reads in a space beside its documents (docs/protocol.md's
// "Space content and host state"). A leading underscore is a convention, not
// a reservation, so a file is Pragma's only where Pragma reads it: a
// `_tags.json` in a subfolder is the person's own.
import { isNamed } from "./entryName.ts";
import { LIBRARIES_FILENAME } from "./libraries.ts";
import { PRESETS_FILENAME } from "./presets.ts";
import { TAGS_FILENAME } from "./tags.ts";

export const STRUCTURE_FILENAME = "_structure.json";
export const PROPERTIES_FILENAME = "_properties.json";
export const SITE_FILENAME = "_site.json";
export const QUEUE_FILENAME = "_queue.json";

/** The job one of Pragma's files does: a folder's manual order or its
 * properties, the space's declared tags, libraries or preset folders, a
 * site's settings or its publishing queue. */
export type PragmaFileRole = "order" | "properties" | "tags" | "libraries" | "presets" | "site" | "queue";

/** Where a file sits, as far as Pragma's reading of it goes. */
export interface PragmaFilePlace {
  /** Its folder is the space's root. */
  atRoot: boolean;
  /** Its folder holds a `_site.json`, which makes it a site's root. */
  inSite: boolean;
}

/** The job the file `name` does for Pragma where it sits, or undefined
 * where Pragma doesn't read it. Names match in any case, as every name
 * Pragma looks up does. */
export function pragmaFileRole(name: string, { atRoot, inSite }: PragmaFilePlace): PragmaFileRole | undefined {
  if (isNamed(name, STRUCTURE_FILENAME)) return "order";
  if (isNamed(name, PROPERTIES_FILENAME)) return "properties";
  if (isNamed(name, SITE_FILENAME)) return "site";
  if (inSite && isNamed(name, QUEUE_FILENAME)) return "queue";
  if (atRoot && isNamed(name, TAGS_FILENAME)) return "tags";
  if (atRoot && isNamed(name, LIBRARIES_FILENAME)) return "libraries";
  if (atRoot && isNamed(name, PRESETS_FILENAME)) return "presets";
  return undefined;
}
