import { describe, expect, it, vi } from "vitest";
import type { PublisherRow, PublishersResponse } from "../../../src/protocol/api.ts";
import { createPublishers } from "../../../web/services/publishers.ts";

function row(id: string, keySource: PublisherRow["keySource"]): PublisherRow {
  return { id, label: id, kind: "sogma", baseURL: "https://example.test", configured: true, keySource };
}

function response(rows: PublisherRow[]): PublishersResponse {
  return { publishers: rows, store: { kind: "plain-files", encrypted: false, available: true } };
}

describe("publishers", () => {
  it("starts empty and keeps only the publishers with a stored key", async () => {
    const fetch = vi.fn(async () => response([row("a", "stored"), row("b", "none"), row("c", "stored")]));
    const publishers = createPublishers({ fetch });
    expect(publishers.get()).toEqual([]);
    await publishers.refresh();
    expect(publishers.get().map((entry) => entry.id)).toEqual(["a", "c"]);
  });

  it("keeps the last good list when a refresh fails, so New Site doesn't flicker off", async () => {
    const fetch = vi
      .fn<() => Promise<PublishersResponse>>()
      .mockResolvedValueOnce(response([row("a", "stored")]))
      .mockRejectedValueOnce(new Error("offline"));
    const publishers = createPublishers({ fetch });
    await publishers.refresh();
    await expect(publishers.refresh()).resolves.toBeUndefined();
    expect(publishers.get().map((entry) => entry.id)).toEqual(["a"]);
  });

  it("subscribe fires with the current list and again on every refresh", async () => {
    const fetch = vi.fn(async () => response([row("a", "stored")]));
    const publishers = createPublishers({ fetch });
    const seen: number[] = [];
    publishers.subscribe((stored) => seen.push(stored.length));
    await publishers.refresh();
    expect(seen).toEqual([0, 1]);
  });
});
