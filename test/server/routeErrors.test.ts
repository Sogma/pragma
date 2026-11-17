import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { SetupError } from "../../src/protocol/setupNeed.ts";
import { sendDispatchError, sendTextError } from "../../src/server/routes/shared.ts";

// The routes' two error shapes, which carry a refusal's need to the client
// so it can link to the setting that fixes it.
const need = { kind: "defaultModel", output: "image" } as const;
const app = new Hono()
  .get("/text/setup", (c) => sendTextError(c, new SetupError("No image model.", need)))
  .get("/text/other", (c) => sendTextError(c, new Error("boom")))
  .get("/dispatch/setup", (c) => sendDispatchError(c, new SetupError("No model selected.", need)))
  .get("/dispatch/other", (c) => sendDispatchError(c, new Error("No text came back.")));

describe("the routes' error shapes", () => {
  it("answer a refusal a setting fixes as JSON naming its need, even where errors are plain text", async () => {
    expect(await (await app.request("/text/setup")).json()).toEqual({ message: "No image model.", need });
    expect(await (await app.request("/text/other")).text()).toBe("boom");
  });

  it("put the need beside a generation's message", async () => {
    expect(await (await app.request("/dispatch/setup")).json()).toEqual({ message: "No model selected.", need });
    expect(await (await app.request("/dispatch/other")).json()).toEqual({ message: "No text came back." });
  });
});
