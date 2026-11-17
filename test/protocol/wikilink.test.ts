import { describe, expect, it } from "vitest";
import { createPathIndex, type PathIndex, resolveWrittenPath } from "../../src/protocol/pathIndex.ts";
import { formatWrittenPath } from "../../src/protocol/relativeReference.ts";
import { type PathRoot, parseRootedPath } from "../../src/protocol/rootedPath.ts";
import {
  formatWikilinkLabel,
  splitWikilinkLabel,
  wikilinkFromRoot,
  wikilinkName,
  wikilinkPattern,
} from "../../src/protocol/wikilink.ts";

// Conformance tests for docs/protocol.md's Links section: the syntax, and a
// wikilink read as a path by the one grammar every path shares, independent
// of who supplies the listing.
describe("wikilink syntax", () => {
  it("matches every `[[...]]` in a line, including a piped one", () => {
    const found = [..."see [[a]] and [[b/c|C]] here".matchAll(wikilinkPattern())].map((m) => m[1]);
    expect(found).toEqual(["a", "b/c|C"]);
  });

  it("does not match an unclosed or empty target", () => {
    expect([..."[[unclosed and [[]] here".matchAll(wikilinkPattern())].map((m) => m[1])).toEqual([]);
  });

  it("hands out a fresh matcher each call, so two scans can't skip each other's matches", () => {
    const text = "[[a]] [[b]]";
    expect([...text.matchAll(wikilinkPattern())].length).toBe(2);
    expect([...text.matchAll(wikilinkPattern())].length).toBe(2);
  });

  it("splits at the first pipe and trims both halves", () => {
    expect(splitWikilinkLabel(" notes/plan | The plan ")).toEqual({ target: "notes/plan", display: "The plan" });
  });

  it("keeps later pipes as display text — only the first one separates", () => {
    expect(splitWikilinkLabel("plan|a|b")).toEqual({ target: "plan", display: "a|b" });
  });

  // Its folders mean nothing to a reader; a path from a root is shown as written.
  it("displays an unpiped relative link by its file or folder name alone", () => {
    expect(splitWikilinkLabel("plan")).toEqual({ target: "plan", display: "plan" });
    expect(splitWikilinkLabel("plan|")).toEqual({ target: "plan", display: "plan" });
    expect(splitWikilinkLabel("../cast/bob").display).toBe("bob");
    expect(splitWikilinkLabel("projects/a/bob").display).toBe("bob");
    expect(splitWikilinkLabel("takes.table.html").display).toBe("takes");
    expect(splitWikilinkLabel("scenes/").display).toBe("scenes");
    expect(splitWikilinkLabel("bob|Bob Smith").display).toBe("Bob Smith");
    expect(splitWikilinkLabel("/projects/a/bob").display).toBe("/projects/a/bob");
    expect(splitWikilinkLabel("lib:footage/a.png").display).toBe("lib:footage/a.png");
  });
});

const SPACE = createPathIndex({
  files: [
    "projects/a/README.md",
    "projects/a/cast/bob.md",
    "projects/a/scenes/one.md",
    "projects/a/takes.table.html",
    "projects/a/plan.md",
    "bob.md",
    "notes/plan.md",
    "notes/café.md",
    "data/report.zip",
    "data/budget.csv",
    ".hidden/secret.md",
  ],
  folders: ["projects", "projects/a", "projects/a/cast", "projects/a/scenes", "projects/a/plan", "notes", "data"],
});
const FOOTAGE = createPathIndex({ files: ["stills/a.png", "notes/n.md"], folders: ["stills", "notes"] });
const indexOf = (root: PathRoot): PathIndex | undefined =>
  root === "space" ? SPACE : root.library === "footage" ? FOOTAGE : undefined;
const wikilink = (fromDir: string, target: string) => resolveWrittenPath(fromDir, target, "wikilink", indexOf)?.path;

describe("reading a wikilink", () => {
  it("reads a plain target from the linking document's folder", () => {
    expect(wikilink("projects/a/scenes", "one")).toBe("projects/a/scenes/one.md");
    expect(wikilink("projects/a/scenes", "../cast/bob")).toBe("projects/a/cast/bob.md");
    expect(wikilink("projects/a", "cast/bob.md")).toBe("projects/a/cast/bob.md");
    expect(wikilink("projects/a", "./cast/bob")).toBe("projects/a/cast/bob.md");
  });

  // A wikilink is a path, never a name: a file of that name elsewhere, or
  // at the root, never changes what it opens.
  it("never falls back to the root or to a name match", () => {
    expect(wikilink("projects/a/scenes", "bob")).toBeUndefined();
    expect(wikilink("projects/a/scenes", "notes/plan")).toBeUndefined();
    expect(wikilink("", "one")).toBeUndefined();
  });

  it("reads a leading `/` from the root", () => {
    expect(wikilink("projects/a", "/notes/plan")).toBe("notes/plan.md");
    expect(wikilink("projects/a", "/bob")).toBe("bob.md");
  });

  it("names nothing with a `..` past the root, rather than stopping there", () => {
    expect(wikilink("projects/a", "../../bob")).toBe("bob.md");
    expect(wikilink("projects/a", "../../../bob")).toBeUndefined();
  });

  it("leaves off only `.md`, and names a folder only with its `/`", () => {
    expect(wikilink("projects/a", "takes.table.html")).toBe("projects/a/takes.table.html");
    expect(wikilink("projects/a", "takes")).toBeUndefined();
    expect(wikilink("projects/a", "plan")).toBe("projects/a/plan.md");
    expect(wikilink("projects/a", "plan/")).toBe("projects/a/plan");
    expect(wikilink("projects/a", "scenes")).toBeUndefined();
    expect(wikilink("projects/a", "scenes/")).toBe("projects/a/scenes");
    expect(wikilink("projects/a", "/")).toBe("");
  });

  it("names a file of no kind by its whole name", () => {
    expect(wikilink("data", "report.zip")).toBe("data/report.zip");
    expect(wikilink("data", "report")).toBeUndefined();
  });

  it("ignores case and Unicode form", () => {
    expect(wikilink("projects/a/scenes", "../Cast/BOB")).toBe("projects/a/cast/bob.md");
    expect(wikilink("", "NOTES/Plan.MD")).toBe("notes/plan.md");
    expect(wikilink("notes", "café")).toBe("notes/café.md");
  });

  it("never names a dot-entry", () => {
    expect(wikilink("", ".hidden/secret")).toBeUndefined();
  });

  it("reads `lib:` from that library, and keeps a library document inside its own", () => {
    expect(wikilink("notes", "lib:footage/stills/a.png")).toBe("lib:footage/stills/a.png");
    expect(wikilink("lib:footage/notes", "../stills/a.png")).toBe("lib:footage/stills/a.png");
    expect(wikilink("lib:footage/notes", "space:bob")).toBeUndefined();
    expect(wikilink("lib:footage/notes", "/bob")).toBeUndefined();
    expect(wikilink("notes", "lib:unloaded/x.png")).toBeUndefined();
  });

  it("names nothing for a blank target", () => {
    expect(wikilink("projects/a", "   ")).toBeUndefined();
  });
});

describe("two entries whose names fold alike", () => {
  const twins = createPathIndex({ files: ["Plan.md", "plan.md", "plan.txt"], folders: [] });
  it("leave the path naming neither", () => {
    expect(resolveWrittenPath("", "plan", "wikilink", () => twins)).toBeUndefined();
    expect(resolveWrittenPath("", "plan.txt", "wikilink", () => twins)?.path).toBe("plan.txt");
  });
});

describe("writing a wikilink", () => {
  const scopes = new Set(["projects/a", "projects/a/sub"]);
  const write = (docDir: string, target: string, folder = false) =>
    formatWrittenPath(docDir, parseRootedPath(target), { form: "wikilink", scopes, folder });

  it("writes a target with the same closest parent scope relative, `.md` left off", () => {
    expect(write("projects/a/scenes", "projects/a/scenes/two.md")).toBe("two");
    expect(write("projects/a/scenes", "projects/a/cast/bob.md")).toBe("../cast/bob");
    expect(write("projects/a", "projects/a/takes.table.html")).toBe("takes.table.html");
    expect(write("loose", "notes/plan.md")).toBe("../notes/plan");
  });

  // A scope's own folder is in it, so linking it from outside crosses in.
  it("writes any other target from the root", () => {
    expect(write("projects/a/scenes", "notes/plan.md")).toBe("/notes/plan");
    expect(write("projects/a", "projects/a/sub/x.md")).toBe("/projects/a/sub/x");
    expect(write("projects", "projects/a", true)).toBe("/projects/a/");
  });

  it("ends a folder in `/`", () => {
    expect(write("projects/a/scenes", "projects/a/cast", true)).toBe("../cast/");
    expect(write("projects/a", "projects/a", true)).toBe("../a/");
  });

  it("names a library file outright from the space, and nothing outside from a library", () => {
    expect(write("notes", "lib:footage/stills/a.png")).toBe("lib:footage/stills/a.png");
    expect(write("lib:footage/notes", "lib:footage/stills/a.png")).toBe("../stills/a.png");
    expect(write("lib:footage/notes", "bob.md")).toBeUndefined();
    expect(write("lib:footage/notes", "lib:other/a.png")).toBeUndefined();
  });

  it("round-trips: what is written reads back to the entry it was written for", () => {
    for (const [docDir, target] of [
      ["projects/a/scenes", "projects/a/cast/bob.md"],
      ["projects/a/scenes", "notes/plan.md"],
      ["data", "data/report.zip"],
    ]) {
      expect(wikilink(docDir, write(docDir, target) ?? "")).toBe(target);
    }
  });
});

describe("a wikilink's label", () => {
  it("pipes the title only when the unpiped link would show something else", () => {
    expect(formatWikilinkLabel("../cast/bob", "bob")).toBe("../cast/bob");
    expect(formatWikilinkLabel("../cast/bob", "Bob Smith")).toBe("../cast/bob|Bob Smith");
    // Case is something a reader sees.
    expect(formatWikilinkLabel("../cast/bob", "Bob")).toBe("../cast/bob|Bob");
  });

  // Unpiped, a root path shows the whole path, so it always takes the title.
  it("always pipes a path from a root", () => {
    expect(formatWikilinkLabel("/projects/b/x", "X marks")).toBe("/projects/b/x|X marks");
    expect(formatWikilinkLabel("/projects/b/x", undefined)).toBe("/projects/b/x|x");
    expect(formatWikilinkLabel("/projects/b/", undefined)).toBe("/projects/b/|b");
  });

  it("falls back to the entry's name when there is no title", () => {
    expect(formatWikilinkLabel("two", undefined)).toBe("two");
    expect(formatWikilinkLabel("two", "  ")).toBe("two");
    expect(formatWikilinkLabel("scenes/", undefined)).toBe("scenes/");
  });

  it("drops brackets from the title and collapses its whitespace", () => {
    expect(formatWikilinkLabel("two", "Act [II]\n  draft")).toBe("two|Act II draft");
  });

  it("keeps a file of no kind's extension wherever a link shows its name", () => {
    expect(wikilinkName("data/budget.csv")).toBe("budget.csv");
    expect(splitWikilinkLabel("budget.csv").display).toBe("budget.csv");
    expect(formatWikilinkLabel("/data/budget.csv", undefined)).toBe("/data/budget.csv|budget.csv");
  });
});

// What an agent is handed to copy into text read as from the space root: the
// link a document at the root writes, which reads back there as its entry.
describe("a wikilink from the space root", () => {
  const scopes = new Set(["projects/a"]);
  const cases: [string, boolean, string][] = [
    ["bob.md", false, "[[bob]]"],
    ["notes/plan.md", false, "[[notes/plan]]"],
    ["data/budget.csv", false, "[[data/budget.csv]]"],
    ["projects/a/cast/bob.md", false, "[[/projects/a/cast/bob|bob]]"],
    ["projects/a/takes.table.html", false, "[[/projects/a/takes.table.html|takes]]"],
    ["notes", true, "[[notes/]]"],
    ["lib:footage/stills/a.png", false, "[[lib:footage/stills/a.png|a]]"],
  ];

  it("is written as a root document writes it, showing the entry's name", () => {
    for (const [path, folder, written] of cases) {
      expect(wikilinkFromRoot(parseRootedPath(path), scopes, folder)).toBe(written);
    }
  });

  it("reads back from the root as the entry it was written for", () => {
    for (const [path, folder, written] of cases) {
      const [inner] = [...written.matchAll(wikilinkPattern())].map((match) => match[1]);
      const found = resolveWrittenPath("", splitWikilinkLabel(inner).target, "wikilink", indexOf);
      expect(found, written).toEqual({ path, type: folder ? "directory" : "file" });
    }
  });
});
