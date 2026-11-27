// What a tree's own drag carries, held for its drop. One per source of
// drags, so a drop takes only what its own tree started. Cleared once the
// drag ends, so one that landed elsewhere is never replayed onto the next
// drop.
export function createDragHold<T>() {
  let dragged: T | undefined;
  document.addEventListener("dragend", () => {
    dragged = undefined;
  });
  return {
    start(item: T): void {
      dragged = item;
    },
    take(): T | undefined {
      const item = dragged;
      dragged = undefined;
      return item;
    },
  };
}
