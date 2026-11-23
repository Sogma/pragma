import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { BucketError, presignUrl, regionOf, s3Client, signRequest } from "../../src/server/s3.ts";

// The signer was checked against the worked examples in the Signature
// Version 4 docs; these pin what it signs for a bucket reached by path.

const credentials = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret/EXAMPLE+key", region: "auto" };
const now = new Date("2026-11-23T12:00:00Z");
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

describe("signRequest", () => {
  it("signs the host, the date, the payload's hash and the headers it is given", () => {
    const headers = signRequest({
      method: "PUT",
      url: new URL("https://storage.example.test/refs/pragma-shared/a%20b.png"),
      headers: { "content-type": "image/png" },
      payloadHash: sha256("hello"),
      credentials,
      now,
    });
    expect(headers).toEqual({
      "content-type": "image/png",
      "x-amz-content-sha256": sha256("hello"),
      "x-amz-date": "20261123T120000Z",
      authorization:
        "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20261123/auto/s3/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=d5a67a0dd81644511d73e62b95567a2881754ee87cf3df4f41dc1bb4ddf06860",
    });
  });
});

describe("presignUrl", () => {
  it("reads one object with no credentials, its key encoded once", () => {
    expect(
      presignUrl({
        url: new URL("https://storage.example.test/refs/pragma-shared/a%20b.png"),
        credentials,
        now,
        expiresSeconds: 86400,
      }),
    ).toBe(
      "https://storage.example.test/refs/pragma-shared/a%20b.png?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIDEXAMPLE%2F20261123%2Fauto%2Fs3%2Faws4_request&X-Amz-Date=20261123T120000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host&X-Amz-Signature=6500fcc00952ab5bf52e9cf2c8cfe52828355956cfa5051d0be5af9d629985f6",
    );
  });
});

describe("regionOf", () => {
  it("takes a region given outright over the endpoint's", () => {
    expect(regionOf("https://s3.eu-central-2.example.com", "auto")).toBe("auto");
  });

  it("reads the region from an endpoint named s3.<region>.<domain>", () => {
    expect(regionOf("https://s3.us-west-004.example.com")).toBe("us-west-004");
    expect(regionOf("https://s3-eu-west-1.example.com")).toBe("eu-west-1");
  });

  it("signs for us-east-1 where the endpoint names no region", () => {
    expect(regionOf("https://0123abcd.storage.example.test")).toBe("us-east-1");
    expect(regionOf("https://s3.example.com")).toBe("us-east-1");
    expect(regionOf("http://localhost:9000")).toBe("us-east-1");
  });
});

describe("s3Client", () => {
  const bucket = { ...credentials, endpoint: "https://storage.example.test/", bucket: "refs" };

  it("puts an object by path, typed and signed", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 200 }));
    await s3Client(bucket, { fetch, now: () => now }).put(
      "pragma-shared/x.png",
      new TextEncoder().encode("hello"),
      "image/png",
    );
    const [url, init] = fetch.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toBe("https://storage.example.test/refs/pragma-shared/x.png");
    expect(init.method).toBe("PUT");
    const headers = init.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("image/png");
    expect(headers.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20261123\/auto\/s3\/aws4_request, /,
    );
  });

  it("lists the objects under a prefix, with when each was last changed", async () => {
    const xml = `<?xml version="1.0"?><ListBucketResult>
      <Contents><Key>pragma-shared/a.png</Key><LastModified>2026-11-20T10:00:00.000Z</LastModified></Contents>
      <Contents><Key>pragma-shared/b&amp;c.mp4</Key><LastModified>2026-11-23T10:00:00.000Z</LastModified></Contents>
    </ListBucketResult>`;
    const fetch = vi.fn(async () => new Response(xml, { status: 200 }));
    const objects = await s3Client(bucket, { fetch, now: () => now }).list("pragma-shared/");
    expect(objects).toEqual([
      { key: "pragma-shared/a.png", lastModified: Date.parse("2026-11-20T10:00:00.000Z") },
      { key: "pragma-shared/b&c.mp4", lastModified: Date.parse("2026-11-23T10:00:00.000Z") },
    ]);
    const [url] = fetch.mock.calls[0] as unknown as [URL];
    expect(String(url)).toBe("https://storage.example.test/refs?list-type=2&prefix=pragma-shared%2F");
  });

  it("says why a bucket refused, in its own words", async () => {
    const body = "<Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>";
    const fetch = vi.fn(async () => new Response(body, { status: 403 }));
    const refused = s3Client(bucket, { fetch, now: () => now }).delete("pragma-shared/x.png");
    await expect(refused).rejects.toBeInstanceOf(BucketError);
    await expect(refused).rejects.toThrow("The bucket answered 403: AccessDenied. Access Denied");
  });
});
