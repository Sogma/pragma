// The ⋮ laid over a clip, a picture or a page, which opens its More options
// menu. The surface under it takes keys (a preview's arrows, a player's
// Space), so the button never keeps focus: a press leaves it where it was,
// and the focus a pick hands back to the menu's button goes on to what held
// it when the button was pressed.

export interface MoreOptionsButton {
  readonly element: HTMLButtonElement;
  /** Stops watching its menu close. */
  dispose(): void;
}

/** A ⋮ of `className` that opens or closes its menu through `open`, which
 * anchors the menu to it. Pressed by key, it had focus, and keeps it. */
export function moreOptionsButton(className: string, open: (anchor: HTMLElement) => void): MoreOptionsButton {
  const element = document.createElement("button");
  element.type = "button";
  element.className = `icon-button ${className}`;
  element.setAttribute("aria-label", "More options");
  element.setAttribute("aria-haspopup", "true");
  element.setAttribute("aria-expanded", "false");
  element.addEventListener("mousedown", (event) => event.preventDefault());
  let focusBeforeMenu: Element | null = null;
  element.addEventListener("click", () => {
    focusBeforeMenu = document.activeElement;
    open(element);
  });
  element.addEventListener("focus", () => {
    const to = focusBeforeMenu;
    focusBeforeMenu = null;
    if (to === null || to === element) return;
    if (to instanceof HTMLElement && to.isConnected) to.focus({ preventScroll: true });
    if (document.activeElement === element) element.blur();
  });
  // A menu closed with no pick hands nothing back, so a later Tab onto the
  // button stays there.
  const menuClosed = new MutationObserver(() => {
    if (element.getAttribute("aria-expanded") === "false") focusBeforeMenu = null;
  });
  menuClosed.observe(element, { attributeFilter: ["aria-expanded"] });
  return { element, dispose: () => menuClosed.disconnect() };
}
