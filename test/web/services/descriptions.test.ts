import { describe, expect, it, vi } from "vitest";
import { createDescriptions } from "../../../web/services/descriptions.ts";
import type { DocumentModel, DocumentsService } from "../../../web/services/documents.ts";

// docs/protocol.md's Descriptions, as the Links tab reaches it.
function setup(
  open: Record<string, Record<string, unknown> | undefined> = {},
  openScreenplays: Record<string, string> = {},
) {
  const documents = {
    get: (path: string) => {
      if (path in open) return { properties: () => open[path] } as unknown as DocumentModel;
      if (path in openScreenplays) return { body: () => openScreenplays[path] } as unknown as DocumentModel;
      return undefined;
    },
  } as unknown as DocumentsService;
  const fetchDescription = vi.fn(async (path: string) => (path.endsWith(".png") ? undefined : "From disk."));
  return { descriptions: createDescriptions({ documents, fetchDescription }), fetchDescription };
}

describe("descriptions", () => {
  it("reads an open note's from its model, unsaved edits and all", async () => {
    const { descriptions, fetchDescription } = setup({ "world/Lina.md": { description: "Unsaved." } });
    expect(await descriptions.read("world/Lina.md")).toBe("Unsaved.");
    expect(fetchDescription).not.toHaveBeenCalled();
  });

  it("reads an open screenplay's first synopsis line from its model", async () => {
    const { descriptions, fetchDescription } = setup({}, { "scenes/one.fountain": "= Unsaved.\n\nEXT. SNOW - DAY\n" });
    expect(await descriptions.read("scenes/one.fountain")).toBe("Unsaved.");
    expect(fetchDescription).not.toHaveBeenCalled();
  });

  it("asks the disk for an open note with no frontmatter, a closed document, or any other kind", async () => {
    const { descriptions, fetchDescription } = setup({ "world/Bare.md": undefined });
    expect(await descriptions.read("world/Bare.md")).toBe("From disk.");
    expect(await descriptions.read("scenes/two.fountain")).toBe("From disk.");
    expect(await descriptions.read("tools/polish.flow.html")).toBe("From disk.");
    expect(await descriptions.read("boards/sky.png")).toBeUndefined();
    expect(fetchDescription.mock.calls.map(([path]) => path)).toEqual([
      "world/Bare.md",
      "scenes/two.fountain",
      "tools/polish.flow.html",
      "boards/sky.png",
    ]);
  });
});
