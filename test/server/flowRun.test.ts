import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadGlobalConfig, rememberSpace, saveGlobalConfig } from "../../src/config/loadConfig.ts";
import { capabilityDigest, readFlowFile } from "../../src/protocol/flowFile.ts";
import { serializeFlowFile } from "../../src/protocol/flowHtml.ts";
import { localDay } from "../../src/protocol/localDay.ts";
import { serializeTableFile } from "../../src/protocol/tableHtml.ts";
import {
  describeSpends,
  FlowAlreadyRunningError,
  runFlowHeadless,
  UnattendedRunRefusedError,
} from "../../src/server/flowRun.ts";
import { grantCapability, setUnattended } from "../../src/server/grants.ts";

// Config and grants are install-global, so this points PRAGMA_CONFIG_DIR at a
// temp directory — see loadConfig.ts.
let configDir: string;
let space: string;

const FLOW_PATH = "notes.flow.html";

// A two-node graph: read a note, show it. Enough to exercise a real
// capability check without a model call or a picker. `exposed` marks the
// output ports a human picked with right-click → Expose.
function writeFlow(exposed?: { nodeId: string; ports: string[] }): void {
  writeFileSync(
    path.join(space, FLOW_PATH),
    serializeFlowFile({
      version: "1.0",
      name: "Notes",
      graph: {
        nodes: [
          {
            id: "load-1",
            type: "loadNote",
            position: { x: 0, y: 0 },
            config: { notePath: "note.md" },
            ...(exposed?.nodeId === "load-1" ? { exposed: exposed.ports } : {}),
          },
          {
            id: "show-1",
            type: "showText",
            position: { x: 200, y: 0 },
            config: {},
            ...(exposed?.nodeId === "show-1" ? { exposed: exposed.ports } : {}),
          },
        ],
        edges: [{ id: "e1", source: "load-1", sourcePort: "raw", target: "show-1", targetPort: "text" }],
      },
    }),
  );
}

// A flow's grants are pinned to its capability digest (protocol.md's Grant
// storage), so a test that grants has to name the digest of the graph it
// just wrote, exactly as the canvas does.
async function grantOnDisk(capabilityKey: string): Promise<void> {
  const { graph } = await readFlowFile(path.join(space, FLOW_PATH));
  await grantCapability(space, { path: FLOW_PATH, contentHash: capabilityDigest(graph) }, capabilityKey);
}

beforeEach(() => {
  configDir = mkdtempSync(path.join(tmpdir(), "pragma-flowrun-config-"));
  process.env.PRAGMA_CONFIG_DIR = configDir;
  space = mkdtempSync(path.join(tmpdir(), "pragma-flowrun-space-"));
  mkdirSync(path.join(space, ".pragma"), { recursive: true });
  saveGlobalConfig(rememberSpace(loadGlobalConfig(), space));
  writeFileSync(path.join(space, "note.md"), "the note body");
  writeFlow();
});

afterEach(() => {
  delete process.env.PRAGMA_CONFIG_DIR;
  rmSync(configDir, { recursive: true, force: true });
  rmSync(space, { recursive: true, force: true });
});

describe("runFlowHeadless", () => {
  // The policy: consult the space's existing grants, never prompt, never
  // auto-grant. A headless runner can only exercise what a human already
  // approved at the canvas — it can never widen what a flow may do.
  it("refuses a capability the flow has not been granted, naming what it wanted", async () => {
    const outcome = await runFlowHeadless(space, FLOW_PATH);

    expect(outcome.errors.map((entry) => entry.nodeId)).toEqual(["load-1", "show-1"]);
    expect(outcome.errors[0].message).toMatch(/Permission denied to read "note\.md"/);
    // The failure propagates rather than the downstream node running on a
    // missing input.
    expect(outcome.errors[1].message).toMatch(/upstream node "load-1" failed/);
  });

  it("runs once the capability is granted, and reports the graph's results", async () => {
    await grantOnDisk("readFile:space:note.md");

    const outcome = await runFlowHeadless(space, FLOW_PATH);

    expect(outcome.errors).toEqual([]);
    expect(outcome.outputs.find((entry) => entry.nodeId === "load-1")?.values.raw).toEqual({
      type: "text",
      value: "the note body",
    });
    // Nothing is exposed, so the flow declares no results — the values are
    // still in `outputs` for --all, but none of them is an answer.
    expect(outcome.results).toEqual([]);
    expect(outcome.outputs.map((entry) => entry.nodeId)).toEqual(["load-1", "show-1"]);
  });

  // The flow's own declaration of what it produces, reusing App Mode's Expose
  // rather than inventing a second notion of "the output".
  // A gone Table fails its node as a gone note does, rather than reading as
  // an empty one the rest of the run carries on with.
  it("fails a loader whose Table is gone, naming it by kind", async () => {
    writeFileSync(
      path.join(space, FLOW_PATH),
      serializeFlowFile({
        version: "1.0",
        name: "Notes",
        graph: {
          nodes: [
            { id: "rows-1", type: "loadTableRows", position: { x: 0, y: 0 }, config: { tablePath: "gone.table.html" } },
          ],
          edges: [],
        },
      }),
    );
    await grantOnDisk("readFile:space:gone.table.html");

    const outcome = await runFlowHeadless(space, FLOW_PATH);

    expect(Object.fromEntries(outcome.errors.map((entry) => [entry.nodeId, entry.message]))).toEqual({
      "rows-1": expect.stringContaining('No table at "gone.table.html"'),
    });
  });

  it("returns the exposed output ports when the flow declares any", async () => {
    writeFlow({ nodeId: "load-1", ports: ["raw"] });
    await grantOnDisk("readFile:space:note.md");

    const outcome = await runFlowHeadless(space, FLOW_PATH);

    expect(outcome.results).toEqual([
      { nodeId: "load-1", nodeType: "loadNote", port: "raw", value: { type: "text", value: "the note body" } },
    ]);
  });

  // `exposed` mixes port ids with config keys, so a config key must not be
  // mistaken for a result.
  it("ignores an exposed config field, which is an input and not a result", async () => {
    writeFlow({ nodeId: "load-1", ports: ["notePath"] });
    await grantOnDisk("readFile:space:note.md");

    const outcome = await runFlowHeadless(space, FLOW_PATH);

    expect(outcome.results).toEqual([]);
  });

  // Capability grants say what a run may touch; a caller that is not the
  // owner at a terminal also needs leave to start one with nobody watching.
  it("refuses an unattended run until the flow is allowed one", async () => {
    await grantOnDisk("readFile:space:note.md");
    await expect(runFlowHeadless(space, FLOW_PATH, { unattended: true })).rejects.toThrow(UnattendedRunRefusedError);

    const { graph } = await readFlowFile(path.join(space, FLOW_PATH));
    await setUnattended(space, { path: FLOW_PATH, contentHash: capabilityDigest(graph) }, true);
    const outcome = await runFlowHeadless(space, FLOW_PATH, { unattended: true });
    expect(outcome.errors).toEqual([]);
  });

  it("runs unattended through the leave's last day, and refuses after it naming that day", async () => {
    await grantOnDisk("readFile:space:note.md");
    const { graph } = await readFlowFile(path.join(space, FLOW_PATH));
    const subject = { path: FLOW_PATH, contentHash: capabilityDigest(graph) };
    await setUnattended(space, subject, true, localDay(new Date()));
    expect((await runFlowHeadless(space, FLOW_PATH, { unattended: true })).errors).toEqual([]);

    await setUnattended(space, subject, true, "2020-01-31");
    await expect(runFlowHeadless(space, FLOW_PATH, { unattended: true })).rejects.toThrow(
      `${FLOW_PATH} was allowed to run unattended until 2020-01-31. Allow it again in the flow's Permissions.`,
    );
  });

  // An input naming a different file is checked against the grants like any
  // other read, so a caller can only point a flow at what was approved.
  it("checks a path supplied as an input against the grants", async () => {
    writeFileSync(
      path.join(space, FLOW_PATH),
      serializeFlowFile({
        version: "1.0",
        name: "Image",
        graph: {
          nodes: [
            {
              id: "image-1",
              type: "loadImage",
              position: { x: 0, y: 0 },
              config: { imagePath: "approved.png" },
              exposed: ["imagePath"],
            },
          ],
          edges: [],
        },
      }),
    );
    await grantOnDisk("readFile:space:approved.png");

    const outcome = await runFlowHeadless(space, FLOW_PATH, { inputs: { "image-1.imagePath": "other.png" } });
    expect(outcome.errors).toEqual([{ nodeId: "image-1", message: 'Permission denied to read "other.png"' }]);
  });

  it("refuses a path outside the space", async () => {
    await expect(runFlowHeadless(space, "../escape.flow.html")).rejects.toThrow();
  });

  // Nobody is there to ask, so a path a wire chose runs only once a person
  // allowed that one file at the canvas.
  it("reads a path a wire brings, from the Flow's folder, only once that file is granted", async () => {
    mkdirSync(path.join(space, "tools"));
    writeFileSync(
      path.join(space, "tools", "wired.flow.html"),
      serializeFlowFile({
        version: "1.0",
        name: "Wired",
        graph: {
          nodes: [
            { id: "where", type: "prompt", position: { x: 0, y: 0 }, config: { text: "../note.md" } },
            { id: "load-1", type: "loadNote", position: { x: 0, y: 0 }, config: {} },
          ],
          edges: [{ id: "e1", source: "where", sourcePort: "text", target: "load-1", targetPort: "path" }],
        },
      }),
    );

    const refused = await runFlowHeadless(space, "tools/wired.flow.html");
    expect(refused.errors).toEqual([{ nodeId: "load-1", message: 'Permission denied to read "space:note.md"' }]);

    const { graph } = await readFlowFile(path.join(space, "tools", "wired.flow.html"));
    await grantCapability(
      space,
      { path: "tools/wired.flow.html", contentHash: capabilityDigest(graph) },
      "readFile:space:note.md",
    );
    const outcome = await runFlowHeadless(space, "tools/wired.flow.html");
    expect(outcome.errors).toEqual([]);
    expect(outcome.outputs.find((entry) => entry.nodeId === "load-1")?.values.raw).toEqual({
      type: "text",
      value: "the note body",
    });
  });
});

// A model endpoint that never answers, so a run is reliably still in flight.
describe("an unattended run in flight", () => {
  let hung: Server;
  let requestsSeen: number;
  let requestClosed: boolean;

  beforeEach(async () => {
    requestsSeen = 0;
    requestClosed = false;
    hung = createServer((req) => {
      requestsSeen++;
      req.on("close", () => (requestClosed = true));
    });
    await new Promise<void>((resolve) => hung.listen(0, "127.0.0.1", resolve));
    const port = (hung.address() as { port: number }).port;
    saveGlobalConfig({
      ...loadGlobalConfig(),
      modelProviders: [{ id: "hung", kind: "openai", baseURL: `http://127.0.0.1:${port}/v1`, textModels: ["m"] }],
    });
    writeFileSync(
      path.join(space, FLOW_PATH),
      serializeFlowFile({
        version: "1.0",
        name: "Hang",
        graph: {
          nodes: [
            { id: "prompt-1", type: "prompt", position: { x: 0, y: 0 }, config: { text: "hi" } },
            { id: "gen-1", type: "generateText", position: { x: 0, y: 0 }, config: { model: "hung/m" } },
          ],
          edges: [{ id: "e1", source: "prompt-1", sourcePort: "text", target: "gen-1", targetPort: "instruction" }],
        },
      }),
    );
    await grantOnDisk("generateText");
    const { graph } = await readFlowFile(path.join(space, FLOW_PATH));
    await setUnattended(space, { path: FLOW_PATH, contentHash: capabilityDigest(graph) }, true);
  });

  afterEach(() => {
    hung.closeAllConnections();
    hung.close();
  });

  // One at a time per flow, and a caller that goes away takes its run with it
  // — the model request included, so nothing keeps spending.
  it("refuses a second run, and stops when its caller stops waiting", async () => {
    const caller = new AbortController();
    const first = runFlowHeadless(space, FLOW_PATH, { unattended: true, signal: caller.signal });
    await vi.waitFor(() => expect(requestsSeen).toBeGreaterThan(0));

    await expect(runFlowHeadless(space, FLOW_PATH, { unattended: true })).rejects.toThrow(FlowAlreadyRunningError);

    caller.abort();
    expect((await first).errors).toEqual([{ nodeId: "gen-1", message: "the caller stopped waiting for the run" }]);
    await vi.waitFor(() => expect(requestClosed).toBe(true));

    // Finished, so the flow can run again.
    const again = new AbortController();
    const next = runFlowHeadless(space, FLOW_PATH, { unattended: true, signal: again.signal });
    again.abort();
    await expect(next).resolves.toBeDefined();
  });
});

// The canvas's grant-checked write, through the same code: a Prompt's text,
// passed by the caller, written over a note.
describe("a headless run with a Write Note", () => {
  beforeEach(() => {
    writeFileSync(
      path.join(space, FLOW_PATH),
      serializeFlowFile({
        version: "1.0",
        name: "Writer",
        graph: {
          nodes: [
            { id: "prompt-1", type: "prompt", position: { x: 0, y: 0 }, config: { text: "x" }, exposed: ["text"] },
            { id: "write-1", type: "writeNote", position: { x: 200, y: 0 }, config: { notePath: "note.md" } },
          ],
          edges: [{ id: "e1", source: "prompt-1", sourcePort: "text", target: "write-1", targetPort: "text" }],
        },
      }),
    );
  });

  it("writes nothing until a human granted the write", async () => {
    const outcome = await runFlowHeadless(space, FLOW_PATH);
    expect(outcome.errors[0].message).toMatch(/Permission denied to write "note\.md"/);
    expect(readFileSync(path.join(space, "note.md"), "utf8")).toBe("the note body");
  });

  it("then writes the text the caller passed", async () => {
    await grantOnDisk("writeDocument:space:note.md");
    const outcome = await runFlowHeadless(space, FLOW_PATH, { inputs: { "prompt-1.text": "written headless" } });
    expect(outcome.errors).toEqual([]);
    expect(readFileSync(path.join(space, "note.md"), "utf8")).toBe("written headless");
  });
});

// The canvas's locked append, through the same code: a Prompt's text, passed
// by the caller, added to the end of a note.
describe("a headless run with an Add to Note", () => {
  beforeEach(() => {
    writeFileSync(
      path.join(space, FLOW_PATH),
      serializeFlowFile({
        version: "1.0",
        name: "Logger",
        graph: {
          nodes: [
            { id: "prompt-1", type: "prompt", position: { x: 0, y: 0 }, config: { text: "x" }, exposed: ["text"] },
            { id: "add-1", type: "addToNote", position: { x: 200, y: 0 }, config: { notePath: "note.md" } },
          ],
          edges: [{ id: "e1", source: "prompt-1", sourcePort: "text", target: "add-1", targetPort: "text" }],
        },
      }),
    );
  });

  it("adds nothing until a human granted the write, then the text the caller passed", async () => {
    const denied = await runFlowHeadless(space, FLOW_PATH);
    expect(denied.errors[0].message).toMatch(/Permission denied to write "note\.md"/);
    await grantOnDisk("writeDocument:space:note.md");
    const outcome = await runFlowHeadless(space, FLOW_PATH, { inputs: { "prompt-1.text": "- added headless" } });
    expect(outcome.errors).toEqual([]);
    expect(readFileSync(path.join(space, "note.md"), "utf8")).toBe("the note body\n- added headless\n");
  });
});

// The same grant-checked append the canvas makes: a Prompt's text, passed by
// the caller, as a new row's cell.
describe("a headless run with an Add Row", () => {
  beforeEach(() => {
    writeFileSync(
      path.join(space, "log.table.html"),
      serializeTableFile({
        version: "1.0",
        name: "Log",
        columns: [{ id: "entry", label: "Entry", type: "text" }],
        rows: [],
      }),
    );
    writeFileSync(
      path.join(space, FLOW_PATH),
      serializeFlowFile({
        version: "1.0",
        name: "Logger",
        graph: {
          nodes: [
            { id: "prompt-1", type: "prompt", position: { x: 0, y: 0 }, config: { text: "x" }, exposed: ["text"] },
            {
              id: "add-1",
              type: "addRow",
              position: { x: 200, y: 0 },
              config: { tablePath: "log.table.html", columns: [{ id: "entry", label: "Entry", type: "text" }] },
            },
          ],
          edges: [{ id: "e1", source: "prompt-1", sourcePort: "text", target: "add-1", targetPort: "entry" }],
        },
      }),
    );
  });

  it("adds nothing until a human granted the write, then adds the row", async () => {
    const denied = await runFlowHeadless(space, FLOW_PATH);
    expect(denied.errors[0].message).toMatch(/Permission denied to write "log\.table\.html"/);

    await grantOnDisk("writeDocument:space:log.table.html");
    const outcome = await runFlowHeadless(space, FLOW_PATH, { inputs: { "prompt-1.text": "logged headless" } });
    expect(outcome.errors).toEqual([]);
    expect(readFileSync(path.join(space, "log.table.html"), "utf8")).toContain("<tr><td>logged headless</td></tr>");
  });
});

describe("a headless run's activity entry", () => {
  it("totals what the run's image calls spent, and counts the reused", async () => {
    const priced = {
      media: "image" as const,
      model: "h/soul_2",
      path: "art/a.png",
      reused: false,
      cost: { amount: 0.12, unit: "credits" },
    };
    expect(
      describeSpends([
        priced,
        priced,
        { media: "image", model: "h/soul_2", path: "art/b.png", reused: false },
        { media: "image", model: "h/soul_2", path: "art/c.png", reused: true },
      ]),
    ).toEqual([
      "Spent 0.24 credits on 2 images",
      "1 image generated at a price the provider didn't name",
      "1 image reused, nothing spent",
    ]);
    expect(describeSpends([])).toEqual([]);
  });

  // A video's price is the quote asked before its job, which the charge can differ from.
  it("totals what its video calls were quoted, apart from its images", async () => {
    expect(
      describeSpends([
        {
          media: "video",
          model: "h/seedance1_5",
          path: "clips/a.mp4",
          reused: false,
          cost: { amount: 2.4, unit: "credits" },
        },
        {
          media: "image",
          model: "h/soul_2",
          path: "art/a.png",
          reused: false,
          cost: { amount: 0.12, unit: "credits" },
        },
        { media: "video", model: "h/seedance1_5", path: "clips/a.mp4", reused: true },
      ]),
    ).toEqual(["Spent 0.12 credits on 1 image", "Quoted 2.4 credits for 1 video", "1 video reused, nothing spent"]);
  });
});

// Only an editor moves a value on after a run it started (protocol.md,
// Execution): a caller outside the host gets the value as stored, and the
// Flow's file is left as it was.
describe("a headless run with an Int", () => {
  it("gives the stored value, a supplied one for that run only, and writes nothing into the Flow", async () => {
    writeFileSync(
      path.join(space, FLOW_PATH),
      serializeFlowFile({
        version: "1.0",
        name: "Count",
        graph: {
          nodes: [
            {
              id: "int-1",
              type: "int",
              position: { x: 0, y: 0 },
              config: { value: "5", control: "increment" },
              exposed: ["value", "int"],
            },
          ],
          edges: [],
        },
      }),
    );
    const before = readFileSync(path.join(space, FLOW_PATH), "utf8");
    const result = { nodeId: "int-1", nodeType: "int", port: "int" };

    expect((await runFlowHeadless(space, FLOW_PATH)).results).toEqual([
      { ...result, value: { type: "number", value: 5 } },
    ]);
    expect((await runFlowHeadless(space, FLOW_PATH, { inputs: { "int-1.value": 40 } })).results).toEqual([
      { ...result, value: { type: "number", value: 40 } },
    ]);
    expect(readFileSync(path.join(space, FLOW_PATH), "utf8")).toBe(before);
  });
});

// Saved in the file, so a run with nobody at the canvas leaves out what the
// canvas does: the read is never asked for, and nothing it fed is a result.
describe("a headless run with a disabled node", () => {
  it("runs neither it nor what it feeds, and asks for nothing", async () => {
    writeFlow({ nodeId: "show-1", ports: ["text"] });
    const flow = await readFlowFile(path.join(space, FLOW_PATH));
    flow.graph.nodes[0].mode = "disabled";
    writeFileSync(path.join(space, FLOW_PATH), serializeFlowFile(flow));

    const outcome = await runFlowHeadless(space, FLOW_PATH);
    expect(outcome).toEqual({ outputs: [], errors: [], results: [] });
  });
});
