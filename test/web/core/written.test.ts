import { beforeEach, describe, expect, it, vi } from "vitest";

// What the window's requests wrote, told to the views: paths written in one
// go together, and a count a read can hold them by.
let written: typeof import("../../../web/core/written.ts");
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(async () => {
  vi.resetModules();
  written = await import("../../../web/core/written.ts");
});

describe("notifyWritten", () => {
  it("tells listeners the paths written together once, with the count they bring it to", async () => {
    const told: [string[], number][] = [];
    const stop = written.onWritten((paths, through) => told.push([[...paths], through]));
    written.notifyWritten(["a.png"]);
    written.notifyWritten(["lib:refs/b.png", "a.png"]);
    expect(written.writesNotified()).toBe(2);
    await tick();
    expect(told).toEqual([[["a.png", "lib:refs/b.png"], 2]]);

    stop();
    written.notifyWritten(["c.png"]);
    await tick();
    expect(told).toHaveLength(1);
  });

  it("counts nothing, and tells nothing, for a write naming no path", async () => {
    const listener = vi.fn();
    written.onWritten(listener);
    written.notifyWritten([]);
    await tick();
    expect(written.writesNotified()).toBe(0);
    expect(listener).not.toHaveBeenCalled();
  });
});
