// A popover anchored to the control that opened it: where it sits, and what
// dismisses it. Every popover opens through here, so only one is ever open,
// and one Escape command closes it wherever focus is.
import type { CommandRegistry } from "../services/commands.ts";
import type { KeybindingRegistry } from "../services/keybindings.ts";

// Below the anchor, flipped above or clamped sideways when it wouldn't fit,
// in viewport coordinates for a `position: fixed` popover. It measures the
// popover, so append the popover to the document first.
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

// Outside-click and resize dismissal for an anchored flyout. The returned
// teardown removes `el` itself and hands focus back to `anchor` when it was
// inside.
//
// A press outside closes the flyout only once it ends as a click, so a
// press that becomes a drag, a file dragged in from the tree, leaves it
// open to drop on. A right or middle press closes it at once. Both are
// armed a tick late, so the click that opened the flyout can't close it.
//
// A press in a menu leaves the flyout open: anything outside closes the
// flyout first, so a menu showing over it was opened from it, as a Flow
// picker is from a Class's Toolkit, and a pick there is part of its use.
function wireFlyoutDismiss(el: HTMLElement, anchor: HTMLElement, onDismiss: () => void): () => void {
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
 * fit, closed by an outside click, a resize, Escape, or focus moving away.
 * `onClose` hears every way it closes. */
export function openFlyout(anchor: HTMLElement, element: HTMLElement, onClose?: () => void): Flyout {
  openFlyoutTeardown?.();
  document.body.appendChild(element);
  positionPopover(element, anchor);

  // Focus leaving closes it as an outside click does, so a keyboard move
  // into another editor group can't leave it open behind. A menu it opened,
  // or a modal dialog over it, is part of its use and leaves it open.
  const onFocusIn = (event: FocusEvent): void => {
    const target = event.target;
    if (!(target instanceof Node) || element.contains(target) || anchor.contains(target)) return;
    if (target instanceof Element && target.closest('[role="menu"], [aria-modal="true"]')) return;
    close();
  };
  document.addEventListener("focusin", onFocusIn);
  const unwire = wireFlyoutDismiss(element, anchor, () => close());
  let closed = false;
  function close(): void {
    if (closed) return;
    closed = true;
    document.removeEventListener("focusin", onFocusIn);
    unwire();
    if (openFlyoutTeardown === close) openFlyoutTeardown = null;
    onClose?.();
  }
  openFlyoutTeardown = close;
  return { element, close, reposition: () => positionPopover(element, anchor) };
}

/** Escape closes the open popover wherever focus is: below a dialog and a
 * menu, which claim it first, and above a pane's own transient. */
export function registerFlyoutEscape(commands: CommandRegistry, keybindings: KeybindingRegistry): void {
  commands.register({
    id: "flyout.close",
    label: "Close popover",
    when: () => openFlyoutTeardown !== null,
    run: () => openFlyoutTeardown?.(),
  });
  keybindings.register({ key: "Escape", command: "flyout.close", weight: 60 });
}
