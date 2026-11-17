import { describe, expect, it } from "vitest";
import {
  formatWrittenPath,
  isDeclaredAddress,
  isHiddenPath,
  readWrittenPath,
  resolveDeclaredPath,
  resolveFileReference,
} from "../../src/protocol/relativeReference.ts";
import { formatDeclaredPath, parseRootedPath, type RootedPath } from "../../src/protocol/rootedPath.ts";

// Conformance tests for how a document's paths are read and written — the
// pair a move depends on, since a path it rewrites has to resolve back to
// the file it just retargeted.
describe("resolveFileReference", () => {
  it("resolves a same-directory and a parent-directory reference", () => {
    expect(resolveFileReference("projects/demo", "./note.md")).toBe("projects/demo/note.md");
    expect(resolveFileReference("projects/demo", "../other/note.md")).toBe("projects/other/note.md");
  });

  it("resolves against a root-level document with no double slash", () => {
    expect(resolveFileReference("", "note.md")).toBe("note.md");
  });

  it("round-trips a path with spaces and unicode", () => {
    expect(resolveFileReference("projects", "café notes.md")).toBe("projects/café notes.md");
  });

  it("resolves a sibling and a nested reference inside the same library", () => {
    expect(resolveFileReference("lib:footage", "cover.png")).toBe("lib:footage/cover.png");
    expect(resolveFileReference("lib:footage/notes", "../stills/a.png")).toBe("lib:footage/stills/a.png");
  });

  // A folder opened alone would otherwise read a climbing path as one of its
  // own; from a library, it would land in the space.
  it("names nothing with a `..` past the root", () => {
    expect(resolveFileReference("lib:footage", "../../../secrets.md")).toBeUndefined();
    expect(resolveFileReference("projects/demo", "../../../secrets.md")).toBeUndefined();
    expect(resolveFileReference("projects/demo", "../../secrets.md")).toBe("secrets.md");
  });

  it("never names a dot-entry", () => {
    expect(resolveFileReference("projects", ".git/config")).toBeUndefined();
    expect(resolveFileReference("projects", "a/.draft.md")).toBeUndefined();
  });

  it("reads a scheme as its own root, and a URL with no scheme as nothing", () => {
    expect(resolveFileReference("notes", "lib:footage/stills/a.png")).toBe("lib:footage/stills/a.png");
    expect(resolveFileReference("notes", "space:cover.png")).toBe("cover.png");
    expect(resolveFileReference("notes", "a.png")).toBe("notes/a.png");
    expect(resolveFileReference("notes", "data:image/png;base64,AAAA")).toBeUndefined();
    expect(resolveFileReference("notes", "//elsewhere/a.png")).toBeUndefined();
  });

  // A library means the same thing whichever space browses it.
  it("never leaves a library from a library document, space: included", () => {
    expect(resolveFileReference("lib:footage/notes", "space:cover.png")).toBeUndefined();
    expect(resolveFileReference("lib:footage/notes", "lib:other/a.png")).toBeUndefined();
    expect(resolveFileReference("lib:footage/notes", "lib:footage/stills/a.png")).toBe("lib:footage/stills/a.png");
  });

  it("percent-decodes a library path as it does a relative one", () => {
    expect(resolveFileReference("notes", "lib:footage/my%20cat.png")).toBe("lib:footage/my cat.png");
    expect(resolveFileReference("notes", "lib:footage/my cat.png")).toBe("lib:footage/my cat.png");
  });
});

describe("writing a path, then reading it back", () => {
  const lib = (library: string, path: string): RootedPath => ({ root: { library }, path });
  const write = (docDir: string, target: RootedPath) =>
    formatWrittenPath(docDir, target, { form: "markdown", scopes: new Set() });
  const space = (path: string): RootedPath => ({ root: "space", path });

  it("names a library file outright from a space document, encoded", () => {
    expect(write("blog", lib("footage", "stills/a.png"))).toBe("lib:footage/stills/a.png");
    expect(write("blog", lib("footage", "my cat.png"))).toBe("lib:footage/my%20cat.png");
  });

  it("stays relative within one root, and refuses a library naming outside it", () => {
    expect(write("blog", space("art/a.png"))).toBe("../art/a.png");
    expect(write("lib:footage/notes", lib("footage", "stills/a.png"))).toBe("../stills/a.png");
    expect(write("lib:footage", space("a.png"))).toBeUndefined();
    expect(write("lib:footage", lib("other", "a.png"))).toBeUndefined();
  });

  it("hops up out of the document's own directory, and names a descendant from the root", () => {
    expect(write("projects/demo", space("projects/demo/note.md"))).toBe("note.md");
    expect(write("projects/demo", space("projects/other/note.md"))).toBe("../other/note.md");
    expect(write("a/b/c", space("note.md"))).toBe("../../../note.md");
    expect(write("", space("projects/demo/note.md"))).toBe("projects/demo/note.md");
  });

  // A directory that merely shares a *name* with the target file is not a
  // shared ancestor — stopping one short of the filename is what prevents
  // "notes/notes.md" from collapsing to nothing.
  it("never treats the target's own filename as a shared directory", () => {
    expect(write("notes", space("notes/notes.md"))).toBe("notes.md");
    expect(write("notes", space("notes.md"))).toBe("../notes.md");
  });

  it("percent-encodes what would otherwise break a Markdown destination", () => {
    expect(write("", space("my notes.md"))).toBe("my%20notes.md");
    expect(write("", space("take (1).md"))).toBe("take%20%281%29.md");
  });

  it("round-trips through the reader", () => {
    for (const [dir, target] of [
      ["projects/demo", "projects/other/note.md"],
      ["", "a/b/c.md"],
      ["a/b/c", "note.md"],
      ["projects", "my notes (draft).md"],
    ] as const) {
      expect(resolveFileReference(dir, write(dir, space(target)) ?? "")).toBe(target);
    }
  });
});

// The one reader for a path a Flow node or an Applet import declares.
describe("resolveDeclaredPath", () => {
  const read = (folder: string, declared: string) => formatDeclaredPath(resolveDeclaredPath(folder, declared));

  it("reads an address by its own root, wherever the document sits", () => {
    expect(read("projects/movie", "space:tags.table.html")).toBe("space:tags.table.html");
    expect(read("projects/movie", "space:projects/a/x.md")).toBe("space:projects/a/x.md");
    expect(read("projects/movie", "lib:footage/x.png")).toBe("lib:footage/x.png");
  });

  it("reads anything else from the document's folder, as a Markdown link is", () => {
    expect(read("tools", "lyrics.md")).toBe("space:tools/lyrics.md");
    expect(read("tools", "./lyrics.md")).toBe("space:tools/lyrics.md");
    expect(read("tools", "../world/places.md")).toBe("space:world/places.md");
    expect(read("tools", "art/cover.png")).toBe("space:tools/art/cover.png");
    expect(read("", "note.md")).toBe("space:note.md");
  });

  it("reads a leading slash from the root, and refuses a `..` past it", () => {
    expect(read("tools/deep", "/world/places.md")).toBe("space:world/places.md");
    expect(() => resolveDeclaredPath("tools", "../../../secrets.md")).toThrow(/climbs above its root/);
  });

  it("refuses a hidden entry, by address or by reference", () => {
    expect(() => resolveDeclaredPath("tools", ".env")).toThrow(/hidden entry/);
    expect(() => resolveDeclaredPath("tools", "space:projects/.git/config")).toThrow(/hidden entry/);
  });

  // One reader for every path a document holds, an address included.
  it("reads a name with spaces whether or not it is percent-encoded, an address's too", () => {
    expect(read("tools", "scene a.md")).toBe("space:tools/scene a.md");
    expect(read("tools", "scene%20a.md")).toBe("space:tools/scene a.md");
    expect(read("tools", "space:tools/scene a.md")).toBe("space:tools/scene a.md");
    expect(read("tools", "space:tools/scene%20a.md")).toBe("space:tools/scene a.md");
    expect(read("tools", "lib:footage/my%20cat.png")).toBe("lib:footage/my cat.png");
  });

  it("refuses a step inside an address, which has one spelling", () => {
    for (const declared of ["space:a/../b.md", "space:a/./b.md", "space:a//b.md", "space:/b.md"]) {
      expect(() => resolveDeclaredPath("tools", declared), declared).toThrow(/isn't a path Pragma can read/);
    }
  });

  it("refuses a scheme it doesn't define, never reading it as a folder name", () => {
    expect(() => resolveDeclaredPath("tools", "foo:bar/baz.md")).toThrow(/isn't a path Pragma can read/);
    expect(() => resolveDeclaredPath("tools", "https://example.com/x.md")).toThrow(/isn't a path Pragma can read/);
  });

  it("refuses a reference that decodes to a traversal", () => {
    expect(() => resolveDeclaredPath("tools", "a%2F..%2F..%2Fb.md")).toThrow();
  });

  it("keeps a library document in its own library", () => {
    expect(read("lib:footage/shots", "../stills/a.png")).toBe("lib:footage/stills/a.png");
    expect(() => resolveDeclaredPath("lib:footage", "space:notes.md")).toThrow(/library document/);
    expect(() => resolveDeclaredPath("lib:footage", "lib:other/a.png")).toThrow(/library document/);
  });
});

describe("isDeclaredAddress", () => {
  it("accepts an address in its one spelling and nothing else", () => {
    expect(isDeclaredAddress("space:projects/a/x.md")).toBe(true);
    expect(isDeclaredAddress("space:x.md")).toBe(true);
    expect(isDeclaredAddress("lib:footage/x.png")).toBe(true);
    for (const input of [
      "x.md",
      "projects/a/x.md",
      "./x.md",
      "space:./x.md",
      "space:a/../x.md",
      "space:a/x.md/",
      "space:/x.md",
      "lib:Footage/x.png",
      "foo:bar",
    ]) {
      expect(isDeclaredAddress(input), input).toBe(false);
    }
  });
});

describe("isHiddenPath", () => {
  it("is true for a path with any segment that starts with a dot", () => {
    expect(isHiddenPath(".env")).toBe(true);
    expect(isHiddenPath("projects/.git/config")).toBe(true);
    expect(isHiddenPath("projects/a.b/x.md")).toBe(false);
  });
});

// The one grammar every path a document writes is read by.
describe("readWrittenPath", () => {
  const read = (docDir: string, written: string, form: "markdown" | "wikilink" = "markdown") =>
    readWrittenPath(docDir, written, form);

  it("reads a scheme by its root, a leading `/` from the document's root, and the rest from its folder", () => {
    expect(read("notes", "lib:footage/a.png")).toEqual({
      target: { root: { library: "footage" }, path: "a.png" },
      folder: false,
    });
    expect(read("notes", "space:a/b.md")?.target).toEqual({ root: "space", path: "a/b.md" });
    expect(read("lib:footage/notes", "/stills/a.png")?.target).toEqual({
      root: { library: "footage" },
      path: "stills/a.png",
    });
    expect(read("notes", "a/b.md")?.target).toEqual({ root: "space", path: "notes/a/b.md" });
  });

  it("marks a trailing `/` as naming only a folder", () => {
    expect(read("notes", "drafts/")).toEqual({ target: { root: "space", path: "notes/drafts" }, folder: true });
    expect(read("notes", "/")).toEqual({ target: { root: "space", path: "" }, folder: true });
    expect(read("notes", ".")?.target.path).toBe("notes");
  });

  it("cuts a Markdown link's anchor and query, and reads a wikilink as written", () => {
    expect(read("notes", "a.md#part")?.target.path).toBe("notes/a.md");
    expect(read("notes", "a.md?x=1")?.target.path).toBe("notes/a.md");
    expect(read("notes", "#part")).toBeUndefined();
    expect(read("notes", "a%20b.md")?.target.path).toBe("notes/a b.md");
    expect(read("notes", "a%20b", "wikilink")?.target.path).toBe("notes/a%20b");
  });

  it("decodes each segment on its own, so an encoded `/` never splits one", () => {
    expect(read("notes", "a%2Fb.md")).toBeUndefined();
    expect(read("notes", "%2E%2E/b.md")?.target.path).toBe("b.md");
  });

  it("reads an address with no steps in it, a folder by its one trailing `/`", () => {
    expect(read("notes", "space:a/../b.md")).toBeUndefined();
    expect(read("notes", "space:a/%2E%2E/b.md")).toBeUndefined();
    expect(read("notes", "lib:footage/a//b.png")).toBeUndefined();
    expect(read("notes", "lib:footage/stills/")).toEqual({
      target: { root: { library: "footage" }, path: "stills" },
      folder: true,
    });
    expect(read("notes", "space:")?.target).toEqual({ root: "space", path: "" });
  });

  it("names nothing for another scheme, a URL with no scheme, or an unknown library id", () => {
    expect(read("notes", "https://example.com/a.md")).toBeUndefined();
    expect(read("notes", "mailto:a@b.c")).toBeUndefined();
    expect(read("notes", "//example.com/a.md")).toBeUndefined();
    expect(read("notes", "lib:Footage/a.png")).toBeUndefined();
  });

  it("splits on a backslash too, so `..\\` can't climb unseen", () => {
    expect(read("a/b", "..\\c.md")?.target.path).toBe("a/c.md");
    expect(read("a", "..\\..\\c.md")).toBeUndefined();
  });
});

describe("formatWrittenPath", () => {
  const write = (docDir: string, target: string, scopes: string[] = [], folder = false) =>
    formatWrittenPath(docDir, parseRootedPath(target), { form: "markdown", scopes: new Set(scopes), folder });

  it("writes relative inside the same closest parent scope, encoded and with `.md` kept", () => {
    expect(write("projects/a", "projects/a/my notes.md")).toBe("my%20notes.md");
    expect(write("projects/a", "projects/b/x.md")).toBe("../b/x.md");
  });

  it("writes from the root across a scope's edge, in either direction", () => {
    expect(write("projects/a", "projects/b/x.md", ["projects/a"])).toBe("/projects/b/x.md");
    expect(write("projects", "projects/a/x.md", ["projects/a"])).toBe("/projects/a/x.md");
  });

  it("writes a library as one scope", () => {
    expect(write("lib:footage/notes", "lib:footage/stills/a b.png", ["notes"])).toBe("../stills/a%20b.png");
  });

  it("ends a folder in `/`, the document's own root included", () => {
    expect(write("projects/a", "projects/a/shots", [], true)).toBe("shots/");
    expect(write("", "", [], true)).toBe("./");
    expect(write("projects/a", "", ["projects/a"], true)).toBe("/");
  });
});
