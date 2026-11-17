// The keyboard cursor's ring, for a list that ↑/↓ move through: it shows
// while the keyboard drives the list, and a pointer press hides it, since a
// click lands the cursor on the item it selects, where a ring would only say
// the list has focus. The list wears `keyboard-cursor`; the look is in
// utilities.css.
//
// A class, not :focus-visible alone: Firefox never turns that on for an
// element a click focused, so a key pressed in a clicked list would move an
// unseen cursor.

export interface CursorRing {
  show(): void;
  hide(): void;
}

/** `show` is for the list's own keys; a keyboard focus on `list`, or on one of
 * its `items` when they take focus themselves, shows the ring as well. */
export function cursorRing(list: HTMLElement, items: readonly HTMLElement[] = [list]): CursorRing {
  const show = (): void => list.classList.add("keyboard-cursor");
  const hide = (): void => list.classList.remove("keyboard-cursor");
  list.addEventListener("pointerdown", hide);
  for (const item of items) {
    item.addEventListener("focus", () => {
      if (item.matches(":focus-visible")) show();
    });
  }
  return { show, hide };
}
