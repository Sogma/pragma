// A file's description, by docs/protocol.md's Descriptions rule, for the
// Links tab. An open note or screenplay is read from its model, which holds
// edits not yet saved; anything else from disk, by the server's reader, the
// one a gallery card shows, so a card and an expanded row never disagree.
// Nothing edits a description from outside its own file.
import { fountainDescription } from "../../src/protocol/fountainSynopsis.ts";
import { frontmatterDescription } from "../../src/protocol/frontmatter.ts";
import { isFountainFile, isMarkdownFile } from "../../src/protocol/types.ts";
import type { DocumentsService } from "./documents.ts";

export interface DescriptionsDeps {
  documents: DocumentsService;
  // A description as the server reads it from disk.
  fetchDescription: (path: string) => Promise<string | undefined>;
}

export interface Descriptions {
  read(path: string): Promise<string | undefined>;
}

export function createDescriptions(deps: DescriptionsDeps): Descriptions {
  return {
    async read(path) {
      const open = deps.documents.get(path);
      if (open && isFountainFile(path)) return fountainDescription(open.body());
      const properties = open && isMarkdownFile(path) ? open.properties() : undefined;
      if (properties) return frontmatterDescription(properties);
      return deps.fetchDescription(path);
    },
  };
}
