// The app's two text formats, registered as main.ts registers them but over
// fakes in place of the space tree's resolvers.
import { resolveFileReference } from "../../../src/protocol/relativeReference.ts";
import type { TagDefinition } from "../../../src/protocol/tags.ts";
import { imageMediaTypeForPath } from "../../../src/protocol/types.ts";
import type { FileResponse } from "../../../web/core/apiClient.ts";
import type { DocumentLinks, LinkScope } from "../../../web/core/spaceTree.ts";
import { markdownFormat } from "../../../web/formats/markdown/format.ts";
import { screenplayFormat } from "../../../web/formats/screenplay/format.ts";
import type { LinkLead } from "../../../web/markdownRender.ts";
import { createFormats, type FormatRegistry } from "../../../web/services/formats.ts";
import { fakeContextMenu } from "./fakeContextMenu.ts";

export interface FormatSources {
  resolveWikilinkTarget?: (target: string, docPath: string) => string | undefined;
  linkHint?: (lead: LinkLead, text: string) => string | undefined;
  linkScope?: (docPath: string) => LinkScope | undefined;
  markdownLinks?: (docPath: string, content: string) => DocumentLinks;
  worldNames?: (docPath: string) => ((name: string) => string | undefined) | undefined;
  loadFile?: (path: string) => Promise<FileResponse>;
  // The space's declared tags and those in use.
  tags?: { known?: readonly TagDefinition[]; used?: readonly string[] };
}

export function testFormats(sources: FormatSources = {}): FormatRegistry {
  const formats = createFormats();
  formats.register(
    "note",
    markdownFormat({
      links: {
        // Images and Markdown links as written, with no listing to check
        // them against; a wikilink by the test's own rule.
        readingResolvers: (docPath) => {
          const docDir = docPath.slice(0, Math.max(docPath.lastIndexOf("/"), 0));
          return {
            image: (href) => {
              const path = resolveFileReference(docDir, href);
              return path !== undefined && imageMediaTypeForPath(path)
                ? `/api/file/raw?path=${encodeURIComponent(path)}`
                : undefined;
            },
            link: (href) => (href.startsWith("#") ? undefined : resolveFileReference(docDir, href)),
            wikilink: (target) => sources.resolveWikilinkTarget?.(target, docPath),
            hint: sources.linkHint ?? (() => undefined),
          };
        },
        linkScope: sources.linkScope ?? (() => undefined),
        libraryFiles: async () => [],
        markdownLinks: sources.markdownLinks ?? (() => ({ found: [], missing: [] })),
      },
      loadFile: sources.loadFile ?? (async (path) => Promise.reject(new Error(`no file at ${path}`))),
      tags: {
        known: () => sources.tags?.known ?? [],
        read: async () => sources.tags?.known ?? [],
        used: () => sources.tags?.used ?? [],
        subscribe: () => () => {},
      },
    }),
  );
  formats.register(
    "screenplay",
    screenplayFormat({ worldNames: sources.worldNames ?? (() => undefined), contextMenu: fakeContextMenu() }),
  );
  return formats;
}
