import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { SetupError } from "../../src/protocol/setupNeed.ts";
import { EntryListFileError } from "../../src/server/entryListFile.ts";
import { PathAccessError } from "../../src/server/rootedFiles.ts";
import { answerError } from "../../src/server/routes/shared.ts";

// What any route answers for what it throws, as the app's one handler
// answers it, so a route that catches nothing still says which thing to fix.
async function answerFor(thrown: unknown): Promise<{ status: number; json: boolean; body: string }> {
  const app = new Hono();
  app.onError(answerError);
  app.get("/route", () => {
    throw thrown;
  });
  const response = await app.request("/route");
  const json = response.headers.get("content-type")?.startsWith("application/json") ?? false;
  return { status: response.status, json, body: await response.text() };
}

describe("what a route answers for what it throws", () => {
  it("answers a refused path with the status that says which thing to fix", async () => {
    expect(await answerFor(new PathAccessError(403, "This library is read-only"))).toEqual({
      status: 403,
      json: false,
      body: "This library is read-only",
    });
  });

  it("answers a file that isn't there as 404, never with the path the system names", async () => {
    const missing = Object.assign(new Error("ENOENT: no such file or directory, open '/home/x/space/gone.md'"), {
      code: "ENOENT",
    });
    expect(await answerFor(missing)).toEqual({ status: 404, json: false, body: "Not found" });
  });

  it("answers a list file that doesn't parse as 409", async () => {
    expect((await answerFor(new EntryListFileError("_tags.json doesn't parse"))).status).toBe(409);
  });

  it("answers a refusal a setting fixes as JSON carrying what to set", async () => {
    const need = { kind: "providerKey", provider: "anthropic" } as const;
    const answer = await answerFor(new SetupError("No API key for Anthropic", need));
    expect({ ...answer, body: JSON.parse(answer.body) }).toEqual({
      status: 500,
      json: true,
      body: { message: "No API key for Anthropic", need },
    });
  });

  it("answers anything else as 500 with its message", async () => {
    expect(await answerFor(new Error("The disk is full"))).toEqual({
      status: 500,
      json: false,
      body: "The disk is full",
    });
  });
});
