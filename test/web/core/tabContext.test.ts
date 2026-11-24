// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { contextOfTab } from "../../../web/core/tabContext.ts";
import { listSpace, unlistSpace } from "../support/spaceListing.ts";

describe("the context a tab is seen in", () => {
  beforeEach(() =>
    listSpace({
      files: ["projects/film/shots.table.html", "projects/film/shots/a.png", "notes/a.png"],
      folders: ["projects", "projects/film", "projects/film/shots", "notes"],
      scopes: ["projects/film"],
    }),
  );
  afterEach(() => unlistSpace());

  it("is the scope a space file or folder sits in, its own folder's included, and the space's outside every scope", () => {
    expect(contextOfTab({ kind: "table", path: "projects/film/shots.table.html" })).toBe("projects/film");
    expect(contextOfTab({ kind: "image", path: "projects/film/shots/a.png" })).toBe("projects/film");
    expect(contextOfTab({ kind: "gallery", path: "projects/film" })).toBe("projects/film");
    expect(contextOfTab({ kind: "image", path: "notes/a.png" })).toBe("");
    expect(contextOfTab({ kind: "gallery", path: "" })).toBe("");
    expect(contextOfTab({ kind: "empty" })).toBe("");
  });

  // A library is one scope, its own, as the space is at its top.
  it("is, for a library's tab, the library's top, whatever folder of it the tab shows", () => {
    expect(contextOfTab({ kind: "image", path: "lib:footage/day1/a.png" })).toBe("lib:footage");
    expect(contextOfTab({ kind: "gallery", path: "lib:footage/day1" })).toBe("lib:footage");
    expect(contextOfTab({ kind: "gallery", path: "lib:footage" })).toBe("lib:footage");
    expect(contextOfTab({ kind: "image", path: "lib:renders/a.png" })).toBe("lib:renders");
  });
});
