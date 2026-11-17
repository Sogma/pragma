// The agent API's second encoding: plain REST beside MCP, on the same
// listener, through the same tokens and the same enforcement.
//
// Not a second contract — a second encoding of one. MCP is designed for LLM
// harnesses; a caller that is not one should not have to hand-build a JSON-RPC
// envelope and parse SSE framing out of the reply just to read a file. A
// workflow tool with a generic HTTP node can do the first and cannot do the
// last. See docs/agent-api.md.
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { FlowInputError } from "../protocol/flowInputs.ts";
import { isWithin } from "../protocol/rootedPath.ts";
import { isFlowFile, isMarkdownFile } from "../protocol/types.ts";
import { agentReader, isVisible, isVisibleFolder, readVisibleFile, visiblePaths } from "./agentSurface.ts";
import type { AuthorizedRequest } from "./apiServer.ts";
import { FlowAlreadyRunningError, runFlowHeadless, UnattendedRunRefusedError } from "./flowRun.ts";
import { findSection, outlineOf, sectionText } from "./markdownSections.ts";
import { loadProtocolSpec, sectionAnchors } from "./protocolSpec.ts";
import { runnableFlows } from "./runnableFlows.ts";
import { searchSpaceFiles } from "./tree.ts";

function send(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body, null, 2));
}

const notFound = (res: ServerResponse, path: string) => send(res, 404, { error: `No such file: ${path}` });

/** The space-relative path from a `/files/...` URL.
 *
 * Decoded per segment and rejected if a segment still contains a separator.
 * A percent-encoded slash decoded into a whole path is a known way to escape
 * a space root in this class of endpoint, and it is not a mistake worth
 * repeating even though the visibility check below would also catch it — the
 * doorway should refuse a malformed path, not merely fail to find one. */
function decodeSpacePath(segments: string[]): string | undefined {
  const decoded: string[] = [];
  for (const segment of segments) {
    let value: string;
    try {
      value = decodeURIComponent(segment);
    } catch {
      return undefined;
    }
    if (!value || value === "." || value === ".." || value.includes("/") || value.includes("\\")) return undefined;
    decoded.push(value);
  }
  return decoded.length > 0 ? decoded.join("/") : undefined;
}

/** A run's inputs from its JSON body, `{ "inputs": { … } }`. An empty body is
 * no inputs; anything else malformed is undefined, and refused. */
function parseRunInputs(bytes: Buffer): Record<string, unknown> | undefined {
  const raw = bytes.toString("utf8").trim();
  if (!raw) return {};
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);
  if (!isObject(body)) return undefined;
  if (body.inputs === undefined) return {};
  return isObject(body.inputs) ? body.inputs : undefined;
}

/** Serves one REST request. Returns false when the path matches no route, so
 * the caller can answer 404 once rather than each branch doing it. */
export async function handleRestRequest(
  spaceRoot: string,
  req: IncomingMessage,
  res: ServerResponse,
  authorized: AuthorizedRequest,
  body: Buffer,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const segments = url.pathname.split("/").filter(Boolean);
  const method = req.method ?? "GET";

  if (segments[0] === "space" && segments.length === 1 && method === "GET") {
    const paths = await visiblePaths(spaceRoot);
    send(res, 200, {
      name: path.basename(spaceRoot),
      visibleFiles: paths.length,
      // Stated rather than implied: a caller that knows it is read-only can
      // say so instead of discovering it by being refused.
      access: authorized.canWrite ? "read-write" : "read-only",
      token: authorized.token.label,
    });
    return true;
  }

  if (segments[0] === "search" && segments.length === 1 && method === "GET") {
    const query = url.searchParams.get("q") ?? "";
    if (!query.trim()) {
      send(res, 400, { error: "Pass a query as ?q=" });
      return true;
    }
    send(res, 200, { matches: await searchSpaceFiles(spaceRoot, query) });
    return true;
  }

  // What a note or screenplay links to and what links to it, as the MCP tool
  // gives them.
  if (segments[0] === "links" && method === "GET") {
    const relativePath = decodeSpacePath(segments.slice(1));
    if (relativePath === undefined) {
      send(res, 400, { error: "Malformed path" });
      return true;
    }
    const links = (await isVisible(spaceRoot, relativePath))
      ? await agentReader(spaceRoot).linksOf(relativePath)
      : undefined;
    if (!links) notFound(res, relativePath);
    else send(res, 200, links);
    return true;
  }

  // What this token could run, with each flow's inputs and outputs. Listed
  // for a read-only token too: it describes, it does not run.
  if (segments[0] === "runnable" && segments.length === 1 && method === "GET") {
    send(res, 200, { flows: await runnableFlows(spaceRoot) });
    return true;
  }

  // Pragma's spec, as the MCP tool serves it. An install without one has no
  // such route, just as MCP then offers no such tool.
  if (segments[0] === "spec" && segments.length <= 2 && method === "GET") {
    const spec = await loadProtocolSpec();
    if (!spec) return false;
    if (segments.length === 1) {
      send(res, 200, { sections: sectionAnchors(spec), nodeCategories: spec.nodeCategories });
      return true;
    }
    let name: string;
    try {
      name = decodeURIComponent(segments[1]);
    } catch {
      send(res, 400, { error: "Malformed section" });
      return true;
    }
    const content = spec.read(name);
    if (content === undefined) {
      send(res, 404, {
        error: `No such section: ${name}`,
        sections: sectionAnchors(spec),
        nodeCategories: spec.nodeCategories,
      });
      return true;
    }
    send(res, 200, { section: name, content });
    return true;
  }

  if (segments[0] === "files") {
    if (segments.length === 1 && method === "GET") {
      const files = await visiblePaths(spaceRoot);
      const folder = url.searchParams.get("folder");
      const dir = folder?.replace(/^\/+|\/+$/g, "") ?? "";
      if (dir && !(await isVisibleFolder(spaceRoot, dir))) {
        send(res, 404, { error: `No such folder: ${folder}` });
        return true;
      }
      send(res, 200, { files: files.filter((file) => isWithin(dir, file)) });
      return true;
    }

    // POST <path>/run is the one action on a document. Writes will be PUT, so
    // the method is what keeps this unambiguous on a variable-length path: a
    // document literally named `run` is written at the same URL this runs
    // `a/b` at, and only the verb tells them apart.
    const isRun = method === "POST" && segments.at(-1) === "run";
    const relativePath = decodeSpacePath(segments.slice(1, isRun ? -1 : undefined));

    if (relativePath === undefined) {
      send(res, 400, { error: "Malformed path" });
      return true;
    }

    if (method === "GET") {
      const content = await readVisibleFile(spaceRoot, relativePath);
      if (content === undefined) {
        notFound(res, relativePath);
        return true;
      }
      const section = url.searchParams.get("section");
      if (section === null) {
        send(res, 200, { path: relativePath, content });
        return true;
      }
      // A section is found as the MCP tool finds one, by heading or anchor.
      const outline = isMarkdownFile(relativePath) ? outlineOf(content) : undefined;
      const part = outline && findSection(outline, section);
      if (!outline || !part) {
        const sections = outline?.sections.map((each) => each.title) ?? [];
        send(res, 404, { error: `${relativePath} has no section "${section}".`, sections });
        return true;
      }
      send(res, 200, { path: relativePath, section: part.title, content: sectionText(outline, part) });
      return true;
    }

    if (isRun) {
      // Running is not reading: a flow can spend model budget and, with
      // Write Note or Add Row nodes, change the space.
      if (!authorized.canWrite) {
        send(res, 403, { error: "This token is read-only; running a document is a write." });
        return true;
      }
      if (!(await isVisible(spaceRoot, relativePath))) {
        notFound(res, relativePath);
        return true;
      }
      // The document exists and the action does not apply to it — 400 naming
      // the kind, not a 404 pretending it is absent.
      if (!isFlowFile(relativePath)) {
        send(res, 400, { error: `${relativePath} is not a runnable document.` });
        return true;
      }
      const inputs = parseRunInputs(body);
      if (!inputs) {
        send(res, 400, { error: 'The body must be JSON: { "inputs": { "<nodeId>.<field>": value } }.' });
        return true;
      }
      // A client that disconnects before the answer stops the run with it.
      const caller = new AbortController();
      res.on("close", () => {
        if (!res.writableFinished) caller.abort();
      });
      try {
        // What the flow exposes and what failed, as MCP answers: every node's
        // value would hand over whatever the run read, a private note's text
        // or a library image among them.
        const outcome = await runFlowHeadless(spaceRoot, relativePath, {
          unattended: true,
          inputs,
          signal: caller.signal,
        });
        send(res, 200, { results: outcome.results, errors: outcome.errors });
      } catch (error) {
        if (error instanceof FlowAlreadyRunningError) {
          send(res, 409, { error: error.message });
          return true;
        }
        if (error instanceof UnattendedRunRefusedError) {
          send(res, 403, { error: error.message });
          return true;
        }
        if (error instanceof FlowInputError) {
          send(res, 400, { error: error.message });
          return true;
        }
        send(res, 500, { error: error instanceof Error ? error.message : "The run failed" });
      }
      return true;
    }
  }

  return false;
}
