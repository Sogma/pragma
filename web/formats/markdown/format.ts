// Markdown, the format a note is written in: wikilinks, web links and tags in
// the editor, the text formatted while it is edited, its links read from the
// whole file, and reading view as a rendered page. The frontmatter and the
// lifted title are the model's, by docs/protocol.md's rules, not this
// format's.
import { markdown } from "@codemirror/lang-markdown";
import { Strikethrough, Subscript, Superscript, Table, TaskList } from "@lezer/markdown";
import { highlightSyntax } from "../../../src/protocol/highlightSyntax.ts";
import { mathSyntax } from "../../../src/protocol/mathSyntax.ts";
import type { FileResponse } from "../../core/apiClient.ts";
import { droppedLinkFor } from "../../core/imageAttach.ts";
import type { DocumentLinks, LinkScope, readingResolvers } from "../../core/spaceTree.ts";
import type { TagVocabulary } from "../../core/tagVocabulary.ts";
import { addCodeBlockCopyButtons } from "../../lib/dom.ts";
import { keepingAnswers, renderMarkdown } from "../../markdownRender.ts";
import type { TextFormat } from "../../services/formats.ts";
import { singleLineBreaks, useWikilinks } from "../../services/settings.ts";
import { tagCompletion } from "../../tagCompletion.ts";
import { webAutolink, webLinks } from "../../webLinks.ts";
import { wikilinkCompletion } from "../../wikilinkCompletion.ts";
import { wikilinkSyntax } from "../../wikilinkSyntax.ts";
import { markdownActions } from "./actions.ts";
import { formattingChanged, markdownFormatting } from "./formatting.ts";
import { markdownSpellcheckSkips } from "./spelling.ts";

export interface MarkdownFormatDeps {
  // The space tree's link resolvers. Each takes the linking document's path,
  // since its root is the one searched: a library note never resolves onto a
  // space file.
  links: {
    readingResolvers: typeof readingResolvers;
    linkScope(docPath: string): LinkScope | undefined;
    libraryFiles(): Promise<readonly string[]>;
    markdownLinks(docPath: string, content: string): DocumentLinks;
  };
  loadFile(path: string): Promise<FileResponse>;
  // The space's tags: a tag's color, and what typing one suggests.
  tags: Pick<TagVocabulary, "known" | "read" | "used" | "subscribe">;
}

export function markdownFormat(deps: MarkdownFormatDeps): TextFormat {
  // On :root, not on a pane as the layout's classes are: a note's preview,
  // outside any pane, keeps its line breaks as reading view does.
  singleLineBreaks.subscribe((on) => document.documentElement.classList.toggle("single-line-breaks", on));
  return {
    extensions: (context) => [
      // Reading view's grammar, so edit view formats what it renders, with
      // wikilinks of its own and only web addresses as bare URLs: GFM's would
      // read a bare email as one.
      markdown({
        extensions: [
          Table,
          TaskList,
          Strikethrough,
          Superscript,
          Subscript,
          highlightSyntax,
          mathSyntax,
          wikilinkSyntax,
          webAutolink,
        ],
      }),
      webLinks,
      wikilinkCompletion({
        docPath: () => context.path(),
        scope: (docPath) => deps.links.linkScope(docPath),
        libraryFiles: () => deps.links.libraryFiles(),
        loadFile: (path) => deps.loadFile(path),
        writesWikilinks: () => useWikilinks.get(),
      }),
      tagCompletion(deps.tags),
    ],
    formatting: (context) =>
      markdownFormatting({
        resolvers: () => {
          const path = context.path();
          return path === undefined ? undefined : deps.links.readingResolvers(path);
        },
        open: (path, anchor) => context.openPath(path, anchor),
        tags: () => deps.tags.known(),
        openTag: (name) => context.searchTag(name),
        watchTags: (redraw) => deps.tags.subscribe(redraw),
      }),
    actions: markdownActions,
    spellcheckSkips: markdownSpellcheckSkips,
    // A note is read whole, frontmatter and title included, and the editor
    // holds its tail: the body, or in Source mode all of it. A mention above
    // the text the editor holds, in the title bar, has no place in it and is
    // dropped.
    links(model, state) {
      const content = model.content();
      const start = content.length - state.doc.length;
      const { found, missing } = deps.links.markdownLinks(model.path, content);
      return {
        found: found.map((link) => ({
          ...link,
          mentions: link.mentions
            .filter((mention) => mention.from >= start)
            .map((mention) => ({ from: mention.from - start, to: mention.to - start })),
        })),
        missing,
      };
    },
    renderReading(model) {
      const { resolvers, changed } = keepingAnswers(deps.links.readingResolvers(model.path));
      const page = renderMarkdown(
        model.content(),
        resolvers,
        // The title bar carries the leading heading; don't render it twice. A
        // note shown without one keeps its heading here.
        { omitLeadingH1: model.title() !== undefined },
      );
      addCodeBlockCopyButtons(page);
      return { page, changed };
    },
    embedsImages: true,
    linkFor: (docPath, target, folder) => droppedLinkFor(docPath, target, { folder, wikilinks: useWikilinks.get() }),
    // A wikilink whose file appeared stops showing as unresolved.
    spaceChanged: (view) => view.dispatch({ effects: formattingChanged.of(null) }),
  };
}
