// What a gallery card says of an entry: its description, by
// docs/protocol.md's Descriptions, or a note's opening where it has none.
// Every kind that has one keeps it in its own file, and a folder's is its
// README's. A folder's `_structure.json` holds only its order, so a
// description is never read from it.
import path from "node:path";
import { parseAppletFile } from "../protocol/appletFile.ts";
import { parseClassFile } from "../protocol/classFile.ts";
import { parseFlowFile } from "../protocol/flowFile.ts";
import { fountainDescription } from "../protocol/fountainSynopsis.ts";
import { frontmatterDescription } from "../protocol/frontmatter.ts";
import { metadataText } from "../protocol/metadata.ts";
import { parseTableFile } from "../protocol/tableFile.ts";
import {
  isAppletFile,
  isClassFile,
  isFlowFile,
  isFountainFile,
  isMarkdownFile,
  isTableFile,
} from "../protocol/types.ts";
import { documentIndex } from "./documentIndex.ts";
import { namedEntryPath } from "./rootedFiles.ts";

const DESCRIBERS: Array<[(name: string) => boolean, (text: string) => string | undefined]> = [
  [isFountainFile, fountainDescription],
  [isFlowFile, (text) => metadataText(parseFlowFile(text)?.metadata, "description")],
  [isTableFile, (text) => metadataText(parseTableFile(text)?.metadata, "description")],
  [isClassFile, (text) => metadataText(parseClassFile(text)?.metadata, "description")],
  [isAppletFile, (text) => parseAppletFile(text).manifest.meta?.description?.trim() || undefined],
];

/** The description of the entry `name` in `dir`, or undefined where there is
 * none: a kind that keeps none, such as an image, or a folder with no
 * `README.md`. */
export function entryDescription(dir: string, name: string, type: "file" | "directory"): string | undefined {
  const absolute = path.join(dir, name);
  const index = documentIndex();
  if (type === "directory") return frontmatterDescription(index.frontmatter(namedEntryPath(absolute, "README.md")));
  if (isMarkdownFile(name)) return frontmatterDescription(index.frontmatter(absolute));
  const describe = DESCRIBERS.find(([matches]) => matches(name))?.[1];
  return describe ? index.description(absolute, describe) : undefined;
}

// Past what an excerpt's lines hold on the widest card (gallery-cards.css):
// any less and a wide card's excerpt ends early.
const EXCERPT_CHARS = 1000;

/** A note's opening, for its card where it has no description; undefined
 * for any other entry. */
export function entryExcerpt(dir: string, name: string, type: "file" | "directory"): string | undefined {
  if (type !== "file" || !isMarkdownFile(name)) return undefined;
  return documentIndex().noteExcerpt(path.join(dir, name), EXCERPT_CHARS);
}
