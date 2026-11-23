import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { createLocalChangeFeeds } from "../../src/server/changeFeeds.ts";
import { tempDir } from "../support/isolation.ts";

// Real folders and real timers: what is under test is whether a change on
// disk reaches the version, by either of the two ways it can.
let root: string;

beforeEach(async () => {
  root = tempDir("pragma-changes-");
  await mkdir(path.join(root, "notes"));
});

async function changesFrom(read: () => string, from: string, within = 3000): Promise<boolean> {
  const deadline = Date.now() + within;
  while (Date.now() < deadline) {
    if (read() !== from) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

describe.each([
  ["watched", { poll: false }],
  ["polled", { poll: true, pollMs: 50 }],
])("a %s tree", (_name, options) => {
  it("keeps its version while nothing changes", async () => {
    const feeds = createLocalChangeFeeds(options);
    const first = feeds.version(root);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(feeds.version(root)).toBe(first);
  });

  it("moves its version when an entry is added in a nested folder", async () => {
    const feeds = createLocalChangeFeeds(options);
    const first = feeds.version(root);
    // Let the watch or the first reading settle before the change.
    await new Promise((resolve) => setTimeout(resolve, 200));
    await writeFile(path.join(root, "notes", "new.md"), "", "utf8");
    expect(await changesFrom(() => feeds.version(root), first)).toBe(true);
  });

  it("ignores what changes under a dot folder", async () => {
    await mkdir(path.join(root, ".git"));
    const feeds = createLocalChangeFeeds(options);
    const first = feeds.version(root);
    await new Promise((resolve) => setTimeout(resolve, 200));
    await writeFile(path.join(root, ".git", "index"), "x", "utf8");
    expect(await changesFrom(() => feeds.version(root), first, 400)).toBe(false);
  });
});

describe("a tree nobody asks about", () => {
  it("is let go, and the next version it is asked for reads as a change", async () => {
    const feeds = createLocalChangeFeeds({ idleMs: 50 });
    const first = feeds.version(root);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(feeds.version(root)).not.toBe(first);
  });
});
