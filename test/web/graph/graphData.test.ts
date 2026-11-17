import { describe, expect, it } from "vitest";
import type { SpaceGraphResponse } from "../../../src/protocol/api.ts";
import { EDGE_GROUPS, localGraph, type ShowOptions } from "../../../web/graph/graphData.ts";

const GRAPH: SpaceGraphResponse = {
  scopes: [
    { id: "", name: "space", parent: null },
    { id: "film", name: "film", parent: "" },
  ],
  nodes: [
    { id: "film/AGENTS.md", kind: "note", label: "Film", scope: "film", opensScope: true },
    { id: "film/scene.md", kind: "note", label: "scene", scope: "film" },
    { id: "?film/gone", kind: "missing", label: "gone", scope: "film" },
    { id: "lonely.md", kind: "note", label: "lonely", scope: "" },
    { id: "_templates/t.md", kind: "note", label: "t", scope: "", template: true },
    { id: "film/", kind: "folder", label: "film/", scope: "film" },
    { id: "#draft", kind: "tag", label: "#draft", scope: null },
    { id: "film/other.md", kind: "note", label: "other", scope: "film" },
    { id: "notes/far.md", kind: "note", label: "far", scope: "" },
  ],
  edges: [
    { from: 1, to: 2, kind: "link" },
    { from: 1, to: 6, kind: "tag" },
    { from: 5, to: 1, kind: "contains" },
    { from: 5, to: 7, kind: "contains" },
    { from: 7, to: 1, kind: "link" },
    { from: 7, to: 8, kind: "link" },
  ],
};

const SHOW: ShowOptions = {
  edges: EDGE_GROUPS.filter((group) => group.key !== "contains").map((group) => group.key),
  missing: true,
  templates: false,
  libraries: true,
};

const ids = (focus: string, options = SHOW) =>
  localGraph(GRAPH, options, focus)
    .nodes.map((node) => node.id)
    .sort();

describe("the open entry's graph", () => {
  it("holds the entry, what it links to and what links to it, and its scope's AGENTS.md with its folder", () => {
    expect(ids("film/scene.md")).toEqual([
      "#draft",
      "?film/gone",
      "film/",
      "film/AGENTS.md",
      "film/other.md",
      "film/scene.md",
    ]);
  });

  it("leaves out what is two links away", () => {
    expect(ids("film/scene.md")).not.toContain("notes/far.md");
    expect(ids("film/other.md")).toContain("notes/far.md");
  });

  it("marks the AGENTS.md and the folder it opens its scope over, and ties the two", () => {
    const shown = localGraph(GRAPH, SHOW, "film/scene.md");
    const folder = shown.nodes.findIndex((node) => node.id === "film/");
    const opener = shown.nodes.findIndex((node) => node.id === "film/AGENTS.md");
    expect(shown.nodes[folder].mark).toBe(2);
    expect(shown.nodes[opener].mark).toBe(1);
    expect(shown.links).toContainEqual({ source: folder, target: opener, kind: "contains" });
  });

  it("follows the switches for what it reaches, but always holds the entry itself", () => {
    expect(ids("film/scene.md", { ...SHOW, missing: false })).not.toContain("?film/gone");
    expect(ids("film/scene.md", { ...SHOW, edges: SHOW.edges.filter((key) => key !== "tag") })).not.toContain("#draft");
    expect(ids("_templates/t.md")).toEqual(["_templates/t.md"]);
  });

  it("gives a folder what it holds as its links, Folders on or off", () => {
    expect(ids("film/")).toEqual(["film/", "film/AGENTS.md", "film/other.md", "film/scene.md"]);
  });

  it("is empty for an entry the graph doesn't hold", () => {
    expect(localGraph(GRAPH, SHOW, "elsewhere.md")).toEqual({ nodes: [], links: [] });
  });
});
