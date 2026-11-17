// Whether a file's text keeps it from every model call (docs/architecture.md's
// Privacy section): a note by its frontmatter, a Table, Flow or
// Class by its metadata block. The one rule every check made from a
// file's text goes through, so the kinds can't drift apart.
import { parse } from "node-html-parser";
import { isPrivateDocument } from "./frontmatter.ts";
import { hasMetadataBlock, isPrivateMetadata } from "./metadata.ts";
import { readMetadataBlock } from "./tableFile.ts";
import { isMarkdownFile } from "./types.ts";

/** Any other kind of file is never private. */
export function isPrivateContent(filePath: string, content: string): boolean {
  if (isMarkdownFile(filePath)) return isPrivateDocument(content);
  // Most files never name the key, and a Flow can take megabytes to parse.
  if (!hasMetadataBlock(filePath) || !content.includes("visibility")) return false;
  try {
    return isPrivateMetadata(readMetadataBlock(parse(content)));
  } catch {
    // Nothing can show it isn't, as with frontmatter that doesn't parse.
    return true;
  }
}
