import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GraphNode, SpaceGraphResponse } from "../../src/protocol/api.ts";
import { serializeTableFile } from "../../src/protocol/tableHtml.ts";
import { buildSpaceGraph } from "../../src/server/spaceGraph.ts";
import { giveSpaceLibraries } from "../support/libraries.ts";

const folders: string[] = [];

async function folder(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  folders.push(dir);
  return dir;
}

async function fill(root: string, files: Record<string, string>): Promise<string> {
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(root, ...relative.split("/"));
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, content);
  }
  return root;
}

const space = async (files: Record<string, string>) => fill(await folder("pragma-graph-"), files);

// Every edge as `from -> to (kind)`, crossings marked, for one assertion.
function edges(graph: SpaceGraphResponse, kinds?: string[]): string[] {
  return graph.edges
    .filter((edge) => !kinds || kinds.includes(edge.kind))
    .map(
      (edge) =>
        `${graph.nodes[edge.from].id} -> ${graph.nodes[edge.to].id} (${edge.kind}${edge.crosses ? ", crosses" : ""})`,
    )
    .sort();
}

const node = (graph: SpaceGraphResponse, id: string): GraphNode | undefined =>
  graph.nodes.find((each) => each.id === id);

beforeEach(async () => {
  vi.stubEnv("PRAGMA_CONFIG_DIR", await folder("pragma-graph-config-"));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(folders.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("the space graph", () => {
  it("joins a note to what it links and embeds, a missing target included, labelled by title", async () => {
    const root = await space({
      "notes/a.md": "# Alpha\n\nSee [[b]] and [c](../c.md), and [[gone]].\n\n![](../art/cover.png)\n",
      "notes/b.md": "Plain.\n",
      "c.md": "",
      "art/cover.png": "",
    });
    const graph = await buildSpaceGraph(root);
    expect(edges(graph, ["link", "embed"])).toEqual([
      "notes/a.md -> ?notes/gone (link)",
      "notes/a.md -> art/cover.png (embed)",
      "notes/a.md -> c.md (link)",
      "notes/a.md -> notes/b.md (link)",
    ]);
    expect(node(graph, "notes/a.md")?.label).toBe("Alpha");
    expect(node(graph, "notes/b.md")?.label).toBe("b");
    expect(node(graph, "?notes/gone")?.kind).toBe("missing");
  });

  it("puts each entry in its scope, marks the AGENTS.md opening one, and marks a link across a scope's edge", async () => {
    const root = await space({
      "projects/film/AGENTS.md": "---\npragma:\n---\n# Film\n",
      "projects/film/README.md": "---\npragma:\n---\n",
      "projects/film/scene.md": "[[/ideas/seed]] and [[cast]]\n",
      "projects/film/cast.md": "",
      "projects/film/sub/AGENTS.md": "---\npragma:\n---\n",
      "ideas/AGENTS.md": "# Ideas\n",
      "ideas/seed.md": "",
      "AGENTS.md": "---\npragma:\n---\n",
    });
    const graph = await buildSpaceGraph(root);
    expect(graph.scopes.map((scope) => [scope.id, scope.parent])).toEqual([
      ["", null],
      ["projects/film", ""],
      ["projects/film/sub", "projects/film"],
    ]);
    expect(node(graph, "projects/film/scene.md")?.scope).toBe("projects/film");
    expect(node(graph, "ideas/seed.md")?.scope).toBe("");
    expect(graph.nodes.filter((each) => each.opensScope).map((each) => each.id)).toEqual([
      "projects/film/AGENTS.md",
      "projects/film/sub/AGENTS.md",
    ]);
    expect(edges(graph, ["link"])).toEqual([
      "projects/film/scene.md -> ideas/seed.md (link, crosses)",
      "projects/film/scene.md -> projects/film/cast.md (link)",
    ]);
  });

  it("ties a document to each tag it carries once, in the colour _tags.json gives it, never across a scope", async () => {
    const root = await space({
      "_tags.json": JSON.stringify({ tags: [{ name: "draft", color: "#cc3300" }] }),
      "a.md": "---\ntags: [draft]\n---\nAnd #Draft again, and #idea.\n",
    });
    const graph = await buildSpaceGraph(root);
    expect(edges(graph, ["tag"])).toEqual(["a.md -> #draft (tag)", "a.md -> #idea (tag)"]);
    expect(node(graph, "#draft")).toMatchObject({ kind: "tag", label: "#draft", scope: null, color: "#cc3300" });
    expect(node(graph, "_tags.json")).toBeUndefined();
  });

  it("reaches the files a Table's path column holds", async () => {
    const table = serializeTableFile({
      version: "1.0",
      columns: [{ id: "shot", type: "media", label: "Shot" }],
      rows: [{ values: { shot: "renders/a.png" } }, { values: { shot: "" } }],
    });
    const root = await space({ "log.table.html": table, "renders/a.png": "" });
    const graph = await buildSpaceGraph(root);
    expect(edges(graph, ["tablePath"])).toEqual(["log.table.html -> renders/a.png (tablePath)"]);
    expect(node(graph, "log.table.html")?.kind).toBe("table");
  });

  it("files every entry under its folder, and marks a preset", async () => {
    const root = await space({
      "a/b/c.md": "",
      "kit/scene.md": "",
      "_presets.json": JSON.stringify({ templates: ["kit/"] }),
    });
    const graph = await buildSpaceGraph(root);
    expect(edges(graph, ["contains"])).toEqual([
      "a/ -> a/b/ (contains)",
      "a/b/ -> a/b/c.md (contains)",
      "kit/ -> kit/scene.md (contains)",
    ]);
    expect(node(graph, "a/b/")).toMatchObject({ kind: "folder", label: "b/" });
    expect(node(graph, "kit/scene.md")?.preset).toBe(true);
    expect(node(graph, "a/b/c.md")?.preset).toBeUndefined();
  });

  it("reads a library's files only once the space names the library, each in the library's one scope", async () => {
    const library = await fill(await folder("pragma-graph-library-"), { "refs/still.png": "" });
    const root = await space({ "a.md": "![](lib:stills/refs/still.png)\n" });
    giveSpaceLibraries(process.env.PRAGMA_CONFIG_DIR as string, root, [
      { id: "stills", label: "Stills", path: library, access: "read-only" },
    ]);
    const graph = await buildSpaceGraph(root);
    expect(edges(graph, ["embed"])).toEqual(["a.md -> lib:stills/refs/still.png (embed, crosses)"]);
    expect(node(graph, "lib:stills/refs/still.png")).toMatchObject({ library: true, scope: "lib:stills" });
    expect(graph.scopes.at(-1)).toEqual({ id: "lib:stills", name: "Stills", parent: null, library: true });
  });
});
