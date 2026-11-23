import { describe, expect, it, vi } from "vitest";
import type { S3Client, S3Object } from "../../src/server/s3.ts";
import { bucketSharing, checkSharing, SHARED_PREFIX } from "../../src/server/sharing.ts";

// Sharing over a stand-in bucket: what goes in, what comes back as a link,
// and what is deleted when.

function fakeBucket(objects: S3Object[] = []) {
  const stored = new Map<string, { data: Uint8Array; mediaType: string }>();
  const client: S3Client & { deleted: string[] } = {
    deleted: [],
    put: vi.fn(async (key: string, data: Uint8Array, mediaType: string) => {
      stored.set(key, { data, mediaType });
    }),
    link: vi.fn(
      (key: string, expiresSeconds: number) => `https://bucket.example.test/${key}?expires=${expiresSeconds}`,
    ),
    delete: vi.fn(async (key: string) => {
      client.deleted.push(key);
      stored.delete(key);
    }),
    list: vi.fn(async () => objects),
  };
  return { client, stored };
}

const DAY = 24 * 60 * 60 * 1000;

describe("bucketSharing", () => {
  it("puts each file under its own random name, typed, and links it for a day", async () => {
    const { client, stored } = fakeBucket();
    const sharing = bucketSharing(client, { sweepKey: "put" });
    const first = await sharing.share({ mediaType: "image/png", data: new Uint8Array([1]) });
    const second = await sharing.share({ mediaType: "video/mp4", data: new Uint8Array([2]) });
    expect(first.key).toMatch(new RegExp(`^${SHARED_PREFIX}[0-9a-f]{32}\\.png$`));
    expect(second.key).toMatch(/\.mp4$/);
    expect(first.key).not.toBe(second.key);
    expect(stored.get(first.key)?.mediaType).toBe("image/png");
    expect(first.url).toBe(`https://bucket.example.test/${first.key}?expires=86400`);
  });

  it("deletes what it shared, and a failed delete fails nobody", async () => {
    const { client } = fakeBucket();
    vi.mocked(client.delete).mockRejectedValueOnce(new Error("gone"));
    await bucketSharing(client, { sweepKey: "unshare" }).unshare(["a", "b"]);
    expect(client.delete).toHaveBeenCalledTimes(2);
  });

  it("sweeps only its own files whose links expired a day ago, at most every six hours", async () => {
    let now = Date.parse("2026-11-23T12:00:00Z");
    const { client } = fakeBucket([
      { key: `${SHARED_PREFIX}old.png`, lastModified: now - 3 * DAY },
      { key: `${SHARED_PREFIX}new.png`, lastModified: now - DAY },
    ]);
    const sharing = bucketSharing(client, { now: () => now, sweepKey: "sweep" });
    await sharing.share({ mediaType: "image/png", data: new Uint8Array([1]) });
    await vi.waitFor(() => expect(client.deleted).toEqual([`${SHARED_PREFIX}old.png`]));
    now += 60 * 60 * 1000;
    await sharing.share({ mediaType: "image/png", data: new Uint8Array([1]) });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(client.list).toHaveBeenCalledTimes(1);
    expect(client.list).toHaveBeenCalledWith(SHARED_PREFIX);
  });
});

describe("checkSharing", () => {
  it("puts a file, reads it back by its link and deletes it", async () => {
    const { client, stored } = fakeBucket();
    const read = vi.fn(async (url: string | URL | Request) => {
      const key = String(url).replace("https://bucket.example.test/", "").replace(/\?.*$/, "");
      const found = stored.get(key);
      return found ? new Response(found.data as Uint8Array<ArrayBuffer>) : new Response(null, { status: 404 });
    });
    await checkSharing(client, { fetch: read });
    expect(client.put).toHaveBeenCalledTimes(1);
    expect(client.deleted).toHaveLength(1);
    expect(stored.size).toBe(0);
  });

  it("says the bucket refused the file", async () => {
    const { client } = fakeBucket();
    vi.mocked(client.put).mockRejectedValueOnce(new Error("The bucket answered 403: AccessDenied."));
    await expect(checkSharing(client, { fetch: vi.fn() })).rejects.toThrow(
      "Couldn't put a file in the bucket. The bucket answered 403: AccessDenied.",
    );
  });

  it("says the link didn't open the file, and deletes it anyway", async () => {
    const { client } = fakeBucket();
    await expect(
      checkSharing(client, { fetch: vi.fn(async () => new Response(null, { status: 403 })) }),
    ).rejects.toThrow("The file went in, but its link didn't open it. The link answered 403.");
    expect(client.deleted).toHaveLength(1);
  });
});
