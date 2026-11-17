// A web link opens in a new window from the editor as from reading view, on a
// plain click: docs/architecture.md's Files and views section allows no modifier-click.
// A click on a link the cursor already touches places the cursor instead, so
// the link stays editable, and a press that drags selects as anywhere else.
import { syntaxTree } from "@codemirror/language";
import type { EditorSelection, EditorState } from "@codemirror/state";
import { Decoration, type DecorationSet, type EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import { Autolink, type MarkdownConfig } from "@lezer/markdown";

const WEB_URL = /^https?:/i;

/** Where a bare URL in prose leads: an http(s) one as written, a `www.` one
 * over https. A bare email or `mailto:` address is no link. */
export function bareUrlHref(text: string): string | undefined {
  if (WEB_URL.test(text)) return text;
  if (/^www\./i.test(text)) return `https://${text}`;
  return undefined;
}

/** GFM's bare URLs for the note editor, the web ones only. GFM also reads a
 * bare email as a URL, which the editor would color as a link that neither
 * view opens. */
export const webAutolink: MarkdownConfig = {
  parseInline: (Autolink.parseInline ?? []).map((gfm) => ({
    name: gfm.name,
    parse: (cx, next, pos) => (/^(https?:\/\/|www\.)/i.test(cx.slice(pos, pos + 8)) ? gfm.parse(cx, next, pos) : -1),
  })),
};

/** A `[label](url)` link's or image's destination: the URL after the
 * label's closing `]`, never one written inside the label, which GFM parses
 * as a URL too. Null for a reference link. */
export function linkDestination(node: SyntaxNode): SyntaxNode | null {
  let marks = 0;
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name === "LinkMark") marks++;
    else if (child.name === "URL" && marks >= 2) return child;
  }
  return null;
}

export interface WebLink {
  from: number;
  to: number;
  href: string;
}

/** The web links in `state` between `from` and `to`: an inline link, an
 * autolink or a bare URL, each by its whole span. */
export function webLinksIn(state: EditorState, from: number, to: number): WebLink[] {
  const links: WebLink[] = [];
  syntaxTree(state).iterate({
    from,
    to,
    enter(node) {
      switch (node.name) {
        case "URL": {
          const href = bareUrlHref(state.sliceDoc(node.from, node.to));
          if (href) links.push({ from: node.from, to: node.to, href });
          return false;
        }
        case "Link":
        case "Autolink": {
          const url = node.name === "Link" ? linkDestination(node.node) : node.node.getChild("URL");
          const href = url ? state.sliceDoc(url.from, url.to) : "";
          if (WEB_URL.test(href)) links.push({ from: node.from, to: node.to, href });
          return false;
        }
        // Neither is a link in reading view: an image embeds, and a
        // reference definition isn't shown.
        case "Image":
        case "LinkReference":
          return false;
        default:
          return true;
      }
    },
  });
  return links;
}

const webLinkMark = Decoration.mark({ class: "cm-web-link" });

class WebLinks {
  links: WebLink[] = [];
  decorations: DecorationSet = Decoration.none;
  // A press on a link, kept until its click: the selection is the one from
  // before the press, put back so the click leaves the cursor where it was.
  press: { href: string; selection: EditorSelection } | undefined;

  constructor(view: EditorView) {
    this.build(view);
  }

  update(update: ViewUpdate) {
    if (update.docChanged || update.viewportChanged || syntaxTree(update.startState) !== syntaxTree(update.state)) {
      this.build(update.view);
    }
  }

  build(view: EditorView) {
    this.links = webLinksIn(view.state, view.viewport.from, view.viewport.to);
    this.decorations = Decoration.set(this.links.map((link) => webLinkMark.range(link.from, link.to)));
  }
}

export const webLinks = ViewPlugin.fromClass(WebLinks, {
  decorations: (plugin) => plugin.decorations,
  eventHandlers: {
    mousedown(event, view) {
      this.press = undefined;
      if (event.button !== 0 || event.detail > 1 || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) {
        return false;
      }
      const mark = event.target instanceof Element ? event.target.closest(".cm-web-link") : null;
      if (!mark) return false;
      const at = view.posAtDOM(mark);
      const link = this.links.find((candidate) => candidate.from <= at && at < candidate.to);
      // A cursor just past the link's end touches it — where typing one leaves it.
      if (!link || view.state.selection.ranges.some((range) => range.to > link.from && range.from <= link.to)) {
        return false;
      }
      this.press = { href: link.href, selection: view.state.selection };
      return false;
    },
    click(_event, view) {
      const press = this.press;
      this.press = undefined;
      if (!press || !view.state.selection.main.empty) return false;
      view.dispatch({ selection: press.selection });
      window.open(press.href, "_blank", "noopener,noreferrer");
      return true;
    },
  },
});
