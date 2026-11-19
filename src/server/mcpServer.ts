// The space's MCP surface, built on the official SDK so protocol framing and
// version negotiation are not ours to get subtly wrong. The boundary is ours:
// loopback binding, the origin check, bearer auth, space binding and the
// read-only ceiling all run in apiServer.ts, so the SDK never sees a request
// that hasn't already been authorized.
//
// Every tool reads, except run_flow, offered only to a token that may write:
// a read-only harness should not be shown a tool it will only be refused.
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { FlowInputError } from "../protocol/flowInputs.ts";
import { isFlowFile } from "../protocol/types.ts";
import { agentReader, isVisible, visiblePaths } from "./agentSurface.ts";
import type { AuthorizedRequest } from "./apiServer.ts";
import { FlowAlreadyRunningError, type FlowRunOutcome, runFlowHeadless, UnattendedRunRefusedError } from "./flowRun.ts";
import {
  loadProtocolSpec,
  noSuchSection,
  type ProtocolSpec,
  specSectionInput,
  specToolDescription,
} from "./protocolSpec.ts";
import { runnableFlows } from "./runnableFlows.ts";
import { pragmaVersion } from "./version.ts";

// Every tool answers with text; a caller that wants structure parses the JSON
// these produce, rather than the surface inventing a second encoding.
const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });
const refusal = (value: string) => ({ ...text(value), isError: true });

// A run's results as MCP content: the JSON summary, with each image result
// replaced by a pointer to an image block after it, since a base64 payload in
// text is unreadable to a model that could simply be shown the image.
function runContent(outcome: FlowRunOutcome) {
  const images: { type: "image"; data: string; mimeType: string }[] = [];
  const results = outcome.results.map(({ nodeId, port, value }) => {
    const name = `${nodeId}.${port}`;
    if (value.type === "video") {
      const { type: _type, ...clip } = value;
      return { name, value: clip };
    }
    if (value.type !== "image") return { name, value: value.value };
    images.push({ type: "image", data: value.data, mimeType: value.mediaType });
    return { name, value: `(image ${images.length}, attached below)` };
  });
  const summary = { results, errors: outcome.errors.map(({ nodeId, message }) => ({ node: nodeId, message })) };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(summary, null, 2) }, ...images],
    isError: outcome.errors.length > 0,
  };
}

// run_flow calls in flight, by token and JSON-RPC request id. The endpoint is
// stateless, so a client's notifications/cancelled — what an SDK client sends
// when it gives up, without dropping the connection — arrives on a request of
// its own, at a fresh server that never saw the call. This is how it finds the
// run. Keyed by token so one client cannot stop another's.
const runsInFlight = new Map<string, AbortController>();
const runKey = (authorized: AuthorizedRequest, requestId: string | number) => `${authorized.token.id}:${requestId}`;

// Stops every run a batch of messages cancels.
function applyCancellations(body: unknown, authorized: AuthorizedRequest): void {
  for (const message of Array.isArray(body) ? body : [body]) {
    const { method, params } = (message ?? {}) as { method?: unknown; params?: { requestId?: unknown } };
    const requestId = params?.requestId;
    if (method !== "notifications/cancelled" || (typeof requestId !== "string" && typeof requestId !== "number")) {
      continue;
    }
    runsInFlight.get(runKey(authorized, requestId))?.abort();
  }
}

export function createSpaceMcpServer(
  spaceRoot: string,
  authorized: AuthorizedRequest,
  spec: ProtocolSpec | undefined,
): McpServer {
  const server = new McpServer({
    name: "pragma",
    version: pragmaVersion,
  });

  server.registerTool(
    "describe_space",
    {
      title: "Describe the space",
      description:
        "The space this token can reach: its name, how many files are visible, and what this token is allowed to do.",
      inputSchema: {},
    },
    async () => {
      const paths = await visiblePaths(spaceRoot);
      return text(
        JSON.stringify(
          {
            name: path.basename(spaceRoot),
            visibleFiles: paths.length,
            // Stated rather than implied: a caller that knows it is read-only
            // can say so instead of discovering it by being refused.
            access: authorized.canWrite ? "read-write" : "read-only",
            token: authorized.token.label,
          },
          null,
          2,
        ),
      );
    },
  );

  // The reads every model surface shares. A reader per call, so each reads
  // the space as it is then.
  for (const { name, title, description, input } of agentReader(spaceRoot).tools) {
    server.registerTool(name, { title, description, inputSchema: input }, async (args) => {
      const tool = agentReader(spaceRoot).tools.find((each) => each.name === name);
      return text(tool ? await tool.run(args) : "");
    });
  }

  server.registerTool(
    "list_runnable_flows",
    {
      title: "List runnable flows",
      description:
        "The flows this space's owner has allowed to run unattended, each with the inputs it takes and the outputs it returns. Pass an input's name to run_flow.",
      inputSchema: {},
    },
    async () => text(JSON.stringify(await runnableFlows(spaceRoot), null, 2)),
  );

  if (spec) {
    server.registerTool(
      "read_pragma_spec",
      {
        title: "Read Pragma's spec",
        description: specToolDescription(spec),
        inputSchema: { section: specSectionInput },
      },
      async ({ section }) => {
        const content = spec.read(section);
        return content === undefined ? refusal(noSuchSection(spec, section)) : text(content);
      },
    );
  }

  if (authorized.canWrite) {
    server.registerTool(
      "run_flow",
      {
        title: "Run a flow",
        description:
          "Runs a flow listed by list_runnable_flows and returns its outputs. Inputs apply to this run only and are never saved. A run stops after five minutes.",
        inputSchema: {
          path: z.string().describe("Space-relative path of the flow, as listed by list_runnable_flows."),
          inputs: z
            .record(z.string(), z.union([z.string(), z.boolean(), z.number().int()]))
            .optional()
            .describe(
              "Values by input name (<nodeId>.<field>). A boolean input takes true or false, an integer input a whole number; the rest take strings.",
            ),
        },
      },
      // An SDK client gives up after 60 s by default; either way it goes —
      // a closed connection (`signal`) or a cancellation — the run stops too.
      async ({ path: relativePath, inputs }, { signal, requestId }) => {
        if (!isFlowFile(relativePath) || !(await isVisible(spaceRoot, relativePath))) {
          return refusal(`No such flow: ${relativePath}`);
        }
        const caller = new AbortController();
        const key = runKey(authorized, requestId);
        runsInFlight.set(key, caller);
        signal.addEventListener("abort", () => caller.abort(), { once: true });
        try {
          return runContent(
            await runFlowHeadless(spaceRoot, relativePath, { unattended: true, inputs, signal: caller.signal }),
          );
        } catch (error) {
          if (
            error instanceof UnattendedRunRefusedError ||
            error instanceof FlowInputError ||
            error instanceof FlowAlreadyRunningError
          ) {
            return refusal(error.message);
          }
          throw error;
        } finally {
          if (runsInFlight.get(key) === caller) runsInFlight.delete(key);
        }
      },
    );
  }

  return server;
}

/** Serves one MCP request. Stateless: a fresh server and transport per
 * request, with no session id, because the read tier has nothing to remember
 * between calls and a session store is state to get wrong for no gain. */
export async function handleMcpRequest(
  spaceRoot: string,
  req: IncomingMessage,
  res: ServerResponse,
  authorized: AuthorizedRequest,
  body: unknown,
): Promise<void> {
  applyCancellations(body, authorized);
  const server = createSpaceMcpServer(spaceRoot, authorized, await loadProtocolSpec());
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}
