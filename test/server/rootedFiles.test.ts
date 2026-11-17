import {
  mkdirSync,
  mkdtempSync,
  type PathLike,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LibraryEntry } from "../../src/protocol/api.ts";
import { resolveToolkits } from "../../src/server/resolveToolkits.ts";
import {
  namedEntryPath,
  newFolderIn,
  newSpaceFolderIn,
  PathAccessError,
  resolveHeldPath,
  resolveRootedPath,
} from "../../src/server/rootedFiles.ts";
import { readSpaceRulesFile } from "../../src/server/spaceFiles.ts";
import { changeSpaceTag, readSpaceTags } from "../../src/server/spaceTags.ts";
import { readStructure, writeStructure } from "../../src/server/structure.ts";
import { buildTree } from "../../src/server/tree.ts";
import { giveSpaceLibraries } from "../support/libraries.ts";

let space: string;
let library: string;
let configDir: string;

// A library's folder sits in the config, so these tests point
// PRAGMA_CONFIG_DIR at a throwaway directory rather than reading the
// developer's own.
function register(...libraries: LibraryEntry[]): void {
  giveSpaceLibraries(configDir, space, libraries);
}

beforeEach(() => {
  space = mkdtempSync(path.join(tmpdir(), "pragma-rooted-space-"));
  library = mkdtempSync(path.join(tmpdir(), "pragma-rooted-library-"));
  configDir = mkdtempSync(path.join(tmpdir(), "pragma-rooted-config-"));
  process.env.PRAGMA_CONFIG_DIR = configDir;
  register({ id: "footage", label: "Footage", path: library, access: "read-only" });
});

afterEach(() => {
  delete process.env.PRAGMA_CONFIG_DIR;
  rmSync(space, { recursive: true, force: true });
  rmSync(library, { recursive: true, force: true });
  rmSync(configDir, { recursive: true, force: true });
});

// The error code a read raises, or undefined when it resolves.
function readCode(run: () => unknown): string | undefined {
  try {
    run();
    return undefined;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code;
  }
}

function status(run: () => unknown): number | undefined {
  try {
    run();
  } catch (error) {
    return error instanceof PathAccessError ? error.status : undefined;
  }
  return undefined;
}

describe("resolving a rooted path", () => {
  it("resolves a bare path inside the space, for either access", () => {
    for (const access of ["read", "write"] as const) {
      expect(resolveRootedPath(space, "notes/a.md", access).filePath).toBe(path.join(space, "notes/a.md"));
    }
  });

  it("resolves a lib: path inside that library's own root", () => {
    const resolved = resolveRootedPath(space, "lib:footage/b-roll/sunset.jpg", "read");
    expect(resolved.filePath).toBe(path.join(library, "b-roll/sunset.jpg"));
    expect(resolved.rooted).toEqual({ root: { library: "footage" }, path: "b-roll/sunset.jpg" });
  });

  // The invariant the whole read-only phase rests on. It is not enforced by
  // the absence of a write route — it's enforced here, so a write route that
  // gets one later is refused by default rather than by omission.
  it("refuses a write to a read-only library", () => {
    expect(status(() => resolveRootedPath(space, "lib:footage/x.png", "write"))).toBe(403);
    expect(() => resolveRootedPath(space, "lib:footage/x.png", "read")).not.toThrow();
  });

  it("refuses a write to a library whose permission is missing or unreadable", () => {
    // Deny by default: anything that isn't explicitly read-write is refused,
    // including a registry file hand-edited into a shape the type forbids.
    register({ id: "footage", name: "Footage", path: library } as unknown as LibraryEntry);
    expect(status(() => resolveRootedPath(space, "lib:footage/x.png", "write"))).toBe(403);

    register({ id: "footage", label: "Footage", path: library, access: "rw" } as unknown as LibraryEntry);
    expect(status(() => resolveRootedPath(space, "lib:footage/x.png", "write"))).toBe(403);
  });

  it("allows a write once a library says read-write", () => {
    register({ id: "footage", label: "Footage", path: library, access: "read-write" });
    expect(resolveRootedPath(space, "lib:footage/x.png", "write").filePath).toBe(path.join(library, "x.png"));
  });

  // No path names a hidden entry; the doorway is where that holds for every
  // root at once, so a root's `.git`, another app's settings folder and a
  // `.trash` are out of reach of a hand-made request. A read finds nothing
  // there, as every surface shows it, and a write is refused.
  it("refuses a write under a hidden segment in either root, and reads it as missing", () => {
    register({ id: "footage", label: "Footage", path: library, access: "read-write" });
    for (const input of [
      ".settings/workspace.json",
      ".git/config",
      "notes/.drafts/a.md",
      "..drafts/a.md",
      "lib:footage/.git/config",
      "lib:footage/.trash/x.png",
      "lib:footage/b-roll/.hidden.png",
    ]) {
      expect(
        status(() => resolveRootedPath(space, input, "write")),
        input,
      ).toBe(403);
      expect(
        readCode(() => resolveRootedPath(space, input, "read")),
        input,
      ).toBe("ENOENT");
    }
    // The root itself has no segment to hide.
    expect(() => resolveRootedPath(space, "", "write")).not.toThrow();
    expect(() => resolveRootedPath(space, "lib:footage", "write")).not.toThrow();
  });

  it("refuses a backslash path for either access, before it reaches the disk", () => {
    for (const access of ["read", "write"] as const) {
      expect(status(() => resolveRootedPath(space, "notes\\..\\.git\\config", access))).toBe(400);
      expect(status(() => resolveHeldPath(space, "notes\\..\\.git\\config", access))).toBe(400);
    }
  });

  // On Windows a short name such as `GIT~1` opens `.git`. This suite runs
  // where no disk does that, so the disk's answer is stood in for.
  it("refuses a write, and finds nothing for a read, that reaches a hidden entry by another name", () => {
    mkdirSync(path.join(space, ".git"));
    const realpath = realpathSync.native;
    const alias = `${path.sep}GIT~1`;
    const disk = vi
      .spyOn(realpathSync, "native")
      .mockImplementation(((target: PathLike) =>
        realpath(String(target).replace(alias, `${path.sep}.git`))) as typeof realpathSync.native);
    try {
      expect(status(() => resolveRootedPath(space, "GIT~1/config", "write"))).toBe(403);
      expect(status(() => resolveHeldPath(space, "GIT~1/hooks/pre-commit", "write"))).toBe(403);
      expect(readCode(() => resolveRootedPath(space, "GIT~1/config", "read"))).toBe("ENOENT");
      // A name that only looks like a short name is an ordinary one.
      expect(() => resolveRootedPath(space, "draft~2/a.md", "write")).not.toThrow();
    } finally {
      disk.mockRestore();
    }
  });

  it("refuses a library this space hasn't registered", () => {
    expect(status(() => resolveRootedPath(space, "lib:nope/x.png", "read"))).toBe(404);
  });

  it("refuses an unparseable path before consulting any root", () => {
    expect(status(() => resolveRootedPath(space, "lib:footage/../../escape.md", "read"))).toBe(400);
    expect(status(() => resolveRootedPath(space, "ftp:x/y.png", "read"))).toBe(400);
  });

  it("resolves space: from the space root, for either access", () => {
    for (const access of ["read", "write"] as const) {
      expect(resolveRootedPath(space, "space:a.md", access).filePath).toBe(path.join(space, "a.md"));
      expect(resolveRootedPath(space, "space:notes/a.md", access).filePath).toBe(path.join(space, "notes/a.md"));
    }
  });

  // Belt and braces: parse rejects `..` segments, and the containment check
  // would catch anything that got past it. Neither is trusted alone.
  it("never returns a path outside the root it named", () => {
    for (const input of ["../outside.md", "lib:footage/../outside.png"]) {
      expect(() => resolveRootedPath(space, input, "read")).toThrow();
    }
  });

  // The containment check tests the `..` prefix exactly, so an entry that
  // merely starts with those two characters is a name, not an escape; a
  // hidden one, like any name with a leading dot, so a read finds nothing.
  it("reads an entry whose name begins with .. as a hidden name, not an escape", () => {
    expect(readCode(() => resolveRootedPath(space, "..drafts/a.md", "read"))).toBe("ENOENT");
    expect(readCode(() => resolveRootedPath(space, "lib:footage/..raw/x.png", "read"))).toBe("ENOENT");
  });
});

// A scheme a reader doesn't define is refused by name, never read as a
// space folder that happens to be called `foo:`.
// A host's own path folds only on a read that misses: a write lands on the
// path as spelled, or renaming `a.md` to `A.md` would land on itself. A path
// a document holds names its entry whatever case it spells it in, as a link.
describe("a path spelled in another case", () => {
  beforeEach(() => {
    mkdirSync(path.join(space, "Notes"));
    writeFileSync(path.join(space, "Notes/Plan.md"), "# Plan");
  });

  it("reads the entry it names, as it is spelled on disk", () => {
    const resolved = resolveRootedPath(space, "notes/PLAN.md", "read");
    expect(resolved.filePath).toBe(path.join(space, "Notes/Plan.md"));
    expect(resolved.rooted).toEqual({ root: "space", path: "Notes/Plan.md" });
  });

  it("leaves a write on the path as spelled", () => {
    expect(resolveRootedPath(space, "notes/PLAN.md", "write").filePath).toBe(path.join(space, "notes/PLAN.md"));
  });

  it("reads nothing when two entries fold alike and neither is spelled exactly", () => {
    writeFileSync(path.join(space, "Notes/PLAN.md"), "# Twin");
    expect(resolveRootedPath(space, "notes/plan.md", "read").filePath).toBe(path.join(space, "notes/plan.md"));
  });

  it("reads and writes the entry a held path names, whatever its case", () => {
    expect(resolveHeldPath(space, "notes/PLAN.md", "read").filePath).toBe(path.join(space, "Notes/Plan.md"));
    expect(resolveHeldPath(space, "notes/PLAN.md", "write").filePath).toBe(path.join(space, "Notes/Plan.md"));
    // A new entry lands in the folder its parent names.
    expect(resolveHeldPath(space, "notes/new.md", "write").filePath).toBe(path.join(space, "Notes/new.md"));
  });

  it("names nothing by a held path two entries match, the exact spelling included", () => {
    writeFileSync(path.join(space, "Notes/PLAN.md"), "# Twin");
    expect(status(() => resolveHeldPath(space, "Notes/Plan.md", "read"))).toBe(404);
    expect(status(() => resolveHeldPath(space, "notes/plan.md", "write"))).toBe(404);
    // A host's own path is read as spelled, so either opens from the tree.
    expect(resolveRootedPath(space, "Notes/PLAN.md", "read").filePath).toBe(path.join(space, "Notes/PLAN.md"));
  });
});

describe("a new folder made from a name", () => {
  it("is the name, trimmed, directly inside its parent", () => {
    expect(newFolderIn(space, " Screenplays ")).toEqual({ folder: path.join(space, "Screenplays") });
  });

  it("is refused for a name that would land elsewhere or break on another OS", () => {
    for (const name of ["..", ".", "a/b", "a/../../x", "a\\b", "", "   ", ".hidden", "a:b"]) {
      expect(newFolderIn(space, name)).toHaveProperty("refused");
    }
  });
});

// A new space never moves into a folder that exists, empty or not, so the
// template can't land among someone's own files.
describe("a new space's folder", () => {
  it("is a new folder named as the space", () => {
    expect(newSpaceFolderIn(space, " Notes ")).toEqual({ folder: path.join(space, "Notes") });
  });

  it("is refused where a folder or a file already has the name, in any case", () => {
    mkdirSync(path.join(space, "notes"));
    writeFileSync(path.join(space, "Draft.md"), "");
    const parent = path.basename(space);

    expect(newSpaceFolderIn(space, "Notes")).toEqual({
      refused: `There’s already a folder named “notes” in ${parent}. Choose another name, or open it with Open folder as space.`,
    });
    expect(newSpaceFolderIn(space, "draft.md")).toEqual({
      refused: `There’s already a file named “Draft.md” in ${parent}. Choose another name.`,
    });
  });

  it("keeps the folder name rule", () => {
    expect(newSpaceFolderIn(space, "a:b")).toHaveProperty("refused");
  });
});

describe("a name the protocol defines, spelled in another case", () => {
  it("is read as the disk spells it, and written back under that spelling", () => {
    writeFileSync(path.join(space, "_Structure.json"), JSON.stringify({ order: [{ name: "b.md" }, { name: "a.md" }] }));

    expect(namedEntryPath(space, "_structure.json")).toBe(path.join(space, "_Structure.json"));
    expect(readStructure(space)).toEqual(["b.md", "a.md"]);
    writeStructure(space, ["a.md", "b.md"]);
    expect(readdirSync(space).filter((name) => /^_structure\.json$/i.test(name))).toEqual(["_Structure.json"]);
    expect(readStructure(space)).toEqual(["a.md", "b.md"]);
  });

  it("is the exact spelling when two fold alike, and the name itself when none is there", () => {
    writeFileSync(path.join(space, "_tags.json"), "{}");
    writeFileSync(path.join(space, "_TAGS.json"), "{}");

    expect(namedEntryPath(space, "_tags.json")).toBe(path.join(space, "_tags.json"));
    expect(namedEntryPath(space, "_properties.json")).toBe(path.join(space, "_properties.json"));
  });
});

describe("an unrecognized scheme", () => {
  it("is refused by the resolver, rather than treated as a filename", () => {
    expect(status(() => resolveRootedPath(space, "foo:bar", "read"))).toBe(400);
  });
});

// docs/protocol.md's Symbolic links rule. A link arrives with a cloned,
// synced or unpacked space; nothing in pragma makes one.
describe("symbolic links below a root", () => {
  let outside: string;

  beforeEach(() => {
    outside = mkdtempSync(path.join(tmpdir(), "pragma-rooted-outside-"));
    writeFileSync(path.join(outside, "secret.md"), "SECRET");
  });

  afterEach(() => {
    rmSync(outside, { recursive: true, force: true });
  });

  it("refuses a path that is, or passes through, a link — for either access, wherever it points", () => {
    mkdirSync(path.join(space, "notes"));
    writeFileSync(path.join(space, "notes", "real.md"), "real");
    symlinkSync(path.join(outside, "secret.md"), path.join(space, "out.md"));
    symlinkSync(outside, path.join(space, "outdir"));
    symlinkSync(path.join(space, "notes", "real.md"), path.join(space, "alias.md"));
    // Dangling: a write through it would create the file wherever it points.
    symlinkSync(path.join(outside, "new.md"), path.join(space, "dangling.md"));

    for (const input of ["out.md", "outdir/secret.md", "outdir/new.md", "alias.md", "dangling.md"]) {
      for (const access of ["read", "write"] as const) {
        expect(
          status(() => resolveRootedPath(space, input, access)),
          `${input} (${access})`,
        ).toBe(403);
      }
    }
  });

  it("refuses a link inside a library the same way", () => {
    register({ id: "footage", label: "Footage", path: library, access: "read-write" });
    symlinkSync(outside, path.join(library, "elsewhere"));
    expect(status(() => resolveRootedPath(space, "lib:footage/elsewhere/secret.md", "read"))).toBe(403);
  });

  it("leaves the path to the root alone, so a root reached through a link resolves", () => {
    const linkedSpace = path.join(outside, "linked-space");
    symlinkSync(space, linkedSpace);
    expect(resolveRootedPath(linkedSpace, "notes/new.md", "write").filePath).toBe(
      path.join(linkedSpace, "notes/new.md"),
    );
  });

  it("lists no link in the tree", async () => {
    writeFileSync(path.join(space, "real.md"), "real");
    symlinkSync(path.join(outside, "secret.md"), path.join(space, "out.md"));
    symlinkSync(outside, path.join(space, "outdir"));
    expect((await buildTree(space, space)).map((node) => node.name)).toEqual(["real.md"]);
  });

  it("reads a linked file pragma names itself as absent, and refuses to write through it", async () => {
    writeFileSync(path.join(outside, "order.json"), JSON.stringify({ order: [{ id: "x", name: "x.md" }] }));
    symlinkSync(path.join(outside, "order.json"), path.join(space, "_structure.json"));
    symlinkSync(path.join(outside, "secret.md"), path.join(space, "AGENTS.md"));

    expect(readStructure(space)).toBeNull();
    expect(status(() => writeStructure(space, ["a.md"]))).toBe(403);
    expect(readFileSync(path.join(outside, "order.json"), "utf8")).toContain('"x.md"');
    expect(await readSpaceRulesFile(space)).toBeNull();
  });

  it("offers no toolkit a Class links whose path leaves the space, by `..` or through a link", () => {
    writeFileSync(path.join(outside, "evil.flow.html"), "<html></html>");
    symlinkSync(outside, path.join(space, "tools"));
    const climb = path.relative(space, path.join(outside, "evil.flow.html"));
    expect(resolveToolkits(space, [{ classPath: "a.class.html", links: [climb, "tools/evil.flow.html"] }])).toEqual([]);
  });

  it("reads a Class's Flow link from the Class's folder, whatever its case", () => {
    mkdirSync(path.join(space, "Tools"));
    mkdirSync(path.join(space, "lists"));
    writeFileSync(path.join(space, "Tools/Lyrics.flow.html"), "<html></html>");
    const toolkits = (link: string) => resolveToolkits(space, [{ classPath: "lists/a.class.html", links: [link] }]);
    const lyrics = [{ classPath: "lists/a.class.html", path: "Tools/Lyrics.flow.html" }];
    expect(toolkits("/tools/lyrics.flow.html")).toEqual(lyrics);
    expect(toolkits("../tools/LYRICS.flow.html")).toEqual(lyrics);
  });

  it("reads a linked _tags.json as no tags, and refuses to write through it", async () => {
    writeFileSync(path.join(outside, "tags.json"), JSON.stringify({ tags: [{ name: "secret" }] }));
    symlinkSync(path.join(outside, "tags.json"), path.join(space, "_tags.json"));

    expect(readSpaceTags(space)).toEqual({ tags: [] });
    await expect(changeSpaceTag(space, { name: "art" })).rejects.toMatchObject({ status: 403 });
    expect(readFileSync(path.join(outside, "tags.json"), "utf8")).toBe(JSON.stringify({ tags: [{ name: "secret" }] }));
  });
});
