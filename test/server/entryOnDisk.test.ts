import { describe, expect, it } from "vitest";
import { aliasedOnWindows } from "../../src/server/entryOnDisk.ts";

describe("aliasedOnWindows", () => {
  it("refuses, on Windows, a path that reaches its entry through a separator, a drive or a stream", () => {
    for (const spacePath of ["notes\\..\\outside.md", "secret.md::$DATA", "C:outside.md"]) {
      expect(aliasedOnWindows(spacePath, "win32")).toBe(true);
    }
    expect(aliasedOnWindows("notes/plan.md", "win32")).toBe(false);
  });

  it("leaves both characters alone where they are ordinary in a name", () => {
    expect(aliasedOnWindows("notes\\plan.md", "linux")).toBe(false);
    expect(aliasedOnWindows("time: 10.md", "darwin")).toBe(false);
  });
});
