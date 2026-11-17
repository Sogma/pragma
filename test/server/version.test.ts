import { describe, expect, it } from "vitest";
import { githubRepository, pragmaRepository } from "../../src/server/version.ts";

describe("githubRepository", () => {
  it("reads npm's shorthands and github.com URLs", () => {
    expect(githubRepository("github:sogma/pragma")).toBe("sogma/pragma");
    expect(githubRepository("sogma/pragma")).toBe("sogma/pragma");
    expect(githubRepository("https://github.com/sogma/pragma")).toBe("sogma/pragma");
    expect(githubRepository({ type: "git", url: "git+https://github.com/sogma/pragma.git" })).toBe("sogma/pragma");
  });

  it("names no repo for another host or a missing field", () => {
    expect(githubRepository("gitlab:sogma/pragma")).toBeUndefined();
    expect(githubRepository("https://gitlab.com/sogma/pragma")).toBeUndefined();
    expect(githubRepository(undefined)).toBeUndefined();
  });

  it("finds one in pragma's own package.json, the repo electron-builder publishes to", () => {
    expect(pragmaRepository).toMatch(/^[\w.-]+\/[\w.-]+$/);
  });
});
