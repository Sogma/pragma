import { describe, expect, it } from "vitest";
import {
  basenameOf,
  dirnameOf,
  formatDeclaredPath,
  formatRootedPath,
  hasPathScheme,
  isLibraryPath,
  isLibraryRoot,
  parseRootedPath,
  type RootedPath,
} from "../../src/protocol/rootedPath.ts";

describe("rooted paths", () => {
  it("reads a bare path as the space", () => {
    expect(parseRootedPath("notes/a.md")).toEqual({ root: "space", path: "notes/a.md" });
    expect(parseRootedPath("a.md")).toEqual({ root: "space", path: "a.md" });
    expect(parseRootedPath("")).toEqual({ root: "space", path: "" });
  });

  it("reads lib: as that library", () => {
    expect(parseRootedPath("lib:footage/b-roll/sunset.jpg")).toEqual({
      root: { library: "footage" },
      path: "b-roll/sunset.jpg",
    });
  });

  // The case the scheme-before-slash rule exists for: this has no slash, so
  // a parser applying the document-relative rule first would hand back a
  // sibling file literally named "lib:cover.png".
  it("reads a scheme before applying any slash rule", () => {
    expect(parseRootedPath("lib:footage/cover.png")).toEqual({
      root: { library: "footage" },
      path: "cover.png",
    });
    expect(parseRootedPath("lib:footage")).toEqual({ root: { library: "footage" }, path: "" });
  });

  it("rejects a scheme it doesn't define rather than falling back to the space", () => {
    expect(() => parseRootedPath("foo:bar/baz.md")).toThrow(/not a path scheme/);
    // Recognized as a scheme, not read as a space file named "Lib:x" — only
    // the lowercase spelling is legal.
    expect(() => parseRootedPath("Lib:footage/x.png")).toThrow(/not a path scheme/);
  });

  // A document in a folder has no other way to name an entry at the space
  // root: there, a bare name is the file beside the document.
  it("reads space: as the space, from its root, with no id", () => {
    expect(parseRootedPath("space:tags.table.html")).toEqual({ root: "space", path: "tags.table.html" });
    expect(parseRootedPath("space:notes/a.md")).toEqual({ root: "space", path: "notes/a.md" });
    expect(parseRootedPath("space:")).toEqual({ root: "space", path: "" });
    expect(() => parseRootedPath("Space:a.md")).toThrow(/not a path scheme/);
    for (const input of ["space:/etc/passwd", "space:../a.md", "space:a//b.md"]) {
      expect(() => parseRootedPath(input), input).toThrow();
    }
  });

  it("stores a dragged path as an address, so it names the same entry from any folder", () => {
    expect(formatDeclaredPath({ root: "space", path: "tags.table.html" })).toBe("space:tags.table.html");
    expect(formatDeclaredPath({ root: "space", path: "projects/a/log.table.html" })).toBe(
      "space:projects/a/log.table.html",
    );
    expect(formatDeclaredPath({ root: { library: "footage" }, path: "x.png" })).toBe("lib:footage/x.png");
    // A colon is no scheme past the first one, so the name survives whole.
    const odd = formatDeclaredPath({ root: "space", path: "12:30 standup.md" });
    expect(parseRootedPath(odd)).toEqual({ root: "space", path: "12:30 standup.md" });
  });

  it("rejects a library path with no usable id", () => {
    for (const input of ["lib:", "lib:/x.png", "lib:Footage/x.png", "lib:-foo/x.png", "lib:a_b/x.png"]) {
      expect(() => parseRootedPath(input), input).toThrow(/library id/);
    }
  });

  it("rejects traversal, absolute paths and empty segments under either root", () => {
    for (const input of ["../secrets.md", "a/../../b.md", "/etc/passwd", "a//b.md"]) {
      expect(() => parseRootedPath(input), input).toThrow();
    }
    for (const input of ["lib:footage/../../secrets.md", "lib:footage//x.png", "lib:footage//"]) {
      expect(() => parseRootedPath(input), input).toThrow();
    }
  });

  // Windows splits at `\` as well, so `notes\..\.git\config` would reach
  // `.git` past every check that reads the string.
  it("refuses a backslash under either root, on every platform", () => {
    for (const input of [
      "notes\\a.md",
      "notes\\..\\.git\\config",
      "notes/x\\..\\..\\.git\\config",
      "space:notes\\a.md",
      "lib:footage/b-roll\\x.png",
      "\\\\server\\share\\x.md",
    ]) {
      expect(() => parseRootedPath(input), input).toThrow('must use "/" between names');
    }
  });

  // A colon inside a path segment isn't a scheme — only a leading one is.
  it("leaves a colon inside a path alone", () => {
    expect(parseRootedPath("notes/12:30 standup.md")).toEqual({
      root: "space",
      path: "notes/12:30 standup.md",
    });
  });

  it("drops one trailing slash", () => {
    expect(parseRootedPath("notes/")).toEqual({ root: "space", path: "notes" });
    expect(parseRootedPath("lib:footage/")).toEqual({ root: { library: "footage" }, path: "" });
  });

  it("round-trips through format", () => {
    for (const input of ["notes/a.md", "a.md", "", "lib:footage/b-roll/sunset.jpg", "lib:footage"]) {
      expect(formatRootedPath(parseRootedPath(input)), input).toBe(input);
    }
  });

  it("narrows the root by type, not by re-reading the string", () => {
    const space: RootedPath = parseRootedPath("a.md");
    const library: RootedPath = parseRootedPath("lib:footage/a.png");
    expect(isLibraryRoot(space.root)).toBe(false);
    expect(isLibraryRoot(library.root)).toBe(true);
    if (isLibraryRoot(library.root)) expect(library.root.library).toBe("footage");
  });

  describe("naming a root from a raw string", () => {
    it("recognizes a scheme without judging it", () => {
      expect(hasPathScheme("lib:footage/x.png")).toBe(true);
      // The point of the predicate: an unknown scheme is still a scheme, so
      // a caller defers to the parser and gets it refused by name rather
      // than resolving it as a filename.
      expect(hasPathScheme("foo:bar/baz.md")).toBe(true);
      expect(hasPathScheme("space:a.md")).toBe(true);
      expect(hasPathScheme("notes/a.md")).toBe(false);
      expect(hasPathScheme("a.md")).toBe(false);
    });

    it("tells a library path from a space one, and calls an unparseable path neither", () => {
      expect(isLibraryPath("lib:footage/x.png")).toBe(true);
      // No slash: the case the slash rule alone would read as a sibling
      // file literally named "lib:cover.png".
      expect(isLibraryPath("lib:footage")).toBe(true);
      expect(isLibraryPath("notes/a.md")).toBe(false);
      expect(isLibraryPath("foo:bar/baz.md")).toBe(false);
      expect(isLibraryPath("lib:Footage/x.png")).toBe(false); // not a legal id
    });
  });

  describe("dirnameOf and basenameOf", () => {
    it("split a path at its last slash, keeping a rooted path's root", () => {
      expect(dirnameOf("projects/a/notes.md")).toBe("projects/a");
      expect(dirnameOf("notes.md")).toBe("");
      expect(dirnameOf("lib:footage/stills/a.png")).toBe("lib:footage/stills");
      expect(dirnameOf("lib:footage/a.png")).toBe("lib:footage");
      expect(basenameOf("projects/a/notes.md")).toBe("notes.md");
      expect(basenameOf("lib:footage/a.png")).toBe("a.png");
      expect(basenameOf("notes.md")).toBe("notes.md");
    });
  });
});
