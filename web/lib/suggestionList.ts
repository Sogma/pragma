// A list of suggestions under a text field, drawn from what's typed in it:
// a tag input's tags, a Flow text box's placeholders. One list is on screen
// at a time, and a new one closes the last, whose field may have been
// rebuilt away without ever blurring. An editor's field anchors it at its
// caret instead of under itself.
//
// Focus never leaves the field, whose own keydown moves the highlight, so
// typing narrows the list as it goes. A press on a row would move focus and
// the field's blur would close the list before the click landed, so the
// list keeps presses off its rows.

export interface SuggestionRow {
  /** Fills the row, a button, with what it shows. */
  fill(row: HTMLButtonElement): void;
  /** What a click on the row does. */
  pick(): void;
}

export interface SuggestionList {
  /** Draws `rows` with the one at `active` highlighted, -1 for none, closing
   * any other list. With no rows nothing is drawn, though the list still
   * counts as showing until it is closed. */
  show(rows: readonly SuggestionRow[], active: number): void;
  close(): void;
  /** Whether rows are drawn. */
  isOpen(): boolean;
  /** Whether this is the list last shown, and not closed since. */
  isShowing(): boolean;
  /** The highlighted row's index, -1 for none. */
  active(): number;
  highlight(index: number): void;
}

const MARGIN = 4;

let closeShowing: (() => void) | undefined;

/** Where a list hangs from: under `bottom`, or over `top` where the viewport
 * has no room below, starting at `left`. */
export interface SuggestionAnchor {
  left: number;
  top: number;
  bottom: number;
}

export function createSuggestionList(
  field: HTMLElement,
  options: {
    id: string;
    label: string;
    className: string;
    onClose?: () => void;
    anchor?: () => SuggestionAnchor;
  },
): SuggestionList {
  let list: HTMLElement | undefined;
  let active = -1;

  field.setAttribute("role", "combobox");
  field.setAttribute("aria-autocomplete", "list");
  field.setAttribute("aria-expanded", "false");

  function show(rows: readonly SuggestionRow[], index: number): void {
    if (closeShowing !== close) closeShowing?.();
    closeShowing = close;
    active = rows.length === 0 ? -1 : index;
    draw(rows);
  }

  function close(): void {
    if (closeShowing === close) closeShowing = undefined;
    active = -1;
    options.onClose?.();
    draw([]);
  }

  function draw(rows: readonly SuggestionRow[]): void {
    if (rows.length === 0) {
      unmount();
      return;
    }
    list ??= mount();
    list.replaceChildren(...rows.map(button));
    paint();
    place(list);
  }

  function button(row: SuggestionRow, index: number): HTMLButtonElement {
    const element = document.createElement("button");
    element.type = "button";
    element.tabIndex = -1;
    element.id = `${options.id}-${index}`;
    element.setAttribute("role", "option");
    row.fill(element);
    // `mousemove`, not `mouseenter`: rows are redrawn under a resting
    // pointer on every keystroke, and a highlight that followed them would
    // change what Enter picks.
    element.addEventListener("mousemove", () => {
      if (active === index) return;
      active = index;
      paint();
    });
    element.addEventListener("click", () => row.pick());
    return element;
  }

  function paint(): void {
    if (!list) return;
    for (const [index, row] of [...list.children].entries()) {
      row.classList.toggle("highlighted", index === active);
      row.setAttribute("aria-selected", String(index === active));
      if (index === active) row.scrollIntoView?.({ block: "nearest" });
    }
    if (active >= 0) field.setAttribute("aria-activedescendant", `${options.id}-${active}`);
    else field.removeAttribute("aria-activedescendant");
  }

  function mount(): HTMLElement {
    const element = document.createElement("div");
    element.className = `context-menu suggestion-list ${options.className}`;
    element.id = options.id;
    element.setAttribute("role", "listbox");
    element.setAttribute("aria-label", options.label);
    element.addEventListener("mousedown", (event) => event.preventDefault());
    document.body.appendChild(element);
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);
    field.setAttribute("aria-expanded", "true");
    field.setAttribute("aria-controls", options.id);
    return element;
  }

  function unmount(): void {
    if (!list) return;
    list.remove();
    list = undefined;
    document.removeEventListener("pointerdown", onPointerDown, true);
    document.removeEventListener("scroll", reposition, true);
    window.removeEventListener("resize", reposition);
    field.setAttribute("aria-expanded", "false");
    field.removeAttribute("aria-controls");
    field.removeAttribute("aria-activedescendant");
  }

  function onPointerDown(event: PointerEvent): void {
    const target = event.target as Node;
    if (!field.contains(target) && !list?.contains(target)) close();
  }

  function reposition(): void {
    if (!field.isConnected) close();
    else if (list) place(list);
  }

  // Kept on screen sideways.
  function place(element: HTMLElement): void {
    const rect = options.anchor?.() ?? field.getBoundingClientRect();
    const left = Math.min(rect.left, window.innerWidth - MARGIN - element.offsetWidth);
    let top = rect.bottom + MARGIN;
    if (top + element.offsetHeight > window.innerHeight - MARGIN) top = rect.top - MARGIN - element.offsetHeight;
    element.style.left = `${Math.max(MARGIN, left)}px`;
    element.style.top = `${Math.max(MARGIN, top)}px`;
  }

  return {
    show,
    close,
    isOpen: () => list !== undefined,
    isShowing: () => closeShowing === close,
    active: () => active,
    highlight: (index) => {
      active = index;
      paint();
    },
  };
}
