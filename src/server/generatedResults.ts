import { readdir } from "node:fs/promises";
import path from "node:path";
import { entryNameKey, isHiddenName } from "../protocol/entryName.ts";
import { refuseLink } from "./rootedFiles.ts";

/** The extension a generated result of each type is saved under. */
export const IMAGE_EXTENSIONS_BY_TYPE: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

export const VIDEO_EXTENSIONS_BY_TYPE: Record<string, string> = {
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
};

/** The file already in the folder for these inputs, by the digest ending its
 * name: the one named `stem` first. `kept` is the name to hand back, a copy's
 * when the request gives its result a new prefix.
 *
 * Only a regular file is found: callers read it without resolving it again,
 * and a link can point anywhere. A link named `stem` refuses, as
 * docs/protocol.md's Symbolic links says of a write naming one; read as
 * absent, the run would pay again and its save would replace the link. */
export async function findResult(
  folderPath: string,
  stem: string,
  digest: string,
  named: string,
): Promise<{ found: string; kept: string } | undefined> {
  const isStem = (entry: string) => entryNameKey(entry.slice(0, entry.lastIndexOf("."))) === entryNameKey(stem);
  const digested = (await readdir(folderPath, { withFileTypes: true })).filter(
    (entry) => !isHiddenName(entry.name) && new RegExp(`-${digest}\\.[a-z0-9]+$`).test(entry.name),
  );
  const link = digested.find((entry) => entry.isSymbolicLink() && isStem(entry.name));
  if (link) refuseLink(folderPath, path.join(folderPath, link.name));
  const matches = digested.filter((entry) => entry.isFile()).map((entry) => entry.name);
  const found = matches.find(isStem) ?? matches[0];
  if (!found) return undefined;
  // Names compare as the file system does, so a change of case alone never
  // copies a file onto itself.
  return { found, kept: named && !isStem(found) ? `${stem}${path.extname(found)}` : found };
}
