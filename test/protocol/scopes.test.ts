import { describe, expect, it, vi } from "vitest";
import { isAgentsFile, opensScope, sameScope, scopeOf } from "../../src/protocol/scopes.ts";

describe("opensScope", () => {
  it("opens one for an AGENTS.md holding a pragma key, whatever the key holds", () => {
    expect(opensScope("projects/film/AGENTS.md", () => ({ pragma: null }))).toBe(true);
    expect(opensScope("projects/film/AGENTS.md", () => ({ pragma: { lookup: ["world/"] } }))).toBe(true);
    expect(opensScope("AGENTS.md", () => ({ pragma: null }))).toBe(true);
  });

  it("reads an AGENTS.md's name in any case", () => {
    expect(opensScope("projects/film/agents.md", () => ({ pragma: null }))).toBe(true);
    expect(opensScope("projects/film/Agents.MD", () => ({ pragma: null }))).toBe(true);
    expect(isAgentsFile("projects/film/aGENTS.md")).toBe(true);
  });

  it("opens none for an AGENTS.md without the key", () => {
    expect(opensScope("projects/film/AGENTS.md", () => ({ description: "Rules" }))).toBe(false);
  });

  it("reads no other document's frontmatter, so the key opens nothing there, a README's included", () => {
    const frontmatter = vi.fn(() => ({ pragma: null }));
    for (const path of ["projects/film/README.md", "projects/film/notes.md", "projects/film/NOT-AGENTS.md"]) {
      expect(opensScope(path, frontmatter), path).toBe(false);
    }
    expect(frontmatter).not.toHaveBeenCalled();
  });
});

describe("scopeOf", () => {
  const scopes = new Set(["projects/film", "projects/film/episodes/one"]);

  it("is the deepest scope at or above an entry", () => {
    expect(scopeOf(scopes, "projects/film/scenes/a.md")).toBe("projects/film");
    expect(scopeOf(scopes, "projects/film/episodes/one/x.md")).toBe("projects/film/episodes/one");
  });

  // So linking a scope's folder from outside it crosses into the scope.
  it("counts a scope's own folder as inside it", () => {
    expect(scopeOf(scopes, "projects/film")).toBe("projects/film");
    expect(scopeOf(scopes, "projects/film/README.md")).toBe("projects/film");
  });

  it("is the root scope outside any other", () => {
    expect(scopeOf(scopes, "projects/notes.md")).toBe("");
    expect(scopeOf(scopes, "projects/filmstrip/a.md")).toBe("");
    expect(scopeOf(new Set(), "a/b.md")).toBe("");
  });
});

describe("sameScope", () => {
  const scopes = new Set(["projects/film"]);
  const space = (path: string) => ({ root: "space" as const, path });
  const lib = (path: string) => ({ root: { library: "footage" }, path });

  it("holds for two entries in one scope, and not across its edge", () => {
    expect(sameScope(scopes, space("projects/film/a.md"), space("projects/film/scenes/b.md"))).toBe(true);
    expect(sameScope(scopes, space("projects/notes.md"), space("notes/c.md"))).toBe(true);
    expect(sameScope(scopes, space("projects/film/a.md"), space("projects/notes.md"))).toBe(false);
  });

  it("takes a library as one scope, and two roots as none", () => {
    expect(sameScope(scopes, lib("projects/film/a.png"), lib("b.png"))).toBe(true);
    expect(sameScope(scopes, space("a.md"), lib("a.png"))).toBe(false);
  });
});
