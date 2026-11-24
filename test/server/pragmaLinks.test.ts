import { describe, expect, it } from "vitest";
import type { PragmaGlobalConfig } from "../../src/config/loadConfig.ts";
import { routePragmaLink } from "../../src/server/pragmaLinks.ts";

const config: PragmaGlobalConfig = {
  spaces: {
    spc_notes: { path: "/home/you/Notes" },
    spc_work: { path: "/home/you/work-2026", label: "Work" },
    spc_cafe: { path: "/home/you/Café" },
    spc_twin_a: { path: "/home/you/a/Drafts" },
    spc_twin_b: { path: "/home/you/b/Drafts" },
    spc_labelled: { path: "/home/you/projects", label: "Studio" },
    spc_studio_folder: { path: "/home/you/Studio-old" },
  },
};

describe("routing a Pragma link to a space", () => {
  it("finds the space by its display name, ignoring case, and carries the entry", () => {
    expect(routePragmaLink(config, "pragma://notes/projects/a.md")).toEqual({
      spaceId: "spc_notes",
      spacePath: "/home/you/Notes",
      link: { space: "notes", path: "projects/a.md", folder: false },
    });
    expect(routePragmaLink(config, "pragma://work/Plans/")).toMatchObject({
      spaceId: "spc_work",
      link: { path: "Plans", folder: true },
    });
  });

  // A label is what the copy writes, but a link to the folder's own name
  // still opens it.
  it("falls back to the folder's name, and folds names as entry names fold", () => {
    expect(routePragmaLink(config, "pragma://work-2026/a.md")).toMatchObject({ spaceId: "spc_work" });
    // "é" as one code point, and as "e" plus a combining accent.
    expect(routePragmaLink(config, "pragma://Caf%C3%A9/a.md")).toMatchObject({ spaceId: "spc_cafe" });
    expect(routePragmaLink(config, "pragma://CAFE%CC%81/a.md")).toMatchObject({ spaceId: "spc_cafe" });
  });

  it("finds the space by its id, for a link a script writes", () => {
    expect(routePragmaLink(config, "pragma://spc_twin_b/a.md")).toMatchObject({
      spaceId: "spc_twin_b",
      spacePath: "/home/you/b/Drafts",
    });
  });

  // One space's label outranks another's folder name, which would otherwise
  // make the name ambiguous.
  it("prefers a display name to another space's folder name", () => {
    expect(routePragmaLink(config, "pragma://studio/a.md")).toMatchObject({ spaceId: "spc_labelled" });
  });

  it("refuses a name two spaces share, naming both folders", () => {
    expect(routePragmaLink(config, "pragma://drafts/a.md")).toEqual({
      refusal: 'More than one space on this computer is named "drafts": /home/you/a/Drafts, /home/you/b/Drafts',
    });
  });

  it("refuses a name no space has, and passes a malformed link's refusal on", () => {
    expect(routePragmaLink(config, "pragma://Elsewhere/a.md")).toEqual({
      refusal: 'No space named "Elsewhere" on this computer',
    });
    expect(routePragmaLink({}, "pragma://Notes/a.md")).toEqual({ refusal: 'No space named "Notes" on this computer' });
    expect(routePragmaLink(config, "pragma://Notes/../a.md")).toHaveProperty("refusal");
    expect(routePragmaLink(config, "https://Notes/a.md")).toEqual({
      refusal: 'Not a Pragma link: "https://Notes/a.md"',
    });
  });
});
