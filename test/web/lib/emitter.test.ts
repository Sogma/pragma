import { describe, expect, it } from "vitest";
import { Emitter } from "../../../web/lib/emitter.ts";

describe("Emitter", () => {
  it("get() returns the initial value before any set()", () => {
    const emitter = new Emitter(1);
    expect(emitter.get()).toBe(1);
  });

  it("set() updates the value returned by get()", () => {
    const emitter = new Emitter("a");
    emitter.set("b");
    expect(emitter.get()).toBe("b");
  });

  it("subscribe() fires immediately with the current value", () => {
    const emitter = new Emitter(42);
    const seen: number[] = [];
    emitter.subscribe((value) => seen.push(value));
    expect(seen).toEqual([42]);
  });

  it("notifies every subscriber on each subsequent set()", () => {
    const emitter = new Emitter(0);
    const seen: number[] = [];
    emitter.subscribe((value) => seen.push(value));
    emitter.set(1);
    emitter.set(2);
    expect(seen).toEqual([0, 1, 2]);
  });

  it("supports multiple independent subscribers", () => {
    const emitter = new Emitter(0);
    const a: number[] = [];
    const b: number[] = [];
    emitter.subscribe((value) => a.push(value));
    emitter.set(1);
    emitter.subscribe((value) => b.push(value));
    emitter.set(2);
    expect(a).toEqual([0, 1, 2]);
    expect(b).toEqual([1, 2]);
  });

  it("unsubscribe stops further notifications without affecting other subscribers", () => {
    const emitter = new Emitter(0);
    const a: number[] = [];
    const b: number[] = [];
    const unsubscribeA = emitter.subscribe((value) => a.push(value));
    emitter.subscribe((value) => b.push(value));
    emitter.set(1);
    unsubscribeA();
    emitter.set(2);
    expect(a).toEqual([0, 1]);
    expect(b).toEqual([0, 1, 2]);
  });

  it("calling unsubscribe twice is a no-op", () => {
    const emitter = new Emitter(0);
    const unsubscribe = emitter.subscribe(() => {});
    unsubscribe();
    expect(() => unsubscribe()).not.toThrow();
  });
});
