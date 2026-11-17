import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createApiToken,
  findApiToken,
  findSpaceId,
  loadGlobalConfig,
  rememberSpace,
  saveGlobalConfig,
} from "../../src/config/loadConfig.ts";
import { capabilityDigest, readFlowFile } from "../../src/protocol/flowFile.ts";
import { serializeFlowFile } from "../../src/protocol/flowHtml.ts";
import { type AgentEndpoint, createAgentEndpoint } from "../../src/server/apiServer.ts";
import { type GrantSubject, grantCapability, setUnattended } from "../../src/server/grants.ts";

// Over real HTTP, like the MCP suite: the point of a second encoding is that a
// caller can reach it with nothing but an HTTP client, so the test uses one.
let configDir: string;
let space: string;
let endpoint: AgentEndpoint | undefined;
let base: string;
let readOnlyToken: string;
let writeToken: string;
let flowSubject: GrantSubject;

async function call(
  route: string,
  options: { token?: string; method?: string; body?: string } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${base}${route}`, {
    method: options.method ?? "GET",
    headers: { authorization: `Bearer ${options.token ?? readOnlyToken}` },
    body: options.body,
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

function mint(readOnly: boolean): string {
  const config = loadGlobalConfig();
  const { secret, record } = createApiToken({
    label: readOnly ? "reader" : "writer",
    spaceId: findSpaceId(config, space) as string,
    access: readOnly ? "read-only" : "read-write",
  });
  saveGlobalConfig({ ...config, apiTokens: [...(config.apiTokens ?? []), record] });
  return secret;
}

// A flow whose model endpoint never answers, so a run is reliably in flight.
// Returns whether the model request has been closed.
async function hungFlow(file: string): Promise<{ closed: () => boolean; seen: () => boolean; stop: () => void }> {
  let seen = false;
  let closed = false;
  const hung = createServer((req) => {
    seen = true;
    req.on("close", () => (closed = true));
  });
  await new Promise<void>((resolve) => hung.listen(0, "127.0.0.1", resolve));
  const port = (hung.address() as { port: number }).port;
  saveGlobalConfig({
    ...loadGlobalConfig(),
    modelProviders: [{ id: "hung", kind: "openai", baseURL: `http://127.0.0.1:${port}/v1`, textModels: ["m"] }],
  });
  writeFileSync(
    path.join(space, file),
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
  const flow = await readFlowFile(path.join(space, file));
  const subject = { path: file, contentHash: capabilityDigest(flow.graph) };
  await grantCapability(space, subject, "generateText");
  await setUnattended(space, subject, true);
  return {
    closed: () => closed,
    seen: () => seen,
    stop: () => {
      hung.closeAllConnections();
      hung.close();
    },
  };
}

beforeEach(async () => {
  configDir = mkdtempSync(path.join(tmpdir(), "pragma-rest-config-"));
  process.env.PRAGMA_CONFIG_DIR = configDir;
  space = mkdtempSync(path.join(tmpdir(), "pragma-rest-space-"));

  writeFileSync(path.join(space, "hello.md"), "# Hello\n\nthe secret word is banana\n");
  writeFileSync(path.join(space, "secret.md"), "---\nvisibility: private\n---\nthe private word is durian\n");
  // Kept private: a block that doesn't parse can't show it isn't.
  writeFileSync(path.join(space, "broken.md"), "---\ntitle: Chapter 1: The Start\n---\nthe broken word is kumquat\n");
  mkdirSync(path.join(space, ".pragma"), { recursive: true });
  writeFileSync(path.join(space, ".pragma", "grants.json"), '{"peek":true}');
  writeFileSync(path.join(space, "note.md"), "the note body");
  writeFileSync(
    path.join(space, "run.flow.html"),
    serializeFlowFile({
      version: "1.0",
      name: "Run",
      graph: {
        nodes: [
          {
            id: "load-1",
            type: "loadNote",
            position: { x: 0, y: 0 },
            config: { notePath: "note.md" },
            exposed: ["raw"],
          },
        ],
        edges: [],
      },
    }),
  );

  saveGlobalConfig({ ...rememberSpace(loadGlobalConfig(), space), api: { enabled: true, port: 0 } });
  readOnlyToken = mint(true);
  writeToken = mint(false);
  const flowDigest = capabilityDigest((await readFlowFile(path.join(space, "run.flow.html"))).graph);
  flowSubject = { path: "run.flow.html", contentHash: flowDigest };
  await grantCapability(space, flowSubject, "readFile:space:note.md");

  endpoint = createAgentEndpoint(() => space);
  await endpoint.apply();
  base = `http://127.0.0.1:${endpoint.port()}`;
});

afterEach(async () => {
  await endpoint?.close();
  delete process.env.PRAGMA_CONFIG_DIR;
  rmSync(configDir, { recursive: true, force: true });
  rmSync(space, { recursive: true, force: true });
});

describe("the REST surface", () => {
  it("describes the space and the token's access", async () => {
    const { status, body } = await call("/space");
    expect(status).toBe(200);
    expect(body).toMatchObject({ visibleFiles: 3, access: "read-only", token: "reader" });
  });

  it("lists and searches only what is visible", async () => {
    expect((await call("/files")).body.files).toEqual(["hello.md", "note.md", "run.flow.html"]);
    expect((await call("/search?q=banana")).body.matches).toHaveLength(1);
    expect((await call("/search?q=durian")).body.matches).toEqual([]);
    expect((await call("/search?q=kumquat")).body.matches).toEqual([]);
    expect((await call("/search")).status).toBe(400);
  });

  it("serves Pragma's spec a section at a time", async () => {
    const listing = (await call("/spec")).body;
    expect(listing.sections).toEqual(expect.arrayContaining(["tables", "flows"]));
    expect(listing.nodeCategories).toEqual(expect.arrayContaining(["text", "ai"]));
    const { status, body } = await call("/spec/templateVariables");
    expect(status).toBe(200);
    expect(body.content).toMatch(/^### `templateVariables`/);
    expect((await call("/spec/nope")).status).toBe(404);
  });

  it("reads a visible document", async () => {
    const { status, body } = await call("/files/hello.md");
    expect(status).toBe(200);
    expect(body.content).toContain("the secret word is banana");
  });

  it("reads a note a section at a time, naming its headings when none matches", async () => {
    writeFileSync(path.join(space, "look.md"), "# Look\n\n## Light\n\nWarm.\n\n## Camera\n\nWide.\n");
    expect((await call("/files/look.md?section=camera")).body).toEqual({
      path: "look.md",
      section: "Camera",
      content: "## Camera\n\nWide.",
    });
    const missing = await call("/files/look.md?section=Sound");
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ error: 'look.md has no section "Sound".', sections: ["Light", "Camera"] });
    expect((await call("/files/secret.md?section=x")).status).toBe(404);
  });

  it("gives what a note links to and what links to it, among what it lists", async () => {
    writeFileSync(path.join(space, "look.md"), "[Hello](hello.md) and [the secret](secret.md)\n");
    expect((await call("/links/look.md")).body).toEqual({ path: "look.md", linksTo: ["hello.md"], linkedFrom: [] });
    expect((await call("/links/hello.md")).body).toEqual({ path: "hello.md", linksTo: [], linkedFrom: ["look.md"] });
    for (const target of ["secret.md", "nope.md", ".pragma/grants.json"]) {
      expect((await call(`/links/${target}`)).status).toBe(404);
    }
  });

  it("lists one folder's files, and no folder it would not list", async () => {
    mkdirSync(path.join(space, "cast"));
    writeFileSync(path.join(space, "cast", "lina.md"), "# Lina\n");
    expect((await call("/files?folder=cast")).body.files).toEqual(["cast/lina.md"]);
    expect((await call("/files?folder=.pragma")).status).toBe(404);
    expect((await call("/files?folder=nope")).status).toBe(404);
  });

  // Unlistable means unreadable, and a private document must not be
  // distinguishable from an absent one — the refusal itself would confirm it.
  it("refuses what it would not list, identically", async () => {
    for (const target of ["secret.md", "broken.md", ".pragma/grants.json", "nope.md"]) {
      const { status, body } = await call(`/files/${target}`);
      expect(status).toBe(404);
      expect(body.error).toMatch(/No such file/);
    }
  });

  // The known escape for this class of endpoint: a percent-encoded separator
  // decoded into a whole path.
  it("rejects a malformed or traversing path before resolving it", async () => {
    for (const target of ["..%2F..%2Fetc%2Fpasswd", "%2Fetc%2Fpasswd", "../../etc/passwd"]) {
      const { status } = await call(`/files/${target}`);
      expect([400, 404]).toContain(status);
    }
  });

  it("runs a flow and returns its declared results", async () => {
    await setUnattended(space, flowSubject, true);
    const { status, body } = await call("/files/run.flow.html/run", { method: "POST", token: writeToken });
    expect(status).toBe(200);
    expect(body.results).toEqual([
      { nodeId: "load-1", nodeType: "loadNote", port: "raw", value: { type: "text", value: "the note body" } },
    ]);
  });

  it("lists the flows allowed to run unattended, to any token", async () => {
    expect((await call("/runnable")).body.flows).toEqual([]);
    await setUnattended(space, flowSubject, true);
    expect((await call("/runnable")).body.flows).toEqual([
      {
        path: "run.flow.html",
        name: "Run",
        description: "",
        inputs: [],
        outputs: [{ name: "load-1.raw", label: "Load Note · raw" }],
      },
    ]);
  });

  it("refuses inputs the flow does not take, and a body that is not the run shape", async () => {
    await setUnattended(space, flowSubject, true);
    const run = (body: string) => call("/files/run.flow.html/run", { method: "POST", token: writeToken, body });

    const unknown = await run(JSON.stringify({ inputs: { "load-1.notePath": "hello.md" } }));
    expect(unknown.status).toBe(400);
    expect(unknown.body.error).toMatch(/takes no input "load-1\.notePath"\. It exposes no inputs/);

    for (const malformed of ["{not json", "[]", JSON.stringify({ inputs: ["x"] })]) {
      expect((await run(malformed)).status).toBe(400);
    }
    expect((await run(JSON.stringify({}))).status).toBe(200);
  });

  // Capability grants say what a run may touch, not that it may start with
  // nobody watching; that is its own grant.
  it("refuses to run a flow never allowed to run unattended", async () => {
    const { status, body } = await call("/files/run.flow.html/run", { method: "POST", token: writeToken });
    expect(status).toBe(403);
    expect(body.error).toMatch(/not allowed to run unattended/);
  });

  // Running can spend model budget and, with Write Note or Add Row nodes, change the space.
  it("refuses to run for a read-only token", async () => {
    const { status, body } = await call("/files/run.flow.html/run", { method: "POST" });
    expect(status).toBe(403);
    expect(body.error).toMatch(/read-only/);
  });

  it("refuses to run a document that is not runnable", async () => {
    const { status, body } = await call("/files/hello.md/run", { method: "POST", token: writeToken });
    expect(status).toBe(400);
    expect(body.error).toMatch(/not a runnable document/);
  });

  it("answers 404 on an unknown route and 401 without a token", async () => {
    expect((await call("/nope")).status).toBe(404);
    expect((await fetch(`${base}/files`)).status).toBe(401);
  });

  // Read by the listener before either encoding sees it, so one cap holds for both.
  it("refuses a body over 4 MiB, on REST and MCP alike", async () => {
    const body = "x".repeat(4 * 1024 * 1024 + 1);
    for (const route of ["/files/run.flow.html/run", "/mcp"]) {
      const res = await call(route, { method: "POST", token: writeToken, body });
      expect(res.status).toBe(413);
      expect(res.body.error).toBe("Request body over 4 MiB");
    }
  });

  // One run at a time per flow, and a client that disconnects takes its run
  // with it, model call included.
  it("refuses a second run of a busy flow, and stops one whose client leaves", async () => {
    const model = await hungFlow("hang.flow.html");
    const leaving = new AbortController();
    const first = fetch(`${base}/files/hang.flow.html/run`, {
      method: "POST",
      headers: { authorization: `Bearer ${writeToken}` },
      signal: leaving.signal,
    }).catch(() => undefined);
    await vi.waitFor(() => expect(model.seen()).toBe(true));

    const second = await call("/files/hang.flow.html/run", { method: "POST", token: writeToken });
    expect(second.status).toBe(409);
    expect(second.body.error).toMatch(/already running/);

    leaving.abort();
    await first;
    await vi.waitFor(() => expect(model.closed()).toBe(true));
    model.stop();
  });
});

// A request whose headers go now and whose body goes only when told, as a
// client holding a request open sends it. `status` settles with the answer,
// or fails when the connection is ended without one.
function heldOpen(token: string, port = endpoint?.port()): { send: () => Promise<number>; status: Promise<number> } {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  const req = request({
    host: "127.0.0.1",
    port,
    path: "/mcp",
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "content-length": Buffer.byteLength(body),
    },
  });
  const status = new Promise<number>((resolve, reject) => {
    req.on("response", (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
  });
  req.flushHeaders();
  return {
    status,
    send: () => {
      req.end(body);
      return status;
    },
  };
}

// Long enough for the listener to have taken the headers and made its first
// check, which happens before it waits for the body.
const headersTaken = () => new Promise((resolve) => setTimeout(resolve, 150));

const tokenId = (secret: string) => findApiToken(loadGlobalConfig(), secret)?.id as string;

describe("a request held open", () => {
  it("is refused when its token is revoked while its body arrives", async () => {
    const pending = heldOpen(readOnlyToken);
    await headersTaken();
    const config = loadGlobalConfig();
    const revoked = tokenId(readOnlyToken);
    saveGlobalConfig({ ...config, apiTokens: config.apiTokens?.filter((token) => token.id !== revoked) });
    expect(await pending.send()).toBe(401);
  });

  it("is refused when the served space switches while its body arrives", async () => {
    const other = mkdtempSync(path.join(tmpdir(), "pragma-rest-other-"));
    saveGlobalConfig(rememberSpace(loadGlobalConfig(), other));
    let served = space;
    await endpoint?.close();
    endpoint = createAgentEndpoint(() => served);
    await endpoint.apply();
    const pending = heldOpen(readOnlyToken, endpoint.port());
    await headersTaken();
    served = other;
    expect(await pending.send()).toBe(403);
    rmSync(other, { recursive: true, force: true });
  });

  it("ends when the endpoint is switched off, without waiting for its client", async () => {
    const pending = heldOpen(readOnlyToken);
    await headersTaken();
    const started = Date.now();
    await endpoint?.close();
    endpoint = undefined;
    expect(Date.now() - started).toBeLessThan(2000);
    await expect(pending.status).rejects.toThrow();
  });

  it("ends, run and model call included, when its token is revoked", async () => {
    const model = await hungFlow("hang.flow.html");
    const running = fetch(`${base}/files/hang.flow.html/run`, {
      method: "POST",
      headers: { authorization: `Bearer ${writeToken}` },
    });
    await vi.waitFor(() => expect(model.seen()).toBe(true));
    endpoint?.dropToken(tokenId(writeToken));
    await expect(running).rejects.toThrow();
    await vi.waitFor(() => expect(model.closed()).toBe(true));
    model.stop();
  });
});
