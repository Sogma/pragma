import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { fetchPublic, fetchPublicToFile, isPrivateAddress } from "../../src/server/fetchPublic.ts";

// The guard a result download goes through. Name resolution and the fetch are
// stand-ins, so no test touches the network.

const publicName = async () => ["203.0.113.7"];

function respond(body: BodyInit | null, init: ResponseInit = {}): typeof fetch {
  return async () => new Response(body, init);
}

describe("isPrivateAddress", () => {
  it("covers loopback, private, link-local and mapped addresses", () => {
    for (const address of [
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "192.168.1.1",
      "169.254.1.1",
      "100.64.0.1",
      "0.0.0.0",
    ]) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
    for (const address of ["::1", "::", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:7f00:1"]) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
    expect(isPrivateAddress("203.0.113.7")).toBe(false);
    expect(isPrivateAddress("2606:4700::1")).toBe(false);
  });
});

describe("fetchPublic", () => {
  it("downloads over https, with the file's media type", async () => {
    const file = await fetchPublic("https://cdn.example/result.png", {
      maxBytes: 100,
      resolve: publicName,
      fetchFn: respond(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png; charset=binary" } }),
    });
    expect(file).toEqual({ bytes: new Uint8Array([1, 2, 3]), mediaType: "image/png" });
  });

  it("refuses plain http", async () => {
    await expect(
      fetchPublic("http://cdn.example/result.png", { maxBytes: 100, resolve: publicName, fetchFn: respond("x") }),
    ).rejects.toThrow(/only https/);
  });

  it("refuses an address, or a name, that points somewhere private", async () => {
    for (const url of ["https://127.0.0.1/x", "https://[::1]/x", "https://[::ffff:127.0.0.1]/x"]) {
      await expect(fetchPublic(url, { maxBytes: 100, fetchFn: respond("x") }), url).rejects.toThrow(/private address/);
    }
    await expect(
      fetchPublic("https://intranet.example/x", {
        maxBytes: 100,
        resolve: async () => ["10.0.0.5"],
        fetchFn: respond("x"),
      }),
    ).rejects.toThrow(/private address/);
  });

  it("checks every redirect the same way", async () => {
    const redirect = respond(null, { status: 302, headers: { location: "https://localhost/secret" } });
    await expect(
      fetchPublic("https://cdn.example/x", {
        maxBytes: 100,
        resolve: async (host) => (host === "localhost" ? ["127.0.0.1"] : ["203.0.113.7"]),
        fetchFn: redirect,
      }),
    ).rejects.toThrow(/private address/);
  });

  it("stops at the size cap, declared or not", async () => {
    const big = new Uint8Array(200);
    await expect(
      fetchPublic("https://cdn.example/x", {
        maxBytes: 100,
        resolve: publicName,
        fetchFn: respond(big, { headers: { "content-length": "200" } }),
      }),
    ).rejects.toThrow(/over the 100-byte limit/);
    const undeclared = new ReadableStream({
      start(controller) {
        controller.enqueue(big);
        controller.close();
      },
    });
    await expect(
      fetchPublic("https://cdn.example/x", { maxBytes: 100, resolve: publicName, fetchFn: respond(undeclared) }),
    ).rejects.toThrow(/over the 100-byte limit/);
  });
});

describe("fetchPublicToFile", () => {
  it("writes the bytes into the file named for the answer's type, under the same guard and cap", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "pragma-fetch-public-"));
    try {
      const written = await fetchPublicToFile(
        "https://cdn.example/clip",
        {
          maxBytes: 100,
          resolve: publicName,
          fetchFn: respond(new Uint8Array([1, 2, 3]), { headers: { "content-type": "video/mp4" } }),
        },
        (mediaType) => path.join(dir, mediaType === "video/mp4" ? "clip.mp4" : "clip.bin"),
      );
      expect(written).toBe(path.join(dir, "clip.mp4"));
      expect([...readFileSync(written)]).toEqual([1, 2, 3]);

      // Past the cap partway, nothing is left behind, not even the temp file.
      await expect(
        fetchPublicToFile(
          "https://cdn.example/big",
          { maxBytes: 100, resolve: publicName, fetchFn: respond(new Uint8Array(200)) },
          () => path.join(dir, "big.mp4"),
        ),
      ).rejects.toThrow(/over the 100-byte limit/);
      expect(existsSync(path.join(dir, "big.mp4"))).toBe(false);
      expect(readdirSync(dir)).toEqual(["clip.mp4"]);
      await expect(
        fetchPublicToFile("http://cdn.example/clip", { maxBytes: 100, resolve: publicName }, () => path.join(dir, "x")),
      ).rejects.toThrow(/only https/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
