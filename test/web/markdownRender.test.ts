// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import {
  keepingAnswers,
  type LinkLead,
  renderFrontmatter,
  renderMarkdown,
  renderMarkdownInline,
} from "../../web/markdownRender.ts";

// MathJax itself is test/web/mathJax.test.ts's: here a host shows what it was
// handed.
vi.mock("../../web/mathTypeset.ts", () => ({
  typesetMath: vi.fn((host: HTMLElement, tex: string, display: boolean) => {
    host.textContent = `${display ? "display" : "inline"}: ${tex}`;
  }),
}));

const resolvers = { image: () => undefined, link: () => undefined, wikilink: () => undefined };

function render(markdown: string): HTMLElement {
  const host = document.createElement("div");
  host.appendChild(renderMarkdown(markdown, resolvers));
  return host;
}

describe("a video embed in reading view", () => {
  it("shows the thumbnail until clicked, then the player", () => {
    const host = render("![Trailer](https://youtu.be/dQw4w9WgXcQ?t=90)");

    expect(host.querySelector("iframe")).toBeNull();
    const poster = host.querySelector<HTMLButtonElement>(".video-embed-poster");
    expect(poster?.getAttribute("aria-label")).toBe("Play Trailer");
    expect(poster?.querySelector("img")?.src).toBe("https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg");

    poster?.click();

    const frame = host.querySelector("iframe");
    expect(frame?.src).toBe("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1&rel=0&start=90");
    expect(frame?.title).toBe("Trailer");
    expect(frame?.getAttribute("sandbox")).not.toContain("allow-top-navigation");
  });

  it("leaves a plain link to the same video a link", () => {
    const host = render("[Trailer](https://youtu.be/dQw4w9WgXcQ)");

    expect(host.querySelector(".video-embed")).toBeNull();
    expect(host.querySelector("a")?.getAttribute("href")).toBe("https://youtu.be/dQw4w9WgXcQ");
  });

  it("leaves any other web image an image", () => {
    const host = render("![Cover](https://example.com/cover.png)");

    expect(host.querySelector(".video-embed")).toBeNull();
    expect(host.querySelector("img")?.getAttribute("src")).toBe("https://example.com/cover.png");
  });
});

describe("a web link in reading view", () => {
  it("links a bare URL, and a www. address over https, in a new window", () => {
    const host = render("see https://www.google.com/, and www.a.com.");

    const links = [...host.querySelectorAll("a")];
    expect(links.map((a) => [a.textContent, a.getAttribute("href"), a.target])).toEqual([
      ["https://www.google.com/", "https://www.google.com/", "_blank"],
      ["www.a.com", "https://www.a.com", "_blank"],
    ]);
    expect(host.textContent).toBe("see https://www.google.com/, and www.a.com.");
  });

  it("leaves a bare email or mailto: address text", () => {
    const host = render("a@b.com and mailto:a@b.com");

    expect(host.querySelector("a")).toBeNull();
    expect(host.textContent).toBe("a@b.com and mailto:a@b.com");
  });

  it("draws a highlight as marked text, its == hidden, and leaves == with spaces round it as text", () => {
    const host = render("A ==bright **bold**== word, and 1 == 1.");

    expect(host.querySelector("mark")?.innerHTML).toBe("bright <strong>bold</strong>");
    expect(host.textContent).toBe("A bright bold word, and 1 == 1.");
  });

  it("keeps the brackets of a reference no definition names, drawing the markup inside", () => {
    const host = render("He said [sic] it, [*twice*] and [three][x]. ![alt]");

    expect(host.querySelector("a, span:not([class]), img")).toBeNull();
    expect(host.querySelector("em")?.textContent).toBe("twice");
    expect(host.textContent).toBe("He said [sic] it, [twice] and [three][x]. ![alt]");
  });

  it("links a reference through the first definition its label names, case and spaces aside", () => {
    const host = render(
      "See [docs], [the docs][DOCS] and [Docs  ][].\n\n> [docs]: https://a.com\n\n[docs]: https://b.com\n",
    );

    const links = [...host.querySelectorAll("a")];
    expect(links.map((a) => [a.textContent, a.getAttribute("href")])).toEqual([
      ["docs", "https://a.com"],
      ["the docs", "https://a.com"],
      ["Docs  ", "https://a.com"],
    ]);
    expect(host.textContent).not.toContain("https://");
  });

  it("links to a link's destination, keeping a URL written in its label as text", () => {
    const host = render("[docs at https://a.com here](https://b.com)");

    const links = host.querySelectorAll("a");
    expect(links).toHaveLength(1);
    expect(links[0].getAttribute("href")).toBe("https://b.com");
    expect(links[0].textContent).toBe("docs at https://a.com here");
  });
});

describe("a Pragma link in reading view", () => {
  // Live, so the desktop app can take it and a browser can hand it on; an
  // image never loads from one.
  it("is a live link, written as a link or an autolink, but no image source", () => {
    const host = render("[scene](pragma://Notes/a.md) <pragma://Notes/b/> ![pic](pragma://Notes/p.png)");
    const anchors = [...host.querySelectorAll("a")];
    expect(anchors.map((a) => [a.getAttribute("href"), a.getAttribute("target")])).toEqual([
      ["pragma://Notes/a.md", "_blank"],
      ["pragma://Notes/b/", "_blank"],
    ]);
    expect(host.querySelector("img")).toBeNull();
    expect(host.textContent).toContain("[image: pic]");
  });
});

describe("a list in reading view", () => {
  const tightness = (markdown: string) =>
    [...render(markdown).querySelectorAll("ul, ol")].map((list) => list.classList.contains("tight-list"));

  // CommonMark's rule, which edit view's lines follow: only a blank line
  // between items, or between two blocks in one, spreads a list out.
  it("marks a list tight unless a blank line parts two of its items or two blocks in one", () => {
    expect(tightness("- a\n- b\n  - nested\n- c")).toEqual([true, true]);
    expect(tightness("1. a\n2. b\n\nAfter the list.")).toEqual([true]);
    expect(tightness("- [ ] open\n- [x] done")).toEqual([true]);
    expect(tightness("- a\n\n- b")).toEqual([false]);
    expect(tightness("- a\n\n  more of a\n- b")).toEqual([false]);
    expect(tightness("> - a\n>\n> - b")).toEqual([false]);
  });

  it("draws what a task item holds after its text, as it does for any item", () => {
    const host = render("- [ ] Buy groceries\n  - milk\n  - eggs\n\n- [x] Call the bank\n\n  Ask about the new card.");
    const [groceries, bank] = host.querySelectorAll(":scope > ul > li");
    const texts = (item: Element, selector: string) =>
      [...item.querySelectorAll(selector)].map((el) => el.textContent?.trim());

    expect(texts(groceries, ":scope > p, :scope > ul > li")).toEqual(["Buy groceries", "milk", "eggs"]);
    expect(texts(bank, ":scope > p")).toEqual(["Call the bank", "Ask about the new card."]);
    expect(groceries.querySelector<HTMLInputElement>(":scope > p > input")?.checked).toBe(false);
    expect(bank.querySelector<HTMLInputElement>(":scope > p > input")?.checked).toBe(true);
  });
});

describe("a paragraph's line breaks in reading view", () => {
  const marked = (markdown: string) =>
    [...render(markdown).querySelectorAll(".soft-break")].map((mark) => mark.parentElement?.localName);

  // Marked whatever the setting: reading.css decides whether a mark starts a
  // new line, so the setting applies without a redraw.
  it("marks each line break inside a paragraph, wherever the paragraph sits", () => {
    expect(marked("one\ntwo\nthree")).toEqual(["p", "p"]);
    expect(marked("> one\n> two")).toEqual(["p"]);
    expect(marked("- one\n  two")).toEqual(["p"]);
    expect(marked("- [ ] one\n  two")).toEqual(["p"]);
    expect(marked("*one\ntwo* and [three\nfour](https://example.com)")).toEqual(["em", "a"]);
  });

  it("leaves a code span, a hard break and the lines between blocks unmarked", () => {
    expect(marked("`one\ntwo`")).toEqual([]);
    expect(marked("one  \ntwo")).toEqual([]);
    expect(marked("one\n\ntwo\n- a\n- b\n\n> c")).toEqual([]);
  });

  it("keeps the text as written", () => {
    expect(render("one\ntwo").querySelector("p")?.textContent).toBe("one\ntwo");
  });
});

describe("frontmatter in reading view", () => {
  it("hides a block that doesn't parse, as it hides one that does", () => {
    const host = render("---\ntitle: Chapter 1: The Start\n---\n\nThe text.");
    expect(host.textContent).toBe("The text.");
  });

  it("marks each `tags` pill with its tag, and no other list's pills", () => {
    const rows = renderFrontmatter({ tags: ["lyrics", "draft"], characters: ["Lina"], title: "Song" });
    expect([...rows.querySelectorAll<HTMLElement>("[data-tag]")].map((pill) => pill.dataset.tag)).toEqual([
      "lyrics",
      "draft",
    ]);
    expect(rows.querySelectorAll(".pill")).toHaveLength(3);
  });

  it("puts each key's icon before its name, the scope mark only in an AGENTS.md", () => {
    const keys = (path: string) => [
      ...renderFrontmatter({ pragma: null, tags: ["a"], rating: 4 }, path).querySelectorAll(".meta-key"),
    ];
    const agents = keys("projects/AGENTS.md");
    expect(agents.map((key) => key.textContent)).toEqual(["pragma", "tags", "rating"]);
    expect(agents.map((key) => key.firstElementChild?.getAttribute("data-known-key"))).toEqual([
      "pragma",
      "tags",
      null,
    ]);
    expect(keys("projects/notes.md")[0].querySelector<HTMLElement>(".property-icon")?.dataset.valueType).toBe("text");
  });

  it("shows a text value whole, with no tooltip, and gives a key one for when it is cut", () => {
    const rows = renderFrontmatter({ description: "A song about leaving", rating: 4, tags: ["a"] });
    const texts = [...rows.querySelectorAll<HTMLElement>(".meta-text")];
    expect(texts.map((text) => text.textContent)).toEqual(["A song about leaving", "4"]);
    expect(texts.some((text) => "tooltipOverflow" in text.dataset)).toBe(false);
    const key = rows.querySelector<HTMLElement>(".meta-key");
    expect(key?.dataset.tooltipOverflow).toBe("");
  });

  it("locks a value a Class types as its field shows it, and one that isn't the field's as written", () => {
    const fields = [{ id: "rating", type: "score" as const, label: "Rating" }];
    const rated = renderFrontmatter({ rating: 4 }, "notes/a.md", fields);
    expect(rated.querySelectorAll(".meta-value .score-mark[data-lit]")).toHaveLength(4);
    expect(rated.querySelector(".meta-value button")).toBeNull();
    expect(renderFrontmatter({ rating: 9 }, "notes/a.md", fields).querySelector(".meta-text")?.textContent).toBe("9");
  });
});

describe("the file lines reading view marks", () => {
  const lines = (host: HTMLElement) =>
    [...host.querySelectorAll<HTMLElement>("[data-line]")].map(
      (el) => `${el.tagName.toLowerCase()}:${el.dataset.line}`,
    );

  it("marks each block with the file line it starts on, frontmatter and the lifted heading counted", () => {
    const content = [
      "---",
      "tags: [a]",
      "---",
      "",
      "# Title",
      "",
      "First para",
      "soft wrap",
      "",
      "- one",
      "- two",
      "  - nested",
      "",
      "```",
      "code",
      "```",
      "",
      "| a | b |",
      "|---|---|",
      "| 1 | 2 |",
      "",
      "> quote",
      "",
      "***",
      "",
    ].join("\n");
    const host = document.createElement("div");
    host.appendChild(renderMarkdown(content, resolvers, { omitLeadingH1: true }));
    expect(lines(host)).toEqual([
      "p:7",
      "ul:10",
      "li:10",
      "p:10",
      "li:11",
      "p:11",
      "ul:12",
      "li:12",
      "p:12",
      "pre:14",
      "table:18",
      "tr:18",
      "tr:20",
      "blockquote:22",
      "p:22",
      "hr:24",
    ]);
  });

  it("counts a file's lines whatever its line breaks", () => {
    expect(lines(render("# Heading\r\n\r\nText\r\n"))).toEqual(["h1:1", "p:3"]);
  });

  it("marks nothing in markdown that is no file's", () => {
    const host = document.createElement("div");
    host.appendChild(renderMarkdownInline("# Heading\n\nText", resolvers));
    expect(lines(host)).toEqual([]);
  });
});

describe("a comment in reading view", () => {
  const paragraphs = (host: HTMLElement) => [...host.querySelectorAll("p")].map((p) => p.textContent);
  // The page's text, the line breaks between its blocks folded.
  const text = (host: HTMLElement) => host.textContent?.replace(/\s+/g, " ").trim();

  it("is left out, inline, as a block of its own and over blank lines", () => {
    const host = render("Before <!-- inline --> after.\n\n<!-- block -->\n\n<!--\nover\n\nlines\n-->\n\nLast.");
    expect(paragraphs(host)).toEqual(["Before  after.", "Last."]);
    expect(host.textContent).not.toMatch(/inline|block|over|lines|<!--|-->/);
  });

  it("shows the HTML a comment block's last line holds past its comments, as text", () => {
    const host = render("<!-- note --> <b>shown</b> <!-- also -->\n\nText");
    expect(text(host)).toBe("<b>shown</b> Text");
  });

  it("hides one left open to its block's end", () => {
    expect(text(render("Text\n\n<!-- never closed\n\nstill hidden"))).toBe("Text");
  });

  it("goes with a lifted title, and the lines after it keep their numbers", () => {
    const host = document.createElement("div");
    host.appendChild(renderMarkdown("<!-- license -->\n\n# Title\n\nBody", resolvers, { omitLeadingH1: true }));
    expect(host.querySelector("h1")).toBeNull();
    expect(host.innerHTML).toBe('<p data-line="5">Body</p>');
  });
});

// docs/protocol.md's Display titles: only a heading the title is read from
// leaves the body.
describe("the title's heading in reading view", () => {
  const withoutTitle = (markdown: string) => {
    const host = document.createElement("div");
    host.appendChild(renderMarkdown(markdown, resolvers, { omitLeadingH1: true }));
    return host;
  };

  it("is left out where a title is read from it", () => {
    expect(withoutTitle("# Title\n\nBody").querySelector("h1")).toBeNull();
  });

  it("stays where it holds no title", () => {
    for (const markdown of ["# <b></b>\n\nBody", "#\n\nBody"]) {
      expect(withoutTitle(markdown).querySelector("h1"), markdown).not.toBeNull();
    }
  });
});

describe("an entity in reading view", () => {
  it("is the character HTML's table names, and one HTML doesn't know stays as written", () => {
    expect(render("Caf&eacute; &copy; &#x41; &foo; &notit;").textContent).toBe("Caf\u00e9 \u00a9 A &foo; &notit;");
  });
});

// docs/protocol.md's Tags: a note's `#tags` as its pills, by the rule the
// index reads them by.
describe("a tag in reading view", () => {
  const tagsIn = (page: HTMLElement) =>
    [...page.querySelectorAll<HTMLElement>(".inline-tag")].map((pill) => [pill.dataset.tag, pill.textContent]);

  it("draws each tag in prose as written, its name on the pill", () => {
    const page = render("# Title #h\n\nA *#not* tag, #Draft and **bold #night/owl**.\n\n- #item\n");
    expect(tagsIn(page)).toEqual([
      ["h", "#h"],
      ["Draft", "#Draft"],
      ["night/owl", "#night/owl"],
      ["item", "#item"],
    ]);
    expect(page.querySelector("p")?.textContent).toBe("A #not tag, #Draft and bold #night/owl.");
  });

  it("draws none in code, a link, a URL, HTML or a comment", () => {
    const page = render("`#a` [#b](x.md) <https://e.com/#c> <span>#d</span> #e<!-- #f -->\n\n```\n#g\n```\n");
    expect(tagsIn(page)).toEqual([["e", "#e"]]);
    expect(page.textContent).not.toContain("#f");
  });

  it("draws none in markdown that is no note's", () => {
    const fragment = renderMarkdownInline("A #reply", resolvers);
    const host = document.createElement("div");
    host.append(fragment);
    expect(host.querySelector(".inline-tag")).toBeNull();
    expect(host.textContent).toBe("A #reply");
  });
});

describe("math in reading view", () => {
  const hosts = (page: HTMLElement) =>
    [...page.querySelectorAll<HTMLElement>(".math")].map((el) => `${el.localName}.${el.className}: ${el.textContent}`);

  it("typesets inline math, `$$` display math and a block, each in a host of its own", () => {
    const page = render("A $x^2$ and $$\\sum_i i$$ here.\n\n$$\na = b\n\\\\ c\n$$\n");
    expect(hosts(page)).toEqual([
      "span.math: inline: x^2",
      "span.math math-display: display: \\sum_i i",
      "div.math math-display: display: a = b\n\\\\ c",
    ]);
  });

  it("marks a block with the file line it opens on", () => {
    const page = render("para\n\n$$\nx\n$$\n");
    expect(page.querySelector<HTMLElement>("div.math")?.dataset.line).toBe("3");
  });

  it("shows math holding no TeX as written", () => {
    const page = render("text\n$$");
    expect(hosts(page)).toEqual(["div.math math-display: $$"]);
  });

  it("draws no tag and breaks no line inside math", () => {
    const page = render("$x #a$ #b and $c\nd$");
    expect([...page.querySelectorAll(".inline-tag")].map((pill) => pill.textContent)).toEqual(["#b"]);
    expect(page.querySelector(".math .soft-break")).toBeNull();
  });

  it("typesets a chat reply's math too", () => {
    const host = document.createElement("div");
    host.append(renderMarkdownInline("so $y$", resolvers));
    expect(hosts(host)).toEqual(["span.math: inline: y"]);
  });

  it("reads TeX's own marks as math in a chat reply, never in a note", () => {
    const reply = document.createElement("div");
    reply.append(renderMarkdownInline("so \\(x\\) and \\[\ny = 1\n\\] but \\[open", resolvers));
    expect(hosts(reply)).toEqual(["span.math: inline: x", "span.math math-display: display: \ny = 1\n"]);
    expect(reply.textContent).toContain("but [open");
    const note = render("so \\(x\\) and \\[y\\]");
    expect(hosts(note)).toEqual([]);
    expect(note.textContent).toBe("so (x) and [y]");
  });
});

// A path is any text a name can hold, and a link's own text can be shaped to
// survive into a scheme: neither may become an href a browser would run.
describe("a link into the space", () => {
  const anyPath = { image: () => undefined, link: (href: string) => href, wikilink: (target: string) => target };
  const linksIn = (markdown: string) => {
    const host = document.createElement("div");
    host.appendChild(renderMarkdown(markdown, anyPath));
    return [...host.querySelectorAll("a")];
  };

  it("gets a fragment for its href, its path kept for the click to follow", () => {
    const [link] = linksIn("[Plan](notes/plan.md)");
    expect(link.getAttribute("href")).toBe("#notes%2Fplan.md");
    expect(link.dataset.spacePath).toBe("notes/plan.md");
  });

  it("reads a destination in angle brackets as the text inside them, a link's, an image's or a web link's", () => {
    const host = document.createElement("div");
    const resolvers = { ...anyPath, image: (href: string) => `/raw/${href}` };
    host.appendChild(renderMarkdown("[Plan](<my plan.md>) ![shot](<my shot.png>) [site](<https://a.com>)", resolvers));
    expect(host.querySelector<HTMLElement>("a[data-space-path]")?.dataset.spacePath).toBe("my plan.md");
    expect(host.querySelector("img")?.getAttribute("src")).toBe("/raw/my shot.png");
    expect(host.querySelector("a[target=_blank]")?.getAttribute("href")).toBe("https://a.com");
  });

  it("never carries a script URL, however its target is spelled", () => {
    const links = linksIn("[x][r] and [[javascript:alert(1)]]\n\n[r]: <java\tscript:alert(document.domain)>");
    expect(links).toHaveLength(2);
    for (const link of links) {
      expect(link.getAttribute("href")?.startsWith("#")).toBe(true);
      expect(link.protocol).not.toBe("javascript:");
    }
  });

  it("draws a wikilink naming nothing as broken, or as text while its root's listing is still to land", () => {
    const drawn = (pending: boolean) => {
      const host = document.createElement("div");
      const wikilink = (target: string) => (target === "plan" ? "notes/plan.md" : undefined);
      host.appendChild(
        renderMarkdown("[[plan]] and [[gone|the gone]]", { ...anyPath, wikilink, wikilinkPending: () => pending }),
      );
      return host;
    };
    expect(drawn(false).querySelector(".wikilink-unresolved")?.textContent).toBe("the gone");
    const waiting = drawn(true);
    expect(waiting.querySelector(".wikilink-unresolved")).toBeNull();
    expect([...waiting.querySelectorAll("a")].map((link) => link.textContent)).toEqual(["plan"]);
    expect(waiting.textContent).toBe("plan and the gone");
  });
});

describe("the answers a page was drawn from", () => {
  it("say it changed only once asking again answers differently", () => {
    let listed = false;
    const { resolvers: kept, changed } = keepingAnswers({
      image: (href: string) => `/raw/${href}`,
      link: (href: string) => `notes/${href}`,
      wikilink: (target: string) => (listed ? `notes/${target}.md` : undefined),
      wikilinkPending: () => !listed,
      hint: (lead: LinkLead) => ("url" in lead ? lead.url : lead.path),
    });
    renderMarkdown("[[plan]] [clip](clip.mp4) ![shot](shot.png)", kept);
    expect(changed()).toBe(false);
    listed = true;
    expect(changed()).toBe(true);
  });
});

describe("a link's hint in reading view", () => {
  // Says back where each link leads, and its text.
  const hint = (lead: LinkLead, text: string) =>
    `${"url" in lead ? lead.url : `${lead.form} ${lead.written} ${lead.path ?? "none"}`} / ${text}`;
  const hinting = {
    image: () => undefined,
    link: (href: string) => (href.startsWith("#") ? undefined : `notes/${href}`),
    wikilink: (target: string) => (target === "missing" ? undefined : `notes/${target}.md`),
    hint,
  };
  const hintsIn = (markdown: string, given: Parameters<typeof renderMarkdown>[1]) => {
    const host = document.createElement("div");
    host.appendChild(renderMarkdown(markdown, given));
    return [...host.querySelectorAll<HTMLElement>("a, span")].map((el) => [el.textContent, el.dataset.tooltip]);
  };
  const doc = "[docs](https://a.com) [the **clip**](clip.mp4) [[plan|the plan]] [[missing]] [top](#top) https://b.com";

  it("asks for each link's hint by where it leads, and a bare address needs none", () => {
    expect(hintsIn(doc, hinting)).toEqual([
      ["docs", "https://a.com / docs"],
      ["the clip", "markdown clip.mp4 notes/clip.mp4 / the clip"],
      ["the plan", "wikilink plan notes/plan.md / the plan"],
      ["missing", "wikilink missing none / missing"],
      ["top", "markdown #top none / top"],
      ["https://b.com", undefined],
    ]);
  });

  it("gives none where the caller gives no hints", () => {
    expect(hintsIn(doc, { ...hinting, hint: undefined }).every(([, tooltip]) => tooltip === undefined)).toBe(true);
  });
});
