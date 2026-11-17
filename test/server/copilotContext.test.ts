import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONTEXT_SECTION_LIMIT, type ContextSource, createContextSources } from "../../src/server/copilotContext.ts";

const PRIVATE = "---\nvisibility: private\n---\n";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "pragma-context-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// A source whose section says which folder it was handed.
function echo(title: string): ContextSource {
  return { section: async (request) => ({ title, body: `from "${request.folder}"` }) };
}

describe("the copilot's context sources", () => {
  it("hand back each section in the order the sources were registered", async () => {
    mkdirSync(path.join(dir, "notes", "act-one"), { recursive: true });
    const sources = createContextSources();
    sources.register("first", echo("First"));
    sources.register("second", echo("Second"));

    expect(await sources.sections(dir, path.join(dir, "notes", "act-one"))).toEqual([
      { title: "First", body: 'from "notes/act-one"' },
      { title: "Second", body: 'from "notes/act-one"' },
    ]);
    expect(await sources.sections(dir, dir)).toEqual([
      { title: "First", body: 'from ""' },
      { title: "Second", body: 'from ""' },
    ]);
  });

  it("refuse a second source under one id", () => {
    const sources = createContextSources();
    sources.register("okf", echo("One"));

    expect(() => sources.register("okf", echo("Two"))).toThrow(/already registered/);
  });

  it("run no source for a turn that starts outside the space", async () => {
    const sources = createContextSources();
    sources.register("any", echo("Any"));

    expect(await sources.sections(dir, path.dirname(dir))).toEqual([]);
  });

  it("leave a failing source out of the turn and keep the others", async () => {
    const sources = createContextSources();
    sources.register("rejects", {
      section: async () => {
        throw new Error("broken");
      },
    });
    sources.register("throws", {
      section: () => {
        throw new Error("broken before its promise");
      },
    });
    sources.register("works", echo("Works"));

    expect(await sources.sections(dir, dir)).toEqual([{ title: "Works", body: 'from ""' }]);
  });

  it("cut a section past the size limit, and say so", async () => {
    const sources = createContextSources();
    sources.register("long", {
      section: async () => ({ title: "Long", body: "x".repeat(CONTEXT_SECTION_LIMIT + 10) }),
    });

    const [section] = await sources.sections(dir, dir);

    expect(section.body).toBe(`${"x".repeat(CONTEXT_SECTION_LIMIT)}\n\n[Cut short at the copilot's size limit.]`);
  });

  it("never cut between the two halves of a character", async () => {
    const sources = createContextSources();
    // The emoji's two UTF-16 units straddle the limit.
    sources.register("emoji", {
      section: async () => ({ title: "Emoji", body: `${"x".repeat(CONTEXT_SECTION_LIMIT - 1)}😀 and more` }),
    });

    const [section] = await sources.sections(dir, dir);

    expect(section.body).toBe(`${"x".repeat(CONTEXT_SECTION_LIMIT - 1)}\n\n[Cut short at the copilot's size limit.]`);
  });
});

describe("the reader a context source is handed", () => {
  // What a source reads of `name` in `folder`, for a turn in `spaceRoot`.
  async function read(spaceRoot: string, folder: string, name: string) {
    let result: { path: string; content: string } | null | undefined;
    const sources = createContextSources();
    sources.register("probe", {
      section: async (request) => {
        result = await request.readNamed(folder, name);
        return null;
      },
    });
    await sources.sections(spaceRoot, spaceRoot);
    return result;
  }

  it("finds an entry in any case, and names it as spelled", async () => {
    mkdirSync(path.join(dir, "kb"));
    writeFileSync(path.join(dir, "kb", "INDEX.MD"), "# Listing");

    expect(await read(dir, "kb", "index.md")).toEqual({ path: "kb/INDEX.MD", content: "# Listing" });
  });

  it("reads a private entry as absent", async () => {
    writeFileSync(path.join(dir, "index.md"), `${PRIVATE}# Secret listing`);

    expect(await read(dir, "", "index.md")).toBeNull();
  });

  it("reads an entry in a hidden folder as absent", async () => {
    mkdirSync(path.join(dir, ".git"));
    writeFileSync(path.join(dir, ".git", "config"), "[remote]");

    expect(await read(dir, ".git", "config")).toBeNull();
  });

  it("reads a link as absent", async () => {
    writeFileSync(path.join(dir, "real.md"), "# Real");
    symlinkSync(path.join(dir, "real.md"), path.join(dir, "index.md"));

    expect(await read(dir, "", "index.md")).toBeNull();
  });

  it("reads nothing outside the space", async () => {
    const space = path.join(dir, "space");
    mkdirSync(space);
    writeFileSync(path.join(dir, "index.md"), "# Outside");

    expect(await read(space, "..", "index.md")).toBeNull();
  });
});
