// A minimal state-holder + pub/sub primitive shared by services, so none
// re-derives the same get/subscribe/set trio. Deliberately dumb: no equality
// check on set, no batching, no async — a service layers that policy on top
// if it needs it.
export class Emitter<T> {
  #value: T;
  #listeners = new Set<(value: T) => void>();

  constructor(initial: T) {
    this.#value = initial;
  }

  get(): T {
    return this.#value;
  }

  set(next: T): void {
    this.#value = next;
    for (const listener of this.#listeners) listener(next);
  }

  // Fires immediately with the current value, then on every subsequent
  // set(). Returns an unsubscribe function.
  subscribe(listener: (value: T) => void): () => void {
    this.#listeners.add(listener);
    listener(this.#value);
    return () => this.#listeners.delete(listener);
  }
}
