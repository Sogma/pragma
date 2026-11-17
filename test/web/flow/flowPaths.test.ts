import { describe, expect, it, vi } from "vitest";
import type { RootedPath } from "../../../src/protocol/rootedPath.ts";
import type { WritePathOptions } from "../../../web/core/spaceTree.ts";
import { flowPickPath, flowStoredPath, flowTreePath } from "../../../web/flow/flowPaths.ts";

// The folders the space's scopes open over, as the tree's listing has them.
const listing = vi.hoisted(() => ({ scopes: new Set<string>() }));
vi.mock("../../../web/core/spaceTree.ts", async () => {
  const { formatWrittenPath } = await import("../../../src/protocol/relativeReference.ts");
  return {
    writePathFrom: (docDir: string, target: RootedPath, options: WritePathOptions = {}) =>
      formatWrittenPath(docDir, target, {
        form: options.form ?? "markdown",
        folder: options.folder,
        scopes: options.scopes ?? listing.scopes,
      }),
  };
});

// A Flow reads every path from its own folder, so a drop is written from
// there, as a link in a note beside it would be.
describe("a Flow's stored paths", () => {
  const flow = "film/flows/shots.flow.html";

  it("writes a drop relative within the Flow's scope, from the root outside it", () => {
    expect(flowStoredPath(flow, { root: "space", path: "film/flows/log.table.html" })).toBe("log.table.html");
    expect(flowStoredPath(flow, { root: "space", path: "film/my art" }, true)).toBe("../my%20art/");
    // A library's file is named by its address, encoded as any path is.
    expect(flowStoredPath(flow, { root: { library: "footage" }, path: "a b.png" })).toBe("lib:footage/a%20b.png");
    try {
      listing.scopes = new Set(["film"]);
      expect(flowStoredPath(flow, { root: "space", path: "tags.table.html" })).toBe("/tags.table.html");
    } finally {
      listing.scopes = new Set();
    }
  });

  it("reads a stored path back as the tree spells it, whatever its form", () => {
    for (const stored of [
      "log.table.html",
      "./log.table.html",
      "/film/flows/log.table.html",
      "space:film/flows/log.table.html",
    ]) {
      expect(flowTreePath(flow, stored), stored).toBe("film/flows/log.table.html");
    }
    expect(flowTreePath(flow, "../my%20art/")).toBe("film/my art");
    expect(flowTreePath(flow, "lib:footage/a%20b.png")).toBe("lib:footage/a b.png");
    expect(flowTreePath(flow, "lib:footage/a b.png")).toBe("lib:footage/a b.png");
    expect(flowTreePath(flow, "../../../x.md")).toBe("../../../x.md");
  });

  it("keeps a folder pick as stored while it names the same file", () => {
    expect(flowPickPath(flow, "film/refs/a.md", "space:film/refs/a.md")).toBe("space:film/refs/a.md");
    expect(flowPickPath(flow, "film/refs/b.md", "space:film/refs/a.md")).toBe("../refs/b.md");
    expect(flowPickPath(flow, "film/refs/b.md", "")).toBe("../refs/b.md");
  });
});
