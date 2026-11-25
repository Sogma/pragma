import { describe, expect, it } from "vitest";
import { oneAtATime } from "../../../web/lib/oneAtATime.ts";

// A reload that only ever runs one at a time, yet never misses a call.
describe("oneAtATime", () => {
  it("runs once more after the run in progress, however many calls came while it ran", async () => {
    let runs = 0;
    let finish = () => {};
    const run = oneAtATime(
      () =>
        new Promise<void>((resolve) => {
          runs++;
          finish = resolve;
        }),
    );
    run();
    run();
    run();
    expect(runs).toBe(1);
    finish();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runs).toBe(2);
    finish();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runs).toBe(2);
    run();
    expect(runs).toBe(3);
  });
});
