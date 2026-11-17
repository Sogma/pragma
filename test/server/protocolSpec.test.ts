import { describe, expect, it } from "vitest";
import { loadProtocolSpec, noSuchSection, parseProtocolSpec, sectionAnchors } from "../../src/server/protocolSpec.ts";

// How a section is named and where it ends, across both docs, then the
// shipped spec itself: the anchors the tool cites have to resolve in the real
// docs, or the tool points models at nothing.

const PROTOCOL = [
  "# Protocol",
  "",
  "Intro.",
  "",
  "## Tables",
  "",
  "Rows.",
  "",
  "### Storage",
  "",
  "Table storage.",
  "",
  "## Flows",
  "",
  "```md",
  "## Not a heading",
  "```",
  "",
  "### Storage",
  "",
  "Flow storage.",
  "",
  "### Node types",
  "",
  "Nodes.",
  "",
].join("\n");

const FLOW_NODES = ["# Flow nodes", "", "## Text", "", "### `joinText`", "", "Joins.", ""].join("\n");

describe("parseProtocolSpec", () => {
  const spec = parseProtocolSpec(PROTOCOL, FLOW_NODES);

  it("lists each part with its sections, and the catalog's categories, skipping titles and anything fenced", () => {
    expect(spec.parts).toEqual([
      { anchor: "tables", sections: ["storage"] },
      { anchor: "flows", sections: ["storage-1", "node-types"] },
    ]);
    expect(sectionAnchors(spec)).toEqual(["tables", "storage", "flows", "storage-1", "node-types"]);
    expect(spec.nodeCategories).toEqual(["text"]);
  });

  it("offers each part with its sections when a name matches nothing", () => {
    expect(noSuchSection(spec, "nope")).toContain("Sections: tables (storage); flows (storage-1, node-types).");
  });

  it("reads a section with its subsections, up to the next section", () => {
    expect(spec.read("tables")).toBe("## Tables\n\nRows.\n\n### Storage\n\nTable storage.");
  });

  it("reads a subsection alone, by its anchor, title or link", () => {
    for (const name of ["node-types", "Node types", "#node-types", "protocol.md#node-types"]) {
      expect(spec.read(name)).toBe("### Node types\n\nNodes.");
    }
  });

  it("reads a node type from the catalog by its type id", () => {
    for (const name of ["joinText", "jointext", "flow-nodes.md#jointext"]) {
      expect(spec.read(name)).toBe("### `joinText`\n\nJoins.");
    }
  });

  it("tells a repeated title apart by GitHub's suffix", () => {
    expect(spec.read("storage")).toBe("### Storage\n\nTable storage.");
    expect(spec.read("storage-1")).toBe("### Storage\n\nFlow storage.");
  });

  it("names nothing it doesn't have", () => {
    for (const name of ["protocol", "flow-nodes", "not-a-heading", "nope"]) expect(spec.read(name)).toBeUndefined();
  });
});

describe("the shipped spec", () => {
  it("resolves every anchor the tool cites", async () => {
    const spec = await loadProtocolSpec();
    const listed = spec?.parts.flatMap((part) => part.sections);
    expect(listed).toEqual(expect.arrayContaining(["flows", "tables", "applets"]));
    expect(spec?.nodeCategories).toEqual(expect.arrayContaining(["text"]));
    expect(spec?.read("applet-nodes")).toMatch(/^#+ Applet nodes/);
    expect(spec?.read("generateImage")).toMatch(/^### `generateImage`/);
    expect(spec?.read("templateVariables")).toMatch(/^### `templateVariables`/);
  });
});
