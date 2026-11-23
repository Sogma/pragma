import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestServer, type TestServer } from "../support/testServer.ts";

// Settings → Files → Sharing over HTTP, against a stand-in bucket that
// keeps objects in memory and refuses one access key.

interface StandInBucket {
  endpoint: string;
  objects: Map<string, Buffer>;
  requests: string[];
  close(): Promise<void>;
}

async function startStandInBucket(): Promise<StandInBucket> {
  const objects = new Map<string, Buffer>();
  const requests: string[] = [];
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://bucket");
    const signed = request.headers.authorization ?? url.searchParams.get("X-Amz-Credential") ?? "";
    requests.push(`${request.method} ${url.pathname}${url.searchParams.has("X-Amz-Signature") ? " (link)" : ""}`);
    if (!signed || signed.includes("REFUSED")) {
      response.writeHead(403).end("<Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>");
      return;
    }
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      if (request.method === "PUT") {
        objects.set(url.pathname, Buffer.concat(chunks));
        response.writeHead(200).end();
      } else if (request.method === "DELETE") {
        objects.delete(url.pathname);
        response.writeHead(204).end();
      } else if (request.method === "GET" && objects.has(url.pathname)) {
        response.writeHead(200).end(objects.get(url.pathname));
      } else {
        response.writeHead(404).end("<Error><Code>NoSuchKey</Code></Error>");
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    endpoint: `http://127.0.0.1:${port}`,
    objects,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe("API contract: Sharing", () => {
  let testServer: TestServer;
  let bucket: StandInBucket;

  beforeAll(async () => {
    testServer = await startTestServer();
    bucket = await startStandInBucket();
  });

  afterAll(async () => {
    await bucket.close();
    await testServer.close();
  });

  const post = (route: string, body?: Record<string, unknown>) =>
    fetch(`${testServer.baseUrl}${route}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  const sharing = async () => (await (await fetch(`${testServer.baseUrl}/api/sharing`)).json()).sharing;

  it("keeps a bucket only once a file has made the round trip, and never hands back its secret", async () => {
    expect(await sharing()).toBeNull();
    const fields = { endpoint: bucket.endpoint, bucket: "refs", accessKeyId: "AK" };

    const malformed = await post("/api/sharing", { ...fields, endpoint: "ftp://bucket" });
    expect(malformed.status).toBe(400);
    expect((await malformed.json()).message).toBe("Sharing needs an endpoint, an http or https URL.");

    const keyless = await post("/api/sharing", fields);
    expect(keyless.status).toBe(400);
    expect((await keyless.json()).message).toBe("Enter the secret key.");

    const refused = await post("/api/sharing", { ...fields, accessKeyId: "REFUSED", secretAccessKey: "shh" });
    expect(refused.status).toBe(400);
    expect((await refused.json()).message).toBe(
      "Couldn't put a file in the bucket. The bucket answered 403: AccessDenied. Access Denied",
    );
    expect(await sharing()).toBeNull();

    bucket.requests.length = 0;
    expect((await post("/api/sharing", { ...fields, secretAccessKey: "shh" })).status).toBe(204);
    expect(bucket.requests).toEqual([
      expect.stringMatching(/^PUT \/refs\/pragma-shared\/check-[0-9a-f]+\.txt$/),
      expect.stringMatching(/^GET \/refs\/pragma-shared\/check-[0-9a-f]+\.txt \(link\)$/),
      expect.stringMatching(/^DELETE \/refs\/pragma-shared\/check-[0-9a-f]+\.txt$/),
    ]);
    expect(bucket.objects.size).toBe(0);
    const response = await fetch(`${testServer.baseUrl}/api/sharing`);
    const text = await response.text();
    expect(text).not.toContain("shh");
    expect(JSON.parse(text).sharing).toEqual({
      kind: "s3",
      endpoint: bucket.endpoint,
      bucket: "refs",
      region: "",
      accessKeyId: "AK",
      keySource: "stored",
    });
  });

  it("checks the saved setup again, and keeps the saved secret through a save that names none", async () => {
    expect((await post("/api/sharing/check")).status).toBe(204);
    expect(
      (await post("/api/sharing", { endpoint: bucket.endpoint, bucket: "refs", accessKeyId: "AK", region: "auto" }))
        .status,
    ).toBe(204);
    expect((await sharing()).region).toBe("auto");

    const moved = await post("/api/sharing", { endpoint: "http://127.0.0.1:9", bucket: "refs", accessKeyId: "AK" });
    expect(moved.status).toBe(400);
    expect((await moved.json()).message).toBe(
      "This credential was saved for another endpoint. Enter it again for this one.",
    );
  });

  it("removes the setup and its secret", async () => {
    expect((await post("/api/sharing/delete")).status).toBe(204);
    expect(await sharing()).toBeNull();
    const check = await post("/api/sharing/check");
    expect(check.status).toBe(400);
    expect((await check.json()).message).toBe("Sharing isn't set up.");
  });

  it("answers 405 to a method it doesn't take", async () => {
    expect((await fetch(`${testServer.baseUrl}/api/sharing`, { method: "PUT" })).status).toBe(405);
    expect((await fetch(`${testServer.baseUrl}/api/sharing/check`)).status).toBe(405);
    expect((await fetch(`${testServer.baseUrl}/api/sharing/delete`)).status).toBe(405);
  });
});
