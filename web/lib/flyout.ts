// A popover anchored to the control that opened it: where it sits, and what
// dismisses it.

// Below-anchor by default, flipped above / clamped horizontally when it
// wouldn't fit — the same placement as colorPicker.ts's, copied rather than
// imported because that module's shapes are otherwise unrelated.
export function positionPopover(popover: HTMLElement, anchor: HTMLElement): void {
  const rect = anchor.getBoundingClientRect();
  const margin = 4;
  const width = popover.offsetWidth;
  const height = popover.offsetHeight;

  let left = rect.left;
  if (left + width > window.innerWidth - margin) left = window.innerWidth - margin - width;
  if (left < margin) left = margin;

  let top = rect.bottom + margin;
  if (top + height > window.innerHeight - margin) top = rect.top - margin - height;
  if (top < margin) top = margin;

  popover.style.left = `${left}px`;
  popover.style.top = `${top}px`;
}

// Outside-click and resize dismissal for an anchored flyout (Escape is the
// flyout's own). The returned teardown removes `el` itself, so a caller's
// teardown only adds what its flyout needs, such as clearing its
// module-level "open" variable.
//
// A press outside closes the flyout only once it ends as a click, so a
// press that becomes a drag, a file dragged in from the tree, leaves it
// open to drop on. A right or middle press closes it at once. Both are
// armed a tick late, so the click that opened the flyout can't close it.
//
// A press in a menu leaves the flyout open: anything outside closes the
// flyout first, so a menu showing over it was opened from it, as a Flow
// picker is from a Class's Toolkit, and a pick there is part of its use.
export function wireFlyoutDismiss(el: HTMLElement, anchor: HTMLElement, onDismiss: () => void): () => void {
  const outside = (target: EventTarget | null): boolean => {
    if (!(target instanceof Node) || el.contains(target) || anchor.contains(target)) return false;
    return !(target instanceof Element && target.closest('[role="menu"]'));
  };
  let pressedOutside = false;
  const onPointerDown = (event: PointerEvent): void => {
    pressedOutside = outside(event.target);
    if (pressedOutside && event.button !== 0) onDismiss();
  };
  const onClick = (): void => {
    if (pressedOutside) onDismiss();
    pressedOutside = false;
  };
  const onResize = (): void => onDismiss();

  const arm = window.setTimeout(() => {
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("click", onClick);
  }, 0);
  window.addEventListener("resize", onResize);

  return () => {
    window.clearTimeout(arm);
    document.removeEventListener("pointerdown", onPointerDown);
    document.removeEventListener("click", onClick);
    window.removeEventListener("resize", onResize);
    const restore = el.contains(document.activeElement);
    el.remove();
    if (restore) anchor.focus();
  };
}

export interface Flyout {
  readonly element: HTMLElement;
  close(): void;
  // Re-places it, for content that changed its size.
  reposition(): void;
}

// One open at a time, as a menu is: opening one closes whatever another
// opener left open.
let openFlyoutTeardown: (() => void) | null = null;

/** Opens `element` as a popover under `anchor`, or above it where it won't
 * fit, closed by an outside click, a resize or Escape. `onClose` hears every
 * way it closes. */
export function openFlyout(anchor: HTMLElement, element: HTMLElement, onClose?: () => void): Flyout {
  openFlyoutTeardown?.();
  document.body.appendChild(element);
  positionPopover(element, anchor);

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    event.preventDefault();
    event.stopPropagation();
    close();
  };
  element.addEventListener("keydown", onKeyDown);
  const unwire = wireFlyoutDismiss(element, anchor, () => close());
  let closed = false;
  function close(): void {
    if (closed) return;
    closed = true;
    element.removeEventListener("keydown", onKeyDown);
    unwire();
    if (openFlyoutTeardown === close) openFlyoutTeardown = null;
    onClose?.();
  }
  openFlyoutTeardown = close;
  return { element, close, reposition: () => positionPopover(element, anchor) };
}
