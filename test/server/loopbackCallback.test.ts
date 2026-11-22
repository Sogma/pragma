import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type CallbackOutcome,
  createLoopbackCallbacks,
  type LoopbackCallbacks,
} from "../../src/server/loopbackCallback.ts";

// The test plays the browser returning from a sign-in, and the sign-in is one
// that notes the code each callback hands it.

interface Entry {
  target: { id: string };
  codes: string[];
}

const created: LoopbackCallbacks<Entry>[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(created.splice(0).map((callbacks) => callbacks.close()));
});

function setup(
  options: { port?: number; anyPortIfTaken?: boolean; answer?: (url: URL) => Promise<CallbackOutcome> } = {},
) {
  const entry: Entry = { target: { id: "t" }, codes: [] };
  const callbacks = createLoopbackCallbacks<Entry>({
    port: options.port ?? 0,
    anyPortIfTaken: options.anyPortIfTaken,
    path: "/callback",
    answer: async (held, url) => {
      held.codes.push(url.searchParams.get("code") ?? "");
      return options.answer ? options.answer(url) : { status: 200, page: "Signed in." };
    },
  });
  created.push(callbacks);
  return { callbacks, entry };
}

// Starts a sign-in that waits on `state`, returning the redirect URI it names.
function pendingAt(callbacks: LoopbackCallbacks<Entry>, entry: Entry, state = "s1"): Promise<URL> {
  return callbacks.starting(entry.target, async () => {
    const uri = new URL(await callbacks.redirectUri());
    callbacks.add(state, entry);
    return uri;
  });
}

// A request to the listener under another host name, as a page whose DNS
// name was rebound to 127.0.0.1 sends it.
function rebound(uri: URL, query: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const sent = request(
      { host: "127.0.0.1", port: uri.port, path: `${uri.pathname}?${query}`, headers: { host: "evil.test" } },
      (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      },
    );
    sent.on("error", reject);
    sent.end();
  });
}

describe("a sign-in's loopback callback", () => {
  it("hands a callback to the sign-in its state names, on a page no cache, link or script reaches", async () => {
    const { callbacks, entry } = setup();
    const uri = await pendingAt(callbacks, entry);
    expect(uri.href).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);

    const landing = await fetch(`${uri.href}?state=s1&code=c1`);
    expect([landing.status, await landing.text()]).toEqual([200, expect.stringContaining("Signed in.")]);
    expect(landing.headers.get("cache-control")).toBe("no-store");
    expect(landing.headers.get("referrer-policy")).toBe("no-referrer");
    expect(landing.headers.get("content-security-policy")).toBe("default-src 'none'; style-src 'unsafe-inline'");
    expect(entry.codes).toEqual(["c1"]);
    expect(callbacks.isPending(entry.target)).toBe(false);
  });

  it("refuses a request under another host name, and a state sent twice, leaving the sign-in pending", async () => {
    const { callbacks, entry } = setup();
    const uri = await pendingAt(callbacks, entry);

    expect(await rebound(uri, "state=s1&code=c1")).toBe(404);
    const twice = await fetch(`${uri.href}?state=s1&state=s1&code=c1`);
    expect([twice.status, await twice.text()]).toEqual([400, expect.stringContaining("expired or was already used")]);
    expect(entry.codes).toEqual([]);
    expect(callbacks.isPending(entry.target)).toBe(true);
  });

  it("keeps a failed callback's message for the sign-in's status, and a throw's as a 502", async () => {
    const declined = setup({ answer: async () => ({ status: 400, page: "Declined.", failure: "It was declined." }) });
    const declinedAt = await pendingAt(declined.callbacks, declined.entry);
    const refusal = await fetch(`${declinedAt.href}?state=s1`);
    expect([refusal.status, await refusal.text()]).toEqual([400, expect.stringContaining("Declined.")]);
    expect(declined.callbacks.failure(declined.entry.target)).toBe("It was declined.");

    const thrown = setup({
      answer: async () => {
        throw new Error("The code was refused.");
      },
    });
    const thrownAt = await pendingAt(thrown.callbacks, thrown.entry);
    const failure = await fetch(`${thrownAt.href}?state=s1&code=c1`);
    expect([failure.status, await failure.text()]).toEqual([502, expect.stringContaining("The code was refused.")]);
    expect(thrown.callbacks.failure(thrown.entry.target)).toBe("The code was refused.");
  });

  it("drops a target's pending sign-in and its failure on a new start or when forgotten", async () => {
    const { callbacks, entry } = setup();
    callbacks.add("s1", entry);
    await callbacks.starting(entry.target, async () => {});
    expect(callbacks.isPending(entry.target)).toBe(false);

    callbacks.add("s2", entry);
    callbacks.fail(entry.target, "It expired.");
    callbacks.forget(entry.target);
    expect([callbacks.isPending(entry.target), callbacks.failure(entry.target)]).toEqual([false, undefined]);
  });

  it("fails a sign-in no callback reaches within ten minutes", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { callbacks, entry } = setup();
    callbacks.add("s1", entry);
    vi.advanceTimersByTime(10 * 60_000 - 1);
    expect(callbacks.isPending(entry.target)).toBe(true);
    vi.advanceTimersByTime(1);
    expect(callbacks.isPending(entry.target)).toBe(false);
    expect(callbacks.failure(entry.target)).toBe("The sign-in timed out. Start it again.");
  });

  // A fixed port keeps one registered redirect across sign-ins, at the cost
  // of one more registration when something else holds it.
  it("listens on any free port when its own is taken, where it may", async () => {
    const holder = createServer();
    await new Promise<void>((resolve) => holder.listen(0, "127.0.0.1", resolve));
    const { port } = holder.address() as AddressInfo;
    try {
      const flexible = setup({ port, anyPortIfTaken: true });
      const uri = await pendingAt(flexible.callbacks, flexible.entry);
      expect(Number(uri.port)).not.toBe(port);

      const fixed = setup({ port });
      await expect(pendingAt(fixed.callbacks, fixed.entry)).rejects.toMatchObject({ code: "EADDRINUSE" });
      expect(fixed.callbacks.isPending(fixed.entry.target)).toBe(false);
    } finally {
      await new Promise<void>((resolve) => holder.close(() => resolve()));
    }
  });
});
