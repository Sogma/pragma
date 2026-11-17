import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { listeningPort } from "../../src/server/listeningPort.ts";

const open: Server[] = [];

afterEach(async () => {
  await Promise.all(open.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

function listen(port: number, host = "127.0.0.1"): { server: Server; port: Promise<number> } {
  const server = createServer();
  open.push(server);
  server.listen(port, host);
  return { server, port: listeningPort(server, host) };
}

describe("listeningPort", () => {
  it("resolves with the port asked for when it is free", async () => {
    const probe = listen(0);
    const free = await probe.port;
    await new Promise((resolve) => probe.server.close(resolve));

    expect(await listen(free).port).toBe(free);
  });

  it("falls back to a free port when the one asked for is taken", async () => {
    const taken = await listen(0).port;

    const port = await listen(taken).port;

    expect(port).toBeGreaterThan(0);
    expect(port).not.toBe(taken);
  });

  it("rejects when the free port fails too", async () => {
    // A documentation address (RFC 5737): no interface here has it, so every
    // port fails to bind.
    await expect(listen(0, "192.0.2.1").port).rejects.toThrow();
  });
});
