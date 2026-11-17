import { describe, expect, it, vi } from "vitest";
import { DisposableStore, listen, toDisposable } from "../../../web/lib/disposable.ts";

describe("DisposableStore", () => {
  it("disposes everything added to it, last added first", () => {
    const order: string[] = [];
    const store = new DisposableStore();
    store.add(() => order.push("first"));
    store.add(toDisposable(() => order.push("second")));
    store.add(() => order.push("third"));

    store.dispose();

    expect(order).toEqual(["third", "second", "first"]);
    expect(store.isDisposed).toBe(true);
  });

  it("returns exactly what it was given so adds can be inlined", () => {
    const store = new DisposableStore();
    const child = new DisposableStore();
    const fn = () => {};

    expect(store.add(child)).toBe(child);
    expect(store.add(fn)).toBe(fn);
  });

  it("is idempotent — a second dispose() runs nothing twice", () => {
    const teardown = vi.fn();
    const store = new DisposableStore();
    store.add(teardown);

    store.dispose();
    store.dispose();

    expect(teardown).toHaveBeenCalledTimes(1);
  });

  it("disposes an item added after teardown immediately", () => {
    const late = vi.fn();
    const store = new DisposableStore();
    store.dispose();

    store.add(late);

    expect(late).toHaveBeenCalledTimes(1);
  });

  it("nests — disposing a parent disposes a child store", () => {
    const inner = vi.fn();
    const parent = new DisposableStore();
    const child = parent.add(new DisposableStore());
    child.add(inner);

    parent.dispose();

    expect(inner).toHaveBeenCalledTimes(1);
    expect(child.isDisposed).toBe(true);
  });
});

describe("listen", () => {
  it("adds a listener and removes it on dispose", () => {
    const target = new EventTarget();
    const handler = vi.fn();

    const subscription = listen(target, "ping", handler);
    target.dispatchEvent(new Event("ping"));
    subscription.dispose();
    target.dispatchEvent(new Event("ping"));

    expect(handler).toHaveBeenCalledTimes(1);
  });
});
