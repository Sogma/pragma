// @vitest-environment jsdom
import { markdown } from "@codemirror/lang-markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { wikilinkSyntax } from "../../src/protocol/wikilinkSyntax.ts";
import { webAutolink, webLinks, webLinksIn } from "../../web/webLinks.ts";

// The note editor's own language, so the tree is the one it marks links in.
const language = markdown({ extensions: [wikilinkSyntax, webAutolink] });

function linksIn(doc: string) {
  const state = EditorState.create({ doc, extensions: language });
  ensureSyntaxTree(state, doc.length);
  return webLinksIn(state, 0, doc.length).map(({ from, to, href }) => ({ text: doc.slice(from, to), href }));
}

describe("webLinksIn", () => {
  it("finds a bare URL, a www. address over https, an autolink and an inline link", () => {
    expect(linksIn("see https://www.google.com/, www.a.com, <http://b.com> and [c](https://c.com).")).toEqual([
      { text: "https://www.google.com/", href: "https://www.google.com/" },
      { text: "www.a.com", href: "https://www.a.com" },
      { text: "<http://b.com>", href: "http://b.com" },
      { text: "[c](https://c.com)", href: "https://c.com" },
    ]);
  });

  it("takes a link's destination, not a URL written in its label", () => {
    expect(linksIn("[docs at https://a.com here](https://b.com)")).toEqual([
      { text: "[docs at https://a.com here](https://b.com)", href: "https://b.com" },
    ]);
  });

  it("reads a destination in angle brackets as the address inside them", () => {
    expect(linksIn("[d](<https://d.com>)")).toEqual([{ text: "[d](<https://d.com>)", href: "https://d.com" }]);
  });

  it("leaves mail, space links, wikilinks, images, definitions and code alone", () => {
    const doc = [
      "a@b.com mailto:a@b.com <a@b.com> [mail](mailto:a@b.com)",
      "[note](./note.md) [[https://x.com]] ![pic](https://x.com/p.png)",
      "`https://x.com`",
      "",
      "[ref]: https://x.com",
    ].join("\n");
    expect(linksIn(doc)).toEqual([]);
  });

  it("parses no bare email as a URL, so the editor never colors one as a link", () => {
    const doc = "a@b.com mailto:a@b.com xmpp:a@b.com";
    const urls: string[] = [];
    language.language.parser.parse(doc).iterate({
      enter: (node) => {
        if (node.name === "URL") urls.push(doc.slice(node.from, node.to));
      },
    });
    expect(urls).toEqual([]);
  });
});

describe("a click on a web link", () => {
  let view: EditorView | undefined;
  afterEach(() => {
    view?.destroy();
    vi.restoreAllMocks();
  });

  function mount(doc: string, cursor: number): EditorView {
    view = new EditorView({
      parent: document.body,
      state: EditorState.create({ doc, selection: EditorSelection.cursor(cursor), extensions: [language, webLinks] }),
    });
    ensureSyntaxTree(view.state, doc.length);
    view.dispatch({}); // the tree is complete: the plugin marks from it
    return view;
  }

  // Between the two events the press puts the cursor where it landed, as the
  // editor's own mousedown does in a browser; jsdom can't lay out text for it.
  function click(editor: EditorView, init: MouseEventInit = {}): void {
    const target = editor.contentDOM.querySelector(".cm-web-link") as Element;
    target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, detail: 1, ...init }));
    editor.dispatch({ selection: EditorSelection.cursor(editor.posAtDOM(target) + 3) });
    target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1, ...init }));
  }

  it("opens the link in a new window and leaves the cursor where it was", () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const editor = mount("see https://www.google.com/ now", 0);
    const link = editor.contentDOM.querySelector(".cm-web-link");
    expect(link?.textContent).toBe("https://www.google.com/");

    click(editor);

    expect(open).toHaveBeenCalledWith("https://www.google.com/", "_blank", "noopener,noreferrer");
    expect(editor.state.selection.main.head).toBe(0);
  });

  it("edits instead while the cursor touches the link", () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const editor = mount("see https://www.google.com/ now", "see https://www.google.com/".length);

    click(editor);

    expect(open).not.toHaveBeenCalled();
  });

  it("leaves a modifier-click to the editor", () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const editor = mount("see https://www.google.com/ now", 0);

    click(editor, { ctrlKey: true });

    expect(open).not.toHaveBeenCalled();
  });
});
