import { noteDragInFlight } from "../../../web/core/paths.ts";

// jsdom has no DataTransfer, so a drag is faked as a browser fires one: what
// its source wrote, any files the browser added, and "Files" among its types
// whenever it carries some.
export function fakeDrag(type: string, carried: { data?: Record<string, string>; files?: File[] } = {}) {
  const written = new Map(Object.entries(carried.data ?? {}));
  const files = carried.files ?? [];
  const event = new Event(type, { bubbles: true, cancelable: true }) as DragEvent;
  Object.defineProperty(event, "dataTransfer", {
    value: {
      get types() {
        return [...(files.length ? ["Files"] : []), ...written.keys()];
      },
      files,
      getData: (key: string) => written.get(key) ?? "",
      setData: (key: string, value: string) => written.set(key, value),
      effectAllowed: "uninitialized",
    },
  });
  return { event, written };
}

/** Fires `type` at `target`, already claimed when `claimed`, and returns what
 * its listeners wrote on the drag. */
export function fireDrag(target: EventTarget, type: "dragstart" | "dragend", claimed = false): Map<string, string> {
  const { event, written } = fakeDrag(type);
  if (claimed) event.preventDefault();
  target.dispatchEvent(event);
  return written;
}

/** Drops `path` on `target` as an entry dragged from Pragma's own tree, whose
 * row notes the path in flight until the drag ends. `foreign` drops the same
 * text with no such drag, as a link dragged out of a note or another app's
 * drag does. */
export function drop(target: EventTarget, path: string, foreign = false): void {
  const event = new Event("drop", { bubbles: true, cancelable: true }) as DragEvent;
  Object.defineProperty(event, "dataTransfer", { value: { getData: () => path, files: [] } });
  if (!foreign) noteDragInFlight(path);
  target.dispatchEvent(event);
  noteDragInFlight(undefined);
}
