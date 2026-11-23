import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type ApiToken,
  createApiToken,
  findSpaceId,
  loadGlobalConfig,
  rememberSpace,
  saveGlobalConfig,
} from "../../src/config/loadConfig.ts";
import { capabilityDigest, readFlowFile } from "../../src/protocol/flowFile.ts";
import { serializeFlowFile } from "../../src/protocol/flowHtml.ts";
import { type AgentEndpoint, createAgentEndpoint } from "../../src/server/apiServer.ts";
import { setUnattended } from "../../src/server/grants.ts";
import { hungFlow } from "../support/hungFlow.ts";
import { isolateConfig, tempDir } from "../support/isolation.ts";

// End-to-end over real HTTP with the SDK's own client, rather than calling the
// tool callbacks directly: the point of taking the SDK was that the protocol
// is not ours to get right, so the test should exercise the protocol too.
let space: string;
let endpoint: AgentEndpoint | undefined;
let client: Client;
let writeSecret: string;

// A flow that needs no capability: Join Text with one exposed input and its
// output exposed as the result.
function writeJoinFlow(file: string, visibility?: string): void {
  writeFileSync(
    path.join(space, file),
    serializeFlowFile({
      version: "1.0",
      name: "Join",
      metadata: visibility ? [{ key: "visibility", values: [visibility] }] : [],
      graph: {
        nodes: [
          {
            id: "join-1",
            type: "joinText",
            position: { x: 0, y: 0 },
            config: { text_1: "saved", text_2: "and", text_3: "tail", separator: " " },
            exposed: ["text_1", "text"],
          },
        ],
        edges: [],
      },
    }),
  );
}

async function allowUnattended(file: string): Promise<void> {
  const flow = await readFlowFile(path.join(space, file));
  await setUnattended(space, { path: file, contentHash: capabilityDigest(flow.graph) }, true);
}

async function connect(secret: string): Promise<Client> {
  const connected = new Client({ name: "test", version: "1" });
  await connected.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${endpoint?.port()}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${secret}` } },
    }),
  );
  return connected;
}

const callText = async (name: string, args: Record<string, unknown> = {}): Promise<string> => {
  const result = (await client.callTool({ name, arguments: args })) as { content: { text: string }[] };
  return result.content[0].text;
};

beforeEach(async () => {
  isolateConfig();
  space = tempDir("pragma-mcp-space-");

  writeFileSync(path.join(space, "hello.md"), "# Hello\n\nthe secret word is banana\n");
  writeFileSync(path.join(space, "secret.md"), "---\nvisibility: private\n---\nthe private word is durian\n");
  // Host state, never space content — it must be neither listed nor readable.
  mkdirSync(path.join(space, ".pragma"), { recursive: true });
  writeFileSync(path.join(space, ".pragma", "grants.json"), '{"peek":true}');

  const registered = rememberSpace(loadGlobalConfig(), space);
  const { secret, record } = createApiToken({
    label: "Test harness",
    spaceId: findSpaceId(registered, space) as string,
    access: "read-only",
  });
  const writer = createApiToken({
    label: "Writer",
    spaceId: findSpaceId(registered, space) as string,
    access: "read-write",
  });
  writeSecret = writer.secret;
  saveGlobalConfig({
    ...registered,
    api: { enabled: true, port: 0 },
    apiTokens: [record satisfies ApiToken, writer.record],
  });

  endpoint = createAgentEndpoint(() => space);
  await endpoint.apply();
  client = new Client({ name: "test", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${endpoint?.port()}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${secret}` } },
    }),
  );
});

afterEach(async () => {
  await client?.close();
  await endpoint?.close();
});

describe("the space's MCP surface", () => {
  it("offers a read-only token the read tier and nothing that runs", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "describe_space",
      "list_runnable_flows",
      "list_space_file_links",
      "list_space_files",
      "read_pragma_spec",
      "read_space_file",
      "search_space_files",
    ]);
  });

  it("reads Pragma's spec a section at a time", async () => {
    const section = await callText("read_pragma_spec", { section: "generateImage" });
    expect(section).toMatch(/^### `generateImage`/);
    expect(section.match(/^#+ /gm)).toHaveLength(1);

    const missing = (await client.callTool({ name: "read_pragma_spec", arguments: { section: "nope" } })) as {
      content: { text: string }[];
      isError?: boolean;
    };
    expect(missing.isError).toBe(true);
    expect(missing.content[0].text).toContain("Sections: ");
  });

  it("reports the space and says plainly that the token is read-only", async () => {
    expect(JSON.parse(await callText("describe_space"))).toMatchObject({
      name: path.basename(space),
      visibleFiles: 1,
      access: "read-only",
      token: "Test harness",
    });
  });

  // The surface is bounded by what the tree shows, not by what the filesystem
  // allows (docs/agent-api.md, Tools).
  it("lists neither private documents nor host state", async () => {
    expect(await callText("list_space_files")).toBe("hello.md");
  });

  it("searches only what it lists", async () => {
    expect(await callText("search_space_files", { query: "banana" })).toContain("hello.md:3:");
    expect(await callText("search_space_files", { query: "durian" })).toBe('Nothing in the space matches "durian".');
  });

  it("reads a visible document", async () => {
    expect(await callText("read_space_file", { path: "hello.md" })).toContain("the secret word is banana");
  });

  it("reads a note a section at a time, and gives a file's links, as the copilot's tools do", async () => {
    writeFileSync(
      path.join(space, "look.md"),
      "# Look\n\n## Light\n\nWarm.\n\n## Camera\n\nWide.\n\n[Hello](hello.md)\n",
    );
    expect(await callText("read_space_file", { path: "look.md", section: "camera" })).toBe(
      "## Camera\n\nWide.\n\n[Hello](hello.md)",
    );
    expect(await callText("list_space_file_links", { path: "look.md" })).toBe("Links to:\nhello.md");
    expect(await callText("list_space_file_links", { path: "secret.md" })).toBe(
      "There's no file at secret.md in the space.",
    );
  });

  // Unlistable has to mean unreadable too. Without the listing check a caller
  // could name any of these directly: path confinement alone would resolve
  // them happily.
  // A PDF lists like any media the tree shows, so reading one has to say
  // there is no text rather than hand a model its bytes decoded as utf8.
  it("refuses a PDF's bytes as text", async () => {
    writeFileSync(path.join(space, "paper.pdf"), "%PDF-1.4\n%%EOF\n");
    expect(await callText("list_space_files")).toContain("paper.pdf");
    const read = await callText("read_space_file", { path: "paper.pdf" });
    expect(read).toContain("PDF");
    expect(read).not.toContain("%PDF");
  });

  it("refuses to read anything it would not list", async () => {
    for (const target of ["secret.md", ".pragma/grants.json", "../../etc/passwd"]) {
      expect(await callText("read_space_file", { path: target })).toBe(`There's no file at ${target} in the space.`);
    }
  });

  it("keeps a Table, Flow or Class marked private as it keeps a private note", async () => {
    const marked = (format: string) =>
      `<html data-format="${format}"><body><dl data-role="metadata"><dt>visibility</dt><dd>private</dd></dl>` +
      "<p>the private word is quince</p></body></html>";
    const files = ["cast.table.html", "polish.flow.html", "shots.class.html"];
    for (const file of files) writeFileSync(path.join(space, file), marked(file.split(".")[1]));

    expect(await callText("list_space_files")).toBe("hello.md");
    expect(await callText("search_space_files", { query: "quince" })).toBe('Nothing in the space matches "quince".');
    for (const file of files) {
      expect(await callText("read_space_file", { path: file })).toBe(`There's no file at ${file} in the space.`);
    }
  });
});

describe("running flows over MCP", () => {
  it("lists only the flows allowed to run unattended, with their inputs and outputs", async () => {
    writeJoinFlow("allowed.flow.html");
    writeJoinFlow("held.flow.html");
    writeJoinFlow("private.flow.html", "private");
    await allowUnattended("allowed.flow.html");
    await allowUnattended("private.flow.html");

    expect(JSON.parse(await callText("list_runnable_flows"))).toEqual([
      {
        path: "allowed.flow.html",
        name: "Join",
        description: "",
        inputs: [{ name: "join-1.text_1", label: "Join Text · text_1", type: "text" }],
        outputs: [{ name: "join-1.text", label: "Join Text · text" }],
      },
    ]);
  });

  it("runs with inputs applied for that run only", async () => {
    writeJoinFlow("allowed.flow.html");
    await allowUnattended("allowed.flow.html");
    const writer = await connect(writeSecret);
    const run = async (inputs?: Record<string, unknown>) =>
      (await writer.callTool({ name: "run_flow", arguments: { path: "allowed.flow.html", inputs } })) as {
        content: { text: string }[];
        isError?: boolean;
      };

    const withInput = await run({ "join-1.text_1": "given" });
    expect(withInput.isError).toBeFalsy();
    expect(JSON.parse(withInput.content[0].text)).toEqual({
      results: [{ name: "join-1.text", value: "given and tail" }],
      errors: [],
    });
    // Nothing the caller supplied was saved.
    expect(JSON.parse((await run()).content[0].text).results[0].value).toBe("saved and tail");
    await writer.close();
  });

  it("takes a whole number for an Int's value, and refuses one written as a string", async () => {
    writeFileSync(
      path.join(space, "count.flow.html"),
      serializeFlowFile({
        version: "1.0",
        name: "Count",
        metadata: [],
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
    await allowUnattended("count.flow.html");
    const writer = await connect(writeSecret);
    const run = async (inputs: Record<string, unknown>) =>
      (await writer.callTool({ name: "run_flow", arguments: { path: "count.flow.html", inputs } })) as {
        content: { text: string }[];
        isError?: boolean;
      };

    const counted = await run({ "int-1.value": 40 });
    expect(counted.isError).toBeFalsy();
    expect(JSON.parse(counted.content[0].text).results).toEqual([{ name: "int-1.int", value: 40 }]);
    const typed = await run({ "int-1.value": "40" });
    expect(typed.isError).toBe(true);
    expect(typed.content[0].text).toMatch(/takes a whole number/);
    await writer.close();
  });

  it("refuses a flow not allowed to run unattended, and an input it does not take", async () => {
    writeJoinFlow("held.flow.html");
    writeJoinFlow("allowed.flow.html");
    await allowUnattended("allowed.flow.html");
    const writer = await connect(writeSecret);
    const call = async (args: Record<string, unknown>) =>
      (await writer.callTool({ name: "run_flow", arguments: args })) as {
        content: { text: string }[];
        isError?: boolean;
      };

    const held = await call({ path: "held.flow.html" });
    expect(held.isError).toBe(true);
    expect(held.content[0].text).toMatch(/not allowed to run unattended/);

    const unknown = await call({ path: "allowed.flow.html", inputs: { "join-1.separator": "-" } });
    expect(unknown.isError).toBe(true);
    expect(unknown.content[0].text).toMatch(/takes no input "join-1\.separator"/);

    expect((await call({ path: "hello.md" })).content[0].text).toMatch(/No such flow/);
    await writer.close();
  });

  // An SDK client that times out sends notifications/cancelled on a request
  // of its own rather than dropping the connection; the run must still stop,
  // model call included.
  it("stops a run the client gives up on", async () => {
    const model = await hungFlow(space, "hang.flow.html");
    const writer = await connect(writeSecret);
    await expect(
      writer.callTool({ name: "run_flow", arguments: { path: "hang.flow.html" } }, undefined, { timeout: 300 }),
    ).rejects.toThrow(/timed out/);
    await vi.waitFor(() => expect(model.closed()).toBe(true));
    await writer.close();
    model.stop();
  });
});
