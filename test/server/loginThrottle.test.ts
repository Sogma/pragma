import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLoginThrottle } from "../../src/server/loginThrottle.ts";

const START = new Date("2026-11-16T12:00:00Z").getTime();
const at = (seconds: number) => vi.setSystemTime(START + seconds * 1000);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  at(0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the login throttle", () => {
  it("lets 5 failed tries through, then doubles the wait from 1 second", () => {
    const throttle = createLoginThrottle();
    for (let i = 0; i < 5; i++) throttle.countFailure("a");
    expect(throttle.secondsToWait("a")).toBe(0);

    throttle.countFailure("a");
    expect(throttle.secondsToWait("a")).toBe(1);
    at(1);
    expect(throttle.secondsToWait("a")).toBe(0);
    throttle.countFailure("a");
    expect(throttle.secondsToWait("a")).toBe(2);
    at(3);
    throttle.countFailure("a");
    expect(throttle.secondsToWait("a")).toBe(4);
  });

  it("never waits longer than 15 minutes", () => {
    const throttle = createLoginThrottle();
    let seconds = 0;
    for (let i = 0; i < 20; i++) {
      at(seconds);
      expect(throttle.secondsToWait("a")).toBe(0);
      throttle.countFailure("a");
      seconds += throttle.secondsToWait("a");
    }
    expect(throttle.secondsToWait("a")).toBe(900);
  });

  it("clears a count after an hour without a failed try", () => {
    const throttle = createLoginThrottle();
    for (let i = 0; i < 6; i++) throttle.countFailure("a");
    at(3599);
    throttle.countFailure("a");
    expect(throttle.secondsToWait("a")).toBe(2);
    at(3599 + 3600);
    throttle.countFailure("a");
    expect(throttle.secondsToWait("a")).toBe(0);
  });

  it("counts each key apart", () => {
    const throttle = createLoginThrottle();
    for (let i = 0; i < 6; i++) throttle.countFailure("a");
    expect(throttle.secondsToWait("a")).toBe(1);
    expect(throttle.secondsToWait("b")).toBe(0);
  });
});
