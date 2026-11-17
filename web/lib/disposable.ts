// Explicit widget lifecycle. A factory that wires listeners, subscriptions,
// or child widgets adds each to a DisposableStore and returns (or accepts)
// the store; disposing it tears everything down in one call, so a pane or
// group can be created and destroyed repeatedly without leaking. Prefer it to
// a bare unsubscribe function, which nothing forces a caller to keep.

export interface Disposable {
  dispose(): void;
}

export function toDisposable(fn: () => void): Disposable {
  return { dispose: fn };
}

export class DisposableStore implements Disposable {
  #items: Disposable[] = [];
  #disposed = false;

  get isDisposed(): boolean {
    return this.#disposed;
  }

  // Accepts a Disposable or a bare teardown function, and hands back exactly
  // what it was given so a call can be inlined:
  //   const child = store.add(createChild(...));
  //
  // Adding to an already-disposed store disposes the item immediately rather
  // than holding it forever — a late subscription after teardown must not
  // outlive the widget.
  add<T extends Disposable | (() => void)>(item: T): T {
    const disposable: Disposable = typeof item === "function" ? toDisposable(item as () => void) : (item as Disposable);
    if (this.#disposed) {
      disposable.dispose();
      return item;
    }
    this.#items.push(disposable);
    return item;
  }

  // Last added, first disposed: a later item may depend on an earlier one
  // (a listener on an element a previous item created), so unwinding in
  // reverse is the order that never touches something already gone.
  // Idempotent — a second dispose() is a no-op.
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    const items = this.#items.splice(0).reverse();
    for (const item of items) item.dispose();
  }
}

// addEventListener whose removal is a Disposable, so a listener can go
// straight into a store: `store.add(listen(button, "click", onClick))`.
export function listen(
  target: EventTarget,
  type: string,
  handler: EventListenerOrEventListenerObject,
  options?: AddEventListenerOptions | boolean,
): Disposable {
  target.addEventListener(type, handler, options);
  return toDisposable(() => target.removeEventListener(type, handler, options));
}
