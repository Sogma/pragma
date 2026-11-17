import { describe, expect, it } from "vitest";
import { pragmaFileRole } from "../../src/protocol/pragmaFiles.ts";

const ANYWHERE = { atRoot: false, inSite: false };

describe("pragmaFileRole", () => {
  it("names a folder's order and properties wherever they sit, in any case", () => {
    expect(pragmaFileRole("_structure.json", ANYWHERE)).toBe("order");
    expect(pragmaFileRole("_Properties.JSON", ANYWHERE)).toBe("properties");
  });

  it("names the declared tags and libraries only at the space's root", () => {
    expect(pragmaFileRole("_tags.json", { atRoot: true, inSite: false })).toBe("tags");
    expect(pragmaFileRole("_libraries.json", { atRoot: true, inSite: false })).toBe("libraries");
    expect(pragmaFileRole("_tags.json", ANYWHERE)).toBeUndefined();
    expect(pragmaFileRole("_libraries.json", ANYWHERE)).toBeUndefined();
  });

  it("names a site's settings anywhere, and its queue only beside them", () => {
    expect(pragmaFileRole("_site.json", ANYWHERE)).toBe("site");
    expect(pragmaFileRole("_queue.json", { atRoot: false, inSite: true })).toBe("queue");
    expect(pragmaFileRole("_queue.json", ANYWHERE)).toBeUndefined();
  });

  it("leaves any other file, underscore or not, to its owner", () => {
    expect(pragmaFileRole("_notes.json", { atRoot: true, inSite: true })).toBeUndefined();
    expect(pragmaFileRole("structure.json", ANYWHERE)).toBeUndefined();
  });
});
