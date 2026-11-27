import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { contentHashFor } from "../../src/protocol/appletFile.ts";
import { parseFlowFile } from "../../src/protocol/flowFile.ts";
import { serializeFlowFile } from "../../src/protocol/flowHtml.ts";
import { serializeTableFile } from "../../src/protocol/tableHtml.ts";
import type { FlowEdgeInstance, FlowGraph, FlowNodeInstance } from "../../src/protocol/types.ts";
import { checkProposal } from "../../src/server/checkProposal.ts";
import { tempDir } from "../support/isolation.ts";

// What the copilot proposes, checked against a real space on disk: problems
// come back instead of a proposal, and a Flow comes back with what the host
// derives from the space filled in, as its editor would record it.

let space: string;
const at = { x: 0, y: 0 };

function node(id: string, type: string, config: Record<string, unknown> = {}): FlowNodeInstance {
  return { id, type, position: at, config };
}

function wire(source: string, sourcePort: string, target: string, targetPort: string): FlowEdgeInstance {
  return { id: `${source}:${sourcePort}>${target}:${targetPort}`, source, sourcePort, target, targetPort };
}

function flow(graph: FlowGraph): string {
  return serializeFlowFile({ version: "1.0", name: "Story", graph });
}

async function problemsOf(name: string, content: string): Promise<string[]> {
  return (await checkProposal(space, name, content)).problems;
}

const APPLET = `<!DOCTYPE html>
<html>
<head><script type="application/json" data-role="manifest">{"id":"applet_dials","meta":{"name":"Story Dials"},"imports":{"helper":"helper.js"},"ports":{"outputs":[{"id":"direction","type":"text"}]}}</script></head>
<body><script type="module">import "helper";</script></body>
</html>
`;
const HELPER = "export const tone = 2;\n";
const TYPES = "checkbox, color, integer, media, path, score, select, text, timestamp";

beforeEach(() => {
  space = tempDir("pragma-proposal-");
  for (const dir of ["notes", "renders", ".pragma"]) mkdirSync(path.join(space, dir));
  writeFileSync(path.join(space, "notes", "idea.md"), "# Idea\n");
  writeFileSync(path.join(space, "notes", "secret.md"), "---\nvisibility: private\n---\nhidden\n");
  writeFileSync(path.join(space, ".pragma", "grants.json"), "{}");
  writeFileSync(path.join(space, "dials.applet.html"), APPLET);
  writeFileSync(path.join(space, "helper.js"), HELPER);
  writeFileSync(
    path.join(space, "cast.table.html"),
    serializeTableFile({
      version: "1.0",
      columns: [
        { id: "name", type: "text", label: "Name" },
        { id: "lead", type: "checkbox", label: "Lead" },
      ],
      rows: [],
    }),
  );
});

describe("checkProposal", () => {
  it("passes a file of another kind, and a blank one, as written", async () => {
    expect(await checkProposal(space, "notes/new.md", "# New\n")).toEqual({ content: "# New\n", problems: [] });
    expect(await checkProposal(space, "new.flow.html", "")).toEqual({ content: "", problems: [] });
  });

  it("refuses a Flow it can't read", async () => {
    expect(await problemsOf("story.flow.html", "<html><body>not a flow</body></html>")).toEqual([
      'It isn\'t a Flow Pragma can read: it needs <html data-format="flow">, and a graph block of JSON.',
    ]);
  });

  it("fills in what a Flow's editor would record, and writes the Flow as the editor does", async () => {
    const proposal = flow({
      nodes: [
        node("dials", "applet", { appletPath: "dials.applet.html" }),
        node("add", "makeObject", { tablePath: "cast.table.html" }),
        node("row", "addRow", { tablePath: "cast.table.html" }),
        node("vars", "templateVariables", { var1Name: "a", var3Name: "c" }),
        node("p", "prompt", { text: "x" }),
      ],
      edges: [wire("dials", "direction", "vars", "var_2"), wire("p", "text", "add", "name")],
    });

    const { content, problems } = await checkProposal(space, "story.flow.html", proposal);

    expect(problems).toEqual([]);
    const file = parseFlowFile(content);
    if (!file) throw new Error("The checked Flow doesn't read back");
    const filled = (id: string) => file.graph.nodes.find((candidate) => candidate.id === id);
    expect(filled("dials")?.config).toMatchObject({
      appletHash: contentHashFor(APPLET, [HELPER]),
      ports: { inputs: [], outputs: [{ id: "direction", type: "text", label: "direction" }] },
    });
    expect(filled("dials")?.label).toBe("Story Dials");
    expect(filled("row")?.config.columns).toEqual(filled("add")?.config.columns);
    expect(filled("add")?.config.columns).toEqual([
      { id: "name", type: "text", label: "Name" },
      { id: "lead", type: "checkbox", label: "Lead" },
    ]);
    expect(filled("vars")?.config.varSlots).toEqual([2, 3]);
    const { version, name, metadata, graph } = file;
    expect(serializeFlowFile({ version, name, metadata, graph })).toBe(content);
  });

  it("returns problems with the proposal as written", async () => {
    const proposal = flow({
      nodes: [node("n", "loadNote", { notePath: "notes/idea.md" }), node("s", "showText")],
      edges: [wire("n", "properties", "s", "text")],
    });
    expect(await checkProposal(space, "story.flow.html", proposal)).toEqual({
      content: proposal,
      problems: ['Show Text "s": a wire brings object into "text", which takes text; a wire joins pins of one type.'],
    });
  });

  it("shows a Flow it fills nothing into as the model wrote it", async () => {
    const graph = { nodes: [node("p", "prompt", { text: "x" })], edges: [] };
    const proposal = flow({ nodes: [], edges: [] }).replace(
      /<script type="application\/json" data-role="graph">.*<\/script>/,
      `<script type="application/json" data-role="graph">${JSON.stringify(graph, null, 2)}</script>`,
    );
    expect(await checkProposal(space, "story.flow.html", proposal)).toEqual({ content: proposal, problems: [] });
  });

  // The writer asked for one change; a stale wire already in the file is no
  // reason to refuse it.
  it("answers an edit only for the problems it adds", async () => {
    const stale = wire("p", "text", "s", "txt");
    const before = flow({ nodes: [node("p", "prompt", { text: "x" }), node("s", "showText")], edges: [stale] });
    const keeps = flow({ nodes: [node("p", "prompt", { text: "y" }), node("s", "showText")], edges: [stale] });
    const adds = flow({
      nodes: [node("p", "prompt", { text: "y" }), node("s", "showText", { colour: "red" })],
      edges: [stale],
    });
    expect((await checkProposal(space, "story.flow.html", keeps, before)).problems).toEqual([]);
    expect((await checkProposal(space, "story.flow.html", adds, before)).problems).toEqual([
      'Show Text "s": its config has "colour", which a Show Text node doesn\'t.',
    ]);
  });

  // Every copilot listing leaves out private and hidden entries, so a check
  // must not tell the model either is there: a private file reads as absent,
  // and a hidden path is one no path names, there or not.
  it("names a path that leads nowhere, reads a private file as absent, and refuses a hidden path", async () => {
    const proposal = flow({
      nodes: [
        node("a", "loadNote", { notePath: "notes/gone.md" }),
        node("b", "loadNote", { notePath: "notes/secret.md" }),
        node("c", "loadNote", { notePath: ".pragma/grants.json" }),
        node("d", "loadNote", { notePath: "notes/idea.md" }),
      ],
      edges: [],
    });
    expect(await problemsOf("story.flow.html", proposal)).toEqual([
      'Load Note "a": "notes/gone.md" isn\'t there.',
      'Load Note "b": "notes/secret.md" isn\'t there.',
      'Load Note "c": ".pragma/grants.json" can\'t be used: ".pragma/grants.json" names a hidden entry, which no path reaches',
    ]);
  });

  it("lets a node write a new note, but not into a folder that isn't there", async () => {
    const proposal = flow({
      nodes: [
        node("p", "prompt", { text: "x" }),
        node("w", "writeNote", { notePath: "notes/summary.md" }),
        node("v", "writeNote", { notePath: "drafts/summary.md" }),
      ],
      edges: [wire("p", "text", "w", "text"), wire("p", "text", "v", "text")],
    });
    expect(await problemsOf("story.flow.html", proposal)).toEqual([
      'Write Note "v": "drafts/summary.md" is in a folder that isn\'t there.',
    ]);
  });

  it("needs a folder for Generate Image's results", async () => {
    const proposal = flow({
      nodes: [
        node("g", "generateImage", { outputFolderPath: "notes/idea.md" }),
        node("h", "generateImage", { outputFolderPath: "renders" }),
      ],
      edges: [],
    });
    expect(await problemsOf("story.flow.html", proposal)).toEqual([
      'Generate Image (AI) "g": "notes/idea.md" isn\'t a folder.',
    ]);
  });

  it("names an Applet node whose Applet isn't there, and a node whose Table isn't one", async () => {
    const proposal = flow({
      nodes: [
        node("a", "applet", { appletPath: "gone.applet.html" }),
        node("m", "makeObject", { tablePath: "notes/idea.md" }),
        node("r", "addRow", { tablePath: "notes/idea.md" }),
      ],
      edges: [],
    });
    expect(await problemsOf("story.flow.html", proposal)).toEqual([
      'Applet "a": "gone.applet.html" isn\'t there.',
      'Make Object "m": "notes/idea.md" isn\'t a Table Pragma can read.',
      'Add Row "r": "notes/idea.md" isn\'t a Table Pragma can read.',
    ]);
  });

  // A wire may name the Table instead, which only the run can read.
  it("asks an Add Row node for a Table, unless a wire brings one", async () => {
    const unwired = flow({ nodes: [node("r", "addRow")], edges: [] });
    expect(await problemsOf("story.flow.html", unwired)).toEqual([
      'Add Row "r": it names no Table; "tablePath" is the Table it adds to, unless a wire brings one.',
    ]);
    const wired = flow({
      nodes: [node("p", "prompt", { text: "log.table.html" }), node("r", "addRow")],
      edges: [wire("p", "text", "r", "path")],
    });
    expect(await problemsOf("story.flow.html", wired)).toEqual([]);
  });

  it("names a Table column it would read as text, or that no Flow could name", async () => {
    const table = `<!DOCTYPE html>
<html data-format="table" data-format-version="1.0" data-id="tbl_people">
<body>
  <table data-role="data">
    <thead><tr>
      <th data-field="name" data-type="text">Name</th>
      <th data-field="age" data-type="number">Age</th>
      <th data-type="text">Note</th>
      <th data-field="name" data-type="text">Again</th>
    </tr></thead>
    <tbody></tbody>
  </table>
</body>
</html>`;
    expect(await problemsOf("people.table.html", table)).toEqual([
      `The column "age" is a "number", a type Pragma doesn't have: ${TYPES}.`,
      'The column "Note" has no data-field id.',
      'Two columns are "name"; an id names one column.',
    ]);
    expect(await problemsOf("people.table.html", "<html><body></body></html>")).toEqual([
      'It isn\'t a Table Pragma can read: it needs <html data-format="table">.',
    ]);
  });

  it("names a Class field the reader would misread, and a file that isn't a Class", async () => {
    const classFile = `<!DOCTYPE html>
<html data-format="class" data-format-version="1.0" data-id="col_shots">
<body>
  <table data-role="fields"><thead><tr>
    <th data-field="status" data-type="select" data-options="draft,shot">Status</th>
    <th data-field="take" data-type="number">Take</th>
    <th data-field="lens, mm" data-type="text">Lens</th>
  </tr></thead></table>
</body>
</html>`;
    expect(await problemsOf("shots.class.html", classFile)).toEqual([
      `The field "take" is a "number", a type Pragma doesn't have: ${TYPES}.`,
      `The field "lens, mm" has a comma in its key, which a view's data-fields can't list.`,
    ]);
    expect(await problemsOf("shots.class.html", "<html><body></body></html>")).toEqual([
      'It isn\'t a Class Pragma can read: it needs <html data-format="class">.',
    ]);
  });

  it("names what an Applet's reader would drop, and what a Flow would refuse", async () => {
    const check = (manifest: string) =>
      problemsOf(
        "new.applet.html",
        `<!DOCTYPE html><html><head><script type="application/json" data-role="manifest">${manifest}</script></head><body></body></html>`,
      );
    expect(await check("{ not json")).toEqual(["Its manifest isn't JSON, so the Applet would open with none."]);
    expect(
      await check('{"ports":{"outputs":[{"id":"a","type":"text"},{"id":"a","type":"text"},{"type":"text"}]}}'),
    ).toEqual(["2 of its outputs would be dropped: a port needs an id of its own and a Flow port type."]);
    expect(await check('{"ports":{"inputs":[{"id":"a","type":"text"}],"outputs":[{"id":"b","type":"text"}]}}')).toEqual(
      ["An Applet node takes inputs or gives outputs, not both."],
    );
    expect(await check('{"capabilities":["generate"]}')).toEqual([expect.stringContaining("declares capabilities")]);
    expect(await check('{"imports":{"x":"missing.js"}}')).toEqual(['Import "x" (missing.js) isn\'t there.']);
    expect(await check('{"ports":{"outputs":[{"id":"a","type":"text"}]}}')).toEqual([]);
  });
});
