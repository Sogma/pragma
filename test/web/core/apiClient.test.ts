import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setupNeedOf } from "../../../src/protocol/setupNeed.ts";
import {
  ApiError,
  fetchLibraryFolder,
  fetchSiteSettings,
  fetchTree,
  postChat,
  postCreateEntry,
  postDiscoverProviderModels,
  postResetSpaceGrants,
  postSaveProvider,
  postSiteSettings,
  postSwitchSpace,
  sandboxGenerate,
} from "../../../web/core/apiClient.ts";

// This module is meant to stay a pure leaf (fetch + types only), so these
// tests mock global.fetch rather than spinning up a server, exercising
// exactly the logic that lives here: URL/body construction, response.ok
// handling, and the error-shape parsing the server contract tests don't
// cover from this side.
function jsonResponse(body: unknown, init?: { status?: number; ok?: boolean }): Response {
  const status = init?.status ?? 200;
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("fetchTree", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("GETs /api/space/tree and returns the parsed body, with the version it was read at", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify([{ name: "a", path: "a", type: "file" }]), {
        status: 200,
        headers: { "X-Pragma-Changes": "1.4" },
      }),
    );
    const read = await fetchTree();
    expect(fetchMock.mock.calls[0][0]).toBe("/api/space/tree");
    expect(read).toEqual({ tree: [{ name: "a", path: "a", type: "file" }], changes: "1.4" });
  });

  it("throws with the status code when the response isn't ok", async () => {
    fetchMock.mockResolvedValue(new Response("", { status: 500 }));
    await expect(fetchTree()).rejects.toThrow("Failed to load space tree: 500");
  });
});

describe("fetchLibraryFolder", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("asks for one folder's own entries, and returns them with the version they were read at", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify([{ name: "a.png", path: "shots/a.png", type: "file" }]), {
        status: 200,
        headers: { "X-Pragma-Changes": "2.7" },
      }),
    );
    const listing = await fetchLibraryFolder("footage", "shots");
    expect(fetchMock.mock.calls[0][0]).toBe("/api/space/libraries/footage/tree?depth=1&dir=shots");
    expect(listing).toEqual({ entries: [{ name: "a.png", path: "shots/a.png", type: "file" }], changes: "2.7" });
  });
});

describe("postCreateEntry", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("omits the content field entirely when content is undefined", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ path: "notes/x.md", type: "file" }));
    await postCreateEntry("notes", "x.md", "file");
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ parentPath: "notes", name: "x.md", type: "file" });
  });

  it("includes content when provided", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ path: "notes/x.md", type: "file" }));
    await postCreateEntry("notes", "x.md", "file", "hello");
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      parentPath: "notes",
      name: "x.md",
      type: "file",
      content: "hello",
    });
  });

  it("throws the response body text on failure, falling back to the status", async () => {
    fetchMock.mockResolvedValue(new Response("name already taken", { status: 409 }));
    await expect(postCreateEntry("notes", "x.md", "file")).rejects.toThrow("name already taken");
  });
});

describe("site settings", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads a site's settings by path", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ siteName: "My blog", publisherLabel: "Sogma CMS", fields: [], skipped: 0 }),
    );
    const settings = await fetchSiteSettings("sites/blog");
    expect(fetchMock.mock.calls[0][0]).toBe("/api/space/site/settings?path=sites%2Fblog");
    expect(settings.siteName).toBe("My blog");
  });

  it("POSTs only what changed", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ siteName: "Field notes", assetsFolder: "" }));
    const saved = await postSiteSettings("sites/blog", { edits: { "/analytics/ga_id": null }, name: "Field notes" });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/space/site/settings");
    expect(JSON.parse(init.body as string)).toEqual({
      path: "sites/blog",
      edits: { "/analytics/ga_id": null },
      name: "Field notes",
    });
    expect(saved.siteName).toBe("Field notes");
  });

  it("carries the rejected field's pointer off the error body", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ message: "Not a valid GA4 measurement id.", field: "/analytics/ga_id" }, { status: 400 }),
    );
    await expect(postSiteSettings("sites/blog", { edits: { "/analytics/ga_id": "nope" } })).rejects.toMatchObject({
      message: "Not a valid GA4 measurement id.",
      field: "/analytics/ga_id",
    });
  });
});

describe("postChat", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("maps each view kind to its own query param", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ reply: "hi" }));
    await postChat({ view: "folder", path: "projects/x" }, [], "hello");
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe("/api/chat?folderPath=projects%2Fx");
  });

  it("sends a document's selection as its line:column range", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ reply: "hi" }));
    const selection = { startLine: 3, startColumn: 7, endLine: 4, endColumn: 2 };
    await postChat({ view: "document", path: "notes/a b.md", selection }, [], "hello");
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe("/api/chat?path=notes%2Fa%20b.md&selection=3:7-4:2");
  });

  it("sends the node a Flow's canvas has selected, by its id", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ reply: "hi" }));
    await postChat({ view: "flow", path: "a b.flow.html", node: "gen text&1" }, [], "hello");
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe("/api/chat?flowPath=a%20b.flow.html&node=gen%20text%261");
  });

  it("names the other group's tab by the same parameters, prefixed, with no selection", async () => {
    fetchMock.mockImplementation(async () => jsonResponse({ reply: "hi" }));
    const selection = { startLine: 1, startColumn: 1, endLine: 1, endColumn: 4 };
    await postChat(
      { view: "document", path: "a.md", selection },
      [],
      "hello",
      {},
      { view: "flow", path: "b c.flow.html", node: "prompt-1" },
    );
    await postChat({ view: "none" }, [], "hello", {}, { view: "folder", path: "" });
    const urls = fetchMock.mock.calls.map(([url]) => url);
    expect(urls).toEqual([
      "/api/chat?path=a.md&selection=1:1-1:4&besideFlowPath=b%20c.flow.html",
      "/api/chat?besideFolderPath=",
    ]);
  });

  it("names no view parameter when no file is open", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ reply: "hi" }));
    await postChat({ view: "none" }, [], "hello");
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe("/api/chat");
  });

  it("sends the chat model pick alongside the turn", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ reply: "hi" }));
    await postChat({ view: "document", path: "a.md" }, [], "hello", { model: "lm/q" });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ history: [], message: "hello", model: "lm/q" });
  });

  it("keeps the setting a refused turn names, beside its message", async () => {
    const need = { kind: "providerKey", provider: "anthropic" };
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ message: "no key set", need }), { status: 401 }));
    const refused = await postChat({ view: "document", path: "a.md" }, [], "hi").catch((error: unknown) => error);
    expect((refused as Error).message).toBe("no key set");
    expect(setupNeedOf(refused)).toEqual(need);
  });

  it("names no setting for any other failure, nor for a need it doesn't know", async () => {
    fetchMock.mockResolvedValueOnce(new Response("boom", { status: 500 }));
    expect(setupNeedOf(await postChat({ view: "folder", path: "" }, [], "hi").catch((error: unknown) => error))).toBe(
      undefined,
    );
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ message: "?", need: { kind: "providerKey" } }), { status: 400 }),
    );
    expect(setupNeedOf(await postChat({ view: "folder", path: "" }, [], "hi").catch((error: unknown) => error))).toBe(
      undefined,
    );
  });
});

describe("sandboxGenerate", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts the kind, the document path, and the request to /api/sandbox/generate", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ reply: "r", model: "m" })));
    const body = { instruction: "x", values: { a: "1" }, images: {}, model: "anthropic/c" };
    await expect(sandboxGenerate("flow", "tools/rewrite.flow.html", body)).resolves.toEqual({
      reply: "r",
      model: "m",
    });
    expect(fetchMock.mock.calls[0][0]).toBe("/api/sandbox/generate");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      kind: "flow",
      path: "tools/rewrite.flow.html",
      instruction: "x",
      values: { a: "1" },
      images: {},
      model: "anthropic/c",
    });
  });

  it("throws the server's message on failure", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ message: "generation failed" }), { status: 500 }));
    const body = { instruction: "x", values: {}, images: {}, model: undefined };
    await expect(sandboxGenerate("flow", "a.flow.html", body)).rejects.toThrow("generation failed");
  });

  it("keeps a refused generation's setting on the error the call throws", async () => {
    const need = { kind: "defaultModel", output: "text" };
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ message: "No model selected.", need }), { status: 500 }));
    const body = { instruction: "x", values: {}, images: {}, model: undefined };
    const refused = await sandboxGenerate("flow", "a.flow.html", body).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ApiError);
    expect(setupNeedOf(refused)).toEqual(need);
  });

  it("falls back to a generic message when the error body isn't JSON", async () => {
    fetchMock.mockResolvedValue(new Response("plain text failure", { status: 500 }));
    const body = { instruction: "x", values: {}, images: {}, model: undefined };
    await expect(sandboxGenerate("flow", "a.flow.html", body)).rejects.toThrow("plain text failure");
  });

  it("hands the run's signal to the request, so a Stop closes it", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ reply: "r", model: "m" })));
    const stop = new AbortController();
    const body = { instruction: "x", values: {}, images: {}, model: undefined };
    await sandboxGenerate("flow", "a.flow.html", body, stop.signal);
    expect(fetchMock.mock.calls[0][1].signal).toBe(stop.signal);
  });
});

describe("postDiscoverProviderModels", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the discovered models on success", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ textModels: ["a", "b"], imageModels: ["gpt-image-1"] }));
    await expect(postDiscoverProviderModels("openai")).resolves.toEqual({
      textModels: ["a", "b"],
      imageModels: ["gpt-image-1"],
    });
  });

  it("reads a list the answer leaves out as empty", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ textModels: ["a"] }));
    await expect(postDiscoverProviderModels("lmstudio")).resolves.toEqual({ textModels: ["a"], imageModels: [] });
  });

  it("throws the server's message on failure", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ message: "Couldn't reach the provider" }, { status: 502 }));
    await expect(postDiscoverProviderModels("lmstudio")).rejects.toThrow("Couldn't reach the provider");
  });
});

describe("postSaveProvider", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("resolves silently on success", async () => {
    fetchMock.mockResolvedValue(new Response("", { status: 200 }));
    await expect(
      postSaveProvider({ id: "anthropic", kind: "anthropic", label: undefined, baseURL: "" }),
    ).resolves.toBeUndefined();
  });

  it("surfaces an error body that isn't JSON rather than dropping it", async () => {
    fetchMock.mockResolvedValue(new Response("not json", { status: 500 }));
    await expect(
      postSaveProvider({ id: "anthropic", kind: "anthropic", label: undefined, baseURL: "" }),
    ).rejects.toThrow("not json");
  });

  it("falls back to a generic message when the reply carries no body", async () => {
    fetchMock.mockResolvedValue(new Response("", { status: 500 }));
    await expect(
      postSaveProvider({ id: "anthropic", kind: "anthropic", label: undefined, baseURL: "" }),
    ).rejects.toThrow("Couldn't save the provider: 500");
  });
});

// The shared failure reader. Every wrapper routes through it, so what it
// keeps and what it drops is the whole module's error behavior.
describe("request failures", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("surfaces a c.text route's message instead of the status code", async () => {
    fetchMock.mockResolvedValue(new Response("Not a known space", { status: 400 }));
    await expect(postResetSpaceGrants("v1")).rejects.toThrow("Not a known space");
  });

  it("prefers a JSON ErrorBody's message over the raw body", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ message: "Space is busy" }), {
        status: 409,
        headers: { "content-type": "application/json" },
      }),
    );
    await expect(postResetSpaceGrants("v1")).rejects.toThrow("Space is busy");
  });

  it("names the call and the status when the reply carries no message", async () => {
    fetchMock.mockResolvedValue(new Response("", { status: 500 }));
    await expect(postResetSpaceGrants("v1")).rejects.toThrow("Failed to reset approvals: 500");
  });

  it("carries the status and parsed body on the thrown ApiError", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ message: "nope", detail: "x" }), {
        status: 403,
        headers: { "content-type": "application/json" },
      }),
    );
    await expect(postResetSpaceGrants("v1")).rejects.toMatchObject({
      message: "nope",
      status: 403,
      body: { message: "nope", detail: "x" },
    });
  });

  it("parses a JSON body that arrives without the content-type header", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ message: "still read" }), { status: 400 }));
    await expect(postResetSpaceGrants("v1")).rejects.toThrow("still read");
  });

  it("sends a JSON envelope for a call with a body", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    await postSwitchSpace("/spaces/two");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/space/switch");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "content-type": "application/json" });
    expect(JSON.parse(init.body as string)).toEqual({ path: "/spaces/two" });
  });

  it("throws an ApiError by default", async () => {
    fetchMock.mockResolvedValue(new Response("boom", { status: 500 }));
    await expect(postSwitchSpace("/spaces/two")).rejects.toBeInstanceOf(ApiError);
  });
});
