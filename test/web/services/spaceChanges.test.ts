// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SpaceChangesResponse } from "../../../src/protocol/api.ts";
import { createSpaceChanges } from "../../../web/services/spaceChanges.ts";

// The server's answers, set per test, and the version the space's tree was
// last read at.
let answer: SpaceChangesResponse;
let readAt: string | undefined;
const fetch = vi.fn(async (_library?: string, _files?: readonly string[]) => answer);

function changes() {
  return createSpaceChanges({ fetch, treeChanges: () => readAt });
}

// Lets the ask in flight settle, then moves the clock one interval on.
async function tick(ms = 3000): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

beforeEach(() => {
  vi.useFakeTimers();
  fetch.mockClear();
  answer = { space: "1.0" };
  readAt = "1.0";
});

afterEach(() => {
  vi.useRealTimers();
});

describe("following the space", () => {
  it("announces a change once, when the space moves past the version its tree was read at", async () => {
    const changed = vi.fn();
    const stop = changes().followSpace(changed);
    await tick(0);
    expect(changed).not.toHaveBeenCalled();

    answer = { space: "1.1" };
    await tick();
    expect(changed).toHaveBeenCalledTimes(1);
    // Still unread: the refresh it caused hasn't landed, and it isn't asked for twice.
    await tick();
    expect(changed).toHaveBeenCalledTimes(1);

    readAt = "1.1";
    answer = { space: "1.2" };
    await tick();
    expect(changed).toHaveBeenCalledTimes(2);
    stop();
  });

  it("says nothing before the tree has been read", async () => {
    readAt = undefined;
    answer = { space: "1.5" };
    const changed = vi.fn();
    const stop = changes().followSpace(changed);
    await tick();
    expect(changed).not.toHaveBeenCalled();
    stop();
  });

  it("stops asking once nothing is followed", async () => {
    const stop = changes().followSpace(vi.fn());
    await tick();
    const asked = fetch.mock.calls.length;
    stop();
    await tick();
    await tick();
    expect(fetch.mock.calls.length).toBe(asked);
  });

  it("asks nothing while the page is hidden, and at once when it shows again", async () => {
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    const changed = vi.fn();
    const stop = changes().followSpace(changed);
    await tick();
    expect(fetch).not.toHaveBeenCalled();

    visibility.mockReturnValue("visible");
    answer = { space: "1.1" };
    document.dispatchEvent(new Event("visibilitychange"));
    await tick(0);
    expect(changed).toHaveBeenCalledTimes(1);
    stop();
    visibility.mockRestore();
  });
});

describe("following a library", () => {
  it("names the library, and tells once when it moves past the version its listings were read at", async () => {
    const changed = vi.fn();
    let listedAt = "4.0";
    answer = { space: "1.0", library: "4.0" };
    const stop = changes().followLibrary("footage", () => listedAt, changed);
    await tick(0);
    expect(fetch).toHaveBeenLastCalledWith("footage", []);
    expect(changed).not.toHaveBeenCalled();

    answer = { space: "1.0", library: "4.1" };
    await tick();
    expect(changed).toHaveBeenCalledTimes(1);
    await tick();
    expect(changed).toHaveBeenCalledTimes(1);

    listedAt = "4.1";
    await tick();
    expect(changed).toHaveBeenCalledTimes(1);
    stop();
  });

  // The race this guards: a library followed mid-interval that waited for
  // the next tick could take a change made meanwhile for its starting point.
  it("asks at once when a library starts being followed, whatever the interval", async () => {
    const following = changes();
    const stopSpace = following.followSpace(vi.fn());
    await tick(1000);
    fetch.mockClear();
    const stop = following.followLibrary("footage", () => "4.0", vi.fn());
    await tick(0);
    expect(fetch).toHaveBeenCalledWith("footage", []);
    stop();
    stopSpace();
  });

  it("runs an ask wanted while one is out as soon as it is back", async () => {
    let release: (value: SpaceChangesResponse) => void = () => {};
    fetch.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));
    const following = changes();
    const stopSpace = following.followSpace(vi.fn());
    const stop = following.followLibrary("footage", () => "4.0", vi.fn());
    expect(fetch).toHaveBeenCalledTimes(1);

    release({ space: "1.0" });
    await tick(0);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenLastCalledWith("footage", []);
    stop();
    stopSpace();
  });
});

describe("following files", () => {
  it("asks about a follower's paths with the trees, and tells it what came back for them", async () => {
    const onRevisions = vi.fn();
    const stop = changes().followFiles({ paths: () => ["a.md", "lib:x/b.md", "c.md"], onRevisions });
    answer = { space: "1.0", files: { "a.md": "r1", "lib:x/b.md": null, "other.md": "r9" } };

    await tick();

    expect(fetch).toHaveBeenLastCalledWith(undefined, ["a.md", "lib:x/b.md", "c.md"]);
    // c.md, which the server said nothing about, is left out; other.md was never asked about.
    expect(onRevisions).toHaveBeenLastCalledWith(
      new Map<string, string | null>([
        ["a.md", "r1"],
        ["lib:x/b.md", null],
      ]),
    );
    stop();
  });

  it("asks about a path two followers share once, and stops asking once neither follows", async () => {
    const following = changes();
    const stopFirst = following.followFiles({ paths: () => ["a.md"], onRevisions: vi.fn() });
    const stopSecond = following.followFiles({ paths: () => ["a.md", "b.md"], onRevisions: vi.fn() });
    await tick();
    expect(fetch).toHaveBeenLastCalledWith(undefined, ["a.md", "b.md"]);

    stopFirst();
    stopSecond();
    const asked = fetch.mock.calls.length;
    await tick();
    expect(fetch.mock.calls.length).toBe(asked);
  });
});
