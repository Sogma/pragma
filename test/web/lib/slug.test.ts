import { describe, expect, it } from "vitest";
import { uniqueSlug } from "../../../web/lib/slug.ts";

describe("uniqueSlug", () => {
  it("keeps a name's lowercase letters and digits, each other run one dash", () => {
    expect(uniqueSlug("  My Server! v2 ", new Set(), "server")).toBe("my-server-v2");
    expect(uniqueSlug("Café Noir", new Set(), "column")).toBe("caf-noir");
  });

  it("falls back for a name with nothing to keep", () => {
    expect(uniqueSlug("!!!", new Set(), "provider")).toBe("provider");
  });

  it("counts on from -2 past the ids already taken", () => {
    expect(uniqueSlug("Notes", new Set(["notes", "notes-2"]), "column")).toBe("notes-3");
    expect(uniqueSlug("", new Set(["server"]), "server")).toBe("server-2");
  });
});
